import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Pool, PoolClient } from 'pg';
import { CONFIG, Config } from './config';
import { hashPassword, randomToken, sha256, verifyPassword } from './crypto';
import { POOL, tx } from './db';
import type { Role, SignupDto } from './dto';
import { Actor, atLeast } from './guards';
import { LedgerClient } from './ledger.client';

interface PlanRow {
  id: string; name: string; monthly_price_cents: number; monthly_credits: string; max_revisions: number;
  max_video_seconds: number; max_concurrent_jobs: number; queue_priority: number; rate_limit_rpm: number;
  workspace_rate_rpm: number; max_seats: number; watermark: boolean; features: Record<string, unknown>;
}

export interface Tokens { access_token: string; refresh_token: string; token_type: 'Bearer'; expires_in: number }

const slugify = (name: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workspace'}-${randomUUID().slice(0, 8)}`;

// A valid hash of a random password, used to keep login timing equal for unknown emails.
const DUMMY_HASH = hashPassword(randomToken());

@Injectable()
export class IdentityService {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly cfg: Config,
    private readonly ledger: LedgerClient,
  ) {}

  // ── plans ────────────────────────────────────────────────────────────────
  async plans() {
    const { rows } = await this.pool.query<PlanRow>('SELECT * FROM plans ORDER BY monthly_price_cents');
    return rows.map((p) => ({ ...p, monthly_credits: Number(p.monthly_credits) }));
  }

  // ── tokens ───────────────────────────────────────────────────────────────
  private async accessToken(userId: string, workspaceId: string): Promise<string> {
    const { rows } = await this.pool.query<{ role: Role; plan_id: string; rate_limit_rpm: number; workspace_rate_rpm: number; queue_priority: number }>(
      `SELECT m.role, w.plan_id, p.rate_limit_rpm, p.workspace_rate_rpm, p.queue_priority
         FROM memberships m JOIN workspaces w ON w.id = m.workspace_id JOIN plans p ON p.id = w.plan_id
        WHERE m.workspace_id = $1 AND m.user_id = $2 AND w.status = 'active'`,
      [workspaceId, userId],
    );
    const m = rows[0];
    if (!m) throw new ForbiddenException('you are not a member of this workspace');
    return jwt.sign(
      { ws: workspaceId, role: m.role, plan: m.plan_id, rpm: m.rate_limit_rpm, wrpm: m.workspace_rate_rpm, prio: m.queue_priority },
      this.cfg.jwtSecret,
      { algorithm: 'HS256', subject: userId, issuer: 'xen-studio', audience: 'xen-studio', expiresIn: this.cfg.accessTtl },
    );
  }

  private async newSession(c: PoolClient | Pool, userId: string, meta: { ip?: string; ua?: string }): Promise<string> {
    const id = randomUUID();
    const secret = randomToken();
    await c.query(
      `INSERT INTO sessions (id, user_id, refresh_hash, user_agent, ip, expires_at) VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval)`,
      [id, userId, sha256(secret), meta.ua?.slice(0, 300) ?? null, meta.ip ?? null, String(this.cfg.refreshTtl)],
    );
    return `${id}.${secret}`;
  }

  private async tokens(userId: string, workspaceId: string, refresh: string): Promise<Tokens> {
    return { access_token: await this.accessToken(userId, workspaceId), refresh_token: refresh, token_type: 'Bearer', expires_in: this.cfg.accessTtl };
  }

  private async audit(c: PoolClient | Pool, workspaceId: string, actorId: string | null, action: string, target = '', metadata: object = {}, ip?: string) {
    await c.query(
      `INSERT INTO audit_logs (workspace_id, id, actor_id, action, target, metadata, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [workspaceId, randomUUID(), actorId, action, target, JSON.stringify(metadata), ip ?? null],
    );
  }

  private async emit(c: PoolClient, workspaceId: string, topic: string, eventType: string, payload: object) {
    await c.query(`INSERT INTO outbox (workspace_id, id, topic, event_type, payload) VALUES ($1,$2,$3,$4,$5)`, [
      workspaceId, randomUUID(), topic, eventType, JSON.stringify(payload),
    ]);
  }

  private async createWorkspaceTx(c: PoolClient, userId: string, name: string, ip?: string) {
    const id = randomUUID();
    const { rows } = await c.query(
      `INSERT INTO workspaces (id, name, slug, plan_id, created_by, owner_id, region) VALUES ($1,$2,$3,'starter',$4,$4,$5) RETURNING id, name, slug, plan_id, region, created_at`,
      [id, name, slugify(name), userId, process.env.CELL_REGION ?? 'local'],
    );
    await c.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [id, userId]);
    await this.audit(c, id, userId, 'workspace.created', id, { name }, ip);
    await this.emit(c, id, 'workspace.events', 'workspace.created', { workspace_id: id, plan: 'starter', owner_id: userId });
    return rows[0] as { id: string; name: string; slug: string; plan_id: string; created_at: Date };
  }

  private async grantPlanCredits(workspaceId: string) {
    const { rows } = await this.pool.query<{ monthly_credits: string }>(`SELECT monthly_credits FROM plans WHERE id = 'starter'`);
    const amount = Number(rows[0]?.monthly_credits ?? 0);
    // Idempotent by key: the outbox event lets a reconciler retry this grant if the ledger was down.
    if (amount > 0) await this.ledger.grant(workspaceId, amount, `workspace-initial-grant:${workspaceId}`, 'starter plan initial credits');
  }

  // ── auth ─────────────────────────────────────────────────────────────────
  async signup(dto: SignupDto, meta: { ip?: string; ua?: string }) {
    const passwordHash = await hashPassword(dto.password);
    try {
      const out = await tx(this.pool, async (c) => {
        const userId = randomUUID();
        await c.query(`INSERT INTO users (id, email, password_hash, name, locale) VALUES ($1,$2,$3,$4,$5)`, [
          userId, dto.email, passwordHash, dto.name, dto.locale ?? 'en',
        ]);
        const workspace = await this.createWorkspaceTx(c, userId, dto.workspace_name ?? `${dto.name}'s workspace`, meta.ip);
        const refresh = await this.newSession(c, userId, meta);
        return { userId, workspace, refresh };
      });
      await this.grantPlanCredits(out.workspace.id);
      return {
        user: { id: out.userId, email: dto.email, name: dto.name },
        workspace: out.workspace,
        ...(await this.tokens(out.userId, out.workspace.id, out.refresh)),
      };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ConflictException('an account with this email already exists');
      throw err;
    }
  }

  async login(email: string, password: string, meta: { ip?: string; ua?: string }) {
    const { rows } = await this.pool.query<{ id: string; password_hash: string; name: string; status: string }>(
      `SELECT id, password_hash, name, status FROM users WHERE email = $1`, [email]);
    const user = rows[0];
    const ok = await verifyPassword(password, user?.password_hash ?? (await DUMMY_HASH));
    if (!user || !ok || user.status !== 'active') throw new UnauthorizedException('incorrect email or password');
    const ws = await this.pool.query<{ workspace_id: string }>(
      `SELECT m.workspace_id FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = $1 AND w.status = 'active' ORDER BY m.created_at LIMIT 1`, [user.id]);
    if (!ws.rows[0]) throw new ForbiddenException('this account has no active workspace');
    const refresh = await this.newSession(this.pool, user.id, meta);
    await this.audit(this.pool, ws.rows[0].workspace_id, user.id, 'auth.login', user.id, {}, meta.ip);
    return { user: { id: user.id, email, name: user.name }, ...(await this.tokens(user.id, ws.rows[0].workspace_id, refresh)) };
  }

  /** Rotates the refresh token. Presenting an already-rotated token revokes the whole session (theft detection). */
  async refresh(token: string, workspaceId?: string): Promise<Tokens> {
    const [id, secret] = token.split('.');
    if (!id || !secret || !/^[0-9a-f-]{36}$/i.test(id)) throw new UnauthorizedException('invalid refresh token');
    const next = randomToken();
    const { rows } = await this.pool.query<{ user_id: string }>(
      `UPDATE sessions SET refresh_hash = $3
        WHERE id = $1 AND refresh_hash = $2 AND revoked_at IS NULL AND expires_at > now() RETURNING user_id`,
      [id, sha256(secret), sha256(next)],
    );
    if (!rows[0]) {
      await this.pool.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [id]);
      throw new UnauthorizedException('invalid refresh token');
    }
    const userId = rows[0].user_id;
    let ws = workspaceId;
    if (!ws) {
      const r = await this.pool.query<{ workspace_id: string }>(
        `SELECT m.workspace_id FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
          WHERE m.user_id = $1 AND w.status = 'active' ORDER BY m.created_at LIMIT 1`, [userId]);
      ws = r.rows[0]?.workspace_id;
    }
    if (!ws) throw new ForbiddenException('this account has no active workspace');
    return this.tokens(userId, ws, `${id}.${next}`);
  }

  async logout(token: string): Promise<void> {
    const [id, secret] = token.split('.');
    if (!id || !secret || !/^[0-9a-f-]{36}$/i.test(id)) return;
    await this.pool.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND refresh_hash = $2`, [id, sha256(secret)]);
  }

  // ── profile and workspaces ───────────────────────────────────────────────
  async me(actor: Actor) {
    const u = await this.pool.query(`SELECT id, email, name, locale, platform_role, created_at FROM users WHERE id = $1`, [actor.userId]);
    if (!u.rows[0]) throw new NotFoundException('user not found');
    return { user: u.rows[0], current_workspace_id: actor.workspaceId, role: actor.role, workspaces: await this.listWorkspaces(actor.userId) };
  }

  async listWorkspaces(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT w.id, w.name, w.slug, w.plan_id, m.role, w.created_at
         FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = $1 AND w.status = 'active' ORDER BY m.created_at`, [userId]);
    return rows;
  }

  async createWorkspace(actor: Actor, name: string, ip?: string) {
    const count = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM memberships WHERE user_id = $1 AND role = 'owner'`, [actor.userId]);
    if (Number(count.rows[0].n) >= 10) throw new BadRequestException('workspace limit reached (10 owned workspaces)');
    const ws = await tx(this.pool, (c) => this.createWorkspaceTx(c, actor.userId, name, ip));
    await this.grantPlanCredits(ws.id);
    return ws;
  }

  /** Issues an access token scoped to another workspace the caller belongs to. */
  async switchWorkspace(actor: Actor, workspaceId: string) {
    return { access_token: await this.accessToken(actor.userId, workspaceId), token_type: 'Bearer' as const, expires_in: this.cfg.accessTtl };
  }

  // ── members (every query is scoped by workspace_id) ──────────────────────
  async members(workspaceId: string) {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.email, u.name, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1 ORDER BY m.created_at`, [workspaceId]);
    return rows;
  }

  async addMember(actor: Actor, email: string, role: Role, ip?: string) {
    return tx(this.pool, async (c) => {
      const seats = await c.query<{ used: string; max_seats: number }>(
        `SELECT (SELECT count(*) FROM memberships WHERE workspace_id = w.id) AS used, p.max_seats
           FROM workspaces w JOIN plans p ON p.id = w.plan_id WHERE w.id = $1 FOR UPDATE OF w`, [actor.workspaceId]);
      if (!seats.rows[0]) throw new NotFoundException('workspace not found');
      if (Number(seats.rows[0].used) >= seats.rows[0].max_seats) {
        throw new ForbiddenException(`your plan allows ${seats.rows[0].max_seats} seat(s); upgrade to add more members`);
      }
      const u = await c.query<{ id: string; name: string }>(`SELECT id, name FROM users WHERE email = $1 AND status = 'active'`, [email]);
      if (!u.rows[0]) throw new NotFoundException('no account with this email; ask them to sign up first');
      const ins = await c.query(
        `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [actor.workspaceId, u.rows[0].id, role]);
      if (ins.rowCount === 0) throw new ConflictException('this person is already a member');
      await this.audit(c, actor.workspaceId, actor.userId, 'member.added', u.rows[0].id, { role }, ip);
      return { id: u.rows[0].id, email, name: u.rows[0].name, role };
    });
  }

  private async guardOwnerChange(c: PoolClient, actor: Actor, targetId: string, removingOwner: boolean) {
    const cur = await c.query<{ role: Role }>(
      `SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`, [actor.workspaceId, targetId]);
    if (!cur.rows[0]) throw new NotFoundException('member not found');
    if (cur.rows[0].role === 'owner') {
      if (actor.role !== 'owner') throw new ForbiddenException('only an owner can change another owner');
      if (removingOwner) {
        const owners = await c.query<{ user_id: string }>(
          `SELECT user_id FROM memberships WHERE workspace_id = $1 AND role = 'owner' FOR UPDATE`, [actor.workspaceId]);
        if (owners.rows.length <= 1) throw new BadRequestException('a workspace must keep at least one owner');
      }
    }
    return cur.rows[0].role;
  }

  async updateMember(actor: Actor, targetId: string, role: Role, ip?: string) {
    if (role === 'owner' && actor.role !== 'owner') throw new ForbiddenException('only an owner can grant the owner role');
    if (!atLeast(actor.role, role)) throw new ForbiddenException('you cannot grant a role above your own');
    return tx(this.pool, async (c) => {
      const from = await this.guardOwnerChange(c, actor, targetId, role !== 'owner');
      await c.query(`UPDATE memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2`, [actor.workspaceId, targetId, role]);
      await this.audit(c, actor.workspaceId, actor.userId, 'member.role_changed', targetId, { from, to: role }, ip);
      return { id: targetId, role };
    });
  }

  async removeMember(actor: Actor, targetId: string, ip?: string) {
    await tx(this.pool, async (c) => {
      await this.guardOwnerChange(c, actor, targetId, true);
      await c.query(`DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [actor.workspaceId, targetId]);
      await this.audit(c, actor.workspaceId, actor.userId, 'member.removed', targetId, {}, ip);
    });
  }
}

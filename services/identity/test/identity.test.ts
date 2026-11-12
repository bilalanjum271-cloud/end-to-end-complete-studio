// Integration tests: real NestJS app, real PostgreSQL (TEST_DATABASE_URL), stub ledger.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import jwt from 'jsonwebtoken';

const DB = process.env.TEST_DATABASE_URL;
const GW = 'test-internal-token';
const SECRET = 'test-secret-test-secret-test-secret-1234';

describe('identity service', { skip: !DB && 'TEST_DATABASE_URL not set' }, () => {
  let app: INestApplication;
  let ledger: Server;
  let base = '';
  const grants: { url: string; key: string; body: { amount: number } }[] = [];
  const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  before(async () => {
    ledger = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        grants.push({ url: req.url ?? '', key: String(req.headers['idempotency-key']), body: JSON.parse(raw || '{}') });
        res.writeHead(201, { 'content-type': 'application/json' }).end('{}');
      });
    }).listen(0);
    Object.assign(process.env, {
      DATABASE_URL: DB, JWT_SECRET: SECRET, INTERNAL_SERVICE_TOKEN: GW,
      LEDGER_URL: `http://127.0.0.1:${(ledger.address() as AddressInfo).port}`,
    });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  after(async () => {
    await app?.close();
    ledger?.close();
  });

  type Claims = { sub: string; ws: string; role: string; plan: string; rpm: number; prio: number };
  /** Calls the service the way the gateway does: verified claims become tenant headers. */
  async function call(method: string, path: string, opts: { token?: string; body?: unknown; gateway?: boolean } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.gateway !== false) headers['x-gateway-token'] = GW;
    if (opts.token) {
      const c = jwt.verify(opts.token, SECRET, { issuer: 'xen-studio', audience: 'xen-studio' }) as Claims;
      Object.assign(headers, { 'x-user-id': c.sub, 'x-workspace-id': c.ws, 'x-role': c.role, 'x-plan': c.plan });
    }
    const res = await fetch(base + path, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  const signup = async (name = 'Ada') => {
    const email = `u-${uniq()}@example.com`;
    const r = await call('POST', '/v1/auth/signup', { body: { email, password: 'correct horse battery', name } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { email, ...r.body } as { email: string; access_token: string; refresh_token: string; user: { id: string }; workspace: { id: string } };
  };

  it('rejects requests that bypass the gateway', async () => {
    const r = await call('GET', '/v1/plans', { gateway: false });
    assert.equal(r.status, 401);
  });

  it('lists the seeded plans with revision limits', async () => {
    const r = await call('GET', '/v1/plans');
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.body.plans.map((p: { id: string }) => [p.id, p]));
    assert.deepEqual(Object.keys(byId).sort(), ['pro', 'starter', 'studio']);
    assert.equal(byId.studio.max_revisions, 5);
    assert.equal(byId.pro.max_revisions, 5);
    assert.equal(byId.starter.max_revisions, 2);
    assert.equal(byId.studio.max_seats, 25);
  });

  it('signup creates user, workspace, owner membership, plan-scoped token and one idempotent credit grant', async () => {
    const before = grants.length;
    const s = await signup();
    const claims = jwt.verify(s.access_token, SECRET) as Claims;
    assert.equal(claims.sub, s.user.id);
    assert.equal(claims.ws, s.workspace.id);
    assert.equal(claims.role, 'owner');
    assert.equal(claims.plan, 'starter');
    assert.equal(claims.rpm, 60);
    assert.equal(claims.prio, 10);
    const mine = grants.slice(before);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].key, `workspace-initial-grant:${s.workspace.id}`);
    assert.equal(mine[0].body.amount, 200);

    const me = await call('GET', '/v1/me', { token: s.access_token });
    assert.equal(me.status, 200);
    assert.equal(me.body.workspaces.length, 1);
    assert.equal(me.body.user.password_hash, undefined);
  });

  it('validates input and rejects duplicate emails', async () => {
    const bad = await call('POST', '/v1/auth/signup', { body: { email: 'nope', password: 'short', name: '' } });
    assert.equal(bad.status, 400);
    const extra = await call('POST', '/v1/auth/signup', { body: { email: `x-${uniq()}@example.com`, password: 'long enough password', name: 'X', platform_role: 'superadmin' } });
    assert.equal(extra.status, 400, 'unknown fields must be rejected');
    const s = await signup();
    const dup = await call('POST', '/v1/auth/signup', { body: { email: s.email.toUpperCase(), password: 'correct horse battery', name: 'Dup' } });
    assert.equal(dup.status, 409);
  });

  it('logs in, and gives the same error for a wrong password and an unknown email', async () => {
    const s = await signup();
    const ok = await call('POST', '/v1/auth/login', { body: { email: s.email, password: 'correct horse battery' } });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.access_token);
    const wrong = await call('POST', '/v1/auth/login', { body: { email: s.email, password: 'wrong password!!' } });
    const unknown = await call('POST', '/v1/auth/login', { body: { email: `nobody-${uniq()}@example.com`, password: 'wrong password!!' } });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body.message, unknown.body.message);
  });

  it('rotates refresh tokens and revokes the session when an old token is replayed', async () => {
    const s = await signup();
    const r1 = await call('POST', '/v1/auth/refresh', { body: { refresh_token: s.refresh_token } });
    assert.equal(r1.status, 200);
    assert.notEqual(r1.body.refresh_token, s.refresh_token);
    const replay = await call('POST', '/v1/auth/refresh', { body: { refresh_token: s.refresh_token } });
    assert.equal(replay.status, 401);
    const afterTheft = await call('POST', '/v1/auth/refresh', { body: { refresh_token: r1.body.refresh_token } });
    assert.equal(afterTheft.status, 401, 'the rotated token must die with the session');
  });

  it('logout revokes the refresh token', async () => {
    const s = await signup();
    assert.equal((await call('POST', '/v1/auth/logout', { body: { refresh_token: s.refresh_token } })).status, 204);
    assert.equal((await call('POST', '/v1/auth/refresh', { body: { refresh_token: s.refresh_token } })).status, 401);
  });

  it('enforces tenant isolation on workspace-scoped routes', async () => {
    const a = await signup('A');
    const b = await signup('B');
    const cross = await call('GET', `/v1/workspaces/${b.workspace.id}/members`, { token: a.access_token });
    assert.equal(cross.status, 403);
    const stolen = await call('POST', `/v1/workspaces/${b.workspace.id}/token`, { token: a.access_token });
    assert.equal(stolen.status, 403, 'cannot mint a token for a workspace you do not belong to');
    const own = await call('GET', `/v1/workspaces/${a.workspace.id}/members`, { token: a.access_token });
    assert.equal(own.status, 200);
    assert.equal(own.body.members.length, 1);
  });

  it('enforces plan seat limits and role rules', async () => {
    const owner = await signup('Owner');
    const mate = await signup('Mate');
    // starter plan: 1 seat
    const full = await call('POST', `/v1/workspaces/${owner.workspace.id}/members`, { token: owner.access_token, body: { email: mate.email, role: 'editor' } });
    assert.equal(full.status, 403);
    assert.match(full.body.message, /seat/);

    // move the workspace to the studio plan (billing does this in Phase 6) and retry
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: DB });
    await pool.query(`UPDATE workspaces SET plan_id = 'studio' WHERE id = $1`, [owner.workspace.id]);
    await pool.end();
    const added = await call('POST', `/v1/workspaces/${owner.workspace.id}/members`, { token: owner.access_token, body: { email: mate.email, role: 'editor' } });
    assert.equal(added.status, 201, JSON.stringify(added.body));

    // the new member gets a token for this workspace with role editor and studio limits
    const sw = await call('POST', `/v1/workspaces/${owner.workspace.id}/token`, { token: mate.access_token });
    assert.equal(sw.status, 200);
    const claims = jwt.verify(sw.body.access_token, SECRET) as Claims;
    assert.equal(claims.role, 'editor');
    assert.equal(claims.plan, 'studio');
    assert.equal(claims.prio, 90);

    // an editor cannot manage members
    const denied = await call('POST', `/v1/workspaces/${owner.workspace.id}/members`, { token: sw.body.access_token, body: { email: owner.email, role: 'viewer' } });
    assert.equal(denied.status, 403);
    // the last owner cannot be demoted or removed
    const demote = await call('PATCH', `/v1/workspaces/${owner.workspace.id}/members/${owner.user.id}`, { token: owner.access_token, body: { role: 'admin' } });
    assert.equal(demote.status, 400);
    const remove = await call('DELETE', `/v1/workspaces/${owner.workspace.id}/members/${owner.user.id}`, { token: owner.access_token });
    assert.equal(remove.status, 400);
    // owner can promote, then remove, the member
    const promote = await call('PATCH', `/v1/workspaces/${owner.workspace.id}/members/${mate.user.id}`, { token: owner.access_token, body: { role: 'admin' } });
    assert.equal(promote.status, 200);
    const gone = await call('DELETE', `/v1/workspaces/${owner.workspace.id}/members/${mate.user.id}`, { token: owner.access_token });
    assert.equal(gone.status, 204);
  });
});

describe('billing', { skip: !DB && 'TEST_DATABASE_URL not set' }, () => {
  // Uses the mock payment provider, which signs webhooks with the same scheme as Stripe.
  let app: INestApplication;
  let base = '';
  let ledger: Server;
  const grants: { key: string; amount: number }[] = [];
  before(async () => {
    ledger = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => { grants.push({ key: String(req.headers['idempotency-key']), amount: JSON.parse(raw || '{}').amount }); res.writeHead(201).end('{}'); });
    }).listen(0);
    Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: SECRET, INTERNAL_SERVICE_TOKEN: GW, LEDGER_URL: `http://127.0.0.1:${(ledger.address() as AddressInfo).port}` });
    delete process.env.STRIPE_SECRET_KEY;
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  after(async () => { await app?.close(); ledger?.close(); });

  const call = async (method: string, path: string, token?: string, body?: unknown, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-gateway-token': GW, ...extra };
    if (token) {
      const c = jwt.verify(token, SECRET) as { sub: string; ws: string; role: string; plan: string };
      Object.assign(headers, { 'x-user-id': c.sub, 'x-workspace-id': c.ws, 'x-role': c.role, 'x-plan': c.plan });
    }
    const res = await fetch(base + path, { method, headers, body: typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  it('regional prices on the plan list', async () => {
    const pk = await call('GET', '/v1/plans?country=PK');
    const pro = pk.body.plans.find((p: { id: string }) => p.id === 'pro');
    assert.equal(pk.body.country, 'PK');
    assert.equal(pro.monthly_price_cents, 2900);
    assert.equal(pro.regional_price_cents, 1000);
    const us = await call('GET', '/v1/plans?country=US');
    assert.equal(us.body.plans.find((p: { id: string }) => p.id === 'pro').regional_price_cents, 2900);
  });

  it('checkout -> signed webhook upgrades the plan once and grants the period credits once; cancel downgrades', async () => {
    const email = `bill-${Date.now()}@example.com`;
    const s = await call('POST', '/v1/auth/signup', undefined, { email, password: 'correct horse battery', name: 'Bill' });
    const token = s.body.access_token;
    const ws = s.body.workspace.id;
    assert.equal((await call('POST', '/v1/billing/checkout', token, { plan_id: 'starter' })).status, 400);
    const co = await call('POST', '/v1/billing/checkout', token, { plan_id: 'pro' });
    assert.equal(co.status, 200);
    assert.match(co.body.url, /\/app\/settings\/mock-checkout\?session=mock_cs_/);

    const { MockProvider } = await import('../src/billing');
    const mock = new MockProvider(`mock-billing:${GW}`, '');
    const paid = JSON.stringify({ id: 'evt_1', type: 'paid', workspace_id: ws, plan_id: 'pro', subscription: 'sub_1' });
    assert.equal((await call('POST', '/v1/billing/webhook', undefined, paid, { 'stripe-signature': 't=1,v1=00' })).status, 403);
    assert.equal((await call('POST', '/v1/billing/webhook', undefined, paid, { 'stripe-signature': mock.sign(paid.replace('pro', 'studio')) })).status, 403, 'tampered body');
    const before = grants.length;
    const r1 = await call('POST', '/v1/billing/webhook', undefined, paid, { 'stripe-signature': mock.sign(paid) });
    const r2 = await call('POST', '/v1/billing/webhook', undefined, paid, { 'stripe-signature': mock.sign(paid) });
    assert.deepEqual([r1.body.applied, r2.body.applied], [true, false]);
    const mine = grants.slice(before);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].amount, 1000);
    assert.match(mine[0].key, new RegExp(`^plan-grant:${ws}:sub_1:`));

    const viewerDenied = await call('GET', '/v1/billing/summary', token);
    assert.equal(viewerDenied.body.plan_id, 'pro');
    assert.equal(viewerDenied.body.status, 'active');

    const cancel = JSON.stringify({ id: 'evt_2', type: 'canceled', workspace_id: ws, plan_id: 'pro', subscription: 'sub_1' });
    assert.equal((await call('POST', '/v1/billing/webhook', undefined, cancel, { 'stripe-signature': mock.sign(cancel) })).body.applied, true);
    assert.equal((await call('GET', '/v1/billing/summary', token)).body.plan_id, 'starter');
  });

  it('verifies real Stripe signatures and rejects stale ones', async () => {
    const { verifyStripeSignature } = await import('../src/billing');
    const { createHmac } = await import('node:crypto');
    const raw = '{"id":"evt"}';
    const t = Math.floor(Date.now() / 1000);
    const sig = (ts: number) => `t=${ts},v1=${createHmac('sha256', 'whsec_test').update(`${ts}.${raw}`).digest('hex')}`;
    assert.doesNotThrow(() => verifyStripeSignature(raw, sig(t), 'whsec_test'));
    assert.throws(() => verifyStripeSignature(raw, sig(t - 600), 'whsec_test'), /stale/);
    assert.throws(() => verifyStripeSignature(raw, sig(t), 'whsec_other'), /invalid/);
  });

  it('Stripe checkout request uses the regional price when configured', async () => {
    const { StripeProvider } = await import('../src/billing');
    let sent: URLSearchParams | undefined;
    const fake = (async (_url: string, init: RequestInit) => {
      sent = new URLSearchParams(String(init.body));
      return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new StripeProvider('sk_test', 'whsec', { pro: 'price_global', pro_pk: 'price_pk' }, fake);
    const out = await p.createCheckout({ workspaceId: 'w', planId: 'pro', email: 'a@b.co', successUrl: 's', cancelUrl: 'c', country: 'PK' });
    assert.equal(out.url, 'https://checkout.stripe.com/c/cs_1');
    assert.equal(sent?.get('line_items[0][price]'), 'price_pk');
    assert.equal(sent?.get('subscription_data[metadata][workspace_id]'), 'w');
  });
});

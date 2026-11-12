// Phase 1 end-to-end test. Boots the real gateway, identity, ledger and cell-router
// against real PostgreSQL and Redis, then drives the whole foundation flow through
// the gateway exactly as a client would.
//
//   DATABASE_URL=... REDIS_URL=... node scripts/e2e-phase1.mjs
//
// Requires: `go build` output in ./bin (the script builds it) and `pnpm --filter @xen-studio/identity build`.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
const goDb = DATABASE_URL.includes('sslmode=') ? DATABASE_URL : `${DATABASE_URL}?sslmode=disable`;
const P = { gateway: 18080, identity: 18101, ledger: 18102, router: 18103 };
const INTERNAL = 'e2e-internal-token';
const env = {
  ...process.env, DATABASE_URL: goDb, GLOBAL_DATABASE_URL: goDb, REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-123456', INTERNAL_SERVICE_TOKEN: INTERNAL, CELL_ID: 'cell-local-1', LOG_LEVEL: 'warn',
  GATEWAY_ADDR: `:${P.gateway}`, LEDGER_ADDR: `:${P.ledger}`, ROUTER_ADDR: `:${P.router}`, IDENTITY_PORT: String(P.identity),
  IDENTITY_URL: `http://127.0.0.1:${P.identity}`, LEDGER_URL: `http://127.0.0.1:${P.ledger}`,
};

console.log('building…');
execFileSync('go', ['build', '-o', 'bin/', './services/...'], { cwd: root, stdio: 'inherit' });
execFileSync('node', ['scripts/migrate.mjs'], { cwd: root, env: { ...process.env, DATABASE_URL }, stdio: 'inherit' });
execFileSync('node', ['scripts/seed.mjs'], { cwd: root, env: { ...process.env, DATABASE_URL }, stdio: 'inherit' });

const procs = [
  spawn(join(root, 'bin/ledger'), { env, stdio: 'inherit' }),
  spawn(join(root, 'bin/cell-router'), { env, stdio: 'inherit' }),
  spawn(join(root, 'bin/gateway'), { env, stdio: 'inherit' }),
  spawn('node', ['dist/src/main.js'], { cwd: join(root, 'services/identity'), env: { ...env, DATABASE_URL }, stdio: 'inherit' }),
];
const stop = () => procs.forEach((p) => p.kill());
process.on('exit', stop);

async function waitReady(port) {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/readyz`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`service on :${port} did not become ready`);
}

const GW = `http://127.0.0.1:${P.gateway}`;
let ipCounter = 0;
async function api(method, path, { token, body, ip } = {}) {
  const res = await fetch(GW + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip ?? `10.9.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
async function internal(base, method, path, body, key) {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL, ...(key ? { 'idempotency-key': key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const steps = [];
const step = (name, fn) => steps.push([name, fn]);
const LEDGER = `http://127.0.0.1:${P.ledger}`;
const ROUTER = `http://127.0.0.1:${P.router}`;
const ctx = {};

step('signup through the gateway creates a workspace on the Starter plan', async () => {
  const email = `e2e-${randomUUID().slice(0, 8)}@example.com`;
  const r = await api('POST', '/v1/auth/signup', { body: { email, password: 'correct horse battery', name: 'E2E User' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  Object.assign(ctx, { email, token: r.body.access_token, refresh: r.body.refresh_token, ws: r.body.workspace.id });
  assert.equal(r.body.workspace.plan_id, 'starter');
});

step('the new workspace received exactly its 200 plan credits (20 video minutes) (identity -> ledger, idempotent)', async () => {
  const r = await api('GET', '/v1/credits', { token: ctx.token });
  assert.equal(r.status, 200);
  assert.deepEqual({ a: r.body.available, r: r.body.reserved, s: r.body.spent }, { a: 200, r: 0, s: 0 });
  // replaying the grant with the same key must not add credits
  const replay = await internal(LEDGER, 'POST', `/internal/v1/workspaces/${ctx.ws}/credits/grant`, { amount: 200, reason: 'starter plan initial credits' }, `workspace-initial-grant:${ctx.ws}`);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal((await api('GET', '/v1/credits', { token: ctx.token })).body.available, 200);
});

step('unauthenticated and forged requests are rejected at the gateway', async () => {
  assert.equal((await api('GET', '/v1/credits')).status, 401);
  assert.equal((await api('GET', '/v1/me', { token: ctx.token.slice(0, -4) + 'AAAA' })).status, 401);
  assert.equal((await api('POST', `/internal/v1/workspaces/${ctx.ws}/credits/grant`, { token: ctx.token, body: { amount: 1e6 } })).status, 404);
});

step('reserve -> commit (success path) debits once and returns the unused remainder', async () => {
  const res = await internal(LEDGER, 'POST', `/internal/v1/workspaces/${ctx.ws}/credits/reserve`, { amount: 120, job_id: 'job-e2e-1' }, 'job-e2e-1:reserve');
  assert.equal(res.status, 201);
  assert.equal((await api('GET', '/v1/credits', { token: ctx.token })).body.reserved, 120);
  const path = `/internal/v1/workspaces/${ctx.ws}/reservations/${res.body.reservation_id}/commit`;
  assert.equal((await internal(LEDGER, 'POST', path, { amount: 100 }, 'job-e2e-1:commit')).status, 201);
  assert.equal((await internal(LEDGER, 'POST', path, { amount: 100 }, 'job-e2e-1:commit')).status, 200); // retry
  const b = (await api('GET', '/v1/credits', { token: ctx.token })).body;
  assert.deepEqual({ a: b.available, r: b.reserved, s: b.spent }, { a: 100, r: 0, s: 100 });
});

step('reserve -> release (failure path) refunds in full; overdraw is refused with 402', async () => {
  const res = await internal(LEDGER, 'POST', `/internal/v1/workspaces/${ctx.ws}/credits/reserve`, { amount: 100, job_id: 'job-e2e-2' }, 'job-e2e-2:reserve');
  assert.equal(res.status, 201);
  const over = await internal(LEDGER, 'POST', `/internal/v1/workspaces/${ctx.ws}/credits/reserve`, { amount: 1, job_id: 'job-e2e-3' }, 'job-e2e-3:reserve');
  assert.equal(over.status, 402);
  const rel = await internal(LEDGER, 'POST', `/internal/v1/workspaces/${ctx.ws}/reservations/${res.body.reservation_id}/release`, { reason: 'provider failed' }, 'job-e2e-2:release');
  assert.equal(rel.status, 201);
  const b = (await api('GET', '/v1/credits', { token: ctx.token })).body;
  assert.deepEqual({ a: b.available, r: b.reserved, s: b.spent }, { a: 100, r: 0, s: 100 });
  const ledger = (await api('GET', '/v1/credits/ledger', { token: ctx.token })).body.entries;
  assert.deepEqual(ledger.map((e) => e.type).sort(), ['debit', 'grant', 'refund', 'refund', 'reserve', 'reserve']);
});

step('tenant isolation: a second account cannot see the first workspace', async () => {
  const r = await api('POST', '/v1/auth/signup', { body: { email: `e2e-${randomUUID().slice(0, 8)}@example.com`, password: 'correct horse battery', name: 'Other' } });
  assert.equal(r.status, 201);
  assert.equal((await api('GET', '/v1/credits', { token: r.body.access_token })).body.available, 200);
  assert.equal((await api('GET', `/v1/workspaces/${ctx.ws}/members`, { token: r.body.access_token })).status, 403);
  assert.equal((await api('POST', `/v1/workspaces/${ctx.ws}/token`, { token: r.body.access_token })).status, 403);
});

step('refresh rotates the session; login works; logout revokes', async () => {
  const r = await api('POST', '/v1/auth/refresh', { body: { refresh_token: ctx.refresh } });
  assert.equal(r.status, 200);
  assert.equal((await api('GET', '/v1/me', { token: r.body.access_token })).body.user.email, ctx.email);
  const l = await api('POST', '/v1/auth/login', { body: { email: ctx.email, password: 'correct horse battery' } });
  assert.equal(l.status, 200);
  assert.equal((await api('POST', '/v1/auth/logout', { body: { refresh_token: l.body.refresh_token } })).status, 204);
  assert.equal((await api('POST', '/v1/auth/refresh', { body: { refresh_token: l.body.refresh_token } })).status, 401);
});

step('the gateway enforces the Starter per-user rate limit (60/min, burst 31) with Retry-After', async () => {
  const results = await Promise.all(Array.from({ length: 80 }, () => api('GET', '/v1/workspaces', { token: ctx.token })));
  const limited = results.filter((r) => r.status === 429);
  const ok = results.filter((r) => r.status === 200);
  assert.ok(ok.length >= 20 && ok.length <= 34, `ok=${ok.length}`);
  assert.equal(ok.length + limited.length, 80);
  assert.ok(Number(limited[0].headers.get('retry-after')) >= 1);
});

step('login attempts are limited per IP', async () => {
  const results = await Promise.all(Array.from({ length: 45 }, () => api('POST', '/v1/auth/login', { ip: '203.0.113.7', body: { email: ctx.email, password: 'wrong password!!' } })));
  assert.equal(results.filter((r) => r.status === 429).length, 15);
});

step('the cell router pins the workspace to a cell and keeps it there', async () => {
  const a = await internal(ROUTER, 'GET', `/internal/v1/route/${ctx.ws}`);
  assert.equal(a.status, 200);
  assert.equal(a.body.cell.id, 'cell-local-1');
  await internal(ROUTER, 'PUT', '/internal/v1/cells/cell-e2e-extra', { region: 'local', endpoint: 'http://localhost:9999', weight: 100 });
  const b = await internal(ROUTER, 'GET', `/internal/v1/route/${ctx.ws}`);
  assert.equal(b.body.cell.id, a.body.cell.id, 'adding a cell must not move existing workspaces');
  await internal(ROUTER, 'PUT', '/internal/v1/cells/cell-e2e-extra', { region: 'local', endpoint: 'http://localhost:9999', weight: 100, status: 'offline' });
});

step('every service exposes health, readiness and Prometheus metrics', async () => {
  for (const port of [P.gateway, P.ledger, P.router]) {
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
    const m = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    assert.match(m, /http_requests_total\{/);
    assert.match(m, /http_request_duration_seconds_bucket\{/);
  }
  assert.equal((await fetch(`http://127.0.0.1:${P.identity}/healthz`)).status, 200);
});

let failed = 0;
try {
  await Promise.all(Object.values(P).map(waitReady));
  for (const [name, fn] of steps) {
    try { await fn(); console.log(`  ok  ${name}`); } catch (err) { failed++; console.log(`FAIL  ${name}\n      ${err.message}`); }
  }
} finally {
  stop();
}
console.log(failed ? `\n${failed} of ${steps.length} steps failed` : `\nPhase 1 e2e: all ${steps.length} steps passed`);
process.exit(failed ? 1 : 0);

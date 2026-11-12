// Starts the local stack: ledger, cell-router, gateway (Go), identity (NestJS), studio (Python:
// model router + Script-to-Video pipeline + project API; needs `pip install -e services/studio` and FFmpeg) and the web app. Infrastructure (SQL, Redis) must already be up:
//   docker compose -f infra/compose/docker-compose.yml up -d     (or local Postgres + Redis)
//   node scripts/dev.mjs            add --prod to serve the production web build
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env');
const fileEnv = existsSync(envFile)
  ? Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
  : {};
const env = { ...fileEnv, ...process.env };
for (const k of ['DATABASE_URL', 'JWT_SECRET', 'INTERNAL_SERVICE_TOKEN']) {
  if (!env[k]) { console.error(`${k} is not set. Copy .env.example to .env first.`); process.exit(1); }
}
const exe = process.platform === 'win32' ? '.exe' : '';
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32', ...opts });

run('go', ['build', '-o', 'bin/', './services/...']);
run('node', ['scripts/migrate.mjs']);
run('node', ['scripts/seed.mjs']);
run('pnpm', ['--filter', '@xen-studio/identity', 'build']);
const prod = process.argv.includes('--prod');
if (prod) run('pnpm', ['--filter', '@xen-studio/web', 'build']);

const procs = [
  ['ledger', join(root, 'bin', `ledger${exe}`), [], root],
  ['router', join(root, 'bin', `cell-router${exe}`), [], root],
  ['gateway', join(root, 'bin', `gateway${exe}`), [], root],
  ['identity', 'node', ['dist/src/main.js'], join(root, 'services', 'identity')],
  ['studio', process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-m', 'xen_studio.api.main'], join(root, 'services', 'studio')],
  ['web', 'pnpm', ['--filter', '@xen-studio/web', prod ? 'start' : 'dev'], root],
].map(([name, cmd, args, cwd]) => {
  const p = spawn(cmd, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' && (cmd === 'pnpm') });
  p.on('exit', (code) => console.log(`[${name}] exited with ${code}`));
  return p;
});
const stop = () => { procs.forEach((p) => p.kill()); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log('\nXen Studio is starting: web http://localhost:3000 · gateway http://localhost:8080\n');

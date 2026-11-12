import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
const b = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const c = await b.newContext({ viewport: { width: 1440, height: 1000 } });
await c.setExtraHTTPHeaders({ 'x-forwarded-for': `10.91.${Math.floor(Math.random() * 250)}.7` });
const p = await c.newPage();
const errors = []; p.on('pageerror', (e) => errors.push(String(e))); p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const base = 'http://localhost:3000';
const email = `p6-${Date.now()}@example.com`;
await p.goto(base + '/signup');
await p.getByLabel('Name').fill('Danial'); await p.getByLabel('Email').fill(email); await p.getByLabel('Password').fill('correct horse battery');
await p.getByRole('button', { name: 'Create account' }).click(); await p.waitForURL('**/app/video');

// 1. billing: upgrade to Studio through the simulated checkout
await p.goto(base + '/app/settings'); await p.waitForLoadState('networkidle');
await p.screenshot({ path: '/tmp/shots/p6-settings.png' });
await p.getByRole('button', { name: /Upgrade to Studio/ }).click();
await p.waitForURL('**/mock-checkout**'); await p.screenshot({ path: '/tmp/shots/p6-checkout.png' });
await p.getByRole('button', { name: /Pay and activate/ }).click();
await p.waitForURL('**/app/settings?billing=success'); await p.waitForLoadState('networkidle');
console.log('after checkout:', await p.getByText(/You are on/).textContent());
// the access token still carries the starter plan until it refreshes: force a refresh by clearing it
await c.clearCookies({ name: 'xs_at' }); await p.goto(base + '/app/credits'); await p.waitForLoadState('networkidle');
console.log('credits after upgrade:', await p.locator('dd').first().textContent());

// 2. animation from text
await p.goto(base + '/app/animation'); await p.waitForLoadState('networkidle');
await p.locator('textarea[name=text]').last().fill('Mira was a lighthouse keeper on a quiet island. Every night she lit the lamp and watched the sea. One stormy night a small whale lost its way near the rocks. Mira swung the beam towards open water. The whale followed the light and found its mother at dawn.');
await p.getByRole('radio', { name: 'Paper cut-out' }).click();
await p.getByRole('button', { name: 'Add character' }).click();
await p.getByLabel('Name', { exact: true }).fill('Mira'); await p.getByLabel('Look').fill('a keeper in a yellow raincoat');
await p.screenshot({ path: '/tmp/shots/p6-animation.png' });
await p.getByRole('button', { name: 'Adapt into a script' }).click();
await p.getByRole('button', { name: 'Approve and generate' }).click({ timeout: 30000 });
await p.getByRole('heading', { name: 'Review', exact: true }).waitFor({ timeout: 120000 });
await p.waitForTimeout(1500);
await p.screenshot({ path: '/tmp/shots/p6-animation-review.png' });

// 3. XR: generate assets, create a VR scene, add, move, autosave, export
await p.goto(base + '/app/vr'); await p.waitForLoadState('networkidle');
for (const prompt of ['a red rocket', 'a pine tree', 'wooden table']) {
  await p.getByLabel('Describe a 3D object').fill(prompt);
  await p.getByRole('button', { name: /Generate asset/ }).click();
  await p.waitForTimeout(300);
}
await p.getByText('Ready').nth(2).waitFor({ timeout: 30000 });
await p.getByRole('button', { name: 'New scene' }).click();
await p.getByLabel('Scene name').fill('Launch pad'); await p.getByRole('button', { name: 'Create scene' }).click();
await p.waitForURL('**/app/xr/scene/**'); await p.locator('canvas').waitFor();
for (const prompt of ['a red rocket', 'a pine tree', 'wooden table']) await p.getByRole('button', { name: `Add ${prompt} to the scene` }).click();
await p.getByLabel('Position (m) X').fill('0.5');
await p.getByRole('checkbox', { name: 'Spatial sound' }).check();
await p.getByRole('combobox', { name: 'Environment' }).click(); await p.getByRole('option', { name: 'Night' }).click();
await p.getByText('Saved', { exact: true }).waitFor({ timeout: 10000 });
await p.waitForTimeout(1500);
await p.screenshot({ path: '/tmp/shots/p6-xr-editor.png' });
const dl = p.waitForEvent('download');
await p.getByRole('link', { name: 'Export GLB' }).click();
const file = await (await dl).path();
const head = execFileSync('head', ['-c', '4', file]).toString();
console.log('export magic:', head);
await p.reload(); await p.locator('canvas').waitFor(); await p.waitForTimeout(800);
console.log('objects after reload:', await p.getByRole('button', { name: /^(a red rocket|a pine tree|wooden table)$/ }).count());

// 4. admin (make staff, reload)
execFileSync('node', ['../../scripts/make-staff.mjs', email], { env: { ...process.env, DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/xen_studio' } });
await p.goto(base + '/app/admin'); await p.waitForLoadState('networkidle');
await p.screenshot({ path: '/tmp/shots/p6-admin.png', fullPage: true });
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
await b.close();

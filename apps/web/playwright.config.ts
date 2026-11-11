import { defineConfig } from '@playwright/test';

// Visual regression for key screens. Needs the stack running: `node scripts/dev.mjs --prod`.
export default defineConfig({
  testDir: './e2e',
  snapshotDir: './e2e/__screenshots__',
  use: { baseURL: process.env.WEB_URL ?? 'http://localhost:3000', channel: process.env.PW_CHANNEL },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' } },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { viewport: { width: 360, height: 760 } } },
  ],
});

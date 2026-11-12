import { expect, test } from '@playwright/test';

// Each test presents its own client address so the gateway's per-IP auth limit (30/min) does not couple tests together.
test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
});

test('marketing home', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow').toBe(true);
  await expect(page).toHaveScreenshot('home.png');
});

test('pricing shows the three plans', async ({ page }) => {
  await page.goto('/pricing');
  for (const plan of ['Starter', 'Pro', 'Studio']) await expect(page.getByRole('heading', { name: plan, exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot('pricing.png');
});

test('login and signup', async ({ page }) => {
  await page.goto('/login');
  await expect(page).toHaveScreenshot('login.png');
  await page.goto('/signup');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert').first()).toBeVisible(); // designed error state
  await expect(page).toHaveScreenshot('signup-errors.png');
});

test('signup lands in the app shell; palette, shortcuts, credits, RTL and light theme work', async ({ page, context, baseURL }) => {
  await page.goto('/signup');
  await page.getByLabel('Name').fill('Visual Test');
  await page.getByLabel('Email').fill(`visual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/app/video');
  await expect(page).toHaveScreenshot('app-video.png');

  await page.keyboard.press('Control+k');
  await expect(page.getByPlaceholder('Search or jump to…').last()).toBeFocused();
  await page.keyboard.type('credits');
  await page.keyboard.press('Enter');
  await page.waitForURL('**/app/credits');
  await expect(page.getByText('200').first()).toBeVisible(); // plan credits arrived from the ledger
  await page.reload(); // fresh render: no leftover focus ring, overlay or tooltip from the palette
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('200').first()).toBeVisible();
  await expect(page).toHaveScreenshot('credits.png', { mask: [page.locator('time')] });

  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await page.keyboard.press('g');
    await page.keyboard.press('x');
    await page.waitForURL('**/app/xr');
  }

  // Script-to-Video: prompt -> script approval -> live generation -> review player (mock providers, real FFmpeg)
  await page.goto('/app/video');
  await page.waitForLoadState('networkidle'); // streaming can briefly leave two copies of the form in the DOM
  await page.locator('textarea[name=prompt]').last().fill('A short documentary about the Tunguska event of 1908');
  await page.getByRole('button', { name: 'Write script' }).click();
  await page.getByRole('heading', { name: 'Script', exact: true }).waitFor({ timeout: 30_000 });
  await expect(page).toHaveScreenshot('video-script.png');
  await page.getByRole('button', { name: 'Approve and generate' }).click();
  await page.getByRole('heading', { name: 'Review', exact: true }).waitFor({ timeout: 120_000 });
  const duration = await page.evaluate(() => new Promise<number>((resolve) => {
    const v = document.querySelector('video')!;
    if (v.readyState > 0) resolve(v.duration); else v.onloadedmetadata = () => resolve(v.duration);
  }));
  expect(duration).toBeGreaterThan(5);
  await expect(page).toHaveScreenshot('video-review.png', { mask: [page.locator('video')] });

  // Phase 3 slice: publish package, vertical export, notifications
  await expect(page.getByRole('heading', { name: 'Publish package' })).toBeVisible();
  await expect(page.getByText('The Truth About the Tunguska event of 1908')).toBeVisible();
  await page.getByRole('button', { name: 'Create 9:16' }).click();
  await expect(page.getByRole('link', { name: 'Download 9:16' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await expect(page.getByText(/Your video is ready to review/)).toBeVisible();
  await expect(page.getByText(/Your script is ready to approve/)).toBeVisible();
  await page.keyboard.press('Escape');

  await context.addCookies([{ name: 'xs_locale', value: 'ar', url: baseURL! }, { name: 'xs_theme', value: 'light', url: baseURL! }]);
  await page.goto('/app/credits');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page).toHaveScreenshot('credits-ar-light.png', { mask: [page.locator('time')] });
});

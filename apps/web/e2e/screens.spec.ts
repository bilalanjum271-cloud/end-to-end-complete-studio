import { expect, test } from '@playwright/test';

test('marketing home', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow').toBe(true);
  await expect(page).toHaveScreenshot('home.png');
});

test('pricing shows the three plans', async ({ page }) => {
  await page.goto('/pricing');
  for (const plan of ['Starter', 'Creator', 'Studio']) await expect(page.getByRole('heading', { name: plan, exact: true })).toBeVisible();
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
  await expect(page).toHaveScreenshot('app-video.png', { mask: [page.getByText('Visual Test')] });

  await page.keyboard.press('Control+k');
  await expect(page.getByPlaceholder('Search or jump to…').last()).toBeFocused();
  await page.keyboard.type('credits');
  await page.keyboard.press('Enter');
  await page.waitForURL('**/app/credits');
  await expect(page.getByText('300').first()).toBeVisible(); // plan credits arrived from the ledger
  await expect(page).toHaveScreenshot('credits.png', { mask: [page.locator('time')] });

  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await page.keyboard.press('g');
    await page.keyboard.press('x');
    await page.waitForURL('**/app/xr');
  }
  await context.addCookies([{ name: 'xs_locale', value: 'ar', url: baseURL! }, { name: 'xs_theme', value: 'light', url: baseURL! }]);
  await page.goto('/app/credits');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page).toHaveScreenshot('credits-ar-light.png', { mask: [page.locator('time')] });
});

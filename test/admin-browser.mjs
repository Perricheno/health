import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const base = process.env.TEST_URL || 'http://localhost:8787';
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
await mkdir('test-results', { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator('.bars').first().waitFor();
  const session = page.waitForResponse(r => r.url().endsWith('/api/admin/session'));
  await page.locator('#admin-open').click();
  await session;
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#admin-dialog').evaluate(el => el.open), true);
  await page.screenshot({ path: 'test-results/admin-pin-light.png', fullPage: true });
  for (const digit of '1111') await page.locator(`[data-digit="${digit}"]`).click();
  await page.waitForFunction(() => document.querySelector('#pin-message').textContent.includes('Incorrect'));
  assert.equal(await page.locator('.pin-dots .filled').count(), 0);
  for (const digit of '0000') await page.keyboard.press(digit);
  await page.locator('#settings-view').waitFor({ state: 'visible' });
  const target = await page.locator('[data-seconds="1"]').getAttribute('aria-pressed') === 'true' ? '5' : '1';
  await page.locator(`[data-seconds="${target}"]`).click();
  await page.locator('#settings-save').click();
  await page.waitForFunction(() => document.querySelector('#settings-message').textContent.startsWith('Saved.'));
  assert.equal((await (await page.request.get(`${base}/api/live`)).json()).interval, Number(target) * 1000);
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/admin-settings-light.png', fullPage: true });
  await page.locator('#admin-close').click();
  await page.reload();
  await page.locator('#admin-open').click();
  await page.locator('#settings-view').waitFor({ state: 'visible' });
  assert.equal(await page.locator(`[data-seconds="${target}"]`).getAttribute('aria-pressed'), 'true');
  if (target !== '1') {
    await page.locator('[data-seconds="1"]').click(); await page.locator('#settings-save').click();
    await page.waitForFunction(() => document.querySelector('#settings-message').textContent.startsWith('Saved.'));
  }
  await page.locator('#admin-logout').click();
  await page.locator('#pin-view').waitFor({ state: 'visible' });
  assert.equal((await page.request.get(`${base}/api/admin/session`)).status(), 401);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#admin-dialog').evaluate(el => el.open), false);
  assert.equal(await page.locator('#admin-open').evaluate(el => el === document.activeElement), true);
  await page.locator('#theme-toggle').click(); await page.waitForTimeout(800);
  await page.locator('#admin-open').click(); await page.waitForTimeout(350);
  await page.screenshot({ path: 'test-results/admin-pin-dark.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 568 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('#admin-dialog').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  assert.deepEqual(errors, []);
  console.log('Admin browser checks passed: keypad, physical keyboard, wrong PIN, login, save, session persistence, logout, focus, mobile themes.');
} finally { await browser.close(); }

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { summarize, DAY } from '../src/monitor.js';

const base = process.env.TEST_URL || 'http://127.0.0.1:8787';
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const errors = [];
await mkdir('test-results', { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, colorScheme: 'light' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator('.bars').waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.fonts.check('14px Inter')), true);
  assert.ok(await page.locator('#theme-icon path').getAttribute('d'));
  assert.match(await page.locator('body').evaluate(el => getComputedStyle(el).fontFamily), /^Inter/);
  assert.equal(await page.locator('.bar').count(), 48);
  assert.match(await page.locator('.service-card h2').textContent(), /api.perricheno.com/);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'test-results/desktop-light.png', fullPage: true });
  await page.locator('.bars').focus();
  await page.keyboard.press('Home');
  assert.equal(await page.locator('.bars').getAttribute('aria-valuenow'), '1');
  assert.match(await page.locator('.tooltip-status').textContent(), /No observations/);
  await page.keyboard.press('End');
  assert.equal(await page.locator('.bars').getAttribute('aria-valuenow'), '48');
  await page.keyboard.press('Escape');
  assert.ok(!await page.locator('.tooltip').evaluate(el => el.classList.contains('visible')));
  for (const range of ['1m', '5m', '7d', '30d', '24h']) {
    await page.locator(`[data-range="${range}"]`).click();
    await page.waitForFunction(() => document.querySelector('.service-card').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator(`[data-range="${range}"]`).getAttribute('aria-pressed'), 'true');
  }
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${width}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/mobile-light.png', fullPage: true });
  await page.locator('#theme-toggle').click();
  await page.waitForTimeout(900);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.screenshot({ path: 'test-results/mobile-dark.png', fullPage: true });
  await page.reload();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.locator('.bars').waitFor();
  await context.setOffline(true);
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !document.querySelector('#notice').hidden);
  assert.match(await page.locator('#notice').textContent(), /offline/i);
  await context.setOffline(false);
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#notice').hidden);

  // Reference-only fixtures exercise a complete history without fabricating production data.
  const now = Date.now();
  const samples = Array.from({ length: 1440 }, (_, index) => ({ time: now - DAY + (index + 1) * 60000, status: 'operational', latency: 120 + index % 40, code: 200 }));
  await page.route('**/api/status?*', route => {
    const range = new URL(route.request().url()).searchParams.get('range') || '24h';
    return route.fulfill({ json: { siteName: 'perricheno', overall: 'operational', updatedAt: now, now, range, interval: 60000, services: [{ id: 'api', name: 'API (api.perricheno.com)', status: 'operational', checkedAt: now, ...summarize(samples, range, now) }] } });
  });
  await page.reload();
  await page.locator('.bars').waitFor();
  await page.waitForTimeout(1300);
  await page.screenshot({ path: 'test-results/reference-full-history-dark.png', fullPage: true });
  await page.locator('#theme-toggle').click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'test-results/reference-full-history-light.png', fullPage: true });
  const chart = await page.locator('.bars').boundingBox();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: chart.x + 8, y: chart.y + 25 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: chart.x + chart.width - 8, y: chart.y + 25 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.ok(Number(await page.locator('.bars').getAttribute('aria-valuenow')) > 40);
  assert.match(await page.locator('.tooltip-status').textContent(), /Operational/);
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/mobile-touch-tooltip.png', fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.status-dot.large').evaluate(el => getComputedStyle(el, '::after').animationName), 'none');
  await page.route('**/api/status?*', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
  await page.reload();
  await page.locator('#retry').waitFor();
  assert.match(await page.locator('#overall').textContent(), /Unavailable/);
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: responsive layouts, themes, history periods, keyboard, touch, reduced motion, offline recovery, error state.');
} finally { await browser.close(); }

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tests that need a real browser.
 *
 * These exist because two classes of bug are invisible to tests that drive the
 * API over fetch: anything the Content-Security-Policy blocks, and anything
 * that only happens during client-side navigation. Both have bitten this
 * project — an inline script on the LTI landing page silently blocked every
 * launch, and a hash navigation quietly ignored the curriculum in the URL.
 *
 * The suite skips itself when no browser is available, so `npm test` still
 * runs anywhere.
 */
function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root).sort().reverse()) {
    const candidate = join(root, entry, 'chrome-linux', 'chrome');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const executablePath = findChromium();
let playwright = null;
try {
  playwright = await import('playwright');
} catch {
  playwright = null;
}

const canRun = Boolean(executablePath && playwright);

describe('browser', { skip: canRun ? false : 'no chromium available' }, () => {
  let server;
  let browser;
  let base;

  before(async () => {
    const { startServer } = await import('./helpers.js');
    server = await startServer();
    base = server.base;
    browser = await playwright.chromium.launch({ executablePath });
  });

  after(async () => {
    await browser?.close();
    await server?.close();
  });

  /** A signed-in page at the given path, collecting any console errors. */
  async function open(path) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    if (await page.locator('input[placeholder="Your name"]').count()) {
      await page.fill('input[placeholder="Your name"]', 'Miss Hart');
      await page.click('button[type="submit"]');
      await page.waitForSelector('.page-head h1');
    }
    if (path !== '/') {
      await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
    }
    await page.waitForTimeout(500);
    return { page, errors };
  }

  test('the app shell loads and runs with no console errors', async () => {
    const { page, errors } = await open('/');
    assert.equal(await page.locator('.page-head h1').textContent(), 'Plan your teaching');
    assert.deepEqual(errors, [], 'the Content-Security-Policy must not block the app');
    await page.close();
  });

  test('the LTI landing page executes its script', async () => {
    // A regression guard: this page once used an inline module script, which
    // the CSP blocks, leaving every real launch stuck on "Completing your
    // launch…" forever. If the script runs, a bad token produces an error.
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${base}/launch.html?handoff=not-a-real-token`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    const status = await page.locator('#status').textContent();
    assert.match(status, /invalid or has expired/, 'the handoff exchange should have run and failed');
    assert.ok(
      !errors.some((e) => /Content Security Policy/i.test(e)),
      `CSP blocked something on the launch page: ${errors.join('; ')}`
    );
    await page.close();
  });

  test('launch.html carries no inline script for the CSP to block', () => {
    const html = readFileSync(new URL('../public/launch.html', import.meta.url), 'utf8');
    assert.doesNotMatch(
      html,
      /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/,
      'inline scripts are blocked by the tool\'s own Content-Security-Policy'
    );
  });

  test('a curriculum named in the query string is selected', async () => {
    const { page, errors } = await open('/?subject=physics&keyStage=KS3');
    assert.equal(await page.locator('.form-grid select >> nth=0').inputValue(), 'physics-ks3');
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('a curriculum named in the hash query is selected during navigation', async () => {
    // A hash change is a same-document navigation, so this only works if the
    // address is re-read on hashchange rather than only on first load.
    const { page } = await open('/');
    await page.evaluate(() => { location.hash = '#/library?subject=physics'; });
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.page-head h1').textContent(), 'Key stage 3 Physics library');

    await page.evaluate(() => { location.hash = '#/library?subject=chemistry'; });
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.page-head h1').textContent(), 'Key stage 3 Chemistry library');
    assert.equal(await page.locator('.unitcard').count(), 9);
    await page.close();
  });

  test('a curriculum that is not installed explains itself and falls back', async () => {
    const { page } = await open('/?subject=biology&keyStage=KS3');
    const notice = await page.locator('.callout').first().textContent();
    assert.match(notice, /No biology curriculum is installed/);
    assert.match(notice, /Showing Key stage 3 Chemistry instead/);
    assert.equal(await page.locator('.form-grid select >> nth=0').inputValue(), 'chemistry-ks3');
    await page.close();
  });

  test('switching curriculum puts it in the address bar, so the page can be shared', async () => {
    const { page } = await open('/#/library?spine=physics-ks3');
    assert.equal(await page.locator('.page-head h1').textContent(), 'Key stage 3 Physics library');
    await page.selectOption('.page-head__actions select', 'chemistry-ks3');
    await page.waitForTimeout(800);
    const href = await page.evaluate(() => location.href);
    assert.match(href, /subject=chemistry/);
    assert.match(href, /keyStage=KS3/);
    assert.doesNotMatch(href, /spine=physics-ks3/, 'the stale request is cleared');
    await page.close();
  });
});

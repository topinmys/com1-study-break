// browser checks use isolated data and replace deployed project settings before loading the page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import bcrypt from 'bcryptjs';
import { database, rpcAdapter, fake } from './helpers.mjs';
import { createHandler } from '../supabase/functions/event-api/handler.js';
let db, server, browser, base, html;
const pin = '87463921'; // synthetic test pin only. never deployed.
// serve the actual frontend and handler against a temporary test database.
before(async () => {
  db = await database();
  html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const env = {
    ALLOWED_ORIGINS: '',
    ORGANISER_PIN_HASH: await bcrypt.hash(pin, 4),
    RATE_LIMIT_SECRET: 'fake-test-secret',
  };
  let handler;
  server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/assets/computing-club-logo.png') {
      res
        .writeHead(200, { 'content-type': 'image/png' })
        .end(await readFile(new URL('../assets/computing-club-logo.png', import.meta.url)));
      return;
    }
    if (req.method === 'GET') {
      const unconfigured = req.url.includes('unconfigured');
      // always override deployment values so automated tests cannot reach production.
      const source = html
        .replace(
          /supabaseUrl: '[^']*'/,
          `supabaseUrl: '${unconfigured ? 'https://YOUR_PROJECT_REF.supabase.co' : base}'`,
        )
        .replace(
          /publishableKey: '[^']*'/,
          `publishableKey: '${unconfigured ? 'YOUR_SUPABASE_PUBLISHABLE_KEY' : 'fake-public-key'}'`,
        );
      res.writeHead(200, { 'content-type': 'text/html' }).end(source);
      return;
    }
    const parts = [];
    for await (const part of req) parts.push(part);
    const response = await handler(
      new Request(`${base}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(parts),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers)).end(await response.text());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  env.ALLOWED_ORIGINS = base;
  handler = createHandler({ env, comparePin: bcrypt.compare, rpc: rpcAdapter(db) });
  browser = await chromium.launch();
  await mkdir('test-results', { recursive: true });
});
after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
  await db?.close();
});
// open a phone-sized browser and wait until test capacity has loaded.
async function page(width = 390) {
  const context = await browser.newContext({ viewport: { width, height: 844 } });
  // layout is also usable if the cdn is unavailable; tests exercise this fallback.
  await context.route('https://cdn.tailwindcss.com/**', (route) => route.abort());
  const page = await context.newPage();
  await page.goto(base);
  await page.locator('#register-button').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('register-button').disabled);
  return page;
}
// enter fake details without creating any real event registration.
async function fill(page, n, name = fake(n).fullName) {
  const data = fake(n);
  await page.locator('#full-name').fill(name);
  await page.locator('#email').fill(data.email);
  await page.locator('#student-id').fill(data.studentId);
  await page.locator('#telegram').fill('@fake_student');
}
// use the fake test pin to open the organiser dashboard.
async function login(page) {
  await page.locator('#organiser-access').click();
  await page.locator('#pin').fill(pin);
  await page.locator('#login-button').click();
  await page.locator('#dashboard-view').waitFor({ state: 'visible' });
  await page.waitForFunction(() =>
    document.getElementById('sync-status').textContent.startsWith('Synced'),
  );
}
test('phone registration, safe text rendering, refresh persistence and duplicate handling', async () => {
  const p = await page(360);
  assert.equal(
    await p.locator('.brand-logo').evaluate((img) => img.complete && img.naturalWidth > 0),
    true,
  );
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await p.screenshot({ path: 'test-results/student-mobile.png', fullPage: true });
  const name = '<img src=x onerror=alert(1)>';
  await fill(p, 1, name);
  await p.locator('#register-button').click();
  await p.locator('#success-state').waitFor({ state: 'visible' });
  assert.match(await p.locator('#success-state').innerText(), /One cup is reserved/);
  assert.ok((await p.locator('#success-name').textContent()).includes(name));
  assert.equal(await p.locator('#success-name img').count(), 0);
  await p.reload();
  await p.waitForFunction(() => !document.getElementById('register-button').disabled);
  await fill(p, 1);
  await p.locator('#register-button').click();
  await p.locator('#registration-error').waitFor({ state: 'visible' });
  assert.match(await p.locator('#registration-error').innerText(), /already registered/);
  assert.equal((await db.query('select count(*)::int as n from private.attendees')).rows[0].n, 1);
  await p.context().close();
});
test('failed network request gives no false registration confirmation', async () => {
  const p = await page();
  await p.route('**/functions/v1/event-api', async (route) => {
    if (route.request().postDataJSON().action === 'register') await route.abort();
    else await route.continue();
  });
  await fill(p, 2);
  await p.locator('#register-button').click();
  await p.locator('#registration-error').waitFor({ state: 'visible' });
  assert.match(await p.locator('#registration-error').innerText(), /Could not confirm/);
  assert.equal(await p.locator('#success-state').isVisible(), false);
  assert.equal((await db.query('select count(*)::int as n from private.attendees')).rows[0].n, 1);
  await p.context().close();
});
test('organiser controls, undo, failed saves, search, polling and second session', async () => {
  const p = await page();
  const second = await page(360);
  await login(p);
  await login(second);
  const card = p.locator('.attendee').first();
  assert.equal(await card.locator('.cup').count(), 0);
  await card.locator('.check').click();
  await p.waitForFunction(() => document.getElementById('total-checked').textContent === '1');
  await second.locator('#search').fill('T0000001');
  await second.waitForFunction(
    () => document.getElementById('total-checked').textContent === '1',
    null,
    { timeout: 12000 },
  );
  assert.equal(await second.locator('#search').inputValue(), 'T0000001');
  assert.equal(
    await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await second.screenshot({ path: 'test-results/organiser-mobile.png', fullPage: true });
  await card.locator('.check').click();
  await p.waitForFunction(() => document.getElementById('total-checked').textContent === '0');
  await p.route('**/functions/v1/event-api', async (route) => {
    if (route.request().postDataJSON().action === 'update') await route.abort();
    else await route.continue();
  });
  await card.locator('.check').click();
  await p.locator('#dashboard-error').waitFor({ state: 'visible' });
  assert.equal(await p.locator('#total-checked').innerText(), '0');
  assert.equal(await card.locator('.check').innerText(), 'Check in & give cup');
  await p.locator('#search').fill('no_such_fake_attendee');
  assert.match(await p.locator('#empty-state').innerText(), /No matches/);
  await p.locator('#logout').click();
  await p.locator('#login-view').waitFor({ state: 'visible' });
  assert.equal(await p.locator('.attendee').count(), 0);
  await p.context().close();
  await second.context().close();
});
test('unconfigured site disables registration honestly; desktop fits without scrolling sideways', async () => {
  const p = await page(1280);
  await p.screenshot({ path: 'test-results/student-desktop.png', fullPage: true });
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await p.setViewportSize({ width: 320, height: 740 });
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await p.goto(`${base}/?unconfigured`);
  await p.locator('#capacity-error').waitFor({ state: 'visible' });
  assert.match(await p.locator('#capacity-error').innerText(), /not connected yet/);
  assert.equal(await p.locator('#register-button').isDisabled(), true);
  await p.context().close();
});
test('capacity loss during form entry hides the form and gives the full message', async () => {
  const p = await page();
  await fill(p, 3);
  await p.route('**/functions/v1/event-api', async (route) => {
    if (route.request().postDataJSON().action === 'register')
      await route.fulfill({ status: 409, json: { error: 'FULL' } });
    else await route.continue();
  });
  await p.locator('#register-button').click();
  await p.locator('#full-state').waitFor({ state: 'visible' });
  assert.match(
    await p.locator('#full-state').innerText(),
    /Fully booked\. Registered attendees only; no walk-ins\./,
  );
  assert.equal(await p.locator('#registration-form').isVisible(), false);
  await p.context().close();
});

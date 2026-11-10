// End-to-end tests of the Contexts tab and the per-component Contexts section,
// driving the real panel against the AIUX fixture (harness.html?page=aiux).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { launchChromium } from './browser.mjs';
import { startServer } from './serve.mjs';

let server, browser, page, panel, inspected;
const errors = [];

before(async () => {
  server = await startServer();
  browser = await launchChromium();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => errors.push(e));
  await page.goto(`http://127.0.0.1:${server.address().port}/test/harness.html?page=aiux`);
  await page.waitForSelector('#panel');
  panel = page.frameLocator('#panel');
  inspected = page.frameLocator('#inspected');
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
});

after(async () => {
  await browser?.close();
  server?.close();
});

const ctx = () => panel.locator('#ctx-details');
const row = (sectionClass, key) =>
  ctx().locator(`.${sectionClass} .row`).filter({ has: panel.locator('.key', { hasText: new RegExp('^' + key.replace(/[()]/g, '\\$&') + '$') }) });

test('the Contexts tab lists global and scoped contexts', async () => {
  await panel.locator('.tree-row').first().waitFor();
  await panel.locator('.tab', { hasText: 'Contexts' }).click();
  await ctx().locator('.section-ctx-global .row').first().waitFor();
  assert.equal(await ctx().locator('.details-header .tag').textContent(), 'Contexts');
  assert.deepEqual(await ctx().locator('.details-header .badge').allTextContents(), ['4 contexts in use']);
  assert.deepEqual(await ctx().locator('.section-ctx-global > .section-body > .node > .row .key').allTextContents(), ['route', 'user (immutable)']);
  assert.deepEqual(await ctx().locator('.section-ctx-scoped > .section-body > .node > .row .key').allTextContents(), [
    'record-apis (scoped)',
    'kit-theme (@lit/context)'
  ]);
  assert.equal(await ctx().locator('.details-header .actions button').count(), 0, 'no element actions for the page view');
});

test('editing a global context updates every component that subscribes to it', async () => {
  await row('section-ctx-global', 'route').click();
  const path = row('section-ctx-global', 'path');
  await path.locator('.val').dblclick();
  await ctx().locator('.edit-input').fill('"/now/change/CHG0030001"');
  await ctx().locator('.edit-input').press('Enter');
  await inspected.locator('aiux-checklist .route', { hasText: '/now/change/CHG0030001' }).waitFor();
  await inspected.locator('kit-route-widget .path', { hasText: '/now/change/CHG0030001' }).waitFor();
  assert.match(await panel.locator('#ctx-status').textContent(), /context "route"\.set\(\)/);
  await page.screenshot({ path: 'test-results/contexts.png' });
});

test('immutable contexts refuse edits, with a reason', async () => {
  await row('section-ctx-global', 'user (immutable)').click();
  await row('section-ctx-global', 'name').locator('.val').dblclick();
  await ctx().locator('.edit-input').fill('"Mallory"');
  await ctx().locator('.edit-input').press('Enter');
  await panel.locator('#ctx-status.error', { hasText: 'The "user" context is immutable' }).waitFor();
  assert.match(await inspected.locator('aiux-checklist .route').textContent(), /Abel Tuter/);
});

test('changes made by the page show up live', async () => {
  await inspected.locator('body').evaluate(() => {
    const route = window.__fixture.routeContext;
    route.set({ ...route.get(), path: '/now/home' });
  });
  await row('section-ctx-global', 'path').locator('.val', { hasText: '/now/home' }).waitFor({ timeout: 6000 });
});

test('a consumer link jumps to that component, whose own Contexts section agrees', async () => {
  await row('section-ctx-consumers', 'route').click();
  const links = ctx().locator('.section-ctx-consumers .val.link');
  assert.deepEqual(await links.allTextContents(), ['<aiux-checklist#list>', '<aiux-record-field>', '<aiux-record-field>', '<kit-route-widget>']);
  await links.nth(1).click();
  await panel.locator('#tab-components:not(.hidden) #details .details-header .tag', { hasText: '<aiux-record-field>' }).waitFor();
  const keys = panel.locator('#details .section-contexts > .section-body > .node > .row .key');
  await keys.first().waitFor();
  assert.deepEqual(await keys.allTextContents(), ['record-apis (scoped)', 'route']);
  await panel.locator('#details .section-contexts .row', { hasText: 'record-apis' }).click();
  await panel.locator('#details .section-contexts .row', { hasText: 'table' }).locator('.val', { hasText: 'incident' }).waitFor();
});

test('no uncaught errors', () => {
  assert.deepEqual(errors.map(String), []);
});

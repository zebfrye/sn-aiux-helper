// End-to-end tests of the Events tab and the Lit/AIUX inspector, driving the
// real panel against the AIUX fixture (harness.html?page=aiux).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';

let server, browser, page, panel, inspected;
const errors = [];

before(async () => {
  server = await startServer();
  browser = await chromium.launch();
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

const rows = () => panel.locator('#ev-list .event-row');
const types = () => panel.locator('#ev-list .event-row .c-type').allTextContents();

test('Components tab shows Lit properties and @state for AIUX components', async () => {
  await panel.locator('.tree-row', { hasText: 'content-toolbar' }).waitFor();
  await panel.locator('.tree-row', { hasText: 'aiux-checklist' }).click();
  await panel.locator('.section-state .row').first().waitFor();
  assert.deepEqual(await panel.locator('.section-state .row .key').allTextContents(), ['_activeIndex', '_draft', '_islandActivated']);
  assert.deepEqual(await panel.locator('.details-header .badge').allTextContents(), ['Custom Element', 'ServiceNow', 'Lit', 'AIUX']);
  assert.ok((await panel.locator('.section-events .row .key').allTextContents()).includes('aiux-checklist:item-clicked'));
});

test('recording logs events dispatched by components', async () => {
  await panel.locator('.tab', { hasText: 'Events' }).click();
  await panel.locator('#ev-record').click();
  await panel.locator('#ev-record.active').waitFor();
  await inspected.locator('aiux-checklist li').nth(1).click();
  await inspected.locator('content-toolbar button').first().click();
  await rows().nth(1).waitFor();
  assert.deepEqual(await types(), ['aiux-checklist:item-clicked', 'content-toolbar:action']);
  assert.deepEqual(await panel.locator('#ev-list .event-row .c-src').allTextContents(), ['aiux-checklist#list', 'content-toolbar']);
  assert.match(await panel.locator('#ev-status').textContent(), /Recording · 2 events/);
  assert.equal(await panel.locator('#events-badge').textContent(), '2');
});

test('selecting an event shows its detail and where it came from', async () => {
  await rows().first().click();
  await panel.locator('#ev-details .section-event-detail .row').first().waitFor();
  assert.equal(await panel.locator('#ev-details .details-header .tag').textContent(), 'aiux-checklist:item-clicked');
  assert.deepEqual(await panel.locator('#ev-details .section-event-detail > .section-body > .node > .row .key').allTextContents(), ['item', 'index']);
  const info = panel.locator('#ev-details .section-event-info');
  assert.match(await info.locator('.row', { hasText: 'declared' }).textContent(), /yes — @fires on aiux-checklist/);
  await page.screenshot({ path: 'test-results/events.png' });
});

test('filter supports include and -exclude terms', async () => {
  await panel.locator('#ev-filter').fill('toolbar');
  assert.deepEqual(await types(), ['content-toolbar:action']);
  await panel.locator('#ev-filter').fill('-toolbar');
  assert.deepEqual(await types(), ['aiux-checklist:item-clicked']);
  await panel.locator('#ev-filter').fill('');
});

test('jumping to the source component shows observed events and listeners', async () => {
  await rows().first().click();
  await panel.locator('#ev-details .go-source').click();
  await panel.locator('#tab-components:not(.hidden) .tree-row.selected', { hasText: 'aiux-checklist' }).waitFor();
  const clicked = panel.locator('#details .section-events .row', { hasText: 'aiux-checklist:item-clicked' });
  await clicked.locator('.val', { hasText: '×1 dispatched' }).waitFor();

  // Listeners are collapsed by default; open the section and reveal the function.
  await panel.locator('#details .section-listeners .section-head').click();
  const keydown = panel.locator('#details .section-listeners .row', { hasText: 'keydown' });
  assert.equal(await keydown.locator('.val').textContent(), 'ƒ _onKeyDown()');
  await keydown.hover();
  await keydown.locator('button', { hasText: '{}' }).click();
  await page.waitForFunction(() => typeof window.__aiuxMock.inspected === 'function');
  assert.equal(await page.evaluate(() => window.__aiuxMock.inspected.name), '_onKeyDown');
  await page.screenshot({ path: 'test-results/aiux-component.png' });
});

test('stopping recording stops logging', async () => {
  await panel.locator('.tab', { hasText: 'Events' }).click();
  await panel.locator('#ev-record').click();
  await panel.locator('#ev-record:not(.active)').waitFor();
  await inspected.locator('aiux-checklist li').first().click();
  await page.waitForTimeout(800);
  assert.equal(await rows().count(), 2);
});

test('Reload & record captures events fired while the page boots', async () => {
  await panel.locator('#ev-reload').click();
  await panel.locator('#ev-list .event-row', { hasText: 'aiux-checklist:ready' }).waitFor({ timeout: 10000 });
  const logged = await types();
  assert.ok(logged.includes('aiux:app-ready'), logged.join(','));
  assert.ok(!logged.includes('content-toolbar:action'), 'the previous log was cleared');
  assert.match(await panel.locator('#ev-status').textContent(), /Recording from page load/);

  // Recording continues after the reload.
  await inspected.locator('aiux-checklist li').first().click();
  await panel.locator('#ev-list .event-row', { hasText: 'aiux-checklist:item-clicked' }).waitFor();
});

test('no uncaught errors', () => {
  assert.deepEqual(errors.map(String), []);
});

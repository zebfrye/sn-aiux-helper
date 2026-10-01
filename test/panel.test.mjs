// End-to-end test of the real panel + sidebar UI against the demo page, using
// the chrome.devtools mock (see test/harness.html).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';

let server, browser, page, panel, sidebar;
const errors = [];

before(async () => {
  server = await startServer();
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => errors.push(e));
  await page.goto(`http://127.0.0.1:${server.address().port}/test/harness.html`);
  await page.waitForSelector('#panel');
  panel = page.frameLocator('#panel');
  sidebar = page.frameLocator('#sidebar');
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
});

after(async () => {
  await browser?.close();
  server?.close();
});

test('panel renders the component tree', async () => {
  await panel.locator('.tree-row').first().waitFor();
  await panel.locator('.tree-row', { hasText: '<InsightCard>' }).first().waitFor();
  const names = await panel.locator('.tree-row .name').allTextContents();
  assert.ok(names.includes('now-aiux-chat [assistant_chat]'));
  assert.equal(names.filter((n) => n === 'now-aiux-message').length, 2);
  assert.match(await panel.locator('#status').textContent(), /components/);
});

test('selecting a component shows properties and state', async () => {
  await panel.locator('.tree-row', { hasText: 'now-aiux-chat' }).click();
  await panel.locator('.section-properties .row').first().waitFor();
  const keys = await panel.locator('.section-properties .row .key').allTextContents();
  assert.deepEqual(keys, ['config', 'heading', 'loading', 'messages']);
  assert.match(await panel.locator('.section-state .note').textContent(), /__demoInternals\.state/);

  // Expand a nested value (lazy fetch).
  await panel.locator('.section-properties .row', { hasText: 'messages' }).click();
  await panel.locator('.section-properties .row .key', { hasText: /^0$/ }).waitFor();
  await page.screenshot({ path: 'test-results/panel.png' });
});

test('editing a state value updates the page', async () => {
  const unread = panel.locator('.section-state .row', { hasText: 'unread' }).locator('.val');
  await unread.dblclick();
  const input = panel.locator('.section-state .edit-input');
  await input.fill('42');
  await input.press('Enter');
  await page.frameLocator('#inspected').locator('now-aiux-chat h4', { hasText: 'unread: 42' }).waitFor();
  await panel.locator('.section-state .row', { hasText: 'unread' }).locator('.val', { hasText: '42' }).waitFor();
  assert.match(await panel.locator('#status').textContent(), /updateState/);
});

test('live mode reflects changes made by the page', async () => {
  await page.frameLocator('#inspected').locator('body').evaluate(() => {
    document.getElementById('chat').__demoInternals.updateState({ draft: 'typed in page' });
  });
  await panel.locator('.section-state .row', { hasText: 'draft' }).locator('.val', { hasText: 'typed in page' }).waitFor({ timeout: 5000 });
});

test('filter narrows the tree', async () => {
  await panel.locator('#filter').fill('insight');
  const names = await panel.locator('.tree-row .name').allTextContents();
  assert.ok(names.every((n) => /insight|aiux-insights/i.test(n)), names.join(','));
  await panel.locator('#filter').fill('');
});

test('React component shows props and hooks; hook edits re-render', async () => {
  await panel.locator('.tree-row', { hasText: '<InsightCard>' }).first().click();
  await panel.locator('.section-react-hooks .row').first().waitFor();
  const hooks = await panel.locator('.section-react-hooks > .section-body > .node > .row .val').allTextContents();
  assert.equal(hooks.length, 5);
  assert.deepEqual(
    await panel.locator('.section-react-hooks .row .key').allTextContents(),
    ['0: State', '1: State', '2: Memo', '3: Ref', '4: Effect']
  );
  const pinned = panel.locator('.section-react-hooks .row', { hasText: '0: State' }).locator('.val');
  await pinned.dblclick();
  await panel.locator('.section-react-hooks .edit-input').fill('true');
  await panel.locator('.section-react-hooks .edit-input').press('Enter');
  await page.frameLocator('#inspected').locator('sn-aiux-insights h5', { hasText: '📌' }).first().waitFor();
});

test('pick mode selects the clicked component', async () => {
  await panel.locator('#pick').click();
  await page.frameLocator('#inspected').locator('now-aiux-message').first().locator('p').click();
  await panel.locator('.tree-row.selected', { hasText: 'now-aiux-message' }).waitFor();
  await panel.locator('.details-header .tag', { hasText: 'now-aiux-message' }).waitFor();
});

test('sidebar follows the Elements panel selection', async () => {
  await page.evaluate(() => {
    const doc = document.getElementById('inspected').contentDocument;
    window.__aiuxMock.$0 = doc.querySelector('sn-aiux-insights').shadowRoot.querySelector('.score');
  });
  // The mock keeps listeners from both pages; fire them all.
  await page.evaluate(() => window.__aiuxMock.selectionListeners.forEach((fn) => fn()));
  await sidebar.locator('.details-header .tag', { hasText: '<InsightCard>' }).waitFor();
  assert.equal(await sidebar.locator('.details-header .tag').textContent(), '<InsightCard>');
  await page.screenshot({ path: 'test-results/sidebar.png' });
});

test('no uncaught errors', () => {
  assert.deepEqual(errors.map(String), []);
});

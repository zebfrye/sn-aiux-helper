// End-to-end test of the real panel + sidebar UI against the demo page, using
// the chrome.devtools mock (see test/harness.html).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { launchChromium } from './browser.mjs';
import { startServer } from './serve.mjs';

let server, browser, page, panel, sidebar;
const errors = [];

before(async () => {
  server = await startServer();
  browser = await launchChromium();
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

test('polling pauses while the DevTools panel is hidden', async () => {
  const panelFrame = page.frames().find((f) => f.url().includes('/panel/panel.html'));
  const setDraft = (value) =>
    page.frameLocator('#inspected').locator('body').evaluate((_, v) => {
      document.getElementById('chat').__demoInternals.updateState({ draft: v });
    }, value);
  const draft = panel.locator('.section-state .row', { hasText: 'draft' }).locator('.val');

  await panelFrame.evaluate(() => window.AiuxPanel.setVisible(false)); // what devtools.js does on panel.onHidden
  await setDraft('changed while hidden');
  await page.waitForTimeout(2500);
  assert.equal(await draft.textContent(), '"typed in page"', 'no refresh while hidden');

  await panelFrame.evaluate(() => window.AiuxPanel.setVisible(true));
  await draft.filter({ hasText: 'changed while hidden' }).waitFor({ timeout: 900 }); // refreshed at once, not on the next tick
});

test('an edit is dropped, not misapplied, when the selection changes mid-edit', async () => {
  const panelFrame = page.frames().find((f) => f.url().includes('/panel/panel.html'));
  const headingOf = () => page.frameLocator('#inspected').locator('body').evaluate(() => document.getElementById('chat').heading);
  const before = await headingOf();

  await panel.locator('.section-properties .row', { hasText: 'heading' }).locator('.val').dblclick();
  await panel.locator('.section-properties .edit-input').fill('"should never be written"');
  // Selection moves on (as Pick, Elements-sync or "go to source" would do) while the editor is open.
  const otherId = Number(await panel.locator('.tree-row', { hasText: 'now-aiux-message' }).first().getAttribute('data-id'));
  await panelFrame.evaluate((id) => window.AiuxPanel.selectComponent(id), otherId);
  await panel.locator('.details-header .tag', { hasText: 'now-aiux-message' }).waitFor();

  assert.equal(await headingOf(), before, 'the abandoned edit was not written to the old component');
  const messageText = await page.frameLocator('#inspected').locator('body').evaluate(() => {
    const m = document.getElementById('chat').shadowRoot.querySelector('now-aiux-message');
    return { text: m.text, heading: m.heading };
  });
  assert.equal(messageText.text, 'Summarize INC0010023', 'nor to the newly selected one');
  assert.equal(messageText.heading, undefined);

  // The inspector is not left frozen: live updates still arrive for the new selection.
  await page.frameLocator('#inspected').locator('body').evaluate(() => {
    document.getElementById('chat').shadowRoot.querySelector('now-aiux-message').role = 'system';
  });
  await panel.locator('.section-properties .row', { hasText: 'role' }).locator('.val', { hasText: 'system' }).waitFor({ timeout: 5000 });
  await panel.locator('.tree-row', { hasText: 'now-aiux-chat' }).click();
});

test('malformed JSON edits are stored as text and flagged', async () => {
  await panel.locator('.section-properties .row', { hasText: 'heading' }).locator('.val').dblclick();
  const input = panel.locator('.section-properties .edit-input');
  await input.fill('{"oops": ');
  await input.press('Enter');
  await panel.locator('#status.error', { hasText: 'not valid JSON' }).waitFor();
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

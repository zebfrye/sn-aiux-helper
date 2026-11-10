// Agent tests against the Lit/AIUX fixture: Lit properties vs @state, @config,
// AIUX data, the event logger, declared events and listeners.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launchChromium } from './browser.mjs';
import { startServer } from './serve.mjs';

const AGENT = await readFile(new URL('../agent/agent.js', import.meta.url), 'utf8');
const CATALOG = JSON.parse(await readFile(new URL('../data/aiux-events.json', import.meta.url), 'utf8'));

let server, browser, page;

before(async () => {
  server = await startServer();
  browser = await launchChromium();
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/test/fixtures/aiux.html`);
  await page.waitForFunction(() => document.getElementById('list')?.shadowRoot?.querySelector('li'));
  await page.evaluate(AGENT);
  await page.evaluate((c) => window.__SN_AIUX_DEVTOOLS__.setCatalog(c), CATALOG);
});

after(async () => {
  await browser?.close();
  server?.close();
});

const api = (method, ...args) =>
  page.evaluate(([m, a]) => JSON.parse(JSON.stringify(window.__SN_AIUX_DEVTOOLS__[m](...a)) ?? 'null'), [method, args]);

/** inspect() with the getEventListeners stand-in, as DevTools would pass it. */
const inspect = (id, opts = {}) =>
  page.evaluate(([i, o]) => window.__SN_AIUX_DEVTOOLS__.inspect(i, o, window.__testGetEventListeners), [id, opts]);

const section = (data, key) => data.sections.find((s) => s.key === key);
const childOf = (node, key) => node.c.find((c) => c.k === key);
const keys = (node) => node.c.map((c) => c.k);

async function treeIds() {
  const { nodes } = await api('getTree', {});
  const out = {};
  const walk = (list) => list.forEach((n) => { out[n.n.split(/[ #[]/)[0]] = n.id; walk(n.c); });
  walk(nodes);
  return out;
}

test('AIUX elements are found even when the tag does not match the pattern', async () => {
  const ids = await treeIds();
  assert.ok(ids['aiux-checklist']);
  assert.ok(ids['content-toolbar'], 'detected as an AIUXElement by its API');
});

test('Lit properties and @state are split exactly', async () => {
  const data = await inspect((await treeIds())['aiux-checklist']);
  assert.deepEqual(data.kinds, ['Custom Element', 'ServiceNow', 'Lit', 'AIUX']);
  const props = section(data, 'properties');
  assert.deepEqual(keys(props.value), ['aiuxConfigData', 'checklistData', 'headerTitle', 'layout-key']);
  assert.match(props.note, /elementProperties/);
  assert.equal(childOf(props.value, 'headerTitle').v, 'Resolution steps');
  assert.equal(childOf(props.value, 'checklistData').p, 'Array(2)');

  const state = section(data, 'state');
  assert.deepEqual(keys(state.value), ['_activeIndex', '_draft', '_islandActivated']);
  assert.equal(childOf(state.value, '_activeIndex').v, -1);
});

test('@config fields and AIUX data', async () => {
  const data = await inspect((await treeIds())['aiux-checklist']);
  assert.equal(childOf(section(data, 'config').value, 'configSize').v, 'md');
  const aiux = section(data, 'aiux');
  assert.equal(childOf(aiux.value, 'data').p, '{incident}');
  assert.equal(childOf(aiux.value, 'loaderScopeKey').v, 'default');
  assert.equal(childOf(aiux.value, 'capabilities').p, '{addItem}');
});

test('editing Lit state, properties, config and data re-renders', async () => {
  const id = (await treeIds())['aiux-checklist'];
  const text = () => page.evaluate(() => document.getElementById('list').shadowRoot.textContent.replace(/\s+/g, ' '));

  assert.deepEqual(await api('setValue', id, 'state', ['_activeIndex'], '1', {}), { ok: true, method: 'host._activeIndex = …' });
  await page.waitForFunction(() => document.getElementById('list').shadowRoot.textContent.includes('▶ Restart'));

  await api('setValue', id, 'properties', ['checklistData', '0', 'label'], '"Reproduce it"', {});
  await page.waitForFunction(() => document.getElementById('list').shadowRoot.textContent.includes('Reproduce it'));

  const cfg = await api('setValue', id, 'config', ['configSize'], '"sm"', {});
  assert.equal(cfg.ok, true);
  await page.waitForFunction(() => document.getElementById('list').shadowRoot.textContent.includes('(sm)'));
  assert.deepEqual(await page.evaluate(() => document.getElementById('list').aiuxConfigData), { configSize: 'sm' });

  assert.equal((await api('setValue', id, 'aiux', ['data', 'incident'], '"INC2"', {})).ok, true);
  assert.deepEqual(await page.evaluate(() => document.getElementById('list').data), { incident: 'INC2' });
  assert.equal((await api('setValue', id, 'aiux', ['loaderScopeKey'], '"x"', {})).ok, false);
  assert.match(await text(), /Resolution steps/);
});

test('reactive controllers expose the UI state AIUX components keep there', async () => {
  const id = (await treeIds())['aiux-checklist'];
  const CTRL = '_ctrl (ChecklistController)';
  const data = await inspect(id, { expanded: { controllers: { [JSON.stringify([CTRL])]: 1 } } });
  assert.deepEqual(data.sections.map((s) => s.key).slice(0, 4), ['properties', 'state', 'controllers', 'config']);
  const ctrl = childOf(section(data, 'controllers').value, CTRL);
  assert.deepEqual(keys(ctrl), ['addItemValue', 'menuOpen', '_announcer', 'toggleMenu'], 'data first, functions last, host link dropped');
  assert.equal(childOf(ctrl, 'menuOpen').v, false);

  const res = await api('setValue', id, 'controllers', [CTRL, 'menuOpen'], 'true', {});
  assert.deepEqual(res, { ok: true, method: '_ctrl.menuOpen = … + requestUpdate()' });
  await page.waitForFunction(() => !!document.getElementById('list').shadowRoot.querySelector('.menu'));
  await api('setValue', id, 'controllers', [CTRL, 'addItemValue'], '"Call the user"', {});
  await page.waitForFunction(() => document.getElementById('list').shadowRoot.textContent.includes('draft: Call the user'));
  assert.equal((await api('setValue', id, 'controllers', [CTRL], '{}', {})).ok, false, 'a controller itself is not replaceable');
  await api('setValue', id, 'controllers', [CTRL, 'menuOpen'], 'false', {});
});

test('controllers get useful names even when a minifier renamed their classes', async () => {
  // On a real instance ChecklistController is just "E". Property names survive
  // minification, so controllers are named after the field that holds them.
  const ids = await treeIds();
  const list = await inspect(ids['aiux-checklist']);
  assert.deepEqual(keys(section(list, 'controllers').value), [
    'LocalizeController', // class "eg": recognised by its shape
    'controller 2', // class "ez": nothing to go on
    '_ctrl (ChecklistController)', // held by host._ctrl; a real class name is kept
    '_ctrl._announcer' // class "o": held by another controller
  ]);
  const toolbar = await inspect(ids['content-toolbar']);
  assert.deepEqual(keys(section(toolbar, 'controllers').value), ['_menu'], 'class "E" held by host._menu');

  const edit = await api('setValue', ids['content-toolbar'], 'controllers', ['_menu', 'open'], 'true', {});
  assert.deepEqual(edit, { ok: true, method: '_menu.open = … + requestUpdate()' });
  assert.equal(await page.evaluate(() => document.querySelector('content-toolbar')._menu.open), true);
});

test('declared events come from the catalog; listeners from getEventListeners', async () => {
  const data = await inspect((await treeIds())['aiux-checklist']);
  const events = section(data, 'events');
  assert.ok(keys(events.value).includes('aiux-checklist:item-clicked'));
  assert.match(childOf(events.value, 'aiux-checklist:item-clicked').v, /detail: ChecklistItemClickedDetail/);
  assert.match(events.note, /9 declared via @fires \(@servicenow\/aiux@/);

  const listeners = section(data, 'listeners');
  assert.equal(childOf(listeners.value, 'keydown').p, 'ƒ _onKeyDown()');

  const noGel = await api('inspect', (await treeIds())['aiux-checklist'], {});
  assert.equal(section(noGel, 'listeners'), undefined, 'listeners need DevTools getEventListeners');
});

test('event logger records component events with a detail snapshot', async () => {
  await api('startEventCapture', {});
  const before = (await api('getEvents', 0)).seq;
  await page.evaluate(() => document.getElementById('list').shadowRoot.querySelector('li').click());
  const res = await api('getEvents', before);
  assert.equal(res.active, true);
  const ev = res.events.find((e) => e.type === 'aiux-checklist:item-clicked');
  assert.ok(ev, JSON.stringify(res.events));
  assert.equal(ev.sl, 'aiux-checklist#list');
  assert.equal(ev.cls, 'CustomEvent');
  assert.equal(ev.f, 'BC');
  assert.equal(ev.p, '{item, index}');
  assert.equal(ev.src, (await treeIds())['aiux-checklist']);

  // Mutating the detail afterwards doesn't change the snapshot.
  const id = `event:${res.session}:${ev.s}`;
  const detail = await inspect(id, { expanded: { 'event.detail': { '["item"]': 1 } } });
  assert.equal(detail.subject, 'event');
  assert.equal(detail.label, 'aiux-checklist:item-clicked');
  const d = section(detail, 'event.detail');
  assert.match(d.note, /snapshot/);
  assert.equal(childOf(childOf(d.value, 'item'), 'label').v, 'Reproduce it');
  const info = section(detail, 'event.info');
  assert.match(childOf(info.value, 'declared').v, /^yes — @fires on aiux-checklist/);
  assert.equal(childOf(info.value, 'propagates through').p, 'Array(1)');

  // Observed counts show up on the component.
  const comp = await inspect((await treeIds())['aiux-checklist']);
  assert.match(childOf(section(comp, 'events').value, 'aiux-checklist:item-clicked').v, /^×1 dispatched/);
  assert.equal(await api('storeGlobal', id, null, null, {}), '$aiux1');
  assert.equal(await page.evaluate(() => window.$aiux1.type), 'aiux-checklist:item-clicked');
});

test('component mode filters non-component events; all mode keeps them', async () => {
  const fire = () =>
    page.evaluate(() => {
      new EventTarget().dispatchEvent(new Event('bus-ping'));
      document.body.dispatchEvent(new Event('plain-body-event'));
      window.dispatchEvent(new CustomEvent('aiux:route-changed', { detail: { path: '/now/x' } }));
      document.querySelector('content-toolbar').shadowRoot.querySelector('button').click();
    });
  let since = (await api('getEvents', 0)).seq;
  await fire();
  let types = (await api('getEvents', since)).events.map((e) => e.type);
  assert.deepEqual(types, ['aiux:route-changed', 'content-toolbar:action']);

  await api('startEventCapture', { eventMode: 'all' });
  since = (await api('getEvents', 0)).seq;
  await fire();
  types = (await api('getEvents', since)).events.map((e) => e.type);
  assert.deepEqual(types, ['bus-ping', 'plain-body-event', 'aiux:route-changed', 'content-toolbar:action']);
  await api('startEventCapture', {});
});

test('undeclared events are flagged; the source of an inner dispatch is its host', async () => {
  const since = (await api('getEvents', 0)).seq;
  await page.evaluate(() => {
    const li = document.getElementById('list').shadowRoot.querySelector('li');
    li.dispatchEvent(new CustomEvent('aiux-checklist:custom-thing', { bubbles: true, composed: true }));
  });
  const ev = (await api('getEvents', since)).events[0];
  assert.equal(ev.sl, 'aiux-checklist#list');
  const comp = await inspect((await treeIds())['aiux-checklist']);
  assert.match(childOf(section(comp, 'events').value, 'aiux-checklist:custom-thing').v, /not declared/);
});

test('adoptFrame records a child frame immediately while capturing', async () => {
  const since = (await api('getEvents', 0)).seq;
  const adopted = await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'child';
    document.body.appendChild(frame);
    const ok = window.__SN_AIUX_DEVTOOLS__.adoptFrame(frame.contentWindow);
    frame.contentWindow.dispatchEvent(new frame.contentWindow.CustomEvent('aiux:frame-event', { detail: 1 }));
    return ok;
  });
  assert.equal(adopted, true);
  assert.deepEqual((await api('getEvents', since)).events.map((e) => e.type), ['aiux:frame-event']);
});

test('stopping restores the native dispatchEvent and leaves dispatch behaviour intact', async () => {
  const result = await page.evaluate(() => {
    const el = document.getElementById('list');
    const ev = new CustomEvent('x-cancel', { cancelable: true });
    el.addEventListener('x-cancel', (e) => e.preventDefault(), { once: true });
    return el.dispatchEvent(ev); // false when prevented
  });
  assert.equal(result, false);
  await api('stopEventCapture');
  assert.equal(await page.evaluate(() => /\[native code\]/.test(EventTarget.prototype.dispatchEvent.toString())), true);
  assert.equal(
    await page.evaluate(() => /\[native code\]/.test(document.getElementById('child').contentWindow.EventTarget.prototype.dispatchEvent.toString())),
    true,
    'child frames are restored too'
  );
  assert.equal(await page.evaluate(() => window.__SN_AIUX_DEVTOOLS__.adoptFrame(window)), false, 'adoptFrame is a no-op when not recording');
  const since = (await api('getEvents', 0)).seq;
  await page.evaluate(() => document.getElementById('list').shadowRoot.querySelector('li').click());
  assert.equal((await api('getEvents', since)).events.length, 0);
  assert.ok((await api('clearEvents')).size === 0);
  assert.equal((await api('getEvents', 0)).dropped, 0, 'clearing is not reported as dropped events');
});

test('the ring buffer evicts the oldest events and reports them as dropped', async () => {
  await api('startEventCapture', {});
  const since = (await api('getEvents', 0)).seq;
  await page.evaluate(() => {
    const el = document.getElementById('list');
    for (let i = 0; i < 2300; i++) el.dispatchEvent(new CustomEvent('aiux-checklist:flood', { detail: i }));
  });
  const res = await api('getEvents', since);
  // Eviction is batched: past 2200 entries the buffer is trimmed back to 2000.
  assert.equal(res.dropped, 201);
  assert.equal(res.events.length, 500, 'at most 500 per call');
  assert.equal(res.events[0].p, '201');
  await api('stopEventCapture');
  await api('clearEvents');
});

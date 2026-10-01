// Tests for the page agent, run against the demo fixture in headless Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';

const AGENT = await readFile(new URL('../agent/agent.js', import.meta.url), 'utf8');
const MANIFEST = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

let server, browser, page;

before(async () => {
  server = await startServer();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/test/fixtures/demo.html`);
  await page.waitForFunction(() => document.querySelector('sn-aiux-insights')?.shadowRoot?.querySelector('.card'));
  assert.equal(await page.evaluate(AGENT), MANIFEST.version, 'agent version must match manifest version');
});

after(async () => {
  await browser?.close();
  server?.close();
});

const api = (method, ...args) =>
  page.evaluate(([m, a]) => JSON.parse(JSON.stringify(window.__SN_AIUX_DEVTOOLS__[m](...a))), [method, args]);

function flatten(nodes, out = []) {
  for (const n of nodes) {
    out.push(n);
    flatten(n.c, out);
  }
  return out;
}

const find = (nodes, pred) => flatten(nodes).find(pred);
const section = (data, key) => data.sections.find((s) => s.key === key);
const childOf = (node, key) => node.c.find((c) => c.k === key);

test('re-injecting the agent is a no-op', async () => {
  await page.evaluate(() => { window.__prevAgent = window.__SN_AIUX_DEVTOOLS__; });
  await page.evaluate(AGENT);
  assert.equal(await page.evaluate(() => window.__SN_AIUX_DEVTOOLS__ === window.__prevAgent), true);
});

test('tree contains SN custom elements through shadow roots, and React components', async () => {
  const { nodes, count } = await api('getTree', {});
  assert.ok(count >= 6);
  const chat = nodes.find((n) => n.n.startsWith('now-aiux-chat'));
  assert.equal(chat.n, 'now-aiux-chat [assistant_chat]');
  assert.equal(chat.k, 'ce');
  assert.equal(chat.c.filter((c) => c.n === 'now-aiux-message').length, 2, 'messages live in the shadow root');

  const insights = nodes.find((n) => n.n === 'sn-aiux-insights#insights');
  const list = insights.c[0];
  assert.equal(list.n, '<InsightsList>');
  assert.equal(list.k, 'react');
  assert.deepEqual(list.c.map((c) => c.n), ['<InsightCard>', '<InsightCard>']);

  assert.equal(find(nodes, (n) => /not-a-component/.test(n.n)), undefined);
});

test('tag pattern and allCustomElements options', async () => {
  const onlyNow = await api('getTree', { tagPattern: '^now-', includeReact: false });
  assert.deepEqual(
    [...new Set(flatten(onlyNow.nodes).map((n) => n.n.split(/[ #[]/)[0]))].sort(),
    ['now-aiux-chat', 'now-aiux-message']
  );
  const none = await api('getTree', { tagPattern: '^zzz-', includeReact: false });
  assert.equal(none.count, 0);
  const all = await api('getTree', { tagPattern: '^zzz-', allCustomElements: true, includeReact: false });
  assert.equal(all.count, 4);
});

async function chatId() {
  const { nodes } = await api('getTree', {});
  return nodes.find((n) => n.n.startsWith('now-aiux-chat')).id;
}

test('inspect a custom element: properties, state, attributes, internals', async () => {
  const data = await api('inspect', await chatId(), {});
  assert.deepEqual(data.kinds, ['Custom Element', 'ServiceNow']);
  assert.deepEqual(data.sections.map((s) => s.key), ['properties', 'state', 'attributes', 'internals']);

  const props = section(data, 'properties');
  assert.deepEqual(props.value.c.map((c) => c.k), ['config', 'heading', 'loading', 'messages']);
  assert.equal(childOf(props.value, 'heading').v, 'Now Assist');
  assert.equal(childOf(props.value, 'messages').p, 'Array(2)');
  assert.equal(childOf(props.value, 'messages').c, undefined, 'nested values are lazy');
  assert.equal(props.note, 'from observedAttributes, class accessors');

  const state = section(data, 'state');
  assert.match(state.note, /__demoInternals\.state/);
  assert.match(state.note, /updateState/);
  assert.equal(childOf(state.value, 'unread').v, 2);

  assert.equal(childOf(section(data, 'attributes').value, 'component-id').v, 'assistant_chat');
  assert.ok(childOf(section(data, 'internals').value, '__demoInternals'));
});

test('expanded paths are serialised on demand', async () => {
  const data = await api('inspect', await chatId(), {
    expanded: { properties: { '["messages"]': 1, '["messages","0"]': 1 } }
  });
  const messages = childOf(section(data, 'properties').value, 'messages');
  assert.deepEqual(messages.c.map((c) => c.k), ['0', '1']);
  assert.equal(childOf(messages.c[0], 'text').v, 'Summarize INC0010023');
  assert.equal(messages.c[1].c, undefined);
});

test('edit property values (top level and nested, immutably)', async () => {
  const id = await chatId();
  const before = await page.evaluate(() => document.getElementById('chat').config);
  let res = await api('setValue', id, 'properties', ['heading'], '"Virtual Agent"', {});
  assert.equal(res.ok, true);
  assert.match(await page.evaluate(() => document.getElementById('chat').shadowRoot.textContent), /Virtual Agent/);

  res = await api('setValue', id, 'properties', ['config', 'temperature'], '0.7', {});
  assert.equal(res.ok, true);
  const after = await page.evaluate(() => document.getElementById('chat').config);
  assert.deepEqual(after, { model: 'now-llm', temperature: 0.7 });
  assert.equal(before.temperature, 0.2);
  assert.equal(await page.evaluate(() => document.getElementById('chat').config.temperature), 0.7);

  res = await api('setValue', id, 'properties', ['loading'], 'true', {});
  assert.equal(await page.evaluate(() => document.getElementById('chat').loading), true);
  res = await api('setValue', id, 'properties', ['heading'], 'not json', {});
  assert.equal(await page.evaluate(() => document.getElementById('chat').heading), 'not json', 'invalid JSON falls back to a string');
});

test('edit state through the discovered updater', async () => {
  const id = await chatId();
  const res = await api('setValue', id, 'state', ['unread'], '7', {});
  assert.deepEqual(res, { ok: true, method: 'updateState()' });
  assert.match(await page.evaluate(() => document.getElementById('chat').shadowRoot.textContent), /unread: 7/);
  await api('setValue', id, 'state', ['panel', 'width'], '400', {});
  assert.deepEqual(await page.evaluate(() => document.getElementById('chat').__demoInternals.state.panel), { open: true, width: 400 });
});

test('custom state paths take precedence', async () => {
  const id = await chatId();
  const data = await api('inspect', id, { statePaths: ['__demoInternals.props'] });
  assert.match(section(data, 'state').note, /host\.__demoInternals\.props/);
});

test('attributes are editable', async () => {
  const id = await chatId();
  await api('setValue', id, 'attributes', ['data-test'], '"hello"', {});
  assert.equal(await page.evaluate(() => document.getElementById('chat').getAttribute('data-test')), 'hello');
  await api('setValue', id, 'attributes', ['data-test'], 'null', {});
  assert.equal(await page.evaluate(() => document.getElementById('chat').hasAttribute('data-test')), false);
});

async function cardId() {
  const { nodes } = await api('getTree', {});
  return find(nodes, (n) => n.n === '<InsightCard>').id;
}

test('inspect a React function component: props and hooks', async () => {
  const data = await api('inspect', await cardId(), {});
  assert.equal(data.label, '<InsightCard>');
  assert.deepEqual(data.kinds, ['React']);
  const props = section(data, 'react.props');
  assert.equal(childOf(props.value, 'title').v, 'Root cause');
  assert.match(props.note, /rendered by InsightsList/);

  const hooks = section(data, 'react.hooks');
  assert.deepEqual(hooks.value.c.map((c) => c.k), ['0: State', '1: State', '2: Memo', '3: Ref', '4: Effect']);
  assert.equal(childOf(hooks.value, '0: State').v, false);
  assert.equal(childOf(hooks.value, '1: State').p, '{priority, tags}');
  assert.equal(childOf(hooks.value, '2: Memo').p, 'Array(2)');
});

test('edit React useState hooks via their dispatcher', async () => {
  const id = await cardId();
  let res = await api('setValue', id, 'react.hooks', ['0: State'], 'true', {});
  assert.deepEqual(res, { ok: true, method: 'hook dispatch()' });
  await page.waitForFunction(() => document.querySelector('sn-aiux-insights').shadowRoot.querySelector('h5').textContent.includes('📌'));

  res = await api('setValue', id, 'react.hooks', ['1: State', 'priority'], '"P3"', {});
  assert.equal(res.ok, true);
  await page.waitForFunction(() => document.querySelector('sn-aiux-insights').shadowRoot.querySelector('.score').textContent.includes('P3'));

  res = await api('setValue', id, 'react.hooks', ['2: Memo'], '1', {});
  assert.equal(res.ok, false, 'memo hooks are read-only');
});

test('edit React class component state via setState', async () => {
  const { nodes } = await api('getTree', {});
  const id = find(nodes, (n) => n.n === '<InsightsList>').id;
  const data = await api('inspect', id, {});
  assert.ok(section(data, 'react.state'));
  const res = await api('setValue', id, 'react.state', ['items'], '["Only one"]', {});
  assert.equal(res.ok, true);
  await page.waitForFunction(() => document.querySelector('sn-aiux-insights').shadowRoot.querySelectorAll('.card').length === 1);
});

test('picker resolves the nearest component from a click', async () => {
  await api('startPick', {});
  assert.equal(await api('pollPick'), null);
  const box = await page.evaluate(() => {
    const msg = document.getElementById('chat').shadowRoot.querySelector('now-aiux-message');
    const r = msg.shadowRoot.querySelector('p').getBoundingClientRect();
    return { x: r.x + 5, y: r.y + 5 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.click(box.x, box.y);
  const id = await api('pollPick');
  const data = await api('inspect', id, {});
  assert.equal(data.tag, 'now-aiux-message');
  assert.equal(data.ancestors.length, 1, 'ancestor chain includes the chat');
});

test('idForElement maps a deep element to its component', async () => {
  const id = await page.evaluate(() => {
    const span = document.querySelector('sn-aiux-insights').shadowRoot.querySelector('.score');
    return window.__SN_AIUX_DEVTOOLS__.idForElement(span, {});
  });
  const data = await api('inspect', id, {});
  assert.equal(data.label, '<InsightCard>');
});

test('storeGlobal and copyValue', async () => {
  const id = await chatId();
  const name = await api('storeGlobal', id, 'properties', ['config'], {});
  assert.match(name, /^\$aiux\d+$/);
  assert.equal(await page.evaluate((n) => window[n].model, name), 'now-llm');
  const json = await api('copyValue', id, 'properties', ['messages'], {});
  assert.equal(JSON.parse(json).length, 2);
});

test('serialiser handles cycles, maps, sets, functions, dates and DOM nodes', async () => {
  const id = await page.evaluate(() => {
    const el = document.createElement('now-aiux-message');
    const cyc = { name: 'loop' };
    cyc.self = cyc;
    el.text = {
      cyc,
      map: new Map([['a', 1]]),
      set: new Set([1, 2]),
      fn: function doThing() {},
      when: new Date(0),
      node: document.body,
      big: 10n,
      sym: Symbol('s')
    };
    document.body.appendChild(el);
    return window.__SN_AIUX_DEVTOOLS__.idForElement(el, {});
  });
  const data = await api('inspect', id, {
    expanded: { properties: { '["text"]': 1, '["text","cyc"]': 1, '["text","cyc","self"]': 1, '["text","map"]': 1 } }
  });
  const text = childOf(section(data, 'properties').value, 'text');
  const get = (k) => childOf(text, k);
  assert.equal(childOf(get('cyc'), 'self').circular, 1);
  assert.equal(get('map').p, 'Map(1)');
  assert.equal(get('map').c[0].l, '"a"');
  assert.equal(get('set').p, 'Set(2)');
  assert.equal(get('fn').p, 'ƒ doThing()');
  assert.equal(get('when').p, '1970-01-01T00:00:00.000Z');
  assert.equal(get('node').t, 'node');
  assert.ok(get('node').el > 0);
  assert.equal(get('big').p, '10n');
  assert.equal(get('sym').p, 'Symbol(s)');
});

test('inspecting a removed element reports it gone', async () => {
  const id = await page.evaluate(() => {
    const el = document.createElement('now-aiux-message');
    document.body.appendChild(el);
    return window.__SN_AIUX_DEVTOOLS__.idForElement(el, {});
  });
  const data = await api('inspect', id, {});
  assert.equal(data.connected, true);
  await page.evaluate(() => document.querySelectorAll('body > now-aiux-message').forEach((e) => e.remove()));
  const after = await api('inspect', id, {});
  assert.equal(after.connected, false);
});

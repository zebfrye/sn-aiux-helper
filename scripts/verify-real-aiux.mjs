// Verifies the page agent against a REAL @servicenow/aiux component
// (aiux-checklist), not the look-alike used by the test fixtures.
//
// Opt-in, because it needs the package and its dependencies (~1 GB):
//
//   mkdir /tmp/aiux && cd /tmp/aiux && npm init -y
//   npm install @servicenow/aiux --ignore-scripts
//   cd <this repo> && npm run verify:aiux -- /tmp/aiux
//   npm run verify:aiux -- /tmp/aiux --minify     # as a production build
//
// The component is bundled with the package's own esbuild and loaded in
// headless Chromium; none of the package's code runs in Node. Modules that
// only exist on a ServiceNow instance (and Node built-ins on server-only
// code paths) are replaced with inert stubs.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { launchChromium } from '../test/browser.mjs';

const args = process.argv.slice(2);
// --minify shortens class names the way a production instance build does
// (ChecklistController becomes a single letter), to check nothing relies on them.
const minify = args.includes('--minify');
const dir = resolve(args.find((a) => !a.startsWith('--')) || '.');
const require = createRequire(resolve(dir, 'package.json'));
let esbuild, pkg;
try {
  esbuild = require('esbuild');
  pkg = require('@servicenow/aiux/package.json');
} catch (e) {
  console.error(`Could not find @servicenow/aiux (and its esbuild) under ${dir}/node_modules.\nSee the instructions at the top of this script.`);
  process.exit(2);
}

const stubbed = new Set();
const stubUnresolvable = {
  name: 'stub-unresolvable',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (args.pluginData?.probing) return null;
      const probe = await build.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { probing: true } });
      if (!probe.errors.length) return null;
      stubbed.add(args.path);
      return { path: args.path, namespace: 'stub' };
    });
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'const noop = () => undefined; module.exports = new Proxy(function () {}, { get: (t, k) => (k === "__esModule" ? false : noop) });',
      loader: 'js'
    }));
  }
};

console.log(`Bundling aiux-checklist from ${pkg.name}@${pkg.version}${minify ? ' (minified)' : ''} …`);
const built = await esbuild.build({
  stdin: {
    contents: `
      import '@servicenow/aiux/aiux-checklist';
      import { AIUXElement } from '@servicenow/aiux/aiux-components-core';
      window.__REAL_AIUX__ = { AIUXElement };`,
    resolveDir: dir,
    loader: 'js'
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  minify,
  target: 'chrome120', // also transpiles the decorators in the package's src/ build
  logLevel: 'error',
  // Entry points pick their build with process.env.AIUX_VERSION (default vN).
  define: { 'process.env': '{}' },
  plugins: [stubUnresolvable]
});
if (stubbed.size) console.log(`Stubbed platform-only modules: ${[...stubbed].sort().join(', ')}`);

const HTML = `<!doctype html><meta charset="utf-8">
<aiux-checklist id="list" header-title="Resolution steps" allow-editing
  checklist-data='[{"itemId":"1","checked":false,"label":"Reproduce the issue"},{"itemId":"2","checked":true,"label":"Restart the mail service"}]'></aiux-checklist>
<script type="module" src="/bundle.js"></script>`;

const agent = await readFile(new URL('../agent/agent.js', import.meta.url), 'utf8');
const catalog = JSON.parse(await readFile(new URL('../data/aiux-events.json', import.meta.url), 'utf8'));
if (catalog.source !== `${pkg.name}@${pkg.version}`) {
  console.log(`Note: the event catalog was generated from ${catalog.source}; run \`npm run catalog -- ${dir}/node_modules/@servicenow/aiux\` to refresh it.`);
}

const browser = await launchChromium();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.route('http://aiux.test/**', (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/') return route.fulfill({ body: HTML, contentType: 'text/html' });
  if (path === '/bundle.js') return route.fulfill({ body: Buffer.from(built.outputFiles[0].contents), contentType: 'text/javascript' });
  return route.fulfill({ status: 404, body: '' });
});
await page.goto('http://aiux.test/');
try {
  await page.waitForFunction(() => document.getElementById('list')?.shadowRoot?.querySelector('aiux-checklist-item'), null, { timeout: 30000 });
} catch (e) {
  console.error('The real component did not render.' + (pageErrors.length ? '\nPage errors:\n  ' + pageErrors.slice(0, 5).join('\n  ') : ''));
  await browser.close();
  process.exit(1);
}

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

await page.evaluate(([src, cat]) => {
  (0, eval)(src);
  window.__SN_AIUX_DEVTOOLS__.setCatalog(cat);
  window.__SN_AIUX_DEVTOOLS__.startEventCapture({});
}, [agent, catalog]);

const info = await page.evaluate(() => {
  const a = window.__SN_AIUX_DEVTOOLS__;
  const el = document.getElementById('list');
  const id = a.idForElement(el, {});
  // The checklist's controller is labelled after the host field holding it
  // ("_ctrl"), plus its class name where the build isn't minified.
  const labels = (a.inspect(id, {}).sections.find((s) => s.key === 'controllers')?.value?.c || []).map((c) => c.k);
  const label = labels.find((k) => /^_ctrl\b/.test(k)) || labels.find((k) => /ChecklistController/.test(k));
  const data = a.inspect(id, { expanded: { controllers: { [JSON.stringify([label])]: 1 } } });
  const keysOf = (key) => (data.sections.find((s) => s.key === key)?.value?.c || []).map((c) => c.k);
  const controller = (data.sections.find((s) => s.key === 'controllers')?.value?.c || []).find((c) => c.k === label);
  return {
    id,
    real: el instanceof window.__REAL_AIUX__.AIUXElement,
    kinds: data.kinds,
    tree: a.getTree({}).nodes.map((n) => n.n + ' > ' + n.c.map((c) => c.n.split('#')[0]).join(',')),
    properties: keysOf('properties'),
    state: keysOf('state'),
    config: keysOf('config'),
    events: keysOf('events'),
    controllerLabels: labels,
    controllerLabel: label,
    controllerFields: (controller?.c || []).map((c) => c.k)
  };
});
check('element is an instance of the real AIUXElement', info.real);
check('recognised as Lit + AIUX', info.kinds.includes('Lit') && info.kinds.includes('AIUX'), info.kinds.join(', '));
check('tree nests aiux-checklist-item under aiux-checklist', /aiux-checklist#list > aiux-checklist-item/.test(info.tree.join('|')), info.tree.join(' | '));
check('Lit properties are listed', info.properties.includes('checklistData') && info.properties.includes('headerTitle'), `${info.properties.length} properties`);
check('@state fields are listed', info.state.length > 0, info.state.join(', '));
check('@config fields are listed', info.config.some((k) => k.startsWith('config')), `${info.config.length} config fields`);
check('controllers are named after the host field that holds them', /^_ctrl\b/.test(info.controllerLabel || ''), info.controllerLabels.join(' | '));
check('controller state is listed', info.controllerFields.includes('addItemValue'), `${info.controllerLabel}: ${info.controllerFields.slice(0, 5).join(', ')}, …`);
check('declared events come from the catalog', info.events.includes('aiux-checklist:item-clicked'), `${info.events.length} declared`);

// A real user click must be logged, with its source and declaration.
await page.locator('aiux-checklist-item').first().locator('input[type=checkbox]').click();
await page.waitForTimeout(200);
const logged = await page.evaluate(() => {
  const a = window.__SN_AIUX_DEVTOOLS__;
  const res = a.getEvents(0);
  const ev = res.events.find((e) => e.type === 'aiux-checklist:item-clicked');
  const detail = ev && a.inspect('event:' + res.session + ':' + ev.s, {});
  const declared = detail?.sections.find((s) => s.key === 'event.info').value.c.find((c) => c.k === 'declared').v;
  return { types: res.events.map((e) => e.type), source: ev?.sl, declared };
});
check('a real click is logged as aiux-checklist:item-clicked', logged.source === 'aiux-checklist#list', logged.types.join(', '));
check('…and recognised as declared', /^yes/.test(logged.declared || ''), logged.declared);

// Edits must reach the real component and re-render it.
await page.evaluate(([id, label]) => {
  const a = window.__SN_AIUX_DEVTOOLS__;
  a.setValue(id, 'properties', ['headerTitle'], '"Edited by DevTools"', {});
  a.setValue(id, 'controllers', [label, 'addItemValue'], '"Typed from DevTools"', {});
}, [info.id, info.controllerLabel]);
await page.waitForTimeout(300);
const after = await page.evaluate(() => {
  const root = document.getElementById('list').shadowRoot;
  return { text: root.textContent, inputs: [...root.querySelectorAll('input')].map((i) => i.value) };
});
check('editing a property re-renders the component', after.text.includes('Edited by DevTools'));
check('editing controller state re-renders the component', after.inputs.includes('Typed from DevTools'));

await browser.close();
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${results.length} checks failed` : `\nAll ${results.length} checks passed against ${pkg.name}@${pkg.version}${minify ? ' (minified)' : ''}`);
process.exit(failed ? 1 : 0);

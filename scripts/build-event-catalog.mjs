// Builds data/aiux-events.json — the events each AIUX component declares —
// from the `@fires` JSDoc in an installed @servicenow/aiux package.
//
// Usage:
//   node scripts/build-event-catalog.mjs [path/to/@servicenow/aiux]
//
// The package is only read as text; nothing in it is executed.
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.argv[2] || 'node_modules/@servicenow/aiux';
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const OUT = new URL('../data/aiux-events.json', import.meta.url);

const SKIP_DIRS = new Set(['node_modules', 'public', 'locales', 'dist', 'vN', 'test', 'tests', '__tests__', 'stories', 'demo', 'mocks']);

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* sourceFiles(p);
    } else if (/\.(ts|js)$/.test(name) && !/\.(d|test|spec|stories)\.(ts|js)$/.test(name) && st.size < 400_000) {
      if (p.split(sep).includes('src')) yield p;
    }
  }
}

// One class with its JSDoc, decorators and base class.
const CLASS_RE =
  /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*((?:@[\w.]+\((?:[^()]|\([^()]*\))*\)\s*)*)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+([\w.]+))?/g;
const FIRES_RE = /@fires\s+(?:\{([^}]*)\}\s*)?([^\s{}]+)(?:\s+-\s+|\s+)?(.*)/;

const classes = new Map(); // className -> { tags:Set, fires:[], base, file }

for (const file of sourceFiles(root)) {
  const text = readFileSync(file, 'utf8');
  if (!text.includes('class ')) continue;
  const defines = new Map();
  for (const m of text.matchAll(/customElements\.define\(\s*['"]([a-z][\w-]*-[\w-]*)['"]\s*,\s*(\w+)/g)) {
    defines.set(m[2], m[1]);
  }
  for (const m of text.matchAll(CLASS_RE)) {
    const [, doc, decorators, name, base] = m;
    const tags = new Set();
    const el = doc.match(/@(?:element|customElement|tagname)\s+([a-z][\w-]*-[\w-]*)/);
    if (el) tags.add(el[1]);
    const dec = decorators.match(/customElement\(\s*['"]([a-z][\w-]*-[\w-]*)['"]/);
    if (dec) tags.add(dec[1]);
    if (defines.has(name)) tags.add(defines.get(name));

    const fires = [];
    for (const line of doc.split('\n')) {
      const f = line.replace(/^\s*\*\s?/, '').match(FIRES_RE);
      if (!f) continue;
      const [, type, eventName, description] = f;
      const detail = type && /<(.+)>/.exec(type)?.[1];
      fires.push({
        name: eventName.replace(/[.,;]$/, ''),
        ...(detail ? { detail } : {}),
        ...(description.trim() ? { description: description.trim() } : {})
      });
    }
    const prev = classes.get(name);
    if (prev && prev.tags.size && !tags.size) continue; // keep the defining declaration
    classes.set(name, { tags, fires, base: base && base.split('.').pop(), file: relative(root, file) });
  }
}

// Inherit @fires from base classes declared in the package.
function allFires(name, seen = new Set()) {
  const c = classes.get(name);
  if (!c || seen.has(name)) return [];
  seen.add(name);
  return [...c.fires, ...allFires(c.base, seen)];
}

const tags = {};
for (const [name, c] of classes) {
  if (!c.tags.size) continue;
  const fires = allFires(name);
  if (!fires.length) continue;
  for (const tag of c.tags) {
    const byName = new Map((tags[tag] || []).map((e) => [e.name, e]));
    for (const f of fires) if (!byName.has(f.name)) byName.set(f.name, f);
    tags[tag] = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

// Merge public API manifests (they carry event detail types).
for (const file of sourceFilesForManifests(root)) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  for (const el of manifest.elements || []) {
    if (!el.events?.length) continue;
    const byName = new Map((tags[el.tag] || []).map((e) => [e.name, e]));
    for (const ev of el.events) {
      const existing = byName.get(ev.name) || { name: ev.name };
      if (ev.detail && ev.detail !== 'unknown' && !existing.detail) existing.detail = ev.detail;
      byName.set(ev.name, existing);
    }
    tags[el.tag] = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

function* sourceFilesForManifests(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* sourceFilesForManifests(p);
    } else if (name === 'public-api-manifest.json') {
      yield p;
    }
  }
}

const sorted = Object.fromEntries(Object.entries(tags).sort(([a], [b]) => a.localeCompare(b)));
const catalog = {
  source: `${pkg.name}@${pkg.version}`,
  generatedBy: 'scripts/build-event-catalog.mjs',
  tags: sorted
};
if (!existsSync(new URL('../data/', import.meta.url))) {
  throw new Error('data/ directory is missing');
}
writeFileSync(OUT, JSON.stringify(catalog, null, 1) + '\n');
const eventCount = Object.values(sorted).reduce((n, list) => n + list.length, 0);
console.log(`${catalog.source}: ${Object.keys(sorted).length} components, ${eventCount} declared events -> data/aiux-events.json`);

/*
 * SN AIUX DevTools — page agent.
 *
 * This file is evaluated in the *main world* of the inspected page via
 * chrome.devtools.inspectedWindow.eval(). It must be self-contained (no
 * imports) and its last expression must evaluate to the agent version.
 *
 * It exposes window.__SN_AIUX_DEVTOOLS__ with a small, JSON-only API that the
 * DevTools panel and Elements sidebar call into. Everything it returns must be
 * JSON-serialisable because inspectedWindow.eval() JSON-encodes results.
 */
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var GLOBAL = '__SN_AIUX_DEVTOOLS__';

  if (window[GLOBAL] && window[GLOBAL].version === VERSION) {
    return VERSION;
  }
  if (window[GLOBAL] && typeof window[GLOBAL].dispose === 'function') {
    try { window[GLOBAL].dispose(); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Configuration defaults (the panel may override per call)
  // ---------------------------------------------------------------------------

  // Tag prefixes that identify ServiceNow Next Experience / AIUX components.
  var DEFAULT_TAG_PATTERN = '^(now|sn|macroponent|uxf|x|aiux|ai|nas|sys|seismic)-';

  // Places on a component host where framework state is commonly kept. The
  // first match that resolves to an object wins. Users can add their own paths
  // from the panel settings. "()" means "call this function".
  var STATE_PATHS = [
    'state',
    '__state',
    '_state',
    '$state',
    'componentState',
    '__componentState',
    '__nowState',
    '$$state',
    '__seismic.state',
    '__component.state',
    '_component.state',
    '__instance.state',
    '__internal.state',
    '__internals.state',
    'renderer.state',
    'store.getState()',
    '__store.getState()',
    '_store.getState()',
    'getState()'
  ];

  // Function names that, when found next to a state object, let us write it.
  var STATE_UPDATERS = ['updateState', 'setState', 'patchState'];

  // Configuration keys commonly holding a component's declared properties.
  var PROPERTY_CONFIG_PATHS = [
    'properties',
    'componentConfig.properties',
    'config.properties',
    '__config.properties',
    'definition.properties',
    'elementConfig.properties'
  ];

  var MAX_KEYS = 200;
  var MAX_STRING = 10000;
  var MAX_TREE_NODES = 5000;

  // ---------------------------------------------------------------------------
  // Element registry: stable numeric ids for elements, weakly held.
  // ---------------------------------------------------------------------------

  var nextId = 1;
  var idByElement = new WeakMap();
  var refById = new Map();
  var hasWeakRef = typeof WeakRef === 'function';

  function register(el) {
    var id = idByElement.get(el);
    if (id) return id;
    id = nextId++;
    idByElement.set(el, id);
    refById.set(id, hasWeakRef ? new WeakRef(el) : { deref: function () { return el; } });
    return id;
  }

  function lookup(id) {
    var ref = refById.get(Number(id));
    var el = ref && ref.deref();
    if (!el) {
      refById.delete(Number(id));
      return null;
    }
    return el;
  }

  // ---------------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------------

  function isObjectLike(v) {
    return v !== null && (typeof v === 'object' || typeof v === 'function');
  }

  function isPlainObjectish(v) {
    return v !== null && typeof v === 'object' && !isNode(v);
  }

  function isNode(v) {
    try {
      return !!v && typeof v === 'object' && typeof v.nodeType === 'number' && typeof v.nodeName === 'string';
    } catch (e) {
      return false;
    }
  }

  function safeGet(obj, key) {
    try {
      return { ok: true, value: obj[key] };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  function ctorName(v) {
    try {
      var proto = Object.getPrototypeOf(v);
      if (proto === null) return 'Object';
      var c = proto && proto.constructor;
      return (c && c.name) || 'Object';
    } catch (e) {
      return 'Object';
    }
  }

  function kebabToCamel(s) {
    return String(s).replace(/-([a-z0-9])/g, function (_, c) { return c.toUpperCase(); });
  }

  /** Resolve a dotted path like "a.b.getState()" against obj. */
  function resolveDotted(obj, dotted) {
    var parts = dotted.split('.');
    var cur = obj;
    var parent = null;
    for (var i = 0; i < parts.length; i++) {
      if (!isObjectLike(cur)) return undefined;
      var part = parts[i];
      var call = /\(\)$/.test(part);
      var name = call ? part.slice(0, -2) : part;
      var got = safeGet(cur, name);
      if (!got.ok) return undefined;
      parent = cur;
      cur = got.value;
      if (call) {
        if (typeof cur !== 'function') return undefined;
        try { cur = cur.call(parent); } catch (e) { return undefined; }
      }
    }
    return { value: cur, parent: parent };
  }

  // Path segments travel as strings. Symbol keys and Map/Set entries need a
  // stable encoding so the panel can address them later.
  var SYM = '\u0000sym:';
  var ENTRY = '\u0000entry:';

  function ownKeys(obj) {
    var keys = [];
    try {
      keys = Object.getOwnPropertyNames(obj);
    } catch (e) { /* ignore */ }
    var syms = [];
    try { syms = Object.getOwnPropertySymbols(obj); } catch (e) { /* ignore */ }
    for (var i = 0; i < syms.length; i++) keys.push(SYM + i);
    return keys;
  }

  function keyLabel(obj, seg) {
    if (seg.indexOf(SYM) === 0) {
      var sym = Object.getOwnPropertySymbols(obj)[Number(seg.slice(SYM.length))];
      return sym ? sym.toString() : seg;
    }
    return seg;
  }

  function child(obj, seg) {
    if (obj instanceof Map) {
      if (seg.indexOf(ENTRY) === 0) {
        var i = Number(seg.slice(ENTRY.length));
        var n = 0;
        var found;
        obj.forEach(function (v, k) {
          if (n++ === i) found = { key: k, value: v };
        });
        return { ok: !!found, value: found };
      }
    }
    if (obj instanceof Set && seg.indexOf(ENTRY) === 0) {
      var arr = Array.from(obj);
      var j = Number(seg.slice(ENTRY.length));
      return { ok: j < arr.length, value: arr[j] };
    }
    if (seg.indexOf(SYM) === 0) {
      var sym = Object.getOwnPropertySymbols(obj)[Number(seg.slice(SYM.length))];
      if (!sym) return { ok: false };
      return safeGet(obj, sym);
    }
    return safeGet(obj, seg);
  }

  function walkPath(root, path) {
    var cur = root;
    for (var i = 0; i < path.length; i++) {
      if (!isObjectLike(cur)) return { ok: false };
      var got = child(cur, path[i]);
      if (!got.ok) return { ok: false };
      cur = got.value;
    }
    return { ok: true, value: cur };
  }

  function realKey(obj, seg) {
    if (seg.indexOf(SYM) === 0) return Object.getOwnPropertySymbols(obj)[Number(seg.slice(SYM.length))];
    return seg;
  }

  function cloneDeep(v) {
    try {
      if (typeof structuredClone === 'function') return structuredClone(v);
    } catch (e) { /* fall through: functions/DOM nodes are not cloneable */ }
    if (Array.isArray(v)) return v.slice();
    if (isPlainObjectish(v)) return Object.assign(Object.create(Object.getPrototypeOf(v)), v);
    return v;
  }

  /**
   * Return a copy of `root` with the value at `path` replaced, cloning only the
   * objects along the path (immutable-style update, so frameworks that compare
   * by reference notice the change).
   */
  function immutableSet(root, path, value) {
    if (path.length === 0) return value;
    var copy = Array.isArray(root) ? root.slice() : (isPlainObjectish(root) ? Object.assign(Object.create(Object.getPrototypeOf(root)), root) : cloneDeep(root));
    var key = realKey(root, path[0]);
    copy[key] = immutableSet(root[key], path.slice(1), value);
    return copy;
  }

  // ---------------------------------------------------------------------------
  // Serialisation
  // ---------------------------------------------------------------------------

  function preview(v) {
    var t = typeof v;
    if (v === null) return 'null';
    if (t === 'undefined') return 'undefined';
    if (t === 'string') return JSON.stringify(v.length > 80 ? v.slice(0, 80) + '…' : v);
    if (t === 'number' || t === 'boolean') return String(v);
    if (t === 'bigint') return v + 'n';
    if (t === 'symbol') return v.toString();
    if (t === 'function') return 'ƒ ' + (v.name || 'anonymous') + '()';
    if (isNode(v)) return nodePreview(v);
    if (Array.isArray(v)) return 'Array(' + v.length + ')';
    if (v instanceof Map) return 'Map(' + v.size + ')';
    if (v instanceof Set) return 'Set(' + v.size + ')';
    if (v instanceof Date) return isNaN(v) ? 'Invalid Date' : v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (v instanceof Error) return (v.name || 'Error') + ': ' + v.message;
    if (typeof Promise !== 'undefined' && v instanceof Promise) return 'Promise';
    var name = ctorName(v);
    var keys = [];
    try { keys = Object.keys(v); } catch (e) { /* ignore */ }
    var shown = keys.slice(0, 4).join(', ') + (keys.length > 4 ? ', …' : '');
    return (name === 'Object' ? '' : name + ' ') + '{' + shown + '}';
  }

  function nodePreview(n) {
    if (n.nodeType === 1) {
      var s = '<' + n.nodeName.toLowerCase();
      if (n.id) s += '#' + n.id;
      var cls = typeof n.className === 'string' ? n.className.trim() : '';
      if (cls) s += '.' + cls.split(/\s+/).slice(0, 2).join('.');
      return s + '>';
    }
    if (n.nodeType === 3) return '#text ' + JSON.stringify(String(n.nodeValue).slice(0, 40));
    if (n.nodeType === 11) return n.host ? '#shadow-root' : '#document-fragment';
    if (n.nodeType === 9) return '#document';
    return n.nodeName;
  }

  function typeOf(v) {
    if (v === null) return 'null';
    var t = typeof v;
    if (t !== 'object') return t;
    if (isNode(v)) return 'node';
    if (Array.isArray(v)) return 'array';
    if (v instanceof Map) return 'map';
    if (v instanceof Set) return 'set';
    if (v instanceof Date) return 'date';
    if (v instanceof RegExp) return 'regexp';
    if (v instanceof Error) return 'error';
    return 'object';
  }

  function childEntries(v) {
    // Returns [[segment, label, value], ...] and total count.
    var out = [];
    var total = 0;
    if (v instanceof Map) {
      var i = 0;
      v.forEach(function (val, k) {
        total++;
        if (out.length < MAX_KEYS) out.push([ENTRY + i, preview(k), { key: k, value: val }]);
        i++;
      });
      return { entries: out, total: total };
    }
    if (v instanceof Set) {
      var j = 0;
      v.forEach(function (val) {
        total++;
        if (out.length < MAX_KEYS) out.push([ENTRY + j, String(j), val]);
        j++;
      });
      return { entries: out, total: total };
    }
    if (isNode(v)) {
      // DOM nodes: show a curated set of fields instead of hundreds of keys.
      var fields = ['nodeName', 'id', 'className', 'textContent', 'attributes', 'shadowRoot', 'parentNode', 'children'];
      for (var f = 0; f < fields.length; f++) {
        var g = safeGet(v, fields[f]);
        if (g.ok && g.value !== undefined) out.push([fields[f], fields[f], g.value]);
      }
      return { entries: out, total: out.length };
    }
    var keys = ownKeys(v);
    if (Array.isArray(v)) keys = keys.filter(function (k) { return k !== 'length'; });
    if (typeof v === 'function') {
      keys = keys.filter(function (k) { return ['length', 'name', 'prototype', 'arguments', 'caller'].indexOf(k) === -1; });
    }
    total = keys.length;
    for (var k = 0; k < keys.length && out.length < MAX_KEYS; k++) {
      var seg = keys[k];
      var got = child(v, seg);
      out.push([seg, keyLabel(v, seg), got.ok ? got.value : new Error('<getter threw: ' + got.error + '>')]);
    }
    return { entries: out, total: total };
  }

  function hasChildren(v) {
    if (!isObjectLike(v)) return false;
    if (typeof v === 'function') {
      try { return Object.keys(v).length > 0; } catch (e) { return false; }
    }
    if (v instanceof Map || v instanceof Set) return v.size > 0;
    if (v instanceof Date || v instanceof RegExp) return false;
    if (isNode(v)) return true;
    try {
      return Object.getOwnPropertyNames(v).length > (Array.isArray(v) ? 1 : 0) || Object.getOwnPropertySymbols(v).length > 0;
    } catch (e) {
      return false;
    }
  }

  /**
   * Serialise `v` into a JSON-safe tree. Children are included for the root
   * (depth 0) and for any path listed in ctx.expanded; everything else is
   * reported lazily with `h` (has children) so the panel can ask for more.
   */
  function serialize(v, path, ctx, seen) {
    var t = typeOf(v);
    var node = { t: t, p: preview(v) };
    if (t === 'string') {
      node.v = v.length > MAX_STRING ? v.slice(0, MAX_STRING) : v;
      if (v.length > MAX_STRING) node.trunc = v.length;
    } else if (t === 'number' || t === 'boolean') {
      node.v = isFinite(v) || t === 'boolean' ? v : String(v);
    } else if (t === 'node' && v.nodeType === 1) {
      node.el = register(v);
    }
    if (!hasChildren(v)) return node;
    node.h = 1;
    var pathKey = JSON.stringify(path);
    var expand = path.length < ctx.autoDepth || ctx.expanded[pathKey];
    if (!expand) return node;
    if (seen.indexOf(v) !== -1) {
      node.circular = 1;
      return node;
    }
    seen.push(v);
    var ce = childEntries(v);
    node.c = [];
    for (var i = 0; i < ce.entries.length; i++) {
      var e = ce.entries[i];
      var childNode = serialize(e[2], path.concat([e[0]]), ctx, seen);
      childNode.k = e[0];
      if (e[1] !== e[0]) childNode.l = e[1];
      node.c.push(childNode);
    }
    if (ce.total > ce.entries.length) node.more = ce.total - ce.entries.length;
    seen.pop();
    return node;
  }

  // ---------------------------------------------------------------------------
  // Component detection
  // ---------------------------------------------------------------------------

  function compileTagPattern(opts) {
    var src = (opts && opts.tagPattern) || DEFAULT_TAG_PATTERN;
    try {
      return new RegExp(src, 'i');
    } catch (e) {
      return new RegExp(DEFAULT_TAG_PATTERN, 'i');
    }
  }

  function isCustomElementTag(el) {
    return el && el.nodeType === 1 && el.localName && el.localName.indexOf('-') > 0;
  }

  function isComponentElement(el, ctx) {
    if (!isCustomElementTag(el)) return false;
    if (ctx.allCustomElements) return true;
    return ctx.tagRe.test(el.localName);
  }

  function isDefined(el) {
    try {
      var view = el.ownerDocument && el.ownerDocument.defaultView;
      return !!(view && view.customElements && view.customElements.get(el.localName));
    } catch (e) {
      return false;
    }
  }

  // ---- React (some AIUX surfaces render React inside custom elements) ------

  function reactFiberOf(el) {
    var keys;
    try { keys = Object.keys(el); } catch (e) { return null; }
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) {
        return el[k];
      }
    }
    return null;
  }

  function isCompositeFiber(f) {
    if (!f) return false;
    var t = f.type;
    return typeof t === 'function' || (t !== null && typeof t === 'object' && (t.render || t.type || t.$$typeof));
  }

  function fiberName(f) {
    var t = f && f.type;
    if (!t) return 'Anonymous';
    if (typeof t === 'function') return t.displayName || t.name || 'Anonymous';
    if (typeof t === 'object') {
      if (t.displayName) return t.displayName;
      if (t.render) return 'ForwardRef(' + (t.render.displayName || t.render.name || '') + ')';
      if (t.type) return 'Memo(' + fiberName({ type: t.type }) + ')';
      if (t._context) return (t._context.displayName || 'Context') + '.Consumer';
      if (t.$$typeof && String(t.$$typeof).indexOf('provider') !== -1) return 'Context.Provider';
    }
    return 'Anonymous';
  }

  function nearestComposite(fiber) {
    var f = fiber;
    var guard = 0;
    while (f && guard++ < 10000) {
      if (isCompositeFiber(f)) return f;
      f = f.return;
    }
    return null;
  }

  function sameFiber(a, b) {
    return !!a && !!b && (a === b || a.alternate === b);
  }

  /** The most recently committed version of a fiber. */
  function currentFiber(f) {
    if (!f || !f.alternate) return f;
    // The fiber whose parent's child chain points at it is current; fall back
    // to comparing memoizedProps freshness via the root's current pointer.
    try {
      var root = f;
      var guard = 0;
      while (root.return && guard++ < 10000) root = root.return;
      var container = root.stateNode;
      if (container && container.current) {
        // Walk from the current root down to see which of f / f.alternate is
        // reachable; cheap enough for one lookup.
        var target = f;
        var alt = f.alternate;
        var stack = [container.current];
        var visited = 0;
        while (stack.length && visited++ < 20000) {
          var n = stack.pop();
          if (n === target) return target;
          if (n === alt) return alt;
          if (n.sibling) stack.push(n.sibling);
          if (n.child) stack.push(n.child);
        }
      }
    } catch (e) { /* ignore */ }
    return f;
  }

  // useState is useReducer with React's internal basicStateReducer:
  // (state, action) => typeof action === 'function' ? action(state) : action.
  // Production builds mangle its name, so detect it by behaviour.
  function isBasicStateReducer(fn) {
    if (typeof fn !== 'function') return false;
    if (fn.name === 'basicStateReducer') return true;
    try {
      var marker = {};
      return fn(null, marker) === marker && fn(1, function (x) { return x + 1; }) === 2;
    } catch (e) {
      return false;
    }
  }

  function hookKind(hook) {
    var ms = hook.memoizedState;
    if (hook.queue && (typeof hook.queue.dispatch === 'function')) {
      return isBasicStateReducer(hook.queue.lastRenderedReducer) ? 'State' : 'Reducer';
    }
    if (ms && typeof ms === 'object') {
      if ('create' in ms && 'deps' in ms && 'tag' in ms) return 'Effect';
      if (Object.keys(ms).length === 1 && 'current' in ms) return 'Ref';
      if (Array.isArray(ms) && ms.length === 2 && (Array.isArray(ms[1]) || ms[1] === null)) {
        return typeof ms[0] === 'function' ? 'Callback' : 'Memo';
      }
    }
    return 'Hook';
  }

  function reactHooks(fiber) {
    var list = [];
    var hook = fiber && fiber.memoizedState;
    // Class components keep state as a plain object, not a hook list.
    if (!fiber || (fiber.stateNode && fiber.stateNode.isReactComponent !== undefined) || (fiber.type && fiber.type.prototype && fiber.type.prototype.isReactComponent)) {
      return list;
    }
    var guard = 0;
    while (hook && typeof hook === 'object' && 'memoizedState' in hook && guard++ < 500) {
      var kind = hookKind(hook);
      var value = hook.memoizedState;
      if (kind === 'Effect') value = { deps: value.deps };
      list.push({ hook: list.length + ': ' + kind, value: value, __hook: hook });
      hook = hook.next;
    }
    return list;
  }

  function reactInfo(el) {
    var fiber = reactFiberOf(el);
    if (!fiber) return null;
    var comp = nearestComposite(fiber);
    if (!comp) return null;
    comp = currentFiber(comp);
    var owners = [];
    var f = comp.return;
    var guard = 0;
    while (f && owners.length < 25 && guard++ < 10000) {
      if (isCompositeFiber(f)) owners.push(fiberName(f));
      f = f.return;
    }
    return { fiber: comp, name: fiberName(comp), owners: owners };
  }

  // ---- Custom element (Next Experience / Seismic) introspection ------------

  function declaredProperties(el) {
    var names = Object.create(null);
    var ctor = el.constructor;
    var sources = [];

    for (var i = 0; i < PROPERTY_CONFIG_PATHS.length; i++) {
      var r = resolveDotted(ctor, PROPERTY_CONFIG_PATHS[i]);
      if (r && isPlainObjectish(r.value)) {
        Object.keys(r.value).forEach(function (n) { names[n] = 'config'; });
        sources.push('constructor.' + PROPERTY_CONFIG_PATHS[i]);
      }
    }

    try {
      var observed = ctor && ctor.observedAttributes;
      if (observed && observed.length) {
        for (var a = 0; a < observed.length; a++) {
          var camel = kebabToCamel(observed[a]);
          if (!(camel in names)) names[camel] = 'attribute';
        }
        sources.push('observedAttributes');
      }
    } catch (e) { /* ignore */ }

    // Accessors defined by the component class (and its framework base
    // classes) — this is how custom element frameworks expose properties.
    var view = el.ownerDocument && el.ownerDocument.defaultView;
    var stopAt = view && view.HTMLElement ? view.HTMLElement.prototype : HTMLElement.prototype;
    var proto = Object.getPrototypeOf(el);
    var guard = 0;
    var foundAccessor = false;
    while (proto && proto !== stopAt && proto !== Object.prototype && guard++ < 20) {
      var own = Object.getOwnPropertyNames(proto);
      for (var p = 0; p < own.length; p++) {
        var name = own[p];
        if (name === 'constructor') continue;
        var d = Object.getOwnPropertyDescriptor(proto, name);
        if (d && (d.get || d.set)) {
          if (!(name in names)) names[name] = 'accessor';
          foundAccessor = true;
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
    if (foundAccessor) sources.push('class accessors');

    return { names: names, sources: sources };
  }

  function propertiesRoot(el) {
    var decl = declaredProperties(el);
    var obj = {};
    Object.keys(decl.names).sort().forEach(function (n) {
      var got = safeGet(el, n);
      obj[n] = got.ok ? got.value : new Error('<getter threw: ' + got.error + '>');
    });
    return { value: obj, sources: decl.sources };
  }

  function findState(el, ctx) {
    var paths = (ctx.statePaths || []).concat(STATE_PATHS);
    for (var i = 0; i < paths.length; i++) {
      var r = resolveDotted(el, paths[i]);
      if (r && isPlainObjectish(r.value)) return { source: paths[i], value: r.value, container: r.parent };
    }

    // Heuristic scan of the host's own (often non-enumerable / symbol) slots.
    var keys = ownKeys(el).filter(function (k) { return k.indexOf('__react') !== 0; });
    var k, got;
    for (i = 0; i < keys.length; i++) {
      k = keys[i];
      if (!/state/i.test(keyLabel(el, k))) continue;
      got = child(el, k);
      if (got.ok && isPlainObjectish(got.value)) return { source: keyLabel(el, k), value: got.value, container: el };
    }
    for (i = 0; i < keys.length; i++) {
      k = keys[i];
      got = child(el, k);
      if (!got.ok || !isPlainObjectish(got.value)) continue;
      var holder = got.value;
      var subs = ['state', '_state', '__state', 'currentState', 'componentState'];
      for (var s = 0; s < subs.length; s++) {
        var sg = safeGet(holder, subs[s]);
        if (sg.ok && isPlainObjectish(sg.value)) {
          return { source: keyLabel(el, k) + '.' + subs[s], value: sg.value, container: holder };
        }
      }
      var gs = safeGet(holder, 'getState');
      if (gs.ok && typeof gs.value === 'function') {
        try {
          var st = gs.value.call(holder);
          if (isPlainObjectish(st)) return { source: keyLabel(el, k) + '.getState()', value: st, container: holder };
        } catch (e) { /* ignore */ }
      }
    }
    return null;
  }

  function findUpdater(el, stateInfo) {
    var candidates = [stateInfo && stateInfo.container, el];
    for (var c = 0; c < candidates.length; c++) {
      var obj = candidates[c];
      if (!isObjectLike(obj)) continue;
      for (var i = 0; i < STATE_UPDATERS.length; i++) {
        var got = safeGet(obj, STATE_UPDATERS[i]);
        if (got.ok && typeof got.value === 'function') return { fn: got.value, self: obj, name: STATE_UPDATERS[i] };
      }
    }
    return null;
  }

  function attributesRoot(el) {
    var obj = {};
    var attrs = el.attributes || [];
    for (var i = 0; i < attrs.length; i++) obj[attrs[i].name] = attrs[i].value;
    return obj;
  }

  function internalsRoot(el) {
    var obj = {};
    var keys = ownKeys(el);
    for (var i = 0; i < keys.length; i++) {
      var got = child(el, keys[i]);
      obj[keyLabel(el, keys[i])] = got.ok ? got.value : new Error('<getter threw: ' + got.error + '>');
    }
    return obj;
  }

  function componentLabel(el) {
    var s = el.localName;
    var named = ['component-id', 'data-component-id', 'data-id', 'name'];
    for (var i = 0; i < named.length; i++) {
      var v = el.getAttribute && el.getAttribute(named[i]);
      if (v) return s + ' [' + v + ']';
    }
    if (el.id) return s + '#' + el.id;
    return s;
  }

  // ---------------------------------------------------------------------------
  // Tree building (walks light DOM, open shadow roots and same-origin iframes)
  // ---------------------------------------------------------------------------

  function makeCtx(opts) {
    opts = opts || {};
    return {
      tagRe: compileTagPattern(opts),
      allCustomElements: !!opts.allCustomElements,
      includeReact: opts.includeReact !== false,
      statePaths: Array.isArray(opts.statePaths) ? opts.statePaths.filter(Boolean) : [],
      expanded: opts.expanded || {},
      autoDepth: typeof opts.autoDepth === 'number' ? opts.autoDepth : 1,
      count: 0,
      truncated: false
    };
  }

  function childNodesOf(el) {
    var list = [];
    if (el.shadowRoot) list.push(el.shadowRoot);
    if (el.localName === 'iframe' || el.localName === 'frame') {
      try {
        if (el.contentDocument && el.contentDocument.documentElement) list.push(el.contentDocument.documentElement);
      } catch (e) { /* cross-origin */ }
    }
    if (el.localName === 'slot') {
      // Slotted content is walked where it lives (light DOM); skip here.
    }
    var kids = el.children || [];
    for (var i = 0; i < kids.length; i++) list.push(kids[i]);
    return list;
  }

  function walk(node, parentOut, ctx, reactParent) {
    if (ctx.count >= MAX_TREE_NODES) {
      ctx.truncated = true;
      return;
    }
    var out = parentOut;
    var reactCurrent = reactParent;

    if (node.nodeType === 1) {
      var isComp = isComponentElement(node, ctx);
      var reactNode = null;
      if (ctx.includeReact) {
        var fiber = reactFiberOf(node);
        if (fiber) {
          var comp = nearestComposite(fiber);
          if (comp && !sameFiber(comp, reactParent)) {
            reactNode = comp;
          }
          if (comp) reactCurrent = comp;
        }
      }
      if (isComp || reactNode) {
        var entry = {
          id: register(node),
          n: isComp ? componentLabel(node) : '<' + fiberName(reactNode) + '>',
          k: isComp ? (isDefined(node) ? 'ce' : 'ce-undefined') : 'react',
          c: []
        };
        if (isComp && reactNode) entry.r = fiberName(reactNode);
        ctx.count++;
        parentOut.push(entry);
        out = entry.c;
      }
    }

    var kids = node.nodeType === 11 ? (node.children || []) : childNodesOf(node);
    for (var i = 0; i < kids.length; i++) walk(kids[i], out, ctx, reactCurrent);
  }

  // ---------------------------------------------------------------------------
  // Sections
  // ---------------------------------------------------------------------------

  /** Build the raw (unserialised) sections for an element. */
  function rawSections(el, ctx) {
    var sections = [];
    var isCE = isCustomElementTag(el);

    if (isCE) {
      var props = propertiesRoot(el);
      sections.push({
        key: 'properties',
        title: 'Properties',
        root: props.value,
        editable: true,
        note: props.sources.length ? 'from ' + props.sources.join(', ') : 'no declared properties found'
      });

      var st = findState(el, ctx);
      var updater = st ? findUpdater(el, st) : null;
      sections.push({
        key: 'state',
        title: 'State',
        root: st ? st.value : undefined,
        editable: !!st,
        note: st ? 'from host.' + st.source + (updater ? ' · writes via ' + updater.name + '()' : ' · writes mutate in place') : 'no state object found on the host (add a path in Settings)',
        empty: !st
      });
    }

    var ri = ctx.includeReact ? reactInfo(el) : null;
    if (ri) {
      var f = ri.fiber;
      sections.push({
        key: 'react.props',
        title: 'React props — ' + ri.name,
        root: f.memoizedProps,
        editable: false,
        note: ri.owners.length ? 'rendered by ' + ri.owners.slice(0, 6).join(' ← ') : ''
      });
      var inst = f.stateNode;
      if (inst && typeof inst.setState === 'function') {
        sections.push({ key: 'react.state', title: 'React state — ' + ri.name, root: inst.state, editable: true, note: 'class component · writes via setState()' });
      } else {
        var hooks = reactHooks(f);
        if (hooks.length) {
          var hooksRoot = {};
          hooks.forEach(function (h) { hooksRoot[h.hook] = h.value; });
          sections.push({ key: 'react.hooks', title: 'React hooks — ' + ri.name, root: hooksRoot, editable: true, note: 'useState hooks are editable (via their dispatcher)' });
        }
      }
    }

    if (el.attributes && el.attributes.length) {
      sections.push({ key: 'attributes', title: 'Attributes', root: attributesRoot(el), editable: true, attr: true });
    }
    if (isCE) {
      sections.push({ key: 'internals', title: 'Host internals', root: internalsRoot(el), editable: false, collapsed: true, note: 'own (incl. non-enumerable & symbol) properties of the host element' });
    }
    return sections;
  }

  // ---------------------------------------------------------------------------
  // Highlight overlay & picker
  // ---------------------------------------------------------------------------

  var overlay = null;
  var overlayLabel = null;

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    overlay = document.createElement('div');
    overlay.setAttribute('data-sn-aiux-devtools', 'overlay');
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:rgba(111,168,220,.35);outline:1px solid rgba(26,115,232,.9);display:none;box-sizing:border-box;';
    overlayLabel = document.createElement('div');
    overlayLabel.style.cssText = 'position:absolute;left:0;top:-22px;white-space:nowrap;font:11px/18px Menlo,Consolas,monospace;background:#1a73e8;color:#fff;padding:0 6px;border-radius:2px;';
    overlay.appendChild(overlayLabel);
    (document.body || document.documentElement).appendChild(overlay);
    return overlay;
  }

  function frameOffset(el) {
    var x = 0;
    var y = 0;
    try {
      var win = el.ownerDocument.defaultView;
      while (win && win !== window && win.frameElement) {
        var r = win.frameElement.getBoundingClientRect();
        x += r.left + win.frameElement.clientLeft;
        y += r.top + win.frameElement.clientTop;
        win = win.parent;
      }
    } catch (e) { /* ignore */ }
    return { x: x, y: y };
  }

  function highlightElement(el, label) {
    if (!el || !el.getBoundingClientRect) return unhighlight();
    var o = ensureOverlay();
    var r = el.getBoundingClientRect();
    var off = frameOffset(el);
    o.style.left = (r.left + off.x) + 'px';
    o.style.top = (r.top + off.y) + 'px';
    o.style.width = r.width + 'px';
    o.style.height = r.height + 'px';
    o.style.display = 'block';
    overlayLabel.textContent = (label || el.localName) + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    overlayLabel.style.top = (r.top + off.y) < 22 ? '0px' : '-22px';
  }

  function unhighlight() {
    if (overlay) overlay.style.display = 'none';
  }

  function nearestComponent(start, ctx) {
    var el = start;
    var guard = 0;
    while (el && guard++ < 10000) {
      if (el.nodeType === 1) {
        if (isComponentElement(el, ctx)) return el;
        if (ctx.includeReact && reactFiberOf(el) && !isCustomElementTag(el)) {
          // A React-managed element counts only if it starts a component
          // boundary; otherwise keep walking to find the owning component.
          var fiber = reactFiberOf(el);
          var comp = nearestComposite(fiber);
          var parent = el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : null;
          var parentComp = parent && reactFiberOf(parent) ? nearestComposite(reactFiberOf(parent)) : null;
          if (comp && !sameFiber(comp, parentComp)) return el;
        }
      }
      if (el.parentNode && el.parentNode.nodeType === 11 && el.parentNode.host) {
        el = el.parentNode.host;
      } else if (el.parentNode && el.parentNode.nodeType === 9) {
        var win = el.parentNode.defaultView;
        el = win && win.frameElement;
      } else {
        el = el.parentNode;
      }
    }
    return null;
  }

  var pick = { active: false, ctx: null, result: null, handlers: null };

  function stopPick() {
    if (!pick.active) return;
    pick.active = false;
    var h = pick.handlers;
    window.removeEventListener('mousemove', h.move, true);
    window.removeEventListener('click', h.click, true);
    window.removeEventListener('mousedown', h.block, true);
    window.removeEventListener('mouseup', h.block, true);
    window.removeEventListener('keydown', h.key, true);
    unhighlight();
  }

  function startPick(opts) {
    stopPick();
    var ctx = makeCtx(opts);
    pick.active = true;
    pick.result = null;
    var targetOf = function (e) {
      var path = e.composedPath ? e.composedPath() : [e.target];
      for (var i = 0; i < path.length; i++) {
        if (path[i] && path[i].nodeType === 1 && path[i] !== overlay) return nearestComponent(path[i], ctx);
      }
      return null;
    };
    pick.handlers = {
      move: function (e) {
        var c = targetOf(e);
        if (c) highlightElement(c, componentLabel(c));
        else unhighlight();
      },
      click: function (e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        var c = targetOf(e);
        pick.result = c ? register(c) : 0;
        stopPick();
      },
      block: function (e) {
        e.preventDefault();
        e.stopPropagation();
      },
      key: function (e) {
        if (e.key === 'Escape') {
          pick.result = 0;
          stopPick();
        }
      }
    };
    window.addEventListener('mousemove', pick.handlers.move, true);
    window.addEventListener('click', pick.handlers.click, true);
    window.addEventListener('mousedown', pick.handlers.block, true);
    window.addEventListener('mouseup', pick.handlers.block, true);
    window.addEventListener('keydown', pick.handlers.key, true);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function ancestorsOf(el, ctx) {
    // Ids of component ancestors (outermost first), used by the panel to
    // expand the tree down to a picked/selected component.
    var ids = [];
    var cur = el;
    var guard = 0;
    while (cur && guard++ < 10000) {
      if (cur.parentNode && cur.parentNode.nodeType === 11 && cur.parentNode.host) cur = cur.parentNode.host;
      else if (cur.parentNode && cur.parentNode.nodeType === 9) {
        var w = cur.parentNode.defaultView;
        cur = w && w.frameElement;
      } else cur = cur.parentNode;
      if (cur && cur.nodeType === 1) {
        var n = nearestComponent(cur, ctx);
        if (n === cur) ids.unshift(register(cur));
      }
    }
    return ids;
  }

  function parseValue(text) {
    if (text === 'undefined') return undefined;
    try {
      return JSON.parse(text);
    } catch (e) {
      return text;
    }
  }

  var api = {
    version: VERSION,

    getTree: function (opts) {
      var ctx = makeCtx(opts);
      var roots = [];
      walk(document.documentElement, roots, ctx, null);
      return { nodes: roots, count: ctx.count, truncated: ctx.truncated, url: location.href, title: document.title };
    },

    inspect: function (id, opts) {
      var el = lookup(id);
      if (!el) return { error: 'gone' };
      var ctx = makeCtx(opts);
      var ri = ctx.includeReact ? reactInfo(el) : null;
      var kinds = [];
      if (isCustomElementTag(el)) kinds.push(isDefined(el) ? 'Custom Element' : 'Undefined Custom Element');
      if (isCustomElementTag(el) && ctx.tagRe.test(el.localName)) kinds.push('ServiceNow');
      if (ri) kinds.push('React');
      var sections = rawSections(el, ctx).map(function (s) {
        var subCtx = {
          expanded: (ctx.expanded[s.key] || {}),
          autoDepth: 1
        };
        var out = {
          key: s.key,
          title: s.title,
          editable: s.editable,
          note: s.note || '',
          collapsed: !!s.collapsed,
          empty: !!s.empty
        };
        if (!s.empty) out.value = serialize(s.root, [], subCtx, []);
        return out;
      });
      return {
        id: Number(id),
        tag: el.localName,
        label: isCustomElementTag(el) ? componentLabel(el) : (ri ? '<' + ri.name + '>' : nodePreview(el)),
        kinds: kinds,
        connected: el.isConnected,
        ancestors: ancestorsOf(el, ctx),
        sections: sections
      };
    },

    setValue: function (id, sectionKey, path, text, opts) {
      var el = lookup(id);
      if (!el) return { ok: false, error: 'Element is no longer available' };
      var ctx = makeCtx(opts);
      var value = parseValue(text);
      try {
        if (sectionKey === 'properties') {
          if (!path.length) return { ok: false, error: 'Select a property' };
          var name = path[0];
          var next = path.length === 1 ? value : immutableSet(el[name], path.slice(1), value);
          el[name] = next;
          return { ok: true, method: 'host.' + name + ' = …' };
        }
        if (sectionKey === 'attributes') {
          if (path.length !== 1) return { ok: false, error: 'Attributes are flat strings' };
          if (value === null || value === undefined) el.removeAttribute(path[0]);
          else el.setAttribute(path[0], typeof value === 'string' ? value : JSON.stringify(value));
          return { ok: true, method: 'setAttribute' };
        }
        if (sectionKey === 'state') {
          var st = findState(el, ctx);
          if (!st) return { ok: false, error: 'No state found' };
          if (!path.length) return { ok: false, error: 'Select a state key' };
          var updater = findUpdater(el, st);
          var top = realKey(st.value, path[0]);
          var newTop = path.length === 1 ? value : immutableSet(st.value[top], path.slice(1), value);
          if (updater) {
            var patch = {};
            patch[top] = newTop;
            updater.fn.call(updater.self, patch);
            return { ok: true, method: updater.name + '()' };
          }
          st.value[top] = newTop;
          // Nudge common re-render hooks; harmless if absent.
          ['requestUpdate', 'forceUpdate', 'render', 'rerender'].some(function (m) {
            if (typeof el[m] === 'function') {
              try { el[m](); return true; } catch (e) { return false; }
            }
            return false;
          });
          return { ok: true, method: 'mutated in place (may not re-render)' };
        }
        if (sectionKey === 'react.state') {
          var ri = reactInfo(el);
          var inst = ri && ri.fiber.stateNode;
          if (!inst || typeof inst.setState !== 'function') return { ok: false, error: 'Not a class component' };
          var k = path[0];
          var p = {};
          p[k] = path.length === 1 ? value : immutableSet(inst.state[k], path.slice(1), value);
          inst.setState(p);
          return { ok: true, method: 'setState()' };
        }
        if (sectionKey === 'react.hooks') {
          var info = reactInfo(el);
          var hooks = info ? reactHooks(info.fiber) : [];
          // Hook keys look like "1: State"; the number is the hook's index.
          var h = hooks[parseInt(path[0], 10)];
          if (!h) return { ok: false, error: 'Edit a hook value' };
          var q = h.__hook.queue;
          if (!q || typeof q.dispatch !== 'function') return { ok: false, error: 'Only useState/useReducer hooks are editable' };
          if (!isBasicStateReducer(q.lastRenderedReducer)) {
            return { ok: false, error: 'useReducer state cannot be set directly' };
          }
          var nv = path.length === 1 ? value : immutableSet(h.__hook.memoizedState, path.slice(1), value);
          q.dispatch(nv);
          return { ok: true, method: 'hook dispatch()' };
        }
        return { ok: false, error: 'Section is read-only' };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    },

    highlight: function (id) {
      var el = lookup(id);
      if (el) highlightElement(el, isCustomElementTag(el) ? componentLabel(el) : null);
      else unhighlight();
      return !!el;
    },

    unhighlight: function () {
      unhighlight();
      return true;
    },

    scrollIntoView: function (id) {
      var el = lookup(id);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' });
      return !!el;
    },

    startPick: startPick,

    stopPick: function () {
      stopPick();
      return true;
    },

    /** Returns null while picking, 0 if cancelled, or the picked id. */
    pollPick: function () {
      if (pick.active) return null;
      var r = pick.result;
      pick.result = null;
      return r === null ? 0 : r;
    },

    /** Resolve the nearest component for an element (e.g. DevTools' $0). */
    idForElement: function (el, opts) {
      if (!el || el.nodeType !== 1) return 0;
      var ctx = makeCtx(opts);
      var c = nearestComponent(el, ctx);
      return register(c || el);
    },

    getElement: function (id) {
      return lookup(id);
    },

    /** Store a value on window as $aiuxN and return the name. */
    storeGlobal: function (id, sectionKey, path, opts) {
      var el = lookup(id);
      if (!el) return null;
      var value = el;
      if (sectionKey) {
        var ctx = makeCtx(opts);
        var s = rawSections(el, ctx).filter(function (x) { return x.key === sectionKey; })[0];
        if (!s) return null;
        var r = walkPath(s.root, path || []);
        if (!r.ok) return null;
        value = r.value;
      }
      var n = 1;
      while (('$aiux' + n) in window) n++;
      window['$aiux' + n] = value;
      return '$aiux' + n;
    },

    /** Return a JSON string of a value (for "Copy value"). */
    copyValue: function (id, sectionKey, path, opts) {
      var el = lookup(id);
      if (!el) return null;
      var ctx = makeCtx(opts);
      var s = rawSections(el, ctx).filter(function (x) { return x.key === sectionKey; })[0];
      if (!s) return null;
      var r = walkPath(s.root, path || []);
      if (!r.ok) return null;
      var seen = [];
      try {
        return JSON.stringify(r.value, function (k, v) {
          if (typeof v === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
          if (typeof v === 'bigint') return v.toString();
          if (isNode(v)) return nodePreview(v);
          if (v instanceof Map) return Object.fromEntries(v);
          if (v instanceof Set) return Array.from(v);
          if (isObjectLike(v)) {
            if (seen.indexOf(v) !== -1) return '[Circular]';
            seen.push(v);
          }
          return v;
        }, 2);
      } catch (e) {
        return String(r.value);
      }
    },

    dispose: function () {
      stopPick();
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null;
    }
  };

  Object.defineProperty(window, GLOBAL, { value: api, configurable: true, writable: true, enumerable: false });
  return VERSION;
})();

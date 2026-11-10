/*
 * Test-only stand-in for DevTools' getEventListeners(), which only exists in
 * the DevTools console scope. Must load before any component registers a
 * listener. The chrome.devtools mock exposes it as getEventListeners.
 */
(function () {
  'use strict';
  const registry = new WeakMap();
  const proto = EventTarget.prototype;
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  const capture = (o) => (typeof o === 'boolean' ? o : !!(o && o.capture));

  proto.addEventListener = function (type, listener, options) {
    if (listener) {
      const map = registry.get(this) || {};
      registry.set(this, map);
      const list = (map[type] = map[type] || []);
      if (!list.some((l) => l.listener === listener && l.useCapture === capture(options))) {
        list.push({
          type,
          listener,
          useCapture: capture(options),
          passive: !!(options && options.passive),
          once: !!(options && options.once)
        });
      }
    }
    return add.call(this, type, listener, options);
  };

  proto.removeEventListener = function (type, listener, options) {
    const map = registry.get(this);
    if (map && map[type]) {
      map[type] = map[type].filter((l) => !(l.listener === listener && l.useCapture === capture(options)));
      if (!map[type].length) delete map[type];
    }
    return remove.call(this, type, listener, options);
  };

  window.__testGetEventListeners = (target) => Object.assign({}, registry.get(target) || {});
})();

/*
 * Minimal chrome.* mock so panel/sidebar pages can run in a normal tab, with
 * the "inspected window" being the sibling iframe named "inspected".
 */
(function () {
  'use strict';
  const inspected = () => window.parent.frames['inspected'];
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/manifest.json', false);
  xhr.send();
  const manifest = JSON.parse(xhr.responseText);

  // Listeners from every mocked page (panel + sidebar) share one list so the
  // harness can simulate an Elements-panel selection or a navigation.
  const mock = (window.parent.__aiuxMock = window.parent.__aiuxMock || {});
  const selectionListeners = (mock.selectionListeners = mock.selectionListeners || []);
  const navigateListeners = (mock.navigateListeners = mock.navigateListeners || []);

  window.chrome = {
    runtime: {
      getManifest: () => manifest,
      getURL: (p) => '/' + String(p).replace(/^\//, '')
    },
    devtools: {
      inspectedWindow: {
        eval(expression, callback) {
          let result;
          let exc;
          try {
            const w = inspected();
            w.$0 = window.parent.__aiuxMock.$0 || null;
            w.inspect = (el) => { window.parent.__aiuxMock.inspected = el; };
            result = w.eval(expression);
            result = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
          } catch (e) {
            exc = { isException: true, value: String(e && e.stack || e) };
          }
          setTimeout(() => callback(result, exc), 0);
        }
      },
      panels: {
        themeName: new URLSearchParams(location.search).get('theme') || 'default',
        elements: { onSelectionChanged: { addListener: (fn) => selectionListeners.push(fn) } }
      },
      network: { onNavigated: { addListener: (fn) => navigateListeners.push(fn) } }
    }
  };
})();

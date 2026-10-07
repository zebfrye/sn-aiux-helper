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
            // DevTools-only Console Utilities; emulated by fixtures/listener-tracker.js.
            w.getEventListeners = w.__testGetEventListeners;
            result = w.eval(expression);
            result = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
          } catch (e) {
            exc = { isException: true, value: String(e && e.stack || e) };
          }
          setTimeout(() => callback(result, exc), 0);
        },
        // Reload the inspected iframe, running injectedScript before any page script.
        async reload(options) {
          const frame = window.parent.document.getElementById('inspected');
          const url = new URL(frame.getAttribute('src') || frame.dataset.src, location.href).href;
          frame.dataset.src = url;
          let html = await (await fetch(url)).text();
          const script = (options && options.injectedScript) || '';
          const head = '<head><base href="' + url + '"><script>' + script.replace(/<\/script/gi, '<\\/script') + '<\/script>';
          html = html.replace('<head>', () => head); // a function: the script contains `$'`
          frame.addEventListener('load', () => navigateListeners.forEach((fn) => fn(url)), { once: true });
          frame.removeAttribute('src');
          frame.srcdoc = html;
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

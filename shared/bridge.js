/*
 * Bridge between extension pages (panel / sidebar) and the page agent.
 * Calls are made with chrome.devtools.inspectedWindow.eval in the page's main
 * world, so the agent can see the components' real JS objects. The agent is
 * injected lazily (and re-injected after navigations or extension updates).
 */
(function (global) {
  'use strict';

  const AGENT_GLOBAL = '__SN_AIUX_DEVTOOLS__';
  const AGENT_VERSION = chrome.runtime.getManifest().version;
  let agentSource = null;
  let catalogJson = null;

  // DevTools' Console Utilities getEventListeners(), when this eval has them.
  const GEL = '(typeof getEventListeners==="function"?getEventListeners:null)';

  function evalInPage(expression) {
    return new Promise((resolve, reject) => {
      chrome.devtools.inspectedWindow.eval(expression, (result, exc) => {
        if (exc && (exc.isError || exc.isException)) {
          reject(new Error(exc.isException ? String(exc.value) : exc.description || exc.code || 'eval failed'));
        } else {
          resolve(result);
        }
      });
    });
  }

  async function loadAgentSource() {
    if (!agentSource) {
      const res = await fetch(chrome.runtime.getURL('agent/agent.js'));
      agentSource = await res.text();
    }
    return agentSource;
  }

  async function loadCatalogJson() {
    if (catalogJson === null) {
      try {
        const res = await fetch(chrome.runtime.getURL('data/aiux-events.json'));
        catalogJson = JSON.stringify(await res.json());
      } catch (e) {
        catalogJson = 'null';
      }
    }
    return catalogJson;
  }

  /** Agent source plus catalog, evaluating to the agent version. */
  async function agentBundle(extraSource) {
    const [source, catalog] = await Promise.all([loadAgentSource(), loadCatalogJson()]);
    return (
      source +
      '\n;(function(a){a.setCatalog(' + catalog + ');' + (extraSource || '') + '})(window[' + JSON.stringify(AGENT_GLOBAL) + ']);\n' +
      'window[' + JSON.stringify(AGENT_GLOBAL) + '].version'
    );
  }

  async function inject() {
    const version = await evalInPage(await agentBundle());
    if (version !== AGENT_VERSION) {
      throw new Error('Agent version mismatch: ' + version + ' vs ' + AGENT_VERSION);
    }
  }

  /**
   * Call agent.method(...) where `argsSource` is a JS source string of the
   * argument list (so callers can pass DevTools helpers like $0).
   */
  async function callSource(method, argsSource) {
    const expr =
      '(function(){var a=window[' + JSON.stringify(AGENT_GLOBAL) + '];' +
      'if(!a||a.version!==' + JSON.stringify(AGENT_VERSION) + ')return{noAgent:1};' +
      'return{r:a[' + JSON.stringify(method) + '](' + argsSource + ')};})()';
    let res = await evalInPage(expr);
    if (res && res.noAgent) {
      await inject();
      res = await evalInPage(expr);
    }
    if (!res || res.noAgent) throw new Error('Could not start the AIUX DevTools agent in this page');
    return res.r;
  }

  function argsToSource(args) {
    return args.map((a) => (a === undefined ? 'undefined' : JSON.stringify(a))).join(',');
  }

  function call(method, ...args) {
    return callSource(method, argsToSource(args));
  }

  /** Like call(), with getEventListeners appended as the last argument. */
  function callWithListeners(method, ...args) {
    return callSource(method, argsToSource(args) + ',' + GEL);
  }

  /** Open a value (e.g. a listener function) in the Sources/Elements panel. */
  async function revealValue(id, sectionKey, path, opts) {
    await callSource('eventStatus', '');
    return evalInPage(
      'inspect(window[' + JSON.stringify(AGENT_GLOBAL) + '].resolveValue(' +
        argsToSource([id, sectionKey, path, opts]) + ',' + GEL + '))'
    );
  }

  /**
   * Reload the inspected page with the agent injected before any page script,
   * recording events from the very start.
   */
  async function reloadAndRecord(opts) {
    const injectedScript = await agentBundle('a.startEventCapture(' + JSON.stringify(opts || {}) + ');');
    chrome.devtools.inspectedWindow.reload({ ignoreCache: false, injectedScript });
  }

  /** Reveal a component's host element in the Elements panel. */
  function revealInElements(id) {
    return evalInPage(
      'inspect(window[' + JSON.stringify(AGENT_GLOBAL) + '].getElement(' + JSON.stringify(id) + '))'
    );
  }

  global.AiuxBridge = { call, callSource, callWithListeners, evalInPage, revealInElements, revealValue, reloadAndRecord };
})(window);

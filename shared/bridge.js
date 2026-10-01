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

  async function inject() {
    const version = await evalInPage(await loadAgentSource());
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

  function call(method, ...args) {
    const argsSource = args.map((a) => (a === undefined ? 'undefined' : JSON.stringify(a))).join(',');
    return callSource(method, argsSource);
  }

  /** Reveal a component's host element in the Elements panel. */
  function revealInElements(id) {
    return evalInPage(
      'inspect(window[' + JSON.stringify(AGENT_GLOBAL) + '].getElement(' + JSON.stringify(id) + '))'
    );
  }

  global.AiuxBridge = { call, callSource, evalInPage, revealInElements };
})(window);

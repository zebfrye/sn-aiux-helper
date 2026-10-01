/*
 * Panel settings, kept in the extension origin's localStorage (shared by the
 * panel and the Elements sidebar).
 */
(function (global) {
  'use strict';

  const KEY = 'sn-aiux-devtools.settings';
  const DEFAULTS = {
    tagPattern: '^(now|sn|macroponent|uxf|x|aiux|ai|nas|sys|seismic)-',
    allCustomElements: false,
    includeReact: true,
    statePaths: [],
    live: true,
    pollMs: 1000
  };

  function load() {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}'));
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function save(settings) {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch (e) {
      /* storage unavailable: settings last for this session only */
    }
  }

  /** Options passed to the agent for every call. */
  function agentOptions(settings, extra) {
    return Object.assign(
      {
        tagPattern: settings.tagPattern,
        allCustomElements: settings.allCustomElements,
        includeReact: settings.includeReact,
        statePaths: settings.statePaths
      },
      extra || {}
    );
  }

  global.AiuxSettings = { DEFAULTS, load, save, agentOptions };
})(window);

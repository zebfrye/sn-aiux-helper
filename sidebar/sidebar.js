/*
 * Elements-panel sidebar: shows the nearest AIUX component of the element
 * selected in the Elements panel ($0).
 */
(function () {
  'use strict';

  const { callSource } = window.AiuxBridge;
  const Settings = window.AiuxSettings;

  const statusEl = document.getElementById('status');
  const setStatus = (msg, isError) => {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('error', !!isError);
  };

  // Re-read settings on every call so changes made in the AIUX panel apply.
  const opts = (extra) => Settings.agentOptions(Settings.load(), extra);

  const details = new window.AiuxDetailsView(document.getElementById('details'), {
    getOptions: opts,
    onStatus: setStatus,
    compact: true
  });

  async function follow() {
    try {
      const id = await callSource('idForElement', '$0,' + JSON.stringify(opts()));
      if (id) await details.show(id);
      else details.clear('Select an element in the Elements panel.');
    } catch (e) {
      details.clear('Unable to inspect: ' + e.message);
    }
  }

  chrome.devtools.panels.elements.onSelectionChanged.addListener(follow);
  chrome.devtools.network.onNavigated.addListener(() => details.clear('Page navigated.'));

  let visible = true; // false while the sidebar pane is collapsed or another panel is showing

  setInterval(() => {
    if (visible && !document.hidden && Settings.load().live) details.refresh(false);
  }, 1000);

  // Called by devtools.js when the sidebar pane is shown or hidden.
  window.AiuxSidebar = {
    setVisible(v) {
      const was = visible;
      visible = !!v;
      if (visible && !was) follow();
    }
  };

  follow();
})();

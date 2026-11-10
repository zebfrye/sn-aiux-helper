/*
 * AIUX DevTools panel — Contexts tab: the app state shared through AIUX
 * contexts (createContext), as declared by the components on the page.
 */
(function () {
  'use strict';

  const Panel = window.AiuxPanel;
  const $ = (id) => document.getElementById(id);
  const statusEl = $('ctx-status');
  const SUBJECT = 'page:contexts';
  const POLL_MS = 2000; // each refresh scans the whole page, so poll gently

  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.title = msg || '';
    statusEl.classList.toggle('error', !!isError);
  }

  const details = new window.AiuxDetailsView($('ctx-details'), {
    getOptions: Panel.agentOptions,
    onStatus: setStatus,
    onSelectId: (id) => Panel.selectComponent(id),
    emptyMessage: 'Scanning the page for contexts…',
    goneMessage: 'Contexts are not available on this page.'
  });

  const isShowing = () => Panel.currentTab() === 'contexts' && Panel.isVisible();

  function refresh(force) {
    if (details.id === null) details.show(SUBJECT);
    else details.refresh(force);
  }

  Panel.onTabShown((name) => {
    if (name === 'contexts') refresh(true);
  });

  $('ctx-refresh').addEventListener('click', () => {
    setStatus('');
    refresh(true);
  });

  setInterval(() => {
    if (isShowing() && Panel.isLive()) refresh(false);
  }, POLL_MS);

  chrome.devtools.network.onNavigated.addListener(() => {
    details.clear();
    // Give the new page a moment to boot its components.
    if (isShowing()) setTimeout(() => refresh(true), 1000);
  });
})();

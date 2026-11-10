// Registers the "AIUX" DevTools panel and the Elements-panel sidebar, and
// tells each page when it is shown or hidden so it only polls the inspected
// page while someone is looking at it.

/** Forward a panel's onShown/onHidden to `window[name].setVisible()` in its page. */
function trackVisibility(view, name) {
  let pageWindow = null;
  view.onShown.addListener((win) => {
    pageWindow = win;
    if (win && win[name]) win[name].setVisible(true);
  });
  view.onHidden.addListener(() => {
    if (pageWindow && pageWindow[name]) pageWindow[name].setVisible(false);
  });
}

chrome.devtools.panels.create('AIUX', '/icons/icon32.png', '/panel/panel.html', (panel) => {
  trackVisibility(panel, 'AiuxPanel');
});

chrome.devtools.panels.elements.createSidebarPane('AIUX Component', (pane) => {
  pane.setPage('/sidebar/sidebar.html');
  pane.setHeight('400px');
  trackVisibility(pane, 'AiuxSidebar');
});

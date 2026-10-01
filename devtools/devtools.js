// Registers the "AIUX" DevTools panel and the Elements-panel sidebar.
chrome.devtools.panels.create('AIUX', '/icons/icon32.png', '/panel/panel.html');

chrome.devtools.panels.elements.createSidebarPane('AIUX Component', (pane) => {
  pane.setPage('/sidebar/sidebar.html');
  pane.setHeight('400px');
});

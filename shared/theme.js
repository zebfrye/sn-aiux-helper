/*
 * Applies the DevTools colour theme to this page and follows changes to it.
 */
(function () {
  'use strict';
  const panels = chrome.devtools.panels;
  const apply = (name) => document.body.classList.toggle('dark', name === 'dark');
  apply(panels.themeName);
  if (typeof panels.setThemeChangeHandler === 'function') panels.setThemeChangeHandler(apply);
})();

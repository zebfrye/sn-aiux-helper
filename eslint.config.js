export default [
  {
    ignores: ['node_modules/**', 'test-results/**']
  },
  {
    files: ['agent/**/*.js', 'shared/**/*.js', 'panel/**/*.js', 'sidebar/**/*.js', 'devtools/**/*.js', 'test/chrome-mock.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', chrome: 'readonly', location: 'readonly',
        HTMLElement: 'readonly', WeakRef: 'readonly', structuredClone: 'readonly', fetch: 'readonly',
        localStorage: 'readonly', setTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        XMLHttpRequest: 'readonly', URLSearchParams: 'readonly'
      }
    },
    rules: { 'no-unused-vars': ['error', { caughtErrors: 'none' }], 'no-undef': 'error' }
  },
  {
    files: ['test/**/*.mjs', 'scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { window: 'readonly', document: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly', console: 'readonly' }
    },
    rules: { 'no-unused-vars': ['error', { caughtErrors: 'none' }], 'no-undef': 'error' }
  }
];

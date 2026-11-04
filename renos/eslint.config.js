import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/dist-local/**', '**/dev-dist/**', '**/node_modules/**', 'data/**', 'e2e/fixtures/**', 'e2e/.artifacts/**', 'test-results/**', 'playwright-report/**', 'apps/web/public/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': ['warn', { allow: ['warn', 'error', 'log'] }],
    },
  },
  {
    // Diese Skripte führen Teile ihres Codes per Playwright im Browser aus.
    files: ['scripts/build-assets.mjs', 'e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Spiele-Hosts: laufen als Seite bzw. Service Worker im Browser, nicht in Node.
    files: ['apps/gamehost/**/*.js', 'apps/web/src/games/sandbox/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...globals.serviceworker, __RENOS_CONFIG__: 'readonly' } },
    // Bewusst ES5-nah geschrieben (läuft ohne Build-Schritt im Spiel): `var self = this` ist hier üblich.
    rules: { '@typescript-eslint/no-this-alias': 'off' },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': 'off',
    },
  },
);

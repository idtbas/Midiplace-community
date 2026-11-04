import { defineConfig } from '@playwright/test';

export const E2E_PORT = 4310;
export const E2E_GAME_PORT = 4311;

/**
 * Browser-End-to-End-Tests gegen den produktionsnahen Build:
 * Der App-Server liefert das gebaute Frontend und die API aus, Spiele kommen vom getrennten Game-Host.
 * Vorher bauen: `npm run build` (erledigt `npm run test:e2e`).
 */
export default defineConfig({
  testDir: 'e2e',
  testIgnore: ['local/**'],
  outputDir: 'test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    viewport: { width: 1180, height: 820 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node e2e/serve.mjs',
    url: `http://localhost:${E2E_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});

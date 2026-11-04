import { defineConfig } from '@playwright/test';

/**
 * End-to-End-Tests des lokalen Modus (RenOS ohne Server, wie auf GitHub Pages).
 * Vorher bauen: `npm run test:e2e:local` erledigt das.
 */
export default defineConfig({
  testDir: 'e2e/local',
  outputDir: 'test-results/local',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4320/renos/',
    viewport: { width: 1180, height: 820 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node e2e/local/serve-static.mjs',
    url: 'http://localhost:4320/renos/',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

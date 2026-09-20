import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: [
    'partner-after-sales.spec.mjs',
    'partner-auth-shell.spec.mjs',
    'partner-management.spec.mjs',
    'partner-portal.spec.mjs',
    'partner-replenishment-review.spec.mjs',
    'partner-replenishment-shipment.spec.mjs',
  ],
  fullyParallel: false,
  retries: 0,
  reporter: 'line',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5199',
    browserName: 'chromium',
    viewport: { width: 1024, height: 768 },
    hasTouch: true,
  },
  webServer: {
    command: `"${process.execPath}" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5199 --strictPort`,
    url: 'http://127.0.0.1:5199/tests/partner-replenishment-shipment-harness.html',
    reuseExistingServer: true,
    timeout: 30000,
  },
})

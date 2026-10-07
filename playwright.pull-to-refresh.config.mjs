import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: ['pull-to-refresh.spec.mjs', 'pull-to-refresh-native.spec.mjs'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5296',
    hasTouch: true,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mobile-webkit', testMatch: 'pull-to-refresh.spec.mjs', use: { browserName: 'webkit', viewport: { width: 390, height: 844 } } },
    { name: 'ipad-webkit', testMatch: 'pull-to-refresh.spec.mjs', use: { browserName: 'webkit', viewport: { width: 1366, height: 1024 } } },
    { name: 'native-touch-chromium', testMatch: 'pull-to-refresh-native.spec.mjs', use: { browserName: 'chromium', viewport: { width: 1366, height: 1024 } } },
  ],
  webServer: {
    command: `"${process.execPath}" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5296 --strictPort`,
    url: 'http://127.0.0.1:5296/tests/pull-to-refresh-harness.html',
    reuseExistingServer: false,
    timeout: 30000,
  },
})

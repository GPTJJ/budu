import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: ['pos-ipad.spec.mjs', 'order-records.spec.mjs', 'product-center.spec.mjs', 'mailing.spec.mjs', 'asset-center.spec.mjs', 'personnel.spec.mjs', 'home-workspace.spec.mjs', 'settings.spec.mjs', 'permissions.spec.mjs', 'employee-profile.spec.mjs'],
  fullyParallel: false,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5198',
    viewport: { width: 1024, height: 768 },
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  },
  projects: [{ name: 'ipad-webkit', use: { browserName: 'webkit' } }],
  webServer: {
    command: `"${process.execPath}" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5198 --strictPort`,
    url: 'http://127.0.0.1:5198/tests/pos-harness.html',
    reuseExistingServer: true,
    timeout: 30000,
  },
})

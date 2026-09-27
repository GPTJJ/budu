import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: ['brand-system.spec.mjs'],
  fullyParallel: false,
  retries: 0,
  reporter: 'line',
  projects: [{ name: 'webkit', use: { browserName: 'webkit' } }],
  webServer: {
    command: `"${process.execPath}" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5208 --strictPort`,
    url: 'http://127.0.0.1:5208/tests/brand-harness.html',
    reuseExistingServer: true,
    timeout: 30000,
  },
  use: { baseURL: 'http://127.0.0.1:5208' },
})

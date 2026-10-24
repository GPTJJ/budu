import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  testDir: '.', testMatch: 'offline-service.spec.mjs', fullyParallel: false, workers: 1, retries: 0, reporter: 'line',
  outputDir: fileURLToPath(new URL('../output/playwright/offline-service', import.meta.url)),
  use: { baseURL: 'http://127.0.0.1:5291', viewport: { width: 1024, height: 768 }, trace: 'retain-on-failure' },
  projects: [{ name: 'webkit', use: { browserName: 'webkit' } }, { name: 'chromium', use: { browserName: 'chromium', channel: 'chrome' } }],
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5291 --strictPort', url: 'http://127.0.0.1:5291/tests/offline-service-harness.html', reuseExistingServer: true, timeout: 30000, cwd: fileURLToPath(new URL('..', import.meta.url)) },
})

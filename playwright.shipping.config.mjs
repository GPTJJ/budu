import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests',
  testMatch: ['transfer.spec.mjs', 'partner-replenishment-shipment.spec.mjs', 'partner-management.spec.mjs', 'mailing.spec.mjs'],
  fullyParallel: false, workers: 1, retries: 0, reporter: 'line',
  outputDir: 'output/playwright/results',
  use: { baseURL: 'http://127.0.0.1:5199', viewport: { width: 1024, height: 768 }, hasTouch: true, screenshot: 'only-on-failure' },
  projects: [{ name: 'ipad-webkit', use: { browserName: 'webkit' } }, { name: 'desktop-chromium', use: { browserName: 'chromium' } }],
})

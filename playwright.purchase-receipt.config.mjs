import { defineConfig, devices } from '@playwright/test';
if (process.env.APP_ENV !== 'test' || process.env.TEST_DATABASE_URL !== 'postgresql://apple@127.0.0.1:55463/postgres') throw Error('Exact isolated Gate2 target required');
export default defineConfig({
  testDir: './tests',
  testMatch: 'purchase-receipt.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60000,
  reporter: [['line'], ['json', {
    outputFile: 'output/purchase-receipt/browser-results.json'
  }]],
  outputDir: 'output/playwright/purchase-receipt',
  use: {
    baseURL: 'http://127.0.0.1:5217',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [{
    name: 'desktop-chromium',
    use: {
      browserName: 'chromium',
      viewport: {
        width: 1440,
        height: 900
      }
    }
  }, {
    name: 'ipad-webkit',
    use: {
      ...devices['iPad (gen 7)'],
      browserName: 'webkit',
      viewport: {
        width: 1024,
        height: 768
      }
    }
  }, {
    name: 'mobile-webkit',
    use: {
      ...devices['iPhone 13'],
      browserName: 'webkit',
      viewport: {
        width: 390,
        height: 844
      }
    }
  }],
  webServer: {
    command: '"' + process.execPath + '" scripts/test-purchase-receipt-native.mjs --serve',
    url: 'http://127.0.0.1:5217/tests/purchase-receipt-harness.html',
    reuseExistingServer: false,
    gracefulShutdown: {signal: 'SIGTERM', timeout: 15000},
    timeout: 120000
  }
});

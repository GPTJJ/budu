import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium, webkit } from '@playwright/test'
import { createServer } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
await vite.listen()
const baseUrl = vite.resolvedUrls.local[0]
const browser = await chromium.launch({ headless: true })
const webkitBrowser = await webkit.launch({ headless: true })

after(async () => {
  await browser.close()
  await webkitBrowser.close()
  await vite.close()
})

async function openHarness(width = 375, browserInstance = browser, height = 812) {
  const page = await browserInstance.newPage({ viewport: { width, height } })
  await page.goto(`${baseUrl}tests/store-entry-integrity-harness.html`)
  await page.locator('select').selectOption('xidan')
  await page.locator('input[type=date]').fill('2026-08-24')
  const numbers = page.locator('input[type=number]')
  await assert.doesNotReject(() => numbers.nth(0).waitFor())
  await page.waitForFunction(() => {
    const fields = [...document.querySelectorAll('input[type=number]')]
    return fields[0]?.value === '12345.00' && fields[1]?.value === '37'
  })
  return page
}

const payload = (storeKey, date, incCents, ord, staff = []) => ({
  storeKey, date, salesDataSource: 'manual', salesDataStatus: 'synced', pos: null,
  entry: { id: `de-${storeKey}-${date}`, status: 'draft', version: 1, incCents: String(incCents), ord, hybridAdjustmentCents: '0' },
  staff,
})

test('historical authority survives the late shared-data refresh', async () => {
  const page = await openHarness()
  try {
    const requestCount = await page.evaluate(() => window.__storeEntryTimeline.length)
    await page.evaluate(() => window.__releaseSharedRefresh())
    await page.waitForTimeout(250)
    const values = await page.locator('input[type=number]').evaluateAll((fields) => fields.map((field) => field.value))
    assert.deepEqual(values.slice(0, 2), ['12345.00', '37'])
    assert.equal(await page.locator('span').filter({ hasText: /^陈文慧/ }).count(), 1)
    assert.equal(await page.evaluate(() => window.__writes.length), 0)
    assert.equal(await page.locator('input[type=date]').inputValue(), '2026-08-24')
    const refreshRequests = await page.evaluate((from) => window.__storeEntryTimeline.slice(from)
      .filter((event) => event.event === 'request' && event.path.includes('/daily-entry/overview'))
      .map((event) => event.path), requestCount)
    assert.ok(refreshRequests.length >= 1)
    assert.ok(refreshRequests.every((path) => path.includes('store=xidan') && path.includes('date=2026-08-24')))
  } finally {
    await page.close()
  }
})

test('late empty response cannot replace an already newer exact-date authority', async () => {
  const page = await openHarness()
  try {
    await page.evaluate((correct) => {
      window.__setOverviewPlan('xidan', '2026-08-24', [
        { delay: 160, payload: { storeKey: 'xidan', date: '2026-08-24', salesDataSource: 'manual', salesDataStatus: 'waiting_input', entry: null, pos: null, staff: [] } },
        { delay: 10, payload: correct },
      ])
      window.__releaseSharedRefresh()
    }, payload('xidan', '2026-08-24', 777700, 19))
    await page.waitForTimeout(5)
    await page.evaluate(() => window.__triggerSharedRefresh())
    await page.waitForTimeout(220)
    const values = await page.locator('input[type=number]').evaluateAll((fields) => fields.map((field) => field.value))
    const timeline = await page.evaluate(() => window.__storeEntryTimeline)
    assert.deepEqual(values.slice(0, 2), ['12345.00', '37'], JSON.stringify(timeline))
  } finally {
    await page.close()
  }
})

test('rapid date switching keeps only the final composite authority', async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  try {
    await page.goto(`${baseUrl}tests/store-entry-integrity-harness.html`)
    await page.locator('select').selectOption('xidan')
    await page.evaluate(([a, b, c]) => {
      window.__setOverviewPlan('xidan', '2026-08-22', [{ delay: 180, payload: a }])
      window.__setOverviewPlan('xidan', '2026-08-23', [{ delay: 120, payload: b }])
      window.__setOverviewPlan('xidan', '2026-08-24', [{ delay: 15, payload: c }])
    }, [
      payload('xidan', '2026-08-22', 111100, 11),
      payload('xidan', '2026-08-23', 222200, 22),
      payload('xidan', '2026-08-24', 333300, 33),
    ])
    const date = page.locator('input[type=date]')
    await date.fill('2026-08-22')
    await date.fill('2026-08-23')
    await date.fill('2026-08-24')
    await page.waitForTimeout(240)
    assert.equal(await date.inputValue(), '2026-08-24')
    const values = await page.locator('input[type=number]').evaluateAll((fields) => fields.map((field) => field.value))
    assert.deepEqual(values.slice(0, 2), ['3333.00', '33'])
  } finally {
    await page.close()
  }
})

test('rapid store switching keeps only the final store/date authority', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  try {
    await page.goto(`${baseUrl}tests/store-entry-integrity-harness.html`)
    await page.locator('input[type=date]').fill('2026-08-24')
    await page.evaluate(([xidan, tongying, chaowai]) => {
      window.__setOverviewPlan('xidan', '2026-08-24', [{ delay: 180, payload: xidan }])
      window.__setOverviewPlan('tongying', '2026-08-24', [{ delay: 120, payload: tongying }])
      window.__setOverviewPlan('chaowai', '2026-08-24', [{ delay: 15, payload: chaowai }])
    }, [
      payload('xidan', '2026-08-24', 111100, 11),
      payload('tongying', '2026-08-24', 222200, 22),
      payload('chaowai', '2026-08-24', 444400, 44),
    ])
    const store = page.locator('select')
    await store.selectOption('xidan')
    await store.selectOption('tongying')
    await store.selectOption('chaowai')
    await page.waitForTimeout(240)
    assert.equal(await store.inputValue(), 'chaowai')
    const values = await page.locator('input[type=number]').evaluateAll((fields) => fields.map((field) => field.value))
    assert.deepEqual(values.slice(0, 2), ['4444.00', '44'])
  } finally {
    await page.close()
  }
})

test('dirty manual form survives background refresh without a write', async () => {
  const page = await openHarness()
  try {
    const revenue = page.locator('input[type=number]').nth(0)
    await revenue.fill('999.99')
    await page.evaluate(() => window.__releaseSharedRefresh())
    await page.waitForTimeout(180)
    assert.equal(await revenue.inputValue(), '999.99')
    await page.getByText('当前未保存编辑已保留').waitFor()
    assert.equal(await page.evaluate(() => window.__writes.length), 0)
  } finally {
    await page.close()
  }
})

test('REAL_ZERO stays distinguishable from loading and failed authority', async () => {
  const page = await browser.newPage({ viewport: { width: 340, height: 760 } })
  try {
    await page.goto(`${baseUrl}tests/store-entry-integrity-harness.html`)
    await page.locator('select').selectOption('xidan')
    await page.evaluate((zero) => window.__setOverviewPlan('xidan', '2026-08-20', [{ delay: 80, payload: zero }]), payload('xidan', '2026-08-20', 0, 0))
    await page.locator('input[type=date]').fill('2026-08-20')
    await page.getByText('正在加载…').waitFor()
    assert.equal(await page.getByRole('button', { name: '保存营业数据' }).count(), 0)
    await page.waitForTimeout(110)
    const values = await page.locator('input[type=number]').evaluateAll((fields) => fields.map((field) => field.value))
    assert.deepEqual(values.slice(0, 2), ['0.00', '0'])
    assert.equal(await page.getByRole('button', { name: '保存营业数据' }).isEnabled(), true)

    await page.evaluate(() => window.__setOverviewPlan('xidan', '2026-08-21', [{ status: 503, payload: { error: 'fixture unavailable' } }]))
    await page.locator('input[type=date]').fill('2026-08-21')
    await page.getByText(/不会以 0 或空值代替/).waitFor()
    assert.equal(await page.getByRole('button', { name: '保存营业数据' }).count(), 0)
  } finally {
    await page.close()
  }
})

for (const width of [320, 340, 375, 390, 430]) {
  test(`mobile candidate selector is bounded and readable at ${width}px`, async () => {
    const page = await openHarness(width)
    try {
      await page.getByRole('button', { name: /已选 1 人/ }).click()
      const panel = page.getByTestId('staff-candidate-panel')
      await panel.waitFor()
      const metrics = await page.evaluate(() => ({
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        panel: (() => {
          const rect = document.querySelector('[data-testid="staff-candidate-panel"]').getBoundingClientRect()
          return { left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width }
        })(),
      }))
      assert.ok(metrics.documentOverflow <= 0)
      assert.ok(metrics.panel.left >= 0 && metrics.panel.right <= width)
      await page.getByText('陈文慧', { exact: true }).waitFor()
      assert.equal(await page.getByText('同名员工', { exact: true }).count(), 2)
      await page.getByText('运营替代·不计工资', { exact: true }).waitFor()
      const badgeStyle = await page.getByText('运营替代·不计工资', { exact: true }).evaluate((node) => getComputedStyle(node).whiteSpace)
      assert.equal(badgeStyle, 'nowrap')
    } finally {
      await page.close()
    }
  })
}

for (const [label, width, height] of [['iPad portrait', 768, 1024], ['desktop', 1440, 900]]) {
  test(`${label} candidate selector regression`, async () => {
    const page = await openHarness(width, browser, height)
    try {
      await page.getByRole('button', { name: /已选 1 人/ }).click()
      const panel = page.getByTestId('staff-candidate-panel')
      await panel.waitFor()
      const metrics = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        panelOverflow: (() => {
          const node = document.querySelector('[data-testid="staff-candidate-panel"]')
          return node.scrollWidth - node.clientWidth
        })(),
      }))
      assert.ok(metrics.overflow <= 0)
      assert.ok(metrics.panelOverflow <= 0)
      await page.getByPlaceholder('搜索员工姓名').fill('陈文慧')
      assert.equal(await panel.getByText('陈文慧', { exact: true }).count(), 1)
      assert.equal(await panel.getByText('同名员工', { exact: true }).count(), 0)
    } finally {
      await page.close()
    }
  })
}

test('WebKit mobile and iPad selector stay bounded', async () => {
  for (const [width, height] of [[390, 844], [768, 1024]]) {
    const page = await openHarness(width, webkitBrowser, height)
    try {
      await page.getByRole('button', { name: /已选 1 人/ }).click()
      const panel = page.getByTestId('staff-candidate-panel')
      await panel.waitFor()
      const metrics = await page.evaluate(() => {
        const rect = document.querySelector('[data-testid="staff-candidate-panel"]').getBoundingClientRect()
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          left: rect.left,
          right: rect.right,
          viewport: document.documentElement.clientWidth,
        }
      })
      assert.ok(metrics.overflow <= 0)
      assert.ok(metrics.left >= 0 && metrics.right <= metrics.viewport)
    } finally {
      await page.close()
    }
  }
})

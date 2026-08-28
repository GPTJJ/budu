import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium, webkit } from '@playwright/test'
import { createServer } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePerformanceDutyStaff } from '../src/utils/storeEntryParticipantDisplay.js'

const employeeDirectory = [
  { id: 'emp-ma', name: '马婧欣' },
  { id: 'emp-renamed', name: '新名字' },
  { id: 'emp-same-a', name: '王某' },
  { id: 'emp-same-b', name: '王某' },
]

const resolve = ({ rows, legacy = [], loaded = true, date = '2026-08-24' }) => resolvePerformanceDutyStaff({
  monthRows: rows,
  monthLoaded: loaded,
  storeKey: 'chaowai',
  date,
  legacyStaffNames: legacy,
  employeeDirectory,
})

test('8/24 chaowai DSS overrides empty DailyEntry.staffNames', () => {
  const result = resolve({ rows: [{ id: 'dss-ma', storeKey: 'chaowai', date: '2026-08-24', employeeId: 'emp-ma', participantType: 'EMPLOYEE', staffName: '旧快照', actualHours: 11.5, payableHoursSource: 'ACTUAL_HOURS' }] })
  assert.equal(result.source, 'dss')
  assert.deepEqual(result.participants.map((row) => row.label), ['马婧欣'])
})

test('DSS stable identity wins over conflicting legacy staffNames', () => {
  const result = resolve({ rows: [{ id: 'dss-renamed', storeKey: 'chaowai', date: '2026-08-24', employeeId: 'emp-renamed', participantType: 'EMPLOYEE', staffName: '旧快照' }], legacy: ['旧名字'] })
  assert.deepEqual(result.participants.map((row) => row.label), ['新名字'])
  assert.equal(result.participants.some((row) => row.label === '旧名字'), false)
})

test('legacy staffNames is display-only fallback when exact store/date has no DSS', () => {
  const result = resolve({ rows: [], legacy: ['历史姓名'] })
  assert.equal(result.source, 'legacy')
  assert.deepEqual(result.participants.map((row) => row.label), ['历史姓名'])
  assert.equal(result.participants[0].stableId, '')
})

test('unloaded DSS authority never falls back to a possibly stale legacy name', () => {
  const result = resolve({ rows: [], legacy: ['旧名字'], loaded: false })
  assert.equal(result.source, 'unresolved')
  assert.deepEqual(result.participants, [])
})

test('multiple Employee and substitute participants retain stable independent identities', () => {
  const result = resolve({ rows: [
    { id: 'dss-ma', storeKey: 'chaowai', date: '2026-08-24', employeeId: 'emp-ma', participantType: 'EMPLOYEE', staffName: '马婧欣' },
    { id: 'dss-sub', storeKey: 'chaowai', date: '2026-08-24', participantUserId: 'user-sub', participantType: 'NON_EMPLOYEE_SUBSTITUTE', staffName: '卡皮巴拉' },
  ] })
  assert.deepEqual(result.participants.map((row) => [row.label, row.identityType, row.stableId]), [
    ['马婧欣', 'EMPLOYEE', 'emp-ma'],
    ['卡皮巴拉', 'NON_EMPLOYEE_SUBSTITUTE', 'user-sub'],
  ])
})

test('same-name Employees remain two stable participant entities', () => {
  const result = resolve({ rows: [
    { id: 'dss-same-a', storeKey: 'chaowai', date: '2026-08-24', employeeId: 'emp-same-a', participantType: 'EMPLOYEE', staffName: '王某' },
    { id: 'dss-same-b', storeKey: 'chaowai', date: '2026-08-24', employeeId: 'emp-same-b', participantType: 'EMPLOYEE', staffName: '王某' },
  ] })
  assert.equal(result.participants.length, 2)
  assert.deepEqual(new Set(result.participants.map((row) => row.key)), new Set(['EMPLOYEE:emp-same-a', 'EMPLOYEE:emp-same-b']))
})

test('historical LEGACY_PAYROLL_HOURS row still displays participant identity without attendance wording', () => {
  const result = resolve({ rows: [{ id: 'dss-legacy', storeKey: 'chaowai', date: '2026-08-24', employeeId: 'emp-ma', participantType: 'EMPLOYEE', staffName: '马婧欣', historicalPayrollHours: 11.5, payableHoursSource: 'LEGACY_PAYROLL_HOURS' }] })
  assert.deepEqual(result.participants.map((row) => row.label), ['马婧欣'])
  assert.equal(result.participants[0].payableHoursSource, 'LEGACY_PAYROLL_HOURS')
})

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
  await page.goto(`${baseUrl}tests/store-entry-performance-detail-harness.html`)
  await page.locator('select').selectOption('chaowai')
  await page.locator('input[type=date]').fill('2026-08-24')
  await page.getByTestId('performance-duty-staff-2026-08-24').getByText('马婧欣', { exact: true }).waitFor()
  return page
}

test('chaowai 8/24 list and exact-date detail agree after background refresh with zero writes', async () => {
  const page = await openHarness()
  try {
    const list = page.getByTestId('performance-duty-staff-2026-08-24')
    assert.equal(await list.getByText('马婧欣', { exact: true }).count(), 1)
    assert.deepEqual(await page.getByTestId('performance-duty-staff-2026-08-22').locator('[data-participant-key]').allTextContents(), ['历史姓名'])
    assert.deepEqual(await page.getByTestId('performance-duty-staff-2026-08-21').locator('[data-participant-key]').allTextContents(), ['新名字'])
    assert.deepEqual(await page.getByTestId('performance-duty-staff-2026-08-20').locator('[data-participant-key]').allTextContents(), ['马婧欣'])
    await page.locator('span').filter({ hasText: /^马婧欣/ }).filter({ hasText: /11\.5h/ }).waitFor()
    await page.evaluate(() => window.__triggerSharedRefresh())
    await page.waitForTimeout(300)
    assert.equal(await list.getByText('马婧欣', { exact: true }).count(), 1)
    assert.equal(await page.evaluate(() => window.__writes.length), 0)
    assert.equal(await page.getByText('¥223.00', { exact: true }).count() > 0, true)
    assert.equal(await page.getByText('2', { exact: true }).count() > 0, true)
  } finally {
    await page.close()
  }
})

for (const width of [320, 340, 375, 390, 430]) {
  test(`performance duty names remain readable without document overflow at ${width}px`, async () => {
    const page = await openHarness(width)
    try {
      const metrics = await page.evaluate(() => {
        const target = document.querySelector('[data-testid="performance-duty-staff-2026-08-24"]')
        const rect = target.getBoundingClientRect()
        return {
          documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          targetWidth: rect.width,
          targetHeight: rect.height,
          names: [...target.querySelectorAll('[data-participant-key]')].map((node) => ({
            text: node.textContent,
            width: node.getBoundingClientRect().width,
            height: node.getBoundingClientRect().height,
          })),
        }
      })
      assert.ok(metrics.documentOverflow <= 0)
      assert.ok(metrics.targetWidth > 0 && metrics.targetHeight > 0)
      assert.deepEqual(metrics.names.map((row) => row.text), ['马婧欣'])
      assert.ok(metrics.names.every((row) => row.width > 0 && row.height > 0))
      const multiple = page.getByTestId('performance-duty-staff-2026-08-23').locator('[data-participant-key]')
      assert.deepEqual(await multiple.allTextContents(), ['王某', '王某', '卡皮巴拉'])
      assert.equal(new Set(await multiple.evaluateAll((nodes) => nodes.map((node) => node.dataset.participantKey))).size, 3)
    } finally {
      await page.close()
    }
  })
}

for (const [label, width, height] of [['iPad portrait', 768, 1024], ['desktop', 1440, 900]]) {
  test(`${label} performance detail regression`, async () => {
    const page = await openHarness(width, browser, height)
    try {
      assert.equal(await page.getByTestId('performance-duty-staff-2026-08-24').getByText('马婧欣', { exact: true }).count(), 1)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    } finally {
      await page.close()
    }
  })
}

test('WebKit mobile and iPad performance detail stay stable', async () => {
  for (const [width, height] of [[390, 844], [768, 1024]]) {
    const page = await openHarness(width, webkitBrowser, height)
    try {
      assert.equal(await page.getByTestId('performance-duty-staff-2026-08-24').getByText('马婧欣', { exact: true }).count(), 1)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    } finally {
      await page.close()
    }
  }
})

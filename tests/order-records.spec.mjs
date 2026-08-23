import { expect, test } from '@playwright/test'
import * as XLSX from 'xlsx'

test('订单记录页展示列表、筛选、明细与导出', async ({ page }) => {
  await page.goto('/tests/order-records-harness.html')
  const today = await page.evaluate(() => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
    return `${values.year}-${values.month}-${values.day}`
  })
  await expect(page.getByLabel('开始日期')).toHaveValue(today)
  await expect(page.getByLabel('结束日期')).toHaveValue(today)
  await expect.poll(() => page.evaluate(() => window.__lastOrderQuery)).toMatchObject({ from: today, to: today })
  await expect(page.getByText('共 3 笔订单', { exact: true })).toBeVisible()
  const summary = page.getByRole('region', { name: '订单汇总' })
  await expect(summary.getByText('¥254.00', { exact: true })).toBeVisible()
  await expect(summary.getByText('3 笔', { exact: true })).toBeVisible()
  await expect(summary.getByText('4 件', { exact: true })).toBeVisible()
  await expect(summary.getByText('¥127.00', { exact: true })).toBeVisible()
  await expect(page.getByText('POS-TEST-ORDER-001', { exact: true })).toBeVisible()
  await expect(page.getByText('POS-TEST-ORDER-002', { exact: true })).toBeVisible()

  await page.getByLabel('支付方式').selectOption('cash')
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await expect(page.getByText('共 1 笔订单', { exact: true })).toBeVisible()
  await expect(page.getByText('POS-TEST-ORDER-001', { exact: true })).toBeVisible()
  await expect(page.getByText('POS-TEST-ORDER-002', { exact: true })).toHaveCount(0)

  await page.getByLabel('开始日期').fill('2026-08-01')
  await page.getByLabel('结束日期').fill('2026-08-15')
  await expect.poll(() => page.evaluate(() => window.__lastOrderQuery)).toMatchObject({ from: '2026-08-01', to: '2026-08-15' })

  await page.getByRole('button', { name: /明细/ }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('卡皮巴拉布丁', { exact: true })).toBeVisible()
  await expect(dialog.getByText('PAY-TEST-1', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 Excel', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/budu订单记录_.+\.xlsx/)
  const stream = await download.createReadStream()
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  const wb = XLSX.read(Buffer.concat(chunks), { type: 'buffer' })
  expect(wb.SheetNames).toEqual(['订单列表', '商品明细'])
  const orderSheet = XLSX.utils.sheet_to_json(wb.Sheets['订单列表'], { header: 1 })
  expect(orderSheet[0]).toContain('商品明细')
  expect(orderSheet.some((row) => row.includes('卡皮巴拉布丁×1'))).toBe(true)
  const itemSheet = XLSX.utils.sheet_to_json(wb.Sheets['商品明细'], { header: 1 })
  expect(itemSheet[0]).toEqual(['订单号', '商品名称', 'SKU', '单价（元）', '数量', '小计（元）'])
  expect(itemSheet.some((row) => row.includes('卡皮巴拉布丁'))).toBe(true)
})

test('开发者可删除订单，删除后列表刷新', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept())
  await page.goto('/tests/order-records-harness.html?deletable=1')
  await expect(page.getByText('共 3 笔订单', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '删除 POS-TEST-ORDER-002' }).click()
  await expect(page.getByText('共 2 笔订单', { exact: true })).toBeVisible()
  await expect(page.getByText('POS-TEST-ORDER-001', { exact: true })).toBeVisible()
  await expect(page.getByText('POS-TEST-ORDER-002', { exact: true })).toHaveCount(0)
})

test('整单退款后订单变为已退款', async ({ page }) => {
  await page.goto('/tests/order-records-harness.html')
  await page.getByRole('button', { name: /退款 POS-TEST-ORDER-001/ }).click()
  const dialog = page.getByRole('dialog', { name: '订单退款' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('整单退款', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '确认退款', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('row').filter({ hasText: 'POS-TEST-ORDER-001' }).getByText('已退款', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /退款 POS-TEST-ORDER-001/ })).toHaveCount(0)
  await page.getByRole('button', { name: /明细/ }).first().click()
  await expect(page.getByRole('dialog', { name: '订单明细' }).getByText('退款记录', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog', { name: '订单明细' }).getByText(/卡皮巴拉布丁×1/)).toBeVisible()
})

test('部分退款按商品退指定数量', async ({ page }) => {
  await page.goto('/tests/order-records-harness.html')
  await page.getByRole('button', { name: /退款 POS-TEST-ORDER-003/ }).click()
  const dialog = page.getByRole('dialog', { name: '订单退款' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '部分退款', exact: true }).click()
  const puddingRow = dialog.locator('tr').filter({ hasText: '卡皮巴拉布丁' })
  await puddingRow.locator('input').fill('1')
  await expect(dialog.locator('tfoot').getByText('¥72.00', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '确认退款', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('row').filter({ hasText: 'POS-TEST-ORDER-003' }).getByText('部分退款', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /明细/ }).last().click()
  const detail = page.getByRole('dialog', { name: '订单明细' })
  await expect(detail.getByText('退款记录', { exact: true })).toBeVisible()
  await expect(detail.getByText(/卡皮巴拉布丁×1/)).toBeVisible()
})

test('微信支付订单支持部分退款，待支付订单显示去支付', async ({ page }) => {
  await page.goto('/tests/order-records-harness.html')
  await expect(page.getByRole('button', { name: /退款 POS-TEST-ORDER-003/ })).toBeVisible()
  const payButton = page.getByRole('button', { name: /去支付 POS-TEST-ORDER-002/ })
  await expect(payButton).toBeVisible()
  await payButton.click()
  await expect.poll(() => page.evaluate(() => window.__payOrder)).toEqual({ id: 'order-2', orderNo: 'POS-TEST-ORDER-002' })
})

test('手机底部导航包含 POS点单并可跳转', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/tests/mobile-nav-harness.html')
  const nav = page.getByRole('navigation', { name: '手机快捷导航' })
  await expect(nav).toBeVisible()
  const glassStyle = await nav.locator('.mobile-liquid-nav__glass').evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      backdropFilter: style.backdropFilter || style.webkitBackdropFilter,
      borderRadius: style.borderRadius,
      position: getComputedStyle(element.closest('nav')).position,
      bottom: element.closest('nav').getBoundingClientRect().bottom,
      viewportHeight: window.innerHeight,
    }
  })
  expect(glassStyle.backdropFilter).toContain('blur')
  expect(Number.parseFloat(glassStyle.borderRadius)).toBeGreaterThanOrEqual(24)
  expect(glassStyle.position).toBe('fixed')
  expect(Math.abs(glassStyle.bottom - glassStyle.viewportHeight)).toBeLessThanOrEqual(1)
  await expect(page.getByRole('button', { name: '首页', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('button', { name: 'POS点单', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'POS点单', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__navigated)).toEqual(['store-pos'])
})

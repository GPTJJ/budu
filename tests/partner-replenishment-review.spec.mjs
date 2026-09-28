import { expect, test } from '@playwright/test'

async function openReview(page) {
  await page.goto('/tests/partner-replenishment-review-harness.html')
  await expect(page.getByRole('heading', { name: '补货订单' })).toBeVisible()
  await page.getByRole('button', { name: /RPL-20260907/ }).click()
  await expect(page.getByRole('dialog', { name: /审核补货单/ })).toBeVisible()
}

test('审核队列展示 Partner、门店、申请金额、来源与动态排班权限', async ({ page }) => {
  await page.goto('/tests/partner-replenishment-review-harness.html')
  await expect(page.getByText('官舍今日值班')).toBeVisible()
  await expect(page.getByText('秦皇岛合作商 · 秦皇岛一店')).toBeVisible()
  await expect(page.getByText('¥1495.00')).toBeVisible()
  await expect(page.getByRole('button', { name: '待发货' })).toBeVisible()
})

test('审核详情在 draft 中增减/移除并仅提交 item identity、数量和可见原因', async ({ page }) => {
  await openReview(page)
  const dialog = page.getByRole('dialog', { name: /审核补货单/ })
  await expect(dialog.getByText('原申请：').first()).toBeVisible()
  await expect(dialog.getByText('冻结基价 ¥180.00/KG')).toBeVisible()
  await dialog.getByLabel('KG 糖确认数量').fill('8000')
  await dialog.getByLabel('KG 糖调整说明').fill('确认 8kg')
  await dialog.getByLabel('颗糖确认数量').fill('0')
  await dialog.getByLabel('颗糖调整说明').fill('本次不发')
  await dialog.getByText('整单审核说明 / 驳回原因').locator('textarea').fill('按本次备货计划确认')
  await expect(dialog.getByText('¥936.00').last()).toBeVisible()
  await dialog.getByRole('button', { name: '确认审核' }).click()
  await expect.poll(() => page.evaluate(() => window.__partnerReviewTest.requests.find(row => row.type === 'approve'))).toMatchObject({
    body: {
      version: 1,
      reason: '按本次备货计划确认',
      items: [
        { itemId: 'kg-line', approvedQuantityBase: 8000, reason: '确认 8kg' },
        { itemId: 'pcs-line', approvedQuantityBase: 0, reason: '本次不发' },
      ],
    },
  })
  const submitted = await page.evaluate(() => window.__partnerReviewTest.requests.find(row => row.type === 'approve'))
  expect(submitted.idempotencyKey).toMatch(/^review-[0-9a-f-]{36}$/)
  expect(JSON.stringify(submitted.body)).not.toMatch(/price|discount|total|orderUnit|inventoryItemId/i)
})

test('整单驳回要求并提交合作商可见原因', async ({ page }) => {
  await openReview(page)
  const dialog = page.getByRole('dialog', { name: /审核补货单/ })
  await expect(dialog.getByRole('button', { name: '整单驳回' })).toBeDisabled()
  await dialog.getByText('整单审核说明 / 驳回原因').locator('textarea').fill('本次无法安排供货')
  await dialog.getByRole('button', { name: '整单驳回' }).click()
  await expect.poll(() => page.evaluate(() => window.__partnerReviewTest.requests.find(row => row.type === 'reject')?.body)).toEqual({ version: 1, reason: '本次无法安排供货' })
})

for (const width of [320, 340, 375, 390, 430]) {
  test(`${width}px 审核列表与确认 Sheet 无横向溢出且操作区可见`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 })
    await openReview(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    const dialog = page.getByRole('dialog', { name: /审核补货单/ })
    await expect(dialog.getByRole('button', { name: '确认审核' })).toBeVisible()
    const box = await dialog.boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1)
  })
}

test('申请日期、合作商、门店和状态筛选与分页、全量导出使用相同参数', async ({ page }) => {
  await page.goto('/tests/partner-replenishment-review-harness.html')
  await page.getByLabel('申请开始日期').fill('2026-09-01')
  await page.getByLabel('申请结束日期').fill('2026-09-30')
  await page.getByLabel('合作商筛选').selectOption('partner-a')
  await expect(page.getByLabel('合作商门店筛选').locator('option')).toHaveCount(2)
  await page.getByLabel('合作商门店筛选').selectOption('store-a')
  await page.getByRole('button', { name: '部分发货', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__partnerReviewTest.requests.filter(row => row.type === 'list').at(-1)?.query)).toMatchObject({ startDate: '2026-09-01', endDate: '2026-09-30', partnerId: 'partner-a', partnerStoreId: 'store-a', status: 'PARTIALLY_SHIPPED', page: '1' })
  await page.getByRole('button', { name: '下一页' }).click()
  await expect(page.getByText('第 2 页')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__partnerReviewTest.requests.filter(row => row.type === 'list').at(-1)?.query.page)).toBe('2')
  await page.getByRole('button', { name: '导出 Excel' }).click()
  await expect.poll(() => page.evaluate(() => window.__partnerReviewTest.requests.find(row => row.type === 'export')?.query)).toMatchObject({ startDate: '2026-09-01', endDate: '2026-09-30', partnerId: 'partner-a', partnerStoreId: 'store-a', status: 'PARTIALLY_SHIPPED' })
})

test('图片长图只绘制原申请字段，商品增多时完整增加高度', async ({ page }) => {
  await page.goto('/tests/partner-replenishment-review-harness.html')
  const result = await page.evaluate(async () => {
    const { createReplenishmentImage } = await import('/src/utils/replenishmentExport.js')
    const order = { ...window.__partnerReviewTest.order, items: Array.from({ length: 80 }, (_, index) => ({ ...window.__partnerReviewTest.order.items[0], productNameSnapshot: `商品${index + 1}号长名称测试` })) }
    const texts = []
    const original = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (value, ...args) { texts.push(String(value)); return original.call(this, value, ...args) }
    try {
      const canvas = await createReplenishmentImage(order)
      return { texts, width: canvas.width, height: canvas.height, png: canvas.toDataURL('image/png').startsWith('data:image/png;base64,') }
    } finally { CanvasRenderingContext2D.prototype.fillText = original }
  })
  expect(result.png).toBe(true)
  expect(result.height).toBeGreaterThan(result.width * 5)
  expect(result.texts).toContain('商品80号长名称测试')
  expect(result.texts).toContain('商品名称')
  expect(result.texts).toContain('申请数量')
  expect(result.texts).toContain('已发数量')
  expect(result.texts.join('|')).toContain('申请时间：')
  expect(result.texts.join('|')).not.toMatch(/状态|待发|单价|小计|金额|审核|发货统计|本次发货/)
})

test('订单详情一键导出图片生成 PNG', async ({ page }) => {
  await openReview(page)
  await page.evaluate(() => {
    window.__exportedPng = false
    const original = HTMLCanvasElement.prototype.toDataURL
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      const result = original.apply(this, args)
      window.__exportedPng = result.startsWith('data:image/png;base64,')
      return result
    }
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false })
    window.open = () => null
  })
  await page.getByRole('dialog', { name: /审核补货单/ }).getByRole('button', { name: '导出图片' }).click()
  await expect.poll(() => page.evaluate(() => window.__exportedPng)).toBe(true)
})

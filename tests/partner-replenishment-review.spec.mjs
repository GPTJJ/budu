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

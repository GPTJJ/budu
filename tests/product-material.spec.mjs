import { expect, test } from '@playwright/test'

test('物料管理只读取物料权威且不再承载产品或分类管理', async ({ page }) => {
  await page.goto('/tests/product-material-harness.html')
  await expect(page.getByRole('heading', { name: '物料管理' })).toBeVisible()
  await expect(page.getByText('冰袋', { exact: true })).toBeVisible()
  await expect(page.getByText('商品中心', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '分类管理' })).toHaveCount(0)
  const requests = await page.evaluate(() => window.__productMaterialTest.requests)
  expect(requests[0]).toMatchObject({ method: 'GET', path: '/api/v2/transfer-master-items?category=material' })
})

test('物料支持新增、编辑、排序和启停且无物理删除', async ({ page }) => {
  await page.goto('/tests/product-material-harness.html')
  await expect(page.locator('[data-master-item-id="m-used"]')).toContainText('已用于历史调拨/采购 · 仅可停用')
  await expect(page.getByRole('button', { name: /删除/ })).toHaveCount(0)
  await page.getByRole('button', { name: '新增物料' }).click()
  await page.getByLabel('物料名称').fill('新物料')
  await page.getByLabel('排序').fill('8')
  await page.getByRole('button', { name: '保存' }).click()
  const row = page.locator('[data-master-item-id="new-2"]')
  await expect(row).toContainText('新物料')
  await page.getByRole('button', { name: '编辑新物料' }).click()
  await page.getByLabel('物料名称').fill('新物料箱')
  await page.getByLabel('排序').fill('2')
  await page.getByRole('button', { name: '保存' }).click()
  await expect(row).toContainText('新物料箱')
  await expect(row).toContainText('排序 2')
  await row.getByRole('button', { name: '停用' }).click()
  await expect(row).toContainText('已停用')
})

for (const width of [320, 340, 375, 390, 430]) {
  test(`${width}px 物料管理无横向滚动`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/tests/product-material-harness.html')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  })
}

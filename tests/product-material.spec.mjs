import { expect, test } from '@playwright/test'

test('产品 Tab 支持新增、编辑、排序与停用', async ({ page }) => {
  await page.goto('/tests/product-material-harness.html')
  await expect(page.getByRole('tab', { name: '产品' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: '新增产品' }).click()
  await page.getByLabel('产品编号').fill('NO.13')
  await page.getByLabel('产品名称').fill('NO.13测试产品')
  await page.getByLabel('排序').fill('13')
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('NO.13测试产品', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '编辑NO.13测试产品' }).click()
  await page.getByLabel('产品编号').fill('NO.13A')
  await page.getByLabel('产品名称').fill('NO.13测试产品改')
  await page.getByLabel('排序').fill('2')
  await page.getByRole('button', { name: '保存' }).click()
  const card = page.locator('[data-master-item-id="new-3"]')
  await expect(card).toContainText('编号 NO.13A · 排序 2')
  await card.getByRole('button', { name: '停用' }).click()
  await expect(card).toContainText('已停用')
})

test('物料 Tab 支持新增、编辑与启停，历史使用项没有删除入口', async ({ page }) => {
  await page.goto('/tests/product-material-harness.html')
  await page.getByRole('tab', { name: '物料' }).click()
  await expect(page.locator('[data-master-item-id="m-used"]')).toContainText('已用于历史调拨/采购 · 仅可停用')
  await expect(page.getByRole('button', { name: /删除/ })).toHaveCount(0)
  await page.getByRole('button', { name: '新增物料' }).click()
  await page.getByLabel('物料名称').fill('新物料')
  await page.getByLabel('排序').fill('8')
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('新物料', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '编辑新物料' }).click()
  await page.getByLabel('物料名称').fill('新物料改')
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('新物料改', { exact: true })).toBeVisible()
})

test('320/340/375/390/430px 管理页面无横向滚动', async ({ page }) => {
  for (const width of [320, 340, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/tests/product-material-harness.html')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  }
})

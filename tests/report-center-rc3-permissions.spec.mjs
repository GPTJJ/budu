import { expect, test } from '@playwright/test'

for (const width of [320, 340, 375, 390, 430]) {
  test(`RC-3 report capability projection remains usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 })
    await page.goto('/tests/account-admin-harness.html')
    await page.getByRole('button', { name: '功能授权' }).click()
    await expect(page.getByText('Report Center 销售数据权限（候选功能）')).toBeVisible()
    const view = page.getByLabel('允许查看销售报表')
    const allStores = page.getByLabel('允许查看全部门店（否则仅限账号绑定门店）')
    await expect(allStores).toBeDisabled()
    await view.check()
    await expect(allStores).toBeEnabled()
    await allStores.check()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    expect(overflow).toBe(false)
  })
}

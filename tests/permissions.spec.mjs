import { expect, test } from '@playwright/test'

test('移动端快捷入口按账号版块授权实时裁剪', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/tests/mobile-nav-harness.html?limited=1')
  await expect(page.getByRole('button', { name: '排班' })).toBeVisible()
  await expect(page.getByRole('button', { name: '首页' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '录入' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'POS点单' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '打开全部功能' })).toBeVisible()
})

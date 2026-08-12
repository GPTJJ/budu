import { expect, test } from '@playwright/test'

test('企业资产中心渲染概览、分类、卡片与到期状态', async ({ page }) => {
  const logs = []
  page.on('console', (m) => { if (m.type() === 'error') logs.push(`[console] ${m.text()}`) })
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  await page.goto('/tests/asset-harness.html')
  await page.waitForTimeout(1000)
  if (logs.length) console.log('ASSET_LOGS:', logs.join('\n'))
  await expect(page.getByText('企业资产中心', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('文件总数', { exact: true })).toBeVisible()
  await expect(page.getByText('营业执照-通盈店', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('30天内到期', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('企业证照', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('到期提醒', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /深色|浅色/ }).click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await expect(page.locator('div.dark')).toHaveCount(1)
})

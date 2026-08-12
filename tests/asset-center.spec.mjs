import { expect, test } from '@playwright/test'

test('budu档案馆渲染概览、分类、卡片与到期状态', async ({ page }) => {
  const logs = []
  page.on('console', (m) => { if (m.type() === 'error') logs.push(`[console] ${m.text()}`) })
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  await page.goto('/tests/asset-harness.html')
  await page.waitForTimeout(1000)
  if (logs.length) console.log('ASSET_LOGS:', logs.join('\n'))
  await expect(page.getByText('budu档案馆', { exact: true }).first()).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('文件总数', { exact: true })).toBeVisible()
  await expect(page.getByText('营业执照-通盈店', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('30天内到期', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('企业证照', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('新店签约', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('产品质检', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('到期提醒', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /管理分类/ })).toHaveCount(1)
  await expect(page.getByRole('button', { name: /管理分类/ })).toBeVisible()
})

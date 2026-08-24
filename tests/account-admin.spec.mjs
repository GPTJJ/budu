// 账号管理绑定员工下拉 E2E：只显示所选固定门店员工
import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/account-admin-harness.html')
  await page.getByRole('button', { name: '新增账号' }).click()
  await page.waitForTimeout(500)
  // 选择角色 = 员工
  await page.locator('select').first().selectOption('staff')
  await page.waitForTimeout(300)
})

test('勾选朝外店后绑定下拉包含马婧欣（档案门店 chaowai）', async ({ page }) => {
  // 勾选「北京朝外店」门店 checkbox（按钮组）
  await page.locator('button', { hasText: '北京朝外店' }).first().click()
  await page.waitForTimeout(500)
  const opts = await page.locator('select').nth(1).locator('option').allInnerTexts()
  expect(opts.join('|')).toContain('马婧欣（北京朝外店）')
  expect(opts.join('|')).toContain('史璐璐（北京朝外店）')
})

test('已删除的多店支援员工不会重新出现在绑定列表', async ({ page }) => {
  // 勾选「北京朝外店」
  await page.locator('button', { hasText: '北京朝外店' }).first().click()
  await page.waitForTimeout(500)
  const opts = await page.locator('select').nth(1).locator('option').allInnerTexts()
  expect(opts.join('|')).not.toContain('陈荣梅')
  expect(opts.join('|')).not.toContain('多店支援')
})

test('未勾选门店时绑定下拉只有占位', async ({ page }) => {
  const opts = await page.locator('select').nth(1).locator('option').allInnerTexts()
  expect(opts.join('|')).toBe('请选择员工')
})

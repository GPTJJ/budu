// 排班页优化 E2E：默认全门店视图、绑定员工高亮、员工只读
import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/schedule-harness.html?mode=developer')
  await expect(page.locator('body')).toContainText('门店排班')
})

test('默认显示所有门店排班详情（全部门店视图）', async ({ page }) => {
  // 两个门店的周排班表都应渲染（每个门店一个卡片）
  await expect(page.getByText('北京通盈中心店').first()).toBeVisible()
  await expect(page.getByText('北京官舍店').first()).toBeVisible()
  // 两个门店的班次都可见
  await expect(page.getByText('叶芷辰', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('龚艺锦', { exact: true }).first()).toBeVisible()
  // 「全部门店」tab 默认选中
  await expect(page.getByRole('button', { name: '全部门店' })).toBeVisible()
})

test('单店视图可切换', async ({ page }) => {
  await page.getByRole('button', { name: '北京通盈中心店' }).first().click()
  // 单店视图只显示一个周排班表
  await expect(page.getByText('北京通盈中心店').first()).toBeVisible()
  // 通盈中心店有排班：叶芷辰可见
  await expect(page.getByText('叶芷辰', { exact: true }).first()).toBeVisible()
})

test('绑定员工查看时当班名字高亮（含「我」徽标）', async ({ page }) => {
  await page.goto('/tests/schedule-harness.html?mode=staff')
  await expect(page.locator('body')).toContainText('门店排班')
  // 叶芷辰（tongying 店）排班项高亮：amber 背景 + 「我」徽标
  const myBadge = page.getByText('我', { exact: true })
  await expect(myBadge.first()).toBeVisible()
  // 叶芷辰有两个班次（周二早班/周四通班）各带「我」徽标；非本人（龚艺锦）无徽标
  await expect(page.getByText('我', { exact: true })).toHaveCount(2)
  const gongCard = page.locator('div.rounded-xl.p-2.shadow-sm').filter({ hasText: '龚艺锦' })
  await expect(gongCard.getByText('我', { exact: true })).toHaveCount(0)
})

test('员工只有查看权限：无添加/删除按钮，只读模式提示', async ({ page }) => {
  await page.goto('/tests/schedule-harness.html?mode=staff')
  await expect(page.locator('body')).toContainText('门店排班')
  await expect(page.getByText('只读模式').first()).toBeVisible()
  await expect(page.getByRole('button', { name: '添加排班' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '删除' })).toHaveCount(0)
})

test('开发者可添加排班（全部门店视图下弹窗显示对应门店）', async ({ page }) => {
  await page.getByRole('button', { name: '添加排班' }).first().click()
  await expect(page.getByText('添加员工排班')).toBeVisible()
  // 弹窗副标题含对应门店名（第一个添加按钮属于第一家门店 tongying）
  await expect(page.getByText(/添加员工排班/)).toBeVisible()
  await expect(page.getByText(/· 北京通盈中心店 ·/)).toBeVisible()
})

test('经理保持可编辑权限', async ({ page }) => {
  await page.goto('/tests/schedule-harness.html?mode=manager')
  await expect(page.locator('body')).toContainText('门店排班')
  await expect(page.getByRole('button', { name: '添加排班' }).first()).toBeVisible()
  await expect(page.getByText('只读模式')).toHaveCount(0)
})

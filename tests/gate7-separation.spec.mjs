import { expect, test } from '@playwright/test'

test('Gate 7 G: 历史-only payroll 员工不出现在当前人员目录', async ({ page }) => {
  await page.goto('/tests/gate7-separation-harness.html')
  // 当前目录：张伟×2（PG 员工）；王五只存在于历史业绩快照，不得渲染为员工卡片
  await expect(page.getByText('张伟', { exact: true })).toHaveCount(2)
  await expect(page.getByText('王五', { exact: true })).toHaveCount(0)
  // 目录计数只含当前 PG 员工
  await expect(page.getByRole('button', { name: '全部（2）' })).toBeVisible()
})

test('Gate 7 H: 当前目录每张员工卡片均有 Employee.id（无 name-only 卡片）', async ({ page }) => {
  await page.goto('/tests/gate7-separation-harness.html')
  const cards = page.locator('.card').filter({ hasText: '张伟' })
  await expect(cards).toHaveCount(2)
  // 卡片可操作（删除按钮存在）→ 必须有 id 才能发起定向离职
  for (let i = 0; i < 2; i += 1) {
    await expect(cards.nth(i).getByRole('button', { name: '删除该员工' })).toBeVisible()
  }
})

test('Gate 7 I: 删除只走 /status-change（按 id），绝不触发全量名单 PUT', async ({ page }) => {
  await page.goto('/tests/gate7-separation-harness.html')
  const cards = page.locator('.card').filter({ hasText: '张伟' })
  await expect(cards).toHaveCount(2)
  const guansheCard = cards.filter({ hasText: '北京官舍店' }).first()
  await guansheCard.getByRole('button', { name: '删除该员工' }).click()
  await page.getByRole('button', { name: '确认删除' }).click()
  await page.getByPlaceholder('请输入二级密码').fill('test-pass')
  await page.getByRole('button', { name: '确认删除' }).click()
  await expect.poll(() => page.evaluate(() => window.__resignCalls.length)).toBe(1)
  const resignCalls = await page.evaluate(() => window.__resignCalls)
  expect(resignCalls[0].url).toContain('/api/v2/employees/emp-A/status-change')
  expect(resignCalls[0].body.action).toBe('RESIGN')
  // 未触发 legacy 全量名单 PUT（removeStaff 路径被移除）
  const puts = await page.evaluate(() => window.__staffListPuts)
  expect(puts).toBe(0)
})

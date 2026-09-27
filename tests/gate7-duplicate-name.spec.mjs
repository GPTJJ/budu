import { expect, test } from '@playwright/test'

const STAFF = [
  { id: 'emp-A', name: '张伟', storeKey: 'guanshe', storeName: '北京官舍店', type: 'fulltime', employeeNo: 'BUDU-0101' },
  { id: 'emp-B', name: '张伟', storeKey: 'chaowai', storeName: '北京朝外店', type: 'parttime', employeeNo: 'BUDU-0102' },
]

test('Gate 7 A: 跨店同名员工各自渲染为独立卡片（React key 不碰撞）', async ({ page }) => {
  await page.goto('/tests/gate7-duplicate-name-harness.html')
  // 两张同名卡片同时存在
  await expect(page.getByText('张伟', { exact: true })).toHaveCount(2)
  // 各自显示门店与员工编号，可区分
  await expect(page.getByText('北京官舍店', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('北京朝外店', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('BUDU-0101', { exact: true })).toBeVisible()
  await expect(page.getByText('BUDU-0102', { exact: true })).toBeVisible()
  // 计数：全部 2（全职 1 / 兼职 1）
  await expect(page.getByRole('button', { name: '全部（2）' })).toBeVisible()
  await expect(page.getByRole('button', { name: '全职人员（1）' })).toBeVisible()
  await expect(page.getByRole('button', { name: '兼职人员（1）' })).toBeVisible()
})

test('Gate 7 C: 删除指定卡片只对目标 Employee.id 发起离职', async ({ page }) => {
  await page.goto('/tests/gate7-duplicate-name-harness.html')
  const cards = page.locator('.card').filter({ hasText: '张伟' })
  await expect(cards).toHaveCount(2)
  // 点击第一张卡片（官舍 emp-A）的删除按钮
  const guansheCard = cards.filter({ hasText: '北京官舍店' }).first()
  await guansheCard.getByRole('button', { name: '删除该员工' }).click()
  await page.getByRole('button', { name: '确认删除' }).click()
  // 二级密码弹窗（开发者删除需要）：mock 已放行，输入任意密码提交
  await page.getByPlaceholder('请输入二级密码').fill('test-pass')
  await page.getByRole('button', { name: '确认删除' }).click()
  await expect.poll(() => page.evaluate(() => window.__resignCalls.length)).toBe(1)
  const resignCalls = await page.evaluate(() => window.__resignCalls)
  expect(resignCalls[0].url).toContain('/api/v2/employees/emp-A/status-change')
  expect(resignCalls[0].body.action).toBe('RESIGN')
  // 离职成功后 emp-A 卡片消失、emp-B 仍在（本地缓存按 id 移除）
  await expect(page.locator('.card').filter({ hasText: '张伟' })).toHaveCount(1)
  await expect(page.locator('.card').filter({ hasText: '北京朝外店' }).first()).toBeVisible()
})

test('Gate 7 D: 档案导航携带正确 Employee.id', async ({ page }) => {
  await page.goto('/tests/gate7-duplicate-name-harness.html')
  const cards = page.locator('.card').filter({ hasText: '张伟' })
  await expect(cards).toHaveCount(2)
  // 点朝外店（emp-B）卡片的档案按钮
  const chaowaiCard = cards.filter({ hasText: '北京朝外店' }).first()
  await chaowaiCard.getByRole('button', { name: '员工档案' }).click()
  const opened = await page.evaluate(() => window.__openedProfile)
  expect(opened.name).toBe('张伟')
  expect(opened.id).toBe('emp-B')
})

test('Gate 7 B/E: 同店同名员工各自渲染（React key 用 Employee.id 不碰撞）', async ({ page }) => {
  await page.goto('/tests/gate7-duplicate-name-harness.html?sameStore=1')
  await expect(page.getByText('李娜', { exact: true })).toHaveCount(2)
  await expect(page.getByText('BUDU-0201', { exact: true })).toBeVisible()
  await expect(page.getByText('BUDU-0202', { exact: true })).toBeVisible()
  // 同店同名两人均渲染为独立卡片（React key=id，无替换/折叠）
  await expect(page.locator('.card').filter({ hasText: '李娜' })).toHaveCount(2)
  await expect(page.getByRole('button', { name: '全部（2）' })).toBeVisible()
})

import { expect, test } from '@playwright/test'

test('Gate 24 A/B: 同店同名两卡各自显示独立金额（EMPLOYEE_ID 模式按 id join）', async ({ page }) => {
  await page.goto('/tests/gate24-payroll-display-harness.html')
  // 稳定计算徽标出现（resolver EMPLOYEE_ID 模式）
  await expect(page.getByText('稳定计算', { exact: true })).toBeVisible()
  const cards = page.locator('.card').filter({ hasText: '张伟' })
  await expect(cards).toHaveCount(2)
  // 两人 share=2，各 6000 营业额分摊：工资应相同且 > 0（同一公式）
  // 断言两卡各有一个非零最终工资
  const amounts = []
  for (let i = 0; i < 2; i += 1) {
    const card = cards.nth(i)
    await expect(card.getByText('最终工资', { exact: true })).toBeVisible()
    const text = await card.innerText()
    const m = text.match(/最终工资\s*¥([\d,]+\.\d{2})/)
    expect(m).toBeTruthy()
    amounts.push(Number(m[1].replace(/,/g, '')))
  }
  expect(amounts[0]).toBeGreaterThan(0)
  expect(amounts[1]).toBeGreaterThan(0)
  // 两人同店同日 share=2 → 金额相等（独立但同值）
  expect(Math.abs(amounts[0] - amounts[1])).toBeLessThan(0.01)
  // 无"身份模糊"标记（EMPLOYEE_ID 模式）
  await expect(page.getByText('身份模糊', { exact: true })).toHaveCount(0)
  // EMPLOYEE_ID 模式的真实金额仍以 ¥ 显示（不是「—」）
  await expect(cards.first().getByText(/^¥/)).not.toHaveCount(0)
})

test('Gate 24 D: LEGACY 重名模式显示身份模糊且不给精确金额', async ({ page }) => {
  await page.goto('/tests/gate24-payroll-display-harness.html?legacy=1')
  await expect(page.getByText('兼容计算', { exact: true })).toBeVisible()
  const cards = page.locator('.card').filter({ hasText: '张伟' })
  await expect(cards).toHaveCount(2)
  await expect(page.getByText('身份模糊', { exact: true })).toHaveCount(2)
  // 无法归属时保持 fail closed，不渲染任何精确工资值。
  await expect(cards.first().getByText('暂无工资数据', { exact: true })).toBeVisible()
  await expect(cards.first().getByText('¥0.00', { exact: true })).toHaveCount(0)
})

test('Gate 24 F/G/H: 月份切换与缓存回访', async ({ page }) => {
  await page.goto('/tests/gate24-payroll-display-harness.html')
  // 初始 2026-08 稳定（resolver EMPLOYEE_ID 驱动）
  await expect(page.getByText('稳定计算', { exact: true })).toBeVisible()
  // 竞态安全由 requestedMonthRef 保证（Gate 24 实现）；此处验证缓存回访：
  // 切走再切回（通过 CalendarPicker 年月按钮组），稳定计算徽标恢复
  // CalendarPicker 用「◀ 2026年08月 ▶」结构，按钮文本含月份
  // 打开日历（页面右上角「2026年08月」按钮）
  await page.getByRole('button', { name: /2026年08月/ }).first().click()
  // 日历面板内的月份翻页按钮（chevron 图标，无文本）——用 svg 图标定位
  const chevrons = page.locator('button svg.lucide-chevron-left, button svg.lucide-chevron-right')
  // 上一月
  await page.locator('button:has(svg.lucide-chevron-left)').first().click()
  await page.waitForTimeout(500)
  // 下一月（回到 8 月）
  await page.locator('button:has(svg.lucide-chevron-right)').first().click()
  await page.waitForTimeout(500)
  await page.locator('body').click({ position: { x: 10, y: 10 } }).catch(() => {})
  await expect(page.getByText('稳定计算', { exact: true })).toBeVisible()
  await expect(page.getByText('人员管理', { exact: true }).first()).toBeVisible()
})

test('Daily Entry V2 regression: business incomplete is employee-scoped, not a technical load error', async ({ page }) => {
  await page.goto('/tests/gate24-payroll-display-harness.html?partial=1')
  await expect(page.getByText('稳定计算', { exact: true })).toBeVisible()
  await expect(page.getByText('部分工资待完善', { exact: true })).toBeVisible()
  const readyCard = page.locator('.card').filter({ hasText: 'A001' })
  const incompleteCard = page.locator('.card').filter({ hasText: 'B001' })
  await expect(readyCard.getByText('最终工资', { exact: true })).toBeVisible()
  await expect(incompleteCard.getByText('工资数据待完善', { exact: true })).toBeVisible()
  await expect(incompleteCard.getByText(/2026-08-02.*北京官舍店.*缺少每日记录/)).toBeVisible()
  await expect(page.getByText('工资数据暂不可用', { exact: true })).toHaveCount(0)
  await expect(incompleteCard.getByRole('button', { name: '重新加载' })).toHaveCount(0)
})

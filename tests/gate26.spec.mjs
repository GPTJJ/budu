import { expect, test } from '@playwright/test'

const cell = (t, i) => (t.split('\t')[i] || '').trim()

test('Gate 26 N: 仅调整月 Personnel 卡片按 Employee.id 显示（同名独立）', async ({ page }) => {
  await page.goto('/tests/gate26-personnel-harness.html')
  await expect(page.getByText('稳定计算', { exact: true })).toBeVisible()
  const cards = page.locator('.card').filter({ hasText: '张伟' })
  await expect(cards).toHaveCount(2)
  const texts = await cards.allInnerTexts()
  const a = texts.find((t) => t.includes('A001'))
  const b = texts.find((t) => t.includes('B001'))
  expect(a).toBeTruthy()
  expect(b).toBeTruthy()
  // 无考勤月：emp-A +500、emp-B -50（调整仅日贡献到达各自 Employee.id 卡）
  expect(a).toContain('¥500.00')
  expect(b).toContain('¥-50.00')
  // 出勤 0 天（不虚构考勤）
  expect(a).toContain('出勤 0 天')
  expect(b).toContain('出勤 0 天')
  // 工资调整标签出现（adjustmentCount > 0）
  expect(a).toContain('工资调整')
  expect(b).toContain('工资调整')
})

test('Gate 26 K: 导出明细 = 考勤 ∪ 调整（调整独占行 工时0/原因正确/不重复）', async ({ page }) => {
  await page.goto('/tests/gate26-export-harness.html')
  await page.getByRole('button', { name: '预览' }).click()
  await expect(page.getByText('稳定计算', { exact: true }).first()).toBeVisible()
  const headers = await page.locator('thead th').allInnerTexts()
  const idx = {
    date: headers.indexOf('日期'),
    no: headers.indexOf('员工编号'),
    hours: headers.indexOf('计薪工时(h)'),
    auto: headers.indexOf('自动工资(元)'),
    adj: headers.indexOf('薪资调整(元)'),
    final: headers.indexOf('最终工资(元)'),
    reason: headers.indexOf('调整原因'),
  }
  expect(idx.date).toBeGreaterThan(-1)
  expect(idx.reason).toBeGreaterThan(-1)
  const rows = page.locator('tbody tr')
  await expect(rows).toHaveCount(4) // A08-01 / B08-01 / A08-10 / B08-10
  const texts = await rows.allInnerTexts()
  const by = (date, no) => texts.find((t) => cell(t, idx.date) === date && cell(t, idx.no) === no)
  // 调整独占行（08-10 无考勤）：工时 0、自动 0、调整/最终 = 各自调整额、原因正确、身份 employeeId
  const a10 = by('2026-08-10', 'A001')
  const b10 = by('2026-08-10', 'B001')
  expect(a10).toBeTruthy()
  expect(b10).toBeTruthy()
  expect(Number(cell(a10, idx.hours))).toBe(0)
  expect(Number(cell(a10, idx.auto))).toBe(0)
  expect(Number(cell(a10, idx.adj))).toBe(500)
  expect(Number(cell(a10, idx.final))).toBe(500)
  expect(cell(a10, idx.reason)).toBe('A 仅调整日 +500')
  expect(Number(cell(b10, idx.hours))).toBe(0)
  expect(Number(cell(b10, idx.adj))).toBe(-50)
  expect(Number(cell(b10, idx.final))).toBe(-50)
  expect(cell(b10, idx.reason)).toBe('B 仅调整日 -50')
  // 考勤日 08-01：每人恰好 1 行（A 携带考勤日调整，不产生重复调整独占行）
  const a01rows = texts.filter((t) => cell(t, idx.date) === '2026-08-01' && cell(t, idx.no) === 'A001')
  const b01rows = texts.filter((t) => cell(t, idx.date) === '2026-08-01' && cell(t, idx.no) === 'B001')
  expect(a01rows.length).toBe(1)
  expect(b01rows.length).toBe(1)
  expect(Number(cell(a01rows[0], idx.hours))).toBe(8)
  expect(Number(cell(b01rows[0], idx.hours))).toBe(6)
  expect(cell(a01rows[0], idx.reason)).toBe('A 考勤日调整 100')
  expect(cell(b01rows[0], idx.reason)).toBe('')
})

test('Gate 26 J/L: 导出汇总含调整仅日贡献，与明细逐位对账（无遗漏无重复）', async ({ page }) => {
  await page.goto('/tests/gate26-export-harness.html')
  await page.getByRole('button', { name: '预览' }).click()
  await expect(page.getByText('稳定计算', { exact: true }).first()).toBeVisible()
  // 明细（默认 tab）：等 4 行渲染完成后读表头与数据
  const headers = await page.locator('thead th').allInnerTexts()
  const dIdx = { date: headers.indexOf('日期'), no: headers.indexOf('员工编号'), final: headers.indexOf('最终工资(元)') }
  expect(dIdx.final).toBeGreaterThan(-1)
  const rows = page.locator('tbody tr')
  await expect(rows).toHaveCount(4)
  const texts = await rows.allInnerTexts()
  const by = (date, no) => texts.find((t) => cell(t, dIdx.date) === date && cell(t, dIdx.no) === no)
  const finalA01 = Number(cell(by('2026-08-01', 'A001'), dIdx.final)) // 考勤日调整后 = 100
  const finalA10 = Number(cell(by('2026-08-10', 'A001'), dIdx.final)) // 仅调整日 = 500
  expect(finalA01).toBe(100)
  expect(finalA10).toBe(500)
  // 切到汇总
  await page.getByRole('button', { name: /薪酬汇总/ }).click()
  const srows = page.locator('tbody tr')
  await expect(srows).toHaveCount(2)
  const stexts = await srows.allInnerTexts()
  const h2 = await page.locator('thead th').allInnerTexts()
  const sIdx = { no: h2.indexOf('员工编号'), auto: h2.indexOf('自动工资(元)'), adj: h2.indexOf('薪资调整(元)'), salary: h2.indexOf('工资合计(元)') }
  const a = stexts.find((t) => cell(t, sIdx.no) === 'A001')
  const b = stexts.find((t) => cell(t, sIdx.no) === 'B001')
  // A：两个调整日（考勤日 100 + 仅调整日 500）→ 汇总工资 = 明细最终工资之和（逐位一致）
  expect(Number(cell(a, sIdx.salary))).toBe(600)
  expect(Number(cell(a, sIdx.salary))).toBe(finalA01 + finalA10)
  // 汇总内部自洽：工资 = 自动工资 + 薪资调整（A/B）
  expect(Number(cell(a, sIdx.salary))).toBe(Number(cell(a, sIdx.auto)) + Number(cell(a, sIdx.adj)))
  expect(Number(cell(b, sIdx.salary))).toBe(Number(cell(b, sIdx.auto)) + Number(cell(b, sIdx.adj)))
  // B：仅调整日 -50 已进入汇总（薪资调整列 = -50，B 无考勤日调整）
  expect(Number(cell(b, sIdx.adj))).toBe(-50)
  // A：薪资调整 = 考勤日差额 + 仅调整日 500（恰好一次，无重复：差额部分为负）
  expect(Number(cell(a, sIdx.adj)) - 500).toBeLessThan(0)
})

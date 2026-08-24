import { expect, test } from '@playwright/test'

test('Gate 25 A/B: 稳定导出同店同名两行 + 稳定计算徽标', async ({ page }) => {
  await page.goto('/tests/gate25-export-harness.html')
  await expect(page.getByText('导出表格', { exact: true })).toBeVisible()
  // 员工选择：两个张伟独立可选（employeeNo 区分）
  await expect(page.getByText('A001', { exact: true })).toBeVisible()
  await expect(page.getByText('B001', { exact: true })).toBeVisible()
  // 预览
  await page.getByRole('button', { name: '预览' }).click()
  await expect(page.getByText('稳定计算', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: /薪酬汇总/ }).click()
  // 汇总两行（张伟×2 各自行）
  const rows = page.locator('tbody tr')
  await expect(rows).toHaveCount(2)
  const texts = await rows.allInnerTexts()
  expect(texts.filter((t) => t.includes('A001')).length).toBe(1)
  expect(texts.filter((t) => t.includes('B001')).length).toBe(1)
  // 金额列存在且为数字（工资合计非空）
  for (const t of texts) {
    const cells = t.split('\t')
    expect(cells[cells.length - 1].trim()).toMatch(/\d/)
  }
})

test('Gate 25 E: LEGACY 重名导出阻断（受控消息）', async ({ page }) => {
  await page.goto('/tests/gate25-export-harness.html?legacy=1')
  await expect(page.getByText('导出表格', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '预览' }).click()
  await expect(page.getByText(/存在同名员工的历史兼容工资/)).toBeVisible()
})

test('Gate 25 F: 明细页含员工编号列', async ({ page }) => {
  await page.goto('/tests/gate25-export-harness.html')
  await page.getByRole('button', { name: '预览' }).click()
  await expect(page.getByRole('cell', { name: '员工编号' })).toBeVisible()
})

test('Gate 25 H: 明细工时按 employeeId 独立（emp-A 8h / emp-B 6h）', async ({ page }) => {
  await page.goto('/tests/gate25-export-harness.html?hours=diff')
  await page.getByRole('button', { name: '预览' }).click()
  await expect(page.getByText('稳定计算', { exact: true }).first()).toBeVisible()
  // 定位「工时(h)」列索引（明细默认 tab）
  const headers = await page.locator('thead th').allInnerTexts()
  const hIdx = headers.indexOf('工时(h)')
  expect(hIdx).toBeGreaterThan(-1)
  const rows = page.locator('tbody tr')
  await expect(rows).toHaveCount(2)
  const texts = await rows.allInnerTexts()
  const cell = (t, i) => (t.split('\t')[i] || '').trim()
  const a = texts.find((t) => t.includes('A001'))
  const b = texts.find((t) => t.includes('B001'))
  expect(Number(cell(a, hIdx))).toBe(8)
  expect(Number(cell(b, hIdx))).toBe(6)
})

import { expect, test } from '@playwright/test'
import * as XLSX from 'xlsx'

test('员工卡片工资明细下载为可读取的 Excel 表格', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/tests/personnel-harness.html')
  const employeeCard = page.locator('.card').filter({ hasText: '叶芷辰' }).first()
  await expect(employeeCard).toBeVisible()
  await employeeCard.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/叶芷辰 · 当月每日工资明细/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: '导出 Excel', exact: true })).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await dialog.getByRole('button', { name: '导出 Excel', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^工资明细-叶芷辰-202608\.xlsx$/)

  const stream = await download.createReadStream()
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  const workbook = XLSX.read(Buffer.concat(chunks), { type: 'buffer' })
  expect(workbook.SheetNames).toEqual(['工资明细'])
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['工资明细'], { header: 1, raw: true })
  expect(rows[0][0]).toBe('BUDU 员工工资明细')
  expect(rows[1][1]).toBe('叶芷辰')
  expect(rows[4]).toEqual(['日期', '值班门店', '营业额(元)', '订单', '工时(h)', '基础工资(元)', '业绩提成(元)', '大单奖(元)', '当日工资(元)'])
  expect(rows.some((row) => row[0] === '09' && row[1] === '北京通盈中心店' && row[8] === 540)).toBe(true)
})

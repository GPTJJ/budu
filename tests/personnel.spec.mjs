import { expect, test } from '@playwright/test'
import * as XLSX from 'xlsx'

test('雇员页面恢复既有全职与兼职主档', async ({ page }) => {
  await page.goto('/tests/personnel-harness.html')
  await expect(page.getByRole('button', { name: '全部（10）' })).toBeVisible()
  await expect(page.getByRole('button', { name: '全职人员（3）' })).toBeVisible()
  await expect(page.getByRole('button', { name: '兼职人员（7）' })).toBeVisible()
  for (const name of ['隋晓', '叶芷辰', '李飞燕', '左可翠', '陈文慧', '舒敏', '史璐璐', '马婧欣', '龚艺锦', '王红云']) {
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible()
  }
})

test('员工卡片工资明细下载为可读取的 Excel 表格', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/tests/personnel-harness.html')
  const employeeCard = page.locator('.card').filter({ hasText: '叶芷辰' }).first()
  await expect(employeeCard).toBeVisible()
  await expect(employeeCard.getByText('薪资调整')).toBeVisible()
  await expect(employeeCard.getByRole('button', { name: '调整每日薪资' })).toBeVisible()
  await employeeCard.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/叶芷辰 · 当月每日工资明细/)).toBeVisible()
  await expect(dialog.getByText('临时加班补偿')).toBeVisible()
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
  expect(rows[4]).toEqual(['日期', '值班门店', '营业额(元)', '订单', '工时(h)', '基础工资(元)', '业绩提成(元)', '调货补贴(元)', '大单奖(元)', '自动工资(元)', '薪资调整(元)', '调整原因', '最终工资(元)'])
  expect(rows.some((row) => row[0] === '09' && row[1] === '北京通盈中心店' && row[9] === 540 && row[10] === 20 && row[11] === '临时加班补偿' && row[12] === 560)).toBe(true)
})

test('开发者可调整每日最终工资并提交审计明细', async ({ page }) => {
  let submitted = null
  await page.route('**/api/v2/daily-pay-adjustments', async (route) => {
    submitted = route.request().postDataJSON()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        adjustment: {
          id: 'dpa-test',
          staffName: '叶芷辰',
          date: '2026-08-09',
          autoPayCentsSnapshot: '54000',
          adjustedPayCents: '57000',
          reason: '闭店加班补偿',
          createdBy: 'developer',
          updatedBy: 'developer',
          createdAt: '2026-08-10T01:00:00.000Z',
          updatedAt: '2026-08-13T15:00:00.000Z',
          version: 2,
        },
      }),
    })
  })

  await page.goto('/tests/personnel-harness.html')
  const employeeCard = page.locator('.card').filter({ hasText: '叶芷辰' }).first()
  await employeeCard.getByRole('button', { name: '调整每日薪资' }).click()
  const dialog = page.getByRole('dialog', { name: '调整每日薪资' })
  await expect(dialog).toBeVisible()
  await dialog.locator('input[type="date"]').fill('2026-08-09')
  await expect(dialog.getByText('当前人工调整明细')).toBeVisible()
  await dialog.locator('input[type="number"]').fill('570')
  await dialog.locator('textarea').fill('闭店加班补偿')
  await dialog.getByRole('button', { name: '更新调整' }).click()

  await expect(dialog.getByText('当日工资已调整并生效')).toBeVisible()
  expect(submitted).toEqual({
    staffName: '叶芷辰',
    date: '2026-08-09',
    autoPayCentsSnapshot: 54000,
    adjustedPayCents: 57000,
    reason: '闭店加班补偿',
    version: 1,
  })
})

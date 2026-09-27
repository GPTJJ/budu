import { expect, test } from '@playwright/test'

const open = (page, scenario) => page.goto(`/tests/payroll-completeness-ux-harness.html?scenario=${scenario}`)

test('today missing DailyEntry is a neutral pending business state', async ({ page }) => {
  await open(page, 'today-missing')
  await expect(page.getByText('今日数据待确认', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('北京官舍店今日门店录入尚未完成', { exact: true })).toBeVisible()
  await expect(page.getByText('工资数据暂不可用', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '重新加载' })).toHaveCount(0)
  await expect(page.locator('[data-payroll-completeness-state="TODAY_PENDING"]')).toBeVisible()
})

test('today draft is pending and remains fail closed', async ({ page }) => {
  await open(page, 'today-draft')
  await expect(page.getByText('北京官舍店今日录入尚未最终确认', { exact: true })).toBeVisible()
  await expect(page.getByText('最终工资', { exact: true })).toHaveCount(0)
  await expect(page.locator('[data-payroll-completeness-state="TODAY_PENDING"]')).toBeVisible()
})

test('today confirmed and complete renders normal payroll', async ({ page }) => {
  await open(page, 'today-confirmed')
  await expect(page.getByText('最终工资', { exact: true })).toBeVisible()
  await expect(page.getByText('今日数据待确认', { exact: true })).toHaveCount(0)
  await expect(page.getByText('工资数据待完善', { exact: true })).toHaveCount(0)
})

test('today missing actualHours is a business pending state and stays fail closed', async ({ page }) => {
  await open(page, 'today-hours')
  await expect(page.getByText('今日工时待确认', { exact: true })).toBeVisible()
  await expect(page.getByText('北京官舍店今日实际工时尚未完善', { exact: true })).toBeVisible()
  await expect(page.getByText('最终工资', { exact: true })).toHaveCount(0)
  await expect(page.getByText('工资数据暂不可用', { exact: true })).toHaveCount(0)
})

test('past missing DailyEntry remains a warning', async ({ page }) => {
  await open(page, 'past-missing')
  await expect(page.getByText('工资数据待完善', { exact: true })).toBeVisible()
  await expect(page.getByText('8月30日 北京官舍店缺少每日记录', { exact: true })).toBeVisible()
  await expect(page.locator('[data-payroll-completeness-state="DATA_INCOMPLETE"]')).toBeVisible()
})

test('past missing actualHours remains a historical warning', async ({ page }) => {
  await open(page, 'past-hours')
  await expect(page.getByText('工资数据待完善', { exact: true })).toBeVisible()
  await expect(page.getByText('8月30日 北京官舍店实际工时待完善', { exact: true })).toBeVisible()
  await expect(page.getByText('工资数据暂不可用', { exact: true })).toHaveCount(0)
})

test('future missing day is excluded from incomplete warning', async ({ page }) => {
  await open(page, 'future')
  await expect(page.getByText('最终工资', { exact: true })).toBeVisible()
  await expect(page.getByText('工资数据待完善', { exact: true })).toHaveCount(0)
  await expect(page.getByText('今日数据待确认', { exact: true })).toHaveCount(0)
})

test('technical failure remains separate with retry', async ({ page }) => {
  await open(page, 'technical-error')
  await expect(page.getByText('工资数据暂不可用', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '重新加载' }).first()).toBeVisible()
  await expect(page.getByText('今日数据待确认', { exact: true })).toHaveCount(0)
})

for (const width of [320, 340, 375, 390, 430]) {
  test(`mobile ${width}px keeps completeness card within viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await open(page, 'today-missing')
    await expect(page.locator('[data-payroll-completeness-state="TODAY_PENDING"]')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  })
}

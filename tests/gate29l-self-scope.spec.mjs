import { expect, test } from '@playwright/test'

async function selectDate(page, date) {
  await page.getByRole('button', { name: /2026年08月/ }).first().click()
  await page.getByRole('textbox', { name: '快速选择日期' }).fill(date)
}

test('Gate 29L self A: monthly/day/week/explanation never renders same-name B', async ({ page }) => {
  await page.goto('/tests/gate29f-personnel-harness.html?self=A')
  await expect(page.locator('.card').filter({ hasText: 'A001' })).toHaveCount(1)
  await expect(page.locator('.card').filter({ hasText: 'B001' })).toHaveCount(0)

  await selectDate(page, '2026-08-10')
  let cardA = page.locator('.card').filter({ hasText: 'A001' })
  await expect(cardA).toContainText('¥264.00')
  await expect(cardA).toContainText('工时 8h')
  await expect(page.getByText('¥198.00', { exact: true })).toHaveCount(0)
  await cardA.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('¥264.00')
  await dialog.getByRole('button', { name: '查看详情', exact: true }).click()
  await expect(dialog).toContainText('2人')
  await expect(dialog).not.toContainText('¥198.00')
  await expect(dialog).not.toContainText('6h')
  await dialog.locator('button').first().click()

  await page.getByRole('button', { name: /2026年08月 · 08-10/ }).click()
  await page.getByRole('button', { name: '查看整周' }).click()
  cardA = page.locator('.card').filter({ hasText: 'A001' })
  await expect(cardA).toContainText('周工资')
  await expect(cardA).toContainText('¥264.00')
  await expect(page.locator('.card').filter({ hasText: 'B001' })).toHaveCount(0)
})

test('Gate 29L self B sees B only', async ({ page }) => {
  await page.goto('/tests/gate29f-personnel-harness.html?self=B')
  await selectDate(page, '2026-08-10')
  await expect(page.locator('.card').filter({ hasText: 'A001' })).toHaveCount(0)
  const cardB = page.locator('.card').filter({ hasText: 'B001' })
  await expect(cardB).toHaveCount(1)
  await expect(cardB).toContainText('¥198.00')
  await expect(cardB).toContainText('工时 6h')
  await expect(page.getByText('¥264.00', { exact: true })).toHaveCount(0)
})

test('Gate 29L missing self binding fails closed in Personnel', async ({ page }) => {
  await page.goto('/tests/gate29f-personnel-harness.html?self=missing')
  await expect(page.locator('.card').filter({ hasText: 'A001' })).toHaveCount(0)
  await expect(page.locator('.card').filter({ hasText: 'B001' })).toHaveCount(0)
  await expect(page.getByText('当前账号仅可查看本人信息')).toBeVisible()
  await expect(page.getByText(/暂无该类人员数据/)).toBeVisible()
})

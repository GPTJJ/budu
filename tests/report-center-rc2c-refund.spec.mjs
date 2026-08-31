import { expect, test } from '@playwright/test'

test('平台订单详情按结算权威展示并记录实际平台退款', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/tests/order-records-harness.html?external=1')

  const row = page.getByRole('row').filter({ hasText: 'POS-TEST-MEITUAN-001' })
  await expect(row.getByText('美团外卖', { exact: true })).toBeVisible()
  await expect(row.getByText('平台结算', { exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: '记录平台退款 POS-TEST-MEITUAN-001' })).toBeVisible()
  await expect(row.getByRole('button', { name: '退款 POS-TEST-MEITUAN-001', exact: true })).toHaveCount(0)

  await row.getByRole('button', { name: '查看明细 POS-TEST-MEITUAN-001' }).click()
  const detail = page.getByRole('dialog', { name: '订单明细' })
  await expect(detail.getByText('美团外卖', { exact: true })).toBeVisible()
  await expect(detail.getByText('平台结算', { exact: true }).first()).toBeVisible()
  await expect(detail.getByText('BUDU POS 人工记录', { exact: true })).toBeVisible()
  await expect(detail.getByText('微信支付', { exact: true })).toHaveCount(0)
  await detail.getByRole('button', { name: '记录平台退款 POS-TEST-MEITUAN-001' }).click()

  const refund = page.getByRole('dialog', { name: '记录平台退款' })
  await expect(refund.getByText('BUDU 这里只记录实际已经发生的退款', { exact: false })).toBeVisible()
  await expect(page.locator('html')).toHaveClass(/budu-overlay-open/)
  await refund.locator('input[type="number"]').first().fill('1')
  await refund.getByLabel('平台实际退款金额（元）').fill('30.25')
  await refund.getByLabel('退款原因（可填）').fill('平台已完成退款')
  await refund.getByRole('button', { name: '确认记录', exact: true }).click()

  await expect(refund).toHaveCount(0)
  await expect(page.getByText('平台退款记录已保存', { exact: true })).toBeVisible()
  const body = await page.evaluate(() => window.__manualExternalRefundBodies[0])
  expect(body.refundAmount).toBe('3025')
  expect(body.items).toEqual([{ orderItemId: 'oi-ext-1', quantity: 1 }])
  expect(body.externalCompletedAt).toMatch(/Z$/)
  expect(body.externalRefundReference).toBeUndefined()
  expect(body.requestKey.length).toBeGreaterThanOrEqual(8)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
})

test('Payment authority 订单保留原退款交互', async ({ page }) => {
  await page.goto('/tests/order-records-harness.html?external=1')
  await expect(page.getByRole('button', { name: '退款 POS-TEST-ORDER-001' })).toBeVisible()
  await page.getByRole('button', { name: '退款 POS-TEST-ORDER-001' }).click()
  await expect(page.getByRole('dialog', { name: '订单退款' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: '订单退款' }).getByText('记录平台退款', { exact: true })).toHaveCount(0)
})

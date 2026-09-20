import { expect, test } from '@playwright/test'

async function openShipment(page) {
  await page.goto('/tests/partner-replenishment-shipment-harness.html')
  await page.getByRole('button', { name: /RPL-20260907-SHIPMENT/ }).click()
  await expect(page.getByRole('dialog', { name: /审核补货单/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: '物流履约' })).toBeVisible()
}

test('默认官舍，可选择其他门店，并仅提交物流与本批数量', async ({ page }) => {
  await openShipment(page)
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('发货门店')).toHaveValue('guanshe')
  await dialog.getByLabel('发货门店').selectOption('tongying')
  await dialog.getByLabel('运费方式').selectOption('COLLECT')
  await dialog.getByLabel('快递公司').fill('顺丰')
  await dialog.getByLabel('快递单号').fill('SF123456789')
  await dialog.getByLabel('KG 糖本次发货数量').fill('6000')
  await dialog.getByRole('button', { name: '确认发货' }).click()
  await expect.poll(() => page.evaluate(() => window.__partnerShipmentTest.requests[0])).toMatchObject({ body: { fulfillmentStoreKey: 'tongying', carrier: '顺丰', trackingNumber: 'SF123456789', freightType: 'COLLECT', items: [{ orderItemId: 'kg-line', shippedQuantityBase: 6000 }] } })
  const request = await page.evaluate(() => window.__partnerShipmentTest.requests[0])
  expect(request.idempotencyKey).toMatch(/^shipment-[0-9a-f-]{36}$/)
  expect(JSON.stringify(request.body)).not.toMatch(/partnerId|price|discount|stock|payment/i)
})

test('removed line 不可进入发货，UI 展示已发和待发', async ({ page }) => {
  await openShipment(page)
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('颗糖本次发货数量')).toHaveCount(0)
  await expect(dialog.getByText('已发 0 kg · 待发 10 kg')).toBeVisible()
})

for (const width of [320, 340, 375, 390, 430]) {
  test(`${width}px 发货 Sheet 无横向溢出且确认按钮可达`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 })
    await openShipment(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: '确认发货' })).toBeVisible()
    const box = await dialog.boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1)
  })
}

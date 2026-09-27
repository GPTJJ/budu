import { expect, test } from '@playwright/test'

const scenarios = [
  { width: 320, source: 'MEITUAN', label: '美团外卖' },
  { width: 340, source: 'TAOBAO_FLASH', label: '淘宝闪购' },
  { width: 375, source: 'JD_INSTANT', label: '京东秒送' },
  { width: 390, source: 'OTHER', label: '其他平台' },
  { width: 430, source: 'MEITUAN', label: '美团外卖' },
]

for (const scenario of scenarios) {
  test(`${scenario.width}px ${scenario.label}平台订单单动作完成且不触发 Payment`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: 844 })
    await page.goto(`/tests/pos-harness.html?external=1&user=rc2c-${scenario.width}`)

    const platformButton = page.getByRole('button', { name: '平台订单', exact: true }).first()
    await expect(platformButton).toBeDisabled()
    await page.getByRole('button', { name: /卡皮巴拉布丁/ }).click()
    await expect(platformButton).toBeEnabled()
    await platformButton.click()

    const dialog = page.getByRole('dialog', { name: '平台订单' })
    await expect(dialog).toBeVisible()
    await expect(page.locator('html')).toHaveClass(/budu-overlay-open/)
    await expect(dialog.getByText('BUDU 不会向平台发起收款。', { exact: false })).toBeVisible()
    await dialog.getByRole('button', { name: `记录${scenario.label}订单`, exact: true }).click()
    await expect(dialog.getByText(new RegExp(`确认该订单已在${scenario.label}完成付款`))).toBeVisible()
    await dialog.getByRole('button', { name: '确认记录', exact: true }).click()

    await expect(page.getByRole('heading', { name: '订单已记录' })).toBeVisible()
    await expect(page.getByText(scenario.label, { exact: true })).toBeVisible()
    const facts = await page.evaluate(() => ({
      requests: window.__externalOrderBodies,
      paymentRequests: window.__paymentRequestCount,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    }))
    expect(facts.requests).toHaveLength(1)
    expect(facts.requests[0]).toMatchObject({ orderSource: scenario.source, confirm: true })
    expect(facts.requests[0].sourceOrderRef).toBeUndefined()
    expect(facts.requests[0].settlementAuthority).toBeUndefined()
    expect(facts.requests[0].entryMode).toBeUndefined()
    expect(facts.requests[0].status).toBeUndefined()
    expect(facts.requests[0].paymentStatus).toBeUndefined()
    expect(facts.requests[0].requestKey.length).toBeGreaterThanOrEqual(8)
    expect(facts.paymentRequests).toBe(0)
    expect(facts.overflow).toBeLessThanOrEqual(1)
  })
}

test('无平台订单能力时不展示入口，店内结算保持原路径', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/tests/pos-harness.html?user=rc2c-no-cap')
  await expect(page.getByRole('button', { name: '平台订单', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: /卡皮巴拉布丁/ }).click()
  await page.getByRole('button', { name: '结算', exact: true }).click()
  await expect(page.getByText('应付金额', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__externalOrderBodies)).toEqual([])
})

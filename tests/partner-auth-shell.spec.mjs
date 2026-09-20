import { expect, test } from '@playwright/test'

const widths = [320, 340, 375, 390, 430]

async function mockPartnerMe(page, principal = null) {
  await page.route('**/api/partner/auth/me', route => route.fulfill({
    status: principal ? 200 : 401,
    contentType: 'application/json',
    body: JSON.stringify(principal ? { principal } : { error: '未登录' }),
  }))
  if (principal) {
    await page.route('**/api/partner/profile', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ partner: { id: principal.partnerId, name: principal.partner.name, companyName: '合作商测试公司', contactName: '王女士', contactPhone: '13800000000', status: 'PAUSED', defaultDiscountBps: 6500 } }),
    }))
    await page.route('**/api/partner/stores', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rows: [{ id: 'store-self-1', name: '自有合作门店', province: '河北省', city: '秦皇岛市', district: '海港区', addressLine: '测试路1号', contactName: '李女士', phone: '13900000000', status: 'ACTIVE' }] }),
    }))
    await page.route('**/api/partner/replenishment-orders', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rows: [{
        id: 'order-self-1', orderNo: 'RPL-SELF-001', status: 'PARTIALLY_SHIPPED', createdByType: 'PARTNER', requestedTotalAmountCents: '149500', approvedTotalAmountCents: '93600', submittedAt: '2026-09-07T00:00:00.000Z', reviewedAt: '2026-09-07T01:00:00.000Z', reviewReason: '按本次计划确认',
        partnerStore: { name: '自有合作门店', province: '河北省', city: '秦皇岛市', district: '海港区', addressLine: '测试路1号' },
        items: [
          { inventoryItemId: 'kg', productNameSnapshot: 'KG 糖', orderUnitSnapshot: 'KG', requestedQuantityBase: 10000, approvedQuantityBase: 8000, shippedQuantityBase: 6000, remainingQuantityBase: 2000, reviewReason: '确认 8kg' },
          { inventoryItemId: 'pcs', productNameSnapshot: '颗糖', orderUnitSnapshot: 'PCS', requestedQuantityBase: 100, approvedQuantityBase: 0, shippedQuantityBase: 0, remainingQuantityBase: 0, reviewReason: '本次不发' },
        ],
        shipments: [{ id: 'shipment-1', carrier: '顺丰', trackingNumber: 'SF123456789', freightType: 'PREPAID', fulfillmentStoreName: '北京官舍店', shippedAt: '2026-09-07T04:00:00.000Z', items: [{ orderItemId: 'kg-line', productNameSnapshot: 'KG 糖', orderUnitSnapshot: 'KG', shippedQuantityBase: 6000 }] }],
      }] }),
    }))
    await page.route('**/api/partner/after-sales', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rows: [] }),
    }))
  }
}

for (const width of widths) {
  test(`/partner ${width}px 使用独立登录壳且无横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 })
    await mockPartnerMe(page)
    await page.goto('/partner')

    await expect(page.getByRole('heading', { name: '合作伙伴中心' })).toBeVisible()
    await expect(page.getByRole('button', { name: '登录合作伙伴中心' })).toBeVisible()
    await expect(page.locator('[data-testid="dashboard-shell"]')).toHaveCount(0)

    const metrics = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      usernameHeight: document.querySelector('input[autocomplete="username"]')?.getBoundingClientRect().height || 0,
      buttonHeight: document.querySelector('button[type="submit"]')?.getBoundingClientRect().height || 0,
    }))
    expect(metrics.overflow).toBe(0)
    expect(metrics.usernameHeight).toBeGreaterThanOrEqual(44)
    expect(metrics.buttonHeight).toBeGreaterThanOrEqual(44)
  })
}

test('/partner 已登录态展示自身档案与门店，不暴露内部导航或内部备注', async ({ page }) => {
  await mockPartnerMe(page, {
    type: 'PARTNER',
    partnerId: 'partner-gate-1',
    partner: { name: 'Gate 1 测试合作商' },
  })
  await page.goto('/partner/orders')

  await expect(page.getByText('budu Partner · 合作伙伴中心')).toBeVisible()
  await page.getByRole('button', { name: '我的' }).click()
  await expect(page.getByText('合作商测试公司')).toBeVisible()
  await expect(page.getByText('自有合作门店')).toBeVisible()
  await expect(page.getByText('内部备注')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  await expect(page.getByText('管理台')).toHaveCount(0)
  await expect(page.getByText('POS')).toHaveCount(0)
})

test('/partner 审核后同时展示原申请、确认数量、removed line 与最终商品金额', async ({ page }) => {
  await mockPartnerMe(page, {
    type: 'PARTNER',
    partnerId: 'partner-gate-1',
    partner: { name: 'Gate 1 测试合作商' },
  })
  await page.goto('/partner/orders')
  await page.getByRole('button', { name: /RPL-SELF-001/ }).click()
  const dialog = page.getByRole('dialog', { name: /补货单详情/ })
  await expect(dialog.getByText('申请 10 kg → budu 确认 8 kg')).toBeVisible()
  await expect(dialog.getByText('申请 100 颗 → budu 确认 本次不发')).toBeVisible()
  await expect(dialog.getByText('¥936.00')).toBeVisible()
  await expect(dialog.getByText('已发 6 kg · 待发 2 kg')).toBeVisible()
  await expect(dialog.getByText('顺丰 · SF123456789')).toBeVisible()
  await expect(page.getByText('reviewedByActorId')).toHaveCount(0)
  await expect(page.getByText('库存')).toHaveCount(0)
})

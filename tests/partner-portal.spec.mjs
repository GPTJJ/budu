import { expect, test } from '@playwright/test'

const catalogue = [
  { productId: 'kg', name: 'KG 糖', sku: 'KG-1', spec: '', productCategory: { id: 'cat-candy', name: '糖果', sortOrder: 1 }, orderUnit: 'KG', basePriceCents: '18000', basePriceUnit: 'KG', discountBps: 6500, referencePriceCents: '11700', minimumOrderBaseQty: 1, orderStepBaseQty: 1, shortcutIncrementBaseQty: 100, quantityAuthority: 'INTEGER_GRAMS' },
  { productId: 'pcs', name: '颗糖', sku: 'PCS-1', spec: '', productCategory: { id: 'cat-candy', name: '糖果', sortOrder: 1 }, orderUnit: 'PCS', basePriceCents: '500', basePriceUnit: 'PCS', discountBps: 6500, referencePriceCents: '325', minimumOrderBaseQty: 1, orderStepBaseQty: 1, shortcutIncrementBaseQty: 10, quantityAuthority: 'INTEGER_PIECES' },
  { productId: 'native', name: '礼盒', sku: 'BOX-1', spec: '', orderUnit: 'NATIVE', nativeUnit: '盒', basePriceCents: '8800', basePriceUnit: 'NATIVE', discountBps: 6500, referencePriceCents: '5720', minimumOrderBaseQty: 1, orderStepBaseQty: 1, shortcutIncrementBaseQty: 1, quantityAuthority: 'INTEGER_NATIVE_UNITS' },
]

const partialOrder = {
  id: 'order-1', orderNo: 'RPL-PORTAL-001', status: 'PARTIALLY_SHIPPED', createdByType: 'PARTNER', requestedTotalAmountCents: '149500', approvedTotalAmountCents: '93600', submittedAt: '2026-09-07T00:00:00.000Z', reviewedAt: '2026-09-07T01:00:00.000Z', reviewReason: '按计划确认',
  partnerStore: { id: 'store-1', name: '秦皇岛一店', province: '河北省', city: '秦皇岛市', district: '海港区', addressLine: '河北大街88号' },
  items: [
    { inventoryItemId: 'kg', productNameSnapshot: 'KG 糖', skuSnapshot: 'KG-1', orderUnitSnapshot: 'KG', requestedQuantityBase: 10000, requestedLineAmountCents: '117000', approvedQuantityBase: 8000, shippedQuantityBase: 6000, remainingQuantityBase: 2000, reviewReason: '确认 8kg' },
    { inventoryItemId: 'gone', productNameSnapshot: '历史下架糖', skuSnapshot: 'OLD', orderUnitSnapshot: 'PCS', requestedQuantityBase: 30, requestedLineAmountCents: '32500', approvedQuantityBase: 0, shippedQuantityBase: 0, remainingQuantityBase: 0, reviewReason: '本次不发' },
  ],
  shipments: [{ id: 'shipment-1', carrier: '顺丰', trackingNumber: 'SF123456789', freightType: 'PREPAID', fulfillmentStoreName: '北京官舍店', shippedAt: '2026-09-07T04:00:00.000Z', items: [{ id: 'ship-item-1', orderItemId: 'kg-line', productNameSnapshot: 'KG 糖', orderUnitSnapshot: 'KG', shippedQuantityBase: 6000 }] }],
}

const submittedOrder = { ...partialOrder, id: 'order-2', orderNo: 'RPL-PORTAL-002', status: 'SUBMITTED', approvedTotalAmountCents: null, shipments: [], items: [partialOrder.items[0]] }

async function mockPortal(page, { quoteFailures = 0, submitDelayMs = 0, catalogueRows = catalogue } = {}) {
  const requests = []
  let remainingQuoteFailures = quoteFailures
  await page.route('**/api/partner/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/api/partner/auth/me') return json({ principal: { type: 'PARTNER', partner: { id: 'partner-1', name: '秦皇岛合作商', status: 'ACTIVE' }, account: { username: 'partner_qhd' } } })
    if (path === '/api/partner/profile') return json({ partner: { id: 'partner-1', name: '秦皇岛合作商', companyName: '秦皇岛合作公司', contactName: '王女士', contactPhone: '13800000000', status: 'ACTIVE', defaultDiscountBps: 6500 } })
    if (path === '/api/partner/stores') return json({ rows: [{ id: 'store-1', name: '秦皇岛一店', province: '河北省', city: '秦皇岛市', district: '海港区', addressLine: '河北大街88号', contactName: '李女士', phone: '13900000000', status: 'ACTIVE' }] })
    if (path === '/api/partner/catalogue' && method === 'GET') return json({ rows: catalogueRows })
    if (path === '/api/partner/after-sales' && method === 'GET') return json({ rows: [] })
    if (path === '/api/partner/after-sales' && method === 'POST') {
      requests.push({ type: 'after-sales', body: request.postDataJSON() })
      return json({ ok: true, request: { id: 'as-1', status: 'PENDING' } }, 201)
    }
    if (path === '/api/partner/catalogue/quote' && method === 'POST') {
      const body = request.postDataJSON(); requests.push({ type: 'quote', body })
      if (remainingQuoteFailures > 0) {
        remainingQuoteFailures -= 1
        return json({ message: '报价服务暂时不可用，请重试' }, 503)
      }
      const quantityBase = body.orderUnit === 'KG' ? body.quantityGrams : body.orderUnit === 'PCS' ? body.quantityPieces : body.quantityUnits
      const price = body.orderUnit === 'KG' ? 18000 : body.orderUnit === 'PCS' ? 500 : 8800
      const finalAmountCents = body.orderUnit === 'KG' ? Math.round(quantityBase * price * 6500 / 10000000) : Math.round(quantityBase * price * 6500 / 10000)
      return json({ quote: { productId: body.productId, orderUnit: body.orderUnit, quantityBase, finalAmountCents: String(finalAmountCents) } })
    }
    if (path === '/api/partner/replenishment-orders' && method === 'GET') return json({ rows: [submittedOrder, partialOrder] })
    if (path === '/api/partner/replenishment-orders' && method === 'POST') {
      requests.push({ type: 'submit', body: request.postDataJSON(), idempotencyKey: request.headers()['idempotency-key'] })
      if (submitDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, submitDelayMs))
      return json({ ok: true, reused: false, order: submittedOrder }, 201)
    }
    if (path.endsWith('/cancel') && method === 'POST') return json({ ok: true, reused: false, order: { ...submittedOrder, status: 'CANCELLED' } })
    return json({ error: `NOT_MOCKED ${method} ${path}` }, 404)
  })
  await page.goto('/partner')
  await expect(page.getByTestId('partner-portal')).toBeVisible()
  return requests
}

test('首页展示合作商、状态摘要、最近订单与发起补货', async ({ page }) => {
  await mockPortal(page)
  await expect(page.getByRole('heading', { name: '秦皇岛合作商' })).toBeVisible()
  await expect(page.getByText('待审核').first()).toBeVisible()
  await expect(page.getByText('待发货').first()).toBeVisible()
  await expect(page.getByText('部分发货').first()).toBeVisible()
  await expect(page.getByRole('button', { name: '发起补货' })).toBeVisible()
  await expect(page.getByText('库存')).toHaveCount(0)
  await expect(page.getByText('欠款')).toHaveCount(0)
})

test('KG/PCS 商品卡只向 quote 发送身份、单位和整数基础数量', async ({ page }) => {
  const requests = await mockPortal(page)
  await page.getByRole('button', { name: '我要补货' }).click()
  await page.getByLabel('KG 糖补货数量').fill('10')
  await page.getByLabel('颗糖补货数量').fill('100')
  await page.getByRole('button', { name: '获取预计金额' }).click()
  await expect(page.getByText('¥1495.00')).toBeVisible()
  await expect.poll(() => requests.filter((row) => row.type === 'quote')).toHaveLength(2)
  expect(requests.find((row) => row.body.productId === 'kg').body).toEqual({ productId: 'kg', orderUnit: 'KG', quantityGrams: 10000 })
  expect(requests.find((row) => row.body.productId === 'pcs').body).toEqual({ productId: 'pcs', orderUnit: 'PCS', quantityPieces: 100 })
})

test('快捷按钮使用 KG 0.1kg、PCS 10，手动输入可绕开快捷步长并支持原生单位', async ({ page }) => {
  const requests = await mockPortal(page)
  await page.getByRole('button', { name: '我要补货' }).click()
  await page.getByLabel('KG 糖增加数量').click()
  await expect(page.getByLabel('KG 糖补货数量')).toHaveValue('0.1')
  await page.getByLabel('KG 糖补货数量').fill('1')
  await page.getByLabel('KG 糖增加数量').click()
  await expect(page.getByLabel('KG 糖补货数量')).toHaveValue('1.1')
  await page.getByLabel('KG 糖补货数量').fill('1.25')
  await page.getByLabel('颗糖增加数量').click()
  await expect(page.getByLabel('颗糖补货数量')).toHaveValue('10')
  await page.getByLabel('颗糖补货数量').fill('20')
  await page.getByLabel('颗糖增加数量').click()
  await expect(page.getByLabel('颗糖补货数量')).toHaveValue('30')
  await page.getByLabel('颗糖补货数量').fill('23')
  await page.getByLabel('礼盒补货数量').fill('2')
  await page.getByRole('button', { name: '获取预计金额' }).click()
  await expect.poll(() => requests.filter((row) => row.type === 'quote')).toHaveLength(3)
  expect(requests.find((row) => row.body.productId === 'kg').body.quantityGrams).toBe(1250)
  expect(requests.find((row) => row.body.productId === 'pcs').body.quantityPieces).toBe(23)
  expect(requests.find((row) => row.body.productId === 'native').body).toEqual({ productId: 'native', orderUnit: 'NATIVE', quantityUnits: 2 })
})

test('KG 小数逐键输入保留编辑状态并只向服务端提交整数克', async ({ page }) => {
  const requests = await mockPortal(page)
  await page.getByRole('button', { name: '我要补货' }).click()
  const input = page.getByLabel('KG 糖补货数量')
  await input.pressSequentially('0.1')
  await expect(input).toHaveValue('0.1')
  await page.getByRole('button', { name: '获取预计金额' }).click()
  await expect.poll(() => requests.filter((row) => row.type === 'quote')).toHaveLength(1)
  expect(requests.at(-1).body.quantityGrams).toBe(100)

  await input.fill('')
  await input.pressSequentially('0.001')
  await expect(input).toHaveValue('0.001')
  await page.getByRole('button', { name: '获取预计金额' }).click()
  await expect.poll(() => requests.filter((row) => row.type === 'quote')).toHaveLength(2)
  expect(requests.at(-1).body.quantityGrams).toBe(1)
})

test('无效 KG、PCS 和原生单位输入保留原文、显示校验并阻止报价', async ({ page }) => {
  await mockPortal(page)
  await page.getByRole('button', { name: '我要补货' }).click()
  await page.getByLabel('KG 糖补货数量').fill('0.0001')
  await expect(page.getByText('请输入大于 0、最多 3 位小数的 kg 数量')).toBeVisible()
  await expect(page.getByLabel('KG 糖补货数量')).toHaveValue('0.0001')
  await expect(page.getByRole('button', { name: '获取预计金额' })).toBeDisabled()

  await page.getByLabel('KG 糖补货数量').fill('')
  await page.getByLabel('颗糖补货数量').fill('1.5')
  await expect(page.getByText('请输入大于 0 的整数数量')).toBeVisible()
  await expect(page.getByRole('button', { name: '获取预计金额' })).toBeDisabled()

  await page.getByLabel('颗糖补货数量').fill('')
  await page.getByLabel('礼盒补货数量').fill('-1')
  await expect(page.getByText('请输入大于 0 的整数数量')).toBeVisible()
  await expect(page.getByRole('button', { name: '获取预计金额' })).toBeDisabled()
})

test('报价网络失败保留草稿并可原键重试', async ({ page }) => {
  const requests = await mockPortal(page, { quoteFailures: 1 })
  await page.getByRole('button', { name: '我要补货' }).click()
  const input = page.getByLabel('KG 糖补货数量')
  await input.fill('1.25')
  await page.getByRole('button', { name: '获取预计金额' }).click()
  await expect(page.getByRole('alert')).toContainText('报价服务暂时不可用，请重试')
  await expect(input).toHaveValue('1.25')
  await page.getByRole('button', { name: '获取预计金额' }).click()
  await expect.poll(() => requests.filter((row) => row.type === 'quote')).toHaveLength(2)
  await expect(page.getByTestId('partner-catalogue-card-kg')).toContainText('预计')
})

test('提交只包含当前商品数量并使用幂等键防止双提交', async ({ page }) => {
  const requests = await mockPortal(page)
  await page.getByRole('button', { name: '我要补货' }).click()
  await page.getByLabel('KG 糖补货数量').fill('10')
  await page.getByRole('button', { name: '获取预计金额' }).click()
  await page.getByRole('button', { name: '提交补货' }).click()
  await expect.poll(() => requests.filter((row) => row.type === 'submit')).toHaveLength(1)
  const submitted = requests.find((row) => row.type === 'submit')
  expect(submitted.body).toEqual({ partnerStoreId: 'store-1', items: [{ inventoryItemId: 'kg', quantity: 10000, orderUnit: 'KG' }] })
  expect(submitted.idempotencyKey).toMatch(/^partner-order-[0-9a-f-]{36}$/)
  expect(JSON.stringify(submitted.body)).not.toMatch(/price|discount|amount|partnerId/i)
})

test('提交进行中禁用操作并拦截连续点击', async ({ page }) => {
  const requests = await mockPortal(page, { submitDelayMs: 300 })
  await page.getByRole('button', { name: '我要补货' }).click()
  await page.getByLabel('KG 糖补货数量').fill('1')
  await page.getByRole('button', { name: '获取预计金额' }).click()
  const submit = page.getByRole('button', { name: '提交补货' })
  await submit.dblclick()
  await expect.poll(() => requests.filter((row) => row.type === 'submit')).toHaveLength(1)
  await expect(page.getByRole('heading', { name: '补货订单' })).toBeVisible()
})

test('订单详情区分申请、审核、物流并按当前 Catalogue 再次补货', async ({ page }) => {
  await mockPortal(page)
  await page.getByRole('button', { name: '补货订单' }).click()
  await page.getByRole('button', { name: /RPL-PORTAL-001/ }).click()
  const dialog = page.getByRole('dialog', { name: /补货单详情 RPL-PORTAL-001/ })
  await expect(dialog.getByText('申请 10 kg')).toBeVisible()
  await expect(dialog.getByText('budu 确认').first()).toBeVisible()
  await expect(dialog.getByText('顺丰 · SF123456789')).toBeVisible()
  await dialog.getByRole('button', { name: '再次补货' }).click()
  await expect(page.getByRole('heading', { name: '我要补货' })).toBeVisible()
  await expect(page.getByLabel('KG 糖补货数量')).toHaveValue('10')
  await expect(page.getByText('历史下架糖 当前已下架或不可补货')).toBeVisible()
  await expect(page.getByText('待重新计算')).toBeVisible()
})

test('已发商品可提交整数数量与受控图片的售后申请', async ({ page }) => {
  const requests = await mockPortal(page)
  await page.getByRole('button', { name: '补货订单' }).click()
  await page.getByRole('button', { name: /RPL-PORTAL-001/ }).click()
  await page.getByRole('dialog', { name: /补货单详情/ }).getByRole('button', { name: '申请售后' }).click()
  const dialog = page.getByRole('dialog', { name: '申请售后' })
  await dialog.getByLabel('售后类型').selectOption('DAMAGED')
  await dialog.getByLabel('售后数量').fill('1')
  await dialog.getByLabel('问题描述').fill('运输中外包装破损')
  await dialog.getByLabel('问题图片').setInputFiles({ name: 'proof.png', mimeType: 'image/png', buffer: Buffer.from('proof') })
  await dialog.getByRole('button', { name: '提交售后申请' }).click()
  await expect.poll(() => requests.find((row) => row.type === 'after-sales')).toBeTruthy()
  const body = requests.find((row) => row.type === 'after-sales').body
  expect(body).toMatchObject({ orderId: 'order-1', shipmentItemId: 'ship-item-1', type: 'DAMAGED', quantityBase: 1000, description: '运输中外包装破损' })
  expect(body.attachments[0]).toMatchObject({ name: 'proof.png', fileType: 'image/png' })
  expect(body.attachments[0].dataUrl).toMatch(/^data:image\/png;base64,/)
})

test('我的仅展示 Partner 基础信息、门店、账号与退出', async ({ page }) => {
  await mockPortal(page)
  await page.getByRole('button', { name: '我的' }).click()
  await expect(page.getByText('秦皇岛合作公司')).toBeVisible()
  await expect(page.getByText('河北省秦皇岛市海港区河北大街88号')).toBeVisible()
  await expect(page.getByText('partner_qhd')).toBeVisible()
  await expect(page.getByText('暂不支持自行创建子账号')).toBeVisible()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
})

test('目录复用商品中心分类顺序并在全部视图分组，空分类不出现', async ({ page }) => {
  await mockPortal(page)
  await page.getByRole('button', { name: '我要补货' }).click()
  const filters = page.getByRole('region', { name: '我要补货' }).getByLabel('商品分类')
  await expect(filters.getByRole('button')).toHaveText(['全部', '糖果', '其他'])
  await expect(filters.getByRole('button', { name: '空分类' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '糖果' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '其他' })).toBeVisible()
})

test('分类与名称/SKU 搜索可组合，分别显示明确空状态', async ({ page }) => {
  await mockPortal(page)
  await page.getByRole('button', { name: '我要补货' }).click()
  await page.getByRole('button', { name: '糖果', exact: true }).click()
  await expect(page.getByTestId('partner-catalogue-card-kg')).toBeVisible()
  await expect(page.getByTestId('partner-catalogue-card-native')).toHaveCount(0)
  await page.getByLabel('搜索商品').fill('PCS-1')
  await expect(page.getByTestId('partner-catalogue-card-pcs')).toBeVisible()
  await expect(page.getByTestId('partner-catalogue-card-kg')).toHaveCount(0)
  await page.getByLabel('搜索商品').fill('不存在')
  await expect(page.getByText('未找到相关商品')).toBeVisible()
  await page.getByLabel('搜索商品').fill('')
  await page.getByRole('button', { name: '其他', exact: true }).click()
  await expect(page.getByTestId('partner-catalogue-card-native')).toBeVisible()
})

test('商品卡片聚焦名称、实际价格与清晰数量控件，隐藏辅助定价信息', async ({ page }) => {
  await mockPortal(page)
  await page.getByRole('button', { name: '我要补货' }).click()
  const card = page.getByTestId('partner-catalogue-card-pcs')
  await expect(card).toContainText('颗糖')
  await expect(card).toContainText('¥3.25 / 颗')
  await expect(card).toContainText('数量（颗）')
  await expect(card).not.toContainText('PCS-1')
  await expect(card).not.toContainText('标准价')
  await expect(card).not.toContainText('合作折扣')
  await expect(card).not.toContainText('数量规则')
  const input = page.getByLabel('颗糖补货数量')
  await expect(input).toHaveAttribute('placeholder', '0')
  await input.fill('10')
  await expect(input).toHaveValue('10')
  await input.fill('100')
  await expect(input).toHaveValue('100')
  await page.getByLabel('颗糖减少数量').click()
  await expect(input).toHaveValue('90')
  await page.getByLabel('颗糖增加数量').click()
  await expect(input).toHaveValue('100')
  await expect(page.getByTestId('partner-catalogue-card-native')).toContainText('数量（盒）')
})

test('零数量是正常未选择态，仅真实非法 PCS 输入显示商品级错误', async ({ page }) => {
  const requests = await mockPortal(page)
  await page.getByRole('button', { name: '我要补货' }).click()
  const card = page.getByTestId('partner-catalogue-card-pcs')
  const input = page.getByLabel('颗糖补货数量')
  const error = card.getByText('请输入大于 0 的整数数量')

  await expect(error).toHaveCount(0)
  await expect(page.getByRole('button', { name: '获取预计金额' })).toBeDisabled()
  await page.getByLabel('颗糖减少数量').click()
  await expect(input).toHaveValue('0')
  await expect(error).toHaveCount(0)
  await page.getByLabel('颗糖增加数量').click()
  await expect(input).toHaveValue('10')
  await expect(error).toHaveCount(0)
  await input.fill('1')
  await page.getByLabel('颗糖减少数量').click()
  await expect(input).toHaveValue('0')
  await expect(error).toHaveCount(0)

  await input.fill('0')
  await expect(error).toHaveCount(0)
  await input.fill('')
  await expect(error).toHaveCount(0)
  await input.blur()
  await expect(input).toHaveValue('0')
  await expect(error).toHaveCount(0)

  for (const invalid of ['-1', '1.5', 'abc']) {
    await input.fill(invalid)
    await expect(error).toBeVisible()
    await expect(page.getByRole('button', { name: '获取预计金额' })).toBeDisabled()
  }

  await page.getByRole('button', { name: '清空当前补货内容' }).click()
  await expect(page.getByText('请输入大于 0 的整数数量')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '获取预计金额' })).toBeDisabled()
  expect(requests.filter((row) => row.type === 'quote')).toHaveLength(0)

  await input.fill('1')
  await expect(page.getByRole('button', { name: '获取预计金额' })).toBeEnabled()
  await page.getByRole('button', { name: '获取预计金额' }).click()
  await expect.poll(() => requests.filter((row) => row.type === 'quote')).toHaveLength(1)
})

test('清空当前草稿会清除数量和旧报价，同时保留门店、分类与搜索条件', async ({ page }) => {
  const requests = await mockPortal(page)
  await page.getByRole('button', { name: '我要补货' }).click()
  await page.getByRole('button', { name: '糖果', exact: true }).click()
  await page.getByLabel('搜索商品').fill('糖')
  const store = page.getByLabel('收货门店')
  await expect(store).toHaveValue('store-1')
  await page.getByLabel('KG 糖补货数量').fill('1')
  await page.getByLabel('颗糖补货数量').fill('10')
  await page.getByRole('button', { name: '获取预计金额' }).click()
  await expect(page.getByText('¥149.50')).toBeVisible()
  await expect(page.getByRole('button', { name: '提交补货' })).toBeEnabled()

  await page.getByRole('button', { name: '清空当前补货内容' }).click()
  await expect(page.getByRole('status')).toHaveText('当前补货内容已清空')
  await expect(page.getByLabel('KG 糖补货数量')).toHaveValue('')
  await expect(page.getByLabel('颗糖补货数量')).toHaveValue('')
  await expect(page.getByText(/^预计 ¥/)).toHaveCount(0)
  await expect(page.getByText('待重新计算')).toBeVisible()
  await expect(page.getByRole('button', { name: '获取预计金额' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '提交补货' })).toBeDisabled()
  await expect(store).toHaveValue('store-1')
  await expect(page.getByRole('button', { name: '糖果', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('搜索商品')).toHaveValue('糖')
  expect(requests.filter((row) => row.type === 'submit')).toHaveLength(0)

  await page.getByLabel('颗糖补货数量').fill('20')
  await page.getByRole('button', { name: '获取预计金额' }).click()
  await expect(page.getByRole('button', { name: '提交补货' })).toBeEnabled()
})

test('空草稿可稳定清空且不会产生报价或提交请求', async ({ page }) => {
  const requests = await mockPortal(page)
  await page.getByRole('button', { name: '我要补货' }).click()
  await page.getByRole('button', { name: '清空当前补货内容' }).click()
  await expect(page.getByRole('status')).toHaveText('当前补货内容已清空')
  expect(requests).toHaveLength(0)
})

for (const [width, expectedColumns] of [[768, 2], [1024, 3], [1440, 4]]) {
  test(`${width}px 同一分类商品稳定显示 ${expectedColumns} 列`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const rows = [
      ...catalogue.slice(0, 2),
      { ...catalogue[1], productId: 'pcs-2', name: '颗糖二', sku: 'PCS-2' },
      { ...catalogue[1], productId: 'pcs-3', name: '颗糖三', sku: 'PCS-3' },
    ]
    await mockPortal(page, { catalogueRows: rows })
    await page.getByRole('button', { name: '我要补货' }).click()
    await page.getByRole('button', { name: '糖果', exact: true }).click()
    const cards = page.locator('[data-testid^="partner-catalogue-card-"]')
    await expect(cards).toHaveCount(4)
    const boxes = await Promise.all(Array.from({ length: expectedColumns }, (_, index) => cards.nth(index).boundingBox()))
    expect(new Set(boxes.map((box) => Math.round(box.y))).size).toBe(1)
    expect(boxes.map((box) => box.x)).toEqual([...boxes.map((box) => box.x)].sort((a, b) => a - b))
    const quantityBox = await page.getByLabel('颗糖补货数量').boundingBox()
    expect(quantityBox.width).toBeGreaterThanOrEqual(80)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  })
}

for (const width of [320, 340, 375, 390, 430]) {
  test(`${width}px Portal、底部导航和订单 Bottom Sheet 无横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 })
    await mockPortal(page)
    await page.getByRole('button', { name: /RPL-PORTAL-002/ }).click()
    await expect(page.getByRole('dialog', { name: /补货单详情/ })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    const nav = page.getByRole('navigation', { name: '合作伙伴中心导航' })
    const navBox = await nav.boundingBox()
    expect(navBox.x).toBeGreaterThanOrEqual(0)
    expect(navBox.x + navBox.width).toBeLessThanOrEqual(width + 1)
  })

  test(`${width}px 补货操作区持续位于导航上方且最后商品可滚动避让`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 })
    await mockPortal(page)
    await page.getByRole('button', { name: '我要补货' }).click()
    const actions = page.getByTestId('partner-replenishment-actions')
    const nav = page.getByRole('navigation', { name: '合作伙伴中心导航' })
    await expect(actions).toBeVisible()
    let [actionsBox, navBox] = await Promise.all([actions.boundingBox(), nav.boundingBox()])
    expect(actionsBox.x).toBeGreaterThanOrEqual(0)
    expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(width + 1)
    expect(actionsBox.y).toBeGreaterThanOrEqual(0)
    expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(navBox.y + 1)

    await page.getByTestId('partner-catalogue-card-native').scrollIntoViewIfNeeded()
    const [lastCardBox, scrolledActionsBox] = await Promise.all([
      page.getByTestId('partner-catalogue-card-native').boundingBox(),
      actions.boundingBox(),
    ])
    expect(lastCardBox.y + lastCardBox.height).toBeLessThanOrEqual(scrolledActionsBox.y + 1)
    await page.setViewportSize({ width, height: 430 })
    await page.getByLabel('KG 糖补货数量').focus()
    ;[actionsBox, navBox] = await Promise.all([actions.boundingBox(), nav.boundingBox()])
    expect(actionsBox.y).toBeGreaterThanOrEqual(0)
    expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(navBox.y + 1)
  })
}

for (const width of [320, 340, 375, 390, 430, 1024]) {
  test(`空目录完成一次加载，允许人工刷新且无横向溢出 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await mockPortal(page)
    let calls = 0
    await page.route('**/api/partner/catalogue', route => {
      calls += 1
      return route.fulfill({ json: { rows: [] } })
    })
    await page.getByRole('button', { name: '我要补货', exact: true }).click()
    await expect(page.getByText('暂无可补货商品')).toBeVisible()
    await expect(page.getByRole('status', { name: '正在加载商品目录' })).toHaveCount(0)
    // Observation window detects the original successful-empty-response render loop.
    await page.waitForTimeout(400)
    expect(calls).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.getByRole('button', { name: '获取预计金额' })).toBeDisabled()
    await page.getByRole('button', { name: '刷新商品目录' }).click()
    await expect.poll(() => calls).toBe(2)
    await expect(page.getByText('暂无可补货商品')).toBeVisible()
  })
}

test('目录 API 失败结束 loading，明确报错并能重试恢复', async ({ page }) => {
  await mockPortal(page)
  let calls = 0
  await page.route('**/api/partner/catalogue', route => {
    calls += 1
    return calls === 1 ? route.fulfill({ status: 503, json: { message: '目录服务暂不可用' } }) : route.fulfill({ json: { rows: catalogue } })
  })
  await page.getByRole('button', { name: '我要补货', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('目录服务暂不可用')
  await expect(page.getByRole('status', { name: '正在加载商品目录' })).toHaveCount(0)
  await expect(page.getByText('暂无可补货商品')).toHaveCount(0)
  await page.getByRole('button', { name: '重试加载商品' }).click()
  await expect(page.getByLabel('KG 糖补货数量')).toBeVisible()
  expect(calls).toBe(2)
})

test('目录超时结束 loading 并提供重试', async ({ page }) => {
  await page.clock.install()
  await mockPortal(page)
  await page.route('**/api/partner/catalogue', () => {})
  await page.getByRole('button', { name: '我要补货', exact: true }).click()
  await expect(page.getByRole('status', { name: '正在加载商品目录' })).toBeVisible()
  await page.clock.fastForward(30001)
  await expect(page.getByRole('alert')).toContainText('商品目录加载超时，请重试')
  await expect(page.getByRole('status', { name: '正在加载商品目录' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '重试加载商品' })).toBeVisible()
})

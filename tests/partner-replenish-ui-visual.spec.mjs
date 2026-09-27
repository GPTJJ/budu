import { expect, test } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'

const out = process.env.PARTNER_UI_EVIDENCE_DIR
const products = Array.from({ length: 8 }, (_, index) => ({
  productId: `pcs-${index + 1}`,
  name: `Partner 糖果商品 ${index + 1}`,
  sku: `PCS-${String(index + 1).padStart(2, '0')}`,
  productCategory: { id: 'cat-candy', name: '糖果', sortOrder: 1 },
  orderUnit: 'PCS', nativeUnit: '颗', basePriceCents: '500', basePriceUnit: 'PCS',
  discountBps: 6500, referencePriceCents: '325', minimumOrderBaseQty: 1,
  orderStepBaseQty: 1, shortcutIncrementBaseQty: 10, quantityAuthority: 'INTEGER_PIECES',
}))

async function open(page) {
  await page.route('**/api/partner/**', route => {
    const pathname = new URL(route.request().url()).pathname
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (pathname.endsWith('/auth/me')) return json({ principal: { type: 'PARTNER', partner: { id: 'p', name: '示例合作商', status: 'ACTIVE' }, account: { username: 'partner' } } })
    if (pathname.endsWith('/profile')) return json({ partner: { id: 'p', name: '示例合作商', status: 'ACTIVE', defaultDiscountBps: 6500 } })
    if (pathname.endsWith('/stores')) return json({ rows: [{ id: 's', name: '示例收货门店', province: '北京市', city: '北京市', district: '朝阳区', status: 'ACTIVE' }] })
    if (pathname.endsWith('/catalogue')) return json({ rows: products })
    if (pathname.endsWith('/replenishment-orders') || pathname.endsWith('/after-sales')) return json({ rows: [] })
    return json({ quote: { finalAmountCents: '3250' } })
  })
  await page.goto('/partner/replenish')
  await expect(page.getByRole('heading', { name: '我要补货' })).toBeVisible()
}

for (const [name, width, height, columns] of [
  ['mobile-320', 320, 760, 1],
  ['mobile-375', 375, 812, 1],
  ['mobile-390', 390, 844, 1],
  ['mobile-430', 430, 860, 1],
  ['ipad-portrait-768', 768, 1024, 2],
  ['ipad-landscape-1024', 1024, 768, 3],
  ['desktop-1440', 1440, 1000, 4],
]) {
  test(`${name} visual layout`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await open(page)
    await expect(page.getByRole('button', { name: '清空当前补货内容' })).toBeVisible()
    await expect(page.getByText('请输入大于 0 的整数数量')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    const cards = page.locator('[data-testid^="partner-catalogue-card-"]')
    const boxes = await Promise.all(Array.from({ length: columns }, (_, index) => cards.nth(index).boundingBox()))
    expect(new Set(boxes.map(box => Math.round(box.y))).size).toBe(1)
    const input = page.getByLabel('Partner 糖果商品 1补货数量')
    const inputBox = await input.boundingBox()
    expect(inputBox.width).toBeGreaterThanOrEqual(80)
    await input.fill('100')
    await expect(input).toHaveValue('100')
    await page.getByRole('button', { name: '获取预计金额' }).click()
    await expect(page.getByTestId('partner-catalogue-card-pcs-1')).toContainText('预计')
    if (out) {
      await fs.mkdir(out, { recursive: true })
      await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true })
    }
  })
}

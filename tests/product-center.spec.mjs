import { expect, test } from '@playwright/test'
import * as XLSX from 'xlsx'

test('统一商品中心按独立业务用途、状态、分类与搜索筛选', async ({ page }) => {
  await page.goto('/tests/product-center-harness.html')
  await expect(page.getByText(/卡皮巴拉布丁/)).toBeVisible()
  await expect(page.getByText('NO.1树莓', { exact: false })).toHaveCount(0)
  await page.getByRole('button', { name: '门店调拨', exact: true }).click()
  await expect(page.getByText(/NO\.1树莓/)).toBeVisible()
  await page.getByRole('button', { name: '合作商供货', exact: true }).click()
  await expect(page.getByText(/NO\.2柠檬/)).toBeVisible()
  await page.getByLabel('商品分类筛选').selectOption('c-candy')
  await page.getByLabel('搜索商品').fill('NO.2')
  await expect(page.getByText(/NO\.2柠檬/)).toBeVisible()
})

test('编辑商品可独立控制三个业务开关并复用正式分类', async ({ page }) => {
  await page.goto('/tests/product-center-harness.html')
  await page.getByRole('button', { name: '编辑卡皮巴拉布丁' }).click()
  await page.getByLabel('商品分类', { exact: true }).selectOption('c-candy')
  await page.getByLabel('门店调拨').check()
  await page.getByLabel('合作商供货').check()
  await page.getByRole('button', { name: '保存商品' }).click()
  const row = page.locator('[data-product-id="p-pos"]')
  await expect(row).toContainText('太妃糖')
  await expect(row).toContainText('POS ✓')
  await expect(row).toContainText('调拨 ✓')
  await expect(row).toContainText('合作商 ✓')
  const request = await page.evaluate(() => window.__productCenterTest.requests.find((item) => item.path === '/api/v2/products/p-pos'))
  expect(request.body).toMatchObject({ isActive: true, transferEnabled: true, partnerSupplyEnabled: true, productCategoryId: 'c-candy' })
  expect(request.body).not.toHaveProperty('image')
})

test('商品编辑可人工配置箱颗调拨规格', async ({ page }) => {
  await page.goto('/tests/product-center-harness.html')
  await page.getByRole('button', { name: '编辑卡皮巴拉布丁' }).click()
  await page.getByLabel('门店调拨').check()
  await page.getByLabel('允许整箱调拨').check()
  await page.getByLabel('整箱净重').fill('2500')
  await page.getByLabel('允许散颗调拨').check()
  await page.getByLabel('标准单颗重量').fill('6')
  await page.getByRole('button', { name: '保存商品' }).click()
  const request = await page.evaluate(() => window.__productCenterTest.requests.find((item) => item.path === '/api/v2/products/p-pos'))
  expect(request.body).toMatchObject({ transferBoxEnabled: true, transferBoxWeightGrams: '2500', transferPieceEnabled: true, transferPieceWeightGrams: '6' })
})

test('商品中心列表只使用版本化 WebP 缩略图并延迟加载', async ({ page }) => {
  await page.goto('/tests/product-center-harness.html')
  const row = page.locator('[data-product-id="p-pos"]')
  const image = row.locator('img')
  await expect(image).toHaveAttribute('src', /\/api\/v2\/products\/p-pos\/thumbnail\?v=2026-08-29/)
  await expect(image).toHaveAttribute('loading', 'lazy')
  const payload = await page.evaluate(() => JSON.stringify(window.__productCenterTest.products))
  expect(payload).not.toContain('data:image/')
  await page.getByRole('button', { name: '编辑卡皮巴拉布丁' }).click()
  await expect(page.getByAltText('商品预览')).toHaveAttribute('src', /\/api\/v2\/products\/p-pos\/image\?v=2026-08-29/)
})

test('批量管理支持分类及 POS、调拨、合作商开关', async ({ page }) => {
  await page.goto('/tests/product-center-harness.html')
  await page.getByRole('button', { name: '全部', exact: true }).click()
  await page.getByLabel('业务状态筛选').selectOption('all')
  await page.getByLabel('选择卡皮巴拉布丁').check()
  await page.getByLabel('选择NO.1树莓').check()
  await page.getByLabel('批量目标分类').selectOption('c-candy')
  await page.getByRole('button', { name: '修改分类' }).click()
  await page.getByLabel('选择卡皮巴拉布丁').check()
  await page.getByLabel('选择NO.1树莓').check()
  await page.getByRole('button', { name: '启用合作商' }).click()
  const requests = await page.evaluate(() => window.__productCenterTest.requests.filter((item) => item.path === '/api/v2/products/bulk').map((item) => item.body))
  expect(requests).toEqual([
    expect.objectContaining({ operation: 'category', productCategoryId: 'c-candy', ids: ['p-pos', 'p-transfer'] }),
    expect.objectContaining({ operation: 'purpose', purpose: 'partner', enabled: true, ids: ['p-pos', 'p-transfer'] }),
  ])
  await expect(page.getByRole('button', { name: '启用POS' })).toHaveCount(0)
})

test('分类管理支持新增、编辑、排序和启停', async ({ page }) => {
  await page.goto('/tests/product-center-harness.html')
  await page.getByRole('button', { name: '分类管理' }).click()
  await page.getByRole('button', { name: '新增分类' }).click()
  await page.getByLabel('分类名称').fill('礼盒')
  await page.getByLabel('分类排序').fill('3')
  await page.getByRole('button', { name: '保存分类' }).click()
  const category = page.locator('[data-category-id="c-new-2"]')
  await expect(category).toContainText('礼盒')
  await page.getByRole('button', { name: '编辑分类礼盒' }).click()
  await page.getByLabel('分类排序').fill('4')
  await page.getByRole('button', { name: '保存分类' }).click()
  await expect(category).toContainText('排序 4')
  await category.getByRole('button', { name: '停用' }).click()
  await expect(category).toContainText('已停用')
})

test('商品组管理支持人工选择真实 SKU、款式名称与单品编辑', async ({ page }) => {
  await page.goto('/tests/product-center-harness.html')
  await page.getByRole('button', { name: '商品组管理' }).click()
  const manager = page.getByRole('dialog', { name: '商品组管理' })
  await manager.getByRole('button', { name: '新建商品组' }).click()
  await manager.getByLabel('商品组名称').fill('幸运小饼干')
  await manager.getByLabel('商品组排序').fill('8')
  await manager.getByLabel('加入商品组卡皮巴拉布丁').check()
  await manager.getByLabel('卡皮巴拉布丁款式名称').fill('蓝')
  await manager.getByLabel('加入商品组茉莉巧克力榛果脆片夹心礼盒装超长商品名称测试').check()
  await manager.getByLabel('茉莉巧克力榛果脆片夹心礼盒装超长商品名称测试款式名称').fill('绿')
  await manager.getByRole('button', { name: '保存商品组' }).click()
  const group = manager.locator('[data-product-group-id="pg-new-1"]')
  await expect(group).toContainText('幸运小饼干')
  await expect(group).toContainText('2 个款式')
  await expect(group).toContainText('蓝')
  await expect(group).toContainText('绿')
  const request = await page.evaluate(() => window.__productCenterTest.requests.find((item) => item.path === '/api/v2/product-groups'))
  expect(request.body.members).toEqual(expect.arrayContaining([
    { productId: 'p-pos', variantName: '蓝' },
    { productId: 'p-long', variantName: '绿' },
  ]))
  await manager.getByRole('button', { name: '关闭商品组管理' }).click()
  await page.getByRole('button', { name: '编辑卡皮巴拉布丁' }).click()
  await expect(page.getByLabel('商品组')).toHaveValue('pg-new-1')
  await expect(page.getByLabel('款式名称')).toHaveValue('蓝')
  await page.getByLabel('款式名称').fill('深蓝')
  await page.getByRole('button', { name: '保存商品' }).click()
  await expect(page.locator('[data-product-id="p-pos"]')).toContainText('幸运小饼干 / 深蓝')
})

test('商品中心仅按稳定 SKU 批量更新，预览后导入并上架', async ({ page }) => {
  await page.goto('/tests/product-center-harness.html')
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['菜品名', 'SKU', '分类', '售价（元）', '成本价（元）'],
    ['卡皮巴拉布丁', 'BUDU-001', '甜品', '75', '25'],
    ['草莓蛋糕', 'CAKE-002', '甜品', '38', '18'],
  ]), '菜单')
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
  await page.locator('input[type="file"]').setInputFiles({ name: '菜单.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer })
  const dialog = page.getByRole('dialog', { name: '菜单导入预览' })
  await expect(dialog.getByText('更新并上架', { exact: true })).toBeVisible()
  await expect(dialog.getByText('新增并上架', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '导入并上架 2 项', exact: true }).click()
  await expect(page.getByText('菜单导入完成：新增 1 个，更新 1 个，已全部自动上架', { exact: true })).toBeVisible()
  const payload = await page.evaluate(() => window.__productImportPayload)
  expect(payload.rows).toHaveLength(2)
  expect(payload.rows.every((row) => row.isActive === true && row.transferEnabled === false && row.partnerSupplyEnabled === false)).toBe(true)
})

test('商品中心可导出 Excel 菜单', async ({ page }) => {
  await page.goto('/tests/product-center-harness.html')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出菜单', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^budu商品菜单_\d{8}\.xlsx$/)
})

for (const width of [320, 340, 375, 390, 430]) {
  test(`${width}px 商品名称优先且无横向滚动`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/tests/product-center-harness.html')
    const row = page.locator('[data-product-id="p-long"]')
    const title = row.getByTestId('product-title')
    await expect(title).toHaveText('茉莉巧克力榛果脆片夹心礼盒装超长商品名称测试')
    await expect(title).not.toContainText('BUDU-CHOC-JAS-04')
    await expect(row.getByTestId('product-price')).toHaveText('¥138.00')
    await expect(row.getByTestId('product-badges')).toContainText('POS ✓')
    await expect(row.getByTestId('product-badges')).toContainText('调拨 —')
    await expect(row.getByTestId('product-badges')).toContainText('合作商 —')
    await expect(row.getByTestId('product-sku')).toContainText('BUDU-CHOC-JAS-04')
    await expect(row.getByRole('button', { name: '编辑茉莉巧克力榛果脆片夹心礼盒装超长商品名称测试' })).toBeVisible()
    const titleMetrics = await title.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        height: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(style.lineHeight),
        lineClamp: style.webkitLineClamp,
        width: element.getBoundingClientRect().width,
      }
    })
    expect(titleMetrics.lineClamp).toBe('2')
    expect(titleMetrics.height).toBeGreaterThan(titleMetrics.lineHeight)
    expect(titleMetrics.height).toBeLessThanOrEqual(titleMetrics.lineHeight * 2 + 1)
    expect(titleMetrics.width).toBeGreaterThanOrEqual(120)
    await expect(page.locator('[data-product-id="p-pos"]').getByTestId('product-title')).toHaveText('卡皮巴拉布丁')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    await page.getByRole('button', { name: '商品组管理' }).click()
    await expect(page.getByRole('dialog', { name: '商品组管理' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  })
}

test('SKU 下沉后仍可搜索商品', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto('/tests/product-center-harness.html')
  await page.getByLabel('搜索商品').fill('BUDU-CHOC-JAS-04')
  await expect(page.locator('[data-product-id="p-long"]')).toBeVisible()
  await expect(page.locator('[data-product-id="p-pos"]')).toHaveCount(0)
})

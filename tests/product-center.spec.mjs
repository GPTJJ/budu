import { expect, test } from '@playwright/test'
import * as XLSX from 'xlsx'

test('商品中心自动分析 Excel，预览后批量导入并上架', async ({ page }) => {
  await page.goto('/tests/product-center-harness.html')
  await expect(page.getByText('卡皮巴拉布丁', { exact: true })).toBeVisible()
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['菜品名', 'SKU', '分类', '售价（元）', '成本价（元）'],
    ['卡皮巴拉布丁', 'BUDU-001', '甜品', '75', '25'],
    ['草莓蛋糕', 'CAKE-002', '蛋糕', '38', '18'],
  ]), '菜单')
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
  await page.locator('input[type="file"]').setInputFiles({ name: '菜单.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer })

  const dialog = page.getByRole('dialog', { name: '菜单导入预览' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('更新并上架', { exact: true })).toBeVisible()
  await expect(dialog.getByText('新增并上架', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '导入并上架 2 项', exact: true }).click()
  await expect(page.getByText('菜单导入完成：新增 1 个，更新 1 个，已全部自动上架', { exact: true })).toBeVisible()
  await expect(page.getByText('草莓蛋糕', { exact: true })).toBeVisible()
  const payload = await page.evaluate(() => window.__productImportPayload)
  expect(payload.rows).toHaveLength(2)
  expect(payload.rows.every((row) => row.isActive === true)).toBe(true)
  expect(payload.rows[0].salePriceCents).toBe('7500')
})

test('商品中心可导出 Excel 菜单', async ({ page }) => {
  await page.goto('/tests/product-center-harness.html')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出菜单', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^budu商品菜单_\d{8}\.xlsx$/)
})


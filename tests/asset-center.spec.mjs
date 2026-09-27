import { expect, test } from '@playwright/test'

async function openAssetCenter(page) {
  await page.goto('/tests/asset-harness.html')
  await expect(page.getByText('budu档案馆', { exact: true })).toBeVisible()
  await expect(page.getByTestId('asset-card-af-1')).toContainText('营业执照-通盈店')
}

test('budu档案馆渲染概览、分类、卡片与到期状态', async ({ page }) => {
  const logs = []
  page.on('console', (m) => { if (m.type() === 'error') logs.push(`[console] ${m.text()}`) })
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  await openAssetCenter(page)
  await page.waitForTimeout(1000)
  if (logs.length) console.log('ASSET_LOGS:', logs.join('\n'))
  await expect(page.getByText('budu档案馆', { exact: true }).first()).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('文件总数', { exact: true })).toBeVisible()
  await expect(page.getByText('营业执照-通盈店', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('30天内到期', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('企业证照', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('品牌信息', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('产品质检', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('到期提醒', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /管理分类/ })).toHaveCount(1)
  await expect(page.getByRole('button', { name: /管理分类/ })).toBeVisible()
})

test('档案卡片仅在缩略图或文件图标区域提供预览入口', async ({ page }) => {
  await openAssetCenter(page)

  const thumbnailTrigger = page.getByTestId('asset-preview-trigger-af-1')
  const iconTrigger = page.getByTestId('asset-preview-trigger-af-2')
  await expect(thumbnailTrigger).toHaveAttribute('aria-label', '预览 营业执照-通盈店')
  await expect(iconTrigger).toHaveAttribute('aria-label', '预览 品牌Logo')
  await expect(thumbnailTrigger.locator('img')).toHaveCount(1)
  await expect(iconTrigger.locator('img')).toHaveCount(0)

  for (const id of ['af-1', 'af-2']) {
    const actions = page.getByTestId(`asset-actions-${id}`)
    await expect(actions.getByRole('button', { name: /预览/ })).toHaveCount(0)
    const labels = await actions.getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.innerText.trim()))
    expect(labels).toEqual(['下载', '编辑', '版本', '删除'])
  }

  await thumbnailTrigger.click()
  await expect(page.getByRole('heading', { name: '预览 · 营业执照-通盈店' })).toBeVisible()
  await expect(page.getByRole('img', { name: '营业执照-通盈店' })).toBeVisible()
  await page.getByRole('button', { name: '关闭' }).click()

  await iconTrigger.click()
  await expect(page.getByRole('heading', { name: '预览 · 品牌Logo' })).toBeVisible()
  await page.getByRole('button', { name: '关闭' }).click()

  const nonReadCalls = await page.evaluate(() => window.__assetApiCalls.filter((call) => call.method !== 'GET'))
  expect(nonReadCalls).toEqual([])
})

test('档案卡片预览入口与操作栏在手机、iPad、桌面无溢出或拥挤', async ({ page }) => {
  for (const width of [320, 340, 375, 390, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 760 : 900 })
    await openAssetCenter(page)

    const metrics = await page.evaluate(() => {
      const rect = (element) => {
        const r = element.getBoundingClientRect()
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
      }
      const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
      const triggers = [...document.querySelectorAll('[data-testid^="asset-preview-trigger-"]')].map(rect)
      const actionGroups = [...document.querySelectorAll('[data-testid^="asset-actions-"]')].map((group) => {
        const buttons = [...group.querySelectorAll('button')].map(rect)
        return {
          buttons,
          overlaps: buttons.some((button, index) => buttons.slice(index + 1).some((other) => overlap(button, other))),
        }
      })
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        triggers,
        actionGroups,
        viewportWidth: window.innerWidth,
      }
    })

    expect(metrics.overflow, `${width}px horizontal overflow`).toBe(0)
    expect(metrics.triggers).toHaveLength(2)
    for (const trigger of metrics.triggers) {
      expect(trigger.width, `${width}px preview width`).toBeGreaterThanOrEqual(44)
      expect(trigger.height, `${width}px preview height`).toBeGreaterThanOrEqual(44)
      expect(trigger.left).toBeGreaterThanOrEqual(0)
      expect(trigger.right).toBeLessThanOrEqual(metrics.viewportWidth)
    }
    for (const group of metrics.actionGroups) {
      expect(group.buttons).toHaveLength(4)
      expect(group.overlaps, `${width}px action overlap`).toBe(false)
      for (const button of group.buttons) {
        expect(button.width).toBeGreaterThan(0)
        expect(button.height).toBeGreaterThan(0)
        expect(button.right).toBeLessThanOrEqual(metrics.viewportWidth)
      }
    }
  }
})

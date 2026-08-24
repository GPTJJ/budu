import { expect, test } from '@playwright/test'

for (const width of [390, 430, 834]) {
  test(`${width}px 通知面板覆盖审批页且保持在视口内`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 834 ? 1112 : 844 })
    await page.goto('/tests/notification-layer-harness.html')
    const dialog = page.getByRole('dialog', { name: '通知' })
    await expect(dialog).toBeVisible()
    const layout = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"][aria-label="通知"]')
      const tabs = document.querySelector('[data-testid="approval-tabs"]')
      const rect = panel.getBoundingClientRect()
      return {
        parentIsBody: panel.parentElement === document.body,
        position: getComputedStyle(panel).position,
        panelZ: Number(getComputedStyle(panel).zIndex),
        tabsZ: Number(getComputedStyle(tabs).zIndex),
        left: rect.left,
        right: rect.right,
        viewportWidth: window.innerWidth,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })
    expect(layout.parentIsBody).toBe(true)
    expect(layout.position).toBe('fixed')
    expect(layout.panelZ).toBeGreaterThan(layout.tabsZ)
    expect(layout.left).toBeGreaterThanOrEqual(0)
    expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth)
    expect(layout.overflow).toBeLessThanOrEqual(0)
  })
}

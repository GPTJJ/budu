import { expect, test } from '@playwright/test'

for (const surface of ['login', 'sidebar']) {
  for (const viewport of [{ label: '390px', width: 390, height: 844 }, { label: 'desktop', width: 1280, height: 900 }]) {
    test(`${surface} ${viewport.label} 使用 canonical budu wordmark`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto(`/tests/brand-harness.html?surface=${surface}`)
      const logo = page.getByRole('img', { name: 'budu' })
      await expect(logo).toBeVisible()
      const box = await logo.boundingBox()
      expect(box.width).toBeGreaterThanOrEqual(80)
      expect(Math.abs((box.width / box.height) - 3.11235)).toBeLessThan(0.03)
      await expect(page.getByText('BUDU', { exact: true })).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })
  }
}

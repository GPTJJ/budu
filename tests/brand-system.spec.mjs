import { expect, test } from '@playwright/test'

const surfaceViewports = {
  login: [{ label: '390px', width: 390, height: 844 }, { label: 'desktop', width: 1280, height: 900 }],
  sidebar: [
    { label: '320px', width: 320, height: 740 },
    { label: '340px', width: 340, height: 760 },
    { label: '375px', width: 375, height: 812 },
    { label: '390px', width: 390, height: 844 },
    { label: '430px', width: 430, height: 932 },
    { label: 'desktop', width: 1280, height: 900 },
  ],
}

for (const surface of ['login', 'sidebar']) {
  for (const viewport of surfaceViewports[surface]) {
    test(`${surface} ${viewport.label} 使用 canonical budu wordmark`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto(`/tests/brand-harness.html?surface=${surface}`)
      const logo = page.getByRole('img', { name: 'budu' })
      await expect(logo).toBeVisible()
      const box = await logo.boundingBox()
      expect(box.width).toBeGreaterThanOrEqual(80)
      expect(Math.abs((box.width / box.height) - 3.11235)).toBeLessThan(0.03)
      await expect(page.getByText('BUDU', { exact: true })).toHaveCount(0)
      if (surface === 'sidebar') {
        const slot = page.getByTestId('brand-slot')
        const icon = page.getByTestId('brand-slot-icon')
        const wordmark = page.getByTestId('brand-slot-wordmark')
        await expect(slot).toBeVisible()
        await expect(icon).toBeVisible()
        await expect(wordmark).toBeVisible()
        await expect(page.getByText('甜蜜治愈日常', { exact: true })).toHaveCount(0)
        const [slotBox, iconBox] = await Promise.all([slot.boundingBox(), icon.boundingBox()])
        expect(slotBox.width).toBeLessThanOrEqual(208)
        expect(iconBox.width).toBe(40)
        expect(iconBox.height).toBe(40)
        for (const asset of [icon, wordmark]) {
          const decoration = await asset.evaluate((element) => {
            const style = getComputedStyle(element)
            return {
              backgroundColor: style.backgroundColor,
              borderWidths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
              boxShadow: style.boxShadow,
              outlineStyle: style.outlineStyle,
            }
          })
          expect(decoration.backgroundColor).toBe('rgba(0, 0, 0, 0)')
          expect(decoration.borderWidths).toEqual(['0px', '0px', '0px', '0px'])
          expect(decoration.boxShadow).toBe('none')
          expect(decoration.outlineStyle).toBe('none')
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })
  }
}

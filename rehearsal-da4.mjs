import { webkit } from '@playwright/test'
const browser = await webkit.launch()
const page = await browser.newPage({ viewport: { width: 1024, height: 800 } })
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)))
await page.goto('http://127.0.0.1:5198/')
await page.waitForSelector('input', { timeout: 15000 })
await page.fill('input:not([type="password"])', 'budu')
await page.fill('input[type="password"]', 'BuduTest2026')
await page.getByRole('button', { name: /登 ?录/ }).first().click()
await page.waitForTimeout(4000)
await page.evaluate(() => { const el = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('门店经营')); el && el.click() })
await page.waitForTimeout(1500)
await page.evaluate(() => {
  const els = [...document.querySelectorAll('button, span, div')].filter((b) => b.textContent.trim().includes('门店业绩录入'))
  const vis = els.filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
  vis[vis.length - 1].click()
})
await page.waitForTimeout(2500)
// 填营业收入 1234.50 / 订单数 15
await page.evaluate(() => {
  const nums = [...document.querySelectorAll('input[type="number"]')]
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  if (nums[0]) { set.call(nums[0], '1234.50'); nums[0].dispatchEvent(new Event('input', { bubbles: true })) }
  if (nums[1]) { set.call(nums[1], '15'); nums[1].dispatchEvent(new Event('input', { bubbles: true })) }
  return nums.length
}).then((n) => console.log('number inputs:', n))
await page.waitForTimeout(500)
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('保存营业数据'))
  if (btn) { btn.click(); return 'clicked' }
  return 'no button'
}).then((r) => console.log('save:', r))
await page.waitForTimeout(3500)
const body2 = await page.locator('body').innerText()
console.log('提示:', body2.includes('已保存') ? '已保存 ✓' : (body2.includes('保存失败') ? '保存失败' : '无提示'))
await browser.close()

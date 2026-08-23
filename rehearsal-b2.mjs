import { webkit } from '@playwright/test'
const browser = await webkit.launch()
const page = await browser.newPage({ viewport: { width: 1024, height: 800 } })
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
await page.waitForTimeout(3000)
page.once('dialog', async (d) => { console.log('DIALOG:', d.message().slice(0, 40)); await d.accept() })
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '删除' && b.getBoundingClientRect().width > 0)
  if (btn) { btn.click(); return 'delete clicked' }
  return 'no delete button'
}).then((r) => console.log(r))
await page.waitForTimeout(4000)
const body = await page.locator('body').innerText()
const errs = (body.match(/[^。\n]*(失败|不可用|错误)[^。\n]*/g) || []).slice(0, 4)
console.log('错误提示:', JSON.stringify(errs))
await browser.close()

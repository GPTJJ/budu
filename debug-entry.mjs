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
await page.waitForTimeout(2500)
const info = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll('input')].map((i) => ({ ph: i.placeholder, type: i.type, val: i.value }))
  const buttons = [...document.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.textContent.trim().slice(0, 20)).filter(Boolean)
  return { inputs: inputs.slice(0, 10), buttons: buttons.slice(0, 20) }
})
console.log(JSON.stringify(info, null, 1))
await browser.close()

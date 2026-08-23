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
  const els = [...document.querySelectorAll('button, span, div')].filter((b) => b.textContent.trim().includes('门店排班'))
  const vis = els.filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
  vis[vis.length - 1].click()
})
await page.waitForTimeout(3000)
// 打开第一个 添加排班 弹窗（tongying 周一 2026-08-24 已有叶芷辰）
await page.evaluate(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('添加排班')); btn && btn.click() })
await page.waitForTimeout(1000)
// 填员工名 隋晓 + 选择晚班
await page.evaluate(() => {
  const input = [...document.querySelectorAll('input')].find((i) => i.getAttribute('list'))
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  if (input) { set.call(input, '隋晓'); input.dispatchEvent(new Event('input', { bubbles: true })) }
})
await page.waitForTimeout(300)
await page.evaluate(() => {
  const sel = document.querySelector('select')
  if (sel) { sel.value = '晚班'; sel.dispatchEvent(new Event('change', { bubbles: true })) }
})
await page.waitForTimeout(300)
await page.evaluate(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('确认添加')); btn && btn.click() })
await page.waitForTimeout(2500)
const body = await page.locator('body').innerText()
console.log('保存成功提示:', body.includes('已保存'))
console.log('隋晓出现:', body.includes('隋晓'))
await browser.close()

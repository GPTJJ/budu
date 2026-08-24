// 生产人员管理页截图（cookie 注入）
import { webkit } from '@playwright/test'
const TOKEN = process.env.BUDU_TOKEN
const browser = await webkit.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)))
await page.context().addCookies([{ name: 'budu_token', value: TOKEN, domain: 'buducandy.cn', path: '/' }])
await page.goto('https://buducandy.cn/')
await page.waitForTimeout(8000)
let body = await page.locator('body').innerText()
console.log('登录态:', body.includes('甜蜜治愈日常') ? 'OK' : 'FAIL(' + body.slice(0, 50) + ')')
if (!body.includes('甜蜜治愈日常')) {
  // 尝试 UI 登录
  await page.fill('input:not([type="password"])', 'budu')
  await page.fill('input[type="password"]', 'Budu2025')
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().includes('登录')); if (b) b.click() })
  await page.waitForTimeout(7000)
  body = await page.locator('body').innerText()
  console.log('UI 登录:', body.includes('甜蜜治愈日常') ? 'OK' : 'FAIL')
}
if (body.includes('甜蜜治愈日常')) {
  // 人员管理 → 雇员
  await page.evaluate(() => { const els = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === '人员管理' && b.getBoundingClientRect().width > 0); if (els.length) els[0].click() })
  await page.waitForTimeout(1500)
  await page.evaluate(() => { const els = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim().replace(/^●\s*/, '').trim() === '雇员' && b.getBoundingClientRect().width > 0); if (els.length) els[0].click() })
  await page.waitForTimeout(4000)
  body = await page.locator('body').innerText()
  console.log('=== 雇员页全文 ===')
  console.log(body.split('\n').filter(l => l.trim()).slice(0, 90).join('\n'))
  await page.screenshot({ path: '/tmp/prod-personnel.png' })
}
await browser.close()

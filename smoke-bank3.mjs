import { webkit } from '@playwright/test'
const browser = await webkit.launch()
const page = await browser.newPage({ viewport: { width: 1024, height: 800 } })
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 300)))
await page.goto('http://127.0.0.1:5198/')
await page.waitForSelector('input', { timeout: 15000 })
await page.fill('input:not([type="password"])', 'budu')
await page.fill('input[type="password"]', 'BuduTest2026')
await page.getByRole('button', { name: /登 ?录/ }).first().click()
await page.waitForTimeout(4000)
await page.evaluate(() => { const el = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('审批中心')); el && el.click() })
await page.waitForTimeout(2500)
await page.evaluate(() => {
  const els = [...document.querySelectorAll('*')].filter((b) => b.textContent.trim().startsWith('工资审批'))
  const vis = els.filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 200 })
  const target = vis[vis.length - 1]
  let node = target
  while (node && node.tagName !== 'BUTTON' && node.tagName !== 'A') node = node.parentElement
  ;(node || target).click()
})
await page.waitForTimeout(2500)
// 三个独立字段
const body = await page.locator('body').innerText()
console.log('银行名行:', body.includes('银行名'), '| 支行名行:', body.includes('支行名'), '| 卡号行:', body.includes('卡号'))
// 选员工
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('员工') && b.textContent.includes('请选择员工'))
  btn && btn.click()
})
await page.waitForTimeout(1200)
await page.evaluate(() => { const el = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('隋晓')); el && el.click() })
await page.waitForTimeout(800)
await page.evaluate(() => { const els = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === '确定' && b.getBoundingClientRect().width > 0); if (els.length) els[els.length - 1].click() })
await page.waitForTimeout(3000)
const vals = await page.evaluate(() => {
  const get = (label) => {
    const l = [...document.querySelectorAll('label')].find((b) => b.textContent.trim().startsWith(label))
    return l && l.querySelector('input') ? l.querySelector('input').value : 'NOT FOUND'
  }
  return { bankName: get('银行名'), bankBranch: get('支行名'), cardNumber: get('卡号') }
})
console.log('自动代入:', JSON.stringify(vals))
const body2 = await page.locator('body').innerText()
console.log('来源提示:', body2.includes('信息来源员工档案'), '| 尾号:', body2.includes('尾号 3445'))
await browser.close()

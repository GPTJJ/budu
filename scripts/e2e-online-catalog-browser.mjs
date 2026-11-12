// 本地端到端验证：需要已启动的 OS 服务（BASE_URL）与已迁移的数据库。
// 用法：BASE_URL=http://127.0.0.1:3100 E2E_USER=... E2E_PASS=... node scripts/e2e-online-catalog-browser.mjs
import { webkit } from 'playwright'
import { mkdir } from 'node:fs/promises'

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3100'
const USER = process.env.E2E_USER || 'e2eowner'
const PASS = process.env.E2E_PASS || 'e2e-pass-123'
const SHOT_DIR = process.env.E2E_SHOT_DIR || '/tmp/budu-e2e-shots'
const stamp = Date.now().toString(36)
const categoryName = `E2E分类-${stamp}`
const productName = `E2E商品-${stamp}`

await mkdir(SHOT_DIR, { recursive: true })

const browser = await webkit.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, baseURL: BASE_URL })
const page = await context.newPage()
const consoleErrors = []
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

function check(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`)
  console.log(`  ✓ ${message}`)
}

try {
  const login = await context.request.post(`${BASE_URL}/api/auth/login`, {
    data: { username: USER, password: PASS },
  })
  check(login.ok(), `登录成功（${login.status()}）`)

  await page.goto('/online-catalog', { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: '小程序商城管理' }).waitFor({ timeout: 15000 })
  check(await page.getByText('CloudBase 发布凭据未配置').isVisible(), '未配置凭据时显示黄色提示')
  await page.screenshot({ path: `${SHOT_DIR}/01-empty.png`, fullPage: true })

  const createButton = page.getByRole('button', { name: '新增商品' })
  check(await createButton.isDisabled(), '无分类时“新增商品”禁用（防止建出无分类商品）')

  await page.getByRole('button', { name: '管理分类' }).click()
  await page.getByLabel('分类名称').fill(categoryName)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(categoryName) }).waitFor({ timeout: 10000 })
  check(true, `分类已创建并出现在筛选条：${categoryName}`)
  await page.screenshot({ path: `${SHOT_DIR}/02-category.png`, fullPage: true })

  await createButton.click()
  await page.getByLabel('商品名称（OS）').fill(productName)
  await page.getByLabel('SKU').fill(`E2E-SKU-${stamp}`)
  await page.getByLabel('POS 售价（元）').fill('12.50')
  await page.getByLabel('成本价（元）').fill('6.00')
  await page.getByLabel('线上标题').fill(`${productName}-线上`)
  await page.getByLabel('规格').fill('100g/盒')
  await page.getByLabel('保质期').fill('90天')
  await page.getByLabel('保存方式').fill('冷藏')
  await page.getByLabel('状态').selectOption('ON')
  await page.screenshot({ path: `${SHOT_DIR}/03-form.png`, fullPage: true })
  await page.getByRole('button', { name: '保存', exact: true }).click()

  await page.getByText('商品与线上档案已创建').waitFor({ timeout: 10000 })
  await page.getByText(`${productName}-线上`).first().waitFor({ timeout: 10000 })
  check(true, '商品创建后出现在列表')
  await page.screenshot({ path: `${SHOT_DIR}/04-created.png`, fullPage: true })

  // 线上价留空 → 应默认跟随 POS 售价 12.50
  const priceCell = page.locator('text=¥12.50').first()
  check(await priceCell.isVisible(), '线上价默认跟随 POS 售价（¥12.50）')

  await page.getByRole('button', { name: '预览' }).first().click()
  const pre = page.locator('pre')
  await pre.waitFor({ timeout: 10000 })
  const docText = await pre.innerText()
  check(docText.includes('"unitPriceCent": 1250'), '发布预览中 unitPriceCent = 1250（分）')
  check(docText.includes(categoryName), '发布预览包含线上分类名称')
  await page.screenshot({ path: `${SHOT_DIR}/05-preview.png`, fullPage: true })
  await page.getByRole('button', { name: '关闭' }).click()

  // 未配置 TCB：发布必须 fail closed，并保留未发布状态
  await page.getByRole('button', { name: '发布' }).first().click()
  await page.waitForTimeout(1500)
  const bodyText = await page.locator('body').innerText()
  check(/未配置|凭据|TCB/i.test(bodyText), '未配置凭据时发布返回明确错误而不是静默成功')
  check(await page.getByText('发布失败').first().isVisible(), '发布失败后商品标记为“发布失败”而不是假装已发布')
  await page.screenshot({ path: `${SHOT_DIR}/06-publish-blocked.png`, fullPage: true })

  // 发布被拒是预期内的 503；只关心脚本错误与真正的页面异常。
  const scriptErrors = consoleErrors.filter((text) => !/Failed to load resource/.test(text))
  check(scriptErrors.length === 0, `浏览器无脚本错误（实际 ${scriptErrors.length} 条）`)
  console.log(`\nE2E PASS · 截图目录 ${SHOT_DIR}`)
} finally {
  if (consoleErrors.length) console.log('console errors:', consoleErrors.slice(0, 5))
  await browser.close()
}

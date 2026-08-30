// Gate 3：真实浏览器验证已挂载 React consumer 能响应异步 PG staff cache 更新。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const vite = await createServer({
  root,
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'silent',
})
await vite.listen()
const baseUrl = vite.resolvedUrls.local[0]
const browser = await chromium.launch({ headless: true })

after(async () => {
  await browser.close()
  await vite.close()
})

const pgStaff = [
  { id: 'emp-zhang', name: '张三', storeKey: 'guanshe', storeName: '北京官舍店', type: 'fulltime' },
  { id: 'emp-li', name: '李四', storeKey: 'chaowai', storeName: '北京朝外店', type: 'parttime' },
]

test('Gate 3 Scenario A: StoreEntryPage 无需刷新即可显示异步到达的 PG 员工', async () => {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await page.goto(`${baseUrl}tests/pg-employee-reactivity-harness.html?mode=store`)
    const chooser = page.getByRole('button', { name: /选择值班人员/ })
    await chooser.waitFor()
    await chooser.click()
    assert.equal(await page.getByText('张三', { exact: true }).count(), 0)

    await page.evaluate((rows) => window.__publishStaff(rows), pgStaff)
    await page.getByText('张三', { exact: true }).waitFor()
    await page.getByText('李四', { exact: true }).waitFor()
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('Gate 3 Scenario B: EmployeeSheet 原地更新、搜索正常且卸载安全', async () => {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await page.goto(`${baseUrl}tests/pg-employee-reactivity-harness.html?mode=employee`)
    await page.getByText('未找到匹配员工', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.__employeeSheetMounts), 1)
    assert.equal(await page.evaluate(() => document.body.style.position), 'fixed', '审批 EmployeeSheet 必须锁定背景')
    assert.equal(await page.getByRole('dialog', { name: '选择员工' }).evaluate((element) => getComputedStyle(element).overscrollBehaviorY), 'contain')

    await page.evaluate((rows) => window.__publishStaff(rows), pgStaff)
    await page.getByText('张三', { exact: true }).waitFor()
    await page.getByText('李四', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.__employeeSheetMounts), 1, 'cache 更新不得 remount EmployeeSheet')

    const search = page.getByPlaceholder('搜索员工姓名 / 门店')
    const requestsBeforeSearch = await page.evaluate(() => window.__fetchCalls.length)
    await search.fill('张')
    assert.equal(await page.getByText('张三', { exact: true }).count(), 1)
    assert.equal(await page.getByText('李四', { exact: true }).count(), 0)
    await search.fill('官舍')
    assert.equal(await page.getByText('张三', { exact: true }).count(), 1)
    assert.equal(await page.getByText('李四', { exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => window.__fetchCalls.length), requestsBeforeSearch, '搜索不得触发网络请求')

    await page.evaluate(() => window.__unmountEmployeeSheet())
    await page.waitForFunction(() => window.__employeeSheetUnmounts === 1)
    await page.waitForFunction(() => document.body.style.position === '')
    await page.evaluate((rows) => window.__publishStaff(rows), [pgStaff[1]])
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('Gate 3 Boundary: 两个锁定 consumer 依赖更新信号且 EmployeeSheet 返回 unsubscribe', () => {
  const storeEntry = fs.readFileSync(path.join(root, 'src/components/StoreEntryPage.jsx'), 'utf8')
  const approvalSelectors = fs.readFileSync(path.join(root, 'src/components/approval/ApprovalSelectors.jsx'), 'utf8')

  assert.match(storeEntry, /daily-participants/, 'StoreEntryPage 必须消费稳定参与者目录')
  assert.match(storeEntry, /onUserDataUpdated\([\s\S]*?loadOverviewRef\.current/, 'StoreEntryPage 必须响应 PG 更新信号并按当前权威重载参与者目录')
  assert.match(approvalSelectors, /onUserDataUpdated\(\(\) => setDataVersion/)
  assert.match(approvalSelectors, /employeeList\('all', null\), \[dataVersion\]/)
  assert.match(approvalSelectors, /\(\) => onUserDataUpdated\(/, 'effect 必须把 unsubscribe 返回给 React')
  assert.ok(!approvalSelectors.includes("loadUserData"), 'EmployeeSheet 不得新增重复数据请求')
})

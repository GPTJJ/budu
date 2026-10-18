import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from 'playwright-core'
import { expect } from '@playwright/test'

const cacheDir = await mkdtemp(join(tmpdir(), 'budu-store-pickup-ui-'))
const vite = await createServer({ cacheDir, server: { host: '127.0.0.1', port: 5261, strictPort: true }, logLevel: 'error' })
await vite.listen()
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const engines = [['chromium', chromium], ['webkit', webkit]]
  .filter(([name]) => !process.env.STORE_PICKUP_UI_BROWSER || process.env.STORE_PICKUP_UI_BROWSER === name)
const results = []
try {
  for (const [name, engine] of engines) {
    const browser = await engine.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true })
    const external = [], errors = []
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"SYNTHETIC_HARNESS_ONLY"}' })
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue()
      external.push(url.origin)
      return route.abort()
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    const pass = (label) => { results.push({ browser: name, label }); console.log(`PASS ${name}: ${label}`) }
    const pickup = page.getByRole('checkbox', { name: '支持顾客自提', exact: true })
    const save = page.getByRole('button', { name: '保存门店', exact: true })
    const nameInput = page.getByLabel('门店名称', { exact: true })
    const districtInput = page.getByLabel('位置说明（选填）', { exact: true })
    const open = async () => {
      await page.goto(`${origin}/tests/store-management-harness.html`)
      await page.getByTestId('settings-row-stores').click()
      await expect(page.getByRole('button', { name: '刷新门店列表' })).toBeEnabled()
    }
    const writes = (method) => page.evaluate((method) => window.__storeTest.requests.filter((row) => row.method === method), method)
    try {
      await open()
      await page.getByRole('button', { name: '新增门店', exact: true }).click()
      await expect(pickup).toBeChecked()
      await nameInput.fill('合成自提门店')
      await districtInput.fill('合成收货地点')
      await pickup.uncheck()
      await page.evaluate(() => { window.__storeTest.fail('create-lost-after-commit'); window.__storeTest.delay(250) })
      await save.evaluate((button) => { button.click(); button.click() })
      await expect(pickup).toBeDisabled()
      await expect(page.getByRole('button', { name: '重试保存', exact: true })).toBeEnabled()
      await expect(nameInput).toBeDisabled()
      await expect(pickup).not.toBeChecked()
      assert.equal((await writes('POST')).length, 1)
      const committed = await page.evaluate(() => window.__storeTest.read().rows.find((row) => row.name === '合成自提门店'))
      assert.equal(committed.pickupEnabled, false)
      // Creation replay returns the current row, including any later authorized edit.
      await page.evaluate((key) => window.__storeTest.pickup(key, true), committed.key)
      await expect(pickup).not.toBeChecked()
      await page.getByRole('button', { name: '重试保存', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: '合成自提门店已新增' })).toBeVisible()
      const creates = await writes('POST')
      assert.equal(creates.length, 2)
      assert.deepEqual(creates[0].body, creates[1].body)
      assert.equal(creates[0].body.pickupEnabled, false)
      const created = await page.evaluate(() => window.__storeTest.read().rows.filter((row) => row.name === '合成自提门店'))
      assert.equal(created.length, 1)
      assert.equal(created[0].pickupEnabled, true)
      await expect(page.getByTestId(`managed-store-${created[0].key}`).getByText('支持顾客自提', { exact: true })).toBeVisible()
      pass('新增默认支持自提；响应丢失重试保持原 false 请求，无重复门店且不覆盖后续设置')

      await open()
      await page.getByRole('button', { name: '编辑北京官舍店', exact: true }).click()
      await expect(pickup).not.toBeChecked()
      await nameInput.fill('合成仅改名称')
      await save.click()
      await expect(page.getByRole('status').filter({ hasText: '合成仅改名称已保存' })).toBeVisible()
      let patch = (await writes('PATCH')).at(-1)
      assert.equal(Object.hasOwn(patch.body, 'pickupEnabled'), false)
      assert.equal((await page.evaluate(() => window.__storeTest.read())).rows.find((row) => row.key === 'guanshe').pickupEnabled, false)
      await page.getByRole('button', { name: '编辑合成仅改名称', exact: true }).click()
      await pickup.check()
      await districtInput.fill('保留编辑中的位置')
      await page.evaluate(() => window.__storeTest.status('xidan', false))
      await expect(pickup).toBeChecked()
      await expect(districtInput).toHaveValue('保留编辑中的位置')
      await save.click()
      await expect(page.getByRole('status').filter({ hasText: '合成仅改名称已保存' })).toBeVisible()
      patch = (await writes('PATCH')).at(-1)
      assert.equal(patch.body.pickupEnabled, true)
      assert.equal(Object.hasOwn(patch.body, 'active'), false)
      const row = page.getByTestId('managed-store-guanshe')
      await row.getByRole('switch').click()
      await expect(row.getByText('已停用', { exact: true })).toBeVisible()
      assert.deepEqual((await writes('PUT')).at(-1).body, { active: false })
      await expect(row.getByText('支持顾客自提', { exact: true })).toBeVisible()
      pass('编辑保留真实 false；仅显式修改附带自提值，目录更新保留草稿，总启停仍独立')

      await open()
      await page.evaluate(() => window.__storeTest.pickup('guanshe'))
      await page.getByRole('button', { name: '编辑北京官舍店', exact: true }).click()
      await nameInput.fill('未知设置时保留的名称')
      await districtInput.fill('未知设置时保留的位置')
      for (const value of [undefined, null, 'false']) {
        await page.evaluate((value) => window.__storeTest.pickup('guanshe', value), value)
        await expect(pickup).toBeDisabled()
        await expect(save).toBeDisabled()
        await expect(page.getByText('自提设置尚未核实，请刷新门店列表后编辑。', { exact: true })).toBeVisible()
        await page.getByRole('form', { name: '编辑门店', exact: true }).evaluate((form) => form.requestSubmit())
        assert.equal((await writes('PATCH')).length, 0)
      }
      await page.evaluate(() => window.__storeTest.pickup('guanshe', false))
      await expect(pickup).toBeEnabled()
      await expect(pickup).not.toBeChecked()
      await expect(nameInput).toHaveValue('未知设置时保留的名称')
      await expect(districtInput).toHaveValue('未知设置时保留的位置')
      await page.evaluate(() => window.__storeTest.pickup('guanshe', true))
      await expect(pickup).toBeChecked()
      await pickup.uncheck()
      await page.evaluate(() => window.__storeTest.fail('', 1))
      await page.getByRole('button', { name: '刷新门店列表' }).click()
      await expect(pickup).toBeDisabled()
      await expect(save).toBeDisabled()
      await page.getByRole('form', { name: '编辑门店', exact: true }).evaluate((form) => form.requestSubmit())
      assert.equal((await writes('PATCH')).length, 0)
      await page.getByRole('button', { name: '刷新门店列表' }).click()
      await expect(pickup).toBeEnabled()
      await expect(pickup).not.toBeChecked()
      await expect(nameInput).toHaveValue('未知设置时保留的名称')
      await save.click()
      await expect(page.getByRole('status').filter({ hasText: '未知设置时保留的名称已保存' })).toBeVisible()
      assert.equal((await writes('PATCH')).at(-1).body.pickupEnabled, false)
      pass('缺失/畸形/读取失败均阻断自提编辑和保存；刷新恢复真实值与用户草稿')

      for (const width of [320, 340, 375, 390, 430, 1024, 1440]) {
        await page.setViewportSize({ width, height: 844 })
        await page.getByRole('button', { name: '新增门店', exact: true }).click()
        await nameInput.fill('用于小屏幕显示检查的合成门店名称')
        await districtInput.fill('北京市朝阳区合成商圈 · 本地界面验证')
        await expect(pickup).toBeChecked()
        await expect(page.getByText('关闭后不可选择此处自提，收货和调拨照常使用。', { exact: true })).toBeVisible()
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${name} ${width}px overflow`)
        assert((await pickup.locator('..').boundingBox()).height >= 44, `${name} ${width}px pickup touch target`)
        assert((await save.boundingBox()).height >= 44, `${name} ${width}px save touch target`)
        await save.scrollIntoViewIfNeeded()
        assert((await save.boundingBox()).y >= 0, `${name} ${width}px save scroll access`)
        assert.equal(await page.getByText('门店类型', { exact: true }).count(), 0)
        assert.equal(await page.getByRole('switch').count(), 4)
        if ([390, 1440].includes(width)) await page.screenshot({ path: `/tmp/store-pickup-${name}-${width}.png`, fullPage: true })
        await page.getByRole('button', { name: '取消编辑门店' }).click()
      }
      assert.deepEqual(errors, [])
      assert.deepEqual(external, [])
      pass('320/340/375/390/430/iPad/桌面无横向溢出，触控及滚动可用，无额外开关和外部请求')
    } finally {
      await context.close()
      await browser.close()
    }
  }
  console.log(`Store pickup UI checks: ${results.length}/${results.length} PASS`)
} finally {
  await vite.close()
  await rm(cacheDir, { recursive: true, force: true })
}

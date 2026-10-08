import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chromium, webkit } from 'playwright-core'

const baseline = process.env.BUDU_RESIZE_BASELINE === '1'
const results = []
const rows = '#root [data-product-id]'
const aside = '#root aside'
async function swipe(page, cdp, from, to) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 700, y: from }] })
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 700, y: from + (to - from) * i / 12 }] })
    await page.waitForTimeout(25)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(300)
}
for (const [name, engine] of [['WebKit', webkit], ['Chromium native touch', chromium], ['Desktop WebKit boundary', webkit]]) {
  const browser = await engine.launch()
  const context = await browser.newContext({ viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: name !== 'Desktop WebKit boundary' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort())
  try {
    await page.goto('http://127.0.0.1:5299/tests/overlay-resize-dashboard-harness.html')
    const open = async () => {
      const bottom = page.getByRole('button', { name: '打开全部功能', exact: true })
      await (await bottom.isVisible() ? bottom : page.getByRole('button', { name: '打开菜单', exact: true })).click()
      await page.waitForFunction(() => document.body.style.position === 'fixed')
    }
    await open()
    await page.locator(aside).getByRole('button', { name: '门店经营', exact: true }).click()
    await page.locator(aside).getByRole('button', { name: /商品中心/ }).click()
    await page.locator(rows).first().waitFor()
    assert.equal(await page.locator(rows).count(), 87)
    await page.waitForFunction(() => document.body.style.position === '')
    await page.evaluate(() => window.scrollTo(0, 420))
    await open()
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.waitForFunction(() => innerWidth >= 1024)
    await page.waitForTimeout(250)
    const state = await page.evaluate(() => ({ position: document.body.style.position, overflow: document.documentElement.style.overflow, y: scrollY, innerWidth, clientWidth: document.documentElement.clientWidth, media: matchMedia('(min-width:1024px)').matches, backdropDisplay: getComputedStyle(document.querySelector('#root .fixed.inset-0.lg\\:hidden')).display }))
    if (name === 'Desktop WebKit boundary') {
      assert.equal(state.position === 'fixed', state.backdropDisplay !== 'none')
      await page.mouse.move(700, 500); await page.mouse.wheel(0, 500); await page.waitForTimeout(200)
      if (state.backdropDisplay !== 'none') assert.equal(await page.evaluate(() => scrollY), state.y)
      await page.setViewportSize({ width: 1366, height: 768 })
      await page.waitForFunction(() => document.body.style.position === '')
      await page.mouse.move(700, 500); await page.mouse.wheel(0, 500); await page.waitForTimeout(300)
      assert.ok(await page.evaluate(() => scrollY) > 100)
      await page.evaluate(() => {
        window.__lockTransitions = 0
        new MutationObserver(() => window.__lockTransitions++).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
      })
      for (const width of [1023, 1024, 1025, 1030, 1024, 1366]) {
        await page.setViewportSize({ width, height: 768 })
        await page.waitForTimeout(150)
        await page.waitForFunction(() => {
          const b = document.querySelector('#root .fixed.inset-0.lg\\:hidden')
          return (document.body.style.position === 'fixed') === (getComputedStyle(b).display !== 'none')
        })
      }
      const transitions = await page.evaluate(() => window.__lockTransitions)
      await page.waitForTimeout(400)
      assert.equal(await page.evaluate(() => window.__lockTransitions), transitions)
      assert.ok(transitions <= 12, `unexpected lock churn: ${transitions}`)
      await page.locator(aside).getByRole('button', { name: /商品中心/ }).click()
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.getByRole('button', { name: '分类管理', exact: true }).click()
      await page.waitForFunction(() => document.body.style.position === 'fixed')
      const lockedY = await page.evaluate(() => scrollY)
      await page.mouse.move(1300, 900); await page.mouse.wheel(0, 600); await page.waitForTimeout(200)
      assert.equal(await page.evaluate(() => scrollY), lockedY)
      await page.setViewportSize({ width: 1024, height: 768 })
      await page.waitForTimeout(200)
      assert.equal(await page.evaluate(() => document.body.style.position), 'fixed')
      await page.getByRole('dialog', { name: '分类管理' }).getByRole('button', { name: '关闭', exact: true }).click()
      await page.waitForFunction(() => document.body.style.position === '')
      assert.equal(await page.evaluate(() => document.documentElement.style.overflow), '')
      results.push({ name, result: 'PASS', state, nativeWheelRestored: true, modalResizeLocked: true, transitions, stableIdle: true })
      assert.deepEqual(errors, [])
      continue
    }
    assert.equal(state.backdropDisplay, 'none')
    const cdp = name.startsWith('Chromium') ? await context.newCDPSession(page) : null
    if (cdp) await swipe(page, cdp, 650, 200)
    else { await page.evaluate(() => window.scrollTo(0, 900)); await page.waitForTimeout(100) }
    const after = await page.evaluate(() => scrollY)
    if (baseline) {
      assert.equal(state.position, 'fixed')
      assert.equal(state.overflow, 'hidden')
      if (cdp) assert.equal(after, state.y)
      results.push({ name, result: 'BASELINE_FAILURE_REPRODUCED', state, after })
    } else {
      assert.equal(state.position, '')
      assert.notEqual(state.overflow, 'hidden')
      assert.ok(after > state.y, `scroll did not advance: ${state.y} → ${after}`)
      if (cdp) { await swipe(page, cdp, 250, 550); assert.ok(await page.evaluate(() => scrollY) < after) }
      for (const width of [1023, 1024, 768, 1366]) {
        await page.setViewportSize({ width, height: 768 })
        await page.waitForFunction(locked => (document.body.style.position === 'fixed') === locked, width < 1024)
      }
      await page.setViewportSize({ width: 768, height: 1024 })
      await page.waitForFunction(() => document.body.style.position === 'fixed')
      await page.locator(aside).getByRole('button', { name: /商品中心/ }).click()
      await page.waitForFunction(() => document.body.style.position === '')
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.getByRole('button', { name: '分类管理', exact: true }).click()
      await page.waitForFunction(() => document.body.style.position === 'fixed')
      await page.setViewportSize({ width: 1366, height: 1024 })
      await page.waitForTimeout(200)
      assert.equal(await page.evaluate(() => document.body.style.position), 'fixed')
      await page.getByRole('dialog', { name: '分类管理' }).getByRole('button', { name: '关闭', exact: true }).click()
      await page.waitForFunction(() => document.body.style.position === '')
      assert.equal(await page.locator(rows).count(), 87)
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('budu-overlay-open')), false)
      results.push({ name, result: 'PASS', state, after, modalResizeLocked: true })
    }
    assert.deepEqual(errors, [])
  } finally { await context.close(); await browser.close() }
}
await fs.mkdir('output/overlay-resize', { recursive: true })
await fs.writeFile(`output/overlay-resize/${baseline ? 'baseline' : 'fixed'}.json`, JSON.stringify({ results }, null, 2))
console.log(JSON.stringify(results, null, 2))

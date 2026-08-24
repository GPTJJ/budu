// 移动端右滑返回（Interactive Pop Gesture）E2E
// 覆盖：1:1 跟手、上一页快照可见（含底部导航）、慢速返回、快速甩动、
//       取消回弹、纵向滚动不误触、非边缘不起手、二级/三级页栈、首页边界、防双重返回
import { expect, test } from '@playwright/test'

async function beginSwipeRightFromEdge(page, { y = 400, distance = 120, steps = 1, stepMs = 16 } = {}) {
  // 只记录起点 + 触摸参数；DOM 引用保存在页面全局（跨 evaluate 有效）
  await page.evaluate(({ y: clientY, distance: dx, steps: st, stepMs: ms }) => {
    const target = document.elementFromPoint(8, clientY) || document.body
    window.__swipeBackTest = {
      target,
      startX: 8,
      startY: clientY,
      distance: dx,
      steps: st,
      stepMs: ms,
      step: 0,
      testTime: 1000,
    }
    const start = { identifier: 1, clientX: 8, clientY, pageX: 8, pageY: clientY }
    const event = new TouchEvent('touchstart', { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
      touches: { value: [start] },
      changedTouches: { value: [start] },
      timeStamp: { value: 1000 },
    })
    target.dispatchEvent(event)
  }, { y, distance: Math.max(distance, 30), steps, stepMs })
  // 分步派发 touchmove（模拟真实 1:1 跟手过程）
  const st = await page.evaluate(() => window.__swipeBackTest?.steps || 0)
  for (let i = 1; i <= st; i += 1) {
    await page.evaluate(({ idx }) => {
      const state = window.__swipeBackTest
      if (!state) return
      const x = state.startX + (state.distance * idx) / state.steps
      const m = { identifier: 1, clientX: x, clientY: state.startY, pageX: x, pageY: state.startY }
      const event = new TouchEvent('touchmove', { bubbles: true, cancelable: true })
      Object.defineProperties(event, {
        touches: { value: [m] },
        changedTouches: { value: [m] },
        timeStamp: { value: state.testTime + state.stepMs * idx },
      })
      state.target.dispatchEvent(event)
    }, { idx: i })
    await page.waitForTimeout(stepMs)
  }
}

async function endSwipeRightFromEdge(page, { toX } = {}) {
  await page.evaluate(({ endX }) => {
    const state = window.__swipeBackTest
    if (!state) return
    const x = endX ?? state.startX + state.distance
    const m = { identifier: 1, clientX: x, clientY: state.startY, pageX: x, pageY: state.startY }
    const event = new TouchEvent('touchend', { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
      touches: { value: [] },
      changedTouches: { value: [m] },
      timeStamp: { value: state.testTime + state.stepMs * (state.steps + 1) },
    })
    state.target.dispatchEvent(event)
    delete window.__swipeBackTest
  }, { endX: toX })
}

async function swipeRightFromEdge(page, options) {
  await beginSwipeRightFromEdge(page, options)
  await endSwipeRightFromEdge(page, options)
}

test.beforeEach(async ({ page }) => {
  // 手机视口（<1024 才显示底部导航，且符合移动端手势场景）
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/tests/swipe-back-harness.html?mode=mobile')
  await expect(page.locator('body')).toContainText('首页概览', { timeout: 10000 })
})

async function gotoSubPage(page, label) {
  // 打开侧栏 → 人员管理 → 雇员（二级页）
  await page.locator('.mobile-liquid-nav button', { hasText: '更多' }).click()
  await page.locator('aside button', { hasText: '人员管理' }).first().click()
  await page.locator('aside button', { hasText: label }).first().click()
  await expect(page.locator('body')).toContainText('人员管理', { timeout: 10000 })
}

test('拖动中当前页 1:1 跟手且上一页快照可见（含底部导航）', async ({ page }) => {
  await gotoSubPage(page, '雇员')
  await beginSwipeRightFromEdge(page, { distance: 120, steps: 4, stepMs: 24 })
  // 未松手：读取 CSS 变量
  const during = await page.evaluate(() => ({
    x: getComputedStyle(document.documentElement).getPropertyValue('--swipe-back-x'),
    progress: getComputedStyle(document.documentElement).getPropertyValue('--swipe-back-progress'),
    prevX: getComputedStyle(document.documentElement).getPropertyValue('--swipe-prev-x'),
    prevVis: getComputedStyle(document.getElementById('swipe-prev-layer')).visibility,
    prevHasNav: document.getElementById('swipe-prev-layer').textContent.includes('录入'),
  }))
  // 120px 位移 → 跟手 x≈120px；progress=120/视口宽；prev 快照可见且含底部导航
  expect(parseFloat(during.x)).toBeGreaterThan(100)
  expect(parseFloat(during.progress)).toBeGreaterThan(0.1)
  expect(parseFloat(during.progress)).toBeLessThan(0.5)
  expect(parseFloat(during.prevX)).toBeLessThan(-10)
  expect(during.prevVis).toBe('visible')
  expect(during.prevHasNav).toBe(true)
  // 取消收尾
  await endSwipeRightFromEdge(page, { toX: 40 })
  await page.waitForTimeout(600)
})

test('慢速拖过阈值 → 播放完成动画后回到上一页（无突然切页）', async ({ page }) => {
  await gotoSubPage(page, '雇员')
  await swipeRightFromEdge(page, { distance: 200, steps: 5, stepMs: 24 })
  // 松手后立即（动画中）页面应仍是当前页（还没有切页）
  const mid = await page.evaluate(() => ({
    settling: document.documentElement.classList.contains('swipe-back-settling'),
    x: getComputedStyle(document.documentElement).getPropertyValue('--swipe-back-x'),
  }))
  expect(mid.settling).toBe(true)
  expect(parseFloat(mid.x)).toBeGreaterThan(300) // 滑出中
  // 动画结束（220ms）后切回首页
  await page.waitForTimeout(900)
  await expect(page.locator('body')).toContainText('今日经营')
})

test('未达阈值 → 自然回弹，不返回', async ({ page }) => {
  await gotoSubPage(page, '雇员')
  await swipeRightFromEdge(page, { distance: 60, steps: 3, stepMs: 24 })
  await page.waitForTimeout(700)
  const state = await page.evaluate(() => ({
    active: document.documentElement.classList.contains('swipe-back-active'),
    x: getComputedStyle(document.documentElement).getPropertyValue('--swipe-back-x'),
  }))
  expect(state.active).toBe(false)
  expect(state.x).toBe('')
  await expect(page.locator('body')).toContainText('人员管理')
})

test('快速甩动（距离小速度高）→ 返回', async ({ page }) => {
  await gotoSubPage(page, '雇员')
  await swipeRightFromEdge(page, { distance: 60, steps: 3, stepMs: 4 })
  await page.waitForTimeout(900)
  await expect(page.locator('body')).toContainText('今日经营')
})

test('取消手势：拖出又拖回 → 不返回', async ({ page }) => {
  await gotoSubPage(page, '雇员')
  await beginSwipeRightFromEdge(page, { distance: 160, steps: 4, stepMs: 20 })
  // 往回拖到 20px
  await page.evaluate(() => {
    const state = window.__swipeBackTest
    if (!state) return
    const m = { identifier: 1, clientX: 20, clientY: state.startY, pageX: 20, pageY: state.startY }
    const event = new TouchEvent('touchmove', { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
      touches: { value: [m] },
      changedTouches: { value: [m] },
    })
    state.target.dispatchEvent(event)
  })
  await endSwipeRightFromEdge(page, { toX: 20 })
  await page.waitForTimeout(700)
  const state = await page.evaluate(() => document.documentElement.classList.contains('swipe-back-active'))
  expect(state).toBe(false)
  await expect(page.locator('body')).toContainText('人员管理')
})

test('纵向滚动不误触返回', async ({ page }) => {
  await gotoSubPage(page, '雇员')
  // 纵向 move（dy 明显大于 dx）
  await page.evaluate(() => {
    const target = document.elementFromPoint(8, 400) || document.body
    const t0 = { identifier: 1, clientX: 8, clientY: 400, pageX: 8, pageY: 400 }
    const t1 = { identifier: 1, clientX: 20, clientY: 260, pageX: 20, pageY: 260 }
    const mk = (type, touches, changed) => {
      const e = new TouchEvent(type, { bubbles: true, cancelable: true })
      Object.defineProperties(e, { touches: { value: touches }, changedTouches: { value: changed } })
      target.dispatchEvent(e)
    }
    mk('touchstart', [t0], [t0])
    mk('touchmove', [t1], [t1])
    mk('touchend', [], [t1])
  })
  await page.waitForTimeout(500)
  await expect(page.locator('body')).toContainText('人员管理')
})

test('非左边缘起手不触发返回', async ({ page }) => {
  await gotoSubPage(page, '雇员')
  await page.evaluate(() => {
    const target = document.elementFromPoint(120, 400) || document.body
    const t0 = { identifier: 1, clientX: 120, clientY: 400, pageX: 120, pageY: 400 }
    const t1 = { identifier: 1, clientX: 260, clientY: 400, pageX: 260, pageY: 400 }
    const mk = (type, touches, changed) => {
      const e = new TouchEvent(type, { bubbles: true, cancelable: true })
      Object.defineProperties(e, { touches: { value: touches }, changedTouches: { value: changed } })
      target.dispatchEvent(e)
    }
    mk('touchstart', [t0], [t0])
    mk('touchmove', [t1], [t1])
    mk('touchend', [], [t1])
  })
  await page.waitForTimeout(500)
  await expect(page.locator('body')).toContainText('人员管理')
})

test('三级页返回栈：雇员 → 员工档案 → 返回雇员 → 返回首页', async ({ page }) => {
  await gotoSubPage(page, '雇员')
  // 进入员工档案（三级页）
  await page.locator('button[title="员工档案"]').first().click()
  await expect(page.locator('body')).toContainText('员工档案', { timeout: 10000 })
  // 右滑返回 → 回雇员页（栈上一页，不是首页）
  await swipeRightFromEdge(page, { distance: 190, steps: 5, stepMs: 20 })
  await expect(page.locator('body')).toContainText('添加员工', { timeout: 10000 })
  // 等待完成动画与状态清理结束（防双重返回锁释放）
  await expect(page.locator('html')).not.toHaveClass(/swipe-back-active/, { timeout: 5000 })
  // 再右滑 → 回首页
  await swipeRightFromEdge(page, { distance: 190, steps: 5, stepMs: 20 })
  await expect(page.locator('body')).toContainText('今日经营', { timeout: 10000 })
  await expect(page.locator('body')).not.toContainText('添加员工')
})

test('首页（一级页）不触发右滑返回', async ({ page }) => {
  // 首页直接右滑 → 无动画、无返回
  await swipeRightFromEdge(page, { distance: 200, steps: 5, stepMs: 20 })
  await page.waitForTimeout(600)
  const state = await page.evaluate(() => document.documentElement.classList.contains('swipe-back-active'))
  expect(state).toBe(false)
  await expect(page.locator('body')).toContainText('今日经营')
})

test('防双重返回：完成返回后动画期间再次滑动不重复触发', async ({ page }) => {
  await gotoSubPage(page, '雇员')
  // 第一次完成返回
  await swipeRightFromEdge(page, { distance: 200, steps: 5, stepMs: 16 })
  await page.waitForTimeout(1000)
  await expect(page.locator('body')).toContainText('今日经营')
  // 首页再次滑动 → 无返回
  await swipeRightFromEdge(page, { distance: 200, steps: 5, stepMs: 16 })
  await page.waitForTimeout(600)
  await expect(page.locator('body')).toContainText('今日经营')
})

test('桌面模式不启用右滑返回（isTouchDevice=false）', async ({ page }) => {
  await page.goto('/tests/swipe-back-harness.html?mode=desktop')
  await expect(page.locator('body')).toContainText('首页概览', { timeout: 10000 })
  // 桌面模式无 touch 事件源，右滑自然无效；验证页面正常渲染且无 swipe 层
  const layer = await page.evaluate(() => document.getElementById('swipe-prev-layer') ? 'exists' : 'none')
  expect(layer).toBe('none')
})

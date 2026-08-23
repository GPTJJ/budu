import test from 'node:test'
import assert from 'node:assert/strict'
import { isSwipeBackGesture, shouldCompleteSwipe } from '../src/utils/swipeBack.js'

const base = { startX: 18, startY: 300, endX: 120, endY: 308, duration: 280 }
const vw = 390 // iPhone 尺寸

test('左侧边缘快速右滑可以返回', () => {
  assert.equal(isSwipeBackGesture(base), true)
})

test('非边缘起手、距离不足或反向滑动不会返回', () => {
  assert.equal(isSwipeBackGesture({ ...base, startX: 50 }), false)
  assert.equal(isSwipeBackGesture({ ...base, endX: 70 }), false)
  assert.equal(isSwipeBackGesture({ ...base, endX: 0 }), false)
})

test('纵向滚动和过慢手势不会误触返回', () => {
  assert.equal(isSwipeBackGesture({ ...base, endX: 110, endY: 390 }), false)
  assert.equal(isSwipeBackGesture({ ...base, duration: 1200 }), false)
})

test('慢速拖拽：超过屏宽 28% 完成返回', () => {
  const dx = vw * 0.3 // 117px
  assert.equal(shouldCompleteSwipe({ dx, viewportWidth: vw, velocityX: 0.1 }), true)
  assert.equal(shouldCompleteSwipe({ dx: vw * 0.2, viewportWidth: vw, velocityX: 0.1 }), false)
})

test('快速甩动：距离不大但速度足够也返回', () => {
  // 40px 位移、0.9px/ms（900px/s）快速甩动 → 返回
  assert.equal(shouldCompleteSwipe({ dx: 40, viewportWidth: vw, velocityX: 0.9 }), true)
  // 距离过小（<24px）即使速度快也不返回
  assert.equal(shouldCompleteSwipe({ dx: 15, viewportWidth: vw, velocityX: 1.5 }), false)
})

test('速度慢且距离不足时回弹（不返回）', () => {
  assert.equal(shouldCompleteSwipe({ dx: 60, viewportWidth: vw, velocityX: 0.2 }), false)
})

test('进度边界：0 或负位移不返回', () => {
  assert.equal(shouldCompleteSwipe({ dx: 0, viewportWidth: vw, velocityX: 0 }), false)
  assert.equal(shouldCompleteSwipe({ dx: -20, viewportWidth: vw, velocityX: 0 }), false)
})

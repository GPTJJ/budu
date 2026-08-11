import test from 'node:test'
import assert from 'node:assert/strict'
import { isSwipeBackGesture } from '../src/utils/swipeBack.js'

const base = { startX: 18, startY: 300, endX: 120, endY: 308, duration: 280 }

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


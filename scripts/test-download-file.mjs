// 下载工具（iOS Web Share / 非 iOS anchor）单元测试
import test from 'node:test'
import assert from 'node:assert/strict'
import { isIOS } from '../src/utils/downloadFile.js'

test('桌面 Chrome UA 判定为非 iOS', () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  const original = globalThis.navigator
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: ua, platform: 'MacIntel', maxTouchPoints: 0 },
    configurable: true,
  })
  assert.equal(isIOS(), false)
  Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true })
})

test('iPhone UA 判定为 iOS', () => {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  const original = globalThis.navigator
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: ua, platform: 'iPhone', maxTouchPoints: 5 },
    configurable: true,
  })
  assert.equal(isIOS(), true)
  Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true })
})

test('iPadOS 13+ 伪装桌面 UA（触屏 Mac）判定为 iOS', () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
  const original = globalThis.navigator
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: ua, platform: 'MacIntel', maxTouchPoints: 5 },
    configurable: true,
  })
  assert.equal(isIOS(), true)
  Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true })
})

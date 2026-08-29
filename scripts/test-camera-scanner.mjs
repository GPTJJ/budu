import test from 'node:test'
import assert from 'node:assert/strict'
import { cameraErrorMessage, isValidAlipayAuthCode, isValidWechatAuthCode, normalizeAuthCode } from '../src/utils/cameraScanner.js'

test('付款码只在内存中规范化并拒绝异常内容', () => {
  assert.equal(normalizeAuthCode('  134567890123456789  '), '134567890123456789')
  assert.equal(normalizeAuthCode('12345'), '')
  assert.equal(normalizeAuthCode(`123456\n789`), '')
  assert.equal(normalizeAuthCode('x'.repeat(513)), '')
})

test('摄像头错误转换为员工可理解的中文提示', () => {
  assert.match(cameraErrorMessage({ name: 'NotAllowedError' }), /权限被拒绝/)
  assert.match(cameraErrorMessage({ name: 'NotFoundError' }), /没有找到/)
  assert.match(cameraErrorMessage({ name: 'NotReadableError' }), /其他应用占用/)
  assert.match(cameraErrorMessage({ name: 'SecurityError' }), /HTTPS/)
  assert.match(cameraErrorMessage(new Error('unknown')), /启动失败/)
})

test('真实付款码按渠道执行前端格式校验', () => {
  assert.equal(isValidWechatAuthCode('130123456789012345'), true)
  assert.equal(isValidWechatAuthCode('990123456789012345'), false)
  assert.equal(isValidAlipayAuthCode('287634438256643948'), true)
  assert.equal(isValidAlipayAuthCode('287634438256643x48'), false)
  assert.equal(isValidAlipayAuthCode('12345'), false)
})

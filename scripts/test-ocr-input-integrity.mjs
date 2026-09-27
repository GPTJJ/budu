import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { correlateOcrRequest, fingerprintOcrImage } from '../server/ocr-integrity.js'
import { createOcrRequestId, fingerprintImageDataUrl, isMatchingOcrResponse, sha256Hex } from '../src/utils/ocrIntegrity.js'

const imageDataUrl = (content) => `data:image/png;base64,${Buffer.from(content).toString('base64')}`

test('client and server produce the same SHA-256 fingerprint for the uploaded image bytes', async () => {
  const payload = imageDataUrl('synthetic-image-a')
  const expected = createHash('sha256').update('synthetic-image-a').digest('hex')
  assert.equal(await fingerprintImageDataUrl(payload), expected)
  assert.equal(fingerprintOcrImage(payload), expected)
})

test('different images have different fingerprints while same-file reselect remains stable', async () => {
  const first = await fingerprintImageDataUrl(imageDataUrl('synthetic-image-a'))
  const second = await fingerprintImageDataUrl(imageDataUrl('synthetic-image-b'))
  assert.notEqual(first, second)
  assert.equal(first, await fingerprintImageDataUrl(imageDataUrl('synthetic-image-a')))
})

test('server validates the supplied fingerprint and echoes safe request correlation', async () => {
  const imageBase64 = imageDataUrl('synthetic-image-a')
  const fileFingerprint = fingerprintOcrImage(imageBase64)
  assert.deepEqual(correlateOcrRequest({ imageBase64, fileFingerprint, requestId: 'ocr-7-safe' }), {
    requestId: 'ocr-7-safe',
    fileFingerprint,
  })
  assert.throws(
    () => correlateOcrRequest({ imageBase64, fileFingerprint: '0'.repeat(64), requestId: 'ocr-8-safe' }),
    /图片指纹校验失败/,
  )
})

test('a response can mutate state only when generation, fingerprint, and request id all match', () => {
  const expected = { generation: 3, fileFingerprint: 'a'.repeat(64), requestId: 'ocr-3-safe' }
  assert.equal(isMatchingOcrResponse(expected, expected, expected), true)
  assert.equal(isMatchingOcrResponse({ ...expected, generation: 4 }, expected, expected), false)
  assert.equal(isMatchingOcrResponse(expected, expected, { ...expected, requestId: 'ocr-2-stale' }), false)
  assert.equal(isMatchingOcrResponse(expected, expected, { ...expected, fileFingerprint: 'b'.repeat(64) }), false)
})

test('OCR raw text and parser input use the exact same fingerprint source', async () => {
  const rawText = '测试姓名\n13800000000\n测试市测试路1号'
  assert.equal(await sha256Hex(rawText), await sha256Hex(rawText))
})

test('request ids change by generation even when the same file is selected again', () => {
  const fingerprint = 'a'.repeat(64)
  const first = createOcrRequestId(1, fingerprint)
  const second = createOcrRequestId(2, fingerprint)
  assert.match(first, /^ocr-1-aaaaaaaaaaaa-/)
  assert.match(second, /^ocr-2-aaaaaaaaaaaa-/)
  assert.notEqual(first, second)
})

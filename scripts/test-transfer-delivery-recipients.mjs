import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTransferDeliverySummaries, summarizeTransferDeliveries } from '../server/transfer-delivery-recipients.js'
import { getInventoryRequests, loadUserData, resetUserData } from '../src/utils/userData.js'

const notification = (id, refId, username, templateKey = 'transfer_new') => ({
  id, refType: 'transfer', refId, templateKey, username,
})
const delivery = (notificationId, channel, status, error = '') => ({ notificationId, channel, status, error })

test('single and multiple successful personal deliveries use persisted notification targets', () => {
  const result = summarizeTransferDeliveries([
    notification('n-1', 'tr-single', '陈文慧'),
    notification('n-2', 'tr-multi', '陈文慧'),
    notification('n-3', 'tr-multi', '隋晓'),
    notification('n-4', 'tr-multi', '舒敏'),
  ], [
    delivery('n-1', 'wecom_individual', 'sent'),
    delivery('n-2', 'wechat', 'sent'),
    delivery('n-3', 'wecom_individual', 'sent'),
    delivery('n-4', 'wecom_individual', 'sent'),
  ])
  assert.deepEqual(result.get('tr-single').successful.map((row) => row.label), ['陈文慧'])
  assert.deepEqual(result.get('tr-multi').successful.map((row) => row.label), ['陈文慧', '舒敏', '隋晓'])
})

test('fallback group and developer are derived from actual delivery rows', () => {
  const result = summarizeTransferDeliveries([
    notification('n-fallback', 'tr-fallback', 'budu'),
  ], [
    delivery('n-fallback', 'inapp', 'sent'),
    delivery('n-fallback', 'wecom_group_robot', 'sent'),
    delivery('n-fallback', 'wecom_individual', 'sent'),
  ]).get('tr-fallback')
  assert.deepEqual(result.successful.map((row) => row.label), ['企业微信群机器人', '开发者'])
  assert.equal(result.undelivered.length, 0)
})

test('skipped and failed recipients never appear as successful', () => {
  const result = summarizeTransferDeliveries([
    notification('n-ok', 'tr-partial', '陈文慧'),
    notification('n-skip', 'tr-partial', '舒敏'),
    notification('n-fail', 'tr-partial', '隋晓'),
  ], [
    delivery('n-ok', 'wecom_individual', 'sent'),
    delivery('n-skip', 'wecom_individual', 'skipped', 'no binding'),
    delivery('n-fail', 'wecom_individual', 'failed', 'send failed (errcode=45009)'),
  ]).get('tr-partial')
  assert.deepEqual(result.successful.map((row) => row.label), ['陈文慧'])
  assert.deepEqual(result.undelivered.map((row) => [row.label, row.reason]), [
    ['舒敏', 'NO_WECOM_BINDING'],
    ['隋晓', 'DELIVERY_FAILED'],
  ])
})

test('shipment notifications and in-app deliveries are excluded', () => {
  const result = summarizeTransferDeliveries([
    notification('n-submit', 'tr-1', '陈文慧'),
    notification('n-shipped', 'tr-1', '申请人', 'transfer_shipped'),
  ], [
    delivery('n-submit', 'inapp', 'sent'),
    delivery('n-shipped', 'wechat', 'sent'),
  ])
  assert.equal(result.has('tr-1'), false)
})

test('loader queries only requested transfer page ids and returns no fabricated history', async () => {
  const calls = []
  const prisma = {
    notification: { findMany: async (query) => {
      calls.push(['notification', query])
      return [notification('n-page', 'tr-page-2', '陈文慧')]
    } },
    notificationDelivery: { findMany: async (query) => {
      calls.push(['delivery', query])
      return [delivery('n-page', 'wecom_individual', 'sent')]
    } },
  }
  const result = await loadTransferDeliverySummaries(prisma, ['tr-page-1', 'tr-page-2', 'tr-page-2'])
  assert.deepEqual(calls[0][1].where.refId.in, ['tr-page-1', 'tr-page-2'])
  assert.equal(result.has('tr-page-1'), false)
  assert.equal(result.get('tr-page-2').successful[0].label, '陈文慧')
})

test('frontend authority cache preserves the delivery read model returned by PostgreSQL API', async () => {
  const originalFetch = globalThis.fetch
  const deliveryRecipients = {
    source: 'notification_delivery',
    successful: [{ key: 'user:chen', type: 'individual', label: '陈文慧', status: 'sent' }],
    undelivered: [],
  }
  globalThis.fetch = async (input) => {
    const path = String(input)
    const data = path === '/api/userdata'
      ? {}
      : path === '/api/v2/transfer-requests'
        ? { rows: [{ id: 'tr-cache', storeKey: 'guanshe', fromStoreKey: 'tongying', status: 'pending', items: [], deliveryRecipients }] }
        : { rows: [] }
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    resetUserData()
    await loadUserData({ userId: 'delivery-cache-test' })
    assert.deepEqual(getInventoryRequests()[0].deliveryRecipients, deliveryRecipients)
  } finally {
    resetUserData()
    globalThis.fetch = originalFetch
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { shipLegacyArchiveOrder, toShippingStatus } from '../server/mini-program-legacy-shipping.js'

// 背景：小程序订单原来只能在「我的 → 商家管理」发货，OS 订单页看不到也发不了。
// 这里锁死 OS 直接发货的四条底线：
//   1) 先写云端权威（条件更新，防并发/重复），再 best-effort 同步微信；
//   2) 微信失败绝不回滚发货；
//   3) 已发货重复提交是幂等 no-op，不换运单号；
//   4) 自提/未知承运商/错误状态一律本地拒绝。

function fakePrisma(row) {
  const state = { row: { ...row } }
  return {
    state,
    onlineOrderArchive: {
      async findUnique() { return state.row },
      async update({ data }) { Object.assign(state.row, data); return state.row },
    },
  }
}

function fakeCloud(initial) {
  const state = { doc: { ...initial }, updates: [], lastWhere: null }
  const matches = (doc, where) => Object.entries(where).every(([k, v]) => doc[k] === v)
  const collection = {
    where(where) {
      state.lastWhere = where
      return {
        limit() { return this },
        async get() { return { data: matches(state.doc, where) ? [state.doc] : [] } },
        async update({ data }) {
          if (!matches(state.doc, where)) return { stats: { updated: 0 } }
          Object.assign(state.doc, data)
          state.updates.push(data)
          return { stats: { updated: 1 } }
        },
      }
    },
    doc() {
      return { async update({ data }) { Object.assign(state.doc, data); state.updates.push(data); return { stats: { updated: 1 } } } }
    },
  }
  return {
    state,
    database() { return { serverDate: () => 'SERVER_DATE', collection: () => collection } },
  }
}

const archiveRow = (over = {}) => ({
  payNo: 'B0001',
  status: 'PENDING_SHIPMENT',
  deliveryType: 'delivery',
  carrier: '',
  trackingNo: '',
  shippedAt: null,
  ...over,
})

const orderDoc = (over = {}) => ({
  _id: 'doc-1',
  payNo: 'B0001',
  status: 'PENDING_SHIPMENT',
  openid: 'openid-owner',
  transactionId: 'TX-0001',
  recipient: { contact: '13800001234' },
  items: [{ productName: '12颗礼盒', qty: 1 }],
  ...over,
})

test('OS 发货：写云端 + 归档，并把微信同步标记为 SYNCED', async () => {
  const prisma = fakePrisma(archiveRow())
  const cloud = fakeCloud(orderDoc())
  let uploadInput = null
  const result = await shipLegacyArchiveOrder({
    payNo: 'B0001', carrierCode: 'SF', trackingNo: 'SF1234567890',
    prisma, cloudbase: cloud,
    upload: async (input) => { uploadInput = input; return { status: 'ACCEPTED', code: 0 } },
  })

  assert.equal(result.ok, true)
  assert.equal(result.status, 'SHIPPED')
  assert.equal(result.wechat.status, 'SYNCED')
  assert.equal(cloud.state.doc.status, 'SHIPPED')
  assert.equal(cloud.state.doc.carrier, 'SF')
  assert.equal(cloud.state.doc.trackingNo, 'SF1234567890')
  assert.equal(cloud.state.doc.wechatShippingStatus, 'SYNCED')
  assert.equal(prisma.state.row.status, 'SHIPPED')
  assert.equal(prisma.state.row.trackingNo, 'SF1234567890')
  // 顺丰必须带掩码后的联系方式
  assert.equal(uploadInput.deliveryId, 'SF')
  assert.equal(uploadInput.receiverContact, '138****1234')
  assert.equal(uploadInput.transactionId, 'TX-0001')
})

test('OS 发货：微信上传抛错也不回滚发货', async () => {
  const prisma = fakePrisma(archiveRow())
  const cloud = fakeCloud(orderDoc())
  const result = await shipLegacyArchiveOrder({
    payNo: 'B0001', carrierCode: 'ZTO', trackingNo: 'ZTO12345678',
    prisma, cloudbase: cloud,
    upload: async () => { throw new Error('network down') },
  })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'SHIPPED')
  assert.equal(cloud.state.doc.status, 'SHIPPED')
  assert.equal(cloud.state.doc.wechatShippingStatus, 'PENDING')
})

test('OS 发货：已发货且运单号相同 → 幂等，不再次上传', async () => {
  const prisma = fakePrisma(archiveRow({ status: 'SHIPPED', carrier: 'SF', trackingNo: 'SF1234567890' }))
  const cloud = fakeCloud(orderDoc({ status: 'SHIPPED', carrier: 'SF', trackingNo: 'SF1234567890' }))
  let called = 0
  const result = await shipLegacyArchiveOrder({
    payNo: 'B0001', carrierCode: 'SF', trackingNo: 'SF1234567890',
    prisma, cloudbase: cloud, upload: async () => { called += 1; return { status: 'ACCEPTED' } },
  })
  assert.equal(result.idempotent, true)
  assert.equal(called, 0)
})

test('OS 发货：自提订单、未知承运商、非待发货状态都被拒绝', async () => {
  const pickup = await shipLegacyArchiveOrder({
    payNo: 'B0001', carrierCode: 'SF', trackingNo: 'SF1234567890',
    prisma: fakePrisma(archiveRow({ deliveryType: 'pickup' })), cloudbase: fakeCloud(orderDoc()),
  }).catch((error) => error)
  assert.equal(pickup.status, 409)

  const carrier = await shipLegacyArchiveOrder({
    payNo: 'B0001', carrierCode: 'XX', trackingNo: 'SF1234567890',
    prisma: fakePrisma(archiveRow()), cloudbase: fakeCloud(orderDoc()),
  }).catch((error) => error)
  assert.equal(carrier.status, 400)

  const cancelled = await shipLegacyArchiveOrder({
    payNo: 'B0001', carrierCode: 'SF', trackingNo: 'SF1234567890',
    prisma: fakePrisma(archiveRow({ status: 'CANCELLED' })), cloudbase: fakeCloud(orderDoc()),
  }).catch((error) => error)
  assert.equal(cancelled.status, 409)
})

test('微信结果映射：只把明确接受当成功', () => {
  assert.deepEqual(toShippingStatus({ status: 'ACCEPTED' }), { status: 'SYNCED', code: 0 })
  assert.deepEqual(toShippingStatus({ status: 'ALREADY_ACCEPTED', code: 10060003 }), { status: 'SYNCED', code: 0 })
  assert.deepEqual(toShippingStatus({ status: 'PENDING', code: 10060012 }), { status: 'PENDING', code: 10060012 })
  assert.deepEqual(toShippingStatus({ status: 'FAILED', code: 10060004 }), { status: 'UNSUPPORTED', code: 10060004 })
  assert.deepEqual(toShippingStatus(null), { status: 'UNSUPPORTED', code: 0 })
})

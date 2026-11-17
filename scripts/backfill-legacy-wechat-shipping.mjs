/**
 * 补录历史订单的微信「发货信息」。
 *
 * 背景：
 *   - 2026-09 之前发货路径根本没上传（13 笔 `wechatShippingStatus` 未写）；
 *   - 之后上传了但代码读错字段名（`errcode` vs `errCode`），微信实际可能已收下，
 *     我们却记成 PENDING（23 笔），`wechatShippingCode` 还是 "NaN"。
 * 本次把两类都补一次：
 *   - 已收下的重复上传会返回 10060023（已发货，请勿重复），属「正确终态」，我们记为 SYNCED；
 *   - 从未上传的，这是第一次上传；失败只记 UNSUPPORTED，不影响订单本身。
 *
 * 安全边界：
 *   - 只处理 SHIPPED / COMPLETED 且非 SYNCED 的订单；
 *   - 缺 transactionId / 运单号 / 承运商映射的一律跳过（绝不编造事实）；
 *   - 默认预演，`--apply` 才写。
 *
 * 运行（必须在生产容器内，那里才有小程序密钥与 TCB 凭据）：
 *   docker cp scripts/backfill-legacy-wechat-shipping.mjs <container>:/tmp/backfill.mjs
 *   docker exec <container> node /tmp/backfill.mjs            # 预演
 *   docker exec <container> node /tmp/backfill.mjs --apply    # 写入
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { createWechatShippingInfo, toWechatReceiverContact } from '/app/server/wechat-shipping-info.js'
import { resolveShippingDeliveryId, shippingCarrierRequiresContact } from '/app/server/wechat-delivery-codes.js'

const apply = process.argv.includes('--apply')
const appId = String(process.env.SWEET_CARD_WECHAT_APP_ID || '').trim()
const secretFile = String(process.env.SWEET_CARD_WECHAT_APP_SECRET_FILE || '').trim()
if (!appId || !secretFile) {
  console.error('缺少 SWEET_CARD_WECHAT_APP_ID / SWEET_CARD_WECHAT_APP_SECRET_FILE（需在容器内运行）')
  process.exit(2)
}
const appSecret = fs.readFileSync(secretFile, 'utf8').trim()

const require = createRequire('/app/package.json')
const tcb = require('@cloudbase/node-sdk')
const app = tcb.init({
  env: process.env.TCB_ENV_ID,
  secretId: process.env.TCB_SECRET_ID,
  secretKey: process.env.TCB_SECRET_KEY,
})
const db = app.database({ throwOnNotFound: false })
const shipping = createWechatShippingInfo({ config: { appId, appSecret } })

function itemDescOf(items) {
  const parts = []
  for (const item of Array.isArray(items) ? items : []) {
    const name = String(item.productName || item.name || '').trim()
    if (!name) continue
    const qty = Number(item.qty || item.quantity)
    parts.push(qty > 0 ? `${name}*${qty}` : name)
  }
  const joined = parts.join('; ')
  if (!joined) return ''
  return joined.length <= 120 ? joined : `${joined.slice(0, 117)}...`
}

async function scanOrders() {
  const docs = []
  let skip = 0
  while (true) {
    const res = await db.collection('orders')
      .where({ status: db.command.in(['SHIPPED', 'COMPLETED']) })
      .orderBy('createdAt', 'asc').skip(skip).limit(100).get()
    const batch = res.data || []
    docs.push(...batch)
    if (batch.length < 100) break
    skip += 100
    if (skip > 5000) break
  }
  return docs
}

function classify(result) {
  const status = result && result.status
  if (status === 'ACCEPTED' || status === 'ALREADY_ACCEPTED') return { status: 'SYNCED', code: 0 }
  if (status === 'PENDING') return { status: 'PENDING', code: Number(result.code) || 0 }
  if (status === 'FAILED') return { status: 'UNSUPPORTED', code: Number(result.code) || 0 }
  return { status: 'UNSUPPORTED', code: 0 }
}

const orders = (await scanOrders()).filter((order) => String(order.wechatShippingStatus || '') !== 'SYNCED')
console.log(`待补录 ${orders.length} 笔（SHIPPED/COMPLETED 且未 SYNCED）${apply ? '' : ' · 预演模式'}`)

const tally = {}
const skipped = []
for (const order of orders) {
  const payNo = String(order.payNo || '')
  const isPickup = String(order.deliveryType || '') === 'pickup'
  const trackingNo = String(order.trackingNo || '').trim()
  const delivery = resolveShippingDeliveryId(String(order.carrier || '').trim())
  const transactionId = String(order.transactionId || '').trim()
  const openid = String(order.openid || '').trim()
  const itemDesc = itemDescOf(order.items)
  const shippedAt = order.shippedAt ? new Date(order.shippedAt) : null

  const missing = []
  if (!transactionId) missing.push('无交易号')
  if (!openid) missing.push('无openid')
  if (!itemDesc) missing.push('无商品描述')
  if (!shippedAt || Number.isNaN(shippedAt.getTime())) missing.push('无发货时间')
  if (!isPickup && !trackingNo) missing.push('无运单号')
  if (!isPickup && !delivery) missing.push(`承运商未映射(${order.carrier || '空'})`)
  if (missing.length) {
    skipped.push({ payNo, reason: missing.join('/') })
    continue
  }

  const contact = !isPickup && shippingCarrierRequiresContact(delivery.deliveryId)
    ? toWechatReceiverContact(order.recipient && order.recipient.contact)
    : ''
  if (!isPickup && shippingCarrierRequiresContact(delivery.deliveryId) && !contact) {
    skipped.push({ payNo, reason: '顺丰缺可掩码手机号' })
    continue
  }

  const input = {
    transactionId,
    openid,
    itemDesc,
    // upload_time 是「本次上传时间」，不是发货时间（官方：用于标识请求先后）。
    // 传历史发货时间会被微信判 268485216；发货事实由 shipping_list 承载。
    uploadTime: Date.now(),
    method: isPickup ? 'PICKUP' : 'DELIVERY',
    deliveryId: isPickup ? '' : delivery.deliveryId,
    trackingNo: isPickup ? '' : trackingNo,
    receiverContact: contact,
  }

  const result = await shipping.upload(input)
  const mapped = classify(result)
  tally[mapped.status] = (tally[mapped.status] || 0) + 1
  console.log(`${payNo} ${shippedAt.toISOString().slice(0, 10)} ${isPickup ? '自提' : `${order.carrier} ${trackingNo}`} → ${mapped.status}${mapped.code ? ` (${mapped.code})` : ''}${result.status === 'ALREADY_ACCEPTED' ? ' [微信已有记录]' : ''}`)

  if (apply) {
    // node-sdk 的 update() 不接受小程序端那种 { data: {...} } 包装：
    // 包一层会写成文档里的一个 `data` 字段（本次已踩第三次）。必须平铺。
    if (order.data && order.data.wechatShippingStatus) {
      await db.collection('orders').doc(order._id).update({ data: db.command.remove() })
    }
    const patch = {
      wechatShippingStatus: mapped.status,
      wechatShippingCode: mapped.status === 'SYNCED' ? '' : String(mapped.code || ''),
    }
    if (mapped.status === 'SYNCED') patch.wechatShippingAt = db.serverDate()
    await db.collection('orders').doc(order._id).update(patch)
  }
}

console.log('\n汇总：', JSON.stringify(tally))
if (skipped.length) {
  console.log(`跳过 ${skipped.length} 笔：`)
  for (const row of skipped) console.log(` - ${row.payNo}：${row.reason}`)
}
if (!apply) console.log('\n预演结束，未写入。加 --apply 执行。')

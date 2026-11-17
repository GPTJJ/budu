/**
 * 小程序（legacy payOrder）订单在 OS 直接发货。
 *
 * 权威划分：
 *   - 发货事实权威 = CloudBase `orders` 文档（status/shippedAt/carrier/trackingNo）。
 *     本模块先改云端，再同步微信；微信失败**不回滚**发货。
 *   - 微信「发货信息管理」是外部副作用，best-effort，失败只记录状态。
 *   - PG `online_order_archive` 是只读镜像；发货成功后立即就地更新一份，
 *     让 OS 页面不用等 5 分钟定时同步。
 *
 * 为什么不在 OS 调 merchant 云函数：云调用的 openapi 鉴权依赖小程序调用身份，
 * OS 服务端触发拿不到同一身份。这里复用 OS 已有的 access_token 客户端
 * （createWechatShippingInfo），与在线结算链是同一套 token 权威。
 */
import { httpError } from './pos-core.js'
import { resolveShippingDeliveryId, shippingCarrierRequiresContact } from './wechat-delivery-codes.js'
import { toWechatReceiverContact } from './wechat-shipping-info.js'
import { buildItemDesc } from './online-wechat-shipping-sync.js'

const SHIPPABLE_STATUSES = ['PENDING_SHIPMENT', 'PAID']
const TRACKING_RE = /^[A-Za-z0-9_-]{4,80}$/

function requireText(value, label, max) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw httpError(`${label}不正确`, 400)
  return text
}

/** 微信上传结果 → 订单文档上的同步状态。 */
export function toShippingStatus(result) {
  const status = result && result.status
  if (status === 'ACCEPTED' || status === 'ALREADY_ACCEPTED') return { status: 'SYNCED', code: 0 }
  if (status === 'PENDING') return { status: 'PENDING', code: Number(result.code) || 0 }
  if (status === 'FAILED') return { status: 'UNSUPPORTED', code: Number(result.code) || 0 }
  return { status: 'UNSUPPORTED', code: 0 }
}

/**
 * @param {object} args
 * @param {string} args.payNo
 * @param {string} args.carrierCode  商家页承运商码（SF/ZTO/...）
 * @param {string} args.trackingNo
 * @param {object} args.prisma
 * @param {object} args.cloudbase    CloudBase node-sdk app（可为 null）
 * @param {Function} args.upload     微信发货上传器（可为 null）
 */
export async function shipLegacyArchiveOrder({ payNo, carrierCode, trackingNo, prisma, cloudbase, upload, now = Date.now() }) {
  const orderNo = requireText(payNo, '订单号', 40)
  const carrier = requireText(carrierCode, '快递公司', 20)
  const waybill = requireText(trackingNo, '运单号', 80)
  if (!TRACKING_RE.test(waybill)) throw httpError('运单号格式不正确（4–80 位字母数字）', 400)

  const delivery = resolveShippingDeliveryId(carrier)
  if (!delivery) throw httpError('该快递公司暂不支持在 OS 发货，请在小程序商家管理操作', 400)

  const row = await prisma.onlineOrderArchive.findUnique({ where: { payNo: orderNo } })
  if (!row) throw httpError('订单不存在', 404)
  if (row.deliveryType === 'pickup') throw httpError('自提订单不适用快递发货，请在顾客取货后于小程序标记完成', 409)
  if (row.status === 'SHIPPED' || row.status === 'COMPLETED') {
    if (row.trackingNo && row.trackingNo !== waybill) throw httpError('订单已发货，运单号不可修改', 409)
    return { ok: true, idempotent: true, status: row.status, carrier: row.carrier, trackingNo: row.trackingNo, wechat: null }
  }
  if (!SHIPPABLE_STATUSES.includes(row.status)) throw httpError(`订单当前状态（${row.status}）不可发货`, 409)

  if (!cloudbase) throw httpError('CloudBase 未配置，无法写回订单', 503)
  const db = cloudbase.database({ throwOnNotFound: false })
  const docs = (await db.collection('orders').where({ payNo: orderNo }).limit(2).get()).data || []
  if (docs.length !== 1) throw httpError('云端订单记录异常（0 条或多条）', 409)
  const order = docs[0]
  if (order.status === 'SHIPPED' || order.status === 'COMPLETED') {
    return { ok: true, idempotent: true, status: order.status, carrier: order.carrier || '', trackingNo: order.trackingNo || '', wechat: null }
  }
  if (order.status !== 'PENDING_SHIPMENT') throw httpError(`云端订单状态（${order.status}）不可发货`, 409)

  const shippedAt = new Date(now)
  // 条件更新：并发/重复点击只有一个能成功，避免两个运单号同时写进去。
  const updated = await db.collection('orders')
    .where({ _id: order._id, status: 'PENDING_SHIPMENT' })
    .update({ data: { status: 'SHIPPED', shippedAt: db.serverDate(), carrier, trackingNo: waybill } })
  const changed = Number(updated && updated.stats && updated.stats.updated) === 1
  if (!changed) throw httpError('订单状态已变化，请刷新后重试', 409)

  // 微信发货信息：best-effort，失败不改发货事实。
  let wechat = { status: 'SKIPPED', code: 0 }
  if (typeof upload === 'function' && order.transactionId && order.openid) {
    const contact = shippingCarrierRequiresContact(delivery.deliveryId)
      ? toWechatReceiverContact(order.recipient && order.recipient.contact)
      : ''
    const itemDesc = buildItemDesc((order.items || []).map(item => ({
      name: item.productName || item.name,
      quantity: item.qty || item.quantity,
    })))
    if (!itemDesc || (shippingCarrierRequiresContact(delivery.deliveryId) && !contact)) {
      // 顺丰缺联系方式、或商品描述为空：本地拒绝上传，避免消耗「重新发货」机会。
      wechat = { status: 'UNSUPPORTED', code: 0, reason: itemDesc ? 'CONTACT_MISSING' : 'ITEM_DESC_MISSING' }
    } else {
      try {
        const result = await upload({
          transactionId: String(order.transactionId),
          openid: String(order.openid),
          itemDesc,
          uploadTime: shippedAt.toISOString(),
          method: 'DELIVERY',
          deliveryId: delivery.deliveryId,
          trackingNo: waybill,
          receiverContact: contact,
        })
        wechat = toShippingStatus(result)
      } catch (error) {
        wechat = { status: 'PENDING', code: 0, reason: 'UPLOAD_THREW' }
        console.error('[legacy-shipping] WECHAT_UPLOAD_FAILED', orderNo, error && error.message ? error.message : error)
      }
    }
    await db.collection('orders').doc(order._id).update({
      data: {
        wechatShippingStatus: wechat.status,
        wechatShippingCode: wechat.status === 'SYNCED' ? '' : String(wechat.code || ''),
        ...(wechat.status === 'SYNCED' ? { wechatShippingAt: db.serverDate() } : {}),
      },
    })
  }

  // 归档表就地更新：OS 页面立刻能看到「已发货」，不必等 5 分钟定时同步。
  await prisma.onlineOrderArchive.update({
    where: { payNo: orderNo },
    data: { status: 'SHIPPED', shippedAt, carrier, trackingNo: waybill },
  })

  return { ok: true, idempotent: false, status: 'SHIPPED', shippedAt: shippedAt.toISOString(), carrier, trackingNo: waybill, wechat }
}

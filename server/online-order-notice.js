/**
 * 新订单成交通知（商家侧）。
 *
 * 触发条件是订单已经达到「权威可履约状态」，不是「创建了订单」，更不是
 * 「待付款」：
 *   - 微信 / 混合支付：online-payment-finalizer 把 settlement 置为 PAID
 *   - 纯甜意卡：submit 时即时 capture，settlement 直接以 PAID 落库
 * 两处都在各自事务提交之后调用本模块，所以通知失败（或企业微信暂时不可用）
 * 永远不会影响支付、结算或库存。
 *
 * 幂等：站内通知用确定性主键，企微投递用确定性 delivery 主键。支付回调重放、
 * 对账补扫、结算重放都只会产生一条「新成交订单」通知。
 *
 * 文案组装在 server/online-order-notice-format.js（零依赖），内容不包含收件人
 * 手机号、地址、openid 等不必要的信息。
 */
import {
  createOrderPaidNotification,
  deliverOrderPaidWecom,
  orderPaidRecipients,
} from './notification-center.js'
import { buildOrderPaidNotice } from './online-order-notice-format.js'

export { buildOrderPaidNotice }

/**
 * 在订单达到权威可履约状态之后调用。可安全重复调用。
 * 任何失败都只返回状态，不抛出，调用方（资金流程）不受影响。
 */
export async function notifyAuthoritativeOrderPaid(prisma, settlementId) {
  if (typeof settlementId !== 'string' || !/^os-[0-9a-f]{64}$/.test(settlementId)) {
    return { ok: false, status: 'invalid_settlement' }
  }
  const settlement = await prisma.onlineSettlement
    .findUnique({ where: { id: settlementId }, include: { quote: true } })
    .catch(() => null)
  // 待付款、已取消、核对中没有「新成交订单」可通知。
  if (!settlement || settlement.status !== 'PAID' || !settlement.paidAt) return { ok: false, status: 'not_paid' }

  // 接收人来自员工自己扫码建立的企微绑定，不是配置里的固定 userid。
  const recipients = await orderPaidRecipients(prisma)
  // 没有任何可达接收人时必须显式返回，而不是安静地什么都不做。
  if (!recipients.length) return { ok: false, status: 'no_recipient' }

  const snapshot = settlement.quote?.snapshot || {}
  const storeRef = snapshot.commerceIntent?.storeRef
  const store = typeof storeRef === 'string' && storeRef
    ? await prisma.store.findUnique({ where: { key: storeRef }, select: { name: true } }).catch(() => null)
    : null
  const notice = buildOrderPaidNotice({ settlement, snapshot, storeName: store?.name })

  const summary = { ok: true, status: 'delivered', delivered: 0, duplicate: 0, failed: 0, skipped: 0 }
  for (const recipient of recipients) {
    const { row, created } = await createOrderPaidNotification({
      prismaClient: prisma, settlementId, username: recipient.username,
      title: notice.title, content: notice.content,
    }).catch(() => ({ row: null, created: false }))
    if (!row) { summary.failed++; continue }
    // 已经通知过这个人：不再重复投递；投递失败的企微补发由后台负责。
    if (!created) { summary.duplicate++; continue }
    const delivery = await deliverOrderPaidWecom({
      prismaClient: prisma, notification: row, settlementId, recipient,
      title: notice.title, content: notice.content,
    }).catch(() => ({ ok: false, status: 'failed' }))
    if (delivery.ok) summary.delivered++
    else if (delivery.status === 'skipped') summary.skipped++
    else summary.failed++
  }
  summary.ok = summary.failed === 0 && summary.skipped === 0
  if (summary.delivered === 0 && summary.duplicate > 0) summary.status = 'duplicate'
  else if (!summary.ok) summary.status = 'partial'
  return summary
}

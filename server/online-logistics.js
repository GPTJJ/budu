/**
 * WeChat logistics reporting, driven from the authoritative shipment.
 *
 * Division of authority, deliberately narrow:
 *   - The shipment itself is OnlineFulfillmentAuthorization. Nothing here can
 *     create, alter or block one.
 *   - The WeChat payment transaction id comes from the settlement's own
 *     SUCCEEDED WECHAT tender. It is read, never inferred. A Sweet Card-only
 *     settlement has none, so its trace is recorded as UNSUPPORTED and the
 *     customer keeps the carrier + waybill number without an official track.
 *   - The buyer openid comes from the settlement owner's WeChat identity.
 *   - The waybill number comes from the authorization the merchant already made.
 *   - receiverPhone / goodsName / goodsImgUrl / orderDetailPath arrive from the
 *     CloudBase edge layer, which is where the order's recipient and catalogue
 *     presentation actually live. This service does not derive them from a
 *     payment number, a hash, or any other stand-in for order identity.
 *
 * Failure policy: reporting is best-effort and retried in the background. A
 * logistics failure never reaches the merchant as "could not ship".
 */
import crypto from 'node:crypto'
import { httpError } from './pos-core.js'

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const MAX_ATTEMPTS = 12
const LEASE_MS = 30000

function cleanText(value, max) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : ''
}

/**
 * @param {object} options.logistics  the client from createWechatLogistics()
 */
export function createOnlineLogistics(prisma, { logistics, appId, batchSize = 10 } = {}) {
  if (typeof logistics?.reportWaybill !== 'function') throw Error('ONLINE_LOGISTICS_CLIENT_REQUIRED')
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) throw Error('ONLINE_LOGISTICS_CONFIG_INVALID')

  /**
   * Idempotent registration from the merchant shipment path. Safe to call
   * repeatedly for the same settlement; the second call returns the same state.
   */
  async function register(input) {
    const settlementId = cleanText(input?.settlementId, 160)
    if (!settlementId) throw httpError('订单无效', 400)
    const detail = {
      receiverPhone: cleanText(input?.receiverPhone, 40),
      goodsName: cleanText(input?.goodsName, 120),
      goodsImgUrl: cleanText(input?.goodsImgUrl, 512),
      orderDetailPath: cleanText(input?.orderDetailPath, 256),
    }
    // WeChat rejects the call without these, so refuse the registration rather
    // than storing a trace that could never succeed.
    if (!detail.receiverPhone || !detail.goodsName || !detail.goodsImgUrl || !detail.orderDetailPath)
      throw httpError('物流上报参数不完整', 400)

    return prisma.$transaction(async tx => {
      const settlement = await tx.onlineSettlement.findUnique({ where: { id: settlementId } })
      if (!settlement) throw httpError('订单不存在', 404)
      const authorization = await tx.onlineFulfillmentAuthorization.findUnique({ where: { settlementId } })
      if (!authorization) throw httpError('订单尚未发货', 409)
      // Pickup never enters the logistics flow.
      if (authorization.method !== 'DELIVERY' || !authorization.trackingNo) throw httpError('该订单不是配送订单', 409)

      const existing = await tx.onlineLogisticsTrace.findUnique({ where: { settlementId } })
      if (existing) {
        const same = ['receiverPhone', 'goodsName', 'goodsImgUrl', 'orderDetailPath']
          .every(key => existing[key] === detail[key])
        if (!same || existing.authorizationId !== authorization.id) throw httpError('物流上报内容冲突', 409)
        return presentation(existing)
      }
      const created = await tx.onlineLogisticsTrace.create({ data: {
        id: 'olt-' + hash(settlementId),
        settlementId,
        authorizationId: authorization.id,
        ...detail,
      } })
      return presentation(created)
    }, { isolationLevel: 'Serializable' })
  }

  function presentation(row) {
    return {
      status: row.status,
      // The token is only meaningful to the customer's own WeChat session, and
      // it is returned only when WeChat actually issued one.
      waybillToken: row.status === 'SYNCED' ? row.waybillToken : null,
      officialTracking: row.status === 'SYNCED' ? 'AVAILABLE' : row.status === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'PENDING',
    }
  }

  /** Customer/merchant read of the current logistics state. Never creates work. */
  async function status(settlementId) {
    const row = await prisma.onlineLogisticsTrace.findUnique({ where: { settlementId } })
    return row ? presentation(row) : null
  }

  async function claim() {
    const owner = crypto.randomUUID()
    const rows = await prisma.$queryRaw`
      WITH candidate AS (
        SELECT id FROM online_logistics_traces
        WHERE status = 'PENDING' AND attempts < ${MAX_ATTEMPTS}
          AND available_at <= clock_timestamp()
          AND (lease_until IS NULL OR lease_until <= clock_timestamp())
        ORDER BY available_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE online_logistics_traces AS t SET lease_owner = ${owner},
        lease_until = clock_timestamp() + (${LEASE_MS} * interval '1 millisecond'), attempts = t.attempts + 1
      FROM candidate WHERE t.id = candidate.id
      RETURNING t.id, t.settlement_id, t.authorization_id, t.attempts, t.lease_owner,
        t.receiver_phone, t.goods_name, t.goods_img_url, t.order_detail_path`
    return rows[0] || null
  }

  async function settle(row, outcome) {
    if (outcome.status === 'SYNCED') {
      // The token is written once. A duplicate/concurrent attempt that also
      // succeeded must not overwrite the token WeChat already accepted.
      await prisma.$executeRaw`
        UPDATE online_logistics_traces SET status = 'SYNCED', waybill_token = ${outcome.waybillToken},
          synced_at = clock_timestamp(), lease_owner = NULL, lease_until = NULL, last_error = NULL
        WHERE id = ${row.id} AND lease_owner = ${row.lease_owner} AND status <> 'SYNCED'`
      return
    }
    if (outcome.status === 'UNSUPPORTED') {
      await prisma.$executeRaw`
        UPDATE online_logistics_traces SET status = 'UNSUPPORTED', lease_owner = NULL, lease_until = NULL,
          last_error = 'LOGISTICS_UNSUPPORTED_NO_WECHAT_TRANSACTION'
        WHERE id = ${row.id} AND lease_owner = ${row.lease_owner}`
      return
    }
    if (outcome.status === 'FAILED') {
      await prisma.$executeRaw`
        UPDATE online_logistics_traces SET status = 'FAILED', lease_owner = NULL, lease_until = NULL,
          last_error = ${'LOGISTICS_REJECTED_' + outcome.code}
        WHERE id = ${row.id} AND lease_owner = ${row.lease_owner}`
      return
    }
    const delay = Math.min(300000, 2000 * 2 ** Math.min(row.attempts, 7))
    await prisma.$executeRaw`
      UPDATE online_logistics_traces SET lease_owner = NULL, lease_until = NULL,
        last_error = ${'LOGISTICS_RETRY_' + outcome.code},
        available_at = clock_timestamp() + (${delay} * interval '1 millisecond')
      WHERE id = ${row.id} AND lease_owner = ${row.lease_owner}`
  }

  async function syncClaimed(row) {
    const settlement = await prisma.onlineSettlement.findUnique({
      where: { id: row.settlement_id }, include: { tenders: true },
    })
    if (!settlement) { await settle(row, { status: 'FAILED', code: 'SETTLEMENT' }); return { status: 'FAILED' } }

    // The WeChat payment transaction number is a stored fact, never a derived
    // one. Without it the official track genuinely is unavailable.
    const tender = settlement.tenders.find(t => t.type === 'WECHAT' && t.status === 'SUCCEEDED' && t.providerTransactionId)
    if (!tender) { await settle(row, { status: 'UNSUPPORTED' }); return { status: 'UNSUPPORTED' } }

    const identity = await prisma.weChatAuthIdentity.findFirst({
      where: { provider: 'WECHAT_MINIPROGRAM', appId, userId: settlement.userId }, select: { openId: true },
    })
    if (!identity?.openId) { await settle(row, { status: 'FAILED', code: 'OPENID' }); return { status: 'FAILED' } }

    const outcome = await logistics.reportWaybill({
      openid: identity.openId,
      receiverPhone: row.receiver_phone,
      waybillId: row.tracking_no,
      transId: tender.providerTransactionId,
      goodsName: row.goods_name,
      goodsImgUrl: row.goods_img_url,
      orderDetailPath: row.order_detail_path,
    })
    await settle(row, outcome)
    return outcome
  }

  return {
    register,
    status,
    /** One bounded background pass. Safe to call from a recovery loop. */
    async tick() {
      const summary = { scanned: 0, synced: 0, unsupported: 0, failed: 0, pending: 0 }
      for (let i = 0; i < batchSize; i++) {
        const row = await claim()
        if (!row) break
        summary.scanned++
        // claim() does not carry tracking_no, so read the waybill from the
        // shipment authorization inside the same logical step.
        const authorization = await prisma.onlineFulfillmentAuthorization.findUnique({
          where: { settlementId: row.settlement_id }, select: { trackingNo: true },
        })
        const outcome = await syncClaimed({ ...row, tracking_no: authorization?.trackingNo || '' })
          .catch(() => ({ status: 'PENDING', code: 0 }))
        if (outcome.status === 'SYNCED') summary.synced++
        else if (outcome.status === 'UNSUPPORTED') summary.unsupported++
        else if (outcome.status === 'FAILED') summary.failed++
        else summary.pending++
      }
      return summary
    },
  }
}

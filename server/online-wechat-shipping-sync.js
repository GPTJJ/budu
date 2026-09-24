/**
 * WeChat 发货信息管理同步：独立状态机 + 专属 worker。
 *
 * 权威划分（刻意的）：
 *   - 发货事实权威永远是 OnlineFulfillmentAuthorization。本模块绝不创建、修改、
 *     撤销、阻断任何一笔发货。
 *   - 微信「发货信息管理」只是 EXTERNAL SIDE EFFECT / SUBORDINATE FACT。它失败
 *     不得让商家看到「发货失败」，不得改支付/退款/甜意卡任何状态。
 *   - 与 online-logistics.js（trace_waybill / 物流轨迹）**状态完全独立**：两张表、
 *     两套状态机、两个 worker。两者共用 access_token authority、发货事实、
 *     transaction_id、openid、worker 基础设施，但不共用状态，也不共用承运商编码
 *     （编码空间不同，见 wechat-delivery-codes.js）。
 *
 * 为什么必须用 get_order 做终态：
 *   upload_shipping_info 返回 errcode 0 只证明「我们发过一次请求」。最终 SYNCED
 *   必须代表「微信平台确实已经把这张运单记在这笔支付单上」。因此：
 *     PENDING_UPLOAD --upload--> PENDING_VERIFY --get_order 命中本运单--> SYNCED
 *   传输层失败是**歧义**的（微信可能已经收下），所以歧义失败一律转 PENDING_VERIFY
 *   先核实，绝不无脑重传 —— 微信对此的解释是「每笔支付单仅有一次重新发货机会」，
 *   而相同内容重复上传会被判定为未更新（10060023）而不是重新发货。
 *
 * 数据来源（全部为既有权威，无一推导/伪造）：
 *   transaction_id     ← settlement 中 SUCCEEDED 的 WECHAT tender.providerTransactionId
 *   payer.openid       ← WeChatAuthIdentity(provider=WECHAT_MINIPROGRAM, appId, userId)
 *   delivery_id        ← wechat-delivery-codes.js（BUDU 页面码 → 微信官方编码）
 *   tracking_no        ← OnlineFulfillmentAuthorization.trackingNo
 *   upload_time        ← OnlineFulfillmentAuthorization.createdAt（首次发货时间，
 *                        绝不用本次重试时间冒充）
 *   item_desc          ← OnlineCheckoutQuote.snapshot.lines（顾客下单时的商品快照）
 *   receiver_contact   ← OnlineLogisticsTrace.receiverPhone（同一笔发货的边缘事实上报，
 *                        顺丰必填；缺失时保持 PENDING 重试，绝不编造号码）
 */
import crypto from 'node:crypto'
import { httpError } from './pos-core.js'
import { resolveShippingDeliveryId, shippingCarrierRequiresContact } from './wechat-delivery-codes.js'
import { toWechatReceiverContact, LOGISTICS_TYPE_EXPRESS, LOGISTICS_TYPE_SELF_PICKUP } from './wechat-shipping-info.js'

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const MAX_ATTEMPTS = 12
const LEASE_MS = 30000
// PENDING_VERIFY 阶段连续核实不到，才允许一次受控重传。次数本身也受
// MAX_ATTEMPTS 约束；由于 payload 完全不变，微信会判定「未更新」而不是消耗
// 重新发货机会。
const VERIFY_RETRIES_BEFORE_REUPLOAD = 3
const ITEM_DESC_MAX = 120

const UPLOAD_KINDS = ['PENDING_UPLOAD', 'PENDING_VERIFY']

function cleanText(value, max) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : ''
}

/**
 * 顾客下单时的商品快照 → 微信 item_desc（≤120 字）。
 * 微信强制 item_desc 非空；过长的商品名要**截断**而不是整条丢弃，否则一笔正常
 * 发货会因为商品名太长而永远无法同步。控制字符仍然拒绝。
 */
export function buildItemDesc(lines) {
  if (!Array.isArray(lines)) return ''
  const parts = []
  for (const line of lines) {
    const name = cleanText(line?.name, 500)
    if (!name) continue
    const quantity = Number(line?.quantity)
    parts.push(Number.isFinite(quantity) && quantity > 0 ? `${name}*${quantity}` : name)
  }
  const joined = parts.join('; ')
  if (!joined) return ''
  return joined.length <= ITEM_DESC_MAX ? joined : `${joined.slice(0, ITEM_DESC_MAX - 3)}...`
}

/**
 * @param {object} options.shipping the client from createWechatShippingInfo()
 */
export function createOnlineWechatShippingSync(prisma, { shipping, appId, batchSize = 10 } = {}) {
  if (typeof shipping?.upload !== 'function' || typeof shipping?.verify !== 'function') {
    throw Error('ONLINE_SHIPPING_CLIENT_REQUIRED')
  }
  if (typeof appId !== 'string' || !appId) throw Error('ONLINE_SHIPPING_CONFIG_INVALID')
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) throw Error('ONLINE_SHIPPING_CONFIG_INVALID')

  /**
   * 幂等注册。由 merchant /fulfill 在履约事实已落库之后调用；同一 settlement
   * 重复调用返回同一状态。两种履约都支持：
   *
   *   DELIVERY → 走承运商映射；映射不到官方编码时**没有微信侧身份**，不写占位串，
   *              而是落一条 FAILED 让问题显式可见（fail closed）。
   *   PICKUP   → 不需要承运商、不需要运单号，也不查 OnlineLogisticsTrace；
   *              delivery_id / tracking_no 保持 NULL，由 DB CHECK 保证。
   */
  async function register(input) {
    const settlementId = cleanText(input?.settlementId, 160)
    if (!settlementId) throw httpError('订单无效', 400)

    return prisma.$transaction(async tx => {
      const settlement = await tx.onlineSettlement.findUnique({ where: { id: settlementId } })
      if (!settlement) throw httpError('订单不存在', 404)
      const authorization = await tx.onlineFulfillmentAuthorization.findUnique({ where: { settlementId } })
      if (!authorization) throw httpError('订单尚未发货', 409)

      const method = authorization.method
      if (method !== 'DELIVERY' && method !== 'PICKUP') throw httpError('履约方式无效', 409)

      const uploadTime = authorization.createdAt instanceof Date
        ? authorization.createdAt
        : new Date(authorization.createdAt)

      let logisticsType = LOGISTICS_TYPE_SELF_PICKUP
      let deliveryId = null
      let trackingNo = null
      if (method === 'DELIVERY') {
        logisticsType = LOGISTICS_TYPE_EXPRESS
        trackingNo = cleanText(authorization.trackingNo, 128)
        if (!trackingNo) throw httpError('该订单缺少运单号', 409)
        const tracked = resolveShippingDeliveryId(authorization.carrierCode)
        // 映射不到就保持 null；绝不用 'UNMAPPED_…' 这类串冒充微信 delivery_id。
        deliveryId = tracked ? tracked.deliveryId : null
      }

      // 指纹含 method：DELIVERY 与 PICKUP 是两份不同的发货信息，绝不能被当成同一个
      // payload 互相覆盖。
      const fingerprint = hash({ method, logisticsType, deliveryId, trackingNo, uploadTime: uploadTime.toISOString() })

      const existing = await tx.onlineWechatShippingSync.findUnique({ where: { settlementId } })
      if (existing) {
        if (existing.payloadFingerprint !== fingerprint || existing.authorizationId !== authorization.id) {
          throw httpError('发货同步内容冲突', 409)
        }
        return presentation(existing)
      }

      const unmapped = method === 'DELIVERY' && deliveryId === null
      const created = await tx.onlineWechatShippingSync.create({ data: {
        id: 'owss-' + hash(settlementId),
        settlementId,
        authorizationId: authorization.id,
        status: unmapped ? 'FAILED' : 'PENDING_UPLOAD',
        method,
        logisticsType,
        deliveryId,
        trackingNo,
        uploadTime,
        payloadFingerprint: fingerprint,
        lastError: unmapped ? 'SHIPPING_CARRIER_UNSUPPORTED' : null,
      } })
      return presentation(created)
    }, { isolationLevel: 'Serializable' })
  }

  function presentation(row) {
    return {
      status: row.status,
      synced: row.status === 'SYNCED',
      method: row.method,
      logisticsType: row.logisticsType,
      deliveryId: row.deliveryId,
      trackingNo: row.trackingNo,
      verifiedAt: row.verifiedAt || null,
    }
  }

  /** 只读视图。绝不创建任何工作。 */
  async function status(settlementId) {
    const row = await prisma.onlineWechatShippingSync.findUnique({ where: { settlementId } })
    return row ? presentation(row) : null
  }

  async function claim() {
    const owner = crypto.randomUUID()
    const rows = await prisma.$queryRaw`
      WITH candidate AS (
        SELECT id FROM online_wechat_shipping_sync
        WHERE status IN ('PENDING_UPLOAD', 'PENDING_VERIFY') AND attempts < ${MAX_ATTEMPTS}
          AND available_at <= clock_timestamp()
          AND (lease_until IS NULL OR lease_until <= clock_timestamp())
        ORDER BY available_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE online_wechat_shipping_sync AS t SET lease_owner = ${owner},
        lease_until = clock_timestamp() + (${LEASE_MS} * interval '1 millisecond'), attempts = t.attempts + 1
      FROM candidate WHERE t.id = candidate.id
      RETURNING t.id, t.settlement_id, t.authorization_id, t.status, t.method, t.logistics_type,
        t.delivery_id, t.tracking_no,
        t.upload_time, t.payload_fingerprint, t.attempts, t.verify_attempts, t.lease_owner,
        t.upload_accepted_at, t.reupload_count`
    return rows[0] || null
  }

  function backoff(row) {
    return Math.min(300000, 2000 * 2 ** Math.min(row.attempts, 7))
  }

  async function settle(row, outcome) {
    if (outcome.status === 'SYNCED') {
      await prisma.$executeRaw`
        UPDATE online_wechat_shipping_sync SET status = 'SYNCED', verified_at = clock_timestamp(),
          lease_owner = NULL, lease_until = NULL, last_error = NULL, verify_attempts = 0
        WHERE id = ${row.id} AND lease_owner = ${row.lease_owner} AND status <> 'SYNCED'`
      return
    }
    if (outcome.status === 'ACCEPTED') {
      // 微信接受（或确认内容未变）→ 进入核实阶段。upload_accepted_at 只写一次。
      await prisma.$executeRaw`
        UPDATE online_wechat_shipping_sync SET status = 'PENDING_VERIFY',
          upload_accepted_at = COALESCE(upload_accepted_at, clock_timestamp()),
          verify_attempts = 0, lease_owner = NULL, lease_until = NULL, last_error = NULL,
          available_at = clock_timestamp() + (${backoff(row)} * interval '1 millisecond')
        WHERE id = ${row.id} AND lease_owner = ${row.lease_owner} AND status <> 'SYNCED'`
      return
    }
    if (outcome.status === 'UNSUPPORTED' || outcome.status === 'FAILED') {
      await prisma.$executeRaw`
        UPDATE online_wechat_shipping_sync SET status = ${outcome.status}, lease_owner = NULL, lease_until = NULL,
          last_error = ${outcome.error}
        WHERE id = ${row.id} AND lease_owner = ${row.lease_owner} AND status <> 'SYNCED'`
      return
    }
    if (outcome.status === 'PENDING_VERIFY') {
      // fresh=true 表示「刚从上传阶段转入核实」：这次不是核实失败，计数归零。
      //
      // ⚠️ 必须写成两条**各自完整**的 SQL。Prisma tagged $executeRaw 会把每个 `${...}`
      // 变成绑定参数，所以把 `'verify_attempts + 1'` 这样的表达式字符串塞进参数，
      // 真实 PostgreSQL 会尝试把该字符串写进 INTEGER 列并报类型错误 —— 上一版正是
      // 这个写法，且被 fake Prisma 的字符串匹配掩盖了。
      // 禁止用字符串插值拼 SQL 表达式，也禁止 $executeRawUnsafe。
      if (outcome.fresh) {
        await prisma.$executeRaw`
          UPDATE online_wechat_shipping_sync SET status = 'PENDING_VERIFY',
            verify_attempts = 0, lease_owner = NULL, lease_until = NULL,
            last_error = ${outcome.error},
            available_at = clock_timestamp() + (${backoff(row)} * interval '1 millisecond')
          WHERE id = ${row.id} AND lease_owner = ${row.lease_owner} AND status <> 'SYNCED'`
      } else {
        await prisma.$executeRaw`
          UPDATE online_wechat_shipping_sync SET status = 'PENDING_VERIFY',
            verify_attempts = verify_attempts + 1, lease_owner = NULL, lease_until = NULL,
            last_error = ${outcome.error},
            available_at = clock_timestamp() + (${backoff(row)} * interval '1 millisecond')
          WHERE id = ${row.id} AND lease_owner = ${row.lease_owner} AND status <> 'SYNCED'`
      }
      return
    }
    // PENDING_UPLOAD：微信明确没接受，重传是安全的。
    await prisma.$executeRaw`
      UPDATE online_wechat_shipping_sync SET lease_owner = NULL, lease_until = NULL,
        last_error = ${outcome.error},
        available_at = clock_timestamp() + (${backoff(row)} * interval '1 millisecond')
      WHERE id = ${row.id} AND lease_owner = ${row.lease_owner} AND status <> 'SYNCED'`
  }

  /**
   * 原子地赢取「唯一一次受控重传」的预算。
   *
   * 这是本模块里**唯一**允许增加 upload 次数的许可点，因此把判定与置位放在同一条
   * 条件 UPDATE 里：`AND reupload_count = 0` 保证两个并发 worker 里最多只有一个拿到
   * 这一行（另一个 UPDATE 影响 0 行）；DB 侧 `CHECK (reupload_count BETWEEN 0 AND 1)`
   * 是第二道防线。预算是**持久化列**，进程重启、换实例、重新 claim 都不会重置。
   *
   * @returns {Promise<boolean>} true = 本次调用拿到了重传许可，可以上传
   */
  async function claimReuploadBudget(row) {
    const rows = await prisma.$queryRaw`
      UPDATE online_wechat_shipping_sync
      SET reupload_count = reupload_count + 1, verify_attempts = 0,
        lease_owner = ${row.lease_owner},
        lease_until = clock_timestamp() + (${LEASE_MS} * interval '1 millisecond')
      WHERE id = ${row.id} AND lease_owner = ${row.lease_owner}
        AND status = 'PENDING_VERIFY' AND reupload_count = 0
      RETURNING reupload_count`
    return Array.isArray(rows) && rows.length > 0
  }

  async function syncClaimed(row) {
    const settlement = await prisma.onlineSettlement.findUnique({
      where: { id: row.settlement_id }, include: { tenders: true },
    })
    if (!settlement) { await settle(row, { status: 'FAILED', error: 'SHIPPING_SETTLEMENT_MISSING' }); return { status: 'FAILED' } }

    // 纯甜意卡订单没有真实微信支付单，不得伪造一个。
    const tender = settlement.tenders.find(
      t => t.type === 'WECHAT' && t.status === 'SUCCEEDED' && t.providerTransactionId
    )
    if (!tender) {
      await settle(row, { status: 'UNSUPPORTED', error: 'SHIPPING_UNSUPPORTED_NO_WECHAT_TRANSACTION' })
      return { status: 'UNSUPPORTED' }
    }

    const identity = await prisma.weChatAuthIdentity.findFirst({
      where: { provider: 'WECHAT_MINIPROGRAM', appId, userId: settlement.userId }, select: { openId: true },
    })
    if (!identity?.openId) {
      await settle(row, { status: 'FAILED', error: 'SHIPPING_OPENID_MISSING' })
      return { status: 'FAILED' }
    }

    const authorization = await prisma.onlineFulfillmentAuthorization.findUnique({
      where: { settlementId: row.settlement_id },
      select: { id: true, method: true, trackingNo: true },
    })
    if (!authorization || authorization.id !== row.authorization_id
      || authorization.method !== row.method) {
      await settle(row, { status: 'FAILED', error: 'SHIPPING_AUTHORIZATION_MISMATCH' })
      return { status: 'FAILED' }
    }
    // 只有快递才需要运单号；自提没有也不需要。
    if (row.method === 'DELIVERY' && !authorization.trackingNo) {
      await settle(row, { status: 'FAILED', error: 'SHIPPING_AUTHORIZATION_MISMATCH' })
      return { status: 'FAILED' }
    }

    const quote = await prisma.onlineCheckoutQuote.findUnique({
      where: { id: settlement.quoteId }, select: { snapshot: true },
    })
    const itemDesc = buildItemDesc(quote?.snapshot?.lines)
    if (!itemDesc) {
      await settle(row, { status: 'FAILED', error: 'SHIPPING_ITEM_DESC_MISSING' })
      return { status: 'FAILED' }
    }

    // 顺丰要求联系方式（官方：「当发货的物流公司为顺丰时，联系方式为必填」）。
    // 来源是与 trace_waybill 共享的既有边缘事实（同一笔发货），**只读、不写**，
    // 数据库里的 receiverPhone 保持原值；掩码只在发给微信的 payload 构建阶段发生。
    // 两种情况必须区分开：
    //   - 号码还没到（空）      → 可重试，等它出现，绝不编造
    //   - 号码存在但不可掩码    → 永久性数据问题，fail closed 且不调用微信
    // 只有快递 + 顺丰才需要联系方式，而且它来自与 trace_waybill 共享的既有边缘事实。
    // 自提一律**不读** OnlineLogisticsTrace（显式按 method 短路，不依赖 delivery_id 的取值）。
    let receiverContact = ''
    if (row.method === 'DELIVERY' && shippingCarrierRequiresContact(row.delivery_id)) {
      const trace = await prisma.onlineLogisticsTrace.findUnique({
        where: { settlementId: row.settlement_id }, select: { receiverPhone: true },
      })
      const raw = cleanText(trace?.receiverPhone, 1024)
      if (!raw) {
        // 号码还没到 —— 此时**尚未上传**，所以必须留在 PENDING_UPLOAD 等它出现再试，
        // 绝不能进 PENDING_VERIFY（那代表「微信已收下、只待核实」，会把这一行推进
        // 只核实不重传的路径，号码后到也永远补不上）。
        await settle(row, { status: 'PENDING', error: 'SHIPPING_CONTACT_PENDING_SF' })
        return { status: 'PENDING' }
      }
      receiverContact = toWechatReceiverContact(raw)
      if (!receiverContact) {
        // 不把完整手机号写进任何错误信息或日志。
        await settle(row, { status: 'FAILED', error: 'SHIPPING_CONTACT_INVALID_FORMAT' })
        return { status: 'FAILED' }
      }
    }

    const verifyNow = async () => {
      const outcome = await shipping.verify({
        method: row.method, transactionId: tender.providerTransactionId,
        trackingNo: row.tracking_no, deliveryId: row.delivery_id,
      })
      if (outcome.status === 'SHIPPED') { await settle(row, { status: 'SYNCED' }); return { status: 'SYNCED' } }
      if (outcome.status === 'REFUNDED') {
        await settle(row, { status: 'UNSUPPORTED', error: 'SHIPPING_ORDER_STATE_REFUNDED' })
        return { status: 'UNSUPPORTED' }
      }
      if (outcome.status === 'MISMATCH') {
        await settle(row, {
          status: Number(row.verify_attempts) + 1 >= VERIFY_RETRIES_BEFORE_REUPLOAD ? 'FAILED' : 'PENDING_VERIFY',
          error: 'SHIPPING_VERIFY_MISMATCH',
        })
        return { status: 'PENDING' }
      }
      if (outcome.status === 'FAILED') {
        await settle(row, { status: 'FAILED', error: `SHIPPING_VERIFY_REJECTED_${outcome.code}` })
        return { status: 'FAILED' }
      }
      await settle(row, { status: 'PENDING_VERIFY', error: `SHIPPING_VERIFY_PENDING_${outcome.code}` })
      return { status: 'PENDING' }
    }

    // 已进入核实阶段：先核实，绝不无脑重传。核实预算用完之前只核实。
    //
    // 注意这里不看 upload_accepted_at：传输歧义（我们不知道微信是否收下）同样必须先
    // 核实，否则一次无脑重传就可能撞上「每笔支付单仅一次重新发货机会」。
    const verifiedTimes = Number(row.verify_attempts) || 0
    if (row.status === 'PENDING_VERIFY' && verifiedTimes < VERIFY_RETRIES_BEFORE_REUPLOAD) {
      return verifyNow()
    }
    // 核实预算已用完。此时**只**在还没用过受控重传时才允许再上传一次；许可是从数据库
    // 原子赢取的（见 claimReuploadBudget），因此进程重启、换实例、并发 worker 都不会
    // 让它发生第二次。拿不到许可就继续核实，直到 SYNCED / 永久失败 / 总尝试预算耗尽。
    if (row.status === 'PENDING_VERIFY') {
      const granted = await claimReuploadBudget(row)
      if (!granted) return verifyNow()
    }

    const outcome = await shipping.upload({
      method: row.method,
      transactionId: tender.providerTransactionId,
      openid: identity.openId,
      deliveryId: row.delivery_id,
      trackingNo: row.tracking_no,
      itemDesc,
      receiverContact,
      uploadTime: row.upload_time,
    })

    if (outcome.status === 'ACCEPTED' || outcome.status === 'ALREADY_ACCEPTED') {
      await settle(row, { status: 'ACCEPTED' })
      return { status: 'PENDING' }
    }
    if (outcome.status === 'UNSUPPORTED') {
      await settle(row, { status: 'FAILED', error: 'SHIPPING_PAYLOAD_INCOMPLETE' })
      return { status: 'FAILED' }
    }
    if (outcome.status === 'FAILED') {
      await settle(row, { status: 'FAILED', error: `SHIPPING_UPLOAD_REJECTED_${outcome.code}` })
      return { status: 'FAILED' }
    }
    // FIX A —— 两种 PENDING 的语义必须分开，不能都推进核实路径：
    //
    //   ambiguous = true   请求已经发出但结果不确定（超时 / 连接被重置 / 非 JSON 响应），
    //                      微信可能已经收下 ⇒ 转 PENDING_VERIFY，**先 get_order 核实**。
    //                      这是唯一值得走核实路径的情形。
    //
    //   ambiguous = false  可以确认这次并未成功上传（access_token 根本拿不到，所以压根没
    //                      调用 upload_shipping_info；或微信明确返回了可重试错误且没接受）
    //                      ⇒ 留在 PENDING_UPLOAD，下一轮正常重试「首次上传」。
    //                      不进入只核实不重传的路径、不增加 verify_attempts、
    //                      也**不消耗**那唯一一次受控重传预算。
    if (outcome.ambiguous) {
      await settle(row, { status: 'PENDING_VERIFY', error: 'SHIPPING_UPLOAD_AMBIGUOUS', fresh: true })
      return { status: 'PENDING' }
    }
    await settle(row, { status: 'PENDING', error: `SHIPPING_UPLOAD_RETRY_${outcome.code}` })
    return { status: 'PENDING' }
  }

  return {
    register,
    status,
    presentation,
    /** 一次有界后台批量。可由恢复循环安全调用。 */
    async tick() {
      const summary = { scanned: 0, uploaded: 0, synced: 0, unsupported: 0, failed: 0, pending: 0 }
      for (let i = 0; i < batchSize; i++) {
        const row = await claim()
        if (!row) break
        summary.scanned++
        if (row.status === 'PENDING_UPLOAD') summary.uploaded++
        const outcome = await syncClaimed(row).catch(() => ({ status: 'PENDING' }))
        if (outcome.status === 'SYNCED') summary.synced++
        else if (outcome.status === 'UNSUPPORTED') summary.unsupported++
        else if (outcome.status === 'FAILED') summary.failed++
        else summary.pending++
      }
      return summary
    },
    /** 测试与运维可见的边界。 */
    limits: { MAX_ATTEMPTS, LEASE_MS, VERIFY_RETRIES_BEFORE_UPLOAD: VERIFY_RETRIES_BEFORE_REUPLOAD, UPLOAD_KINDS },
  }
}

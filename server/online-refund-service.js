import { httpError } from './pos-core.js'
import { createOnlineWechatTransport } from './online-wechat-transport.js'
import { createOnlineWechatMessageVerifier } from './online-wechat-evidence.js'
import { createOnlineRefundFinalizer, onlineRefundContext } from './online-refund-finalizer.js'

// All dispatch identities and amounts are immutable PG facts. A network error
// never creates another refund number or credits the Sweet Card.
export function createOnlineRefundService(prisma, configuration, { request = createOnlineWechatTransport(configuration) } = {}) {
  const verifyMessage = createOnlineWechatMessageVerifier(configuration)
  const finalize = createOnlineRefundFinalizer(prisma, configuration)
  const notify = new URL(configuration.notifyUrl)
  if (notify.protocol !== 'https:' || notify.pathname !== '/api/online-checkout/wechat/notify' || notify.search || notify.hash
    || notify.username || notify.password) throw Error('ONLINE_REFUND_NOTIFY_INVALID')
  notify.pathname = '/api/online-checkout/wechat/refund-notify'
  const unknown = () => httpError('退款结果正在核对，请稍后查询', 503)
  return {
    finalize,
    async recover(merchantRefundNo) {
      const context = await onlineRefundContext(prisma, merchantRefundNo, configuration)
      if (context.row.status === 'SETTLED') return context.row
      const reply = await request('GET', `/v3/refund/domestic/refunds/${merchantRefundNo}`)
      verifyMessage(reply)
      if (reply.statusCode === 200) return finalize({ ...reply, source: 'QUERY' })
      let error
      try { error = JSON.parse(reply.rawBody.toString('utf8')) } catch { throw unknown() }
      if (reply.statusCode !== 404 || error?.code !== 'RESOURCE_NOT_EXISTS') throw unknown()
      // WeChat's refund contract explicitly permits original-no/original-body
      // retries after verified RESOURCE_NOT_EXISTS. Never allocate again.
      // https://pay.wechatpay.cn/doc/v3/merchant/4014959631
      const e = context.expected
      const result = await request('POST', '/v3/refund/domestic/refunds', {
        transaction_id: e.transactionId, out_refund_no: e.merchantRefundNo,
        notify_url: notify.toString(),
        amount: { refund: Number(e.refundCents), total: Number(e.totalCents), currency: 'CNY' },
      })
      return finalize({ ...result, source: 'SUBMIT' })
    },
  }
}

export function createOnlineRefundRecovery(prisma, service, { batchSize = 20 } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw Error('ONLINE_REFUND_RECOVERY_CONFIG_INVALID')
  const positions = [{ model: 'onlineRefund' }, { model: 'onlinePaymentCompensation' }]
  let inFlight
  async function scan(signal) {
    const summary = { scanned: 0, settled: 0, pending: 0, failed: 0 }
    for (const position of positions) {
      if (signal?.aborted) break
      const model = prisma[position.model], eligible = { status: 'PENDING', ...(position.model === 'onlineRefund' ? { merchantRefundNo: { not: null } } : {}) }
      if (!position.highWater) position.highWater = (await model.findFirst({ where: eligible, orderBy: { id: 'desc' }, select: { id: true } }))?.id
      if (!position.highWater) continue
      const rows = await model.findMany({ where: { ...eligible, id: { lte: position.highWater, ...(position.cursor ? { gt: position.cursor } : {}) } },
        orderBy: { id: 'asc' }, take: batchSize, select: { id: true, merchantRefundNo: true } })
      for (const row of rows) {
        if (signal?.aborted) break
        try { const result = await service.recover(row.merchantRefundNo); summary[result.status === 'SETTLED' ? 'settled' : 'pending']++ }
        catch { summary.failed++ }
        summary.scanned++; position.cursor = row.id
      }
      if (rows.length < batchSize || position.cursor === position.highWater) { position.cursor = null; position.highWater = null }
    }
    return summary
  }
  return { tick({ signal } = {}) {
    if (!inFlight) inFlight = scan(signal).finally(() => { inFlight = null })
    return inFlight
  } }
}

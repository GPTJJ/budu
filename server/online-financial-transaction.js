import crypto from 'node:crypto'
import { httpError } from './pos-core.js'

const json = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

// Internal-only financial envelope. No identity credentials, recipient PII,
// provider tokens, or request bodies cross into the commerce mirror.
export function onlineFinancialEnvelope(row) {
  if (!row) return null
  return json({
    schemaVersion: 1, settlementId: row.id, namespace: row.namespace,
    externalOrderId: row.externalOrderId, version: row.version, status: row.status,
    currency: row.currency, merchandiseCents: row.merchandiseCents,
    shippingCents: row.shippingCents, totalCents: row.totalCents,
    sweetCardCents: row.sweetCardCents, wechatCents: row.wechatCents,
    paidAt: row.paidAt, cancelledAt: row.cancelledAt,
    tenders: row.tenders.map(t => ({ type: t.type, amountCents: t.amountCents, status: t.status })),
    compensations: row.compensations.map(c => ({ id: c.id, amountCents: c.amountCents, status: c.status, settledAt: c.settledAt })),
    refunds: row.refunds.map(r => ({ id: r.id, sequence: r.sequence, status: r.status,
      totalCents: r.totalCents, sweetCardCents: r.sweetCardCents, wechatCents: r.wechatCents, settledAt: r.settledAt })),
  })
}
const include = { compensations: { orderBy: { id: 'asc' } }, tenders: { orderBy: { type: 'asc' } }, refunds: { orderBy: { sequence: 'asc' } } }

// operation is a DB-only unit; all provider calls belong outside this retry.
// Lock order: settlement -> existing account advisory lock. Never the reverse.
export async function onlineFinancialTransaction(prisma, settlementId, operation, { maxAttempts = 5 } = {}) {
  if (typeof settlementId !== 'string' || !settlementId || settlementId.length > 160) throw httpError('结算标识无效', 400)
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) throw Error('ONLINE_RETRY_LIMIT_INVALID')
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`online-settlement:${settlementId}`}, 0))`
        const before = await tx.onlineSettlement.findUnique({ where: { id: settlementId }, include })
        // Snapshot before exposing the row to callback code; in-place callback
        // mutation must not conceal a committed financial change.
        const oldEnvelope = onlineFinancialEnvelope(before)
        const result = await operation(tx, before)
        const after = await tx.onlineSettlement.findUnique({ where: { id: settlementId }, include })
        const envelope = onlineFinancialEnvelope(after)
        if (JSON.stringify(oldEnvelope) !== JSON.stringify(envelope)) {
          if (!after || after.version !== (oldEnvelope ? oldEnvelope.version + 1 : 1)) throw httpError('结算同步版本冲突', 409)
          const eventKey = `online:${settlementId}:${after.version}`
          await tx.onlineOutbox.create({ data: {
            id: crypto.randomUUID(), eventKey, settlementId, version: after.version,
            type: 'FINANCIAL_SNAPSHOT', payload: envelope,
          } })
        }
        return result
      }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 10000 })
    } catch (error) {
      // Only a proven transaction abort is retryable. Unknown commit outcomes
      // must be resolved by the caller's original idempotency identity.
      const code = error?.meta?.code
      if (error?.code !== 'P2034' && !['40001', '40P01'].includes(code)) throw error
      if (attempt === maxAttempts - 1) throw httpError('结算处理中，请使用原请求重试', 409)
      await pause(Math.min(100, 5 * 2 ** attempt) + crypto.randomInt(5))
    }
  }
}

// P0 AUTHORITATIVE RECOVERY for one online settlement.
// The provider has already been queried and proven NOTPAY (no money moved), so
// this calls the EXISTING authoritative recovery path (close -> re-query ->
// release -> CANCELLED). It creates no second cancellation authority and writes
// no ledger rows. No secret is printed.
import { prisma } from '/app/server/pg.js'
import { loadOnlineCheckoutConfig } from '/app/server/online-checkout-config.js'
import { createOnlinePaymentService } from '/app/server/online-payment-service.js'

const ID = process.argv[2]
if (!ID) { console.log('USAGE: node p0-recover.mjs <settlementId>'); process.exit(1) }

const cfg = loadOnlineCheckoutConfig()
const payment = createOnlinePaymentService(prisma, cfg.paymentConfig, { env: process.env })

const shape = s => ({
  status: s.status, reason: s.reconciliationReason, version: s.version,
  paidAt: s.paidAt, cancelledAt: s.cancelledAt, updatedAt: s.updatedAt,
})

const before = await prisma.onlineSettlement.findUnique({ where: { id: ID }, include: { tenders: true, reservation: true } })
if (!before) { console.log('SETTLEMENT_NOT_FOUND'); await prisma.$disconnect(); process.exit(2) }
console.log('BEFORE:', JSON.stringify(shape(before)))
console.log('BEFORE tenders:', before.tenders.map(t => `${t.type}=${t.status}`).join(' ') || '(none)')
console.log('BEFORE reservation:', before.reservation ? before.reservation.status : '(none)')
console.log('--- calling authoritative recover() ---')

let result
try { result = await payment.recover(ID) } catch (e) {
  console.log('RECOVER_THREW:', e.status || '', e.code || '', e.message)
  await prisma.$disconnect(); process.exit(3)
}
console.log('recover() returned:', JSON.stringify(result))

const after = await prisma.onlineSettlement.findUnique({ where: { id: ID }, include: { tenders: true, reservation: true } })
console.log('AFTER:', JSON.stringify(shape(after)))
console.log('AFTER tenders:', after.tenders.map(t => `${t.type}=${t.status}`).join(' ') || '(none)')
console.log('AFTER reservation:', after.reservation ? after.reservation.status : '(none)')
console.log('---')
console.log('TERMINAL:', ['PAID', 'CANCELLED', 'EXPIRED', 'REFUNDED'].includes(after.status))
console.log('REORDER_UNBLOCKED:', !['PENDING', 'CLOSING'].includes(after.status))
await prisma.$disconnect()

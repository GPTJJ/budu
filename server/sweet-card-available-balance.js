import { httpError } from './pos-core.js'

// Use inside the account lock for spending. Preview reads are advisory only.
// Expired timestamps do not release holds: provider reconciliation must first
// transition the reservation to RELEASED/EXPIRED. This remains active with the
// online feature OFF so rollback/flag changes cannot expose reserved funds.
export async function sweetCardAvailableBalance(tx, account) {
  if (!account?.id || !tx.sweetCardReservation?.aggregate) throw httpError('甜意卡可用余额服务暂不可用', 503)
  const sums = await tx.sweetCardReservation.aggregate({
    where: { accountId: account.id, status: 'RESERVED' }, _sum: { amountCents: true },
  })
  const balance = BigInt(account.balanceCents)
  const reserved = BigInt(sums._sum.amountCents ?? 0n)
  if (balance < 0n || reserved < 0n || reserved > balance) throw httpError('甜意卡余额核对异常，请稍后重试', 409)
  return { balanceCents: balance, reservedCents: reserved, availableCents: balance - reserved }
}

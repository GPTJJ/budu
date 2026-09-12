// Read-only, snapshot-consistent financial certification. Counts, not customer
// identities or credentials, are exported. Pending provider obligations are
// reported separately; they are never mislabeled settled or released.
export async function reconcileOnlineFinancials(prisma) {
  return prisma.$transaction(async tx => {
    const rows = await tx.onlineSettlement.findMany({ include: { tenders: true, refunds: true, compensations: true, reservation: true } })
    const result = { settlements: rows.length, settled: 0, pendingRefunds: 0, pendingCompensations: 0,
      activeReservations: 0, overdueReservations: 0, mismatches: 0, monetaryDeltaCents: '0' }
    let delta = 0n
    const accountIds = new Set()
    const fail = () => { result.mismatches++ }
    for (const s of rows) {
      if (s.accountId) accountIds.add(s.accountId)
      if (s.totalCents !== s.sweetCardCents + s.wechatCents) fail()
      if (s.tenders.reduce((n, t) => n + t.amountCents, 0n) !== s.totalCents) fail()
      if (['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(s.status)) {
        result.settled++
        const captured = s.tenders.filter(t => t.status === 'SUCCEEDED').reduce((n, t) => n + t.amountCents, 0n)
        delta += s.totalCents - captured
        if (captured !== s.totalCents) fail()
      }
      if (s.sweetCardCents > 0n && s.reservation?.amountCents !== s.sweetCardCents) fail()
      if (s.reservation?.status === 'RESERVED') {
        result.activeReservations++
        if (s.expiresAt < new Date()) result.overdueReservations++
        if (!['PENDING', 'CLOSING'].includes(s.status)) fail()
      }
      if (s.capturedLedgerId) {
        const ledger = await tx.sweetCardLedger.findUnique({ where: { id: s.capturedLedgerId } })
        if (!ledger || ledger.accountId !== s.accountId || ledger.type !== 'REDEEM' || ledger.amountCents !== -s.sweetCardCents) fail()
      } else if (s.sweetCardCents > 0n && ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(s.status)) fail()
      let total = 0n, sc = 0n, wx = 0n
      for (const r of s.refunds) {
        total += r.totalCents; sc += r.sweetCardCents; wx += r.wechatCents
        if (r.totalCents !== r.sweetCardCents + r.wechatCents || r.wechatCents < r.shippingCents) fail()
        if (r.status !== 'SETTLED') { result.pendingRefunds++; if (r.creditedLedgerId) fail(); continue }
        if (r.wechatCents > 0n && (r.providerStatus !== 'SUCCESS' || !r.verifiedAt || !r.providerRefundId)) fail()
        if (r.sweetCardCents > 0n) {
          const ledger = r.creditedLedgerId && await tx.sweetCardLedger.findUnique({ where: { id: r.creditedLedgerId } })
          if (!ledger || ledger.accountId !== s.accountId || ledger.type !== 'REFUND' || ledger.amountCents !== r.sweetCardCents) fail()
        }
      }
      if (total > s.totalCents || sc > s.sweetCardCents || wx > s.wechatCents) fail()
      for (const c of s.compensations) {
        if (c.status !== 'SETTLED') result.pendingCompensations++
        else if (c.providerStatus !== 'SUCCESS' || !c.verifiedAt || !c.providerRefundId) fail()
        if (s.capturedLedgerId || c.amountCents !== s.wechatCents) fail()
      }
    }
    for (const id of accountIds) {
      const a = await tx.sweetCardAccount.findUnique({ where: { id } })
      const ledger = await tx.sweetCardLedger.aggregate({ where: { accountId: id }, _sum: { amountCents: true } })
      const held = await tx.sweetCardReservation.aggregate({ where: { accountId: id, status: 'RESERVED' }, _sum: { amountCents: true } })
      const difference = a.balanceCents - (ledger._sum.amountCents || 0n)
      delta += difference
      if (difference !== 0n || a.balanceCents < (held._sum.amountCents || 0n)) fail()
    }
    result.monetaryDeltaCents = String(delta)
    result.pass = result.mismatches === 0 && delta === 0n
    result.operationallyClear = result.pass && result.overdueReservations === 0
      && result.pendingRefunds === 0 && result.pendingCompensations === 0
    return result
  }, { isolationLevel: 'RepeatableRead', timeout: 60000 })
}

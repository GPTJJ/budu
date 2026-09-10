// Internal composition only. This scanner never creates payments or interprets
// provider truth. recover() is the verified, idempotent PG payment service.
// No purchase rollout flag is read: outstanding obligations survive flag OFF.
export function createOnlinePaymentRecovery(prisma, paymentService, { batchSize = 20 } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100
    || typeof paymentService?.recover !== 'function') throw Error('ONLINE_RECOVERY_CONFIG_INVALID')
  let cursor = null, highWater = null, inFlight = null
  async function scan(signal) {
    const summary = { scanned: 0, resolved: 0, pending: 0, failed: 0, stopped: false }
    if (signal?.aborted) return { ...summary, stopped: true }
    const eligible = {
        status: { in: ['PENDING', 'CLOSING'] },
        OR: [
          { status: 'CLOSING' }, { expiresAt: { lte: new Date() } },
          { tenders: { some: { type: 'WECHAT', prepayRequestedAt: { not: null } } } },
        ],
    }
    // Freeze a finite pass boundary. Continuous arrivals must not prevent
    // retries of earlier ambiguous/failed payments indefinitely.
    if (!highWater) {
      const end = await prisma.onlineSettlement.findFirst({ where: eligible, orderBy: { id: 'desc' }, select: { id: true } })
      if (!end) return summary
      highWater = end.id
    }
    const rows = await prisma.onlineSettlement.findMany({
      where: { ...eligible, id: { lte: highWater, ...(cursor ? { gt: cursor } : {}) } },
      orderBy: { id: 'asc' }, take: batchSize, select: { id: true },
    })
    if (!rows.length) { cursor = null; highWater = null }
    for (const row of rows) {
      if (signal?.aborted) { summary.stopped = true; break }
      try {
        const result = await paymentService.recover(row.id)
        if (['PAID', 'CANCELLED', 'EXPIRED', 'RECONCILIATION_REQUIRED'].includes(result?.status)) summary.resolved++
        else summary.pending++
      } catch {
        // Do not emit provider errors, identities, raw messages or credentials.
        // Financial state remains durable. Advance past a poison item so other
        // customers are checked; it is retried on the next full scan/restart.
        summary.failed++
      }
      summary.scanned++
      cursor = row.id
    }
    if (!summary.stopped && (rows.length < batchSize || cursor === highWater)) { cursor = null; highWater = null }
    return summary
  }
  return {
    tick({ signal } = {}) {
      // Share the actual work promise; never abandon in-flight provider work
      // just to start a competing interval after an observation timeout.
      if (!inFlight) inFlight = scan(signal).finally(() => { inFlight = null })
      return inFlight
    },
  }
}

export function startOnlinePaymentRecovery(worker, { intervalMs = 5000, onResult = () => {} } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 300000
    || typeof worker?.tick !== 'function' || typeof onResult !== 'function') throw Error('ONLINE_RECOVERY_CONFIG_INVALID')
  const controller = new AbortController()
  let timer, active
  async function run() {
    let result
    try { result = await worker.tick({ signal: controller.signal }) }
    catch { result = { status: 'RECOVERY_SCAN_FAILED' } }
    try { Promise.resolve(onResult(result)).catch(() => {}) } catch { /* telemetry must not stop recovery */ }
    if (!controller.signal.aborted) {
      timer = setTimeout(() => { active = run() }, intervalMs)
      timer.unref?.()
    }
  }
  active = run()
  return {
    async stop() {
      controller.abort()
      clearTimeout(timer)
      // Drain the current item. Its transport owns the absolute I/O deadline.
      await active
    },
  }
}

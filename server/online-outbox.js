import crypto from 'node:crypto'

// Each lease has a fresh fencing token. An expired worker cannot acknowledge or
// clear a later worker's lease. Delivery is intentionally at-least-once: the
// CloudBase receiver MUST deduplicate eventKey and ignore older versions.
export async function claimOnlineOutbox(prisma, { leaseMs = 30000 } = {}) {
  if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 120000) throw Error('ONLINE_LEASE_INVALID')
  const owner = crypto.randomUUID()
  const rows = await prisma.$queryRaw`
    WITH candidate AS (
      SELECT id FROM online_outbox
      WHERE delivered_at IS NULL AND available_at <= clock_timestamp()
        AND (lease_until IS NULL OR lease_until <= clock_timestamp())
      ORDER BY available_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE online_outbox AS o SET lease_owner=${owner},
      lease_until=clock_timestamp()+(${leaseMs} * interval '1 millisecond'), attempts=o.attempts+1
    FROM candidate WHERE o.id=candidate.id
    RETURNING o.id, o.event_key, o.version, o.payload, o.lease_owner, o.attempts`
  return rows[0] || null
}

export async function acknowledgeOnlineOutbox(prisma, event, acknowledgement) {
  if (acknowledgement?.eventKey !== event.event_key || acknowledgement?.version !== event.version
      || !['APPLIED', 'ALREADY_APPLIED', 'SUPERSEDED'].includes(acknowledgement?.status)) throw Error('ONLINE_MIRROR_ACK_INVALID')
  const rows = await prisma.$queryRaw`
    UPDATE online_outbox SET delivered_at=clock_timestamp(), lease_owner=NULL, lease_until=NULL, last_error=NULL
    WHERE id=${event.id} AND lease_owner=${event.lease_owner} AND delivered_at IS NULL AND lease_until>clock_timestamp()
    RETURNING id`
  return rows.length === 1
}

export async function failOnlineOutbox(prisma, event) {
  const delay = Math.min(300000, 1000 * 2 ** Math.min(event.attempts, 8))
  return prisma.$executeRaw`
    UPDATE online_outbox SET lease_owner=NULL, lease_until=NULL, last_error='MIRROR_DELIVERY_FAILED',
      available_at=clock_timestamp()+(${delay} * interval '1 millisecond')
    WHERE id=${event.id} AND lease_owner=${event.lease_owner} AND delivered_at IS NULL`
}

// Single bounded work item. Called by a recovery loop independent of purchase
// rollout flags. The transport must authenticate the server-to-server receiver.
export async function deliverOnlineOutboxOnce(prisma, deliver, options) {
  const event = await claimOnlineOutbox(prisma, options)
  if (!event) return { status: 'IDLE' }
  let timer
  try {
    const signal = AbortSignal.timeout(10000)
    const acknowledgement = await Promise.race([
      Promise.resolve().then(() => deliver({ eventKey: event.event_key, version: event.version, payload: event.payload }, { signal })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('ONLINE_MIRROR_TIMEOUT')), 10000) }),
    ])
    const acknowledged = await acknowledgeOnlineOutbox(prisma, event, acknowledgement)
    return { status: acknowledged ? 'DELIVERED' : 'LEASE_LOST' }
  } catch {
    await failOnlineOutbox(prisma, event)
    return { status: 'RETRY_PENDING' }
  } finally { clearTimeout(timer) }
}

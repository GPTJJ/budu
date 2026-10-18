// Confirmed historical last operating day; this constant never changes active.
export const CHAOWAI_BUSINESS_CLOSED_ON = '2026-10-13'
const DAY_MS = 86400000

function dayStart(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return NaN
  const stamp = Date.parse(`${value}T00:00:00+08:00`)
  return Number.isFinite(stamp) && new Date(stamp + 8 * 3600000).toISOString().slice(0, 10) === value ? stamp : NaN
}

export function storeBusinessDate(value) {
  const stamp = new Date(value).getTime()
  return Number.isFinite(stamp) ? new Date(stamp + 8 * 3600000).toISOString().slice(0, 10) : null
}

function eventsFor(store) {
  return (Array.isArray(store?.statusHistory) ? store.statusHistory : [])
    .filter(event => typeof event?.active === 'boolean' && Number.isFinite(Date.parse(event.executedAt)))
    .map(event => ({ ...event, stamp: Date.parse(event.executedAt) }))
    .sort((a, b) => a.stamp - b.stamp)
}

/** Last operating date is presentation metadata; it cannot authorize writes. */
export function storeBusinessClosedOn(store) {
  if (store?.active !== false) return null
  const last = eventsFor(store).filter(event => event.action === 'DISABLE_STORE').at(-1)
  if (last) return Number.isFinite(dayStart(last.businessClosedOn)) ? last.businessClosedOn : storeBusinessDate(last.executedAt)
  return store?.key === 'chaowai' ? CHAOWAI_BUSINESS_CLOSED_ON : null
}

/** Whether an operating interval overlaps inclusive Shanghai business dates. */
export function storeOperatedInPeriod(store, firstDate, lastDate = firstDate) {
  const from = dayStart(firstDate), last = dayStart(lastDate)
  if (!store || !Number.isFinite(from) || !Number.isFinite(last) || last < from) return false
  const until = last + DAY_MS
  const history = eventsFor(store)
  const created = history.find(event => event.action === 'CREATE_STORE')
  const changes = history.filter(event => event.action !== 'CREATE_STORE')
  // Unaudited Store.createdAt may be a migration timestamp, not an opening date.
  // Every store created by the managed API has its CREATE audit in the same tx.
  const recordedBirth = created?.stamp ?? -Infinity
  let started = Number.isFinite(recordedBirth) ? recordedBirth : -Infinity
  let active = created ? created.active : changes.length ? !changes[0].active : store.active === true
  const overlaps = end => active && started < until && end > from && end > started
  // A migrated inactive store's first audited ENABLE only proves its reopening.
  // It does not prove there was no business before audits were introduced.
  if (!created && changes[0]?.action === 'ENABLE_STORE') {
    const legacyEnd = store.key === 'chaowai'
      ? Math.min(changes[0].stamp, dayStart(CHAOWAI_BUSINESS_CLOSED_ON) + DAY_MS)
      : changes[0].stamp
    if (started < until && legacyEnd > from && legacyEnd > started) return true
  }
  if (!history.length && store.active === false && store.key === 'chaowai') {
    return dayStart(CHAOWAI_BUSINESS_CLOSED_ON) + DAY_MS > from
  }
  // A legacy inactive identity without an audited closure date still keeps
  // historical visibility. Absence of an audit is not proof it never operated.
  if (!history.length && store.active === false) return started < until
  for (const event of changes) {
    const closedOn = event.action === 'DISABLE_STORE' ? dayStart(event.businessClosedOn) : NaN
    const ended = Number.isFinite(closedOn) ? closedOn + DAY_MS : event.stamp
    if (overlaps(ended)) return true
    active = event.active
    started = ended
  }
  return overlaps(Infinity)
}

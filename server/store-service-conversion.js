import { httpError } from './customer-request-core.js'
const DAY = 86400000
const time = value => new Date(value).getTime()
const unique = values => new Set(values).size
export function serviceReportRange(query, now = new Date()) {
  const today = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10)
  const from = query.from || new Date(now.getTime() - 29 * DAY + 8 * 3600000).toISOString().slice(0, 10), to = query.to || today
  if (![from, to].every(s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s))) throw httpError('日期格式不正确', 400)
  const start = new Date(`${from}T00:00:00+08:00`), end = new Date(time(`${to}T00:00:00+08:00`) + DAY)
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || end <= start || end - start > 93 * DAY) throw httpError('请选择不超过93天的有效日期范围', 400)
  if (new Date(+start + 8 * 3600000).toISOString().slice(0, 10) !== from || new Date(+end - DAY + 8 * 3600000).toISOString().slice(0, 10) !== to) throw httpError('日期不存在', 400)
  if (query.type && !['MAILING', 'INVOICE'].includes(query.type)) throw httpError('服务类型无效', 400)
  return { start, end, storeKey: String(query.storeKey || ''), type: String(query.type || '') }
}
export function serviceConversion({ requests, visits, payments, range, now = new Date() }) {
  const matches = r => (!range.storeKey || r.storeKey === range.storeKey) && (!range.type || r.type === range.type)
  const inRange = value => value && time(value) >= +range.start && time(value) < +range.end
  const cohort = requests.filter(r => r.customerUserId && r.status === 'SUBMITTED' && inRange(r.submittedAt) && matches(r))
  const byId = new Map(requests.map(r => [r.id, r]))
  const events = visits.filter(v => inRange(v.createdAt) && byId.has(v.requestId) && matches(byId.get(v.requestId)))
  const allSubmitted = requests.filter(r => r.customerUserId && r.submittedAt && r.status === 'SUBMITTED')
  const authoritativePayments = [...new Map(payments.filter(p => p.paidAt && ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status)).map(p => [p.id, p])).values()]
    .map(p => {
      const wechat = p.tenders?.find(t => t.kind === 'WECHAT' || t.type === 'WECHAT')
      // Unknown verified provider time cannot establish a service-after-payment relation.
      const wxTime = wechat?.providerSuccessAt || p.tenders?.find(t => t.providerSuccessAt)?.providerSuccessAt
      return { ...p, observedPaidAt: BigInt(p.wechatCents || 0) > 0n ? wxTime : p.paidAt }
    })
  const cohortIds = new Set(cohort.map(r => r.id))
  const windows = [7, 30].map(days => {
    let paid = 0n, refund = 0n, orders = 0
    const customers = new Set(), returning = new Set()
    for (const p of authoritativePayments) {
      if (!p.observedPaidAt || time(p.observedPaidAt) > +now) continue
      // Attribute globally first. Filters must never create a second attribution.
      const candidates = allSubmitted.filter(r => r.customerUserId === p.userId && time(r.submittedAt) < time(p.observedPaidAt)
        && time(p.observedPaidAt) <= time(r.submittedAt) + days * DAY)
        .sort((a, b) => time(b.submittedAt) - time(a.submittedAt) || b.id.localeCompare(a.id))
      const owner = candidates[0]
      if (!owner || !cohortIds.has(owner.id)) continue
      orders++; customers.add(p.userId); paid += BigInt(p.totalCents)
      refund += (p.refunds || []).filter(r => r.status === 'SETTLED' && r.settledAt && time(r.settledAt) <= +now).reduce((sum, r) => sum + BigInt(r.totalCents), 0n)
      if (authoritativePayments.some(old => old.userId === p.userId && old.observedPaidAt && time(old.observedPaidAt) < time(owner.submittedAt))) returning.add(p.userId)
    }
    return { days, customers: customers.size, orders, paidCents: String(paid), refundCents: String(refund),
      immatureApplications: cohort.filter(r => time(r.submittedAt) + days * DAY > +now).length,
      firstPurchaseCustomers: null, returningCustomers: returning.size, unknownHistoryCustomers: customers.size - returning.size }
  })
  return { scannedCustomers: unique(events.filter(v => v.event === 'SCAN').map(v => v.userId)),
    submittedCustomers: unique(cohort.map(r => r.customerUserId)), mallVisitors: unique(events.filter(v => v.event === 'MALL').map(v => v.userId)),
    anonymousVisits: null, windows, asOf: now.toISOString(),
    coverageNote: '北京时间；扫码/商城人数按事件发生日期，提交按首次提交日期。7/30日为累计窗口（不相加），订单全门店最近申请归因。仅统计 PostgreSQL 权威线上已支付订单；退款单列为截至统计时点的已结算退款。微信采用已核验付款时间，缺失则不归因。CloudBase旧支付链未纳入，故无可核验历史者为未知，未识别访问未采集；这些是关联购买观察，不代表因果新增销售。' }
}
export async function queryServiceConversion(db, query, now = new Date()) {
  const range = serviceReportRange(query, now)
  const requests = await db.customerServiceRequest.findMany({ where: { OR: [
    { submittedAt: { gte: new Date(+range.start - 30 * DAY), lt: new Date(Math.min(+now + 1, +range.end + 30 * DAY)) } },
    { createdAt: { gte: range.start, lt: range.end } },
  ] }, take: 20001 })
  const visits = await db.storeServiceVisit.findMany({ where: { createdAt: { gte: range.start, lt: range.end } }, take: 50001 })
  const missingIds = [...new Set(visits.map(v => v.requestId))].filter(id => !requests.some(r => r.id === id))
  if (missingIds.length) requests.push(...await db.customerServiceRequest.findMany({ where: { id: { in: missingIds } }, take: 20001 }))
  const customers = [...new Set(requests.map(r => r.customerUserId).filter(Boolean))]
  const payments = customers.length ? await db.onlineSettlement.findMany({ where: { userId: { in: customers }, paidAt: { not: null },
    status: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] } }, include: { tenders: true, refunds: true }, take: 50001 }) : []
  if (requests.length > 20000 || visits.length > 50000 || payments.length > 50000) throw httpError('数据量较大，请缩小日期范围', 400)
  return serviceConversion({ requests, visits, payments, range, now })
}

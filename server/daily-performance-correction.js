import crypto from 'node:crypto'
import { Router } from 'express'
import { prisma } from './pg.js'
import { httpError } from './pos-core.js'
import { canCorrectDailyPerformance } from '../shared/accountPermissions.js'
import { buduBusinessDate } from '../shared/businessDate.js'
import { normalizeDailyStaffSubmission, resolveDailyStaffSubmission, replaceDailyStaff, serializeEntry, serializeStaff, aggregatePosDay, effectiveSource } from './daily-entry-upgrade.js'

const jsonValue = (value) => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item))
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(jsonValue(value))).digest('hex')
function authorize(actor) {
  if (!canCorrectDailyPerformance(actor)) throw httpError('仅开发者或最高权限管理员可以更正历史事实', 403)
}
function day(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw httpError('营业日期不正确')
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value > buduBusinessDate()) throw httpError('营业日期不正确或尚未发生')
  return date
}
async function snapshot(tx, storeKey, date) {
  const entry = await tx.dailyEntry.findUnique({ where: { storeKey_date: { storeKey, date } } })
  const staff = await tx.dailyStoreStaff.findMany({ where: { storeId: storeKey, date }, orderBy: { id: 'asc' } })
  const store = await tx.store.findUnique({ where: { key: storeKey } })
  if (!store) throw httpError('门店不存在')
  const source = entry?.salesDataStatus === 'corrected' ? 'manual' : effectiveSource(store, date.toISOString().slice(0, 10))
  const pos = source === 'manual' ? null : await aggregatePosDay(storeKey, date.toISOString().slice(0, 10), tx)
  // Include the displayed POS facts in the concurrency token; never silently
  // prefill a POS store with DailyEntry's legacy zero placeholder.
  const sales = { source, incCents: pos ? (BigInt(pos.effectiveAfterRefund) + (source === 'hybrid' ? entry?.hybridAdjustmentCents || 0n : 0n)).toString() : String(entry?.incCents || 0), ord: pos ? pos.orderCount : entry?.ord || 0 }
  return { entry, staff, sales }
}
export async function getDailyCorrectionContext(db, { actor, storeKey, date }) {
  authorize(actor)
  return db.$transaction(async (tx) => {
    const facts = await snapshot(tx, storeKey, day(date))
    const [stores, employees, audits] = await Promise.all([
      tx.store.findMany({ select: { key: true, name: true }, orderBy: { name: 'asc' } }),
      tx.employee.findMany({ where: { status: { in: ['ACTIVE', 'PROBATION'] } }, select: { id: true, name: true, employeeNo: true }, orderBy: { name: 'asc' } }),
      tx.dailyEntryAuditLog.findMany({ where: { module: 'daily_correction', date: day(date), OR: [
        { storeId: storeKey }, ...(facts.entry ? [{ afterValue: { path: ['entry', 'id'], equals: facts.entry.id } }] : []),
      ] }, orderBy: { createdAt: 'desc' } }),
    ])
    return { entry: serializeEntry(facts.entry), staff: facts.staff.map(serializeStaff), sales: facts.sales, token: digest(facts), stores, employees, audits: jsonValue(audits) }
  }, { isolationLevel: 'RepeatableRead' })
}

export async function correctDailyPerformance(db, input) {
  authorize(input.actor)
  const { actor } = input
  const date = day(input.date)
  const from = String(input.storeKey || '').trim()
  const to = String(input.targetStoreKey || from).trim()
  if (!from || !to || from.length > 100 || to.length > 100) throw httpError('请选择门店')
  const reason = String(input.reason || '').trim()
  if (!reason || reason.length > 500) throw httpError('请填写更正原因（最多500字）')
  if (!/^[a-f0-9]{64}$/.test(input.token || '')) throw httpError('请重新打开记录后核对', 409)
  if (!/^[\w-]{8,100}$/.test(input.requestKey || '')) throw httpError('更正请求标识不正确')
  const cents = Number(input.incCents), ord = Number(input.ord)
  if (input.incCents === '' || input.ord === '' || input.incCents == null || input.ord == null || !Number.isSafeInteger(cents) || cents < 0 || cents > 999999999999 || !Number.isInteger(ord) || ord < 0 || ord > 999999) throw httpError('请完整填写有效营业额与订单数')
  const normalized = normalizeDailyStaffSubmission(input.items)
  if (!normalized.length) throw httpError('请填写实际值班人员及工时')
  const auditId = `correction-${digest([actor.id, input.requestKey])}`
  const commandHash = digest({ from, to, date: input.date, token: input.token, cents, ord, normalized, reason })
  try {
    return await db.$transaction(async (tx) => {
      for (const key of [...new Set([from, to])].sort()) {
        await tx.$queryRawUnsafe('SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtext($1))) l', `daily-entry:${key}:${input.date}`)
      }
      const replay = await tx.dailyEntryAuditLog.findUnique({ where: { id: auditId } })
      if (replay) {
        if (replay.afterValue.commandHash !== commandHash) throw httpError('相同请求标识对应不同内容', 409)
        return { ok: true, reused: true, correctionId: replay.id, entry: replay.afterValue.entry }
      }
      const before = await snapshot(tx, from, date)
      if (digest(before) !== input.token) throw httpError('记录或工时已被修改，请重新打开核对', 409)
      if (!before.entry && before.staff.length) throw httpError('该日期有孤立工时记录，需要先复核，不能直接补录', 409)
      const target = await tx.store.findUnique({ where: { key: to } })
      if (!target) throw httpError('目标门店不存在')
      if (to !== from) {
        const occupied = await snapshot(tx, to, date)
        if (occupied.entry || occupied.staff.length) throw httpError('目标门店当天已有记录或工时，禁止覆盖或自动合并', 409)
      }
      const parsed = await resolveDailyStaffSubmission(tx, normalized, to)
      const employeeIds = [...new Set([...before.staff, ...parsed].map((row) => row.employeeId).filter(Boolean))].sort()
      // The same lock namespace as payroll issuance prevents a simultaneous issue
      // from observing only part of a correction.
      for (const id of employeeIds) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`
      const notices = await tx.payrollNotice.findMany({ where: { periodStart: { lte: date }, periodEnd: { gte: date },
        OR: [{ employeeId: { in: employeeIds } }, { employeeId: null }],
      }, orderBy: { id: 'asc' } })
      const payrollState = {
        // pending means issued but not yet acknowledged: protect it as issued.
        status: notices.some((row) => !['recalled', 'deleted'].includes(row.status)) ? 'PAID' : 'UNPAID',
        authority: 'payroll_notices issued snapshot (pending/confirmed); not bank settlement',
        notices: notices.map((row) => ({ id: row.id, employeeId: row.employeeId, status: row.status, checksum: digest(row) })),
      }
      if (to !== from) {
        if (before.staff.some((row) => row.payableHoursSource !== 'ACTUAL_HOURS' || !['EMPLOYEE', 'NON_EMPLOYEE_SUBSTITUTE'].includes(row.participantType))) throw httpError('历史人员或计薪工时权威待复核，禁止移动', 409)
        await tx.dailyStoreStaff.updateMany({ where: { storeId: from, date }, data: { storeId: to } })
      }
      const staff = await replaceDailyStaff(tx, { storeKey: to, dateStr: input.date, parsed, actor, reason })
      const data = { storeKey: to, incCents: BigInt(cents), ord, staffNames: staff.map((row) => row.staffNameSnapshot),
        status: 'confirmed', salesDataStatus: 'corrected', updatedBy: actor.username,
        confirmedAt: before.entry?.confirmedAt || new Date(), confirmedBy: before.entry?.confirmedBy || actor.username }
      const entry = before.entry
        ? await tx.dailyEntry.update({ where: { id: before.entry.id, version: before.entry.version }, data: { ...data, version: { increment: 1 } } })
        : await tx.dailyEntry.create({ data: { ...data, id: `de-${crypto.randomUUID()}`, date, version: 1 } })
      const after = { entry: serializeEntry(entry), participants: staff.map(serializeStaff), actorRole: actor.role, payrollState, commandHash,
        storeBefore: from, storeAfter: to, businessDate: input.date, correctionId: auditId }
      await tx.dailyEntryAuditLog.create({ data: { id: auditId, storeId: to, date, module: 'daily_correction', fieldName: before.entry ? 'historical_facts' : 'historical_supplement',
        reason, operatorId: actor.id, operatorName: actor.username, beforeValue: jsonValue({ entry: before.entry, sales: before.sales, participants: before.staff }), afterValue: jsonValue(after) } })
      const afterNotices = await tx.payrollNotice.findMany({ where: { id: { in: notices.map((row) => row.id) } }, orderBy: { id: 'asc' } })
      if (digest(notices) !== digest(afterNotices)) throw httpError('已发工资快照发生变化，更正已回滚', 409)
      return { ok: true, correctionId: auditId, entry: serializeEntry(entry), staff: staff.map(serializeStaff), payrollState }
    }, { isolationLevel: 'Serializable', timeout: 15000 })
  } catch (error) {
    if (['P2002', 'P2025', 'P2034'].includes(error.code)) throw httpError('记录已变化或目标日期被占用，请重新打开核对', 409)
    throw error
  }
}

export const dailyCorrectionRouter = Router()
const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req)) } catch (error) {
    if (!error.status) console.error('[daily-correction]', error.code || error.name)
    res.status(error.status || 500).json({ error: error.status ? error.message : '更正失败，未保存，请重试' })
  }
}
dailyCorrectionRouter.get('/daily-entry/correction', wrap((req) => getDailyCorrectionContext(prisma, { actor: req.user, storeKey: String(req.query.store || ''), date: String(req.query.date || '') })))
dailyCorrectionRouter.post('/daily-entry/correction', wrap((req) => correctDailyPerformance(prisma, { ...req.body, actor: req.user })))

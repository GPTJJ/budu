import crypto from 'node:crypto'
import { Router } from 'express'
import { prisma, dbReady } from './pg.js'
import { httpError } from './pos-core.js'
import { isStoreKey } from '../shared/storeDirectory.js'
import { CHAOWAI_BUSINESS_CLOSED_ON, storeBusinessDate } from '../shared/storeOperationDates.js'
import { readStoreDirectory, storeDirectoryRow } from './store-operation-policy.js'

const TX_OPTIONS = { timeout: 10000, maxWait: 3000 }
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

function developer(actor) {
  if (!actor?.id || actor.role !== 'developer' || actor.status !== 'active') {
    throw httpError('仅在职开发者可管理门店', 403)
  }
}

async function lockDeveloper(tx, actor) {
  developer(actor)
  await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR SHARE', actor.id)
  const current = await tx.user.findUnique({ where: { id: actor.id }, select: { id: true, username: true, role: true, status: true } })
  developer(current)
  return current
}

function textField(value, label, limit, { empty = false } = {}) {
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) throw httpError(`${label}格式不正确`, 400)
  const result = value.trim()
  if ((!empty && !result) || result.length > limit) throw httpError(`${label}${empty ? '最多' : '需为1–'}${limit}个字符`, 400)
  return result
}

function storeKey(value) {
  if (!isStoreKey(value)) throw httpError('门店不存在', 404)
  return value
}

async function lockStore(tx, key) {
  await tx.$queryRawUnsafe('SELECT key FROM "Store" WHERE key = $1 FOR UPDATE', key)
  const store = await tx.store.findUnique({ where: { key } })
  if (!store) throw httpError('门店不存在', 404)
  return store
}

async function appendAudit(tx, actor, { id = `store-event-${crypto.randomUUID()}`, action, key, before, after, executedAt, ...detail }) {
  await tx.sensitiveRecordAudit.create({ data: {
    id, action, recordType: 'store', recordId: key,
    actorUserId: actor.id, actorUsername: actor.username || '',
    reason: JSON.stringify({ before, after, executedAt, ...detail }),
    createdAt: new Date(executedAt),
  } })
  return id
}

/** Same actor + requestKey always resolves to the same durable Store identity. */
export async function createManagedStore(db, { actor, name, district = '', active = true, requestKey, now = new Date() }) {
  developer(actor)
  const profile = { name: textField(name, '门店名称', 30), district: textField(district, '所在位置', 50, { empty: true }), active }
  if (typeof active !== 'boolean') throw httpError('启用状态必须为布尔值', 400)
  if (typeof requestKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/.test(requestKey)) throw httpError('新增请求标识不正确，请刷新后重试', 400)
  const operation = crypto.createHash('sha256').update(`${actor.id}\0${requestKey}`).digest('hex')
  const auditId = `store-create-${operation}`
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(profile)).digest('hex')
  return db.$transaction(async tx => {
    const currentActor = await lockDeveloper(tx, actor)
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS locked', auditId)
    const previous = await tx.sensitiveRecordAudit.findUnique({ where: { id: auditId } })
    if (previous) {
      let detail
      try { detail = JSON.parse(previous.reason) } catch { throw httpError('新增请求记录无法核实，请联系开发者', 409) }
      if (previous.action !== 'CREATE_STORE' || previous.recordType !== 'store' || previous.actorUserId !== currentActor.id || detail.requestFingerprint !== fingerprint) {
        throw httpError('相同新增请求标识对应的门店资料不一致，请刷新后重试', 409)
      }
      const store = await tx.store.findUnique({ where: { key: previous.recordId } })
      if (!store) throw httpError('新增请求对应门店不存在，请核实后重试', 409)
      return { ok: true, changed: false, reused: true, store: storeDirectoryRow(store) }
    }
    const key = `store-${crypto.randomBytes(10).toString('hex')}`
    const executedAt = new Date(now).toISOString()
    // Independent financial policies intentionally retain their schema defaults.
    const store = await tx.store.create({ data: { key, ...profile, createdAt: new Date(executedAt) } })
    await appendAudit(tx, currentActor, { id: auditId, action: 'CREATE_STORE', key, before: null,
      after: storeDirectoryRow(store), executedAt, requestFingerprint: fingerprint })
    return { ok: true, changed: true, store: storeDirectoryRow(store) }
  }, TX_OPTIONS)
}

export async function updateManagedStore(db, { actor, key: inputKey, name, district, now = new Date() }) {
  developer(actor)
  const key = storeKey(inputKey), data = {}
  if (name !== undefined) data.name = textField(name, '门店名称', 30)
  if (district !== undefined) data.district = textField(district, '所在位置', 50, { empty: true })
  if (!Object.keys(data).length) throw httpError('请填写需要修改的门店资料', 400)
  return db.$transaction(async tx => {
    const currentActor = await lockDeveloper(tx, actor)
    const before = await lockStore(tx, key)
    if (Object.entries(data).every(([field, value]) => (before[field] || '') === value)) {
      return { ok: true, changed: false, store: storeDirectoryRow(before) }
    }
    const store = await tx.store.update({ where: { key }, data })
    await appendAudit(tx, currentActor, { action: 'UPDATE_STORE', key,
      before: { name: before.name, district: before.district || '' }, after: { name: store.name, district: store.district || '' },
      executedAt: new Date(now).toISOString() })
    return { ok: true, changed: true, store: storeDirectoryRow(store) }
  }, TX_OPTIONS)
}

/** Explicit desired state is retry-safe; same-state retries do not append audits. */
export async function setManagedStoreStatus(db, { actor, key: inputKey, active, reason = '', legacyClosedOn = null, now = new Date() }) {
  developer(actor)
  const key = storeKey(inputKey)
  if (typeof active !== 'boolean') throw httpError('启用状态必须为布尔值', 400)
  if (typeof reason !== 'string' || reason.trim().length > 500) throw httpError('操作原因最多500字', 400)
  return db.$transaction(async tx => {
    const currentActor = await lockDeveloper(tx, actor)
    const before = await lockStore(tx, key)
    if (before.active === active) return { ok: true, changed: false, store: storeDirectoryRow(before), ...(legacyClosedOn ? { businessClosedOn: legacyClosedOn } : {}) }
    const previousChange = await tx.sensitiveRecordAudit.findFirst({
      where: { recordType: 'store', recordId: key, action: { in: ['CREATE_STORE', 'ENABLE_STORE', 'DISABLE_STORE'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    // Store's row lock serializes transitions. Keep audit timestamps ordered
    // even when two clicks arrive within the same millisecond.
    const previousStamp = new Date(previousChange?.createdAt).getTime()
    const executedAt = new Date(Math.max(new Date(now).getTime(), Number.isFinite(previousStamp) ? previousStamp + 1 : -Infinity)).toISOString()
    let businessClosedOn
    if (!active) {
      // Preserve the confirmed first Chaowai closure; a later reopen/closure is
      // dated when it happens, never retroactively applied to the old period.
      businessClosedOn = key === 'chaowai' && !previousChange
        ? (legacyClosedOn || CHAOWAI_BUSINESS_CLOSED_ON) : storeBusinessDate(executedAt)
    }
    const store = await tx.store.update({ where: { key }, data: { active } })
    const auditId = await appendAudit(tx, currentActor, { action: active ? 'ENABLE_STORE' : 'DISABLE_STORE', key,
      before: { active: before.active }, after: { active }, executedAt,
      reason: reason.trim() || (active ? '通过门店管理启用' : '通过门店管理停用'),
      ...(!active ? { businessClosedOn } : {}) })
    return { ok: true, changed: true, store: storeDirectoryRow(store), executedAt, auditId, ...(!active ? { businessClosedOn } : {}) }
  }, TX_OPTIONS)
}

function wrap(handler) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      if (!dbReady()) throw httpError('门店服务暂不可用，请稍后重试', 503)
      res.json(await handler(req))
    } catch (error) {
      if (error.code === 'P2002') return res.status(409).json({ error: '门店名称已存在，请使用其他名称' })
      res.status(error.status || 503).json({ error: error.status ? error.message : '门店操作未完成，请刷新核实后重试' })
    }
  }
}

export const storeManagementRouter = Router()
storeManagementRouter.post('/stores', wrap(req => createManagedStore(prisma, {
  actor: req.user, name: req.body?.name, district: req.body?.district, active: req.body?.active, requestKey: req.body?.requestKey,
})))
storeManagementRouter.patch('/stores/:key', wrap(req => updateManagedStore(prisma, {
  actor: req.user, key: req.params.key, name: req.body?.name, district: req.body?.district,
})))
storeManagementRouter.put('/stores/:key/status', wrap(req => setManagedStoreStatus(prisma, {
  actor: req.user, key: req.params.key, active: req.body?.active,
})))

export const publicStoreDirectoryRouter = Router()
publicStoreDirectoryRouter.get('/store-directory', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (!dbReady()) throw Error('STORE_DIRECTORY_UNAVAILABLE')
    const stores = await readStoreDirectory(prisma)
    if (stores.length > 5000 || stores.some(row => typeof row.name !== 'string' || !row.name.trim()
      || row.name.length > 30 || CONTROL_CHARACTERS.test(row.name)
      || typeof row.district !== 'string' || row.district.length > 50 || CONTROL_CHARACTERS.test(row.district))) throw Error('STORE_DIRECTORY_INVALID')
    const response = { ok: true, stores }
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 1024 * 1024) throw Error('STORE_DIRECTORY_TOO_LARGE')
    res.json(response)
  } catch {
    res.status(503).json({ ok: false, error: '门店目录暂不可用，请稍后重试' })
  }
})

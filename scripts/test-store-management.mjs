import assert from 'node:assert/strict'
import test from 'node:test'
import crypto from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createStoreManagementFixture } from './helpers/store-management-fixture.mjs'
import { isStoreKey } from '../shared/storeDirectory.js'
import { storeBusinessDate, storeBusinessClosedOn, storeOperatedInPeriod } from '../shared/storeOperationDates.js'

// Entire suite is synthetic. The only permitted network is its own loopback HTTP.
process.env.APP_ENV = 'test'
process.env.NODE_ENV = 'test'
process.env.DATABASE_URL = 'postgresql://synthetic:synthetic@127.0.0.1:1/store_management_fixture_only'
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'budu-store-management-http-'))
process.env.DATA_STORE = 'file'
process.env.JWT_SECRET = 'synthetic-store-management-secret-no-real-account'
process.env.BUDU_RUNTIME_MODE = 'active'
for (const key of ['WECHAT_WORK_WEBHOOK_URL', 'WXWORK_CORP_ID', 'WXWORK_AGENT_ID', 'WXWORK_SECRET', 'MP_APP_ID', 'MP_APP_SECRET', 'MP_TEMPLATE_ID']) delete process.env[key]
process.env.ONLINE_CHECKOUT_ENABLED = '0'
process.env.WECHAT_PAY_ENABLED = '0'
const originalFetch = globalThis.fetch
let permittedOrigin = null
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  if (!permittedOrigin || url.origin !== permittedOrigin) throw Error('external network forbidden in synthetic store tests')
  return originalFetch(input, options)
}
const db = createStoreManagementFixture()
globalThis.__buduPrisma = db
const { createManagedStore, updateManagedStore, setManagedStoreStatus, publicStoreDirectoryRouter } = await import('../server/store-management.js')
const { readStoreDirectory, assertExistingStore, assertOperatingStore } = await import('../server/store-operation-policy.js')
const { disableChaowai } = await import('../server/store-closure.js')
const { createApp } = await import('../server/app.js')
const { signToken } = await import('../server/auth.js')
const { resetCache } = await import('../server/store.js')
const { resolveStoreName } = await import('../server/store-names.js')

const actor = db.actor
const create = (extra = {}) => createManagedStore(db, { actor, name: '合成新增门店', district: '合成位置', active: true, requestKey: 'synthetic-create-001', now: new Date('2026-10-18T04:00:00Z'), ...extra })
const rejectsStatus = status => error => error.status === status
const operations = [
  passedActor => create({ actor: passedActor }),
  passedActor => updateManagedStore(db, { actor: passedActor, key: 'guanshe', name: '合成改名' }),
  passedActor => updateManagedStore(db, { actor: passedActor, key: 'guanshe', pickupEnabled: false }),
  passedActor => setManagedStoreStatus(db, { actor: passedActor, key: 'guanshe', active: false }),
]

test('新增第五家普通门店：系统生成稳定 key，单事务审计，财务资格使用原 schema 默认', async () => {
  db.reset()
  const result = await create({ name: '  合成新门店  ', district: '  合成位置  ' })
  assert.equal(result.changed, true)
  assert.match(result.store.key, /^store-[a-f0-9]{20}$/)
  assert.equal(isStoreKey(result.store.key), true)
  assert.deepEqual(result.store, { key: result.store.key, name: '合成新门店', district: '合成位置', active: true, pickupEnabled: true })
  assert.equal(db.state.stores.length, 5)
  assert.equal(db.state.stores.at(-1).operationType, 'UNKNOWN')
  assert.equal(db.state.audits.length, 1)
  assert.equal(db.state.audits[0].action, 'CREATE_STORE')
  assert.equal(db.state.audits[0].recordId, result.store.key)
  const rows = await readStoreDirectory(db, { includeHistory: true })
  assert.equal(rows.length, 5)
  assert.equal(rows.find(row => row.key === result.store.key).statusHistory[0].action, 'CREATE_STORE')
  assert.ok(db.calls.includes('transaction:RepeatableRead'))
})

test('新增请求丢失响应后重试及并发重放复用持久身份；相同 requestKey 不同资料拒绝', async () => {
  db.reset()
  const [first, retry] = await Promise.all([create(), create()])
  assert.equal(retry.store.key, first.store.key)
  assert.equal(retry.reused, true)
  assert.equal(db.state.stores.length, 5)
  assert.equal(db.state.audits.length, 1)
  // Reconstructing the service call reads the saved audit, not a process cache.
  await updateManagedStore(db, { actor, key: first.store.key, name: '合成修改后名称' })
  const laterRetry = await create()
  assert.equal(laterRetry.store.key, first.store.key)
  assert.equal(laterRetry.store.name, '合成修改后名称')
  await assert.rejects(create({ name: '不同资料' }), rejectsStatus(409))
  assert.equal(db.state.stores.length, 5)
  assert.equal(db.state.audits.filter(row => row.action === 'CREATE_STORE').length, 1)
})

test('自提选项独立保存、默认支持；只改资料或总启停不覆盖，不改历史营业事件', async () => {
  db.reset()
  const result = await create({ pickupEnabled: false }), key = result.store.key
  assert.equal(result.store.active, true)
  assert.equal(result.store.pickupEnabled, false)
  assert.equal((await assertOperatingStore(db, key, { lock: true })).key, key)
  const before = structuredClone(db.state.facts)
  const audits = db.state.audits.length
  assert.equal((await updateManagedStore(db, { actor, key, pickupEnabled: false })).changed, false)
  assert.equal(db.state.audits.length, audits)
  await updateManagedStore(db, { actor, key, name: '合成仓库改名' })
  assert.equal(db.state.stores.at(-1).pickupEnabled, false)
  await setManagedStoreStatus(db, { actor, key, active: false })
  await setManagedStoreStatus(db, { actor, key, active: true })
  assert.equal(db.state.stores.at(-1).pickupEnabled, false)
  const history = (await readStoreDirectory(db, { includeHistory: true })).find(row => row.key === key).statusHistory
  await updateManagedStore(db, { actor, key, pickupEnabled: true })
  assert.equal(db.state.stores.at(-1).pickupEnabled, true)
  assert.deepEqual((await readStoreDirectory(db, { includeHistory: true })).find(row => row.key === key).statusHistory, history)
  assert.deepEqual(db.state.facts, before)
  const audit = db.state.audits.at(-1)
  assert.equal(audit.action, 'UPDATE_STORE')
  assert.equal(JSON.parse(audit.reason).before.pickupEnabled, false)
  assert.equal(JSON.parse(audit.reason).after.pickupEnabled, true)
})

test('旧三字段新增指纹兼容；原请求重试不覆盖后来关闭的自提设置', async () => {
  db.reset()
  const result = await create(), key = result.store.key
  const oldFingerprint = crypto.createHash('sha256').update(JSON.stringify({ name: '合成新增门店', district: '合成位置', active: true })).digest('hex')
  assert.equal(JSON.parse(db.state.audits[0].reason).requestFingerprint, oldFingerprint)
  await updateManagedStore(db, { actor, key, pickupEnabled: false })
  for (const request of [{}, { pickupEnabled: true }]) {
    const replay = await create(request)
    assert.equal(replay.store.key, key)
    assert.equal(replay.reused, true)
    assert.equal(replay.store.pickupEnabled, false)
  }
  await assert.rejects(create({ pickupEnabled: false }), rejectsStatus(409))
  db.reset()
  await create({ pickupEnabled: false })
  await assert.rejects(create({ pickupEnabled: true }), rejectsStatus(409))
  for (const value of ['false', null, 0, {}]) {
    await assert.rejects(create({ pickupEnabled: value }), rejectsStatus(400))
    await assert.rejects(updateManagedStore(db, { actor, key: 'guanshe', pickupEnabled: value }), rejectsStatus(400))
  }
})

test('审计失败回滚新店、编辑与启停；同名唯一冲突不产生第二家门店', async () => {
  for (const operation of operations) {
    db.reset()
    const before = structuredClone(db.state)
    db.failures['sensitiveRecordAudit.create'] = true
    await assert.rejects(operation(actor), /synthetic sensitiveRecordAudit.create unavailable/)
    assert.deepEqual(db.state, before)
  }
  db.reset()
  await create()
  await assert.rejects(create({ requestKey: 'synthetic-second-001' }), error => error.code === 'P2002')
  assert.equal(db.state.stores.length, 5)
  assert.equal(db.state.audits.length, 1)
})

test('管理动作只允许当前持久 active developer；请求角色或过时登录角色均不能越权', async () => {
  for (const role of ['admin', 'finance', 'manager', 'staff', 'cashier', 'public']) {
    for (const operation of operations) {
      db.reset()
      await assert.rejects(operation({ ...actor, role }), rejectsStatus(403))
      assert.equal(db.state.audits.length, 0)
      assert.equal(db.calls.filter(value => value.endsWith('.create') || value.endsWith('.update')).length, 0)
    }
  }
  for (const persisted of [{ ...actor, role: 'admin' }, { ...actor, status: 'disabled' }, null]) {
    for (const operation of operations) {
      db.reset()
      db.state.users = persisted ? [persisted] : []
      await assert.rejects(operation(actor), rejectsStatus(403))
      assert.equal(db.state.audits.length, 0)
      assert.ok(db.rawQueries[0].sql.includes('"User"') && db.rawQueries[0].sql.includes('FOR SHARE'))
      assert.equal(db.rawQueries.some(query => query.sql.includes('"Store"')), false)
    }
  }
})

test('显式状态设置幂等；改名、关闭、重启同一身份，历史和绑定不变', async () => {
  db.reset()
  const result = await create()
  const key = result.store.key
  db.state.users.push({ id: 'synthetic-bound', username: 'bound-user', role: 'cashier', status: 'active', storeKeys: [key] })
  db.state.employees.push({ id: 'synthetic-bound-employee', currentStoreKey: key, name: '合成员工' })
  const kept = structuredClone({ facts: db.state.facts, users: db.state.users, employees: db.state.employees })
  const stamp = new Date('2026-10-18T16:30:00Z')
  const stopped = await setManagedStoreStatus(db, { actor, key, active: false, now: stamp })
  assert.equal(stopped.businessClosedOn, '2026-10-19')
  assert.equal((await setManagedStoreStatus(db, { actor, key, active: false, now: stamp })).changed, false)
  assert.equal(db.state.audits.length, 2)
  await assert.rejects(assertOperatingStore(db, key), error => error.code === 'STORE_CLOSED')
  assert.equal((await assertExistingStore(db, key)).key, key)
  await updateManagedStore(db, { actor, key, name: '合成改名', district: '新位置', now: stamp })
  const reopened = await setManagedStoreStatus(db, { actor, key, active: true, now: stamp })
  assert.equal(reopened.store.key, key)
  assert.equal(reopened.store.name, '合成改名')
  assert.ok(Date.parse(reopened.executedAt) > Date.parse(stopped.executedAt))
  assert.equal((await assertOperatingStore(db, key, { lock: true })).active, true)
  assert.deepEqual({ facts: db.state.facts, users: db.state.users, employees: db.state.employees }, kept)
})

test('未知及保留 key 拒绝；普通查验既不造店也不覆盖 PG 名称和启停', async () => {
  db.reset()
  for (const key of ['unregistered', 'all', 'multi', ' guanshe', 'GUANSHE', 'x'.repeat(31)]) {
    await assert.rejects(assertExistingStore(db, key), rejectsStatus(404))
    await assert.rejects(setManagedStoreStatus(db, { actor, key, active: true }), rejectsStatus(404))
  }
  const before = structuredClone(db.state.stores)
  await assertExistingStore(db, 'guanshe')
  assert.deepEqual(db.state.stores, before)
  assert.equal(db.state.audits.length, 0)
  assert.equal(resolveStoreName('guanshe', 'PG 修改后的官舍名称'), 'PG 修改后的官舍名称')
})

test('输入边界拒绝空白名、控制字符、超长资料、非布尔状态和无幂等标识', async () => {
  for (const extra of [{ name: '' }, { name: '  ' }, { name: 'a'.repeat(31) }, { name: '店\n名' }, { district: 'a'.repeat(51) }, { district: '址\u0085' }, { active: 'false' }, { requestKey: '' }]) {
    db.reset()
    await assert.rejects(create(extra), rejectsStatus(400))
    assert.equal(db.state.stores.length, 4)
    assert.equal(db.state.audits.length, 0)
  }
})

test('原朝外关闭接口兼容；旧闭店日仅历史元数据，后台可重新启用再关闭', async () => {
  db.reset()
  db.state.stores.find(row => row.key === 'chaowai').active = true
  const request = { actor, confirmation: '停用朝外', reason: '合成原接口验收', now: new Date('2026-10-18T01:00:00Z') }
  const closed = await disableChaowai(db, request)
  assert.equal(closed.businessClosedOn, '2026-10-13')
  assert.equal((await disableChaowai(db, request)).changed, false)
  await assert.rejects(disableChaowai(db, { ...request, confirmation: 'wrong' }), rejectsStatus(400))
  await setManagedStoreStatus(db, { actor, key: 'chaowai', active: true, now: new Date('2026-10-20T01:00:00Z') })
  assert.equal((await assertOperatingStore(db, 'chaowai')).active, true)
  const next = await setManagedStoreStatus(db, { actor, key: 'chaowai', active: false, now: new Date('2026-10-22T16:10:00Z') })
  assert.equal(next.businessClosedOn, '2026-10-23')
  const row = (await readStoreDirectory(db, { includeHistory: true })).find(store => store.key === 'chaowai')
  assert.equal(row.statusHistory[0].businessClosedOn, '2026-10-13')
  assert.equal(storeBusinessClosedOn(row), '2026-10-23')
  assert.equal(storeOperatedInPeriod(row, '2026-10-13'), true)
  assert.equal(storeOperatedInPeriod(row, '2026-10-14', '2026-10-19'), false)
  assert.equal(storeOperatedInPeriod(row, '2026-10-20'), true)
})

test('历史营业日期按上海日期、多次启停与新建未启用区间计算', () => {
  assert.equal(storeBusinessDate('2026-10-18T15:59:59Z'), '2026-10-18')
  assert.equal(storeBusinessDate('2026-10-18T16:00:00Z'), '2026-10-19')
  const store = { key: 'store-0123456789abcdef0123', active: true, createdAt: '2026-10-18T04:00:00Z', statusHistory: [
    { action: 'CREATE_STORE', active: false, executedAt: '2026-10-18T04:00:00Z' },
    { action: 'ENABLE_STORE', active: true, executedAt: '2026-10-20T04:00:00Z' },
    { action: 'DISABLE_STORE', active: false, executedAt: '2026-10-21T16:30:00Z', businessClosedOn: '2026-10-22' },
    { action: 'ENABLE_STORE', active: true, executedAt: '2026-10-25T04:00:00Z' },
  ] }
  for (const date of ['2026-10-17', '2026-10-18', '2026-10-19', '2026-10-23', '2026-10-24']) assert.equal(storeOperatedInPeriod(store, date), false, date)
  for (const date of ['2026-10-20', '2026-10-22', '2026-10-25']) assert.equal(storeOperatedInPeriod(store, date), true, date)
  assert.equal(storeOperatedInPeriod(store, '2026-02-30'), false)
  assert.equal(storeOperatedInPeriod({ ...store, active: false, statusHistory: store.statusHistory.slice(0, 1) }, '2026-10-18', '2026-10-31'), false)
})

test('旧 inactive 无 CREATE 审计或首次 ENABLE 不丢历史；朝外首次重开保留已知旧闭店边界', () => {
  const old = { key: 'legacy-store', active: false, createdAt: '2026-10-15T00:00:00Z', statusHistory: [] }
  assert.equal(storeOperatedInPeriod(old, '2026-01-01'), true)
  const reopened = { ...old, active: true, statusHistory: [{ action: 'ENABLE_STORE', active: true, executedAt: '2026-10-20T04:00:00Z' }] }
  assert.equal(storeOperatedInPeriod(reopened, '2026-01-01'), true)
  assert.equal(storeOperatedInPeriod(reopened, '2026-10-21'), true)
  const chaowai = { ...reopened, key: 'chaowai' }
  assert.equal(storeOperatedInPeriod(chaowai, '2026-10-13'), true)
  assert.equal(storeOperatedInPeriod(chaowai, '2026-10-14', '2026-10-19'), false)
  assert.equal(storeOperatedInPeriod(chaowai, '2026-10-20'), true)
})

async function directoryResponse() {
  const layer = publicStoreDirectoryRouter.stack.find(item => item.route?.path === '/store-directory')
  const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value }, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } }
  await layer.route.stack[0].handle({}, res)
  return res
}

test('公共目录仅基础字段、包含 inactive、无需业务开关、不读审计或用户且禁止缓存', async () => {
  db.reset()
  await create({ active: false })
  db.calls.length = 0
  const res = await directoryResponse()
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.deepEqual(Object.keys(res.body).sort(), ['ok', 'stores'])
  assert.equal(res.body.stores.length, 5)
  assert.equal(res.body.stores.filter(row => row.active === false).length, 2)
  for (const store of res.body.stores) assert.deepEqual(Object.keys(store).sort(), ['active', 'district', 'key', 'name'])
  assert.deepEqual(db.calls, ['store.findMany'])
})

test('四种状态：公共目录仅投影自提资格，内部启用/历史身份保留且兼容旧四字段', async () => {
  db.reset()
  const combinations = [[true, true], [true, false], [false, true], [false, false]]
  db.state.stores.forEach((row, index) => { [row.active, row.pickupEnabled] = combinations[index] })
  const internal = await readStoreDirectory(db)
  const response = await directoryResponse()
  assert.equal(response.statusCode, 200)
  for (const row of db.state.stores) {
    const privateRow = internal.find(store => store.key === row.key)
    assert.equal(privateRow.active, row.active)
    assert.equal(privateRow.pickupEnabled, row.pickupEnabled)
    const publicRow = response.body.stores.find(store => store.key === row.key)
    assert.deepEqual(Object.keys(publicRow).sort(), ['active', 'district', 'key', 'name'])
    assert.equal(publicRow.active, row.active && row.pickupEnabled)
    if (row.active) assert.equal((await assertOperatingStore(db, row.key)).key, row.key)
  }
})

test('公共目录不可用、非法资料、超 5000 家或 1 MiB 时 503，不以缓存伪造成功', async () => {
  for (const scenario of ['database', 'invalid', 'rows', 'bytes']) {
    db.reset()
    if (scenario === 'database') db.failures['store.findMany'] = true
    if (scenario === 'invalid') db.state.stores[0].name = 'bad\nname'
    if (scenario === 'rows' || scenario === 'bytes') db.state.stores = Array.from({ length: scenario === 'rows' ? 5001 : 5000 }, (_, index) => ({ key: `store-${index}`, name: `${'门'.repeat(25)}${index}`, district: '位'.repeat(50), active: true }))
    const res = await directoryResponse()
    assert.equal(res.statusCode, 503, scenario)
    assert.equal(res.body.ok, false)
    assert.equal(res.body.stores, undefined)
    assert.equal(res.headers['Cache-Control'], 'no-store')
    assert.equal(db.calls.some(call => call.endsWith('.create') || call.endsWith('.update')), false)
  }
})

test('实际应用 HTTP：公开目录、developer 管理、PG 绑定新收银账号、员工目录与旧权限链', async () => {
  db.reset(); resetCache()
  const app = createApp({ disableStartupTasks: true })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  permittedOrigin = origin
  async function request(route, { method = 'GET', body, user = actor } = {}) {
    const response = await fetch(`${origin}${route}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(user ? { Cookie: `budu_token=${signToken(user, process.env.JWT_SECRET)}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, headers: response.headers, body: await response.json() }
  }
  try {
    assert.equal((await request('/api/customer/store-directory', { user: null })).status, 200)
    assert.equal((await request('/api/v2/stores', { user: null })).status, 401)
    const added = await request('/api/v2/stores', { method: 'POST', body: { name: '合成 HTTP 门店', district: '合成 HTTP 位置', active: true, requestKey: 'synthetic-http-create-001', key: 'client-supplied', operationType: 'DIRECT' } })
    assert.equal(added.status, 200, JSON.stringify(added.body))
    const key = added.body.store.key
    assert.match(key, /^store-[a-f0-9]{20}$/)
    assert.equal(db.state.stores.find(store => store.key === key).operationType, 'UNKNOWN')
    const privateRows = await request('/api/v2/stores')
    assert.equal(privateRows.body.rows.length, 5)
    assert.equal(privateRows.body.rows.find(row => row.key === key).statusHistory[0].action, 'CREATE_STORE')
    assert.equal(privateRows.body.rows.find(row => row.key === key).pickupEnabled, true)
    const warehouse = await request(`/api/v2/stores/${key}`, { method: 'PATCH', body: { pickupEnabled: false } })
    assert.equal(warehouse.status, 200)
    assert.equal(warehouse.body.store.active, true)
    assert.equal(warehouse.body.store.pickupEnabled, false)
    assert.equal((await request('/api/customer/store-directory', { user: null })).body.stores.find(row => row.key === key).active, false)
    const cashier = await request('/api/admin/users', { method: 'POST', body: { username: 'synthetic-cashier', password: 'synthetic-only-password', role: 'cashier', storeKeys: [key] } })
    assert.equal(cashier.status, 200, JSON.stringify(cashier.body))
    const cashierUser = db.state.users.find(user => user.username === 'synthetic-cashier')
    assert.deepEqual(cashierUser.storeKeys, [key])
    const scoped = await request('/api/userdata', { user: cashierUser })
    assert.equal(scoped.status, 200)
    assert.equal(scoped.body.storesAuthority, 'postgresql')
    assert.equal(scoped.body.stores.some(store => store.key === key), true)
    assert.equal((await request('/api/v2/stores', { user: cashierUser })).status, 403)
    assert.equal((await request('/api/v2/stores', { method: 'POST', user: cashierUser, body: { name: '不能新增', requestKey: 'synthetic-denied-001' } })).status, 403)
    const unknownBinding = await request('/api/admin/users', { method: 'POST', body: { username: 'unknown-cashier', password: 'synthetic-only-password', role: 'cashier', storeKeys: ['unregistered'] } })
    assert.equal(unknownBinding.status, 400)
    const employees = await request('/api/v2/staff-list', { method: 'PUT', body: { staff: [{ name: '合成新增员工', storeKey: key, type: 'fulltime' }] } })
    assert.equal(employees.status, 200, JSON.stringify(employees.body))
    const employeeRows = await request('/api/v2/staff-list')
    assert.equal(employeeRows.body.rows[0].storeKey, key)
    const savedEmployees = structuredClone(db.state.employees)
    const invalidEmployees = await request('/api/v2/staff-list', { method: 'PUT', body: { staff: [{ name: '不能绑定未知门店', storeKey: `${key}invalid`, type: 'fulltime' }] } })
    assert.equal(invalidEmployees.status, 404)
    assert.deepEqual(db.state.employees, savedEmployees)
    assert.equal((await request(`/api/v2/stores/${key}`, { method: 'PATCH', body: { name: '合成改名 HTTP' } })).status, 200)
    assert.equal(db.state.stores.find(store => store.key === key).pickupEnabled, false)
    const closed = await request(`/api/v2/stores/${key}/status`, { method: 'PUT', body: { active: false } })
    assert.equal(closed.body.store.active, false)
    const publicRows = await request('/api/customer/store-directory', { user: null })
    assert.equal(publicRows.body.stores.find(store => store.key === key).active, false)
    assert.equal(publicRows.headers.get('cache-control'), 'no-store')
    assert.equal((await request(`/api/v2/stores/${key}/status`, { method: 'PUT', body: { active: false } })).body.changed, false)
    assert.equal((await request(`/api/v2/stores/${key}/status`, { method: 'PUT', body: { active: true } })).body.store.active, true)
    assert.deepEqual(cashierUser.storeKeys, [key])
    assert.equal(db.state.employees[0].currentStoreKey, key)
    assert.equal((await request(`/api/v2/stores/${key}`, { method: 'DELETE' })).status, 403)
  } finally {
    await new Promise(resolve => server.close(resolve))
    permittedOrigin = null
    rmSync(process.env.DATA_DIR, { recursive: true, force: true })
  }
})

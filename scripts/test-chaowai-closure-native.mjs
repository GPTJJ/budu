import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { PrismaClient } from '@prisma/client'

// Explicit opt-in to this owned synthetic database, never DATABASE_URL fallback.
const url = new URL(process.env.CHAOWAI_NATIVE_DATABASE_URL || 'file:invalid')
assert.equal(url.hostname, '127.0.0.1')
assert.equal(url.port, '55439')
assert.equal(url.pathname, '/budu_chaowai_closure_001')
url.searchParams.set('application_name', 'chaowai-closure-isolated-test')
const db = new PrismaClient({ datasourceUrl: url.href })
const [identity] = await db.$queryRawUnsafe("SELECT current_database() AS name, current_setting('data_directory') AS directory")
assert.equal(identity.name, 'budu_chaowai_closure_001')
assert.equal(identity.directory, '/Users/buxieshi/Documents/Codex/2026-10-13/BUDU-CODE-AUDIT-001-P1-FIX/work/pgdata')
process.env.APP_ENV = 'test'
process.env.DATABASE_URL = url.href
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex')
process.env.DATA_STORE = 'file'
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-chaowai-synthetic-data-'))
for (const key of ['WECHAT_WORK_WEBHOOK_URL','UPSTASH_REDIS_REST_URL','KV_REST_API_URL','WXWORK_CORP_ID','WXWORK_AGENT_ID','WXWORK_SECRET']) delete process.env[key]
globalThis.__buduPrisma = db
const { disableChaowai } = await import('../server/store-closure.js')
const { assertOperatingStore, readStoreDirectory } = await import('../server/store-operation-policy.js')
const { createApp } = await import('../server/app.js')
const { signToken } = await import('../server/auth.js')
const { aggregatePosDay } = await import('../server/daily-sales-authority.js')
const externalAttempts = []
const proofs = { database: identity.name, isolated: true }
const originalFetch = globalThis.fetch
globalThis.fetch = (input, options) => {
  if (new URL(String(input)).hostname !== '127.0.0.1') {
    externalAttempts.push('BLOCKED_NON_LOOPBACK')
    throw Error('EXTERNAL_REQUEST_FORBIDDEN')
  }
  return originalFetch(input, options)
}
const keys = ['tongying', 'guanshe', 'chaowai', 'xidan']
const actors = Object.fromEntries(['developer','admin','finance','manager','staff','cashier'].map(role => [role,
  { id: `closure-synthetic-${role}`, username: `closure-synthetic-${role}`, role, status: 'active', storeKeys: ['chaowai','guanshe'], employeeId: '', passwordHash: 'not-a-login-password' }]))
const day = new Date('2026-10-13T00:00:00Z')
for (const key of keys) await db.store.upsert({ where: { key }, update: { active: true }, create: { key, name: `合成${key}`, active: true } })
for (const actor of Object.values(actors)) await db.user.upsert({ where: { id: actor.id }, update: { role: actor.role, status: 'active' }, create: actor })
await db.employee.upsert({ where: { id: 'closure-synthetic-employee' }, update: {}, create: { id: 'closure-synthetic-employee', employeeNo: 'SYNTHETIC-CLOSURE-1', name: '合成员工', currentStoreKey: 'chaowai' } })
await db.employeeSalaryHistory.upsert({ where: { id: 'closure-salary' }, update: {}, create: { id: 'closure-salary', employeeId: 'closure-synthetic-employee', effectiveDate: day, oldValue: '20', newValue: '25', salaryType: 'hourly', reason: '合成历史' } })
await db.dailyEntry.upsert({ where: { id: 'closure-daily' }, update: {}, create: { id: 'closure-daily', storeKey: 'chaowai', date: day, incCents: 530000n, ord: 53, status: 'confirmed' } })
await db.dailyStoreStaff.upsert({ where: { id: 'closure-hours' }, update: {}, create: { id: 'closure-hours', storeId: 'chaowai', date: day, employeeId: 'closure-synthetic-employee', participantType: 'EMPLOYEE', staffId: 'closure-staff', staffNameSnapshot: '合成员工', actualHours: 8, payableHoursSource: 'ACTUAL_HOURS' } })
await db.payrollNotice.upsert({ where: { id: 'closure-payroll' }, update: {}, create: { id: 'closure-payroll', employeeId: 'closure-synthetic-employee', periodType: 'month', periodKey: '2026-10', periodStart: new Date('2026-10-01'), periodEnd: new Date('2026-10-31'), employeeName: '合成员工', storeKey: 'chaowai', snapshot: { hours: 8, pay: 20000, employeeId: 'closure-synthetic-employee' }, totalCents: 20000n, status: 'confirmed' } })
await db.schedule.upsert({ where: { id: 'closure-schedule' }, update: {}, create: { id: 'closure-schedule', weekStart: '2026-10-12', storeKey: 'chaowai', date: '2026-10-13', shifts: [{ employeeId: 'closure-synthetic-employee', staff: '合成员工', time: '09:00-17:00' }] } })
await db.expense.upsert({ where: { id: 'closure-expense' }, update: {}, create: { id: 'closure-expense', storeKey: 'chaowai', date: day, amountCents: 1234n } })
await db.inventoryItem.upsert({ where: { id: 'closure-product' }, update: {}, create: { id: 'closure-product', name: '合成闭店货品', isActive: true, salePriceCents: 1000n } })
await db.transferRequest.upsert({ where: { id: 'closure-transfer' }, update: {}, create: { id: 'closure-transfer', fromStoreKey: 'chaowai', toStoreKey: 'guanshe', status: 'received', items: { create: { id: 'closure-transfer-item', itemId: 'closure-product', quantity: 2, itemNameSnapshot: '合成闭店货品' } } } })
await db.$transaction(async tx => {
  for (const suffix of ['', '-refunded']) {
    const orderId = `closure-order${suffix}`, paymentId = `closure-payment${suffix}`
    await tx.order.upsert({ where: { id: orderId }, update: {}, create: { id: orderId, orderNo: `SYNTHETIC-CLOSURE-ORDER${suffix}`, storeId: 'chaowai', cashierId: actors.developer.id, checkoutKey: `closure-historical-checkout${suffix}`, cartHash: 'synthetic', status: 'pending_payment', paymentStatus: 'unpaid', payableAmount: 1000n, subtotal: 1000n, businessDate: day } })
    await tx.orderItem.upsert({ where: { id: `closure-item${suffix}` }, update: {}, create: { id: `closure-item${suffix}`, orderId, productId: 'closure-product', productNameSnapshot: '合成闭店货品', skuSnapshot: 'SYNTHETIC', unitPrice: 1000n, costPriceSnapshot: 500n, quantity: 1, lineAmount: 1000n, actualAmount: 1000n } })
    await tx.payment.upsert({ where: { id: paymentId }, update: {}, create: { id: paymentId, paymentNo: `SYNTHETIC-PAYMENT${suffix}`, orderId, channel: 'cash', amount: 1000n, status: 'success', merchantTradeNo: `SYNTHETIC-TRADE${suffix}`, provider: 'mock', requestKey: `closure-historical-payment${suffix}` } })
    await tx.order.update({ where: { id: orderId }, data: { status: 'paid', paymentStatus: 'paid' } })
  }
  await tx.refund.upsert({ where: { id: 'closure-refund' }, update: {}, create: { id: 'closure-refund', refundNo: 'SYNTHETIC-REFUND', orderId: 'closure-order-refunded', paymentId: 'closure-payment-refunded', refundAmount: 100n, status: 'pending', requestKey: 'closure-historical-refund', items: { create: { id: 'closure-refund-item', orderItemId: 'closure-item-refunded', quantity: 1, amountCents: 100n } } } })
})
let server
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  await db.$disconnect()
  globalThis.fetch = originalFetch
  if (process.env.CHAOWAI_NATIVE_RESULT_PATH) fs.writeFileSync(process.env.CHAOWAI_NATIVE_RESULT_PATH, JSON.stringify(proofs, null, 2) + '\n')
})
const command = { actor: actors.developer, confirmation: '停用朝外', reason: '合成开发验证' }
const setActive = active => db.store.update({ where: { key: 'chaowai' }, data: { active } })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function allFacts() {
  const tables = await db.$queryRawUnsafe("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
  const facts = {}
  for (const { tablename } of tables) {
    if (tablename === 'sensitive_record_audits') continue
    const quoted = '"' + tablename.replaceAll('"','""') + '"'
    const expr = tablename === 'Store' ? "to_jsonb(t) - 'active'" : 'to_jsonb(t)'
    const [value] = await db.$queryRawUnsafe(`SELECT count(*)::int AS count, md5(coalesce(string_agg((${expr})::text, E'\\n' ORDER BY (${expr})::text),'')) AS digest FROM ${quoted} t`)
    facts[tablename] = value
  }
  return facts
}

test('开发者停用精确单店，历史全表事实、工资快照、支付关联及聚合不变', async () => {
  await setActive(true)
  const before = await allFacts(), revenue = await aggregatePosDay('chaowai', '2026-10-13', db)
  assert.equal(revenue.orderCount, 1)
  assert.equal(revenue.effectiveAfterRefund, '1000')
  const result = await disableChaowai(db, command)
  assert.equal(result.changed, true)
  assert.equal(result.businessClosedOn, '2026-10-13')
  assert.notEqual(result.executedAt.slice(0,10), result.businessClosedOn)
  const audit = await db.sensitiveRecordAudit.findUnique({ where: { id: result.auditId } })
  assert.equal(audit.actorUserId, actors.developer.id)
  assert.deepEqual(JSON.parse(audit.reason).before, { active: true })
  assert.deepEqual(JSON.parse(audit.reason).after, { active: false })
  assert.deepEqual(await allFacts(), before)
  // syncedAt is the read/aggregation time, not a persisted business fact.
  const { syncedAt: beforeReadAt, ...beforeRevenue } = revenue
  const { syncedAt: afterReadAt, ...afterRevenue } = await aggregatePosDay('chaowai','2026-10-13', db)
  assert(beforeReadAt && afterReadAt)
  assert.deepEqual(afterRevenue, beforeRevenue)
  for (const table of ['employees','employee_salary_history','payroll_notices','DailyEntry','daily_store_staff','schedules','orders','payments','refunds','TransferRequest','TransferItem']) assert(before[table]?.count > 0, `non-empty ${table}`)
  proofs.history = { allTablesUnchangedExceptStoreActiveAndNewAudit: true, tables: before, revenue: beforeRevenue, auditId: audit.id, audit: JSON.parse(audit.reason) }
  const directory = await readStoreDirectory(db)
  assert.equal(directory.length, 4)
  assert.deepEqual(directory.filter(row => row.active).map(row=>row.key).sort(), ['guanshe','tongying','xidan'])
})

test('停用幂等不重复审计，不提供重开/删除/其他门店停用命令', async () => {
  const count = await db.sensitiveRecordAudit.count()
  assert.equal((await disableChaowai(db, command)).changed, false)
  assert.equal(await db.sensitiveRecordAudit.count(), count)
  for (const key of ['guanshe','tongying','xidan']) assert.equal((await assertOperatingStore(db,key)).active, true)
})

test('普通管理员/财务/店长/员工/收银及失效开发者无办理权', async () => {
  await setActive(true)
  for (const role of ['admin','finance','manager','staff','cashier']) await assert.rejects(disableChaowai(db,{...command,actor:actors[role]}), error=>error.status===403)
  await assert.rejects(disableChaowai(db,{...command,actor:{...actors.developer,status:'disabled'}}), error=>error.status===403)
  await db.user.update({where:{id:actors.developer.id},data:{role:'admin'}})
  await assert.rejects(disableChaowai(db,command), error=>error.status===403)
  await db.user.update({where:{id:actors.developer.id},data:{role:'developer'}})
  assert.equal((await db.store.findUnique({where:{key:'chaowai'}})).active,true)
})

test('确认与原因必填，审计故障真实事务回滚，不留下无痕停用', async () => {
  for (const override of [{ confirmation:'yes' },{ reason:'' }]) await assert.rejects(disableChaowai(db,{...command,...override}),error=>error.status===400)
  const failing = { $transaction: (fn, options) => db.$transaction(tx=>fn(new Proxy(tx,{get(target,name) { return name==='sensitiveRecordAudit' ? { create:()=>{throw Error('SYNTHETIC_AUDIT_FAILURE')} } : target[name] }})),options) }
  await assert.rejects(disableChaowai(failing,command),/SYNTHETIC_AUDIT_FAILURE/)
  assert.equal((await db.store.findUnique({where:{key:'chaowai'}})).active,true)
})

test('开发者降权先取得账号行锁：命令等待后重新判权并拒绝停用', async () => {
  let held, release
  const ready=new Promise(resolve=>{held=resolve}), unlock=new Promise(resolve=>{release=resolve})
  const revoke=db.$transaction(async tx=>{
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id=$1 FOR UPDATE',actors.developer.id)
    await tx.user.update({where:{id:actors.developer.id},data:{role:'admin'}})
    held();await unlock
  },{timeout:10000})
  await ready
  let finished=false
  const rejection=assert.rejects(disableChaowai(db,command),error=>error.status===403).then(()=>{finished=true})
  try {await sleep(100);assert.equal(finished,false)} finally {release()}
  await revoke;await rejection
  assert.equal((await db.store.findUnique({where:{key:'chaowai'}})).active,true)
  await db.user.update({where:{id:actors.developer.id},data:{role:'developer'}})
  proofs.accountRevocationSerialized=true
})

test('真实PG共享锁令停用等待已准入事务，提交后关闭；此后新经营拒绝', async () => {
  let release, held
  const lockReady = new Promise(resolve=>{held=resolve})
  const unlock = new Promise(resolve=>{release=resolve})
  const operating = db.$transaction(async tx=>{await assertOperatingStore(tx,'chaowai',{lock:true});held();await unlock},{timeout:10000})
  await lockReady
  let completed = false
  const closing = disableChaowai(db,command).then(result=>{completed=true;return result})
  try {
    let waiting = false
    for (let n=0;n<80;n++) {
      const [state] = await db.$queryRawUnsafe("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND application_name='chaowai-closure-isolated-test' AND wait_event_type='Lock'")
      if (state.count > 0) {waiting=true;break}
      await sleep(25)
    }
    assert.equal(waiting,true,'actual PostgreSQL lock wait observed')
    assert.equal(completed,false)
  } finally { release() }
  await operating
  await closing
  await assert.rejects(db.$transaction(tx=>assertOperatingStore(tx,'chaowai',{lock:true})),error=>error.status===409 && error.code==='STORE_CLOSED')
  proofs.operatingTransactionBeforeClosure=true
})

test('真实关闭事务在先，新业务共享锁等待后读取inactive而拒绝', async () => {
  await setActive(true)
  let held, release
  const ready = new Promise(resolve=>{held=resolve}), unlock = new Promise(resolve=>{release=resolve})
  const closing = db.$transaction(async tx=>{await tx.$queryRawUnsafe('SELECT key FROM "Store" WHERE key=$1 FOR UPDATE','chaowai');await tx.store.update({where:{key:'chaowai'},data:{active:false}});held();await unlock},{timeout:10000})
  await ready
  let finished=false
  const rejected = assert.rejects(db.$transaction(tx=>assertOperatingStore(tx,'chaowai',{lock:true})),error=>error.code==='STORE_CLOSED').then(()=>{finished=true})
  try { await sleep(100);assert.equal(finished,false) } finally { release() }
  await closing;await rejected
  proofs.closureBeforeOperatingTransaction=true
})

test('实际app挂载：原认证、完整PG目录、非开发者403与开发者停用可用', async () => {
  await setActive(true)
  const app=createApp({disableStartupTasks:true})
  server=app.listen(0,'127.0.0.1')
  await new Promise(resolve=>server.on('listening',resolve))
  const base=`http://127.0.0.1:${server.address().port}`
  const request=(route,role,body)=>fetch(base+route,{method:body?'POST':'GET',headers:{...(role?{cookie:`budu_token=${signToken(actors[role],process.env.JWT_SECRET)}`} : {}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
  assert.equal((await request('/api/v2/stores/chaowai/disable',null,command)).status,401)
  for(const role of ['admin','finance','manager'])assert.equal((await request('/api/v2/stores/chaowai/disable',role,command)).status,403)
  const response=await request('/api/v2/stores/chaowai/disable','developer',command)
  assert.equal(response.status,200)
  assert.equal((await response.json()).changed,true)
  for(const route of ['/api/userdata','/api/v2/stores']){
    const result=await request(route,'developer');assert.equal(result.status,200)
    const body=await result.json(),stores=body.stores || body.rows
    assert.equal(stores.length,4);assert.equal(stores.find(row=>row.key==='chaowai').active,false)
    if(route==='/api/userdata')assert.equal(body.storesAuthority,'postgresql')
  }
  assert.equal((await request('/api/v2/stores','cashier')).status,403)
  const cashierResponse=await request('/api/userdata','cashier')
  assert.equal(cashierResponse.status,200)
  const cashierBody=await cashierResponse.json()
  assert.equal(cashierBody.storesAuthority,'postgresql')
  assert.deepEqual(cashierBody.stores.map(store=>store.key).sort(),['chaowai','guanshe'])
  assert.equal(cashierBody.stores.find(store=>store.key==='chaowai').active,false)
  assert.equal(app.locals.buduRuntime.appTasksStarted,0)
  assert.equal(app.locals.buduRuntime.processTasksStarted,0)
  assert.deepEqual(externalAttempts,[])
  proofs.actualAuthenticatedApp=true
  proofs.startupTasks=0
  proofs.externalAttempts=0
})

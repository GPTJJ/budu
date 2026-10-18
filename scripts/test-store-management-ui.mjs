import assert from 'node:assert/strict'
import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
const originalFetch = globalThis.fetch
const results = []
try {
  const data = await vite.ssrLoadModule('/src/utils/userData.js')
  const selectors = await vite.ssrLoadModule('/src/utils/selectors.js')
  const directory = await vite.ssrLoadModule('/src/utils/storeDirectory.js')
  const operations = await vite.ssrLoadModule('/src/utils/storeOperations.js')
  const store = { key:'store-12345678901234567890', name:'合成新门店', district:'合成位置', active:true,
    createdAt:'2026-10-18T04:00:00.000Z', statusHistory:[{ action:'CREATE_STORE', active:true, executedAt:'2026-10-18T04:00:00.000Z' }] }
  const fixture = { stores:[store], staff:[{ id:'employee-new-store', name:'合成员工', storeKey:store.key }],
    entries:{ [`2026-10|${store.key}|10-18`]:{inc:4000,ord:20,staff:['合成员工']} } }
  const pass = name => { results.push(name); console.log(`PASS ${name}`) }
  data.seedCachedDataForTest(fixture)
  assert(selectors.allStoreKeys().includes(store.key))
  assert.equal(selectors.currentEmployeeDirectory()[0].id,'employee-new-store')
  assert.equal(selectors.entryMonthPayroll('2026-10').get('合成员工').storeKey,store.key)
  const before = {aggregate:selectors.aggregate('2026-10','all'),payroll:selectors.entryMonthPayroll('2026-10')}
  data.seedCachedDataForTest({...fixture,stores:[{...store,active:false}]})
  assert.deepEqual(selectors.aggregate('2026-10','all'),before.aggregate)
  assert.deepEqual(selectors.entryMonthPayroll('2026-10'),before.payroll)
  assert.equal(selectors.operatingStores().length,0)
  assert(selectors.allStoreKeys().includes(store.key))
  pass('新门店身份、人员及历史汇总保留；启停不改历史金额')
  data.seedCachedDataForTest({...fixture,storesAuthority:'unavailable'})
  assert.equal(selectors.operatingStores().length,0)
  assert.equal(directory.isStoreDirectoryRows([{...store,active:'true'}]),false)
  assert.equal(directory.isStoreDirectoryRows([store,store]),false)
  for(const key of ['all','multi',' temporary','temporary:test']) assert.equal(directory.isStoreDirectoryRows([{...store,key}]),false)
  assert.equal(directory.isStoreDirectoryRows([{key:'ghost',active:true}]),false)
  pass('只有完整合法PG目录建立营业权威，缓存/畸形/临时地点不放行')

  const json = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}})
  let failure = false
  globalThis.fetch = async (url) => url==='/api/v2/stores'
    ? failure ? json({error:'synthetic unavailable'},503) : json({ok:true,rows:[store]})
    : json({rows:[]})
  await data.refreshStoreDirectory()
  assert.equal(selectors.isOperatingStore(store.key),true)
  failure=true
  await assert.rejects(data.refreshStoreDirectory())
  assert.equal(selectors.isOperatingStore(store.key),false)
  assert.equal(selectors.storeName(store.key),store.name)
  pass('目录读取失败暂停新业务选择、完整历史名称继续可读')

  let resolveOld
  data.prepareUserDataForUser('generation-a')
  globalThis.fetch = async url => url==='/api/v2/stores' ? new Promise(resolve=>{resolveOld=resolve}) : json({rows:[]})
  const old = data.refreshStoreDirectory()
  globalThis.fetch = async url => json({ok:true,rows:[{...store,active:false}]})
  await data.refreshStoreDirectory()
  resolveOld(json({ok:true,rows:[store]}))
  await old
  assert.equal(data.getStores()[0].active,false)
  pass('迟到旧目录不能覆盖较新停用状态')

  let resolveLegacy
  globalThis.fetch = async url => url==='/api/userdata' ? new Promise(resolve=>{resolveLegacy=resolve})
    : url==='/api/v2/stores' ? json({ok:true,rows:[store]}) : json({rows:[]})
  const full = data.loadUserData({userId:'generation-a'})
  globalThis.fetch = async url => json({ok:true,rows:[{...store,active:false}]})
  await data.refreshStoreDirectory()
  resolveLegacy(json({stores:[{key:'ghost',name:'旧KV门店',active:true}]}))
  await full
  assert.equal(data.getStores()[0].active,false)
  assert.equal(selectors.allStoreKeys().includes('ghost'),false)
  pass('全量后台加载不覆盖较新的专用门店刷新、旧KV不能生成门店')

  let resolvePreviousUser
  globalThis.fetch = async () => new Promise(resolve=>{resolvePreviousUser=resolve})
  const previous = data.refreshStoreDirectory()
  data.prepareUserDataForUser('generation-b')
  resolvePreviousUser(json({ok:true,rows:[store]}))
  await previous
  assert.equal(data.getStores().length,0)
  assert.equal(selectors.operatingStores().length,0)
  pass('切换账号后上一账号迟到请求不能污染新账号门店目录')

  assert.equal(operations.storeVisibleInOperatingPeriod(store,'2026-10-01','2026-10-17'),false)
  assert.equal(operations.storeVisibleInOperatingPeriod(store,'2026-10-01','2026-10-31'),true)
  const changed = {...store,active:true,statusHistory:[...store.statusHistory,
    {action:'DISABLE_STORE',active:false,executedAt:'2026-10-19T16:15:00Z'},
    {action:'ENABLE_STORE',active:true,executedAt:'2026-10-25T00:00:00Z'}]}
  assert.equal(operations.storeVisibleInOperatingPeriod(changed,'2026-10-20'),true)
  assert.equal(operations.storeVisibleInOperatingPeriod(changed,'2026-10-21','2026-10-24'),false)
  assert.equal(operations.storeVisibleInOperatingPeriod(changed,'2026-10-25'),true)
  pass('共享北京营业日期支持新增、停用空档、恢复及跨期展示')
  console.log(`store-management UI authority checks: ${results.length}/${results.length} PASS`)
} finally { globalThis.fetch = originalFetch; await vite.close() }

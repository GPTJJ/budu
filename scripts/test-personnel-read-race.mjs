import test, {afterEach} from 'node:test'
import assert from 'node:assert/strict'
const m = await import(process.env.PERSONNEL_BASELINE ? '../src/utils/.audit-original.js' : '../src/utils/userData.js')
const original = globalThis.fetch
const json = (x, status=200) => new Response(JSON.stringify(x), {status})
const rows=[{id:'employee-1',type:'fulltime',storeKey:'guanshe'}]
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
function seed(){m.prepareUserDataForUser('test');m.seedCachedDataForTest({staff:rows,entries:{known:{inc:1}},stores:[{key:'guanshe'}],dailyStoreStaffByMonth:{'2026-08':[{id:'aug'}]}})}
function mock(gate, staff=rows, error=false){globalThis.fetch=async url=>{
 if(String(url).endsWith('/userdata'))return json({staff:[],entries:{},stores:[],dailyStoreStaffByMonth:{}})
 if(String(url).includes('daily-store-staff'))return json({month:'2026-09',rows:[],businessDate:'2026-09-13'})
 await gate.promise
 return json({rows:String(url).endsWith('/staff-list')?staff:[]},error?503:200)
}}
afterEach(()=>{m.resetUserData();globalThis.fetch=original})
test('RACE-01/08 global legacy completes before PG: employees and attendance never clear',async()=>{
 seed();const g=deferred();mock(g);const run=m.loadUserData();await new Promise(r=>setTimeout(r,20));
 const during=m.getStaff().length;const month=m.getDailyStoreStaff('2026-08').length;g.resolve();await run;
 assert.equal(during,1);assert.equal(month,1)
})
test('RACE-02/03 late same-session load cannot overwrite newer accepted success',async()=>{
 seed();const old=deferred();mock(old,[]);const a=m.loadUserData();await new Promise(r=>setTimeout(r,5));
 const fresh=deferred();mock(fresh,rows);const b=m.loadUserData();fresh.resolve();await b;old.resolve();await a;assert.equal(m.getStaff().length,1)
})
test('RACE-04 failed refresh preserves last success, next success recovers',async()=>{
 seed();const g=deferred();mock(g,[],true);const p=m.loadUserData();g.resolve();await p;assert.equal(m.getStaff().length,1)
 assert.equal(m.getPersonnelReadState().status,'ERROR_WITH_STALE_DATA');const g2=deferred();mock(g2);const p2=m.loadUserData();g2.resolve();await p2;assert.equal(m.getPersonnelReadState().status,'DATA')
})
test('RACE-05 latest authoritative zero becomes REAL_EMPTY only at completion',async()=>{
 seed();const g=deferred();mock(g,[]);const p=m.loadUserData();assert.equal(m.getStaff().length,1);g.resolve();await p;assert.equal(m.getStaff().length,0);assert.equal(m.getPersonnelReadState().status,'REAL_EMPTY')
})
test('month failure retains payload but cannot claim a fresh successful read',async()=>{
 seed();globalThis.fetch=async()=>json({error:'synthetic'},503);await m.loadDailyStoreStaffMonth('2026-08',{force:true});assert.equal(m.getDailyStoreStaff('2026-08').length,1);assert.equal(m.getDailyStoreStaffMonthState('2026-08').status,'error')
})
test('legacy payroll facts cannot seed first load or replace failed PG reads',async()=>{
 m.prepareUserDataForUser('fresh');globalThis.fetch=async url=>String(url).endsWith('/userdata')?json({staff:rows,entries:{ghost:{inc:999}},dailyStoreStaffByMonth:{'2026-08':[{id:'ghost'}]}}):json({error:'unavailable'},503)
 await m.loadUserData();assert.deepEqual(m.getStaff(),[]);assert.deepEqual(m.getUserData().entries,{});assert.equal(m.getPersonnelReadState().status,'ERROR');assert.deepEqual(m.getDailyStoreStaff('2026-08'),[])
})
test('RACE-06 independent month caches cannot overwrite each other when A finishes after B',async()=>{
 seed();const a=deferred();globalThis.fetch=async url=>{const month=new URL(String(url),'https://test.invalid').searchParams.get('month');if(month==='2026-08')await a.promise;return json({month,rows:[{id:month}]})}
 const first=m.loadDailyStoreStaffMonth('2026-08',{force:true});await m.loadDailyStoreStaffMonth('2026-09',{force:true});a.resolve();await first
 assert.equal(m.getDailyStoreStaff('2026-09')[0].id,'2026-09');assert.equal(m.getDailyStoreStaff('2026-08')[0].id,'2026-08')
})
test('aborted/malformed monthly response preserves data and is never REAL_EMPTY',async()=>{
 seed();for(const reply of [()=>{throw new DOMException('Aborted','AbortError')},()=>json({}),()=>json({month:'2026-09',rows:[]})]){globalThis.fetch=async()=>reply();await m.loadDailyStoreStaffMonth('2026-08',{force:true});assert.equal(m.getDailyStoreStaff('2026-08').length,1);assert.equal(m.getDailyStoreStaffMonthState('2026-08').status,'error')}
})
test('loading metadata never notifies business-data subscribers before an atomic commit',async()=>{
 seed();let commits=0;const off=m.onUserDataUpdated(()=>commits++);const g=deferred();mock(g);const run=m.loadUserData();await new Promise(r=>setTimeout(r,5));assert.equal(commits,0);g.resolve();await run;assert.ok(commits>=1);off()
})

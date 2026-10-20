import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { startFixture } from './test-purchase-receipt-native.mjs';
import { procurementHistoryExcelBytes, historyHeaders } from '../src/utils/procurementHistoryExport.js';

const rk = () => randomUUID();
const root = '/procurement/returns';
export async function returnFixture() {
  const f = await startFixture();
  const { prisma, ok, users } = f;
  await prisma.store.create({ data: { key: 'chaowai', name: '合成朝外闭店', active: false } });
  await prisma.user.update({ where: { id: users.multi.id }, data: { storeKeys: ['synth-1','synth-2','chaowai'] } });
  await prisma.user.update({ where: { id: users.outsider.id }, data: { storeKeys: ['synth-2'] } });
  const supplier = (await ok('dev','/procurement/suppliers',{ requestKey:rk(), name:'合成供应商', productIds:['synth-item-a','synth-item-b','synth-item-c'] })).supplier;
  const content = (storeKey = 'synth-1', replacements = []) => ({ supplierId:supplier.id, storeKey, originalOrderId:'', returnedDate:'2026-09-14', reason:'合成质量退货', notes:'合成演示，不可导入生产', items:[{ rowId:rk(), itemId:'synth-item-a', quantity:'100', unit:'个' }], replacements });
  const replacement = (quantity = '80', storeKey = 'synth-1') => ({ rowId:rk(), itemId:'synth-item-a', quantity, unit:'个', storeKey, receivedDate:'2026-09-18', notes:'实际补回，可少于退回' });
  const create = async (who,c) => (await ok(who,root,{ requestKey:rk(),content:c })).record;
  const act = async (who,r,action,extra={}) => (await ok(who,`${root}/${r.id}/${action}`,{ requestKey:rk(),version:r.version,...extra })).record;
  const history = async (who='dev',filters={}) => ok(who,'/procurement/history?' + new URLSearchParams({ start:'2026-09-01',end:'2026-09-30',...filters }));
  return { ...f, supplier, content, replacement, create, act, history };
}

export async function run() {
  const f = await returnFixture(), { prisma,ok,request,users,content,replacement,create,act,history } = f;
  const results = [];
  const test = async (name,fn) => { try { await fn(); results.push({ name,status:'PASS' }); console.log(name + ' PASS'); } catch(e) { results.push({ name,status:'FAIL',error:e.stack }); console.error(name + ' FAIL ' + e.message); } };
  let closed, cross, simple, linked;
  let originalBefore;
  const inventorySnapshot = async () => JSON.stringify((await prisma.inventoryItem.findMany({ orderBy:{id:'asc'} })).map(({updatedAt,...row})=>row), (_,v) => typeof v === 'bigint' ? v.toString() : v);
  const inventoryBefore = await inventorySnapshot();
  const notificationBefore = await prisma.notification.count();
  try {
    await test('R01 员工只读选项及门店权限、闭店来源保持停用',async () => {
      assert((await ok('staff','/procurement/return-options')).suppliers.length > 0);
      assert.equal((await request('staff','/procurement/suppliers',{name:'拒绝',productIds:[],requestKey:rk()})).status,403);
      assert.equal((await request('staff',root,{requestKey:rk(),content:content('chaowai')})).status,403);
      closed = await create('multi',content('chaowai'));
      closed = await act('multi',closed,'submit');
      closed = await act('dev',closed,'confirm');
      assert.equal((await prisma.store.findUnique({where:{key:'chaowai'}})).active,false);
      assert.equal((await request('staff',root + '/' + closed.id)).status,404);
      assert.equal((await request('disabled','/procurement/return-options')).status,403);
    });
    await test('R02 不完整草稿可保存、无原单退100不补货可确认、员工不能确认',async () => {
      simple = await create('staff',{storeKey:'synth-1',replacements:[{rowId:rk(),itemId:'',quantity:'',unit:'',storeKey:'',receivedDate:'',notes:''}]});
      assert.equal(simple.status,'PROCESSING');
      assert.equal(simple.content.replacements.length,1);
      assert.equal((await ok('staff',root+'/'+simple.id)).record.content.replacements.length,1);
      assert.equal((await request('staff',`${root}/${simple.id}/submit`,{version:simple.version,requestKey:rk()})).status,400);
      simple = await act('staff',simple,'save',{content:content()});
      simple = await act('staff',simple,'submit');
      simple = await act('staff',simple,'withdraw');
      assert.equal(simple.status,'PROCESSING');
      simple = await act('staff',simple,'submit');
      simple = await act('dev',simple,'return',{reason:'合成退回修改'});
      assert.equal(simple.status,'PROCESSING');
      simple = await act('staff',simple,'submit');
      for (const who of ['staff','buyer','admin','manager','finance']) assert.equal((await request(who,`${root}/${simple.id}/confirm`,{version:simple.version,requestKey:rk()})).status,403);
      simple = await act('dev',simple,'confirm');
      assert.equal(simple.confirmedContent.replacements.length,0);
      assert.equal(simple.confirmedContent.originalOrderId,'');
    });
    await test('R03 退100补80与跨店逐行权限、隐藏行不能被整单覆盖',async () => {
      cross = await create('multi',content('synth-1',[replacement('80','synth-2')]));
      const staff = await ok('staff',root + '/' + cross.id), other = await ok('outsider',root + '/' + cross.id);
      assert.equal(staff.record.content.replacements.length,0);
      assert.equal(staff.record.canEdit,false);
      assert.equal(other.record.content.items.length,0);
      assert.equal(other.record.content.storeNameSnapshot,'');
      assert.equal(other.record.content.reason,'');
      assert.equal(other.record.content.replacements[0].quantity,'80');
      assert(!JSON.stringify(staff).includes('synth-2'));
      for (const action of ['save','submit']) assert.equal((await request('staff',`${root}/${cross.id}/${action}`,{requestKey:rk(),version:cross.version,content:content()})).status,403);
      cross = await act('multi',cross,'submit');
      assert.equal((await request('multi',`${root}/${cross.id}/save`,{requestKey:rk(),version:cross.version,content:content()})).status,409);
      cross = await act('dev',cross,'confirm');
      assert.equal(cross.confirmedContent.items[0].quantity,'100');
      assert.equal(cross.confirmedContent.replacements[0].quantity,'80');
      const a = await history('staff'), b = await history('outsider');
      assert(!a.events.some(e => e.storeKey === 'synth-2'));
      assert(b.events.every(e => e.storeKey === 'synth-2'));
      assert.equal((await request('staff','/procurement/history?storeKey=synth-2')).status,403);
    });
    await test('R04 重开保留旧确认事实、状态筛选、纠错审计与再次确认替换',async () => {
      assert.equal((await request('dev',`${root}/${cross.id}/reopen`,{requestKey:rk(),version:cross.version,reason:''})).status,400);
      cross = await act('dev',cross,'reopen',{reason:'合成补充后续事实'});
      const revised = structuredClone(cross.content); revised.items[0].quantity='95'; revised.replacements.push(replacement('5','synth-2'));
      cross = await act('multi',cross,'save',{content:revised});
      const h = await history('dev',{returnStatus:'PROCESSING'}), line=h.events.find(e => e.number===cross.number && e.type==='RETURN');
      assert.equal(line.quantity,'100'); assert.match(line.notes,/上次已确认值/); assert.equal(line.status,'处理中');
      assert(!(await history('dev',{returnStatus:'COMPLETED'})).events.some(e => e.number===cross.number));
      cross = await act('multi',cross,'submit');
      assert.equal((await request('dev',`${root}/${cross.id}/confirm`,{requestKey:rk(),version:cross.version-1})).status,409);
      assert.equal((await history()).events.find(e => e.number===cross.number && e.type==='RETURN').quantity,'100');
      cross = await act('dev',cross,'confirm');
      const latest=(await history()).events.filter(e=>e.number===cross.number);
      assert.equal(latest.filter(e=>e.type==='RETURN').length,1);
      assert.equal(latest.find(e=>e.type==='RETURN').quantity,'95');
      assert.equal(latest.filter(e=>e.type==='REPLACEMENT').length,2);
      const audits=await prisma.procurementAudit.findMany({where:{entityId:cross.id,action:'RETURN_CONFIRM'},orderBy:{createdAt:'asc'}});
      assert.equal(audits.length,2); assert.equal(audits[0].after.confirmedContent.items[0].quantity,'100');
    });
    await test('R05 数据库行锁并发屏障、幂等重试与过期版本拒绝',async () => {
      let r=await create('staff',content()); r=await act('staff',r,'submit');
      const body={requestKey:rk(),version:r.version};
      let pending;
      await prisma.$transaction(async tx=>{
        await tx.$queryRawUnsafe('SELECT id FROM "ProcurementReturn" WHERE id=$1 FOR UPDATE',r.id);
        pending=[request('dev',`${root}/${r.id}/confirm`,body),request('dev',`${root}/${r.id}/confirm`,body)];
        let blocked=0;
        for(let n=0;n<150;n++) {
          await tx.$queryRawUnsafe('SELECT true AS cleared FROM pg_stat_clear_snapshot()');
          blocked=(await tx.$queryRawUnsafe("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%ProcurementReturn%'"))[0].n;
          if(blocked>=2) break;
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert(blocked>=2,'两连接必须实际等待同一数据库行锁');
      },{timeout:10000});
      const replay=await Promise.all(pending); assert(replay.every(x=>x.status===200));
      assert.equal(await prisma.procurementAudit.count({where:{entityId:r.id,action:'RETURN_CONFIRM'}}),1);
      assert.equal((await request('dev',`${root}/${r.id}/confirm`,{...body,requestKey:rk()})).status,409);
      assert.equal((await request('dev',`${root}/${r.id}/confirm`,{...body,reason:'不同内容'})).status,409);
      const createBody={requestKey:rk(),content:content()};
      const creates=await Promise.all([request('staff',root,createBody),request('staff',root,createBody)]);
      assert(creates.every(x=>x.status===200)); assert.equal(creates[0].record.id,creates[1].record.id);
    });
    await test('R06 跨月订单、两次实收、关联原单不改累计与快照',async () => {
      let order=(await ok('dev','/procurement/orders',{requestKey:rk(),content:{storeKey:'synth-1',supplierId:f.supplier.id,items:[{itemId:'synth-item-a',quantity:'100',unit:'盒'},{itemId:'synth-item-b',quantity:'20',unit:'克'}]}})).order;
      order=(await ok('dev',`/procurement/orders/${order.id}/mark-ordered`,{requestKey:rk(),version:order.version})).order;
      await prisma.procurementOrder.update({where:{id:order.id},data:{orderedAt:new Date('2026-08-28T02:00:00Z')}});
      for(const [receivedDate,q] of [['2026-09-03','60'],['2026-09-20','40']]) {
        const r=(await ok('staff',`/procurement/orders/${order.id}/receipts`,{requestKey:rk(),receivedDate,items:[{orderLineId:order.lines[0].id,quantity:q}]})).receipt;
        await ok('dev',`/procurement/receipts/${r.id}/approve`,{requestKey:rk(),version:r.version});
      }
      originalBefore=await ok('dev','/procurement/orders/'+order.id);
      const c=content(); c.originalOrderId=order.id;
      linked=await create('staff',c); linked=await act('staff',linked,'submit'); linked=await act('dev',linked,'confirm');
      assert.deepEqual(await ok('dev','/procurement/orders/'+order.id),originalBefore);
      const half=await history('staff',{end:'2026-09-15'}), month=await history('staff');
      assert.equal(half.purchases.filter(p=>p.number===order.id).length,0);
      assert.equal(half.events.filter(e=>e.relatedNumber===order.id&&e.type==='RECEIPT').reduce((n,e)=>n+Number(e.quantity),0),60);
      assert.equal(month.events.filter(e=>e.relatedNumber===order.id&&e.type==='RECEIPT').reduce((n,e)=>n+Number(e.quantity),0),100);
      await prisma.user.update({where:{id:users.dev.id},data:{username:'合成改名账号'}});
      assert((await history('staff')).events.filter(e=>e.relatedNumber===order.id&&e.type==='RECEIPT').every(e=>e.confirmedBy==='budu'));
      await prisma.user.update({where:{id:users.dev.id},data:{username:'budu'}});
      assert.equal((await history('staff',{start:'2026-08-01',end:'2026-08-31'})).purchases.filter(p=>p.number===order.id).length,2);
      assert.equal((await history('staff',{start:'2026-08-01',end:'2026-08-31',itemId:'synth-item-b'})).summary[0].ordered,'20');
      assert.equal((await request('outsider',root,{requestKey:rk(),content:{...content('synth-2'),originalOrderId:order.id}})).status,403);
    });
    await test('R07 业务日含起止边界、北京时间下单与商品单位不混加',async () => {
      for(const [id,orderedAt,qty,unit] of [['before','2026-08-31T15:59:59.999Z','7','盒'],['start','2026-08-31T16:00:00Z','11','盒'],['end','2026-09-30T15:59:59.999Z','13','克'],['after','2026-09-30T16:00:00Z','17','盒']]) {
        await prisma.procurementOrder.create({data:{id:'boundary-'+id,storeKey:'synth-1',supplierId:f.supplier.id,supplierNameSnapshot:'合成供应商',storeNameSnapshot:'合成门店1',status:'ORDERED',createdById:users.dev.id,createdByName:'合成备单人',orderedAt:new Date(orderedAt),createRequestKey:rk(),createPayloadHash:'synthetic',lines:{create:{id:'boundary-line-'+id,inventoryItemId:'synth-item-b',productNameSnapshot:'合成糖商品B',unitSnapshot:unit,orderedQty:qty,linePosition:0}}}});
      }
      const h=await history('staff',{itemId:'synth-item-b'});
      assert.deepEqual(h.purchases.map(r=>r.number).sort(),['boundary-end','boundary-start']);
      assert.deepEqual(h.summary.map(r=>[r.unit,r.ordered]).sort(),[['克','13'],['盒','11']].sort());
      assert.equal((await request('staff','/procurement/history?start=2026-02-30')).status,400);
      assert.equal((await request('staff','/procurement/history?start=2026-10-02&end=2026-09-01')).status,400);
    });
    await test('R08 待确认明细不汇总、重命名不改历史、停用接收限制',async () => {
      const c=content(); c.items[0].quantity='37';
      let r=await create('staff',c); r=await act('staff',r,'submit');
      const h=await history('staff',{returnStatus:'PENDING',type:'RETURN'});
      assert(h.events.some(e=>e.number===r.number)); assert.equal(h.summary.length,0);
      assert.equal((await request('multi',root,{requestKey:rk(),content:content('synth-1',[replacement('2','chaowai')])})).status,409);
      await prisma.inventoryItem.update({where:{id:'synth-item-a'},data:{name:'合成改名商品'}});
      assert.equal((await ok('staff',root+'/'+simple.id)).record.content.items[0].productNameSnapshot,'合成糖商品A');
      await prisma.inventoryItem.update({where:{id:'synth-item-a'},data:{name:'合成糖商品A'}});
    });
    await test('R09 超过500条完整获取与筛选导出同源',async () => {
      const rows=Array.from({length:505},(_,i)=>({id:'bulk-'+i,number:'合成批量-'+String(i).padStart(3,'0'),content:{...content(),items:[{rowId:'r',itemId:'synth-item-c',productNameSnapshot:'合成物料C',quantity:'1.001',unit:'盒'}]},storeKeys:['synth-1'],createdById:users.staff.id,createdByName:'合成员工',createRequestKey:rk(),createPayloadHash:'synthetic',updatedAt:new Date()}));
      await prisma.procurementReturn.createMany({data:rows.map(r=>({...r,status:'COMPLETED',confirmedContent:r.content}))});
      await prisma.procurementOrder.createMany({data:rows.map((r,i)=>({id:'bulk-order-'+i,storeKey:'synth-1',supplierId:f.supplier.id,supplierNameSnapshot:'合成供应商',storeNameSnapshot:'合成门店1',status:'ORDERED',orderedAt:new Date('2026-09-10T02:00:00Z'),createdById:users.dev.id,createdByName:'合成备单人',createRequestKey:rk(),createPayloadHash:'synthetic'}))});
      await prisma.procurementOrderLine.createMany({data:rows.map((r,i)=>({id:'bulk-order-line-'+i,orderId:'bulk-order-'+i,inventoryItemId:'synth-item-c',productNameSnapshot:'合成物料C',unitSnapshot:'盒',orderedQty:'1.001',linePosition:0}))});
      const h=await history('staff',{itemId:'synth-item-c'});
      assert.equal(h.events.length,505); assert.equal(h.summary[0].returned,'505.505');
      assert.equal(h.purchases.length,505); assert.equal(h.summary[0].ordered,'505.505');
      const bytes=await procurementHistoryExcelBytes(h), wb=XLSX.read(bytes,{type:'array'});
      assert.equal(XLSX.utils.sheet_to_json(wb.Sheets['收退货明细'],{range:4}).length,505);
      assert.equal(XLSX.utils.sheet_to_json(wb.Sheets['采购明细'],{range:4}).length,505);
      assert.equal((await history('outsider',{itemId:'synth-item-c'})).events.length,0);
    });
    await test('R10 实际XLSX三表、日期数值、公式文本、冻结与空结果',async () => {
      const h=await history('staff',{keyword:'无匹配的合成查询'});
      const wb=XLSX.read(await procurementHistoryExcelBytes(h),{type:'array'});
      assert.deepEqual(wb.SheetNames,['期间汇总','采购明细','收退货明细']);
      for(let i=0;i<3;i++) assert.deepEqual(historyHeaders[i],XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[i]],{header:1,range:4})[0]);
      const original=await history('staff',{itemId:'synth-item-b'}); original.purchases[0].notes='=1+1';
      const bytes=await procurementHistoryExcelBytes(original), parsed=XLSX.read(bytes,{type:'array'});
      assert.equal(parsed.Sheets['采购明细'].J6.t,'s'); assert.equal(parsed.Sheets['采购明细'].J6.f,undefined);
      assert.equal(parsed.Sheets['采购明细'].A6.t,'n'); assert.equal(parsed.Sheets['采购明细'].G6.t,'n');
      const zip=await JSZip.loadAsync(bytes);
      for(let i=1;i<=3;i++) { const xml=await zip.file(`xl/worksheets/sheet${i}.xml`).async('string'); assert.match(xml,/state="frozen"/); assert.match(xml,/<autoFilter ref="A5:/); }
    });
    await test('R11 原库存价格和通知无副作用',async () => {
      assert.equal(await inventorySnapshot(),inventoryBefore);
      // Only the two ordinary procurement receipts above are allowed to notify.
      assert.equal(await prisma.notification.count()-notificationBefore,2);
      assert.equal(f.externalAttempts.length,0);
    });
    await test('R12 程序导出半月整月合成样例（退100补80）',async () => {
      // A dedicated supplier makes the sample small and independent of other tests.
      const sampleSupplier=await prisma.procurementSupplier.create({data:{id:'sample-supplier',name:'演示供应商（虚构）',createdById:users.dev.id}});
      const c=content('synth-1',[replacement()]); c.supplierId=sampleSupplier.id; c.reason='合成质量退货';
      let r=await create('staff',c); r=await act('staff',r,'submit'); await act('dev',r,'confirm');
      await prisma.procurementOrder.update({where:{id:originalBefore.order.id},data:{supplierId:sampleSupplier.id,supplierNameSnapshot:sampleSupplier.name}});
      for (const [suffix,day] of [['half','08'],['late','22']]) await prisma.procurementOrder.create({data:{id:'sample-order-'+suffix,storeKey:'synth-1',supplierId:sampleSupplier.id,supplierNameSnapshot:sampleSupplier.name,storeNameSnapshot:'合成门店1',status:'ORDERED',createdById:users.dev.id,createdByName:'合成备单人',orderedAt:new Date(`2026-09-${day}T02:00:00Z`),createRequestKey:rk(),createPayloadHash:'synthetic',lines:{create:[{id:'sample-line-a-'+suffix,inventoryItemId:'synth-item-a',productNameSnapshot:'合成糖商品A',unitSnapshot:'盒',orderedQty:'25',linePosition:0},{id:'sample-line-b-'+suffix,inventoryItemId:'synth-item-b',productNameSnapshot:'合成糖商品B',unitSnapshot:'克',orderedQty:'40.5',linePosition:1}]}}});
      fs.mkdirSync('output/purchase-return',{recursive:true});
      for(const end of ['2026-09-15','2026-09-30']) {
        const data=await history('staff',{end,supplierId:sampleSupplier.id});
        const bytes=await procurementHistoryExcelBytes(data);
        const file=`output/purchase-return/budu-采购记录-2026-09-01_${end}.xlsx`;
        fs.writeFileSync(file,bytes);
        const returned=data.summary.reduce((n,r)=>n+Number(r.returned),0), replenished=data.summary.reduce((n,r)=>n+Number(r.replacement),0);
        assert.equal(returned,100); assert.equal(replenished,end.endsWith('15')?0:80);
        console.log(`SAMPLE ${end} return=${returned} replacement=${replenished} sha256=${createHash('sha256').update(bytes).digest('hex')}`);
      }
    });
  } finally { fs.mkdirSync('output/purchase-return',{recursive:true}); fs.writeFileSync('output/purchase-return/native-results.json',JSON.stringify({results,externalAttempts:f.externalAttempts.length},null,2)); await f.cleanup(); }
  if(results.some(r=>r.status==='FAIL')) process.exitCode=1;
}

if(import.meta.url === pathToFileURL(process.argv[1]).href) {
  if(process.argv.includes('--serve')) {
    const f=await returnFixture();
    const {createServer}=await import('vite');
    const vite=await createServer({configFile:false,plugins:[(await import('@vitejs/plugin-react')).default()],server:{host:'127.0.0.1',port:5217,strictPort:true,proxy:{'/api':f.base,'/__fixture':f.base}}});
    await vite.listen(); console.log('PURCHASE_RETURN_LOCAL_FIXTURE_READY');
    const cleanup=async()=>{await vite.close();await f.cleanup();process.exit(0);};
    for(const [signal,hook] of f.helperSignalHooks) if(hook) process.removeListener(signal,hook);
    process.on('SIGTERM',cleanup);process.on('SIGINT',cleanup);
  } else await run();
}

import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';
import { returnFixture } from './test-purchase-return-native.mjs';
import { procurementHistoryExcelBytes } from '../src/utils/procurementHistoryExport.js';
const rk=()=>randomUUID(), root='/procurement/returns';
const project=fileURLToPath(new URL('../',import.meta.url));
const output=fileURLToPath(new URL('../output/purchase-return-r1/',import.meta.url));
export async function r1Fixture() {
  const f=await returnFixture();
  const orders=[];
  for(const storeKey of ['synth-1','synth-2']) {
    let order=(await f.ok('dev','/procurement/orders',{requestKey:rk(),content:{storeKey,supplierId:f.supplier.id,items:[{itemId:'synth-item-a',quantity:'100',unit:'盒'},{itemId:'synth-item-b',quantity:'20',unit:'克'}]}})).order;
    order=(await f.ok('dev',`/procurement/orders/${order.id}/mark-ordered`,{requestKey:rk(),version:order.version})).order;
    orders.push(order);
  }
  return {...f,orders};
}
async function run() {
  const f=await r1Fixture(), {prisma,request,ok,create,content,replacement,act,history}=f;
  const results=[];
  const test=async(name,fn)=>{try{const evidence=await fn();results.push({name,status:'PASS',...evidence});console.log(name+' PASS');}catch(e){results.push({name,status:'FAIL',error:e.stack});console.error(name+' FAIL '+e.message);}};
  const setActive=active=>prisma.store.update({where:{key:'synth-2'},data:{active}});
  let saved,corrected;
  try {
    await test('R1-01 服务端原单带入、空实际数量、可信快照和越权拒绝',async()=>{
      const order=f.orders[0], original=await ok('dev','/procurement/orders/'+order.id), count=await prisma.procurementReturn.count();
      const template=(await ok('staff',`/procurement/orders/${order.id}/return-template`)).content;
      assert.equal(await prisma.procurementReturn.count(),count);
      assert.equal(template.originalOrderId,order.id);assert.equal(template.supplierId,order.supplierId);assert.equal(template.storeKey,order.storeKey);
      assert.equal(template.items.length,2);assert(template.items.every(l=>l.quantity===''));assert.equal(template.returnedDate,'');
      assert.deepEqual(template.items.map(l=>l.unit),['盒','克']);
      assert.equal((await request('outsider',`/procurement/orders/${order.id}/return-template`)).status,403);
      const c={...template,returnedDate:'2026-09-14',reason:'合成带入退货',supplierNameSnapshot:'伪造供应商',storeNameSnapshot:'伪造门店',items:[{...template.items[0],quantity:'7',productNameSnapshot:'伪造商品'}]};
      let r=await create('staff',c);
      assert.equal(r.content.supplierNameSnapshot,order.supplierNameSnapshot);assert.equal(r.content.storeNameSnapshot,order.storeNameSnapshot);assert.equal(r.content.items[0].productNameSnapshot,order.lines[0].productNameSnapshot);
      r=await act('staff',r,'submit');r=await act('dev',r,'confirm');assert.equal(r.confirmedContent.items[0].quantity,'7');
      assert.deepEqual(await ok('dev','/procurement/orders/'+order.id),original);
      assert.equal((await request('outsider',root,{requestKey:rk(),content:{...c,storeKey:'synth-2'}})).status,403);
      for(const status of ['DRAFT','CANCELLED']) {
        await prisma.procurementOrder.update({where:{id:order.id},data:{status}});
        assert.equal((await request('staff',`/procurement/orders/${order.id}/return-template`)).status,409);
      }
      await prisma.procurementOrder.update({where:{id:order.id},data:{status:'ORDERED'}});
      return {automaticReturnRecords:0,actualReturned:'7',originalOrderUnchanged:true};
    });
    await test('R1-02A 完整补货80保存后停用仍可提交确认',async()=>{
      await setActive(true);saved=await create('multi',content('synth-1',[replacement('80','synth-2')]));
      await setActive(false);saved=await act('multi',saved,'submit');saved=await act('dev',saved,'confirm');
      assert.equal(saved.confirmedContent.replacements[0].quantity,'80');assert.equal((await prisma.store.findUnique({where:{key:'synth-2'}})).active,false);
      return {savedQuantity:'80',confirmedQuantity:'80',storeStillDisabled:true};
    });
    await test('R1-02B 确认80后停用重开改79；确认前Excel80、确认后79及审计',async()=>{
      await setActive(true);corrected=await create('multi',content('synth-1',[replacement('80','synth-2')]));
      corrected=await act('multi',corrected,'submit');corrected=await act('dev',corrected,'confirm');
      await setActive(false);corrected=await act('dev',corrected,'reopen',{reason:'合成纠正80录为79'});
      const oldVersion=corrected.version,c=structuredClone(corrected.content);c.replacements[0].quantity='79';
      corrected=await act('multi',corrected,'save',{content:c});corrected=await act('multi',corrected,'submit');
      const query=()=>history('dev',{keyword:corrected.number,type:'REPLACEMENT'});
      const excelQty=async h=>XLSX.utils.sheet_to_json(XLSX.read(await procurementHistoryExcelBytes(h),{type:'array'}).Sheets['收退货明细'],{range:4})[0]['本次数量'];
      let h=await query();assert.equal(h.events[0].quantity,'80');assert.equal(await excelQty(h),80);assert.equal(h.summary[0].replacement,'80');
      assert.equal((await request('dev',`${root}/${corrected.id}/confirm`,{requestKey:rk(),version:oldVersion})).status,409);
      corrected=await act('dev',corrected,'confirm');h=await query();assert.equal(h.events[0].quantity,'79');assert.equal(await excelQty(h),79);assert.equal(h.summary[0].replacement,'79');
      const audit=await prisma.procurementAudit.findMany({where:{entityId:corrected.id},orderBy:{createdAt:'asc'}});
      assert(audit.some(a=>a.action==='RETURN_REOPEN'&&a.reason==='合成纠正80录为79'));
      assert(audit.some(a=>a.action==='RETURN_SAVE'&&a.before.content.replacements[0].quantity==='80'&&a.after.content.replacements[0].quantity==='79'));
      return {beforeReconfirmation:{history:'80',xlsx:80},afterReconfirmation:{history:'79',xlsx:79},auditBeforeAfter:true};
    });
    await test('R1-02C 新增、更换停用门店、伪造及复制行号仍拒绝',async()=>{
      assert.equal((await request('multi',root,{requestKey:rk(),content:content('synth-1',[replacement('80','synth-2')])})).status,409);
      let r=await act('dev',saved,'reopen',{reason:'合成权限边界验证'});
      const duplicate=structuredClone(r.content);duplicate.replacements.push({...duplicate.replacements[0]});
      assert.equal((await request('multi',`${root}/${r.id}/save`,{requestKey:rk(),version:r.version,content:duplicate})).status,400);
      const appended=structuredClone(r.content);appended.replacements.push({...appended.replacements[0],rowId:rk()});
      assert.equal((await request('multi',`${root}/${r.id}/save`,{requestKey:rk(),version:r.version,content:appended})).status,409);
      const moved=structuredClone(r.content);moved.replacements[0].storeKey='chaowai';
      assert.equal((await request('multi',`${root}/${r.id}/save`,{requestKey:rk(),version:r.version,content:moved})).status,409);
      const blank=await create('multi',content());
      assert.equal((await request('multi',`${root}/${blank.id}/save`,{requestKey:rk(),version:blank.version,content:{...blank.content,replacements:[{...r.content.replacements[0]}]},confirmedContent:r.confirmedContent})).status,409);
      assert.equal((await request('outsider',`${root}/${r.id}/save`,{requestKey:rk(),version:r.version,content:r.content})).status,403);
      assert.equal((await request('staff',`${root}/${r.id}/save`,{requestKey:rk(),version:r.version,content:r.content})).status,403);
      return {newLineRejected:true,duplicateRowIdRejected:true,crossRecordRowIdRejected:true,changedClosedStoreRejected:true,partialScopeRejected:true};
    });
    await test('R1-02D 空或不完整已存草稿不能变成停用门店新事实',async()=>{
      await setActive(true);
      const drafts=[];
      for(const field of ['quantity','itemId','unit','receivedDate','storeKey']) {
        const line=replacement('80','synth-2');line[field]='';
        drafts.push(await create('multi',content('synth-1',[line])));
      }
      await setActive(false);
      for(const r of drafts) {
        const c=structuredClone(r.content);c.replacements[0]={...replacement('80','synth-2'),rowId:r.content.replacements[0].rowId,historical:true};
        assert.equal((await request('multi',`${root}/${r.id}/save`,{requestKey:rk(),version:r.version,content:c})).status,409);
        assert.equal((await ok('multi',root+'/'+r.id)).record.version,r.version);
      }
      return {incompleteDraftVariantsRejected:5,failedWritesLeaveVersionUnchanged:true};
    });
    await test('R1-02E 普通采购、普通收货的停用限制保持',async()=>{
      const c={storeKey:'synth-2',supplierId:f.supplier.id,items:[{itemId:'synth-item-a',quantity:'1',unit:'盒'}]};
      assert.equal((await request('dev','/procurement/orders',{requestKey:rk(),content:c})).status,409);
      const o=f.orders[1];
      assert.equal((await request('outsider',`/procurement/orders/${o.id}/receipts`,{requestKey:rk(),receivedDate:'2026-09-20',items:[{orderLineId:o.lines[0].id,quantity:'1'}]})).status,409);
      assert.equal(f.externalAttempts.length,0);
      return {ordinaryPurchaseRejected:true,ordinaryReceiptRejected:true,externalAttempts:0};
    });
  } finally {fs.mkdirSync(output,{recursive:true});fs.writeFileSync(output+'r1-native-results.json',JSON.stringify({results,externalAttempts:f.externalAttempts.length},null,2));await f.cleanup();}
  if(results.some(r=>r.status==='FAIL'))process.exitCode=1;
}
if(import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv.includes('--serve')) {
    // Tailwind resolves its existing configuration relative to the project cwd.
    process.chdir(project);
    const f=await r1Fixture();const {createServer}=await import('vite');
    const vite=await createServer({root:project,configFile:false,plugins:[(await import('@vitejs/plugin-react')).default()],server:{host:'127.0.0.1',port:5218,strictPort:true,proxy:{'/api':f.base,'/__fixture':f.base}}});
    await vite.listen();console.log('PURCHASE_RETURN_R1_FIXTURE_READY');
    const cleanup=async()=>{await vite.close();await f.cleanup();process.exit(0);};
    for(const [signal,hook]of f.helperSignalHooks)if(hook)process.removeListener(signal,hook);
    process.on('SIGTERM',cleanup);process.on('SIGINT',cleanup);
  } else await run();
}

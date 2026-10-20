import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { returnFixture } from './test-purchase-return-native.mjs';
const rk=()=>randomUUID(),root='/procurement/returns';
const output=fileURLToPath(new URL('../output/purchase-return-r2/',import.meta.url));
const f=await returnFixture(),{prisma,request,ok,create,content,replacement,act,history}=f;
const results=[];
const test=async(name,fn)=>{
  if(process.argv.includes('--reproduce-only')&&!name.startsWith('R2-01'))return;
  try{const evidence=await fn();results.push({name,status:'PASS',...evidence});console.log(name+' PASS');}
  catch(e){results.push({name,status:'FAIL',error:e.stack});console.error(name+' FAIL '+e.message);}
};
const active=value=>prisma.store.update({where:{key:'synth-2'},data:{active:value}});
const stored80=async()=>{await active(true);const r=await create('multi',content('synth-1',[replacement('80','synth-2')]));await active(false);return r;};
const saveQty=async(r,quantity)=>{const c=structuredClone(r.content);c.replacements[0].quantity=quantity;return act('multi',r,'save',{content:c});};
const query=r=>history('dev',{keyword:r.number,type:'REPLACEMENT'});
try {
  await test('R2-01 未确认80→空草稿→79→提交确认，历史资格和审计保留',async()=>{
    let r=await stored80();const rowId=r.content.replacements[0].rowId;
    r=await saveQty(r,'');assert.equal(r.confirmedContent,null);
    r=(await ok('multi',root+'/'+r.id)).record;assert.equal(r.content.replacements[0].quantity,'');
    r=await saveQty(r,'79');assert.equal(r.content.replacements[0].rowId,rowId);
    let h=await query(r);assert.equal(h.events[0].quantity,'79');assert.equal(h.events[0].counted,false);assert.equal(h.summary.length,0);
    r=await act('multi',r,'submit');h=await query(r);assert.equal(h.summary.length,0);
    r=await act('dev',r,'confirm');h=await query(r);assert.equal(h.summary[0].replacement,'79');
    assert.equal((await prisma.store.findUnique({where:{key:'synth-2'}})).active,false);
    const audits=await prisma.procurementAudit.findMany({where:{entityId:r.id},orderBy:{createdAt:'asc'}});
    assert(audits.some(a=>a.action==='RETURN_SAVE'&&a.before.content.replacements[0].quantity==='80'&&a.after.content.replacements[0].quantity===''));
    assert(audits.some(a=>a.action==='RETURN_SAVE'&&a.before.content.replacements[0].quantity===''&&a.after.content.replacements[0].quantity==='79'));
    return {persistedSequence:['80','','79'],unconfirmedSummaryRows:0,confirmedQuantity:'79',storeStillDisabled:true,auditBeforeAfter:true};
  });
  await test('R2-02 多次不完整修订仍可补齐同店已有事实',async()=>{
    let r=await stored80();const original=structuredClone(r.content.replacements[0]);
    for(const field of ['quantity','unit','itemId','receivedDate','storeKey']){
      const c=structuredClone(r.content);c.replacements[0][field]='';r=await act('multi',r,'save',{content:c});
    }
    const c=structuredClone(r.content);c.replacements[0]={...original,quantity:'79'};r=await act('multi',r,'save',{content:c});
    r=await act('multi',r,'submit');r=await act('dev',r,'confirm');assert.equal(r.confirmedContent.replacements[0].quantity,'79');
    return {incompleteSaves:5,restoredStore:'synth-2',confirmedQuantity:'79'};
  });
  await test('R2-03 初始不完整草稿、客户端历史与确认伪造不授予历史资格',async()=>{
    await active(true);const drafts=[];
    for(const field of ['quantity','unit','itemId','receivedDate','storeKey']){const line=replacement('80','synth-2');line[field]='';drafts.push(await create('multi',content('synth-1',[line])));}
    await active(false);
    for(const r of drafts){const c=structuredClone(r.content);c.replacements[0]={...replacement('79','synth-2'),rowId:r.content.replacements[0].rowId,historical:true,previouslyComplete:true};
      const fake={...r,content:c,confirmedContent:c};
      assert.equal((await request('multi',`${root}/${r.id}/save`,{requestKey:rk(),version:r.version,content:c,confirmedContent:c,history:[fake],historicalStores:{[c.replacements[0].rowId]:'synth-2'}})).status,409);
      assert.equal((await ok('multi',root+'/'+r.id)).record.version,r.version);
    }
    return {initialPlaceholdersRejected:5,clientHistoryIgnored:true,clientConfirmedContentIgnored:true};
  });
  await test('R2-04 新增、跨单／重复行号、更换停用门店仍拒绝',async()=>{
    let r=await stored80();r=await saveQty(r,'');
    const c=structuredClone(r.content);c.replacements[0].quantity='79';
    const appended=structuredClone(c);appended.replacements.push({...c.replacements[0],rowId:rk()});
    assert.equal((await request('multi',`${root}/${r.id}/save`,{requestKey:rk(),version:r.version,content:appended})).status,409);
    const duplicate=structuredClone(c);duplicate.replacements.push({...c.replacements[0]});
    assert.equal((await request('multi',`${root}/${r.id}/save`,{requestKey:rk(),version:r.version,content:duplicate})).status,400);
    const moved=structuredClone(c);moved.replacements[0].storeKey='chaowai';
    assert.equal((await request('multi',`${root}/${r.id}/save`,{requestKey:rk(),version:r.version,content:moved})).status,409);
    const other=await create('multi',content());
    assert.equal((await request('multi',`${root}/${other.id}/save`,{requestKey:rk(),version:other.version,content:{...other.content,replacements:c.replacements}})).status,409);
    assert.equal((await request('multi',root,{requestKey:rk(),content:c})).status,409);
    for(const who of ['staff','outsider'])assert.equal((await request(who,`${root}/${r.id}/save`,{requestKey:rk(),version:r.version,content:c})).status,403);
    return {newLineRejected:true,crossRecordIdRejected:true,duplicateIdRejected:true,changedClosedStoreRejected:true,partialScopeRejected:true};
  });
  await test('R2-05 删除后复用行号或换店再清空不能复活旧店资格',async()=>{
    let deleted=await stored80();const old=structuredClone(deleted.content.replacements[0]);
    deleted=await act('multi',deleted,'save',{content:{...deleted.content,replacements:[]}});
    const placeholder={...old,quantity:'',unit:'',itemId:'',receivedDate:'',storeKey:''};
    deleted=await act('multi',deleted,'save',{content:{...deleted.content,replacements:[placeholder]}});
    assert.equal((await request('multi',`${root}/${deleted.id}/save`,{requestKey:rk(),version:deleted.version,content:{...deleted.content,replacements:[{...old,quantity:'79'}]}})).status,409);
    let moved=await stored80();const original=structuredClone(moved.content.replacements[0]);
    moved=await act('multi',moved,'save',{content:{...moved.content,replacements:[{...original,quantity:'',storeKey:'synth-1'}]}});
    moved=await act('multi',moved,'save',{content:{...moved.content,replacements:[{...original,quantity:'',storeKey:''}]}});
    assert.equal((await request('multi',`${root}/${moved.id}/save`,{requestKey:rk(),version:moved.version,content:{...moved.content,replacements:[{...original,quantity:'79'}]}})).status,409);
    return {deletedRowIdCannotResurrect:true,changedStoreInvalidatesOldAnchor:true};
  });
  await test('R2-06 已确认重开修订、版本、冻结、幂等和最终确认保持',async()=>{
    await active(true);let r=await create('multi',content('synth-1',[replacement('80','synth-2')]));r=await act('multi',r,'submit');r=await act('dev',r,'confirm');
    await active(false);r=await act('dev',r,'reopen',{reason:'合成R2纠错'});r=await saveQty(r,'');const oldVersion=r.version;
    r=await saveQty(r,'79');assert.equal((await query(r)).summary[0].replacement,'80');
    assert.equal((await request('multi',`${root}/${r.id}/save`,{requestKey:rk(),version:oldVersion,content:r.content})).status,409);
    const body={requestKey:rk(),version:r.version,content:r.content};
    const replay=await Promise.all([request('multi',`${root}/${r.id}/save`,body),request('multi',`${root}/${r.id}/save`,body)]);
    assert(replay.every(x=>x.status===200));r=replay[0].record;
    assert.equal(await prisma.procurementAudit.count({where:{entityId:r.id,operationKey:body.requestKey}}),1);
    r=await act('multi',r,'submit');assert.equal((await query(r)).summary[0].replacement,'80');
    assert.equal((await request('multi',`${root}/${r.id}/save`,{requestKey:rk(),version:r.version,content:r.content})).status,409);
    assert.equal((await request('multi',`${root}/${r.id}/confirm`,{requestKey:rk(),version:r.version})).status,403);
    r=await act('dev',r,'confirm');assert.equal((await query(r)).summary[0].replacement,'79');
    assert.equal((await prisma.store.findUnique({where:{key:'synth-2'}})).active,false);
    return {beforeConfirmation:'80',afterConfirmation:'79',staleVersionRejected:true,pendingFrozen:true,employeeConfirmRejected:true,idempotentSaveAudits:1};
  });
} finally {
  fs.mkdirSync(output,{recursive:true});fs.writeFileSync(output+(process.argv.includes('--reproduce-only')?'baseline-reproduction.json':'native-results.json'),JSON.stringify({results,externalAttempts:f.externalAttempts.length},null,2));
  await f.cleanup();
}
if(results.some(r=>r.status==='FAIL'))process.exitCode=1;

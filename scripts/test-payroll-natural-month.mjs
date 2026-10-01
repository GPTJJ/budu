import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {buildNaturalMonthSummary,renderNaturalMonthHtml} from '../server/payroll-audit-natural-month.js'
import {prepareNaturalMonthReports,runPayrollAuditJob,runDuePayrollAuditJobs} from '../server/payroll-audit-scheduler-core.js'
import {readPayrollDeliveryPdf,preparePayrollConnectedDelivery,reviewPayrollConnectedDelivery,claimPayrollConnectedDelivery,completePayrollConnectedDelivery} from '../server/payroll-audit-delivery-bridge.js'
import {sendPayrollAuditEmail} from '../server/payroll-audit-email.js'
import {writePayrollAuditJob,readPayrollAuditJob} from '../server/payroll-audit-job-store.js'
const execution={actualModel:'GPT-5.6 Sol',actualReasoning:'Medium'}
const period={periodStart:'2026-09-01',periodEnd:'2026-09-30'}
const recipients=['yuegu1995@gmail.com','970701330@qq.com','korea_jing@163.com']
function source(type,id,amount='100') {
 const e={employeeId:id,employeeName:id,employmentType:type==='MONTHLY_PART_TIME'?'parttime':'fulltime',authoritativePayrollCents:amount,employeeCardCents:amount,differenceCents:'0',components:[{key:'basePay',amountCents:amount}],issues:[],status:'PASS',payableHours:1,dailyPayrollBreakdownComplete:true,dailyReconciliation:[{date:'2026-09-30'}]}
 return {model:{schemaVersion:6,runId:id,canonicalHash:id+'hash',metadata:{...execution,reportType:type,requestedPeriod:{start:period.periodStart,end:period.periodEnd},authorityDigest:'same',productionSha:'same'},employeeResults:[e],summary:{employeeCount:1,passCount:1,blockedCount:0,reviewRequiredCount:0,anomalyCount:0,issueCount:0,auditHintCount:0,noPayrollRequiredCount:0,authoritativePayrollCents:amount,employeeCardCents:amount,differenceCents:'0',finalResult:'PASS'}}}
}
function input(){return {...execution,...period,fullTimeSource:source('MONTHLY_FULL_TIME_REVIEWED','full'),partTimeMonthlySource:source('MONTHLY_PART_TIME','part','250')}}
test('natural month combines exact persisted monthly results without weekly dependency or recalculation',()=>{
 const m=buildNaturalMonthSummary(input());assert.equal(m.summary.authoritativePayrollCents,'350');assert.equal(m.naturalMonth.partTimePayrollCents,'250');assert.equal(m.summary.employeeCount,2);assert.equal(m.executionEvidence.payrollCoreReexecuted,false);assert.equal(m.sourceReferences.length,2)
})
test('month boundaries, employee duplication, types and unequal snapshots fail closed',()=>{
 for(const [change,code] of [
 [x=>x.partTimeMonthlySource.model.employeeResults[0].dailyReconciliation[0].date='2026-10-01','NATURAL_MONTH_DATE_OUTSIDE_RANGE'],
 [x=>x.partTimeMonthlySource.model.employeeResults[0].dailyReconciliation.push({date:'2026-09-30'}),'NATURAL_MONTH_DATE_DUPLICATE'],
 [x=>x.partTimeMonthlySource.model.employeeResults[0].employeeId='full','NATURAL_MONTH_EMPLOYEE_DUPLICATE'],
 [x=>x.partTimeMonthlySource.model.employeeResults[0].employmentType='fulltime','NATURAL_MONTH_EMPLOYMENT_TYPE_MISMATCH'],
 [x=>x.partTimeMonthlySource.model.metadata.authorityDigest='changed','NATURAL_MONTH_SNAPSHOT_MISMATCH'],
 [x=>x.partTimeMonthlySource=null,'NATURAL_MONTH_SOURCE_MISSING_OR_INVALID']]){const x=input();change(x);assert.throws(()=>buildNaturalMonthSummary(x),e=>e.code===code)}
})
test('real blocked or review source remains held, with known amounts never changing',()=>{
 for(const status of ['BLOCKED','REVIEW_REQUIRED']){const x=input();x.partTimeMonthlySource.model.summary.finalResult=status;x.partTimeMonthlySource.model.employeeResults[0].status=status;const m=buildNaturalMonthSummary(x);assert.equal(m.summary.finalResult,status);assert.equal(m.summary.authoritativePayrollCents,'350')}
})
test('monthly generation cannot use direct send even with injected transport',async()=>{
 let sent=false;await assert.rejects(runPayrollAuditJob({...execution,...period,reportType:'MONTHLY_FULL_TIME_REVIEWED',email:true},{send:async()=>{sent=true}}),e=>e.code==='PAYROLL_MONTHLY_PREPARE_ONLY');assert.equal(sent,false)
})
test('existing weekly FORMAL delivery remains available and idempotent without a monthly parent gate',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'budu-weekly-compat-')),previous=process.env.PAYROLL_AUDIT_DATA_DIR;process.env.PAYROLL_AUDIT_DATA_DIR=root
 try{
 const generated=await runPayrollAuditJob({...execution,reportType:'WEEKLY_PART_TIME',periodStart:'2026-09-21',periodEnd:'2026-09-27',email:false,allowNonProduction:true},{snapshot:async()=>snapshot()})
 const jobKey=generated.job.jobKey
 const prepared=await preparePayrollConnectedDelivery({jobKey,mode:'FORMAL',recipients,expectedModel:execution.actualModel,expectedReasoning:execution.actualReasoning})
 assert.equal(prepared.parentReview,null)
 const claimed=await claimPayrollConnectedDelivery({jobKey,deliveryId:prepared.deliveryId});assert.equal(claimed.status,'SENDING')
 const complete=await completePayrollConnectedDelivery({jobKey,deliveryId:prepared.deliveryId,status:'SENT',messageId:'fake-test-weekly-message'});assert.equal(complete.formalEmailStatus,'SENT')
 assert.equal((await claimPayrollConnectedDelivery({jobKey,deliveryId:prepared.deliveryId})).alreadySent,true)
 }finally{if(previous===undefined)delete process.env.PAYROLL_AUDIT_DATA_DIR;else process.env.PAYROLL_AUDIT_DATA_DIR=previous;fs.rmSync(root,{recursive:true,force:true})}
})
function snapshot(){return {generatedAt:'2026-10-01T01:00:00Z',productionSha:'test',database:'test',authorityDigest:'same',schedules:[],attendanceRows:[],cardAmountCentsById:{f:'0',p:'0'},authority:{period,employees:[{id:'f',name:'全职',type:'fulltime'},{id:'p',name:'兼职',type:'parttime'}],storeNames:{},result:{calculationReady:true,payroll:{employees:[{employeeId:'f',salary:0,payableHours:0,dailyExplanations:[]},{employeeId:'p',salary:0,payableHours:0,dailyExplanations:[]}]},readiness:{employees:[{employeeId:'f',blockers:[]},{employeeId:'p',blockers:[]}]},blockers:[]}}}}
test('prepare serial sources once, persist independent identities, require exact independent parent review before claim',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'budu-natural-review-')),previous=process.env.PAYROLL_AUDIT_DATA_DIR;process.env.PAYROLL_AUDIT_DATA_DIR=root
 try {
 let captures=0;const args={...execution,...period,allowNonProduction:true,actorId:'prepare:child',preparationThreadId:'child',parentReviewThreadId:'parent'}
 const first=await prepareNaturalMonthReports(args,{snapshot:async()=>{captures++;return snapshot()}})
 assert.equal(captures,1);assert.equal(first.results.length,3);assert.equal(new Set(first.results.map(r=>r.job.jobKey)).size,3);assert.ok(first.results.every(r=>r.job.emailStatus==='NOT_SENT'))
 const second=await prepareNaturalMonthReports(args,{snapshot:async()=>snapshot()});assert.deepEqual(second.results.map(r=>r.job.runId),first.results.map(r=>r.job.runId))
 for(const jobKey of first.deliveryJobKeys){
 await assert.rejects(preparePayrollConnectedDelivery({jobKey,mode:'TEST',recipients:['yuegu1995@gmail.com'],expectedModel:execution.actualModel,expectedReasoning:execution.actualReasoning}),e=>e.code==='PAYROLL_MONTHLY_FORMAL_ONLY')
 const prepared=await preparePayrollConnectedDelivery({jobKey,mode:'FORMAL',recipients,expectedModel:execution.actualModel,expectedReasoning:execution.actualReasoning})
 await assert.rejects(claimPayrollConnectedDelivery({jobKey,deliveryId:prepared.deliveryId}),e=>e.code==='PAYROLL_PARENT_REVIEW_REQUIRED')
 const reviewed={jobKey,deliveryId:prepared.deliveryId,reportId:prepared.reportId,canonicalHash:prepared.canonicalHash,pdfHash:prepared.artifact.sha256,...period,recipients,reviewerThreadId:'parent',preparationThreadId:'child',decision:'APPROVED',evidence:'Read all pages and checked amounts'}
 for(const change of [{pdfHash:'wrong'},{canonicalHash:'wrong'},{reportId:'wrong'},{periodEnd:'2026-10-01'},{recipients:['yuegu1995@gmail.com']}]) await assert.rejects(reviewPayrollConnectedDelivery({...reviewed,...change}),e=>e.code==='PAYROLL_PARENT_REVIEW_BINDING_MISMATCH')
 await assert.rejects(reviewPayrollConnectedDelivery({...reviewed,reviewerThreadId:'other-parent'}),e=>e.code==='PAYROLL_PARENT_REVIEW_NOT_INDEPENDENT')
 await assert.rejects(reviewPayrollConnectedDelivery({...reviewed,reviewerThreadId:'child'}),e=>e.code==='PAYROLL_PARENT_REVIEW_NOT_INDEPENDENT')
 const frozen=readPayrollDeliveryPdf(reviewed);assert.equal(crypto.createHash('sha256').update(frozen.bytes).digest('hex'),reviewed.pdfHash)
 await assert.throws(()=>readPayrollDeliveryPdf({...reviewed,pdfHash:'wrong'}),e=>e.code==='PAYROLL_ATTACHMENT_IDENTITY_MISMATCH')
 await reviewPayrollConnectedDelivery(reviewed)
 // A later artifact replacement invalidates review, even if its manifest hash is updated.
 const job=first.results.find(r=>r.job.jobKey===jobKey).job;const manifest=JSON.parse(fs.readFileSync(job.artifacts.manifest));const old=manifest.artifacts.pdf.sha256;const bytes=fs.readFileSync(manifest.artifacts.pdf.path);fs.appendFileSync(manifest.artifacts.pdf.path,'\n');assert.equal(crypto.createHash('sha256').update(frozen.bytes).digest('hex'),reviewed.pdfHash);assert.throws(()=>readPayrollDeliveryPdf(reviewed),e=>e.code==='PAYROLL_DELIVERY_ARTIFACT_INVALID');manifest.artifacts.pdf.sha256=crypto.createHash('sha256').update(fs.readFileSync(manifest.artifacts.pdf.path)).digest('hex');fs.writeFileSync(job.artifacts.manifest,JSON.stringify(manifest))
 await assert.rejects(claimPayrollConnectedDelivery({jobKey,deliveryId:prepared.deliveryId}),e=>e.code==='PAYROLL_PARENT_REVIEW_REQUIRED')
 fs.writeFileSync(manifest.artifacts.pdf.path,bytes);manifest.artifacts.pdf.sha256=old;fs.writeFileSync(job.artifacts.manifest,JSON.stringify(manifest));const claimed=await claimPayrollConnectedDelivery({jobKey,deliveryId:prepared.deliveryId});assert.equal(claimed.status,'SENDING')
 fs.appendFileSync(manifest.artifacts.pdf.path,'\n');await assert.rejects(claimPayrollConnectedDelivery({jobKey,deliveryId:prepared.deliveryId}),e=>e.code==='PAYROLL_DELIVERY_ARTIFACT_INVALID');fs.writeFileSync(manifest.artifacts.pdf.path,bytes)
 }
 }finally{if(previous===undefined)delete process.env.PAYROLL_AUDIT_DATA_DIR;else process.env.PAYROLL_AUDIT_DATA_DIR=previous;fs.rmSync(root,{recursive:true,force:true})}
})

test('bottom-level automatic Gmail sender rejects monthly payloads before OAuth or network',async()=>{
 let network=0
 for(const payload of [{reportType:'MONTHLY_NATURAL_SUMMARY',subject:'summary'},{subject:'budu 全职员工薪酬审查报告'},{subject:'budu 统一月度薪酬总览'}]) await assert.rejects(sendPayrollAuditEmail(payload,{fetch:async()=>{network++}}),e=>e.code==='PAYROLL_MONTHLY_PARENT_SEND_ONLY')
 assert.equal(network,0)
})

test('scheduled skips old monthly preparation and retries while still generating and retrying weekly reports',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'budu-scheduled-monthly-skip-')),previous=process.env.PAYROLL_AUDIT_DATA_DIR,previousStart=process.env.PAYROLL_AUDIT_SCHEDULER_START_DATE;process.env.PAYROLL_AUDIT_DATA_DIR=root;process.env.PAYROLL_AUDIT_SCHEDULER_START_DATE='2026-09-01'
 try{
 const common={...execution,email:false,allowNonProduction:true}
 const oldWeekly=await runPayrollAuditJob({...common,reportType:'WEEKLY_PART_TIME',periodStart:'2026-09-14',periodEnd:'2026-09-20'},{snapshot:async()=>snapshot()})
 const oldMonthly=await runPayrollAuditJob({...common,...period,reportType:'MONTHLY_FULL_TIME'},{snapshot:async()=>snapshot()})
 for(const r of [oldWeekly,oldMonthly])writePayrollAuditJob({...r.job,emailStatus:'FAILED'})
 let sends=0
 const results=await runDuePayrollAuditJobs(new Date('2026-10-01T01:00:00Z'),{...execution,snapshot:async()=>({...snapshot(),database:'budu_bj006'}),send:async()=>{sends++;return {messageId:'fake-scheduled-weekly'}}})
 assert.ok(results.some(r=>r.skipped && r.reportType==='MONTHLY_FULL_TIME'));assert.equal(sends,2)
 assert.equal(readPayrollAuditJob(oldWeekly.job.jobKey).emailStatus,'SENT');assert.equal(readPayrollAuditJob(oldMonthly.job.jobKey).emailStatus,'FAILED')
 }finally{if(previous===undefined)delete process.env.PAYROLL_AUDIT_DATA_DIR;else process.env.PAYROLL_AUDIT_DATA_DIR=previous;if(previousStart===undefined)delete process.env.PAYROLL_AUDIT_SCHEDULER_START_DATE;else process.env.PAYROLL_AUDIT_SCHEDULER_START_DATE=previousStart;fs.rmSync(root,{recursive:true,force:true})}
})

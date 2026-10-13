import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createP1Harness,syntheticPdf} from './helpers/p1-fix-harness.mjs'
const h=await createP1Harness()
const {createServer}=h.require('vite'),{webkit}=h.require('playwright-core')
const reactPlugin=h.require('@vitejs/plugin-react');
const vite=await createServer({plugins:[(reactPlugin.default||reactPlugin)()],root:h.source,cacheDir:path.join(h.root,'work/vite-cache'),configFile:false,envFile:false,server:{host:'127.0.0.1',port:58320,strictPort:true,proxy:{'/api':'http://127.0.0.1:58319'}}})
await vite.listen()
const browser=await webkit.launch({executablePath:'/Users/buxieshi/Library/Caches/ms-playwright/webkit-2203/pw_run.sh',headless:true})
const origin='http://127.0.0.1:58320',checks=[]
async function context(actor){const c=await browser.newContext({viewport:{width:1024,height:900}});await c.addCookies([{name:'budu_token',value:h.cookies[actor].slice('budu_token='.length),url:origin,httpOnly:true,sameSite:'Lax'}]);await c.route('**/*',route=>{const url=route.request().url();return url.startsWith(origin+'/')||url.startsWith('data:')||url.startsWith('blob:'+origin+'/')?route.continue():route.abort()});return c}
async function fromPage(page,route,body,method='POST'){return page.evaluate(async({route,body,method})=>{const response=await fetch('/api'+route,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()}},{route,body,method})}
const contexts=[]
try{
 const uploader=await context('uploader'),viewer=await context('viewer');contexts.push(uploader,viewer)
 const uploadPage=await uploader.newPage(),viewPage=await viewer.newPage()
 await uploadPage.goto(origin+'/tests/p1-fix-harness.html');await viewPage.goto(origin+'/tests/p1-fix-harness.html')
 await viewPage.getByRole('heading',{name:'budu档案馆',exact:true}).waitFor({timeout:10000}).catch(async e=>{console.log((await viewPage.locator('body').innerText()).slice(0,2000));throw e})
 const html='<script>parent.__p1UntrustedExecuted=true;try{parent.document.body.dataset.compromised="1"}catch(e){};fetch("/api/admin/users").then(()=>parent.__p1ProtectedCalled=true)</script>'
 const malicious='data:text/html;base64,'+Buffer.from(html).toString('base64')
 const rejection=await fromPage(uploadPage,'/v2/asset-center/files',{name:'Counterfeit PDF',category:'p1-category',fileName:'counterfeit.pdf',fileType:'application/pdf',dataUrl:malicious})
 assert.equal(rejection.status,400);checks.push({id:'AUTH-upload-E2E',result:'PASS',ordinaryRole:h.users.uploader.role,status:rejection.status})
 // Safely accepted active format is persisted as octet-stream; actual UI opens it download-only.
 const safeActive=await fromPage(uploadPage,'/v2/asset-center/files',{name:'Active file download only',category:'p1-category',fileName:'active.html',fileType:'text/html',dataUrl:malicious});assert.equal(safeActive.status,201)
 const historical=await h.db.assetFile.create({data:{id:'p1-browser-historical',name:'Historical Counterfeit',category:'p1-category',fileType:'application/pdf',fileSize:Buffer.from(html).length,versions:{create:{id:'p1-browser-history-v1',version:1,name:'old.pdf',fileType:'application/pdf',dataUrl:malicious,uploaderName:'Synthetic'}}}})
 let protectedCalls=0;viewPage.on('request',req=>{if(req.url().includes('/api/admin/users'))protectedCalls++})
 await viewPage.reload();await viewPage.getByTestId('asset-card-p1-browser-historical').waitFor()
 await viewPage.getByRole('button',{name:'预览 Historical Counterfeit',exact:true}).click()
 await viewPage.locator('[data-testid="safe-attachment-preview"][data-preview-kind="download"]').waitFor()
 assert.equal(await viewPage.getByTestId('safe-attachment-preview').getAttribute('data-preview-kind'),'download')
 assert.equal(await viewPage.locator('iframe').count(),0)
 const probe=await viewPage.evaluate(()=>({executed:!!window.__p1UntrustedExecuted,protected:!!window.__p1ProtectedCalled,modified:document.body.dataset.compromised==='1'}));assert.deepEqual(probe,{executed:false,protected:false,modified:false});assert.equal(protectedCalls,0)
 assert.equal((await h.db.assetFileVersion.findUnique({where:{id:'p1-browser-history-v1'}})).dataUrl,malicious)
 checks.push({id:'AUTH-history-E2E',result:'PASS',...probe,protectedRequests:protectedCalls,storedBytesUnchanged:true})
 await viewPage.getByRole('button',{name:'关闭',exact:true}).last().click()
 const pdf=await fromPage(uploadPage,'/v2/asset-center/files',{name:'Normal Synthetic PDF',category:'p1-category',fileName:'normal.pdf',fileType:'application/pdf',dataUrl:'data:application/pdf;base64,'+syntheticPdf().toString('base64')});assert.equal(pdf.status,201)
 const png=h.require('sharp');const pngBytes=await png({create:{width:8,height:8,channels:4,background:{r:220,g:30,b:80,alpha:1}}}).png().toBuffer()
 const image=await fromPage(uploadPage,'/v2/asset-center/files',{name:'Normal Synthetic PNG',category:'p1-category',fileName:'normal.png',fileType:'image/png',dataUrl:'data:image/png;base64,'+pngBytes.toString('base64')});assert.equal(image.status,201)
 await viewPage.reload();await viewPage.getByTestId('asset-card-'+pdf.body.file.id).waitFor()
 await viewPage.getByRole('button',{name:'预览 Normal Synthetic PDF',exact:true}).click()
 await viewPage.locator('canvas[data-rendered="true"]').waitFor({timeout:15000})
 const pixels=await viewPage.locator('canvas').evaluate(c=>{const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let nonwhite=0;for(let i=0;i<data.length;i+=4)if(data[i+3]&&data[i]<200)nonwhite++;return {width:c.width,height:c.height,nonwhite}});assert.ok(pixels.nonwhite>20)
 checks.push({id:'AUTH-PDF-preview',result:'PASS',...pixels})
 await viewPage.screenshot({path:path.join(h.root,'work/pdf-preview.png')})
 await viewPage.getByRole('button',{name:'关闭',exact:true}).last().click()
 await viewPage.getByRole('button',{name:'预览 Normal Synthetic PNG',exact:true}).click()
 await viewPage.getByTestId('safe-attachment-preview').locator('img').waitFor();await viewPage.waitForFunction(()=>document.querySelector('[data-testid="safe-attachment-preview"] img')?.naturalWidth===8);assert.ok(await viewPage.getByTestId('safe-attachment-preview').locator('img').evaluate(x=>x.complete&&x.naturalWidth===8));checks.push({id:'AUTH-image-preview',result:'PASS'})
 await viewPage.getByRole('button',{name:'关闭',exact:true}).last().click()
 const content=await h.api('/v2/asset-center/files/'+pdf.body.file.id+'/download?asFile=1',{raw:true});assert.match(content.headers.get('content-disposition'),/^attachment;/)
 const downloaded=viewPage.waitForEvent('download');await viewPage.getByTestId('asset-card-'+pdf.body.file.id).getByRole('button',{name:'下载',exact:true}).click();assert.equal((await downloaded).suggestedFilename(),'normal.pdf');checks.push({id:'AUTH-authorized-download',result:'PASS'})
 assert.equal((await h.api('/v2/asset-center/files/'+historical.id+'/download',{actor:'outsider'})).status,403)
 const history=await h.api('/v2/asset-center/files/'+historical.id+'/versions');assert.equal(history.body.rows[0].fileType,'application/octet-stream');assert.equal(history.body.rows[0].previewKind,'download')
 checks.push({id:'AUTH-history-version-GET-and-unauthorized',result:'PASS'})
 // PDF actions are present in the bytes but the renderer never installs an action execution layer.
 const actionPdf=await fromPage(uploadPage,'/v2/asset-center/files',{name:'PDF with synthetic action',category:'p1-category',fileName:'action.pdf',fileType:'application/pdf',dataUrl:'data:application/pdf;base64,'+syntheticPdf({pages:2,script:html}).toString('base64')});assert.equal(actionPdf.status,201)
 await viewPage.reload();await viewPage.getByRole('button',{name:'预览 PDF with synthetic action',exact:true}).click();await viewPage.locator('canvas[data-rendered="true"]').waitFor()
 await viewPage.getByRole('button',{name:'下一页',exact:true}).click();await viewPage.getByText('2 / 2',{exact:true}).waitFor();await viewPage.locator('canvas[data-rendered="true"]').waitFor()
 assert.equal(await viewPage.evaluate(()=>!!window.__p1UntrustedExecuted),false);assert.equal(protectedCalls,0);checks.push({id:'AUTH-PDF-action-and-pagination',result:'PASS',pages:2,renderedPage:2,untrustedActionsExecuted:false})
 const widths=[]
 for(const width of [320,340,375,390,430,768,1024]){await viewPage.setViewportSize({width,height:900});const rect=await viewPage.locator('canvas').boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=width+1);widths.push(width)}
 checks.push({id:'AUTH-preview-widths',result:'PASS',widths});await viewPage.getByRole('button',{name:'关闭',exact:true}).last().click()
 // Exercise all raster formats claimed by the classifier through the real upload/read/UI chain.
 const rasterInputs=[['JPEG',await png({create:{width:8,height:8,channels:3,background:'#de2050'}}).jpeg().toBuffer(),'image/jpeg'],['GIF',await png({create:{width:8,height:8,channels:3,background:'#de2050'}}).gif().toBuffer(),'image/gif'],['WebP',await png({create:{width:8,height:8,channels:3,background:'#de2050'}}).webp().toBuffer(),'image/webp']]
 const bmp=Buffer.alloc(58);bmp.write('BM');bmp.writeUInt32LE(58,2);bmp.writeUInt32LE(54,10);bmp.writeUInt32LE(40,14);bmp.writeInt32LE(1,18);bmp.writeInt32LE(1,22);bmp.writeUInt16LE(1,26);bmp.writeUInt16LE(24,28);bmp.writeUInt32LE(4,34);bmp[56]=220;rasterInputs.push(['BMP',bmp,'image/bmp'])
 for(const [label,bytes,mime] of rasterInputs){const uploaded=await fromPage(uploadPage,'/v2/asset-center/files',{name:'Raster '+label,category:'p1-category',fileName:'raster.'+label.toLowerCase(),fileType:mime,dataUrl:'data:'+mime+';base64,'+bytes.toString('base64')});assert.equal(uploaded.status,201);await viewPage.reload();await viewPage.getByRole('button',{name:'预览 Raster '+label,exact:true}).click();await viewPage.waitForFunction(()=>document.querySelector('[data-testid="safe-attachment-preview"] img')?.naturalWidth>0);checks.push({id:'AUTH-raster-'+label,result:'PASS'});await viewPage.getByRole('button',{name:'关闭',exact:true}).last().click()}
 // Employee frontend follows the same safe component, while content is always a forced attachment.
 const employeeId=h.users.uploader.employeeId,employeeRoute='/v2/employees/'+employeeId+'/documents'
 const employeePdf=await h.api(employeeRoute,{method:'POST',body:{fileName:'employee.pdf',mimeType:'application/pdf',data:syntheticPdf().toString('base64')}});assert.equal(employeePdf.status,200)
 await h.db.employeeDocument.create({data:{id:'p1-browser-employee-historical',employeeId,documentType:'other',fileName:'historical-active.pdf',mimeType:'application/pdf',fileSize:Buffer.from(html).length,data:Buffer.from(html).toString('base64'),isSensitive:true,uploadedBy:'Synthetic'}})
 const employeePage=await viewer.newPage();await employeePage.goto(origin+'/tests/p1-fix-harness.html?mode=employee&id='+employeeId);await employeePage.getByRole('button',{name:'附件',exact:true}).click()
 for(const [name,kind] of [['employee.pdf','pdf'],['historical-active.pdf','download']]){await employeePage.locator('p').filter({hasText:name}).locator('xpath=../..').getByRole('button',{name:'查看',exact:true}).click();await employeePage.locator('[data-preview-kind="'+kind+'"]').waitFor();if(kind==='pdf')await employeePage.locator('canvas[data-rendered="true"]').waitFor();assert.equal(await employeePage.locator('iframe').count(),0);assert.equal(await employeePage.evaluate(()=>!!window.__p1UntrustedExecuted),false);await employeePage.getByRole('button',{name:'关闭',exact:true}).click()}
 checks.push({id:'AUTH-employee-frontend',result:'PASS',normalPdf:true,historicalActiveDownloadOnly:true});await employeePage.close()
 // Complete sequential stale view: A renders100, B rejects/edits9000/resubmits and finishes, then A acts.
 const approverA=await context('approver'),approverB=await context('approver');contexts.push(approverA,approverB)
 const a=await approverA.newPage(),b=await approverB.newPage()
 for(const action of ['approve','reject']){
  const created=await h.createApproval(),id=created.body.request.id;assert.equal(created.status,200)
  await a.goto(origin+'/tests/p1-fix-harness.html?mode=approval&id='+id);await b.goto(origin+'/tests/p1-fix-harness.html?mode=approval&id='+id)
  await a.getByRole('button',{name:'同意',exact:true}).waitFor()
  const fresh=(await h.api('/v2/approvals/requests/'+id,{actor:'approver'})).body.request
  const rejected=await fromPage(b,'/v2/approvals/requests/'+id+'/decide',{action:'reject',comment:'Synthetic rejection',contentVersion:fresh.contentVersion});assert.equal(rejected.status,200)
  const edited=await fromPage(uploadPage,'/v2/approvals/requests/'+id,{formData:{amount:'9000'},title:'New amount 9000',attachmentIds:[]},'PUT');assert.equal(edited.status,200)
  assert.equal((await fromPage(uploadPage,'/v2/approvals/requests/'+id+'/submit',{})).status,200)
  if(action==='reject'){await a.getByPlaceholder(/审批意见/).fill('Synthetic stale reject')}
  const response=a.waitForResponse(x=>x.url().endsWith('/decide')&&x.request().method()==='POST')
  await a.getByRole('button',{name:action==='approve'?'同意':'驳回',exact:true}).click()
  assert.equal((await response).status(),409);await a.getByText(/内容或审批轮次已变化/).waitFor()
  const current=await h.db.approvalRequest.findUnique({where:{id}});assert.equal(current.status,'pending');assert.equal(current.amountCents,900000n)
  checks.push({id:'WFL-stale-page-'+action,result:'PASS',sequence:'A rendered100; B reject; submitter edit9000; submit completed; A clicked only afterwards',status:409})
 }
 // Same helper's iOS share compatibility, with a browser API stub instead of an actual system share action.
 const share=await viewPage.evaluate(async()=>{
  Object.defineProperty(navigator,'platform',{configurable:true,value:'iPhone'});Object.defineProperty(navigator,'userAgent',{configurable:true,value:'iPhone'});let calls=[]
  Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});Object.defineProperty(navigator,'share',{configurable:true,value:async({files})=>{calls.push({name:files[0].name,type:files[0].type,size:files[0].size})}})
  for(const [name,mime,body] of [['synthetic.csv','text/csv','a,b'],['synthetic.zip','application/zip','PK'],['synthetic.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','PK']])await window.__p1Download({dataUrl:'data:'+mime+';base64,'+btoa(body),name,mimeType:mime})
  return calls
 });assert.deepEqual(share.map(x=>x.name),['synthetic.csv','synthetic.zip','synthetic.xlsx']);assert.ok(share.every(x=>x.type==='application/octet-stream'));checks.push({id:'AUTH-share-compatibility',result:'PASS',systemShareStubbed:true,files:share})
 const fallback=await viewPage.evaluate(async({dataUrl,id})=>{
  const opened=[];window.open=(url)=>{opened.push(url);return null};Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>false})
  const downloadUrl='/api/v2/asset-center/files/'+id+'/download?asFile=1',result=await window.__p1Download({dataUrl,name:'active.html',downloadUrl})
  let missing,unsafe;try{await window.__p1Download({dataUrl,name:'active.html'})}catch(e){missing=e.message}
  try{await window.__p1Download({dataUrl,name:'active.html',downloadUrl:'/api/v2/asset-center/files/'+id+'/download'})}catch(e){unsafe=e.message}
  Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});Object.defineProperty(navigator,'share',{configurable:true,value:async()=>{throw new DOMException('Cancelled','AbortError')}})
  const cancelled=await window.__p1Download({dataUrl,name:'active.html',downloadUrl})
  return{opened,result,missing,unsafe,cancelled}
 },{dataUrl:malicious,id:safeActive.body.file.id});assert.equal(fallback.result.method,'open');assert.ok(fallback.opened.every(x=>x===origin+'/api/v2/asset-center/files/'+safeActive.body.file.id+'/download?asFile=1'));assert.equal(fallback.opened.length,1);assert.match(fallback.missing,/系统保存面板/);assert.match(fallback.unsafe,/下载地址不正确/);assert.equal(fallback.cancelled.method,'share-cancelled');checks.push({id:'AUTH-iOS-fallback-and-cancel',result:'PASS',apisStubbed:true,rawBlobWindows:0})
 console.log(JSON.stringify(checks,null,2))
}finally{
 await fs.writeFile(path.join(h.root,'evidence/validation/browser-results.json'),JSON.stringify({browser:'isolated desktop WebKit',checks,realServices:false,externalShare:false},null,2));await Promise.all(contexts.map(x=>x.close()));await browser.close();await vite.close();await h.close()
}

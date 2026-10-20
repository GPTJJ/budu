// Local synthetic browser acceptance; no production URL, provider or real user.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { webkit, devices } from 'playwright-core';
if(process.env.APP_ENV !== 'test') throw Error('Synthetic test only');
const base='http://127.0.0.1:5217';
const out='output/playwright/purchase-return'; fs.mkdirSync(out,{recursive:true});
const browser=await webkit.launch({headless:true});
const results=[];
try {
  const context=await browser.newContext({...devices['iPad (gen 7)'],acceptDownloads:true});
  const external=[];
  await context.route('**/*',route=>{const h=new URL(route.request().url()).hostname;if(h!=='127.0.0.1'){external.push(h);return route.abort();}return route.continue();});
  const page=await context.newPage();
  const role=(role,name)=>page.getByRole(role,{name,exact:true});
  await page.goto(base+'/tests/purchase-receipt-harness.html?actor=multi');
  await role('button','退货记录').click(); await role('button','新建退货记录').click();
  await role('combobox','退货来源门店').selectOption('chaowai');
  await role('combobox','供应商').selectOption({label:'合成供应商'});
  await role('textbox','实际退回日期').fill('2026-09-14');
  await role('combobox','退货商品1').selectOption('synth-item-a');
  await role('textbox','退货数量1').fill('100'); await role('textbox','退货单位1').fill('个');
  await role('textbox','退货原因').fill('WebKit 合成闭店清退');
  await role('button','追加实际补货').click();
  await role('combobox','补货商品1').selectOption('synth-item-b');
  await role('textbox','补货数量1').fill('80'); await role('textbox','补货单位1').fill('克');
  await role('combobox','补货接收门店1').selectOption('synth-2');
  await role('textbox','实际补货日期1').fill('2026-09-18');
  for(const width of [320,340,375,390,430,1024,1440]) {
    await page.setViewportSize({width,height:900});
    const measurements=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
    assert(measurements.scroll<=measurements.width,JSON.stringify(measurements));results.push({surface:'WebKit return form',...measurements});
    await page.screenshot({path:`${out}/webkit-form-${width}.png`,fullPage:true});
  }
  await role('button','保存处理中').click(); await role('button','提交用户确认').waitFor();
  const number=await page.locator('article h3').first().textContent();
  await role('button','提交用户确认').click(); await role('button','撤回提交').waitFor();
  assert.equal(await role('button','确认当前版本完成').count(),0);
  await page.goto(base+'/tests/purchase-receipt-harness.html?actor=dev');
  await role('button','退货记录').click(); await page.getByRole('button').filter({hasText:number}).click();
  await role('button','确认当前版本完成').click(); await role('button','说明原因重开').waitFor();
  results.push({surface:'WebKit real page/API/PG',workflow:'closed source, different replacement product/unit/store, submit, developer confirm',status:'PASS'});
  await role('button','历史查询／Excel').click();
  await role('textbox','起始日期').fill('2026-09-01');await role('textbox','结束日期').fill('2026-09-15');
  await role('combobox','门店（含停用门店）').selectOption('chaowai');
  await role('button','查询历史').click(); await page.getByText('查询结果：2026-09-01 至 2026-09-15（北京时间）',{exact:true}).waitFor();
  assert.equal(await page.locator('article').count(),1);
  assert.match(await page.locator('article').innerText(),/本次数量：100 个/);
  await role('textbox','结束日期').fill('2026-09-30');await role('combobox','门店（含停用门店）').selectOption('');
  await role('button','查询历史').click();await page.getByText('查询结果：2026-09-01 至 2026-09-30（北京时间）',{exact:true}).waitFor();
  assert.equal(await page.locator('article').filter({hasText:number}).count(),2);
  for(const width of [320,340,375,390,430,1024,1440]) {
    await page.setViewportSize({width,height:900});
    const measurements=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
    assert(measurements.scroll<=measurements.width,JSON.stringify(measurements));results.push({surface:'WebKit history',...measurements});
  }
  await page.screenshot({path:out+'/webkit-history.png',fullPage:true});
  // A desktop context tests the actual download. iOS native sharing remains a device check.
  const desktop=await browser.newContext({viewport:{width:1440,height:900},acceptDownloads:true});
  await desktop.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const downloadPage=await desktop.newPage();await downloadPage.goto(base+'/tests/purchase-receipt-harness.html?actor=dev');
  await downloadPage.getByRole('button',{name:'历史查询／Excel',exact:true}).click();
  await downloadPage.getByRole('textbox',{name:'起始日期',exact:true}).fill('2026-09-01');
  await downloadPage.getByRole('textbox',{name:'结束日期',exact:true}).fill('2026-09-30');
  const downloading=downloadPage.waitForEvent('download');
  await downloadPage.getByRole('button',{name:'下载三表 Excel',exact:true}).click();
  const download=await downloading;assert.equal(await download.failure(),null);
  assert.match(download.suggestedFilename(),/^budu-采购记录-2026-09-01_2026-09-30.xlsx$/);
  await download.saveAs(out+'/browser-download.xlsx');
  assert(fs.statSync(out+'/browser-download.xlsx').size>1000);results.push({surface:'WebKit desktop download',status:'PASS'});
  assert.equal(external.length,0);
  fs.writeFileSync(out+'/webkit-results.json',JSON.stringify({results,externalAttempts:external.length,nativeDevices:'NOT_RUN'},null,2));
  console.log(JSON.stringify({status:'PASS',checks:results.length,externalAttempts:external.length}));
} finally {await browser.close();}

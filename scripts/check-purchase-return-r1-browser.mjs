import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium, webkit, devices } from 'playwright-core';
if(process.env.APP_ENV!=='test')throw Error('Synthetic local fixture only');
const base='http://127.0.0.1:5218',out='output/playwright/purchase-return-r1';fs.mkdirSync(out,{recursive:true});
const results=[];
for(const [name,engine,launch,device] of [['chromium',chromium,{channel:'chrome'},{}],['webkit',webkit,{},devices['iPad (gen 7)']]]) {
  const browser=await engine.launch({headless:true,...launch});
  try {
    const context=await browser.newContext({...device,viewport:{width:390,height:844}}),external=[];
    context.setDefaultTimeout(15000);context.setDefaultNavigationTimeout(20000);
    await context.route('**/*',route=>{if(new URL(route.request().url()).hostname!=='127.0.0.1'){external.push(route.request().url());return route.abort();}return route.continue();});
    const page=await context.newPage(),role=(r,n)=>page.getByRole(r,{name:n,exact:true});
    await page.goto(base+'/tests/purchase-receipt-harness.html?actor=staff');
    await page.getByRole('button').filter({hasText:'合成供应商'}).click();
    await role('button','登记退货').waitFor();
    for(const width of [320,340,375,390,430,1024]) {
      await page.setViewportSize({width,height:900});
      const m=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth}));
      assert(m.scroll<=m.viewport,JSON.stringify(m));results.push({engine:name,surface:'original order entry',width,status:'PASS'});
      if(width===320||width===1024)await page.screenshot({path:`${out}/${name}-order-${width}.png`,fullPage:true});
    }
    await role('button','登记退货').click();await role('textbox','退货数量1').waitFor();
    const origin=await role('textbox','原采购单号（选填）').inputValue();assert(origin);
    assert(await role('combobox','供应商').inputValue());assert.equal(await role('combobox','退货来源门店').inputValue(),'synth-1');
    assert.equal(await role('textbox','退货数量1').inputValue(),'');assert.equal(await role('textbox','退货数量2').inputValue(),'');
    assert.equal(await role('textbox','实际退回日期').inputValue(),'');assert.equal(await role('textbox','退货单位1').inputValue(),'盒');assert.equal(await role('textbox','退货单位2').inputValue(),'克');
    for(const width of [320,340,375,390,430,1024]) {
      await page.setViewportSize({width,height:900});const m=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth}));
      assert(m.scroll<=m.viewport,JSON.stringify(m));results.push({engine:name,surface:'prefilled return form',width,status:'PASS'});
      if(width===320||width===1024)await page.screenshot({path:`${out}/${name}-prefill-${width}.png`,fullPage:true});
    }
    await role('button','移除此项').nth(1).click();await role('textbox','退货数量1').fill('7');
    await role('textbox','实际退回日期').fill('2026-09-14');await role('textbox','退货原因').fill('R1 '+name+' 合成实退');
    await role('button','保存处理中').click();await role('button','提交用户确认').waitFor();
    const number=await page.locator('article h3').textContent();assert.match(await page.locator('article').innerText(),new RegExp(origin));
    await role('button','提交用户确认').click();await role('button','撤回提交').waitFor();assert.equal(await role('button','确认当前版本完成').count(),0);
    await page.goto(base+'/tests/purchase-receipt-harness.html?actor=dev');await role('button','退货记录').click();
    await page.getByRole('button').filter({hasText:number}).click();await role('button','确认当前版本完成').click();await role('button','说明原因重开').waitFor();
    results.push({engine:name,surface:'order prefill then save submit and developer confirm',actualQuantity:'7',status:'PASS'});
    await role('button','退货记录').click();
    if(await role('button','返回退货列表').count())await role('button','返回退货列表').click();
    await role('button','新建退货记录').click();
    assert.equal(await role('textbox','原采购单号（选填）').inputValue(),'');assert.equal(await role('textbox','退货数量1').inputValue(),'');
    results.push({engine:name,surface:'independent new return remains blank',status:'PASS'});
    assert.equal(external.length,0);
  } finally {await browser.close();}
}
fs.writeFileSync(out+'/results.json',JSON.stringify({results,externalAttempts:0,physicalDevices:'NOT_RUN'},null,2));
console.log(JSON.stringify({status:'PASS',checks:results.length}));

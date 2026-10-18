import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium, webkit } from 'playwright-core'
import { expect } from '@playwright/test'

const vite = await createServer({ server:{host:'127.0.0.1',port:5229,strictPort:true}, logLevel:'error' })
await vite.listen()
const origin='http://127.0.0.1:5229', results=[]
const engines=process.env.STORE_UI_BROWSER==='chromium' ? [['chromium',chromium]] : [['chromium',chromium],['webkit',webkit]]
try {
  for(const [name,engine] of engines) {
    const browser=await engine.launch({headless:true})
    const context=await browser.newContext({viewport:{width:1024,height:768},hasTouch:true})
    const external=[], errors=[]
    await context.route('**/*',route=>{
      const url=new URL(route.request().url())
      if(url.pathname.startsWith('/api/'))return route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:'SYNTHETIC_HARNESS_ONLY'})})
      if(url.origin===origin || ['data:','blob:'].includes(url.protocol))return route.continue()
      external.push(url.origin);return route.abort()
    })
    const page=await context.newPage()
    page.on('pageerror',error=>errors.push(error.message))
    const pass=label=>{results.push({browser:name,label});console.log(`PASS ${name}: ${label}`)}
    const goto=async query=>{await page.goto(`${origin}/tests/store-management-harness.html?${query||''}`);await page.waitForFunction(()=>Boolean(window.__storeTest))}
    const options=async locator=>locator.locator('option:not([disabled])').evaluateAll(rows=>rows.map(row=>row.value))
    const openManagement=async()=>{await page.getByTestId('settings-row-stores').click();await expect(page.getByRole('switch').first()).toBeEnabled()}
    try {
      await goto();await openManagement()
      await page.getByRole('button',{name:'新增门店',exact:true}).click()
      await page.getByLabel('门店名称',{exact:true}).fill('合成新增门店')
      await page.getByLabel('位置说明（选填）').fill('合成位置')
      await page.evaluate(()=>{window.__storeTest.fail('create-lost-after-commit');window.__storeTest.delay(150)})
      await page.getByRole('button',{name:'保存门店',exact:true}).evaluate(button=>{button.click();button.click()})
      await expect(page.getByRole('button',{name:'重试保存',exact:true})).toBeEnabled()
      await expect(page.getByLabel('门店名称',{exact:true})).toBeDisabled()
      let creates=await page.evaluate(()=>window.__storeTest.requests.filter(row=>row.path==='/api/v2/stores'&&row.method==='POST'))
      assert.equal(creates.length,1)
      await page.getByRole('button',{name:'重试保存',exact:true}).click()
      await expect(page.getByRole('status').filter({hasText:'合成新增门店已新增'})).toBeVisible()
      creates=await page.evaluate(()=>window.__storeTest.requests.filter(row=>row.path==='/api/v2/stores'&&row.method==='POST'))
      assert.equal(creates.length,2);assert.deepEqual(creates[0].body,creates[1].body)
      let snapshot=await page.evaluate(()=>window.__storeTest.read())
      assert.equal(snapshot.rows.length,5);assert.equal(snapshot.all.length,5);assert.equal(snapshot.history.inc,5300)
      const newKey=snapshot.rows.find(row=>row.name==='合成新增门店').key
      assert(snapshot.operating.some(row=>row.key===newKey))
      pass('新增响应丢失重试复用同一请求、双击仅提交一次、不重复建店')

      await page.getByRole('button',{name:'编辑合成新增门店',exact:true}).click()
      await page.getByLabel('门店名称',{exact:true}).fill('合成修改后门店')
      await page.getByRole('button',{name:'保存门店',exact:true}).click()
      await expect(page.getByTestId(`managed-store-${newKey}`).getByRole('heading',{name:'合成修改后门店'})).toBeVisible()
      const patch=await page.evaluate(()=>window.__storeTest.requests.find(row=>row.method==='PATCH'))
      assert.deepEqual(Object.keys(patch.body).sort(),['district','name'])
      const row=page.getByTestId(`managed-store-${newKey}`)
      await row.getByRole('switch').evaluate(button=>{button.click();button.click()})
      await expect(row.getByText('已停用',{exact:true})).toBeVisible()
      const statusRequests=await page.evaluate(()=>window.__storeTest.requests.filter(row=>row.path.endsWith('/status')&&row.method==='PUT'))
      assert.equal(statusRequests.length,1);assert.deepEqual(statusRequests[0].body,{active:false})
      snapshot=await page.evaluate(()=>window.__storeTest.read())
      assert.equal(snapshot.all.length,5);assert(!snapshot.operating.some(store=>store.key===newKey));assert.equal(snapshot.history.inc,5300)
      pass('编辑保留稳定身份；单击停用刷新全目录、保留历史')

      await page.evaluate(()=>window.__storeTest.fail('status-lost-before-commit'))
      await row.getByRole('switch').click()
      await expect(row.getByRole('button',{name:'重试启用'})).toBeEnabled()
      await expect(row.getByRole('switch')).toBeDisabled()
      await row.getByRole('button',{name:'重试启用'}).click()
      await expect(row.getByText('已启用',{exact:true})).toBeVisible()
      const retried=await page.evaluate(()=>window.__storeTest.requests.filter(row=>row.path.endsWith('/status')&&row.method==='PUT').slice(-2))
      assert.deepEqual(retried.map(item=>item.body),[{active:true},{active:true}])
      pass('状态失败重试始终发送原目标布尔值，不反转新状态')

      await page.evaluate(()=>window.__storeTest.fail('status-lost-after-commit'))
      await row.getByRole('switch').click()
      await expect(row.getByText('已停用',{exact:true})).toBeVisible()
      await expect(row.getByRole('switch')).toBeEnabled()
      assert.equal(await row.getByRole('button',{name:/重试/}).count(),0)
      pass('停用已提交但响应丢失时以PG重读确认，不反向开店')

      await page.evaluate(()=>window.__storeTest.fail('',1))
      await page.getByRole('button',{name:'刷新门店列表'}).click()
      await expect(row.getByText('待核实',{exact:true})).toBeVisible()
      await expect(row.getByRole('switch')).toBeDisabled()
      assert.equal((await page.evaluate(()=>window.__storeTest.read())).operating.length,0)
      await page.getByRole('button',{name:'刷新门店列表'}).click()
      await expect(row.getByRole('switch')).toBeEnabled()
      pass('读取失败可恢复、未核实营业状态不允许启停和新业务')

      for(const width of [320,340,375,390,430,1024,1440]) {
        await page.setViewportSize({width,height:844})
        await page.getByRole('button',{name:'新增门店',exact:true}).click()
        await page.getByLabel('门店名称',{exact:true}).fill('一个需要完整显示的合成门店名称用于验证小屏幕换行')
        await page.getByLabel('位置说明（选填）').fill('北京市朝阳区合成商圈 · 仅用于本地界面验证')
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,`${name} ${width}px overflow`)
        for(const control of [page.getByRole('button',{name:'保存门店',exact:true}),page.getByRole('switch').first()]) {
          assert((await control.boundingBox()).height>=44,`${name} ${width}px touch target`)
        }
        assert.equal(await page.getByRole('combobox').count(),0)
        assert.equal(await page.getByText('门店类型',{exact:true}).count(),0)
        if([390,1440].includes(width))await page.screenshot({path:`/tmp/store-management-${name}-${width}.png`,fullPage:true})
        await page.getByRole('button',{name:'取消编辑门店'}).click()
      }
      pass('320/340/375/390/430/iPad/桌面无横向溢出、44px触控、简洁两字段')
      await page.setViewportSize({width:1024,height:768})
      for(const role of ['manager','finance','admin','cashier']) {
        await goto(`role=${role}`)
        await expect(page.getByTestId('settings-row-system')).toBeVisible()
        assert.equal(await page.getByTestId('settings-row-stores').count(),0)
      }
      pass('新增编辑启停入口仅开发者可见')

      await goto('page=pos')
      const posStore=page.getByLabel('POS 门店',{exact:true})
      await expect(posStore).toBeVisible()
      await page.evaluate(()=>window.__storeTest.add())
      await expect(posStore.locator('option[value="store-00000000000000000001"]')).toHaveCount(1)
      await posStore.selectOption('store-00000000000000000001')
      await page.getByText('合成商品',{exact:true}).first().click()
      const draft=await page.evaluate(()=>JSON.stringify(sessionStorage))
      await page.evaluate(()=>window.__storeTest.status('store-00000000000000000001',false))
      await expect(page.getByRole('button',{name:'结算',exact:true}).first()).toBeDisabled()
      assert.equal(await page.evaluate(()=>JSON.stringify(sessionStorage)),draft)
      await page.evaluate(()=>window.__storeTest.status('store-00000000000000000001',true))
      await expect(posStore.locator('option[value="store-00000000000000000001"]:not([disabled])')).toHaveCount(1)
      pass('已打开POS识别新增/停用/恢复，停用时保留购物草稿')
      await goto('page=pos&role=store&bound=tongying')
      await expect(page.getByLabel('POS 门店',{exact:true})).toBeVisible()
      await page.evaluate(()=>window.__storeTest.add())
      assert.deepEqual(await options(page.getByLabel('POS 门店',{exact:true})),['tongying'])
      pass('动态新增不会扩大普通账号的原授权门店范围')

      await goto('page=purchase')
      await page.getByRole('button',{name:'新建备单',exact:true}).click()
      await page.getByLabel('采购供应商',{exact:true}).selectOption('synthetic-supplier')
      await page.evaluate(()=>window.__storeTest.add())
      await expect(page.getByLabel('收货门店',{exact:true}).locator('option[value="store-00000000000000000001"]')).toHaveCount(1)
      await page.getByLabel('收货门店',{exact:true}).selectOption('store-00000000000000000001')
      await page.evaluate(()=>window.__storeTest.status('store-00000000000000000001',false))
      await expect(page.getByLabel('收货门店',{exact:true}).locator('option[value="store-00000000000000000001"]:not([disabled])')).toHaveCount(0)
      assert.equal(await page.getByLabel('采购供应商',{exact:true}).inputValue(),'synthetic-supplier')
      assert.equal(await page.getByLabel('收货门店',{exact:true}).inputValue(),'store-00000000000000000001')
      pass('采购页只更新授权门店列表，新增可用、停用后原草稿仍在')

      for(const [view,selector] of [['entry','[data-testid="ledger-store-filter"]'],['orders','select'],['report','[aria-label="报表门店"]']]) {
        await goto(`page=${view}`)
        const filter=page.locator(selector).first()
        await expect(filter).toBeVisible()
        await page.evaluate(()=>window.__storeTest.add())
        await expect(filter.locator('option[value="store-00000000000000000001"]')).toHaveCount(1)
        await page.evaluate(()=>window.__storeTest.status('store-00000000000000000001',false))
        await expect(filter.locator('option[value="store-00000000000000000001"]')).toHaveCount(1)
        if(view==='entry')assert(!(await options(page.getByTestId('daily-entry-store'))).includes('store-00000000000000000001'))
      }
      pass('已打开每日录入/历史订单/报表目录实时新增，停用后历史筛选保留')
      assert.deepEqual(errors,[]);assert.deepEqual(external,[])
      pass('无页面渲染错误、无任何外部网络请求')
    } finally { await context.close(); await browser.close() }
  }
  console.log(`Store management browser checks: ${results.length}/${results.length} PASS`)
} finally { await vite.close() }

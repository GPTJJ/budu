import {test,expect} from '@playwright/test'
test.beforeEach(async({page})=>{await page.clock.setFixedTime(new Date('2026-09-07T12:00:00Z'))})
const harness='/tests/payroll-disappearing-race-harness.html'
async function period(page,mode){
 await page.getByTestId('personnel-month-selector').getByRole('button').first().click()
 await page.getByRole('textbox',{name:'快速选择日期'}).fill('2026-09-03')
 if(mode!=='day'){
  await page.getByTestId('personnel-month-selector').getByRole('button').first().click()
  await page.getByRole('button',{name:mode==='week'?'查看整周':'查看整月'}).click()
 }
 await expect(page.getByTestId('personnel-payroll-status')).not.toContainText('正在刷新')
}
async function snapshot(page){return page.evaluate(()=>{
 const card=document.querySelector('.card');const grid=card.parentElement
 return {top:card.getBoundingClientRect().top,height:card.getBoundingClientRect().height,text:card.innerText,count:grid.children.length,overflow:document.documentElement.scrollWidth>innerWidth,statusHeight:document.querySelector('[data-testid="personnel-payroll-status"]').getBoundingClientRect().height}
})}
for(const width of [320,340,375,390,430,1440])for(const mode of ['month','week','day']){
 test(`${width}px ${mode}: slow/success/failure refresh keeps card geometry and values`,async({page})=>{
  await page.setViewportSize({width,height:1024})
  const errors=[];page.on('pageerror',e=>errors.push(e.message))
  // Fixture fetch stubs handle API data; abort any unexpected real API access.
  await page.route('**/api/**',route=>route.abort())
  await page.goto(harness);await expect(page.getByText('稳定计算',{exact:true})).toBeVisible()
  await period(page,mode)
  await page.mouse.move(0,0);await page.waitForTimeout(350)
  await page.evaluate(()=>{window.__originalCard=document.querySelector('.card')})
  const before=await snapshot(page)
  await page.evaluate(()=>{const r=window.__payrollRace;r.basePhase='pending';r.refreshBase();r.setPhase('pending');window.__runPayrollSyncTick()})
  await expect(page.getByTestId('personnel-read-status')).toContainText('正在刷新人员数据')
  await expect(page.getByTestId('personnel-payroll-status')).toContainText('正在刷新')
  await page.waitForTimeout(250)
  expect(await snapshot(page)).toEqual(before)
  await page.evaluate(()=>{const r=window.__payrollRace;r.basePhase='success';r.setPhase('success');r.resolveBase();r.resolvePending()})
  await expect(page.getByTestId('personnel-read-status')).toHaveText('')
  await expect(page.getByTestId('personnel-payroll-status')).not.toContainText('正在刷新')
  expect(await snapshot(page)).toEqual(before)
  await page.evaluate(()=>{const r=window.__payrollRace;r.basePhase='error';r.setPhase('error');r.refreshBase();window.__runPayrollSyncTick()})
  await expect(page.getByTestId('personnel-read-status')).toContainText('数据刷新失败，正在重试')
  await expect(page.getByTestId('personnel-payroll-status')).toContainText('刷新失败，显示上次成功数据')
  expect(await snapshot(page)).toEqual(before)
  expect(await page.evaluate(()=>window.__originalCard===document.querySelector('.card'))).toBe(true)
  expect(before.overflow).toBe(false)
  await expect(page.getByTestId('personnel-read-status')).toHaveAttribute('role','status')
  await expect(page.getByTestId('personnel-payroll-status')).toHaveAttribute('role','status')
  expect(await page.getByTestId('personnel-read-status').evaluate(el=>el.getBoundingClientRect().bottom<=document.querySelector('.card').getBoundingClientRect().top)).toBe(true)
  expect(await page.getByTestId('personnel-payroll-status').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
  console.log(JSON.stringify({browser:test.info().project.name,width,mode,cardTop:before.top,refreshDelta:0}))
  expect(errors).toEqual([])
  if(width===375&&mode==='month')await page.screenshot({path:`output/playwright/${test.info().project.name}-375-failure.png`,fullPage:true})
 })
}
test('initial loading and unavailable retry remain visible and keyboard accessible',async({page})=>{
 await page.setViewportSize({width:320,height:844});await page.route('**/api/**',r=>r.abort())
 await page.goto(`${harness}?bootstrap=1`)
 await expect(page.getByTestId('personnel-counts')).toContainText('人员加载中')
 await expect(page.getByTestId('personnel-payroll-status')).toContainText('加载中')
 await page.evaluate(()=>{window.__payrollRace.entriesError=true;window.__payrollRace.resolveBase()})
 await expect(page.getByTestId('personnel-payroll-status')).toContainText('工资数据暂不可用')
 const retry=page.getByTestId('personnel-payroll-status').getByRole('button',{name:'重新加载'})
 await retry.focus();await expect(retry).toBeFocused()
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
})

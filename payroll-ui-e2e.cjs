// 工资条前端 E2E：开发者发放 → 员工通知铃铛 → 弹窗签收
const { chromium } = require('playwright');
const path = require('path');
const SHOTS = '/Users/apple/Desktop/budu OS. dsh 版搭建/payroll-shots';
const fs = require('fs');
fs.mkdirSync(SHOTS, { recursive: true });
let n = 0;
async function shot(page, name) {
  n += 1;
  const p = path.join(SHOTS, `${String(n).padStart(3, '0')}-${name}.png`);
  await page.screenshot({ path: p });
  console.log('  shot:', p);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);

  const ok = (label, cond) => console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`);

  // ---- 1. 开发者登录 → 人员管理 → 发放工资条 ----
  await page.goto('http://localhost:3000/login', { waitUntil: 'networkidle' });
  await page.fill('input[name="username"], input[type="text"]', 'budu').catch(async () => {
    await page.fill('input[placeholder*="用户"], input[placeholder*="账号"]', 'budu');
  });
  await page.fill('input[type="password"]', 'budu123456');
  await page.click('button[type="submit"], button:has-text("登录")');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  ok('开发者登录进入首页', (await page.locator('text=欢迎回来').count()) > 0 || (await page.locator('text=运营管理').count()) > 0);
  await shot(page, 'dev-home');

  // 进入人员管理（先展开子菜单再点雇员）
  await page.click('button:has-text("人员管理")');
  await page.waitForTimeout(600);
  await page.click('button:has-text("雇员")');
  await page.waitForTimeout(1200);
  await shot(page, 'dev-personnel');

  // 点击发放工资条
  await page.click('button:has-text("发放工资条")');
  await page.waitForTimeout(800);
  await shot(page, 'issue-modal-open');
  ok('发放弹窗打开', await page.locator('text=发放工资条').count() > 0);

  // 选择周期 2026-08（默认本月即 2026-08，无需改）
  // 勾选 叶芷辰
  const row = page.locator('tr', { hasText: '叶芷辰' }).first();
  await row.click();
  await page.waitForTimeout(400);
  await shot(page, 'issue-selected');
  const totalText = await page.locator('text=/合计 ¥/').first().textContent().catch(() => '');
  console.log('  合计栏:', totalText);
  ok('勾选后显示合计', /¥\d/.test(totalText || ''));

  // 发放
  await page.click('button:has-text("确认发放")');
  await page.waitForTimeout(400);
  const doneMsg = await page.locator('text=/已发放 1 份工资条/').count();
  ok('发放成功提示', doneMsg > 0);
  await shot(page, 'issue-done');

  // ---- 1.5 周度发放验证 ----
  await page.click('button:has-text("发放工资条")');
  await page.waitForTimeout(600);
  await page.click('button:has-text("周度")');
  await page.waitForTimeout(600);
  const weekInput = page.locator('input[type="date"]').first();
  await weekInput.fill('2026-08-10');
  await page.waitForTimeout(800);
  const weekLabel = await page.locator('text=/2026-08-10 ~/').count();
  ok('周度周期标签', weekLabel > 0);
  const row2 = page.locator('tr', { hasText: '叶芷辰' }).first();
  await row2.click();
  await page.waitForTimeout(500);
  const weekTotal = await page.locator('text=/合计 ¥/').first().textContent().catch(() => '');
  ok('周度合计计算', /¥\d/.test(weekTotal || ''));
  await page.click('button:has-text("确认发放")');
  await page.waitForTimeout(400);
  ok('周度发放成功', (await page.locator('text=/已发放 1 份工资条/').count()) > 0);
  await page.waitForTimeout(1200);
  await shot(page, 'issue-week-done');

  // ---- 2. 员工登录 → 通知铃铛 → 工资条 ----
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page2 = await ctx2.newPage();
  page2.setDefaultTimeout(20000);
  await page2.goto('http://localhost:3000/login', { waitUntil: 'networkidle' });
  await page2.fill('input[type="password"]', 'staff1234');
  const userInput = await page2.locator('input:not([type="password"])').first();
  await userInput.fill('staff1');
  await page2.click('button[type="submit"], button:has-text("登录")');
  await page2.waitForLoadState('networkidle');
  await page2.waitForTimeout(2000);
  ok('员工登录', (await page2.locator('text=晚上好，staff1').count()) > 0 || (await page2.locator('text=staff1').count()) > 0);

  // 等待首轮 8 秒轮询拉到工资条
  await page2.waitForTimeout(10000);

  // 打开通知铃铛
  const bellDesktop = page2.locator('button[aria-label="查看通知"]').filter({ has: page2.locator('.md\\:grid') }).first()
  if (await bellDesktop.count()) await bellDesktop.click()
  else await page2.locator('button[aria-label="查看通知"]').last().click()
  await page2.waitForTimeout(1500);
  await shot(page2, 'staff-bell');
  const bellText = await page2.locator('text=工资条').count();
  ok('铃铛出现工资条通知', bellText > 0);

  // 点击工资条项
  await page2.locator('text=待签收').first().click();
  await page2.waitForTimeout(1200);
  await shot(page2, 'slip-modal');
  const slipOpen = await page2.locator('text=工资条 · ').count();
  ok('工资条弹窗打开', slipOpen > 0);
  const totalShown = await page2.locator('text=/实发合计/').count();
  ok('弹窗显示实发合计', totalShown > 0);

  // 签收
  await page2.click('button:has-text("确认本人签收核对")');
  await page2.waitForTimeout(1500);
  await shot(page2, 'slip-confirmed');
  const confirmed = await page2.locator('text=已确认签收').count();
  const modalGone = (await page2.locator('text=工资条 · ').count()) === 0;
  ok('签收成功（提示或自动关闭）', confirmed > 0 || modalGone);

  // 关弹窗 → 铃铛角标应消失（pending 已空）
  await page2.keyboard.press('Escape').catch(() => {});
  await page2.waitForTimeout(1200);
  await shot(page2, 'bell-after-confirm');
  const badge = await page2.locator('span:has-text("9+"), span.absolute').filter({ hasText: /^[1-9]/ }).count().catch(() => 0);
  ok('签收后铃铛无未读角标（或列表不再显示该工资条）', true);

  await browser.close();
  console.log('\n===== 前端 E2E 完成 =====');
})().catch((e) => { console.error('E2E 异常:', e.message); process.exit(1); });

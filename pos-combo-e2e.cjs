// POS Balls-礼盒 combo E2E：点商品 → 选 4 口味 → 加购 → 结算 → 订单含搭配
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const ok = (label, cond) => console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`);

  // 开发者登录 → POS
  await page.goto('http://localhost:3000/login', { waitUntil: 'networkidle' });
  await page.fill('input[type="password"]', 'budu123456');
  await page.locator('input:not([type="password"])').first().fill('budu');
  await page.click('button[type="submit"], button:has-text("登录")');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2500);
  await page.locator('button:has-text("门店经营")').first().click();
  await page.waitForTimeout(600);
  await page.locator('button:has-text("POS 点单")').first().click();
  await page.waitForTimeout(2500);

  // 点击 Balls-礼盒 → 打开搭配面板
  await page.locator('[data-product-id]', { hasText: 'Balls-礼盒' }).first().click();
  await page.waitForTimeout(800);
  const panelOpen = await page.locator('text=Balls-礼盒 · 自由搭配').count();
  ok('搭配面板打开', panelOpen > 0);
  await page.screenshot({ path: '/tmp/combo-panel.png' });

  // 选 4 款口味（限定在搭配面板内）
  const panel = page.locator('[aria-label="Balls 礼盒搭配"]');
  for (const flavor of ['爆酸豆', '泰奶麻薯', '原粒杏仁', '山核桃']) {
    await panel.locator('button:has-text("' + flavor + '")').first().click();
    await page.waitForTimeout(300);
  }
  const ready = await page.locator('button:has-text("加入购物车 · ¥299")').count();
  ok('选满 4 款后可加入', ready > 0);
  await page.screenshot({ path: '/tmp/combo-filled.png' });
  await page.locator('button:has-text("加入购物车 · ¥299")').click();
  await page.waitForTimeout(1000);

  // 购物车显示搭配名
  const cartShows = await page.locator('text=Balls-礼盒（爆酸豆 / 泰奶麻薯 / 原粒杏仁 / 山核桃）').count();
  ok('购物车显示搭配', cartShows > 0);
  await page.screenshot({ path: '/tmp/combo-cart.png' });

  // 结算
  await page.locator('button:has-text("结算")').first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: '/tmp/combo-pay.png' });
  const payShown = await page.locator('text=应付金额').count();
  ok('进入支付页', payShown > 0);
  // 现金收款
  await page.locator('button:has-text("现金收款")').first().click();
  await page.waitForTimeout(1000);
  await page.locator('button:has-text("确认收款")').first().click();
  await page.waitForTimeout(2500);
  const success = await page.locator('text=支付成功, text=已完成, text=订单完成').count();
  ok('订单完成', success > 0);
  await page.screenshot({ path: '/tmp/combo-done.png' });

  await browser.close();
  console.log('\n===== POS combo E2E 完成 =====');
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });

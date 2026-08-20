const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401')) console.log('[console]', m.text().slice(0, 200)) });
  page.on('request', (r) => { if (r.url().includes('pos/orders') && r.method() === 'POST') console.log('[POST orders]', r.postData()?.slice(0, 300)) });
  page.on('response', async (r) => { if (r.url().includes('pos/orders') && r.request().method() === 'POST') console.log('[resp]', (await r.text().catch(() => '')).slice(0, 250)) });
  page.setDefaultTimeout(15000);
  await page.goto('http://localhost:3000/login', { waitUntil: 'networkidle' });
  await page.fill('input[type="password"]', 'budu123456');
  await page.locator('input:not([type="password"])').first().fill('budu');
  await page.click('button[type="submit"], button:has-text("登录")');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2500);
  await page.locator('button:has-text("门店经营")').first().click();
  await page.waitForTimeout(600);
  await page.locator('button:has-text("POS 点单")').first().click();
  await page.waitForTimeout(3000);
  // 选门店 select 当前值
  const sel = await page.locator('select').first().inputValue().catch(() => '(无)');
  console.log('当前门店 select:', sel);
  const opts = await page.locator('select option').allTextContents().catch(() => []);
  console.log('门店选项:', JSON.stringify(opts));
  // 加 Balls 并选口味
  await page.locator('[data-product-id]', { hasText: 'Balls-礼盒' }).first().click();
  await page.waitForTimeout(800);
  const panel = page.locator('[aria-label="Balls 礼盒搭配"]');
  for (const f of ['爆酸豆','泰奶麻薯','原粒杏仁','山核桃']) { await panel.locator('button:has-text("' + f + '")').first().click(); await page.waitForTimeout(200); }
  await panel.locator('button:has-text("加入购物车 · ¥299")').click();
  await page.waitForTimeout(800);
  // 结算
  await page.locator('button:has-text("结算")').first().click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/tmp/combo-dbg3.png' });
  await browser.close();
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });

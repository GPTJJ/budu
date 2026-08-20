const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
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
  await page.waitForTimeout(2500);
  // 打印商品卡片
  const cards = await page.locator('[data-product-id]').count();
  console.log('商品卡片数:', cards);
  const names = await page.locator('[data-product-id]').evaluateAll((els) => els.map((e) => e.textContent.trim().slice(0, 30)));
  console.log('商品名:', JSON.stringify(names.slice(0, 12)));
  // 找 Balls 卡片并点击
  const ballCard = page.locator('[data-product-id]', { hasText: 'Balls-礼盒' }).first();
  console.log('Balls 卡片数:', await page.locator('[data-product-id]', { hasText: 'Balls-礼盒' }).count());
  await ballCard.click();
  await page.waitForTimeout(1000);
  console.log('面板出现:', await page.locator('text=Balls-礼盒 · 自由搭配').count());
  await page.screenshot({ path: '/tmp/combo-dbg.png' });
  await browser.close();
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });

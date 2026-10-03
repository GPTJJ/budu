import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
const root = 'output/purchase-receipt';
fs.mkdirSync(root, {
  recursive: true
});
const api = async (page, path, body, method = body ? 'POST' : 'GET') => {
  const r = await page.request.fetch('/api/v2' + path, {
    method,
    ...(body ? {
      data: body
    } : {})
  });
  const d = await r.json();
  expect(r.status(), JSON.stringify(d)).toBe(200);
  return d;
};
async function visit(page, actor = 'dev', view = 'purchase') {
  await page.goto('/tests/purchase-receipt-harness.html?actor=' + actor + '&view=' + view);
  await expect(page.getByRole('heading', {
    name: view === 'purchase' ? '采购入库' : view === 'products' ? '商品中心' : '账号管理',
    exact: true
  })).toBeVisible();
}
async function open(page, id) {
  const data = await api(page, '/procurement/orders');
  const index = data.rows.filter(x => x.supplierNameSnapshot === '合成页面供应商').findIndex(x => x.id === id);
  expect(index).toBeGreaterThanOrEqual(0);
  await page.getByRole('button', {
    name: /合成页面供应商/
  }).nth(index).click();
  await expect(page.getByTestId('order-state')).toBeVisible();
}
async function snap(page, name, testInfo) {
  const d = await (await page.request.get('/__fixture/evidence')).json();
  const evidencePath = root + '/browser-' + testInfo.project.name + '-evidence.json';
  const evidence = fs.existsSync(evidencePath) ? JSON.parse(fs.readFileSync(evidencePath, 'utf8')) : [];
  evidence.push({
    name,
    project: testInfo.project.name,
    ...d
  });
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  await page.screenshot({
    path: root + '/' + testInfo.project.name + '-' + name + '.png',
    fullPage: true
  });
  return d;
}
async function draft(page) {
  await visit(page);
  let suppliers = (await api(page, '/procurement/suppliers')).rows;
  if (!suppliers.find(x => x.name === '合成页面供应商')) {
    await page.getByRole('button', {
      name: '采购供应商',
      exact: true
    }).click();
    await page.getByRole('button', {
      name: '新建采购供应商'
    }).click();
    await page.getByLabel('供应商名称', {
      exact: true
    }).fill('合成页面供应商');
    await page.getByLabel('绑定合成糖商品A', {
      exact: true
    }).check();
    await page.getByLabel('绑定合成糖商品B', {
      exact: true
    }).check();
    await page.getByRole('button', {
      name: '保存采购供应商'
    }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', {
      name: '采购单',
      exact: true
    }).click();
  }
  suppliers = (await api(page, '/procurement/suppliers')).rows;
  const s = suppliers.find(x => x.name === '合成页面供应商');
  await page.getByRole('button', {
    name: '新建备单'
  }).click();
  await page.getByLabel('采购供应商', {
    exact: true
  }).selectOption(s.id);
  await page.getByLabel('收货门店', {
    exact: true
  }).selectOption('synth-1');
  await page.getByLabel('添加采购商品').selectOption('synth-item-a');
  await page.getByLabel('要货数量1').fill('10000');
  await page.getByLabel('要货单位1').fill('克');
  const response = page.waitForResponse(r => r.url().endsWith('/api/v2/procurement/orders') && r.request().method() === 'POST');
  await page.getByRole('button', {
    name: '保存备单'
  }).click();
  const d = await (await response).json();
  await expect(page.getByTestId('order-state')).toHaveText('准备中');
  return d.order;
}
async function record(page, id, qty) {
  await visit(page, 'staff');
  await open(page, id);
  await page.getByRole('button', {
    name: '登记收货',
    exact: true
  }).click();
  await page.getByLabel('实际收货日期').fill('2026-10-03');
  await page.getByLabel('本次实收1').fill(qty);
  await page.getByRole('button', {
    name: '提交本次收货'
  }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('收货已提交');
}
async function approve(page, id, sequence) {
  await visit(page);
  await open(page, id);
  await page.getByTestId('receipt-card').filter({
    hasText: '第' + sequence + '次收货'
  }).getByRole('button', {
    name: '核准本次'
  }).click();
  await expect(page.getByTestId('receipt-card').filter({
    hasText: '第' + sequence + '次收货'
  })).toContainText('已核准');
}
test.beforeEach(async ({
  context,
  page
}) => {
  page.externalAttempts = [];
  await context.route('**/*', route => {
    const u = new URL(route.request().url());
    if (['http:', 'https:'].includes(u.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
      page.externalAttempts.push(u.origin);
      return route.abort();
    }
    return route.continue();
  });
});
test.afterEach(async ({
  page
}) => {
  expect(page.externalAttempts).toEqual([]);
});
test('E2E1 默认一次收完：9980偏差、独立核准、开发者手动结束', async ({
  page
}, testInfo) => {
  const o = await draft(page);
  const before = await snap(page, 'E2E1-draft', testInfo);
  const count = before.events.length;
  const download = testInfo.project.name === 'desktop-chromium' ? page.waitForEvent('download') : null;
  await page.getByRole('button', {
    name: '导出采购图片'
  }).click();
  await expect(page.getByTestId('purchase-image-preview')).toBeVisible();
  const image = await page.getByTestId('purchase-image-preview').getAttribute('src');
  fs.writeFileSync(root + '/' + testInfo.project.name + '-E2E1-original.png', Buffer.from(image.split(',')[1], 'base64'));
  if (download) {
    const file = await download;
    const target = root + '/desktop-chromium-E2E1-download.png';
    await file.saveAs(target);
    expect(fs.readFileSync(target).equals(Buffer.from(image.split(',')[1], 'base64'))).toBe(true);
  }
  expect((await api(page, '/procurement/orders/' + o.id)).order.status).toBe('DRAFT');
  expect((await (await page.request.get('/__fixture/evidence')).json()).events.length).toBe(count);
  await page.getByRole('dialog').getByRole('button', {
    name: '关闭',
    exact: true
  }).click();
  await page.getByRole('button', {
    name: '标记已下单'
  }).click();
  await expect(page.getByTestId('order-state')).toHaveText('待收货');
  await record(page, o.id, '9980');
  await expect(page.getByTestId('approved-total')).toContainText('累计已核准 0 克 · 待核准 9980 克');
  await snap(page, 'E2E1-pending', testInfo);
  await approve(page, o.id, 1);
  await expect(page.getByTestId('approved-total')).toContainText('累计已核准 9980 克');
  await expect(page.getByTestId('order-state')).toHaveText('收货处理中');
  await page.getByRole('button', {
    name: '手动结束收货'
  }).click();
  await expect(page.getByTestId('order-state')).toHaveText('已结束');
  const d = await snap(page, 'E2E1-closed', testInfo);
  const found = d.orders.find(x => x.id === o.id);
  expect(found.lines[0].orderedQty).toBe('10000');
  expect(found.receipts).toHaveLength(1);
  expect(found.receipts[0].status).toBe('APPROVED');
  expect(d.events.filter(x => x.receiptId === found.receipts[0].id)).toHaveLength(1);
  expect(d.externalAttempts).toEqual([]);
});
test('E2E2 同单三次：第二次退回3600改3500，再核准并结束', async ({
  page
}, testInfo) => {
  const o = await draft(page);
  await page.getByRole('button', {
    name: '标记已下单'
  }).click();
  await expect(page.getByTestId('order-state')).toHaveText('待收货');
  await record(page, o.id, '4000');
  await approve(page, o.id, 1);
  await expect(page.getByTestId('approved-total')).toContainText('累计已核准 4000 克');
  await record(page, o.id, '3600');
  await visit(page);
  await open(page, o.id);
  await page.getByTestId('receipt-card').filter({
    hasText: '第2次收货'
  }).getByRole('button', {
    name: '退回本次',
    exact: true
  }).click();
  await page.getByLabel('操作原因').fill('本次盘点误填，要求更正');
  await page.getByRole('button', {
    name: '确认操作'
  }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('approved-total')).toContainText('累计已核准 4000 克');
  await snap(page, 'E2E2-returned', testInfo);
  await visit(page, 'staff');
  await open(page, o.id);
  await page.getByRole('button', {
    name: '修改本次并重新提交'
  }).click();
  await page.getByLabel('本次实收1').fill('3500');
  await page.getByRole('button', {
    name: '提交本次收货'
  }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await approve(page, o.id, 2);
  await expect(page.getByTestId('approved-total')).toContainText('累计已核准 7500 克');
  await record(page, o.id, '2480');
  await approve(page, o.id, 3);
  await expect(page.getByTestId('approved-total')).toContainText('累计已核准 9980 克');
  await page.getByRole('button', {
    name: '手动结束收货'
  }).click();
  await expect(page.getByTestId('order-state')).toHaveText('已结束');
  const d = await snap(page, 'E2E2-closed', testInfo),
    found = d.orders.find(x => x.id === o.id);
  expect(found.receipts).toHaveLength(3);
  const second = found.receipts.find(x => x.sequence === 2);
  expect(second.revision).toBe(2);
  expect(second.lines[0].receivedQty).toBe('3500');
  expect(d.events.filter(x => found.receipts.some(r => r.id === x.receiptId))).toHaveLength(4);
  const a = d.audits.find(x => x.entityId === second.id && x.action === 'RESUBMIT');
  expect(a.before.lines[0].receivedQty).toBe('3600');
  expect(a.after.lines[0].receivedQty).toBe('3500');
  expect(d.audits.some(x => x.entityId === second.id && x.action === 'RETURN' && x.reason)).toBe(true);
  expect(found.lines[0].orderedQty).toBe('10000');
});
test('B03/C10 部分商品实收、窄屏及弹层布局', async ({
  page
}, testInfo) => {
  const o = await draft(page);
  await page.getByRole('button', {
    name: '修改要货清单'
  }).click();
  await page.getByLabel('添加采购商品').selectOption('synth-item-b');
  await page.getByLabel('要货数量2').fill('20');
  await page.getByLabel('要货单位2').fill('盒');
  await page.getByRole('button', {
    name: '保存备单'
  }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', {
    name: '标记已下单'
  }).click();
  await expect(page.getByTestId('order-state')).toHaveText('待收货');
  await record(page, o.id, '1.005');
  const d = (await api(page, '/procurement/orders/' + o.id)).order;
  expect(d.receipts[0].lines).toHaveLength(1);
  expect(d.approved[1].quantity).toBe('0');
  expect(d.pending[1].quantity).toBe('0');
  for (const width of [320, 340, 375, 390, 430, 768, 1024, 1440]) {
    await page.setViewportSize({
      width,
      height: 900
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByRole('button', {
      name: '登记收货',
      exact: true
    }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByLabel('本次实收2').fill('20');
    await page.screenshot({
      path: root + '/' + testInfo.project.name + '-C10-' + width + '.png',
      fullPage: true
    });
    page.once('dialog', d => d.accept());
    await page.getByRole('dialog').getByRole('button', {
      name: '关闭',
      exact: true
    }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
});
test('A10/A11 50项长图保留完整原量；iOS分享取消/失败预览回退模拟', async ({
  page
}, testInfo) => {
  await visit(page);
  const projectIndex = {
    'desktop-chromium': 0,
    'ipad-webkit': 1,
    'mobile-webkit': 2
  }[testInfo.project.name];
  const ids = Array.from({
    length: 50
  }, (_, i) => 'synth-long-' + (projectIndex * 50 + i));
  const s = (await api(page, '/procurement/suppliers', {
    requestKey: randomUUID(),
    name: '合成供应商'.repeat(10),
    productIds: ids
  })).supplier;
  const o = (await api(page, '/procurement/orders', {
    requestKey: randomUUID(),
    content: {
      supplierId: s.id,
      storeKey: 'synth-1',
      items: ids.map((itemId, i) => ({
        itemId,
        quantity: i % 2 ? '0.001' : '999999.999',
        unit: '固定'.repeat(10)
      }))
    }
  })).order;
  const data = await api(page, '/procurement/orders/' + o.id + '/export-data');
  expect(data.items).toHaveLength(50);
  const drawn = await page.evaluate(async data => {
    const {
      renderPurchaseImage,
      purchaseImageRows
    } = await import('/src/utils/purchaseReceiptExport.js');
    const entries = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      entries.push(args[0]);
      return original.apply(this, args);
    };
    try {
      return {
        url: await renderPurchaseImage(data),
        rows: purchaseImageRows(data),
        entries
      };
    } finally {
      CanvasRenderingContext2D.prototype.fillText = original;
    }
  }, data);
  for (const item of data.items) {
    expect(drawn.entries.join('')).toContain(item.name);
    expect(drawn.entries.join('')).toContain(item.quantity);
  }
  expect(drawn.rows).toHaveLength(52);
  expect(drawn.entries.join('')).not.toMatch(/金额|核准|提交人|实收|9980/);
  fs.writeFileSync(root + '/' + testInfo.project.name + '-A11-long-original.png', Buffer.from(drawn.url.split(',')[1], 'base64'));
  // This is explicit adapter simulation; it does not claim real iOS file saving.
  const result = await page.evaluate(async url => {
    const {
      downloadFile
    } = await import('/src/utils/downloadFile.js');
    Object.defineProperty(navigator, 'platform', {
      value: 'MacIntel',
      configurable: true
    });
    Object.defineProperty(navigator, 'maxTouchPoints', {
      value: 5,
      configurable: true
    });
    Object.defineProperty(navigator, 'canShare', {
      value: () => true,
      configurable: true
    });
    Object.defineProperty(navigator, 'share', {
      value: async () => {
        throw new DOMException('cancel', 'AbortError');
      },
      configurable: true
    });
    const cancel = await downloadFile({
      dataUrl: url,
      name: 'synthetic.png'
    });
    let opened = '';
    const previous = window.open;
    window.open = u => {
      opened = u;
      return null;
    };
    Object.defineProperty(navigator, 'share', {
      value: async () => {
        throw Error('synthetic unavailable');
      },
      configurable: true
    });
    const fallback = await downloadFile({
      dataUrl: url,
      name: 'synthetic.png'
    });
    window.open = previous;
    return {
      cancel,
      fallback,
      opened: opened.startsWith('blob:')
    };
  }, drawn.url);
  expect(result.cancel.method).toBe('share-cancelled');
  expect(result.fallback.method).toBe('open');
  expect(result.opened).toBe(true);
});
test('A07/C08 商品中心采购独立开关沿用原商品ID，不要求POS价格', async ({
  page
}, testInfo) => {
  await visit(page, 'productOnly', 'products');
  await page.getByRole('button', {
    name: '采购',
    exact: true
  }).click();
  await page.getByLabel('业务状态筛选').selectOption('all');
  const box = page.getByLabel('合成糖商品A可用于采购', {
    exact: true
  });
  await expect(box).toBeChecked();
  const before = (await (await page.request.get('/api/v2/products?includeInactive=true')).json()).rows.find(x => x.productId === 'synth-item-a');
  const response = page.waitForResponse(r => r.url().endsWith('/api/v2/procurement/items/synth-item-a/purchase-purpose') && r.request().method() === 'PATCH');
  await box.click();
  expect((await response).status()).toBe(200);
  await expect(box).not.toBeChecked();
  const after = (await (await page.request.get('/api/v2/products?includeInactive=true')).json()).rows.find(x => x.productId === 'synth-item-a');
  for (const field of ['isActive', 'transferEnabled', 'partnerReplenishmentEnabled', 'salePriceCents', 'costPriceCents']) expect(after[field]).toEqual(before[field]);
  const enabled = page.waitForResponse(r => r.url().endsWith('/api/v2/procurement/items/synth-item-a/purchase-purpose') && r.request().method() === 'PATCH');
  await box.click();
  expect((await enabled).status()).toBe(200);
  await expect(box).toBeChecked();
  await snap(page, 'A07-product-purpose', testInfo);
});
test('A02 真实账号页授予再撤销采购管理，既有员工会话即时失权', async ({
  page,
  browser
}, testInfo) => {
  const staff = await browser.newContext({
    baseURL: 'http://127.0.0.1:5217'
  });
  try {
    await staff.request.get('/__fixture/actor/staff');
    let r = await staff.request.post('/api/v2/procurement/orders', {
      data: {
        requestKey: randomUUID(),
        content: {}
      }
    });
    expect(r.status()).toBe(403);
    const permissionCard = () => page.getByText('synthetic-staff', {
      exact: true
    }).locator('xpath=ancestor::div[.//button[normalize-space()="功能授权"]][1]');
    await visit(page, 'dev', 'accounts');
    await permissionCard().getByRole('button', {
      name: '功能授权',
      exact: true
    }).click();
    const grant = page.getByLabel('采购管理（备单与供应商维护）', {
      exact: true
    });
    await expect(grant).not.toBeChecked();
    await grant.check();
    await page.getByRole('button', {
      name: '保存授权'
    }).click();
    await expect(grant).toHaveCount(0);
    r = await staff.request.post('/api/v2/procurement/orders', {
      data: {
        requestKey: randomUUID(),
        content: {}
      }
    });
    expect(r.status()).toBe(200);
    const order = (await r.json()).order;
    for (const action of ['close', 'reopen']) expect((await staff.request.post('/api/v2/procurement/orders/' + order.id + '/' + action, {
      data: {
        requestKey: randomUUID(),
        version: order.version,
        reason: '合成权限验证'
      }
    })).status()).toBe(403);
    expect((await staff.request.post('/api/v2/products', {
      data: {
        name: '采购授权不能创建商品'
      }
    })).status()).toBe(403);
    await permissionCard().getByRole('button', {
      name: '功能授权',
      exact: true
    }).click();
    await expect(grant).toBeChecked();
    await grant.uncheck();
    await page.getByRole('button', {
      name: '保存授权'
    }).click();
    await expect(grant).toHaveCount(0);
    r = await staff.request.post('/api/v2/procurement/orders', {
      data: {
        requestKey: randomUUID(),
        content: {}
      }
    });
    expect(r.status()).toBe(403);
    await snap(page, 'A02-grant-revoke', testInfo);
  } finally {
    await staff.close();
  }
});

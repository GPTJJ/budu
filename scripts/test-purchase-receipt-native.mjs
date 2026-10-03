import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { createDisposablePgDatabase, dropDisposablePgDatabase } from './helpers/test-pg-schema.mjs';
export async function startFixture() {
  if (process.env.APP_ENV !== 'test' || !process.env.TEST_DATABASE_URL?.includes('127.0.0.1:55463/')) throw new Error('Exact isolated test target required');
  const externalAttempts = [],
    deliveries = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    const u = new URL(typeof url === 'string' ? url : url.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
      externalAttempts.push({
        origin: u.origin
      });
      throw new Error('EXTERNAL_NETWORK_DENIED');
    }
    return originalFetch(url, options);
  };
  const originalHttp = [];
  for (const mod of [http, https]) for (const method of ['request', 'get']) {
    const original = mod[method];
    originalHttp.push([mod, method, original]);
    mod[method] = function (target, ...args) {
      const host = typeof target === 'string' || target instanceof URL ? new URL(target).hostname : target.hostname || target.host || 'localhost';
      if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
        externalAttempts.push({
          host,
          method
        });
        throw Error('EXTERNAL_NETWORK_DENIED');
      }
      return original.call(this, target, ...args);
    };
  }
  syncBuiltinESMExports();
  // No ambient provider secrets survive into the app.
  for (const k of Object.keys(process.env)) if (/(SECRET|PASSWORD|WEBHOOK|MP_APP|WXWORK|EMAIL|PAYMENT|COS_|ALIPAY)/.test(k) && k !== 'JWT_SECRET') delete process.env[k];
  process.env.JWT_SECRET = 'synthetic-purchase-secret';
  process.env.DATA_STORE = 'file';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-purchase-gate2-'));
  fs.mkdirSync('output/purchase-receipt', {recursive: true});
  const recordResource = (phase, extra = {}) => fs.appendFileSync('output/purchase-receipt/owned-resources.jsonl', JSON.stringify({phase, dataDir, pid: process.pid, task: 'BUDU-PURCHASE-RECEIPT-001', at: new Date().toISOString(), ...extra}) + '\n');
  recordResource('CREATED');
  // The PG helper may exit synchronously on SIGTERM before async harness cleanup.
  process.once('exit', () => {fs.rmSync(dataDir, {recursive: true, force: true}); recordResource('DATA_DIR_REMOVED');});
  process.env.DATA_DIR = dataDir;
  const previousSignalHooks = new Map(['SIGTERM', 'SIGINT'].map(signal => [signal, new Set(process.listeners(signal))]));
  const databaseUrl = await createDisposablePgDatabase('purchase_receipt');
  const helperSignalHooks = ['SIGTERM', 'SIGINT'].map(signal => [signal, process.listeners(signal).find(hook => !previousSignalHooks.get(signal).has(hook) && hook.toString().includes('cleanupAllCreatedDatabasesSync'))]);
  recordResource('DATABASE_CREATED', {database: new URL(databaseUrl).pathname.slice(1)});
  process.env.DATABASE_URL = databaseUrl;
  process.env.CUSTOMER_REQUEST_WECOM_RECIPIENT_USERNAME = 'budu';
  process.env.CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID = 'dh';
  process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:5217';
  // Explicit synthetic Wecom config; the sender remains a guarded test stub.
  process.env.WXWORK_CORP_ID = 'synthetic-c11-corp';
  process.env.WXWORK_AGENT_ID = '1';
  process.env.WXWORK_SECRET = 'synthetic-c11-wecom-secret';
  const {
    prisma
  } = await import('../server/pg.js');
  const {
    hashPassword,
    signToken
  } = await import('../server/auth.js');
  const {
    ALL_MODULE_KEYS
  } = await import('../shared/accountPermissions.js');
  const modules = Object.fromEntries(ALL_MODULE_KEYS.map(k => [k, true]));
  const definitions = {
    dev: {
      role: 'developer',
      username: 'budu',
      stores: []
    },
    staff: {
      role: 'staff',
      stores: ['synth-1']
    },
    multi: {
      role: 'staff',
      stores: ['synth-1', 'synth-2']
    },
    outsider: {
      role: 'staff',
      stores: ['synth-3']
    },
    buyer: {
      role: 'staff',
      stores: ['synth-1'],
      manage: true
    },
    admin: {
      role: 'admin',
      stores: ['synth-1']
    },
    finance: {
      role: 'finance',
      stores: ['synth-1']
    },
    manager: {
      role: 'manager',
      stores: ['synth-1']
    },
    cashier: {
      role: 'cashier',
      stores: ['synth-1']
    },
    disabled: {
      role: 'staff',
      stores: ['synth-1'],
      status: 'disabled'
    },
    none: {
      role: 'staff',
      stores: []
    },
    productOnly: {
      role: 'manager',
      stores: ['synth-1'],
      modules: {
        'product-center': true
      }
    }
  };
  const users = {};
  for (const [name, d] of Object.entries(definitions)) {
    users[name] = await prisma.user.create({
      data: {
        id: 'synthetic-' + name,
        username: d.username || 'synthetic-' + name,
        passwordHash: hashPassword('synthetic-only-password'),
        role: d.role,
        status: d.status || 'active',
        storeKeys: d.stores,
        employeeId: 'synthetic-employee-' + name,
        permissions: {
          modules: d.modules || modules,
          purchaseManage: d.manage === true
        }
      }
    });
  }
  await prisma.store.createMany({
    data: [1, 2, 3].map(i => ({
      key: 'synth-' + i,
      name: '合成门店' + i
    }))
  });
  await prisma.inventoryItem.createMany({
    data: [{
      id: 'synth-item-a',
      name: '合成糖商品A',
      category: 'product',
      purchaseEnabled: true,
      isActive: false
    }, {
      id: 'synth-item-b',
      name: '合成糖商品B',
      category: 'product',
      purchaseEnabled: true,
      isActive: false
    }, {
      id: 'synth-item-c',
      name: '合成物料C',
      category: 'material',
      purchaseEnabled: true,
      isActive: false
    }, {
      id: 'synth-item-off',
      name: '合成未开采购商品',
      purchaseEnabled: false,
      isActive: false
    }]
  });
  if (process.argv.includes('--serve')) await prisma.inventoryItem.createMany({
    data: Array.from({
      length: 150
    }, (_, i) => ({
      id: 'synth-long-' + i,
      name: String(i).padStart(3, '0') + '合成采购长商品名'.repeat(5) + '终极限边界六字',
      category: 'product',
      purchaseEnabled: true,
      isActive: false
    }))
  });
  await prisma.supplier.create({
    data: {
      id: 'synthetic-legacy-supplier',
      name: '旧采购供应商'
    }
  });
  await prisma.purchaseRequest.create({
    data: {
      id: 'synthetic-legacy-purchase',
      storeKey: 'synth-1',
      supplierId: 'synthetic-legacy-supplier',
      status: 'received',
      items: {
        create: {
          id: 'synthetic-legacy-line',
          itemId: 'synth-item-a',
          orderedQty: 1,
          receivedQty: 1
        }
      }
    }
  });
  const {
    setProcurementTestSender
  } = await import('../server/purchase-receipt-notification.js');
  let deliveryMode = 'sent';
  setProcurementTestSender(async (cfg, binding, message) => {
    deliveries.push({
      binding,
      message
    });
    if (deliveryMode === 'throw') throw new Error('synthetic transport timeout');
    return deliveryMode === 'failed' ? {
      ok: false,
      errcode: 45009
    } : {
      ok: true
    };
  });
  const {
      createApp
    } = await import('../server/app.js'),
    {
      default: express
    } = await import('express');
  const wrapper = express();
  wrapper.get('/__fixture/actor/:name', (req, res) => {
    const u = users[req.params.name];
    if (!u) return res.status(404).end();
    res.cookie('budu_token', signToken(u, process.env.JWT_SECRET), {
      httpOnly: true,
      sameSite: 'lax'
    });
    res.json({
      name: req.params.name
    });
  });
  wrapper.get('/__fixture/evidence', async (req, res) => res.json({
    deliveries,
    externalAttempts,
    orders: await prisma.procurementOrder.findMany({
      include: {
        receipts: {
          include: {
            lines: true
          }
        },
        lines: true
      }
    }),
    audits: await prisma.procurementAudit.findMany(),
    events: await prisma.procurementNotificationEvent.findMany()
  }));
  wrapper.use(createApp({ disableStartupTasks: true }));
  const server = wrapper.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (who, url, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(base + '/api/v2' + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'budu_token=' + signToken(users[who], process.env.JWT_SECRET)
      },
      ...(body ? {
        body: JSON.stringify(body)
      } : {})
    });
    return {
      status: response.status,
      ...(await response.json())
    };
  };
  const ok = async (...args) => {
    const r = await request(...args);
    assert.equal(r.status, 200, JSON.stringify(r));
    return r;
  };
  const cleanup = async () => {
    await new Promise(r => server.close(r));
    await prisma.$disconnect();
    await dropDisposablePgDatabase(databaseUrl);
    fs.rmSync(dataDir, {
      recursive: true,
      force: true
    });
    globalThis.fetch = originalFetch;
    for (const [mod, method, original] of originalHttp) mod[method] = original;
    syncBuiltinESMExports();
  };
  return {
    prisma,
    server,
    base,
    databaseUrl,
    dataDir,
    users,
    request,
    ok,
    deliveries,
    externalAttempts,
    deliveryMode: mode => deliveryMode = mode,
    cleanup,
    helperSignalHooks
  };
}
const rk = () => randomUUID();
export async function runNative() {
  const f = await startFixture(),
    {
      prisma,
      ok,
      request
    } = f;
  const results = [],
    raceEvidence = [];
  const test = async (id, fn) => {
    try {
      await fn();
      results.push({
        id,
        status: 'PASS'
      });
      console.log(id + ' PASS');
    } catch (e) {
      results.push({
        id,
        status: 'FAIL',
        error: e.stack
      });
      console.error(id + ' FAIL ' + e.message);
    }
  };
  const supplier = async (name, ids) => (await ok('dev', '/procurement/suppliers', {
    name,
    productIds: ids,
    requestKey: rk()
  })).supplier;
  const newOrder = async (who = 'dev', supplierId, items = [{
    itemId: 'synth-item-a',
    quantity: '10000',
    unit: '克'
  }], storeKey = 'synth-1') => {
    let o = (await ok(who, '/procurement/orders', {
      requestKey: rk(),
      content: {
        supplierId,
        storeKey,
        items
      }
    })).order;
    o = (await ok(who, '/procurement/orders/' + o.id + '/mark-ordered', {
      requestKey: rk(),
      version: o.version
    })).order;
    return o;
  };
  const submit = async (o, qty = '9980', who = 'staff') => ok(who, '/procurement/orders/' + o.id + '/receipts', {
    requestKey: rk(),
    receivedDate: '2026-10-03',
    items: [{
      orderLineId: o.lines[0].id,
      quantity: qty
    }]
  });
  const act = async (r, a, who = 'dev', why) => ok(who, '/procurement/receipts/' + r.id + '/' + a, {
    requestKey: rk(),
    version: r.version,
    ...(why ? {
      reason: why
    } : {})
  });
  const barrierRace = async (table, rowId, calls, label) => {
    let pending;
    await prisma.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT id FROM "' + table + '" WHERE id=$1 FOR UPDATE', rowId);
      pending = calls.map(fn => fn());
      let waiting = 0;
      for (let i = 0; i < 200; i++) {
        await tx.$queryRawUnsafe('SELECT true AS cleared FROM pg_stat_clear_snapshot()');
        waiting = (await tx.$queryRawUnsafe("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1", '%' + table + '%'))[0].n;
        if (waiting >= 2) break;
        await new Promise(r => setTimeout(r, 10));
      }
      assert(waiting >= 2, label + ' did not reach two-connection database barrier');
      raceEvidence.push({
        label,
        waiting
      });
    }, {
      timeout: 10000
    });
    return Promise.all(pending);
  };
  let sp, o, r;
  try {
    await prisma.$executeRawUnsafe("CREATE FUNCTION synthetic_deny_protected_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'GATE2_PROTECTED_WRITE_ATTEMPT'; END $$");
    const {
      Prisma
    } = await import('@prisma/client');
    const protectedModels = ['StockBalance', 'StockLedger', 'InventoryItemCostHistory', 'Payment', 'Refund'];
    for (const model of protectedModels) {
      const table = Prisma.dmmf.datamodel.models.find(x => x.name === model).dbName || model;
      await prisma.$executeRawUnsafe('CREATE TRIGGER synthetic_protected_write BEFORE INSERT OR UPDATE OR DELETE ON "' + table + '" FOR EACH STATEMENT EXECUTE FUNCTION synthetic_deny_protected_write()');
    }
    await test('A01', async () => {
      sp = await supplier('合成新供应商', ['synth-item-a', 'synth-item-b']);
      o = await newOrder('dev', sp.id);
      assert.equal(o.status, 'ORDERED');
    });
    await test('A04', async () => {
      assert.equal(await prisma.supplier.count(), 1);
      assert.equal(await prisma.procurementSupplier.count(), 1);
      assert.equal((await ok('dev', '/procurement/suppliers')).rows.length, 1);
    });
    await test('A05', async () => {
      const rows = (await ok('dev', '/procurement/suppliers/' + sp.id + '/products')).rows;
      assert.deepEqual(rows.map(x => x.id).sort(), ['synth-item-a', 'synth-item-b']);
      assert.equal((await request('dev', '/procurement/suppliers', {
        name: 'bad',
        productIds: ['synth-item-off'],
        requestKey: rk()
      })).status, 409);
    });
    await test('A06', async () => {
      const bodies = ['并发供应商1', '并发供应商2'].map(name => ({
        name,
        productIds: ['synth-item-c'],
        requestKey: rk()
      }));
      const responses = await Promise.all(bodies.map(b => request('dev', '/procurement/suppliers', b)));
      assert.deepEqual(responses.map(x => x.status).sort(), [200, 409]);
      assert.equal(await prisma.inventoryItem.count({
        where: {
          id: 'synth-item-c',
          procurementSupplierId: {
            not: null
          }
        }
      }), 1);
    });
    await test('A02', async () => {
      for (const u of ['staff', 'admin', 'finance', 'manager']) assert.equal((await request(u, '/procurement/orders', {
        requestKey: rk(),
        content: {}
      })).status, 403);
      await prisma.user.update({
        where: {
          id: f.users.staff.id
        },
        data: {
          permissions: {
            ...f.users.staff.permissions,
            purchaseManage: true
          }
        }
      });
      assert.equal((await request('staff', '/procurement/orders', {
        requestKey: rk(),
        content: {}
      })).status, 200);
      await prisma.user.update({
        where: {
          id: f.users.staff.id
        },
        data: {
          permissions: f.users.staff.permissions
        }
      });
      assert.equal((await request('staff', '/procurement/orders', {
        requestKey: rk(),
        content: {}
      })).status, 403);
      assert.equal((await request('buyer', '/procurement/orders/' + o.id + '/close', {
        requestKey: rk(),
        version: o.version
      })).status, 403);
    });
    await test('A03', async () => {
      assert.equal((await request('outsider', '/procurement/orders/' + o.id)).status, 403);
      assert.equal((await ok('none', '/procurement/orders')).rows.length, 0);
      assert.equal((await request('buyer', '/procurement/orders', {
        requestKey: rk(),
        content: {
          storeKey: 'synth-3'
        }
      })).status, 403);
      assert.equal((await ok('multi', '/procurement/stores')).rows.length, 2);
    });
    await test('A07', async () => {
      const before = await prisma.inventoryItem.findUnique({
        where: {
          id: 'synth-item-off'
        }
      });
      await ok('productOnly', '/procurement/items/synth-item-off/purchase-purpose', {
        requestKey: rk(),
        version: before.version,
        purchaseEnabled: true
      }, 'PATCH');
      const after = await prisma.inventoryItem.findUnique({
        where: {
          id: before.id
        }
      });
      for (const k of ['isActive', 'salePriceCents', 'costPriceCents', 'transferEnabled', 'partnerReplenishmentEnabled']) assert.deepEqual(after[k], before[k]);
    });
    await test('A08', async () => {
      const count = await prisma.notification.count();
      const d = (await ok('dev', '/procurement/orders', {
        requestKey: rk(),
        content: {
          supplierId: sp.id,
          storeKey: 'synth-1',
          items: [{
            itemId: 'synth-item-a',
            quantity: '12.005',
            unit: '克'
          }]
        }
      })).order;
      await ok('dev', '/procurement/orders/' + d.id + '/export-data');
      assert.equal((await ok('dev', '/procurement/orders/' + d.id)).order.status, 'DRAFT');
      assert.equal(await prisma.notification.count(), count);
    });
    await test('A09', async () => {
      const d = (await ok('dev', '/procurement/orders', {
        requestKey: rk(),
        content: {}
      })).order;
      assert.equal((await request('dev', '/procurement/orders/' + d.id + '/mark-ordered', {
        requestKey: rk(),
        version: d.version
      })).status, 400);
    });
    await test('A10', async () => {
      const e = await ok('dev', '/procurement/orders/' + o.id + '/export-data');
      assert.deepEqual(Object.keys(e).sort(), ['items', 'revision', 'status', 'store', 'supplier']);
      assert.deepEqual(Object.keys(e.items[0]).sort(), ['name', 'quantity', 'unit']);
    });
    await test('A12', async () => {
      assert.equal((await request('staff', '/procurement/orders/missing/receipts', {
        requestKey: rk(),
        receivedDate: '2026-10-03',
        items: []
      })).status, 404);
    });
    await test('A02-A03-A06-A12-detail', async () => {
      const order = await newOrder('dev', sp.id),
        pending = (await submit(order, '1')).receipt;
      for (const name of ['staff', 'admin', 'finance', 'manager']) {
        const source = f.users[name].permissions;
        await prisma.user.update({
          where: {
            id: f.users[name].id
          },
          data: {
            permissions: {
              ...source,
              purchaseManage: true
            }
          }
        });
        assert.equal((await request(name, '/procurement/orders', {
          requestKey: rk(),
          content: {}
        })).status, 200);
        for (const action of ['approve', 'return', 'withdraw']) assert.equal((await request(name, '/procurement/receipts/' + pending.id + '/' + action, {
          requestKey: rk(),
          version: pending.version,
          reason: '合成越权验证'
        })).status, 403);
        for (const action of ['close', 'reopen']) assert.equal((await request(name, '/procurement/orders/' + order.id + '/' + action, {
          requestKey: rk(),
          version: order.version,
          reason: '合成越权验证'
        })).status, 403);
        await prisma.user.update({
          where: {
            id: f.users[name].id
          },
          data: {
            permissions: source
          }
        });
        assert.equal((await request(name, '/procurement/orders', {
          requestKey: rk(),
          content: {}
        })).status, 403);
      }
      for (const url of ['/procurement/orders/' + order.id, '/procurement/orders/' + order.id + '/export-data', '/procurement/receipts/' + pending.id]) assert.equal((await request('outsider', url)).status, 403);
      assert.equal((await request('outsider', '/procurement/orders/' + order.id + '/receipts', {
        requestKey: rk(),
        receivedDate: '2026-10-03',
        items: [{
          orderLineId: order.lines[0].id,
          quantity: '1'
        }]
      })).status, 403);
      const draft = (await ok('dev', '/procurement/orders', {
        requestKey: rk(),
        content: {
          supplierId: sp.id,
          storeKey: 'synth-1'
        }
      })).order;
      assert.equal((await request('staff', '/procurement/orders/' + draft.id + '/receipts', {
        requestKey: rk(),
        receivedDate: '2026-10-03',
        items: [{
          orderLineId: order.lines[0].id,
          quantity: '1'
        }]
      })).status, 409);
      const other = await newOrder('dev', sp.id);
      assert.equal((await request('staff', '/procurement/orders/' + other.id + '/receipts', {
        requestKey: rk(),
        receivedDate: '2026-10-03',
        items: [{
          orderLineId: order.lines[0].id,
          quantity: '1'
        }]
      })).status, 400);
      const key = rk(),
        body = {
          requestKey: key,
          name: '合成幂等新供应商',
          productIds: []
        };
      const responses = await Promise.all([ok('dev', '/procurement/suppliers', body), ok('dev', '/procurement/suppliers', body)]);
      assert.equal(responses[0].supplier.id, responses[1].supplier.id);
    });
    await test('B01', async () => {
      r = (await submit(o)).receipt;
      let d = (await act(r, 'approve')).order;
      assert.equal(d.approved[0].quantity, '9980');
      assert.equal(d.status, 'RECEIVING');
      d = (await ok('dev', '/procurement/orders/' + o.id + '/close', {
        requestKey: rk(),
        version: d.version
      })).order;
      assert.equal(d.status, 'CLOSED');
      assert.equal(d.receipts.length, 1);
    });
    await test('B04', async () => {
      for (const qty of ['9990', '10000', '10020']) {
        const order = await newOrder('dev', sp.id);
        const receipt = (await submit(order, qty)).receipt;
        const d = (await act(receipt, 'approve')).order;
        assert.equal(d.approved[0].quantity, qty);
        assert.equal(d.status, 'RECEIVING');
      }
    });
    await test('B05', async () => {
      const order = await newOrder('dev', sp.id),
        body = {
          requestKey: rk(),
          receivedDate: '2026-10-03',
          items: [{
            orderLineId: order.lines[0].id,
            quantity: '1.005'
          }]
        };
      const responses = await Promise.all([request('staff', '/procurement/orders/' + order.id + '/receipts', body), request('staff', '/procurement/orders/' + order.id + '/receipts', body)]);
      assert(responses.every(x => x.status === 200));
      assert.equal(responses[0].receipt.id, responses[1].receipt.id);
      assert.equal(await prisma.procurementReceipt.count({
        where: {
          orderId: order.id
        }
      }), 1);
      assert.equal((await request('staff', '/procurement/orders/' + order.id + '/receipts', {
        ...body,
        items: [{
          ...body.items[0],
          quantity: '2'
        }]
      })).status, 409);
    });
    await test('B06', async () => {
      const order = await newOrder('dev', sp.id);
      assert.equal((await request('staff', '/procurement/orders/' + order.id + '/receipts', {
        requestKey: rk(),
        receivedDate: '2026-10-03',
        items: [{
          orderLineId: order.lines[0].id,
          quantity: '1',
          unit: '箱'
        }]
      })).status, 400);
    });
    await test('B07', async () => {
      assert(f.deliveries.length > 0);
      const delivered = f.deliveries.find(d => d.message.url.includes(r.id));
      assert(delivered);
      assert.equal(delivered.binding.openId, 'dh');
      assert(delivered.message.url.includes('purchase_receipt'));
      assert(delivered.message.content.includes('9980'));
    });
    let batch, b1, b2, b3;
    await test('B02', async () => {
      batch = await newOrder('dev', sp.id);
      b1 = (await submit(batch, '4000')).receipt;
      await act(b1, 'approve');
      b2 = (await submit(batch, '3600')).receipt;
      b3 = (await submit(batch, '2480')).receipt;
      assert.equal(await prisma.procurementOrder.count({
        where: {
          id: batch.id
        }
      }), 1);
      assert.equal(await prisma.procurementReceipt.count({
        where: {
          orderId: batch.id
        }
      }), 3);
    });
    await test('B03', async () => {
      const order = await newOrder('dev', sp.id, [{
        itemId: 'synth-item-a',
        quantity: '1',
        unit: '克'
      }, {
        itemId: 'synth-item-b',
        quantity: '20',
        unit: '盒'
      }]);
      let d = await submit(order, '0.001');
      assert.equal(d.receipt.lines.length, 1);
      assert.equal(d.order.pending[1].quantity, '0');
      await act(d.receipt, 'approve');
      d = await ok('staff', '/procurement/orders/' + order.id + '/receipts', {
        requestKey: rk(),
        receivedDate: '2026-10-03',
        items: [{
          orderLineId: order.lines[1].id,
          quantity: '20'
        }]
      });
      assert.equal(d.receipt.lines.length, 1);
      assert.equal(d.receipt.lines[0].orderLineId, order.lines[1].id);
    });
    await test('B08', async () => {
      assert.equal((await ok('dev', '/procurement/orders/' + batch.id)).order.approved[0].quantity, '4000');
    });
    await test('B09', async () => {
      let d = (await act(b2, 'return', 'dev', '实盘数字误填')).order;
      const returned = d.receipts.find(x => x.id === b2.id);
      b2 = (await ok('staff', '/procurement/receipts/' + b2.id + '/resubmit', {
        requestKey: rk(),
        version: returned.version,
        receivedDate: '2026-10-03',
        items: [{
          orderLineId: batch.lines[0].id,
          quantity: '3500'
        }]
      })).receipt;
      await act(b2, 'approve');
      await act(b3, 'approve');
      d = (await ok('dev', '/procurement/orders/' + batch.id)).order;
      assert.equal(d.approved[0].quantity, '9980');
      assert.equal(await prisma.procurementNotificationEvent.count({
        where: {
          receiptId: b2.id
        }
      }), 2);
    });
    await test('B10', async () => {
      let d = (await ok('dev', '/procurement/orders/' + batch.id)).order,
        approved = d.receipts.find(x => x.id === b1.id);
      assert.equal((await request('buyer', '/procurement/receipts/' + approved.id + '/withdraw', {
        requestKey: rk(),
        version: approved.version,
        reason: 'x'
      })).status, 403);
      d = (await act(approved, 'withdraw', 'dev', '重新核对')).order;
      assert.equal(d.approved[0].quantity, '5980');
      const returned = d.receipts.find(x => x.id === b1.id);
      const rs = (await ok('staff', '/procurement/receipts/' + b1.id + '/resubmit', {
        requestKey: rk(),
        version: returned.version,
        receivedDate: '2026-10-03',
        items: [{
          orderLineId: batch.lines[0].id,
          quantity: '4000'
        }]
      })).receipt;
      d = (await act(rs, 'approve')).order;
      assert.equal(d.approved[0].quantity, '9980');
    });
    await test('B11', async () => {
      const order = await newOrder('dev', sp.id);
      await submit(order);
      const d = (await ok('dev', '/procurement/orders/' + order.id)).order;
      assert.equal((await request('dev', '/procurement/orders/' + order.id + '/close', {
        requestKey: rk(),
        version: d.version
      })).status, 409);
    });
    await test('B12', async () => {
      let d = (await ok('dev', '/procurement/orders/' + o.id)).order;
      assert.equal((await request('staff', '/procurement/orders/' + o.id + '/receipts', {
        requestKey: rk(),
        receivedDate: '2026-10-03',
        items: [{
          orderLineId: d.lines[0].id,
          quantity: '1'
        }]
      })).status, 409);
      d = (await ok('dev', '/procurement/orders/' + o.id + '/reopen', {
        requestKey: rk(),
        version: d.version,
        reason: '工厂补发'
      })).order;
      assert.equal(d.status, 'RECEIVING');
    });
    await test('B13', async () => {
      let d = (await ok('dev', '/procurement/orders/' + batch.id)).order;
      d = (await ok('dev', '/procurement/orders/' + batch.id + '/close', {
        requestKey: rk(),
        version: d.version
      })).order;
      const approved = d.receipts[0];
      assert.equal((await request('dev', '/procurement/receipts/' + approved.id + '/withdraw', {
        requestKey: rk(),
        version: approved.version,
        reason: '错填'
      })).status, 409);
      d = (await ok('dev', '/procurement/orders/' + batch.id + '/reopen', {
        requestKey: rk(),
        version: d.version,
        reason: '纠错'
      })).order;
      d = (await act(d.receipts[0], 'withdraw', 'dev', '纠错')).order;
      assert.equal(d.status, 'RECEIVING');
      assert.equal(d.receipts[0].status, 'RETURNED');
    });
    await test('B14', async () => {
      const d = (await ok('dev', '/procurement/orders/' + o.id)).order;
      assert.equal((await request('dev', '/procurement/orders/' + o.id, {
        requestKey: rk(),
        version: d.version,
        content: d.draftContent
      }, 'PUT')).status, 409);
      assert.equal((await request('dev', '/procurement/orders/' + o.id + '/cancel', {
        requestKey: rk(),
        version: d.version
      })).status, 409);
      const empty = (await ok('dev', '/procurement/orders', {
        requestKey: rk(),
        content: {}
      })).order;
      assert.equal((await ok('dev', '/procurement/orders/' + empty.id + '/cancel', {
        requestKey: rk(),
        version: empty.version
      })).order.status, 'CANCELLED');
    });
    await test('B11-B12-B13-close-correction', async () => {
      let d = (await ok('dev', '/procurement/orders/' + batch.id)).order;
      assert.equal((await request('dev', '/procurement/orders/' + d.id + '/close', {
        requestKey: rk(),
        version: d.version
      })).status, 409);
      const returned = d.receipts[0];
      const fresh = (await ok('staff', '/procurement/receipts/' + returned.id + '/resubmit', {
        requestKey: rk(),
        version: returned.version,
        receivedDate: '2026-10-03',
        items: [{
          orderLineId: batch.lines[0].id,
          quantity: '4000'
        }]
      })).receipt;
      d = (await act(fresh, 'approve')).order;
      d = (await ok('dev', '/procurement/orders/' + d.id + '/close', {
        requestKey: rk(),
        version: d.version
      })).order;
      assert.equal(d.approved[0].quantity, '9980');
      assert.equal(d.status, 'CLOSED');
      assert.equal((await request('dev', '/procurement/orders/' + d.id + '/reopen', {
        requestKey: rk(),
        version: d.version
      })).status, 400);
    });
    await test('C01', async () => {
      const body = {
        requestKey: rk(),
        content: {}
      };
      const [a, b] = await Promise.all([ok('dev', '/procurement/orders', body), ok('dev', '/procurement/orders', body)]);
      assert.equal(a.order.id, b.order.id);
    });
    await test('C01-approve-withdraw-retry', async () => {
      const order = await newOrder('dev', sp.id),
        receipt = (await submit(order, '1.005')).receipt,
        body = {
          requestKey: rk(),
          version: receipt.version
        };
      const replies = await Promise.all([ok('dev', '/procurement/receipts/' + receipt.id + '/approve', body), ok('dev', '/procurement/receipts/' + receipt.id + '/approve', body)]);
      assert(replies.every(x => x.order.approved[0].quantity === '1.005'));
      assert.equal(await prisma.procurementAudit.count({
        where: {
          operationKey: body.requestKey
        }
      }), 1);
      const approved = replies[0].order.receipts[0],
        withdraw = {
          requestKey: rk(),
          version: approved.version,
          reason: '合成重试纠错'
        };
      const withdrawn = await Promise.all([ok('dev', '/procurement/receipts/' + approved.id + '/withdraw', withdraw), ok('dev', '/procurement/receipts/' + approved.id + '/withdraw', withdraw)]);
      assert(withdrawn.every(x => x.order.approved[0].quantity === '0'));
      assert.equal(await prisma.procurementAudit.count({
        where: {
          operationKey: withdraw.requestKey
        }
      }), 1);
    });
    await test('C02', async () => {
      for (let i = 0; i < 20; i++) {
        for (const action of ['cancel', 'close', 'edit']) {
          const order = await newOrder('dev', sp.id),
            first = () => request('dev', '/procurement/orders/' + order.id + (action === 'edit' ? '' : '/' + action), {
              requestKey: rk(),
              version: order.version,
              ...(action === 'edit' ? {
                content: order.draftContent
              } : {})
            }, action === 'edit' ? 'PUT' : 'POST');
          const second = () => request('staff', '/procurement/orders/' + order.id + '/receipts', {
            requestKey: rk(),
            receivedDate: '2026-10-03',
            items: [{
              orderLineId: order.lines[0].id,
              quantity: '1'
            }]
          });
          const calls = i % 2 ? [second, first] : [first, second],
            responses = await barrierRace('ProcurementOrder', order.id, calls, action + '-first-submit-' + i);
          assert(responses.every(x => [200, 400, 409].includes(x.status)));
          assert(responses.some(x => x.status === 200));
          const after = await prisma.procurementOrder.findUnique({
            where: {
              id: order.id
            },
            include: {
              receipts: true
            }
          });
          if (['CANCELLED', 'CLOSED'].includes(after.status)) assert.equal(after.receipts.length, 0);else if (after.receipts.length) assert.equal(after.status, 'RECEIVING');
        }
        const order = await newOrder('dev', sp.id),
          receipt = (await submit(order, '1')).receipt;
        const approvalPair = [() => request('dev', '/procurement/receipts/' + receipt.id + '/approve', {
          requestKey: rk(),
          version: receipt.version
        }), () => request('dev', '/procurement/receipts/' + receipt.id + '/withdraw', {
          requestKey: rk(),
          version: receipt.version,
          reason: '并发纠错'
        })];
        const responses = await barrierRace('ProcurementOrder', order.id, i % 2 ? approvalPair.reverse() : approvalPair, 'approve-withdraw-' + i);
        assert.deepEqual(responses.map(x => x.status).sort(), [200, 409]);
        let current = (await ok('dev', '/procurement/orders/' + order.id)).order;
        await barrierRace('ProcurementOrder', order.id, [() => request('dev', '/procurement/orders/' + order.id + '/close', {
          requestKey: rk(),
          version: current.version
        }), () => request('dev', '/procurement/orders/' + order.id + '/reopen', {
          requestKey: rk(),
          version: current.version,
          reason: '并发重开'
        })], 'close-reopen-' + i);
        current = (await ok('dev', '/procurement/orders/' + order.id)).order;
        assert.equal(current.status, 'CLOSED');
        assert(current.receipts.every(x => x.status === 'APPROVED'));
        const draft = (await ok('dev', '/procurement/orders', {
          requestKey: rk(),
          content: {
            supplierId: sp.id,
            storeKey: 'synth-1',
            items: [{
              itemId: 'synth-item-a',
              quantity: '1',
              unit: '克'
            }]
          }
        })).order;
        const item = await prisma.inventoryItem.findUnique({
          where: {
            id: 'synth-item-a'
          }
        });
        const pair = [() => request('dev', '/procurement/orders/' + draft.id + '/mark-ordered', {
          requestKey: rk(),
          version: draft.version
        }), () => request('dev', '/procurement/items/' + item.id + '/purchase-purpose', {
          requestKey: rk(),
          version: item.version,
          purchaseEnabled: false
        }, 'PATCH')];
        const purposeResponses = await barrierRace('InventoryItem', item.id, i % 2 ? pair.reverse() : pair, 'purpose-off-mark-' + i);
        assert(purposeResponses.every(x => [200, 409].includes(x.status)));
        let latest = await prisma.inventoryItem.findUnique({
          where: {
            id: item.id
          }
        });
        await ok('dev', '/procurement/items/' + item.id + '/purchase-purpose', {
          requestKey: rk(),
          version: latest.version,
          purchaseEnabled: true
        }, 'PATCH');
        const bindDraft = (await ok('dev', '/procurement/orders', {
          requestKey: rk(),
          content: {
            supplierId: sp.id,
            storeKey: 'synth-1',
            items: [{
              itemId: item.id,
              quantity: '1',
              unit: '克'
            }]
          }
        })).order;
        const supplierRow = await prisma.procurementSupplier.findUnique({
          where: {
            id: sp.id
          }
        });
        const bindingPair = [() => request('dev', '/procurement/orders/' + bindDraft.id + '/mark-ordered', {
          requestKey: rk(),
          version: bindDraft.version
        }), () => request('dev', '/procurement/suppliers/' + sp.id, {
          name: sp.name,
          version: supplierRow.version,
          productIds: ['synth-item-b'],
          requestKey: rk()
        }, 'PUT')];
        const bindingResponses = await barrierRace('InventoryItem', item.id, i % 2 ? bindingPair.reverse() : bindingPair, 'unbind-mark-' + i);
        assert(bindingResponses.every(x => [200, 409].includes(x.status)));
        const supplierLatest = await prisma.procurementSupplier.findUnique({
          where: {
            id: sp.id
          }
        });
        await ok('dev', '/procurement/suppliers/' + sp.id, {
          name: sp.name,
          version: supplierLatest.version,
          productIds: ['synth-item-a', 'synth-item-b'],
          requestKey: rk()
        }, 'PUT');
      }
      const unsafe = await prisma.procurementOrder.count({
        where: {
          status: 'CLOSED',
          receipts: {
            some: {
              status: {
                in: ['PENDING', 'RETURNED']
              }
            }
          }
        }
      });
      assert.equal(unsafe, 0);
    });
    await test('C03', async () => {
      const order = await newOrder('dev', sp.id);
      assert.equal((await request('dev', '/procurement/orders', {requestKey: rk(), content: {supplierId: sp.id, storeKey: 'synth-1', items: [{itemId: 'synth-item-a', quantity: 1.005, unit: '克'}]}})).status, 400);
      assert.equal((await request('dev', '/procurement/orders', {requestKey: rk(), content: {supplierId: sp.id, storeKey: 'synth-1', items: [{itemId: 'synth-item-a', quantity: '1', unit: '克'}, {itemId: 'synth-item-a', quantity: '2', unit: '克'}]}})).status, 400);
      for (const value of ['', '0', '-1', 'NaN', 'Infinity', '1e3', '1.0001', '1000000', 'a']) assert.equal((await request('staff', '/procurement/orders/' + order.id + '/receipts', {
        requestKey: rk(),
        receivedDate: '2026-10-03',
        items: [{
          orderLineId: order.lines[0].id,
          quantity: value
        }]
      })).status, 400);
      const d = await submit(order, '0.001');
      assert.equal(d.receipt.lines[0].receivedQty, '0.001');
      assert.equal((await submit(order, '999999.999')).receipt.lines[0].receivedQty, '999999.999');
    });
    await test('C04', async () => {
      const order = await newOrder('dev', sp.id);
      f.deliveryMode('failed');
      let response = await submit(order, '1');
      assert.equal(response.submitted, true);
      assert.equal(response.notificationStatus[0].status, 'FAILED');
      f.deliveryMode('sent');
      await ok('dev', '/procurement/receipts/' + response.receipt.id + '/notification-retry', {
        eventId: response.notificationStatus[0].id
      });
      f.deliveryMode('throw');
      response = await submit(order, '2');
      assert.equal(response.notificationStatus[0].status, 'UNKNOWN');
      assert.equal((await request('dev', '/procurement/receipts/' + response.receipt.id + '/notification-retry', {
        eventId: response.notificationStatus[0].id
      })).status, 409);
      f.deliveryMode('sent');
    });
    await test('C04-transaction-and-long-detail', async () => {
      const order = await newOrder('dev', sp.id),
        before = await prisma.procurementReceipt.count({
          where: {
            orderId: order.id
          }
        }),
        notices = await prisma.notification.count();
      await prisma.$executeRawUnsafe('CREATE TRIGGER synthetic_notification_failure BEFORE INSERT ON "notifications" FOR EACH STATEMENT EXECUTE FUNCTION synthetic_deny_protected_write()');
      try {
        assert.equal((await request('staff', '/procurement/orders/' + order.id + '/receipts', {
          requestKey: rk(),
          receivedDate: '2026-10-03',
          items: [{
            orderLineId: order.lines[0].id,
            quantity: '1'
          }]
        })).status, 500);
        assert.equal(await prisma.procurementReceipt.count({
          where: {
            orderId: order.id
          }
        }), before);
        assert.equal(await prisma.notification.count(), notices);
        assert.equal((await ok('dev', '/procurement/orders/' + order.id)).order.status, 'ORDERED');
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER synthetic_notification_failure ON "notifications"');
      }
      const response = await submit(order, '1'),
        event = response.notificationStatus[0];
      await prisma.procurementNotificationEvent.update({
        where: {
          id: event.id
        },
        data: {
          status: 'SENDING',
          updatedAt: new Date(Date.now() - 180000)
        }
      });
      assert.equal((await ok('dev', '/procurement/orders/' + order.id)).order.receipts[0].events[0].status, 'UNKNOWN');
      assert.equal((await request('dev', '/procurement/receipts/' + response.receipt.id + '/notification-retry', {
        eventId: event.id
      })).status, 409);
      const ids = Array.from({
        length: 50
      }, (_, i) => 'synthetic-notice-item-' + i);
      await prisma.inventoryItem.createMany({
        data: ids.map((id, i) => ({
          id,
          name: '合成通知长商品名' + i + '长'.repeat(30),
          purchaseEnabled: true
        }))
      });
      const supplierRow = await supplier('合成通知长清单供应商', ids);
      const long = await newOrder('dev', supplierRow.id, ids.map(itemId => ({
        itemId,
        quantity: '1.005',
        unit: '固定单位'
      })));
      const d = await ok('staff', '/procurement/orders/' + long.id + '/receipts', {
        requestKey: rk(),
        receivedDate: '2026-10-03',
        items: long.lines.map(x => ({
          orderLineId: x.id,
          quantity: '1.005'
        }))
      });
      const full = await prisma.notification.findUnique({
        where: {
          id: d.notificationStatus[0].id.replace('pre-', 'pn-')
        }
      });
      assert(full.content.includes('49长'));
      const sent = f.deliveries.at(-1);
      assert(sent.message.content.includes('共50项，完整本次明细见详情'));
      assert(sent.message.content.length <= 500);
      assert(sent.message.url.includes(d.receipt.id));
    });
    await test('C05', async () => {
      const before = (await ok('dev', '/procurement/orders/' + o.id + '/export-data')).items[0].name;
      await prisma.inventoryItem.update({
        where: {
          id: 'synth-item-a'
        },
        data: {
          name: '已改名合成商品'
        }
      });
      assert.equal((await ok('dev', '/procurement/orders/' + o.id + '/export-data')).items[0].name, before);
      await prisma.inventoryItem.update({
        where: {
          id: 'synth-item-a'
        },
        data: {
          name: '合成糖商品A'
        }
      });
    });
    await test('C05-snapshot-binding-and-revision', async () => {
      const edited = await newOrder('dev', sp.id),
        prior = await ok('dev', '/procurement/orders/' + edited.id + '/export-data');
      const change = {
        ...edited.draftContent,
        items: edited.draftContent.items.map(x => ({
          ...x,
          quantity: '20000'
        }))
      };
      await ok('dev', '/procurement/orders/' + edited.id, {
        requestKey: rk(),
        version: edited.version,
        content: change
      }, 'PUT');
      assert.equal((await ok('dev', '/procurement/orders/' + edited.id + '/export-data?revision=' + prior.revision)).items[0].quantity, '10000');
      const order = await newOrder('dev', sp.id),
        imageBefore = await ok('dev', '/procurement/orders/' + order.id + '/export-data'),
        item = await prisma.inventoryItem.findUnique({
          where: {
            id: 'synth-item-a'
          }
        }),
        supplierRow = await prisma.procurementSupplier.findUnique({
          where: {
            id: sp.id
          }
        });
      await ok('dev', '/procurement/suppliers/' + sp.id, {
        requestKey: rk(),
        version: supplierRow.version,
        name: '改名合成新供应商',
        productIds: ['synth-item-b']
      }, 'PUT');
      const latest = await prisma.inventoryItem.findUnique({
        where: {
          id: item.id
        }
      });
      await ok('dev', '/procurement/items/' + item.id + '/purchase-purpose', {
        requestKey: rk(),
        version: latest.version,
        purchaseEnabled: false
      }, 'PATCH');
      await prisma.inventoryItem.update({
        where: {
          id: item.id
        },
        data: {
          name: '改名且解绑合成商品',
          unit: '箱'
        }
      });
      await prisma.store.update({
        where: {
          key: 'synth-1'
        },
        data: {
          name: '改名合成门店1'
        }
      });
      const result = await submit(order, '10020');
      assert.equal(result.order.lines[0].unitSnapshot, '克');
      assert.deepEqual(await ok('dev', '/procurement/orders/' + order.id + '/export-data'), imageBefore);
      assert.equal(result.order.lines[0].productNameSnapshot, '合成糖商品A');
    });
    await test('C06', async () => {
      assert.equal((await request('dev', '/purchase-requests', {
        storeKey: 'synth-1',
        items: []
      })).status, 410);
      assert.equal((await request('dev', '/suppliers', {
        name: 'x'
      })).status, 410);
      assert.equal((await ok('dev', '/purchase-requests')).rows.length, 1);
      assert.equal(await prisma.purchaseRequest.count(), 1);
    });
    await test('C07', async () => {
      for (const table of ['stockBalance', 'stockLedger', 'payment', 'refund', 'inventoryItemCostHistory']) assert.equal(await prisma[table].count(), 0);
    });
    await test('C11', async () => {
      assert.equal((await prisma.$queryRawUnsafe('SELECT count(*)::int n FROM "_prisma_migrations"'))[0].n, 88);
      assert.equal(f.externalAttempts.length, 0);
    });
    fs.mkdirSync('output/purchase-receipt', {
      recursive: true
    });
    fs.writeFileSync('output/purchase-receipt/native-results.json', JSON.stringify({
      database: f.databaseUrl.replace(/\/[^/]+$/, '/disposable-created-by-helper'),
      results,
      raceEvidence,
      deliveries: f.deliveries,
      externalAttempts: f.externalAttempts
    }, null, 2));
  } finally {
    await f.cleanup();
  }
  if (results.some(x => x.status === 'FAIL')) process.exitCode = 1;
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--serve')) {
    const f = await startFixture();
    const {
      createServer
    } = await import('vite');
    const vite = await createServer({
      configFile: false,
      server: {
        host: '127.0.0.1',
        port: 5217,
        strictPort: true,
        proxy: {
          '/api': f.base,
          '/__fixture': f.base
        }
      },
      plugins: [(await import('@vitejs/plugin-react')).default()]
    });
    await vite.listen();
    console.log('REAL_PAGE_API_PG_READY ' + f.databaseUrl);
    const clean = async () => {
      await vite.close();
      await f.cleanup();
      process.exit(0);
    };
    process.on('SIGTERM', clean);
    process.on('SIGINT', clean);
    for (const [signal, hook] of f.helperSignalHooks) if (hook) process.removeListener(signal, hook);
  } else await runNative();
}

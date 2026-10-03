import { Router } from 'express';
import { prisma } from './pg.js';
import { canUseProcurement, canManageProcurement, canAccessProcurementStore, isProcurementDeveloper, hasModuleAccess, MODULE_KEYS, normalizeAccountPermissions } from '../shared/accountPermissions.js';
import { fail, id, json, digest, quantity, unit, date, reason, key, version, open, unique, sum } from './purchase-receipt-core.js';
import { createReceiptNotice, deliverReceiptNotice, receiptDeliverySummary } from './purchase-receipt-notification.js';
export const purchaseReceiptRouter = Router();
const include = {
  lines: {
    orderBy: {
      linePosition: 'asc'
    }
  },
  receipts: {
    orderBy: {
      sequence: 'asc'
    },
    include: {
      lines: true,
      events: {
        select: {
          id: true,
          status: true,
          errorCode: true,
          submissionRevision: true,
          updatedAt: true
        }
      }
    }
  }
};
const wrap = fn => async (req, res) => {
  try {
    if (!canUseProcurement(req.user) && !(req.method === 'PATCH' && req.path.endsWith('/purchase-purpose'))) throw fail('无采购权限', 403);
    res.json(await fn(req));
  } catch (e) {
    if (e.code === 'P2002') e = fail('请求或商品绑定已存在，请刷新后重试', 409);
    if (!e.status) console.error('[procurement]', e);
    res.status(e.status || 500).json({
      error: e.status ? e.message : '采购操作失败，请刷新后核对记录再重试'
    });
  }
};
async function actor(tx, user, productScope = false) {
  const u = await tx.user.findUnique({
    where: {
      id: user.id
    }
  });
  if (!u) throw fail('未登录', 401);
  u.permissions = normalizeAccountPermissions(u.permissions, u.role);
  if (productScope) {
    if (!['developer', 'admin', 'finance', 'manager', 'staff'].includes(u.role) || u.status !== 'active') throw fail('无权限', 403);
  } else if (!canUseProcurement(u)) throw fail('无采购权限', 403);
  return u;
}
const manage = u => {
  if (!canManageProcurement(u)) throw fail('需要采购管理权限', 403);
};
const developer = u => {
  if (!isProcurementDeveloper(u)) throw fail('仅开发者可执行', 403);
};
function scope(u, o) {
  if (o.storeKey ? canAccessProcurementStore(u, o.storeKey) : canManageProcurement(u) && o.status === 'DRAFT' && (o.createdById === u.id || isProcurementDeveloper(u))) return;
  throw fail('无该门店权限', 403);
}
async function lockOrder(tx, orderId) {
  await tx.$queryRawUnsafe('SELECT id FROM "ProcurementOrder" WHERE id=$1 FOR UPDATE', orderId);
  const o = await tx.procurementOrder.findUnique({
    where: {
      id: orderId
    },
    include
  });
  if (!o) throw fail('采购单不存在', 404);
  return o;
}
async function audit(tx, u, entityId, orderId, action, before, after, op, payload, why = '') {
  return tx.procurementAudit.create({
    data: {
      id: id('pa'),
      entityId,
      orderId,
      action,
      actorId: u.id,
      actorName: u.username,
      reason: why,
      before: before === undefined ? undefined : json(before),
      after: after === undefined ? undefined : json(after),
      operationKey: op,
      payloadHash: digest(payload)
    }
  });
}
async function replay(tx, op, payload) {
  const a = await tx.procurementAudit.findUnique({
    where: {
      operationKey: op
    }
  });
  if (a && a.payloadHash !== digest(payload)) throw fail('同一请求标识不可用于不同内容', 409);
  return a;
}
function present(o) {
  const value = json(o);
  for (const r of value.receipts) for (const e of r.events || []) if (e.status === 'SENDING' && Date.now() - new Date(e.updatedAt).getTime() > 120000) {
    e.status = 'UNKNOWN';
    e.errorCode = 'UNCONFIRMED_DELIVERY';
  }
  return {
    ...value,
    approved: o.lines.map(l => ({
      orderLineId: l.id,
      quantity: sum(o.receipts.filter(r => r.status === 'APPROVED').flatMap(r => r.lines.filter(x => x.orderLineId === l.id).map(x => x.receivedQty))),
      unit: l.unitSnapshot
    })),
    pending: o.lines.map(l => ({
      orderLineId: l.id,
      quantity: sum(o.receipts.filter(r => r.status === 'PENDING').flatMap(r => r.lines.filter(x => x.orderLineId === l.id).map(x => x.receivedQty)))
    }))
  };
}
// Every path locks in order: order (if present), all items sorted, supplier.
// Supplier and purpose paths never acquire an order lock.
async function lockItems(tx, ids) {
  for (const itemId of [...new Set(ids)].sort()) await tx.$queryRawUnsafe('SELECT id FROM "InventoryItem" WHERE id=$1 FOR UPDATE', itemId);
}
async function prepare(tx, u, content, strict) {
  const c = content || {},
    storeKey = String(c.storeKey || '') || null,
    supplierId = String(c.supplierId || '') || null;
  if (storeKey && !canAccessProcurementStore(u, storeKey)) throw fail('无该门店权限', 403);
  const rows = Array.isArray(c.items) ? c.items : [];
  if (rows.length > 50) throw fail('每单最多50种商品');
  unique(rows, 'itemId');
  await lockItems(tx, rows.map(x => String(x.itemId || '')));
  if (supplierId) await tx.$queryRawUnsafe('SELECT id FROM "ProcurementSupplier" WHERE id=$1 FOR UPDATE', supplierId);
  const supplier = supplierId ? await tx.procurementSupplier.findUnique({
    where: {
      id: supplierId
    }
  }) : null;
  const store = storeKey ? await tx.store.findUnique({
    where: {
      key: storeKey
    }
  }) : null;
  if (supplierId && !supplier) throw fail('采购供应商不存在');
  if (storeKey && (!store || !store.active)) throw fail('门店不存在或已停用');
  if (strict && (!store || !supplier || !rows.length)) throw fail('请完整选择供应商、门店和商品');
  const items = [];
  for (const row of rows) {
    const item = await tx.inventoryItem.findUnique({
      where: {
        id: String(row.itemId || '')
      }
    });
    if (!item || !item.purchaseEnabled || !supplier || item.procurementSupplierId !== supplier.id) throw fail('商品未开启采购用途或未绑定所选供应商', 409);
    if (row.quantity != null && typeof row.quantity !== 'string') throw fail('数量请以十进制文本提交');
    const q = row.quantity == null ? '' : row.quantity,
      un = String(row.unit || '').trim();
    if (strict || q) quantity(q);
    if (strict || un) unit(un);
    items.push({
      itemId: item.id,
      productNameSnapshot: item.name,
      quantity: q,
      unit: un
    });
  }
  return {
    storeKey,
    supplierId,
    storeNameSnapshot: store?.name || '',
    supplierNameSnapshot: supplier?.name || '',
    items
  };
}
async function replaceLines(tx, o, c) {
  await tx.procurementOrderLine.deleteMany({
    where: {
      orderId: o.id
    }
  });
  for (let i = 0; i < c.items.length; i++) {
    const l = c.items[i];
    await tx.procurementOrderLine.create({
      data: {
        id: id('pol'),
        orderId: o.id,
        inventoryItemId: l.itemId,
        productNameSnapshot: l.productNameSnapshot,
        unitSnapshot: unit(l.unit),
        orderedQty: quantity(l.quantity),
        linePosition: i
      }
    });
  }
}
async function orderedAction(req, action, fn) {
  const op = key(req.body.requestKey),
    payload = {
      ...req.body,
      action,
      orderId: req.params.id
    };
  return prisma.$transaction(async tx => {
    const u = await actor(tx, req.user),
      o = await lockOrder(tx, req.params.id);
    scope(u, o);
    if (['CLOSE', 'REOPEN'].includes(action)) developer(u);else manage(u);
    if (await replay(tx, op, payload)) return present(o);
    version(o.version, req.body.version);
    const before = json(o);
    await fn(tx, u, o);
    const after = await tx.procurementOrder.findUnique({
      where: {
        id: o.id
      },
      include
    });
    await audit(tx, u, o.id, o.id, action, before, after, op, payload, req.body.reason || '');
    return present(after);
  }, {
    timeout: 15000
  });
}
purchaseReceiptRouter.get('/procurement/stores', wrap(async req => ({
  rows: await prisma.store.findMany({
    where: {
      active: true,
      ...(isProcurementDeveloper(req.user) ? {} : {
        key: {
          in: req.user.storeKeys || []
        }
      })
    },
    select: {
      key: true,
      name: true
    }
  })
})));
purchaseReceiptRouter.get('/procurement/orders', wrap(async req => {
  const u = req.user,
    where = isProcurementDeveloper(u) ? {} : {
      OR: [{
        storeKey: {
          in: u.storeKeys || []
        },
        ...(canManageProcurement(u) ? {} : {
          status: {
            not: 'DRAFT'
          }
        })
      }, {
        status: 'DRAFT',
        storeKey: null,
        createdById: u.id
      }]
    };
  const rows = await prisma.procurementOrder.findMany({
    where,
    include,
    orderBy: {
      createdAt: 'desc'
    },
    take: 500
  });
  return {
    rows: rows.filter(o => o.status !== 'DRAFT' || canManageProcurement(u)).map(present)
  };
}));
purchaseReceiptRouter.get('/procurement/orders/:id', wrap(async req => {
  const o = await prisma.procurementOrder.findUnique({
    where: {
      id: req.params.id
    },
    include
  });
  if (!o) throw fail('采购单不存在', 404);
  scope(req.user, o);
  if (o.status === 'DRAFT') manage(req.user);
  return {
    order: present(o),
    history: await prisma.procurementAudit.findMany({
      where: {
        orderId: o.id
      },
      orderBy: {
        createdAt: 'asc'
      }
    })
  };
}));
purchaseReceiptRouter.post('/procurement/orders', wrap(async req => {
  const k = key(req.body.requestKey),
    hash = digest(req.body.content || {});
  return prisma.$transaction(async tx => {
    const u = await actor(tx, req.user);
    manage(u);
    // Advisory lock serializes create retries before a row exists.
    await tx.$queryRawUnsafe('SELECT true AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))', k);
    const existing = await tx.procurementOrder.findUnique({
      where: {
        createRequestKey: k
      },
      include
    });
    if (existing) {
      scope(u, existing);
      if (existing.createPayloadHash !== hash) throw fail('请求内容不同', 409);
      return {
        order: present(existing)
      };
    }
    const c = await prepare(tx, u, req.body.content, false);
    const o = await tx.procurementOrder.create({
      data: {
        id: id('po'),
        storeKey: c.storeKey,
        supplierId: c.supplierId,
        supplierNameSnapshot: c.supplierNameSnapshot,
        storeNameSnapshot: c.storeNameSnapshot,
        createdById: u.id,
        createdByName: u.username,
        draftContent: c,
        createRequestKey: k,
        createPayloadHash: hash
      },
      include
    });
    await audit(tx, u, o.id, o.id, 'CREATE', undefined, o, 'create:' + k, req.body.content || {});
    return {
      order: present(o)
    };
  });
}));
purchaseReceiptRouter.put('/procurement/orders/:id', wrap(async req => ({
  order: await orderedAction(req, 'EDIT', async (tx, u, o) => {
    manage(u);
    if (!['DRAFT', 'ORDERED'].includes(o.status) || o.receipts.length) throw fail('已有收货记录或状态不允许修改原清单', 409);
    const c = await prepare(tx, u, req.body.content, o.status === 'ORDERED');
    if (o.status === 'ORDERED') await replaceLines(tx, o, c);
    await tx.procurementOrder.update({
      where: {
        id: o.id
      },
      data: {
        ...Object.fromEntries(['storeKey', 'supplierId', 'supplierNameSnapshot', 'storeNameSnapshot'].map(k => [k, c[k]])),
        draftContent: c,
        version: {
          increment: 1
        },
        orderRevision: {
          increment: 1
        }
      }
    });
  })
})));
purchaseReceiptRouter.post('/procurement/orders/:id/mark-ordered', wrap(async req => ({
  order: await orderedAction(req, 'MARK_ORDERED', async (tx, u, o) => {
    manage(u);
    if (o.status !== 'DRAFT') throw fail('当前状态不能标记下单', 409);
    const c = await prepare(tx, u, o.draftContent, true);
    await replaceLines(tx, o, c);
    await tx.procurementOrder.update({
      where: {
        id: o.id
      },
      data: {
        status: 'ORDERED',
        orderedAt: new Date(),
        draftContent: c,
        supplierNameSnapshot: c.supplierNameSnapshot,
        storeNameSnapshot: c.storeNameSnapshot,
        version: {
          increment: 1
        },
        orderRevision: {
          increment: 1
        }
      }
    });
  })
})));
purchaseReceiptRouter.post('/procurement/orders/:id/cancel', wrap(async req => ({
  order: await orderedAction(req, 'CANCEL', async (tx, u, o) => {
    manage(u);
    if (!['DRAFT', 'ORDERED'].includes(o.status) || o.receipts.length) throw fail('已有收货记录，不能取消', 409);
    await tx.procurementOrder.update({
      where: {
        id: o.id
      },
      data: {
        status: 'CANCELLED',
        version: {
          increment: 1
        }
      }
    });
  })
})));
for (const action of ['close', 'reopen']) purchaseReceiptRouter.post('/procurement/orders/:id/' + action, wrap(async req => ({
  order: await orderedAction(req, action.toUpperCase(), async (tx, u, o) => {
    developer(u);
    if (action === 'close') {
      open(o);
      if (o.receipts.some(r => r.status !== 'APPROVED')) throw fail('请先处理所有待核准或退回的收货记录', 409);
    } else {
      reason(req.body.reason);
      if (o.status !== 'CLOSED') throw fail('只有已结束单可重开', 409);
    }
    await tx.procurementOrder.update({
      where: {
        id: o.id
      },
      data: {
        status: action === 'close' ? 'CLOSED' : o.receipts.length ? 'RECEIVING' : 'ORDERED',
        closedAt: action === 'close' ? new Date() : null,
        version: {
          increment: 1
        }
      }
    });
  })
})));
purchaseReceiptRouter.get('/procurement/orders/:id/export-data', wrap(async req => {
  const o = await prisma.procurementOrder.findUnique({
    where: {
      id: req.params.id
    },
    include
  });
  if (!o) throw fail('采购单不存在', 404);
  scope(req.user, o);
  manage(req.user);
  let c = o.draftContent;
  if (req.query.revision && Number(req.query.revision) !== o.orderRevision) {
    const histories = await prisma.procurementAudit.findMany({
      where: {
        orderId: o.id
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    const snapshot = histories.flatMap(a => [a.after, a.before]).find(s => s?.orderRevision === Number(req.query.revision));
    if (!snapshot) throw fail('清单版本不存在', 404);
    c = snapshot.draftContent;
  }
  if (!c.supplierNameSnapshot || !c.storeNameSnapshot || !c.items?.length) throw fail('请先保存完整采购清单');
  for (const l of c.items) {
    quantity(l.quantity);
    unit(l.unit);
  }
  return {
    revision: req.query.revision ? Number(req.query.revision) : o.orderRevision,
    supplier: c.supplierNameSnapshot,
    store: c.storeNameSnapshot,
    items: c.items.map(l => ({
      name: l.productNameSnapshot,
      quantity: l.quantity,
      unit: l.unit
    }))
  };
}));
async function receiptWrite(req, resubmit) {
  const payload = {
      ...req.body,
      receiptId: resubmit ? req.params.id : undefined,
      orderId: resubmit ? undefined : req.params.id
    },
    op = key(req.body.requestKey);
  let eventId;
  const result = await prisma.$transaction(async tx => {
    const u = await actor(tx, req.user);
    const found = resubmit ? await tx.procurementReceipt.findUnique({
      where: {
        id: req.params.id
      }
    }) : null;
    if (resubmit && !found) throw fail('收货记录不存在', 404);
    const o = await lockOrder(tx, resubmit ? found.orderId : req.params.id);
    scope(u, o);
    const replayAudit = await replay(tx, op, payload);
    const existing = resubmit ? o.receipts.find(x => x.id === req.params.id) : o.receipts.find(x => x.createRequestKey === op);
    if (replayAudit || !resubmit && existing) {
      if (!resubmit && existing.createPayloadHash !== digest(payload)) throw fail('请求内容不同', 409);
      return {
        receipt: json(existing),
        order: present(o),
        submitted: true
      };
    }
    open(o);
    if (resubmit) {
      if (existing.status !== 'RETURNED') throw fail('只有退回记录可修改提交', 409);
      version(existing.version, req.body.version);
    }
    const rows = req.body.items;
    if (!Array.isArray(rows) || !rows.length || rows.length > o.lines.length) throw fail('请填写本次实际到货商品');
    unique(rows, 'orderLineId');
    for (const l of rows) {
      const original = o.lines.find(x => x.id === l.orderLineId);
      if (!original) throw fail('商品明细不属于本采购单');
      if (l.unit !== undefined && l.unit !== original.unitSnapshot) throw fail('实收单位必须沿用原清单');
      quantity(l.quantity);
    }
    const receivedDate = date(req.body.receivedDate),
      before = existing ? json(existing) : undefined;
    let r;
    if (resubmit) {
      await tx.procurementReceiptLine.deleteMany({
        where: {
          receiptId: existing.id
        }
      });
      r = await tx.procurementReceipt.update({
        where: {
          id: existing.id
        },
        data: {
          receivedDate,
          status: 'PENDING',
          revision: {
            increment: 1
          },
          version: {
            increment: 1
          },
          submittedById: u.id,
          submittedByName: u.username,
          submittedAt: new Date(),
          approvedById: null,
          approvedAt: null
        }
      });
    } else r = await tx.procurementReceipt.create({
      data: {
        id: id('prc'),
        orderId: o.id,
        sequence: o.receipts.length + 1,
        receivedDate,
        registeredById: u.id,
        submittedById: u.id,
        submittedByName: u.username,
        createRequestKey: op,
        createPayloadHash: digest(payload)
      }
    });
    for (const l of rows) await tx.procurementReceiptLine.create({
      data: {
        id: id('prl'),
        orderId: o.id,
        receiptId: r.id,
        orderLineId: l.orderLineId,
        receivedQty: quantity(l.quantity)
      }
    });
    r = await tx.procurementReceipt.findUnique({
      where: {
        id: r.id
      },
      include: {
        lines: true
      }
    });
    eventId = await createReceiptNotice(tx, r, o);
    await tx.procurementOrder.update({
      where: {
        id: o.id
      },
      data: {
        status: 'RECEIVING',
        version: {
          increment: 1
        }
      }
    });
    await audit(tx, u, r.id, o.id, resubmit ? 'RESUBMIT' : 'SUBMIT', before, r, op, payload);
    return {
      receipt: json(r),
      submitted: true,
      order: present(await tx.procurementOrder.findUnique({
        where: {
          id: o.id
        },
        include
      }))
    };
  }, {
    timeout: 15000
  });
  if (eventId) await deliverReceiptNotice(eventId).catch(async () => {
    await prisma.procurementNotificationEvent.updateMany({
      where: {
        id: eventId,
        status: 'SENDING'
      },
      data: {
        status: 'UNKNOWN',
        errorCode: 'UNCONFIRMED_DELIVERY'
      }
    }).catch(() => {});
  });
  result.notificationStatus = await receiptDeliverySummary(result.receipt.id);
  return result;
}
purchaseReceiptRouter.post('/procurement/orders/:id/receipts', wrap(req => receiptWrite(req, false)));
purchaseReceiptRouter.post('/procurement/receipts/:id/resubmit', wrap(req => receiptWrite(req, true)));
purchaseReceiptRouter.get('/procurement/receipts/:id', wrap(async req => {
  const r = await prisma.procurementReceipt.findUnique({
    where: {
      id: req.params.id
    }
  });
  if (!r) throw fail('收货记录不存在', 404);
  const o = await prisma.procurementOrder.findUnique({
    where: {
      id: r.orderId
    },
    include
  });
  scope(req.user, o);
  return {
    order: present(o),
    receiptId: r.id
  };
}));
for (const action of ['approve', 'return', 'withdraw']) purchaseReceiptRouter.post('/procurement/receipts/:id/' + action, wrap(async req => {
  const op = key(req.body.requestKey),
    payload = {
      ...req.body,
      action,
      id: req.params.id
    };
  return prisma.$transaction(async tx => {
    const u = await actor(tx, req.user);
    developer(u);
    const ref = await tx.procurementReceipt.findUnique({
      where: {
        id: req.params.id
      }
    });
    if (!ref) throw fail('收货记录不存在', 404);
    const o = await lockOrder(tx, ref.orderId);
    scope(u, o);
    const r = o.receipts.find(x => x.id === ref.id);
    if (await replay(tx, op, payload)) return {
      order: present(o)
    };
    open(o);
    version(r.version, req.body.version);
    if (r.status !== (action === 'withdraw' ? 'APPROVED' : 'PENDING')) throw fail('本次收货状态已变化', 409);
    const why = action === 'approve' ? '' : reason(req.body.reason);
    const after = await tx.procurementReceipt.update({
      where: {
        id: r.id
      },
      data: {
        status: action === 'approve' ? 'APPROVED' : 'RETURNED',
        version: {
          increment: 1
        },
        approvedById: action === 'approve' ? u.id : null,
        approvedAt: action === 'approve' ? new Date() : null
      }
    });
    await tx.procurementOrder.update({
      where: {
        id: o.id
      },
      data: {
        version: {
          increment: 1
        }
      }
    });
    await audit(tx, u, r.id, o.id, action.toUpperCase(), r, after, op, payload, why);
    return {
      order: present(await tx.procurementOrder.findUnique({
        where: {
          id: o.id
        },
        include
      }))
    };
  });
}));
purchaseReceiptRouter.post('/procurement/receipts/:id/notification-retry', wrap(async req => {
  developer(req.user);
  const r = await prisma.procurementReceipt.findUnique({
    where: {
      id: req.params.id
    }
  });
  if (!r) throw fail('收货记录不存在', 404);
  const ev = await prisma.procurementNotificationEvent.findUnique({
    where: {
      id: req.body.eventId
    }
  });
  if (!ev || ev.receiptId !== r.id || ev.status !== 'FAILED') throw fail('仅明确失败的本次投递可重试', 409);
  await deliverReceiptNotice(ev.id, {
    retry: true
  });
  return {
    submitted: true,
    notificationStatus: await receiptDeliverySummary(r.id)
  };
}));
purchaseReceiptRouter.get('/procurement/items', wrap(async req => {
  manage(req.user);
  return {
    rows: await prisma.inventoryItem.findMany({
      select: {
        id: true,
        name: true,
        category: true,
        purchaseEnabled: true,
        procurementSupplierId: true,
        version: true
      },
      orderBy: {
        name: 'asc'
      },
      take: 1000
    })
  };
}));
purchaseReceiptRouter.patch('/procurement/items/:id/purchase-purpose', wrap(async req => prisma.$transaction(async tx => {
  const u = await actor(tx, req.user, true);
  await lockItems(tx, [req.params.id]);
  const item = await tx.inventoryItem.findUnique({
    where: {
      id: req.params.id
    }
  });
  if (!item) throw fail('商品不存在', 404);
  if (!isProcurementDeveloper(u) && !hasModuleAccess(u, item.category === 'material' ? MODULE_KEYS.PRODUCT_MATERIAL_MANAGEMENT : MODULE_KEYS.PRODUCT_CENTER)) throw fail('无商品中心管理权限', 403);
  // Preserve existing product management role restriction.
  if (!['developer', 'admin', 'finance', 'manager'].includes(u.role)) throw fail('无商品管理权限', 403);
  version(item.version, req.body.version);
  if (typeof req.body.purchaseEnabled !== 'boolean') throw fail('采购用途值不正确');
  const after = await tx.inventoryItem.update({
    where: {
      id: item.id
    },
    data: {
      purchaseEnabled: req.body.purchaseEnabled,
      version: {
        increment: 1
      }
    }
  });
  await audit(tx, u, item.id, null, 'PURCHASE_PURPOSE', item, after, key(req.body.requestKey), req.body);
  return {
    item: json(after)
  };
})));
purchaseReceiptRouter.get('/procurement/suppliers', wrap(async req => {
  manage(req.user);
  return {
    rows: await prisma.procurementSupplier.findMany({
      include: {
        products: {
          select: {
            id: true,
            name: true,
            purchaseEnabled: true
          }
        }
      },
      orderBy: {
        createdAt: 'asc'
      }
    })
  };
}));
purchaseReceiptRouter.get('/procurement/suppliers/:id/products', wrap(async req => {
  manage(req.user);
  return {
    rows: await prisma.inventoryItem.findMany({
      where: {
        purchaseEnabled: true,
        procurementSupplierId: req.params.id
      },
      select: {
        id: true,
        name: true
      },
      orderBy: {
        name: 'asc'
      }
    })
  };
}));
async function saveSupplier(req, update) {
  return prisma.$transaction(async tx => {
    const u = await actor(tx, req.user);
    manage(u);
    const op = key(req.body.requestKey),
      payload = {
        ...req.body,
        id: update ? req.params.id : undefined
      };
    await tx.$queryRawUnsafe('SELECT true AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))', op);
    const prior = await replay(tx, op, payload);
    if (prior) return {
      supplier: await tx.procurementSupplier.findUnique({
        where: {
          id: prior.entityId
        }
      })
    };
    const name = String(req.body.name || '').trim();
    if (!name || name.length > 50) throw fail('供应商名称应为1–50字');
    const productIds = req.body.productIds;
    if (!Array.isArray(productIds) || productIds.length > 1000 || new Set(productIds).size !== productIds.length) throw fail('绑定商品不正确');
    const supplierId = update ? req.params.id : id('ps');
    // Common advisory lock prevents binding paths from taking item sets out of order.
    await tx.$queryRawUnsafe("SELECT true AS locked FROM pg_advisory_xact_lock(hashtextextended('procurement-binding',0))");
    const oldProducts = update ? await tx.inventoryItem.findMany({
      where: {
        procurementSupplierId: supplierId
      },
      select: {
        id: true
      }
    }) : [];
    await lockItems(tx, [...productIds, ...oldProducts.map(x => x.id)]);
    let before;
    if (update) {
      await tx.$queryRawUnsafe('SELECT id FROM "ProcurementSupplier" WHERE id=$1 FOR UPDATE', supplierId);
      before = await tx.procurementSupplier.findUnique({
        where: {
          id: supplierId
        }
      });
      if (!before) throw fail('采购供应商不存在', 404);
      version(before.version, req.body.version);
    }
    for (const productId of productIds) {
      const item = await tx.inventoryItem.findUnique({
        where: {
          id: productId
        }
      });
      if (!item?.purchaseEnabled) throw fail('绑定商品须开启采购用途', 409);
      if (item.procurementSupplierId && item.procurementSupplierId !== supplierId) throw fail('商品已绑定其他采购供应商，请先明确解绑', 409);
    }
    const supplier = update ? await tx.procurementSupplier.update({
      where: {
        id: supplierId
      },
      data: {
        name,
        version: {
          increment: 1
        }
      }
    }) : await tx.procurementSupplier.create({
      data: {
        id: supplierId,
        name,
        createdById: u.id
      }
    });
    await tx.inventoryItem.updateMany({
      where: {
        procurementSupplierId: supplierId,
        id: {
          notIn: productIds
        }
      },
      data: {
        procurementSupplierId: null,
        version: {
          increment: 1
        }
      }
    });
    await tx.inventoryItem.updateMany({
      where: {
        id: {
          in: productIds
        },
        procurementSupplierId: {
          not: supplierId
        }
      },
      data: {
        procurementSupplierId: supplierId,
        version: {
          increment: 1
        }
      }
    });
    // SQL NULL needs its own predicate.
    await tx.inventoryItem.updateMany({
      where: {
        id: {
          in: productIds
        },
        procurementSupplierId: null
      },
      data: {
        procurementSupplierId: supplierId,
        version: {
          increment: 1
        }
      }
    });
    await audit(tx, u, supplierId, null, update ? 'SUPPLIER_EDIT' : 'SUPPLIER_CREATE', before ? {
      ...before,
      productIds: oldProducts.map(x => x.id)
    } : undefined, {
      ...supplier,
      productIds
    }, op, payload);
    return {
      supplier
    };
  }, {
    timeout: 15000
  });
}
purchaseReceiptRouter.post('/procurement/suppliers', wrap(req => saveSupplier(req, false)));
purchaseReceiptRouter.put('/procurement/suppliers/:id', wrap(req => saveSupplier(req, true)));

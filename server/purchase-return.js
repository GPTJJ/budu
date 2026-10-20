import { Router } from 'express';
import { prisma } from './pg.js';
import { canUseProcurement, canAccessProcurementStore, isProcurementDeveloper, normalizeAccountPermissions } from '../shared/accountPermissions.js';
import { fail, id, json, digest, quantity, unit, date, reason, key, version } from './purchase-receipt-core.js';
import { assertExistingStore } from './store-operation-policy.js';
import { readProcurementHistory, parseHistoryFilters } from './procurement-history.js';

export const purchaseReturnRouter = Router();
const MAX_RECORDS = 100000;
const text = (v, max = 2000) => {
  if (v != null && typeof v !== 'string') throw fail('文字内容格式不正确');
  const s = (v || '').trim();
  if (s.length > max) throw fail(`文字内容最多${max}字`);
  return s;
};
export const contentStores = c => [...new Set([c?.storeKey, ...(c?.replacements || []).map(l => l.storeKey)].filter(Boolean))];
const allStores = r => [...new Set([...contentStores(r.content), ...contentStores(r.confirmedContent)])];
export const fullReturnScope = (u, r) => allStores(r).every(s => canAccessProcurementStore(u, s));
const visible = (u, r) => allStores(r).some(s => canAccessProcurementStore(u, s));
const assertFull = (u, r) => { if (!fullReturnScope(u, r)) throw fail('整单操作需要全部相关门店权限', 403); };

export async function procurementActor(tx, supplied, lock = false) {
  if (lock) await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id=$1 FOR SHARE', supplied.id);
  const u = await tx.user.findUnique({ where: { id: supplied.id } });
  if (!u) throw fail('未登录', 401);
  u.permissions = normalizeAccountPermissions(u.permissions, u.role);
  if (!canUseProcurement(u)) throw fail('无采购权限', 403);
  return u;
}
const handler = fn => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) {
    if (e.code === 'P2002') e = fail('请求标识已使用，请刷新后核对记录', 409);
    if (!e.status) console.error('[procurement-return]', e.code || e.name);
    res.status(e.status || 500).json({ error: e.status ? e.message : '采购记录操作失败，请刷新后核对记录' });
  }
};

function projectContent(u, c) {
  if (!c) return null;
  const ownSource = canAccessProcurementStore(u, c.storeKey);
  return { ...c, storeKey: ownSource ? c.storeKey : '', storeNameSnapshot: ownSource ? c.storeNameSnapshot : '',
    originalOrderId: ownSource ? c.originalOrderId : '', returnedDate: ownSource ? c.returnedDate : '',
    reason: ownSource ? c.reason : '', notes: ownSource ? c.notes : '',
    items: ownSource ? c.items : [], replacements: c.replacements.filter(l => l.storeKey ? canAccessProcurementStore(u, l.storeKey) : ownSource) };
}
export function presentReturn(u, r) {
  return { id: r.id, number: r.number, status: r.status, version: r.version,
    content: projectContent(u, r.content), confirmedContent: projectContent(u, r.confirmedContent),
    createdByName: r.createdByName, createdAt: r.createdAt, updatedAt: r.updatedAt,
    submittedByName: r.submittedByName, submittedAt: r.submittedAt,
    confirmedByName: r.confirmedByName, confirmedAt: r.confirmedAt, canEdit: fullReturnScope(u, r) };
}

async function prepare(tx, u, raw, previous, strict = false, confirmed = null) {
  const c = raw || {};
  const storeKey = text(c.storeKey, 100), supplierId = text(c.supplierId, 100);
  // A source store is required even in a partial draft, to establish its permission scope.
  if (!canAccessProcurementStore(u, storeKey)) throw fail('请选择有权限的退货来源门店', 403);
  const replacementRows = c.replacements || [], rows = c.items || [];
  if (!Array.isArray(rows) || !Array.isArray(replacementRows) || rows.length > 100 || replacementRows.length > 200) throw fail('每单最多100条退货、200条补货明细');
  const keys = [...new Set([storeKey, ...replacementRows.map(l => text(l.storeKey, 100)).filter(Boolean)])].sort();
  const stores = new Map();
  for (const s of keys) {
    if (!canAccessProcurementStore(u, s)) throw fail('无该门店权限', 403);
    stores.set(s, await assertExistingStore(tx, s, { lock: true }));
  }
  const supplier = supplierId ? await tx.procurementSupplier.findUnique({ where: { id: supplierId } }) : null;
  if (supplierId && !supplier) throw fail('供应商不存在');
  const originalOrderId = text(c.originalOrderId, 100);
  if (originalOrderId) {
    const order = await tx.procurementOrder.findUnique({ where: { id: originalOrderId } });
    if (!order || !canAccessProcurementStore(u, order.storeKey)) throw fail('无该关联采购单权限', 403);
    if (order.supplierId !== supplierId || order.storeKey !== storeKey || ['DRAFT','CANCELLED'].includes(order.status)) throw fail('关联采购单须为同供应商、同来源门店的有效订单');
  }
  const itemIds = [...new Set([...rows, ...replacementRows].map(l => text(l.itemId, 100)).filter(Boolean))].sort();
  for (const itemId of itemIds) await tx.$queryRawUnsafe('SELECT id FROM "InventoryItem" WHERE id=$1 FOR SHARE', itemId);
  const masters = new Map((await tx.inventoryItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true } })).map(i => [i.id, i]));
  const seenRows = new Set();
  const normalize = (l, replacement) => {
    const itemId = text(l.itemId, 100), rowId = text(l.rowId, 100) || id('line');
    if (seenRows.has(rowId)) throw fail('明细行标识重复');
    seenRows.add(rowId);
    if (itemId && !masters.has(itemId)) throw fail('商品不存在');
    const qty = text(l.quantity, 20), un = text(l.unit, 20);
    if (strict || qty) quantity(qty);
    if (strict || un) unit(un);
    if (strict && !itemId) throw fail('请完整选择商品');
    const prior = (replacement ? previous?.replacements : previous?.items)?.find(p => p.rowId === rowId && p.itemId === itemId);
    const line = { rowId, itemId, productNameSnapshot: prior?.productNameSnapshot || masters.get(itemId)?.name || '', quantity: qty, unit: un };
    if (replacement) {
      const receivedDate = text(l.receivedDate, 10), receivingStore = text(l.storeKey, 100);
      if (strict || receivedDate) date(receivedDate);
      if (strict && !receivingStore) throw fail('请选择补货接收门店');
      // Existing historical receipts remain editable after store closure. New or changed
      // receipt facts require a currently operating receiving store.
      const confirmedLine = confirmed?.replacements?.find(p => p.rowId === rowId);
      const sameFact = confirmedLine && ['itemId','quantity','unit','storeKey','receivedDate'].every(k => confirmedLine[k] === l[k]);
      if (receivingStore && !sameFact && stores.get(receivingStore)?.active !== true) throw fail('补货接收门店已停用，请选择可接收门店', 409);
      Object.assign(line, { storeKey: receivingStore, storeNameSnapshot: prior?.storeKey === receivingStore ? prior.storeNameSnapshot : stores.get(receivingStore)?.name || '', receivedDate, notes: text(l.notes) });
    }
    return line;
  };
  const returnedDate = text(c.returnedDate, 10), why = text(c.reason, 500);
  if (strict || returnedDate) date(returnedDate);
  if (strict) {
    if (!supplier || !rows.length) throw fail('请填写供应商及实际退回商品');
    reason(why);
  }
  return { supplierId, supplierNameSnapshot: previous?.supplierId === supplierId ? previous.supplierNameSnapshot : supplier?.name || '',
    storeKey, storeNameSnapshot: previous?.storeKey === storeKey ? previous.storeNameSnapshot : stores.get(storeKey).name,
    originalOrderId, returnedDate, reason: why, notes: text(c.notes),
    items: rows.map(l => normalize(l, false)), replacements: replacementRows.map(l => normalize(l, true)) };
}

async function retainProductRefs(tx, r) {
  const ids = [...new Set([r.content, r.confirmedContent].filter(Boolean).flatMap(c => [...c.items, ...c.replacements].map(l => l.itemId)).filter(Boolean))];
  await tx.procurementReturnProduct.deleteMany({ where: { returnId: r.id, itemId: { notIn: ids } } });
  if (ids.length) await tx.procurementReturnProduct.createMany({ data: ids.map(itemId => ({ returnId: r.id, itemId })), skipDuplicates: true });
}
async function writeAudit(tx, u, r, action, before, op, payload, why = '') {
  await tx.procurementAudit.create({ data: { id: id('pa'), entityId: r.id, action: 'RETURN_' + action,
    actorId: u.id, actorName: u.username, reason: why, before: before ? json(before) : undefined,
    after: json(r), operationKey: op, payloadHash: digest(payload) } });
}

purchaseReturnRouter.get('/procurement/return-options', handler(async req => {
  await procurementActor(prisma, req.user);
  const [suppliers, items] = await Promise.all([
    prisma.procurementSupplier.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' }, take: MAX_RECORDS + 1 }),
    prisma.inventoryItem.findMany({ select: { id: true, name: true, procurementSupplierId: true }, orderBy: { name: 'asc' }, take: MAX_RECORDS + 1 })
  ]);
  if (Math.max(items.length, suppliers.length) > MAX_RECORDS) throw fail('选项数量超出限制，请联系管理员', 413);
  return { suppliers, items };
}));
purchaseReturnRouter.get('/procurement/returns', handler(async req => {
  const u = await procurementActor(prisma, req.user);
  const rows = await prisma.procurementReturn.findMany({ where: isProcurementDeveloper(u) ? {} : { storeKeys: { hasSome: u.storeKeys || [] } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: MAX_RECORDS + 1 });
  if (rows.length > MAX_RECORDS) throw fail('结果超出限制，请缩小查询范围', 413);
  return { rows: rows.filter(r => visible(u, r)).map(r => presentReturn(u, r)) };
}));
purchaseReturnRouter.get('/procurement/returns/:id', handler(async req => {
  const u = await procurementActor(prisma, req.user), r = await prisma.procurementReturn.findUnique({ where: { id: req.params.id } });
  if (!r || !visible(u, r)) throw fail('记录不存在或无门店权限', 404);
  const history = await prisma.procurementAudit.findMany({ where: { entityId: r.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return { record: presentReturn(u, r), history: history.map(a => ({ id: a.id, action: a.action, actorName: a.actorName, createdAt: a.createdAt,
    reason: fullReturnScope(u, r) && (!a.before || fullReturnScope(u, a.before)) && fullReturnScope(u, a.after) ? a.reason : '',
    before: a.before && fullReturnScope(u, a.before) ? presentReturn(u, a.before) : null,
    after: fullReturnScope(u, a.after) ? presentReturn(u, a.after) : null })) };
}));
purchaseReturnRouter.post('/procurement/returns', handler(req => prisma.$transaction(async tx => {
  const u = await procurementActor(tx, req.user, true), op = key(req.body.requestKey), payload = { action: 'CREATE', ...req.body };
  await tx.$queryRawUnsafe('SELECT true AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))', op);
  const existing = await tx.procurementReturn.findUnique({ where: { createRequestKey: op } });
  if (existing) {
    assertFull(u, existing);
    if (existing.createdById !== u.id || existing.createPayloadHash !== digest(payload)) throw fail('同一请求标识不可用于不同内容', 409);
    return { record: presentReturn(u, existing) };
  }
  const content = await prepare(tx, u, req.body.content, null);
  const r = await tx.procurementReturn.create({ data: { id: id('pret'), number: 'TH-' + crypto.randomUUID(), content, storeKeys: contentStores(content), createdById: u.id, createdByName: u.username, createRequestKey: op, createPayloadHash: digest(payload) } });
  await retainProductRefs(tx, r);
  await writeAudit(tx, u, r, 'CREATE', null, op, payload);
  return { record: presentReturn(u, r) };
}, { timeout: 15000 })));

for (const action of ['save','submit','withdraw','return','confirm','reopen']) purchaseReturnRouter.post('/procurement/returns/:id/' + action, handler(req => prisma.$transaction(async tx => {
  const u = await procurementActor(tx, req.user, true), op = key(req.body.requestKey), payload = { ...req.body, action, id: req.params.id };
  await tx.$queryRawUnsafe('SELECT id FROM "ProcurementReturn" WHERE id=$1 FOR UPDATE', req.params.id);
  const r = await tx.procurementReturn.findUnique({ where: { id: req.params.id } });
  if (!r || !visible(u, r)) throw fail('记录不存在或无门店权限', 404);
  assertFull(u, r);
  if (['return','confirm','reopen'].includes(action) && !isProcurementDeveloper(u)) throw fail('仅开发者可最终确认或退回、重开', 403);
  const prior = await tx.procurementAudit.findUnique({ where: { operationKey: op } });
  if (prior) {
    if (prior.entityId !== r.id || prior.actorId !== u.id || prior.payloadHash !== digest(payload)) throw fail('同一请求标识不可用于不同内容', 409);
    return { record: presentReturn(u, r) };
  }
  version(r.version, req.body.version);
  const expected = { save: 'PROCESSING', submit: 'PROCESSING', withdraw: 'PENDING', return: 'PENDING', confirm: 'PENDING', reopen: 'COMPLETED' }[action];
  if (r.status !== expected) throw fail('记录状态已变化，请刷新后重试', 409);
  const why = ['return','reopen'].includes(action) ? reason(req.body.reason) : '';
  const data = { version: { increment: 1 } };
  if (action === 'save') {
    data.content = await prepare(tx, u, req.body.content, r.content, false, r.confirmedContent);
    data.storeKeys = [...new Set([...contentStores(data.content), ...contentStores(r.confirmedContent)])];
  }
  if (action === 'submit') {
    await prepare(tx, u, r.content, r.content, true, r.confirmedContent);
    Object.assign(data, { status: 'PENDING', submittedByName: u.username, submittedAt: new Date() });
  }
  if (['withdraw','return','reopen'].includes(action)) data.status = 'PROCESSING';
  if (action === 'confirm') Object.assign(data, { status: 'COMPLETED', confirmedContent: r.content, confirmedById: u.id, confirmedByName: u.username, confirmedAt: new Date(), storeKeys: contentStores(r.content) });
  const after = await tx.procurementReturn.update({ where: { id: r.id }, data });
  await retainProductRefs(tx, after);
  await writeAudit(tx, u, after, action.toUpperCase(), r, op, payload, why);
  return { record: presentReturn(u, after) };
}, { timeout: 15000 })));

purchaseReturnRouter.get('/procurement/history', handler(req => prisma.$transaction(async tx => {
  const u = await procurementActor(tx, req.user, true);
  return readProcurementHistory(tx, u, parseHistoryFilters(req.query));
}, { isolationLevel: 'RepeatableRead', timeout: 30000 })));

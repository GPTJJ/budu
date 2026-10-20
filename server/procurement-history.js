import { canAccessProcurementStore, canManageProcurement, isProcurementDeveloper } from '../shared/accountPermissions.js';
import { fail, date, sum } from './purchase-receipt-core.js';

export const procurementLabels = {
  DRAFT: '准备中', ORDERED: '待收货', RECEIVING: '收货处理中', CLOSED: '已结束', CANCELLED: '已取消',
  PENDING: '待核准', APPROVED: '已核准', RETURNED: '已退回修改',
  PROCESSING: '处理中', COMPLETED: '已完成'
};
export const returnLabel = s => s === 'PENDING' ? '待确认' : procurementLabels[s] || s;
const types = ['ORDER','RECEIPT','RETURN','REPLACEMENT'];
const statuses = { orderStatus: ['DRAFT','ORDERED','RECEIVING','CLOSED','CANCELLED'], receiptStatus: ['PENDING','APPROVED','RETURNED'], returnStatus: ['PROCESSING','PENDING','COMPLETED'] };
const LIMIT = 100000;
export function parseHistoryFilters(query) {
  const f = {};
  for (const k of ['start','end','supplierId','storeKey','itemId','type','orderStatus','receiptStatus','returnStatus','keyword']) {
    if (query[k] != null && (typeof query[k] !== 'string' || query[k].length > 200)) throw fail('查询条件不正确');
    f[k] = query[k]?.trim() || '';
  }
  for (const k of ['start','end']) if (f[k]) date(f[k]);
  if (f.start && f.end && f.start > f.end) throw fail('起始日期不能晚于结束日期');
  if (f.type && !types.includes(f.type)) throw fail('记录类型不正确');
  for (const [k, values] of Object.entries(statuses)) if (f[k] && !values.includes(f[k])) throw fail('记录状态不正确');
  return f;
}
const businessDay = value => value ? new Date(value).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) : '';
const storedDay = value => value ? new Date(value).toISOString().slice(0, 10) : '';
const validQty = q => /^\d{1,6}(\.\d{1,3})?$/.test(String(q)) && Number(q) > 0;
const sortRows = rows => rows.sort((a, b) => [a.date, a.number, a.itemName, a.id].join('\0').localeCompare([b.date, b.number, b.itemName, b.id].join('\0'), 'zh-CN'));

// One projection owns UI and export filtering, row authorization and fact aggregation.
export function projectProcurementHistory(u, orders, returns, f) {
  if (f.storeKey && !canAccessProcurementStore(u, f.storeKey)) throw fail('无查询门店权限', 403);
  const purchases = [], events = [];
  const match = row => canAccessProcurementStore(u, row.storeKey)
    && (!f.type || f.type === row.type)
    && (!f.start || row.date && row.date >= f.start) && (!f.end || row.date && row.date <= f.end)
    && (!f.supplierId || row.supplierId === f.supplierId) && (!f.storeKey || row.storeKey === f.storeKey)
    && (!f.itemId || row.itemId === f.itemId)
    && (!f.keyword || [row.number, row.relatedNumber, row.supplierName, row.storeName, row.itemName, row.notes].join(' ').toLocaleLowerCase().includes(f.keyword.toLocaleLowerCase()));
  for (const o of orders) {
    if (!canAccessProcurementStore(u, o.storeKey) || o.status === 'DRAFT' && !canManageProcurement(u)) continue;
    const common = { supplierId: o.supplierId || '', supplierName: o.supplierNameSnapshot, storeKey: o.storeKey, storeName: o.storeNameSnapshot };
    const orderLines = o.status === 'DRAFT' ? (o.draftContent?.items || []).map((l, i) => ({ id: `${o.id}-${i}`, inventoryItemId: l.itemId, productNameSnapshot: l.productNameSnapshot, unitSnapshot: l.unit, orderedQty: l.quantity })) : o.lines;
    if (!f.orderStatus || o.status === f.orderStatus) for (const l of orderLines) {
      const row = { ...common, id: l.id, type: 'ORDER', date: businessDay(o.orderedAt), number: o.id, relatedNumber: '', itemId: l.inventoryItemId,
        itemName: l.productNameSnapshot, unit: l.unitSnapshot, quantity: String(l.orderedQty || ''), status: procurementLabels[o.status], registeredBy: o.createdByName,
        notes: o.draftContent?.notes || '', counted: !['DRAFT','CANCELLED'].includes(o.status) && !!o.orderedAt && validQty(l.orderedQty) };
      if (match(row)) purchases.push(row);
    }
    for (const r of o.receipts) {
      if (f.receiptStatus && r.status !== f.receiptStatus) continue;
      for (const l of r.lines) {
        const original = o.lines.find(x => x.id === l.orderLineId);
        if (!original) throw fail('收货关联明细不完整，请核对后重试', 409);
        const row = { ...common, id: l.id, type: 'RECEIPT', date: storedDay(r.receivedDate), number: `${o.id}/${r.sequence}`, relatedNumber: o.id,
          itemId: original.inventoryItemId, itemName: original.productNameSnapshot, unit: original.unitSnapshot, quantity: String(l.receivedQty),
          status: procurementLabels[r.status], registeredBy: r.submittedByName, confirmedBy: r.approvedByName || '', notes: '', counted: r.status === 'APPROVED' };
        if (match(row)) events.push(row);
      }
    }
  }
  for (const r of returns) {
    if (f.returnStatus && r.status !== f.returnStatus) continue;
    const c = r.confirmedContent || r.content, reopened = !!r.confirmedContent && r.status !== 'COMPLETED';
    const common = { supplierId: c.supplierId, supplierName: c.supplierNameSnapshot, number: r.number, status: returnLabel(r.status), registeredBy: r.createdByName,
      confirmedBy: r.confirmedByName || '', counted: !!r.confirmedContent };
    const note = value => [value, reopened ? '重开处理中，事实数量为上次已确认值' : ''].filter(Boolean).join('；');
    for (const l of c.items) {
      const row = { ...common, id: `${r.id}/${l.rowId}`, type: 'RETURN', date: c.returnedDate, relatedNumber: c.originalOrderId || '', storeKey: c.storeKey, storeName: c.storeNameSnapshot,
        itemId: l.itemId, itemName: l.productNameSnapshot, unit: l.unit, quantity: l.quantity, notes: note([c.reason, c.notes].filter(Boolean).join('；')) };
      if (validQty(l.quantity) && l.itemId && l.unit && row.date && match(row)) events.push(row);
    }
    for (const l of c.replacements) {
      const row = { ...common, id: `${r.id}/${l.rowId}`, type: 'REPLACEMENT', date: l.receivedDate, relatedNumber: r.number, storeKey: l.storeKey, storeName: l.storeNameSnapshot,
        itemId: l.itemId, itemName: l.productNameSnapshot, unit: l.unit, quantity: l.quantity, notes: note(l.notes) };
      if (validQty(l.quantity) && l.itemId && l.unit && row.date && match(row)) events.push(row);
    }
  }
  if (purchases.length + events.length > LIMIT * 2) throw fail('匹配明细超出导出限制，请缩小查询范围；未导出任何文件', 413);
  const groups = new Map();
  for (const row of [...purchases, ...events]) {
    if (!row.counted) continue;
    const groupKey = JSON.stringify([row.supplierId, row.storeKey, row.itemId, row.unit]);
    if (!groups.has(groupKey)) groups.set(groupKey, { supplierName: row.supplierName, storeName: row.storeName, itemName: row.itemName, unit: row.unit, ordered: '0', received: '0', returned: '0', replacement: '0' });
    const g = groups.get(groupKey), field = { ORDER: 'ordered', RECEIPT: 'received', RETURN: 'returned', REPLACEMENT: 'replacement' }[row.type];
    g[field] = sum([g[field], row.quantity]);
  }
  return { filters: f, purchases: sortRows(purchases), events: sortRows(events), summary: [...groups.values()].sort((a,b) => [a.supplierName,a.storeName,a.itemName,a.unit].join('\0').localeCompare([b.supplierName,b.storeName,b.itemName,b.unit].join('\0'), 'zh-CN')),
    complete: true, totalRows: purchases.length + events.length };
}

export async function readProcurementHistory(tx, u, f) {
  if (f.storeKey && !canAccessProcurementStore(u, f.storeKey)) throw fail('无查询门店权限', 403);
  const permitted = isProcurementDeveloper(u) ? {} : { storeKey: { in: u.storeKeys || [] } };
  // Receipts are fetched independently of the order date: a prior-month order
  // must not hide this month's received events. Bound scans fail explicitly.
  const orders = await tx.procurementOrder.findMany({ where: { ...permitted, ...(f.supplierId ? { supplierId: f.supplierId } : {}), ...(f.storeKey ? { storeKey: f.storeKey } : {}) },
    include: { lines: true, receipts: { include: { lines: true } } }, take: LIMIT + 1 });
  const returns = await tx.procurementReturn.findMany({ where: isProcurementDeveloper(u) ? {} : { storeKeys: { hasSome: u.storeKeys || [] } }, take: LIMIT + 1 });
  if (orders.length > LIMIT || returns.length > LIMIT) throw fail('历史记录超出完整查询限制，请联系管理员；本次结果未返回', 413);
  const approvedReceipts = orders.flatMap(o => o.receipts.filter(r => r.status === 'APPROVED'));
  const approvals = await tx.procurementAudit.findMany({ where: { entityId: { in: approvedReceipts.map(r => r.id) }, action: 'APPROVE' }, orderBy: { createdAt: 'desc' }, select: { entityId: true, actorName: true, after: true } });
  // Existing receipt audits already hold the approver's name at confirmation.
  // Prefer that snapshot over the account's possibly renamed current username.
  for (const r of approvedReceipts) r.approvedByName = approvals.find(a => a.entityId === r.id && a.after?.version === r.version)?.actorName || '';
  const result = projectProcurementHistory(u, orders, returns, f);
  const supplier = f.supplierId ? await tx.procurementSupplier.findUnique({ where: { id: f.supplierId }, select: { name: true } }) : null;
  const store = f.storeKey ? await tx.store.findUnique({ where: { key: f.storeKey }, select: { name: true } }) : null;
  const item = f.itemId ? await tx.inventoryItem.findUnique({ where: { id: f.itemId }, select: { name: true } }) : null;
  result.filterLabels = { supplier: supplier?.name || f.supplierId || '全部', store: store?.name || '授权门店', item: item?.name || f.itemId || '全部' };
  return result;
}

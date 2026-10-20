import test from 'node:test';
import assert from 'node:assert/strict';
import { projectProcurementHistory } from '../server/procurement-history.js';
import { normalizeAccountPermissions } from '../shared/accountPermissions.js';
const user = { id: 'synthetic-dev', role: 'developer', status: 'active', permissions: normalizeAccountPermissions({}, 'developer') };
const filters = { start: '2026-09-01', end: '2026-09-30' };
const order = (id, day, name, itemId = 'item-1', quantity = '100') => ({
  id, orderedAt: `2026-09-${day}T02:00:00Z`, status: 'ORDERED', supplierId: 'supplier-1', storeKey: 'store-1',
  supplierNameSnapshot: '供应商' + name, storeNameSnapshot: '门店' + name, createdByName: '合成备单人',
  lines: [{ id: 'line-' + id, inventoryItemId: itemId, productNameSnapshot: '商品' + name, unitSnapshot: '盒', orderedQty: quantity }], receipts: []
});
test('R1-03 latest valid business-date snapshot is independent of input order', () => {
  const orders = [order('old', '01', '旧名'), order('new', '20', '新名')];
  const a = projectProcurementHistory(user, orders, [], filters), b = projectProcurementHistory(user, [...orders].reverse(), [], filters);
  assert.deepEqual(a.summary,b.summary); assert.deepEqual(a.purchases,b.purchases);
  assert.equal(a.summary.length,1); assert.equal(a.summary[0].ordered,'200');
  assert.deepEqual([a.summary[0].supplierName,a.summary[0].storeName,a.summary[0].itemName],['供应商新名','门店新名','商品新名']);
  assert.deepEqual(a.purchases.map(r=>r.itemName),['商品旧名','商品新名']);
});
test('R1-03 same-day stable-ID tie and confirmed events ignore unconfirmed future names', () => {
  const orders = [order('a','10','甲'),order('z','10','乙')];
  const content = (name,day) => ({supplierId:'supplier-1',supplierNameSnapshot:'供应商'+name,storeKey:'store-1',storeNameSnapshot:'门店'+name,returnedDate:'2026-09-'+day,reason:'合成',items:[{rowId:'line',itemId:'item-1',productNameSnapshot:'商品'+name,quantity:'5',unit:'盒'}],replacements:[]});
  const returns = [{id:'confirmed',number:'TH-C',status:'PROCESSING',content:content('未确认修订','30'),confirmedContent:content('确认历史','15')}, {id:'draft',number:'TH-D',status:'PENDING',content:content('未确认未来','29')}];
  const a=projectProcurementHistory(user,orders,returns,filters),b=projectProcurementHistory(user,[...orders].reverse(),[...returns].reverse(),filters);
  assert.deepEqual(a.summary,b.summary);assert.deepEqual(a.events,b.events);
  assert.equal(a.summary[0].itemName,'商品确认历史');assert.equal(a.summary[0].returned,'5');
  const tied=projectProcurementHistory(user,orders,[],filters);
  assert.equal(tied.summary[0].itemName,'商品乙');
});
test('R1-03 equal visible names still sort by stable group identity; units and IDs stay separate', () => {
  const orders=[order('b','10','同名','item-b','11'),order('a','10','同名','item-a','13')];
  const otherUnit=order('c','11','同名','item-a','17');otherUnit.lines[0].unitSnapshot='克';orders.push(otherUnit);
  const reference=projectProcurementHistory(user,orders,[],filters);
  for(const input of [[...orders].reverse(),[orders[2],orders[0],orders[1]],[orders[1],orders[2],orders[0]]]) assert.deepEqual(projectProcurementHistory(user,input,[],filters).summary,reference.summary);
  assert.equal(reference.summary.length,3);assert.deepEqual(reference.summary.map(g=>g.ordered).sort(),['11','13','17']);
});

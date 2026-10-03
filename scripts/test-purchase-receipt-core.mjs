import test from 'node:test';
import assert from 'node:assert/strict';
import { quantity, sum, date, unique, reason } from '../server/purchase-receipt-core.js';
import { normalizeAccountPermissions, canManageProcurement, canAccessProcurementStore, isProcurementDeveloper } from '../shared/accountPermissions.js';
test('C03 quantities retain exact decimal boundaries and reject silent rounding', () => {
  for (const q of ['0.001', '1.005', '999999.999']) assert.equal(quantity(q), q);
  for (const q of ['', 0, '0', '-1', 'NaN', 'Infinity', '1e3', '1.0001', '1000000', ' 1', '1.', 'a']) assert.throws(() => quantity(q));
  assert.equal(sum(['4000', '3500', '2480']), '9980');
  assert.equal(sum(Array(50).fill('999999.999')), '49999999.95');
  assert.equal(sum(['0.001', '1.005']), '1.006');
});
test('C03 invalid calendar dates and repeated item lines are rejected', () => {
  assert.equal(date('2026-10-03').toISOString(), '2026-10-03T00:00:00.000Z');
  for (const d of ['2026-02-30', '2026-13-01', '03/10/2026', '']) assert.throws(() => date(d));
  assert.throws(() => unique([{
    itemId: 'x'
  }, {
    itemId: 'x'
  }], 'itemId'));
  assert.throws(() => reason('  '));
});
test('A02/A03 explicit purchase grant never grants developer or unrestricted store scope', () => {
  for (const status of ['disabled', 'pending', undefined]) assert.equal(isProcurementDeveloper({role: 'developer', status}), false);
  for (const role of ['staff', 'admin', 'finance', 'manager']) {
    const u = {
      id: role,
      role,
      status: 'active',
      storeKeys: ['s1'],
      permissions: normalizeAccountPermissions({}, role)
    };
    assert.equal(canManageProcurement(u), false);
    u.permissions.purchaseManage = true;
    assert.equal(canManageProcurement(u), true);
    assert.equal(isProcurementDeveloper(u), false);
    assert.equal(canAccessProcurementStore(u, 's1'), true);
    assert.equal(canAccessProcurementStore(u, 's2'), false);
  }
});

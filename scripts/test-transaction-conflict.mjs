import assert from 'node:assert/strict'
import test from 'node:test'
import { isRetryableTransactionConflict as retryable } from '../server/transaction-conflict.js'

test('only proven structured serialization errors are retryable', () => {
  for (const error of [{ code: 'P2034' }, { code: '40001' }, { code: 'P2010', meta: { code: '40001', message: 'could not serialize access due to concurrent update' } }]) assert.equal(retryable(error), true)
  for (const error of [null, undefined, '40001', {}, { code: 'P9999' }, { code: 'P2010' },
    ...['42601', '23505', '42501', '22003', '40P01'].map(code => ({ code: 'P2010', meta: { code } })),
    ...[null, '40001', 40001, [], { code: 40001 }, { message: '40001' }, Object.create({ code: '40001' })].map(meta => ({ code: 'P2010', meta })),
    { code: 'P2010', message: 'syntax error referencing 40001' }, { code: 'P9999', meta: { code: '40001' } },
  ]) assert.equal(retryable(error), false)
  assert.equal(retryable({ code: '40P01' }), false)
  assert.equal(retryable({ code: '40P01' }, { allowDirectDeadlock: true }), true)
})

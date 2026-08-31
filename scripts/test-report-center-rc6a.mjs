import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateRentCents, deterministicAllocateCents } from '../server/operating-cost-authority.js'

test('rent modes use integer cents and never substitute a missing gross basis', () => {
  const base = { grossCents: 100_000n, netRevenueCents: 80_000n, selectedDays: 30, totalDays: 30 }
  assert.equal(calculateRentCents({ mode: 'FIXED', fixedAmountCents: 20_000n }, base).amountCents, 20_000n)
  assert.equal(calculateRentCents({ mode: 'PERCENT', percentageBps: 1200, percentageBasis: 'GROSS_SALES' }, base).amountCents, 12_000n)
  assert.equal(calculateRentCents({ mode: 'PERCENT', percentageBps: 1200, percentageBasis: 'NET_REVENUE' }, base).amountCents, 9_600n)
  assert.equal(calculateRentCents({ mode: 'FIXED_PLUS_PERCENT', fixedAmountCents: 20_000n, percentageBps: 1200, percentageBasis: 'GROSS_SALES' }, base).amountCents, 32_000n)
  assert.equal(calculateRentCents({ mode: 'MAX_FIXED_PERCENT', fixedAmountCents: 10_000n, percentageBps: 1200, percentageBasis: 'GROSS_SALES' }, base).amountCents, 12_000n)
  assert.deepEqual(calculateRentCents({ mode: 'PERCENT', percentageBps: 1200, percentageBasis: 'GROSS_SALES' }, { ...base, grossCents: null }), { amountCents: null, reasonCode: 'INCOMPLETE_RENT_BASIS' })
})

test('fixed costs prorate by calendar day and payroll allocation reconciles exactly', () => {
  assert.equal(calculateRentCents({ mode: 'FIXED', fixedAmountCents: 31_000n }, { grossCents: null, netRevenueCents: null, selectedDays: 10, totalDays: 31 }).amountCents, 10_000n)
  const rows = deterministicAllocateCents(600_01n, [{ storeKey: 'a', weight: 8000n }, { storeKey: 'b', weight: 4000n }])
  assert.deepEqual(rows.map((row) => row.amountCents), [40_000n, 20_001n])
  assert.equal(rows.reduce((sum, row) => sum + row.amountCents, 0n), 60_001n)
})


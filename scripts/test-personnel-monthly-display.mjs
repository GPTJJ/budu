#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { personnelMonthlyComponents } from '../src/utils/payrollDisplay.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const personnelSource = fs.readFileSync(path.join(root, 'src/components/PersonnelPage.jsx'), 'utf8')

function components(record, options) {
  return personnelMonthlyComponents(record, options)
}

const controlled = components({
  basePay: 1000,
  commission: 300,
  transferSubsidy: 20,
  bigBonus: 80,
  salaryAdjustment: 50,
  salary: 1450,
})
assert.deepEqual(controlled, {
  basePay: 1000,
  commission: 300,
  transferSubsidy: 20,
  bigBonus: 80,
  salaryAdjustment: 50,
  salary: 1450,
})
assert.equal(controlled.basePay + controlled.commission + controlled.transferSubsidy + controlled.bigBonus + controlled.salaryAdjustment, controlled.salary)

assert.deepEqual(components({ commission: 100, bigBonus: 50 }), {
  basePay: 0, commission: 100, transferSubsidy: 0, bigBonus: 50, salaryAdjustment: 0, salary: 0,
})
assert.equal(components({ commission: 100, bigBonus: 0 }).commission, 100)
assert.equal(components({ commission: 100, bigBonus: 0 }).bigBonus, 0)
assert.equal(components({ commission: 0, bigBonus: 100 }).commission, 0)
assert.equal(components({ commission: 0, bigBonus: 100 }).bigBonus, 100)
assert.equal(components({ commission: 0, bigBonus: 0 }).commission, 0)
assert.equal(components({ commission: 0, bigBonus: 0 }).bigBonus, 0)

const adjustmentOnly = components({
  basePay: 0,
  commission: 0,
  transferSubsidy: 0,
  bigBonus: 0,
  salaryAdjustment: 500,
  salary: 500,
})
assert.deepEqual(adjustmentOnly, {
  basePay: 0, commission: 0, transferSubsidy: 0, bigBonus: 0, salaryAdjustment: 500, salary: 500,
})

const byEmployeeId = new Map([
  ['emp-A', { employeeId: 'emp-A', name: '张伟', commission: 100, bigBonus: 50 }],
  ['emp-B', { employeeId: 'emp-B', name: '张伟', commission: 200, bigBonus: 0 }],
])
const empA = components(byEmployeeId.get('emp-A'))
const empB = components(byEmployeeId.get('emp-B'))
assert.equal(empA.commission, 100)
assert.equal(empA.bigBonus, 50)
assert.equal(empB.commission, 200)
assert.equal(empB.bigBonus, 0)

const legacyUnique = components({ commission: 20, bigBonus: 30, salary: 50 })
assert.equal(legacyUnique.commission, 20)
assert.equal(legacyUnique.bigBonus, 30)
const legacyAmbiguous = components({ commission: 20, bigBonus: 30, salary: 50 }, { legacyAmbiguous: true })
assert.ok(Object.values(legacyAmbiguous).every((value) => value === null))

assert.match(personnelSource, /payrollDisplay\.byEmployeeId\.get\(d\.id\)/)
assert.match(personnelSource, /weekStart \|\| day \? periodPerf : emp\.commission/)
assert.match(personnelSource, /day \|\| weekStart \? 0 : emp\.bigBonus/)
assert.doesNotMatch(personnelSource, /emp\.perf\s*\+\s*emp\.big/)

console.log('Gate 29G Personnel monthly component display tests: PASS')

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const skillPath = path.join(root, '.agents/skills/budu-payroll-audit/SKILL.md')
const routerPath = path.join(root, '.agents/skills/budu-task-router/SKILL.md')
const procedurePath = path.join(root, '.agents/skills/budu-payroll-audit/references/audit-procedure.md')
const reportPath = path.join(root, '.agents/skills/budu-payroll-audit/references/report-contract.md')

const skill = fs.readFileSync(skillPath, 'utf8')
const router = fs.readFileSync(routerPath, 'utf8')
const procedure = fs.readFileSync(procedurePath, 'utf8')
const report = fs.readFileSync(reportPath, 'utf8')

function routeIntent(input) {
  const settlement = /(已经.*发|发了多少钱|还欠|是否已经支付|银行.*转)/u
  const payroll = /(工资|薪资|薪酬|payroll)/iu
  const correctness = /(审查|核对|检查|算得对|算对|金额对不对|帮我查|看看)/u
  if (settlement.test(input)) return 'PAYROLL_SETTLEMENT'
  if (payroll.test(input) && correctness.test(input)) return 'budu-payroll-audit'
  return 'OTHER'
}

function assertClauses(source, clauses) {
  for (const clause of clauses) {
    assert.match(source, clause)
  }
}

test('skill metadata and router use the canonical skill name', () => {
  assert.match(skill, /^---\nname: budu-payroll-audit\n/m)
  assert.match(skill, /Always STRICT and read-only\./)
  assert.match(router, /route payroll-correctness audits to budu-payroll-audit/)
  assert.match(router, /always `budu-payroll-audit` and STRICT/)
  assert.doesNotMatch(`${skill}\n${router}`, /budou-payroll-audit/)
})

test('routing contract accepts payroll-correctness prompts and rejects settlement', () => {
  const cases = [
    ['审查李飞燕8月工资', 'budu-payroll-audit'],
    ['检查隋晓8月15日工资', 'budu-payroll-audit'],
    ['陈文慧这个月工资算对了吗', 'budu-payroll-audit'],
    ['审查所有员工上个月工资', 'budu-payroll-audit'],
    ['审查卡皮巴拉本月薪资', 'budu-payroll-audit'],
    ['李飞燕已经发了多少钱', 'PAYROLL_SETTLEMENT'],
  ]

  for (const [input, expected] of cases) {
    assert.equal(routeIntent(input), expected, input)
  }
  assert.match(router, /“已经发了多少” or “还欠多少” are payment\/settlement reconciliation/)
})

test('A: lawful actual attendance can pass despite a Schedule difference', () => {
  assertClauses(skill, [
    /Schedule is plan, not payroll authority/,
    /A Schedule difference does not by itself make payroll wrong/,
    /payroll may PASS while Schedule reconciliation remains REVIEW/,
  ])
})

test('B: missing actualHours is never replaced with Schedule or default hours', () => {
  assert.match(skill, /Never substitute Schedule hours, default 8h/)
  assert.match(skill, /Missing\/invalid required facts fail closed/)
})

test('C: missing or ambiguous employee identity never falls back to a name', () => {
  assert.match(skill, /Zero or multiple matches return `IDENTITY_REVIEW_REQUIRED`/)
  assert.match(skill, /never infer identity from names, snapshots, Schedule, or legacy rows/)
})

test('D: a one-cent employee-card difference is a mismatch with fixed direction', () => {
  assert.match(skill, /differenceCents = employeeCardCents - authoritativePayrollCents/)
  assert.match(skill, /any nonzero difference, including one cent, is `MISMATCH`/)
  assert.match(report, /Employee card - Authoritative payroll/)
})

test('E/F: PREVIEW excludes an unfinished current day while FINAL includes the last day', () => {
  assert.match(skill, /Default an unfinished current-period request to `PREVIEW`: exclude the current business day/)
  assert.match(skill, /Use `FINAL`.*Cover the complete requested period; do not skip the last day/s)
  assert.match(procedure, /In PREVIEW, current business day is `IN_PROGRESS` and outside the effective period/)
  assert.match(procedure, /In FINAL, a missing required last-day fact is a blocker/)
})

test('G: Cardbara is audited normally and labelled 老板替班', () => {
  assert.match(skill, /Cardbara is a normal auditable employee\/business participant with business role `老板替班`/)
  assert.match(procedure, /Cardbara is not a special exclusion/)
})

test('H: audit findings produce options without mutations', () => {
  assert.match(skill, /\*\*AUDIT IS NOT REPAIR\.\*\*/)
  assert.match(skill, /Findings lead only to evidence, impact, options, and required confirmation/)
  assert.match(report, /`NO ACTION EXECUTED`/)
  assert.match(report, /No production changes were performed\./)
})

test('formal report contract is persistent, dynamic, and non-secret', () => {
  assert.match(skill, /preferring `docs\/audits\/payroll\/`/)
  assert.match(report, /# BUDU PAYROLL AUDIT REPORT/)
  assert.match(report, /Render every component returned by the current Payroll authority/)
  assert.match(report, /Missing values are `—`, never zero/)
  assert.match(report, /Do not include passwords, tokens, webhook URLs, credentials/)
})

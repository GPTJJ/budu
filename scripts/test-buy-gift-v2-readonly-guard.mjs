/**
 * 买赠 v2 只读保护（OS 旧面板）
 *
 * 两层断言：
 *  1. 纯函数行为：v1 / 不存在 → 允许写；v2（rules[]，含空数组）→ 409 拒绝；只读摘要不得泄漏成可编辑表单。
 *  2. 接线契约：PUT 必须在 .set() 之前写前重读并经过 buyGiftWriteDecision；
 *     GET 必须回 readOnly / ruleVersion / v2 摘要；前端必须在 readOnly 时禁用保存。
 *
 * 运行：node --test scripts/test-buy-gift-v2-readonly-guard.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  isV2BuyGiftDoc,
  buyGiftWriteDecision,
  buyGiftV2Summary,
  BUY_GIFT_V2_READ_ONLY_REASON,
} from '../server/buy-gift-guard.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const V1_DOC = {
  active: true,
  triggerType: 'category',
  triggerCategory: '生巧克力',
  triggerProductIds: [],
  tiers: [{ minQty: 2, giftProductId: 'bean', giftQty: 1, label: '满2盒赠1罐豆' }],
  startAt: null,
  endAt: null,
}
const V2_DOC = {
  active: false,
  version: 2,
  rules: [{ id: 'candy', category: '糖果', mode: 'stepCumulative', steps: [{ paid: 10, gift: 3 }] }],
}

test('v1 文档不是 v2，允许旧面板保存', () => {
  assert.equal(isV2BuyGiftDoc(V1_DOC), false)
  assert.deepEqual(buyGiftWriteDecision(V1_DOC).allow, true)
})

test('文档不存在允许初始化（由旧面板或运维动作显式写入）', () => {
  assert.equal(isV2BuyGiftDoc(null), false)
  assert.equal(isV2BuyGiftDoc(undefined), false)
  assert.equal(buyGiftWriteDecision(null).allow, true)
})

test('v2 文档拒绝保存：409 + BUY_GIFT_V2_READ_ONLY', () => {
  assert.equal(isV2BuyGiftDoc(V2_DOC), true)
  const decision = buyGiftWriteDecision(V2_DOC)
  assert.equal(decision.allow, false)
  assert.equal(decision.status, 409)
  assert.equal(decision.code, 'BUY_GIFT_V2_READ_ONLY')
  assert.match(decision.message, /v2/)
})

test('停用的 v2 同样拒绝：active:false 不是放行理由', () => {
  assert.equal(V2_DOC.active, false)
  assert.equal(buyGiftWriteDecision(V2_DOC).allow, false)
})

test('空 rules[] 也算 v2：与小程序「带 rules 字段即 v2」口径一致', () => {
  const doc = { active: false, rules: [] }
  assert.equal(isV2BuyGiftDoc(doc), true)
  assert.equal(buyGiftWriteDecision(doc).allow, false)
})

test('rules 非数组不误判为 v2', () => {
  assert.equal(isV2BuyGiftDoc({ active: true, rules: 'nope' }), false)
})

test('v2 摘要只含只读信息，不含可提交的 tiers/trigger 字段', () => {
  const summary = buyGiftV2Summary(V2_DOC)
  assert.equal(summary.active, false)
  assert.equal(summary.rules.length, 1)
  assert.equal(summary.rules[0].id, 'candy')
  assert.equal(summary.rules[0].mode, 'stepCumulative')
  assert.equal('tiers' in summary, false)
  assert.equal('triggerCategory' in summary, false)
  assert.equal(buyGiftV2Summary(V1_DOC), null)
  assert.ok(BUY_GIFT_V2_READ_ONLY_REASON.length > 10)
})

test('接线：PUT 在 .set() 之前写前重读并经过 buyGiftWriteDecision，且读取失败 fail-closed', () => {
  const source = readFileSync(join(ROOT, 'server/online-catalog.js'), 'utf8')
  const putStart = source.indexOf("onlineCatalogRouter.put('/online-catalog/buy-gift'")
  assert.ok(putStart > 0, '必须存在买赠 PUT 路由')
  const put = source.slice(putStart, putStart + 4000)

  const readAt = put.indexOf("await db.collection('promotions').doc(BUY_GIFT_DOC).get()")
  const decisionAt = put.indexOf('buyGiftWriteDecision(existing)')
  const writeAt = put.indexOf(".doc(BUY_GIFT_DOC).set(")
  assert.ok(readAt > 0, 'PUT 必须在写入前重读现有文档')
  assert.ok(decisionAt > readAt, '裁决必须发生在重读之后')
  assert.ok(writeAt > decisionAt, '写入必须发生在裁决之后，顺序不可颠倒')
  assert.match(put, /catch \(err\) \{\s*throw httpError\([^\n]*503\)/, '读取失败必须 503 中止，不得带着未知状态写入')
  assert.match(put, /if \(!decision\.allow\) throw httpError\(decision\.message, decision\.status\)/)
})

test('接线：GET 暴露 readOnly / ruleVersion / v2 摘要', () => {
  const source = readFileSync(join(ROOT, 'server/online-catalog.js'), 'utf8')
  const getStart = source.indexOf("onlineCatalogRouter.get('/online-catalog/buy-gift'")
  const get = source.slice(getStart, getStart + 3000)
  assert.match(get, /readOnly: isV2BuyGiftDoc\(saved\)/)
  assert.match(get, /ruleVersion: isV2BuyGiftDoc\(saved\) \? 2 : 1/)
  assert.match(get, /v2: buyGiftV2Summary\(saved\)/)
  assert.match(get, /readOnlyReason: isV2BuyGiftDoc\(saved\) \? BUY_GIFT_V2_READ_ONLY_REASON : ''/)
})

test('接线：前端 readOnly 时禁用保存与启用开关，且不渲染 v1 编辑表单', () => {
  const source = readFileSync(join(ROOT, 'src/components/BuyGiftBoard.jsx'), 'utf8')
  assert.match(source, /setReadOnly\(!!res\?\.readOnly\)/)
  assert.match(source, /disabled=\{saving \|\| loading \|\| readOnly\}/)
  assert.match(source, /if \(readOnly\) \{[\s\S]{0,200}?return/, 'save() 必须在 readOnly 时直接返回')
  assert.match(source, /\) : readOnly \? \(/, 'readOnly 应渲染只读摘要分支而不是 v1 表单')
  assert.match(source, /<input type="checkbox" checked=\{form\.active\} disabled=\{readOnly\}/)
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  AUDIT_EVENT_LABELS,
  AUDIT_ACTION_FALLBACK,
  auditEventLabel,
  formatAuditActor,
  auditMoney,
  buildCardTailIndex,
  auditEventSummary,
  buildAuditEntries,
} from '../src/utils/sweetCardAudit.js'

/** 后端 server/*.js 里出现过的全部 audit action（含 status 路由动态拼接的 4 个）。 */
const BACKEND_ACTIONS = [
  'sweet_card.batch_archived', 'sweet_card.batch_created', 'sweet_card.batch_restored', 'sweet_card.bound',
  'sweet_card.card_delivery_activated', 'sweet_card.claim_asset_created', 'sweet_card.claim_asset_reissued',
  'sweet_card.claim_asset_revoked', 'sweet_card.claim_credential_issued', 'sweet_card.claim_credential_revoked',
  'sweet_card.claim_url_link_created', 'sweet_card.credential_replaced', 'sweet_card.electronic_card_generated',
  'sweet_card.lost', 'sweet_card.miniprogram_bound', 'sweet_card.miniprogram_claimed',
  'sweet_card.presentation_exported', 'sweet_card.presentation_updated',
  'sweet_card.production_test_allowlist_disabled', 'sweet_card.production_test_allowlist_enabled',
  'sweet_card.qr_exported', 'sweet_card.redeemed', 'sweet_card.redemption_reversed', 'sweet_card.refund_restored',
  'sweet_card.rules_updated', 'sweet_card.active', 'sweet_card.frozen', 'sweet_card.unfreeze', 'sweet_card.void',
]

test('后端全部事件都有中文动作，且界面不会露出英文下划线代码', () => {
  for (const action of BACKEND_ACTIONS) {
    const label = auditEventLabel(action)
    assert.notEqual(label, AUDIT_ACTION_FALLBACK, `${action} 缺少中文映射`)
    assert.doesNotMatch(label, /[a-z_]{3,}/, `${action} 的中文名仍含英文/下划线：${label}`)
  }
})

test('事件码与后端源码逐字对齐（防止后端新增事件后前端漏配）', () => {
  const files = ['server/sweet-card.js', 'server/sweet-card-claim.js', 'server/sweet-card-availability.js',
    'server/sweet-card-issue.js', 'server/sweet-card-refunds.js']
  const found = new Set()
  for (const file of files) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    for (const match of source.matchAll(/'sweet_card\.([a-z_]+)'/g)) found.add(`sweet_card.${match[1]}`)
  }
  for (const action of found) {
    assert.match(AUDIT_EVENT_LABELS[action] || '', /^[\u4e00-\u9fa5]+$/, `${action} 未配置中文映射`)
  }
})

test('未知事件回落中文兜底，不显示事件码', () => {
  assert.equal(auditEventLabel('sweet_card.future_unknown_event'), AUDIT_ACTION_FALLBACK)
  assert.equal(auditEventLabel(''), AUDIT_ACTION_FALLBACK)
  assert.doesNotMatch(auditEventLabel('sweet_card.future_unknown_event'), /[a-z_]{3,}/)
})

test('操作人：真人姓名优先显示', () => {
  assert.equal(formatAuditActor({ action: 'sweet_card.qr_exported', actorName: '胡东辉', actorId: 'daa77021-df1a-46e4-8196-d3ddbd432006' }).text, '胡东辉')
})

test('操作人：系统签发 UUID + 空姓名 → 系统自动签发', () => {
  const actor = formatAuditActor({ action: 'sweet_card.claim_credential_issued', actorName: '', actorId: 'daa77021-df1a-46e4-8196-d3ddbd432006' })
  assert.equal(actor.text, '系统自动签发')
  assert.equal(actor.kind, 'system')
})

test('操作人：姓名本身是 UUID 也不外露', () => {
  const actor = formatAuditActor({ action: 'sweet_card.active', actorName: 'daa77021-df1a-46e4-8196-d3ddbd432006', actorId: 'daa77021-df1a-46e4-8196-d3ddbd432006' })
  assert.doesNotMatch(actor.text, /[0-9a-f]{8}-/)
})

test('操作人：小程序访客 → 微信领取用户（尾号）', () => {
  const actor = formatAuditActor({ action: 'sweet_card.miniprogram_claimed', actorName: '', actorId: '318071ae-be62-4b27-a22f-ae07fdbd32a4' })
  assert.equal(actor.text, '微信领取用户（尾号 32A4）')
  assert.equal(actor.kind, 'customer')
})

test('金额格式化：分转元', () => {
  assert.equal(auditMoney('82800'), '¥828.00')
  assert.equal(auditMoney('50000'), '¥500.00')
  assert.equal(auditMoney(10), '¥0.10')
  assert.equal(auditMoney(''), '')
  assert.equal(auditMoney(undefined), '')
})

test('摘要：卡号尾号 + 核销金额', () => {
  const index = buildCardTailIndex([{ id: 'scv-1', publicCardNo: 'SC202673FBDD29EB2A' }])
  const summary = auditEventSummary({
    action: 'sweet_card.redeemed', accountId: 'scv-1',
    metadata: { amountCents: '82800', storeId: 'tongying' },
  }, index)
  assert.equal(summary, '****EB2A · ¥828.00')
})

test('摘要：批次创建显示张数与面额', () => {
  const summary = auditEventSummary({
    action: 'sweet_card.batch_created', batchId: 'scb-1',
    metadata: { cardCount: 1, faceValueCents: '50000' },
  })
  assert.equal(summary, '1 张 · ¥500.00')
})

test('制卡多事件合并为一条「创建甜意卡」', () => {
  const events = [
    { id: 'e1', action: 'sweet_card.batch_created', batchId: 'scb-1', actorName: '胡东辉', actorId: 'daa77021-df1a-46e4-8196-d3ddbd432006', metadata: { cardCount: 1, faceValueCents: '50000' }, createdAt: '2026-11-26T08:06:02.103Z' },
    { id: 'e2', action: 'sweet_card.electronic_card_generated', accountId: 'scv-1', actorName: '胡东辉', actorId: 'daa77021-df1a-46e4-8196-d3ddbd432006', metadata: {}, createdAt: '2026-11-26T08:06:22.089Z' },
    { id: 'e3', action: 'sweet_card.claim_asset_created', accountId: 'scv-1', batchId: 'scb-1', actorName: '胡东辉', actorId: 'daa77021-df1a-46e4-8196-d3ddbd432006', metadata: {}, createdAt: '2026-11-26T08:06:22.086Z' },
  ]
  const entries = buildAuditEntries(events, { cards: [{ id: 'scv-1', publicCardNo: 'SC202673FBDD29EB2A' }] })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].label, '创建甜意卡')
  assert.equal(entries[0].mergedCount, 3)
  assert.match(entries[0].summary, /1 张/)
  assert.match(entries[0].summary, /¥500\.00/)
  assert.match(entries[0].summary, /\*\*\*\*EB2A/)
})

test('不同批次即便相邻也不合并', () => {
  const events = [
    { id: 'a', action: 'sweet_card.batch_created', batchId: 'scb-1', metadata: { cardCount: 1 }, createdAt: '2026-11-26T08:06:02.000Z' },
    { id: 'b', action: 'sweet_card.batch_created', batchId: 'scb-2', metadata: { cardCount: 1 }, createdAt: '2026-11-26T08:06:05.000Z' },
  ]
  assert.equal(buildAuditEntries(events).length, 2)
})

test('非制卡事件不合并，且各自有中文动作', () => {
  const events = [
    { id: 'r1', action: 'sweet_card.redeemed', accountId: 'scv-1', metadata: { amountCents: '1000' }, createdAt: '2026-11-26T08:56:15.007Z' },
    { id: 'r2', action: 'sweet_card.redeemed', accountId: 'scv-1', metadata: { amountCents: '2000' }, createdAt: '2026-11-26T08:56:16.007Z' },
  ]
  const entries = buildAuditEntries(events, { cards: [{ id: 'scv-1', publicCardNo: 'SC202673FBDD29EB2A' }] })
  assert.equal(entries.length, 2)
  assert.equal(entries[0].label, '门店消费核销')
  assert.equal(entries[0].summary, '****EB2A · ¥20.00')
})

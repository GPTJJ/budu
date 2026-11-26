/**
 * 甜意卡移动端界面验收沙盘（仅前端渲染，不连后端、不写生产）。
 *
 * 用途：在没有本地数据库的环境里，用固定夹具渲染真实组件，检查
 * 单行导航 / 丝绒主卡排版 / 配置中心三段 / 制卡抽屉 / 双模转发的视觉与交互。
 * 所有 /api 请求由下方 mock 拦截，数据形状与 server/sweet-card.js 的响应一致。
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../src/index.css'
import SweetCardPage from '../src/components/SweetCardPage'

const overview = {
  businessPurpose: 'COMMERCIAL', archived: false,
  statusCounts: { ACTIVE: 12, CREATED: 2, EXHAUSTED: 3 },
  count: 17, issued: 14, claimed: 9,
  initialAmountCents: '1280000', balanceCents: '836500',
}
const batches = { batches: [
  { id: 'b1', name: '甜意卡 11.26 · ¥200', businessPurpose: 'COMMERCIAL', cardCount: 6, totalInitialAmountCents: '120000', carrierType: 'ELECTRONIC', bindingMode: 'OPTIONAL', createdAt: '2026-11-26T10:12:00Z', metrics: { activated: 6, consumedCents: '24000', balanceCents: '96000' } },
  { id: 'b2', name: '中秋客户答谢', businessPurpose: 'COMMERCIAL', cardCount: 5, totalInitialAmountCents: '500000', carrierType: 'ELECTRONIC', bindingMode: 'OPTIONAL', createdAt: '2026-11-20T02:00:00Z', metrics: { activated: 5, consumedCents: '150000', balanceCents: '350000' } },
] }
const cards = { cards: [
  { id: 'c1', publicCardNo: 'SC202611260001A31F', batchId: 'b1', initialAmountCents: '20000', balanceCents: '20000', status: 'ACTIVE', carrierType: 'ELECTRONIC', bindingMode: 'OPTIONAL', recipientLabel: '阿岚', recipientNote: 'With a little sweetness, from budu.', claimedAt: null, credentials: [] },
  { id: 'c2', publicCardNo: 'SC202611250009B7C2', batchId: 'b1', initialAmountCents: '20000', balanceCents: '20000', status: 'ACTIVE', carrierType: 'ELECTRONIC', bindingMode: 'OPTIONAL', recipientLabel: '市场部 · 老周', recipientNote: '', claimedAt: '2026-11-25T09:31:00Z', credentials: [] },
  { id: 'c3', publicCardNo: 'SC202611200003C9D4', batchId: 'b2', initialAmountCents: '100000', balanceCents: '60000', status: 'ACTIVE', carrierType: 'ELECTRONIC', bindingMode: 'OPTIONAL', recipientLabel: '陈总', recipientNote: '中秋快乐', claimedAt: '2026-11-21T03:12:00Z', credentials: [] },
] }
const rules = { categories: [
  { id: 'cat-1', name: 'pos-森醒', blocked: true },
  { id: 'cat-2', name: 'pos-12 样商店', blocked: true },
  { id: 'cat-3', name: '烘焙', blocked: false },
  { id: 'cat-4', name: '饮品', blocked: false },
  { id: 'cat-5', name: '礼盒', blocked: false },
] }
const usage = { redemptions: [
  { id: 'r1', publicCardNo: 'SC202611250009B7C2', orderNo: 'BJ20261125001', amountCents: '6800', storeId: 'bj-003', redeemedByName: '李敏', createdAt: '2026-11-25T11:20:00Z' },
] }
const audit = { events: [
  { id: 'a1', action: 'sweet_card.batch_issued', actorName: '胡东辉', createdAt: '2026-11-26T10:12:00Z' },
  { id: 'a2', action: 'sweet_card.rules_updated', actorName: '胡东辉', createdAt: '2026-11-25T18:04:00Z' },
  { id: 'a3', action: 'sweet_card.claim_url_link_created', actorName: '胡东辉', createdAt: '2026-11-25T17:42:00Z' },
] }
const availability = {
  globalEnabled: true, runtimeEnabled: true,
  stores: [
    { id: 'bj-001', name: '北京一店', operationType: 'DIRECT', active: true, configurable: true, enabled: true, posOperatorCount: 4 },
    { id: 'bj-003', name: '北京三店', operationType: 'DIRECT', active: true, configurable: true, enabled: true, posOperatorCount: 3 },
    { id: 'bj-009', name: '北京九店（停业）', operationType: 'DIRECT', active: false, configurable: false, enabled: false, posOperatorCount: 0 },
  ],
}

const cardDetail = {
  card: {
    ...cards.cards[0],
    delivery: {
      activationStatus: 'ACTIVATED', presentationStatus: 'GENERATED', claimCredentialStatus: 'ACTIVE',
      claimStatus: 'UNCLAIMED', bindingStatus: 'UNBOUND', deliveryStatus: 'READY',
      activeClaimCredentialId: '7f1d2c3b-4a59-4e6d-8b7a-0c1d2e3f4a5b',
    },
    ledger: [{ id: 'l1', type: 'ISSUE', amountCents: '20000', balanceAfterCents: '20000', createdAt: '2026-11-26T10:12:00Z' }],
  },
}

const routes = [
  [/claim-url-link/, { ok: true, schemeUrl: 'weixin://dl/business/?t=AbCd1234EfGh', urlLink: 'https://wxmpurl.cn/DhjnRN5cuvh', channel: 'WECHAT_URL_SCHEME', expireDays: 7, credentialId: '7f1d2c3b4a594e6d8b7a0c1d2e3f4a5b' }],
  [/\/v2\/sweet-cards\/cards\/c1/, cardDetail],
  [/\/v2\/sweet-cards\/config(\?|$)/, { enabled: true, claimPresentationEnabled: true }],
  [/\/v2\/sweet-cards\/overview(\?|$)/, overview],
  [/\/v2\/sweet-cards\/batches(\?|$)/, batches],
  [/\/v2\/sweet-cards\/cards(\?|$)/, cards],
  [/\/v2\/sweet-cards\/rules(\?|$)/, rules],
  [/\/v2\/sweet-cards\/usage(\?|$)/, usage],
  [/\/v2\/sweet-cards\/audit(\?|$)/, audit],
  [/\/v2\/sweet-cards\/availability(\?|$)/, availability],
]

const realFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = String(input)
  for (const [pattern, payload] of routes) {
    if (pattern.test(url)) return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return realFetch(input, init)
}
const wantedEnv = new URLSearchParams(location.search).get('env')
window.__wxjs_environment = wantedEnv === 'miniprogram' ? 'miniprogram' : 'browser'
if (wantedEnv === 'miniprogram') {
  window.__miniProgramNav = []
  window.wx = { miniProgram: { navigateTo: ({ url }) => { window.__miniProgramNav.push(url) } } }
}

const user = { id: 'harness-user', name: '验收账号', role: 'developer', status: 'active', permissions: {} }

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <SweetCardPage user={user} onBack={() => {}} />
  </React.StrictMode>,
)

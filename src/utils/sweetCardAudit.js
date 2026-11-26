/**
 * 甜意卡「操作审计」的前端语义层。
 *
 * 只做展示翻译，不碰数据库、不改审计写入：后端把 action / actorId / metadata
 * 原样返回，这里负责把面向机器的字段转成业务人员能读懂的句子。
 *
 * 三条约束：
 * 1. 界面上不允许出现任何英文下划线事件码；未知事件一律回落中文兜底文案。
 * 2. 操作人只展示可信身份：真人姓名 > 微信领取用户（尾号）> 系统自动签发，
 *    绝不把裸 UUID 摊在界面上。
 * 3. 单次制卡会同时落 batch_created / electronic_card_generated /
 *    claim_asset_created / claim_credential_issued 多条底层事件，
 *    展示时合并成一条「创建甜意卡」，避免同一动作刷屏。
 */

export const AUDIT_ACTION_FALLBACK = '系统操作记录'

/** 事件码 → 业务动作。键必须与后端 audit(action) 的取值逐字一致。 */
export const AUDIT_EVENT_LABELS = {
  // 制卡与批次
  'sweet_card.batch_created': '创建甜意卡',
  'sweet_card.electronic_card_generated': '创建甜意卡',
  'sweet_card.claim_asset_created': '创建甜意卡',
  'sweet_card.claim_credential_issued': '创建甜意卡',
  'sweet_card.batch_archived': '归档历史批次',
  'sweet_card.batch_restored': '恢复历史批次',
  // 转发与卡面
  'sweet_card.qr_exported': '生成微信转发链接',
  'sweet_card.presentation_exported': '生成微信转发链接',
  'sweet_card.claim_url_link_created': '生成微信转发链接',
  'sweet_card.presentation_updated': '修改卡面赠言',
  'sweet_card.card_delivery_activated': '交付激活甜意卡',
  // 领取与绑定
  'sweet_card.miniprogram_claimed': '好友微信领取入包',
  'sweet_card.miniprogram_bound': '微信领取并绑定账户',
  'sweet_card.bound': '绑定持卡人',
  'sweet_card.claim_asset_reissued': '重新签发领取凭证',
  'sweet_card.claim_asset_revoked': '撤销领取凭证',
  'sweet_card.claim_credential_revoked': '撤销领取凭证',
  'sweet_card.credential_replaced': '更换领取凭据',
  // 卡状态
  'sweet_card.active': '激活甜意卡',
  'sweet_card.frozen': '冻结甜意卡',
  'sweet_card.unfreeze': '解冻甜意卡',
  'sweet_card.void': '作废撤回甜意卡',
  'sweet_card.lost': '挂失甜意卡',
  // 消费与退款
  'sweet_card.redeemed': '门店消费核销',
  'sweet_card.redemption_reversed': '撤销核销记录',
  'sweet_card.refund_restored': '退款回补余额',
  // 规则与运维
  'sweet_card.rules_updated': '更新核销规则',
  'sweet_card.production_test_allowlist_enabled': '开启生产测试白名单',
  'sweet_card.production_test_allowlist_disabled': '关闭生产测试白名单',
}

/** 业务动作中文名。未知事件（后端新增）也必须是中文，不允许露出事件码。 */
export function auditEventLabel(action) {
  return AUDIT_EVENT_LABELS[String(action || '')] || AUDIT_ACTION_FALLBACK
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_ID_RE = /^[0-9a-f]{16,}$/i

/** 微信侧事件：actor 是顾客身份，不是内部员工，也不是"系统签发"。 */
const CUSTOMER_ACTIONS = new Set(['sweet_card.miniprogram_claimed', 'sweet_card.miniprogram_bound'])

/**
 * 操作人转译。
 * - 有可信中文姓名 → 直接显示（内部员工）
 * - 姓名缺失/姓名本身就是 UUID → 按事件来源判定
 *   · 微信领取/绑定 → 微信领取用户（尾号 xxxx）
 *   · 其余（制卡、凭据签发等内部动作）→ 系统自动签发
 */
export function formatAuditActor(event) {
  const name = String(event?.actorName || '').trim()
  const actorId = String(event?.actorId || '').trim()
  const nameLooksLikeId = UUID_RE.test(name) || HEX_ID_RE.test(name)
  if (name && !nameLooksLikeId) return { text: name, kind: 'person' }

  if (CUSTOMER_ACTIONS.has(String(event?.action || ''))) {
    const tail = actorId.replace(/-/g, '').slice(-4).toUpperCase()
    return { text: tail ? `微信领取用户（尾号 ${tail}）` : '微信领取用户', kind: 'customer' }
  }
  return { text: '系统自动签发', kind: 'system' }
}

/** 分（字符串/数字/BigInt 都可能）→ ¥x,xxx.xx */
export function auditMoney(cents) {
  if (cents === null || cents === undefined || cents === '') return ''
  const value = Number(String(cents))
  if (!Number.isFinite(value)) return ''
  return `¥${(value / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** 从卡片列表建立 accountId → 卡号后四位（metadata 里没有卡号，只能靠列表映射）。 */
export function buildCardTailIndex(cards = []) {
  const index = new Map()
  for (const card of cards || []) {
    const id = String(card?.id || '')
    const cardNo = String(card?.publicCardNo || '')
    if (id && cardNo.length >= 4) index.set(id, cardNo.slice(-4).toUpperCase())
  }
  return index
}

/** 单条事件的业务摘要：卡号尾号 / 面额 / 核销金额 / 批次张数。 */
export function auditEventSummary(event, cardTailIndex = new Map()) {
  const meta = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {}
  const parts = []
  const tail = cardTailIndex instanceof Map ? cardTailIndex.get(String(event?.accountId || '')) : ''
  if (tail) parts.push(`****${tail}`)

  const action = String(event?.action || '')
  if (action === 'sweet_card.batch_created') {
    if (meta.cardCount) parts.push(`${meta.cardCount} 张`)
    const face = auditMoney(meta.faceValueCents)
    if (face) parts.push(face)
  }
  if (action === 'sweet_card.redeemed' || action === 'sweet_card.redemption_reversed' || action === 'sweet_card.refund_restored') {
    const amount = auditMoney(meta.amountCents)
    if (amount) parts.push(amount)
  }
  return parts.join(' · ')
}

/**
 * 制卡动作会连写多条底层事件，且实测 batch_created 与其余事件相差约 20 秒
 * （不是严格同一秒），因此用「连续同类 + 时间窗」合并，而不是精确到秒。
 */
const CREATE_ACTIONS = new Set([
  'sweet_card.batch_created',
  'sweet_card.electronic_card_generated',
  'sweet_card.claim_asset_created',
  'sweet_card.claim_credential_issued',
])
const DEFAULT_MERGE_WINDOW_MS = 120_000

function timestampOf(event) {
  const value = new Date(event?.createdAt).getTime()
  return Number.isFinite(value) ? value : 0
}

/**
 * 把原始审计行转成列表条目。
 * @returns {Array<{ id, label, at, actor, summary, mergedCount, isCreate }>}
 */
export function buildAuditEntries(events = [], options = {}) {
  const cardTailIndex = options.cardTailIndex instanceof Map ? options.cardTailIndex : buildCardTailIndex(options.cards || [])
  const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : DEFAULT_MERGE_WINDOW_MS
  const sorted = [...(events || [])].sort((a, b) => timestampOf(b) - timestampOf(a))

  const groups = []
  for (const event of sorted) {
    const isCreate = CREATE_ACTIONS.has(String(event?.action || ''))
    const prev = groups[groups.length - 1]
    const prevBatch = prev ? String(prev.events[0]?.batchId || '') : ''
    const nextBatch = String(event?.batchId || '')
    // 两个事件都标了批次号且不同 → 是两次独立制卡，不能合并。
    const sameBatch = !prevBatch || !nextBatch || prevBatch === nextBatch
    if (isCreate && prev && prev.isCreate && sameBatch && Math.abs(prev.anchorAt - timestampOf(event)) <= windowMs) {
      prev.events.push(event)
      prev.anchorAt = timestampOf(event)
      continue
    }
    groups.push({ isCreate, anchorAt: timestampOf(event), events: [event] })
  }

  return groups.map((group) => {
    const first = group.events[0]
    if (!group.isCreate) {
      return {
        id: first.id,
        label: auditEventLabel(first.action),
        at: first.createdAt,
        actor: formatAuditActor(first),
        summary: auditEventSummary(first, cardTailIndex),
        mergedCount: 1,
        isCreate: false,
      }
    }

    const batchEvent = group.events.find((e) => String(e.action) === 'sweet_card.batch_created')
    const cardIds = [...new Set(group.events.map((e) => String(e.accountId || '')).filter(Boolean))]
    const summaryParts = []
    if (cardIds.length === 1 && cardTailIndex.has(cardIds[0])) summaryParts.push(`****${cardTailIndex.get(cardIds[0])}`)
    const cardCount = Number(batchEvent?.metadata?.cardCount || 0)
    const count = cardCount || cardIds.length
    if (count > 0) summaryParts.push(`${count} 张`)
    const face = auditMoney(batchEvent?.metadata?.faceValueCents)
    if (face) summaryParts.push(face)

    // 合并条目取组内最早一条的落库时间（批次创建发生在最前）。
    const earliest = group.events.reduce((acc, e) => (timestampOf(e) < timestampOf(acc) ? e : acc), group.events[0])
    return {
      id: first.id,
      label: auditEventLabel('sweet_card.batch_created'),
      at: earliest.createdAt,
      actor: formatAuditActor(batchEvent || first),
      summary: summaryParts.join(' · '),
      mergedCount: group.events.length,
      isCreate: true,
    }
  })
}

import { supportsSweetCardClaim } from './sweet-card-claim-eligibility.js'
import fs from 'node:fs'

const escapeXml = (value) => String(value || '').replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char])

export const SWEET_CARD_DESIGN_VERSION = 'minimal-v2'
export const SWEET_CARD_PRESENTATION_FIELDS = Object.freeze([
  'logoAsset', 'cardTheme', 'backgroundAsset', 'faceValueDisplay', 'currentBalanceDisplay',
  'maskedCardNo', 'validityText', 'recipientText', 'campaignText', 'statusText', 'bindingText',
  'claimAsset', 'designVersion',
])

const STATUS_LABELS = Object.freeze({ CREATED: '待激活', ACTIVE: '可使用', FROZEN: '已冻结', LOST: '已挂失', EXHAUSTED: '已用尽', EXPIRED: '已过期', VOID: '已作废' })
const BINDING_LABELS = Object.freeze({ NONE: '不绑定', OPTIONAL: '可选绑定', REQUIRED: '必须绑定' })
const CLAIM_ASSET_ELIGIBLE_STATUSES = new Set(['CREATED', 'ACTIVE'])

const logoSvg = fs.readFileSync(new URL('../brand/web/budu-wordmark.svg', import.meta.url), 'utf8')
export const CANONICAL_LOGO_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(logoSvg).toString('base64')}`

export function maskedSweetCardNo(value) {
  const cardNo = String(value || '')
  return cardNo.length > 4 ? `${'*'.repeat(Math.min(8, cardNo.length - 4))}${cardNo.slice(-4)}` : '****'
}

export function sweetCardValidityText(card) {
  if (card?.expiresAt) return `有效期至 ${new Date(card.expiresAt).toISOString().slice(0, 10)}`
  return card?.validityType === 'LONG_TERM' ? '长期有效' : '激活后生效'
}

function formatCents(value) {
  const cents = BigInt(value || 0)
  const sign = cents < 0n ? '-' : ''
  const absolute = cents < 0n ? -cents : cents
  return `${sign}¥${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`
}

export function buildSweetCardDeliveryState(card, now = new Date()) {
  const latestClaimCredential = card?.claimTokens?.[0] || null
  let claimCredentialStatus = 'NONE'
  if (latestClaimCredential?.revokedAt) claimCredentialStatus = 'REVOKED'
  else if (latestClaimCredential?.consumedAt) claimCredentialStatus = 'CONSUMED'
  else if (latestClaimCredential?.expiresAt && new Date(latestClaimCredential.expiresAt) <= now) claimCredentialStatus = 'EXPIRED'
  else if (latestClaimCredential) claimCredentialStatus = 'ACTIVE'

  const claimStatus = card?.claim ? 'CLAIMED' : 'UNCLAIMED'
  const bindingStatus = card?.bindingMode === 'NONE' ? 'NOT_REQUIRED' : card?.binding ? 'BOUND' : 'UNBOUND'
  const presentationStatus = claimCredentialStatus === 'NONE' ? 'NOT_GENERATED'
    : claimCredentialStatus === 'REVOKED' || claimCredentialStatus === 'EXPIRED' ? 'REVOKED'
      : 'GENERATED'
  const activationStatus = card?.activatedAt ? 'ACTIVATED' : 'UNACTIVATED'
  const deliveryStatus = claimStatus === 'CLAIMED' ? 'CLAIMED'
    : claimCredentialStatus === 'REVOKED' || claimCredentialStatus === 'EXPIRED' ? 'REVOKED'
      : claimCredentialStatus === 'ACTIVE' && activationStatus === 'ACTIVATED' ? 'READY'
        : claimCredentialStatus === 'ACTIVE' ? 'GENERATED'
          : 'NOT_PREPARED'

  return {
    cardStatus: card?.status || 'CREATED', activationStatus, presentationStatus,
    claimCredentialStatus, claimStatus, bindingStatus, deliveryStatus,
    claimedAt: card?.claim?.claimedAt || null,
    claimCredentialExpiresAt: latestClaimCredential?.expiresAt || null,
  }
}

/** Server-owned eligibility contract for issuing a MiniProgram Claim asset. */
export function buildClaimAssetEligibility(card, { claimPresentationEnabled = false, canIssue = false, now = new Date() } = {}) {
  if (!claimPresentationEnabled) return {
    claimAssetEligible: false,
    claimAssetBlockedCode: 'CLAIM_DISABLED',
    claimAssetBlockedReason: '甜意卡领取功能当前未开放。',
  }
  if (!canIssue) return {
    claimAssetEligible: false,
    claimAssetBlockedCode: 'PERMISSION_DENIED',
    claimAssetBlockedReason: '无权限执行此操作。',
  }
  if (!supportsSweetCardClaim(card?.batch?.businessPurpose)) return {
    claimAssetEligible: false,
    claimAssetBlockedCode: 'NOT_ELIGIBLE',
    claimAssetBlockedReason: '当前卡用途暂不支持电子领取凭证生成。',
  }
  if (card?.binding || card?.claim) return {
    claimAssetEligible: false,
    claimAssetBlockedCode: 'NOT_ELIGIBLE',
    claimAssetBlockedReason: '当前卡已领取或绑定，无法生成新的电子领取凭证。',
  }
  if (!CLAIM_ASSET_ELIGIBLE_STATUSES.has(card?.status) || (card?.expiresAt && new Date(card.expiresAt) <= now)) return {
    claimAssetEligible: false,
    claimAssetBlockedCode: 'NOT_ELIGIBLE',
    claimAssetBlockedReason: '当前卡状态暂不可生成电子领取凭证。',
  }
  return { claimAssetEligible: true, claimAssetBlockedCode: 'ELIGIBLE', claimAssetBlockedReason: '' }
}

export function buildSweetCardPresentation(card, options = {}) {
  const initial = BigInt(card?.initialAmountCents || 0)
  const balance = BigInt(card?.balanceCents ?? initial)
  const carrierType = ['PHYSICAL', 'ELECTRONIC'].includes(options.carrierType) ? options.carrierType : card?.carrierType
  const claimAsset = options.claimAsset
  return {
    carrierType,
    logoAsset: 'brand/web/budu-wordmark.svg', cardTheme: 'budu-rose', backgroundAsset: '',
    faceValueDisplay: formatCents(initial),
    currentBalanceDisplay: formatCents(balance),
    maskedCardNo: maskedSweetCardNo(card?.publicCardNo), validityText: sweetCardValidityText(card),
    recipientText: String(options.recipientText ?? (card?.recipientLabel ? `赠予 ${card.recipientLabel}` : '')).slice(0, 120),
    campaignText: String(options.campaignText ?? card?.recipientNote ?? card?.giftingScenario ?? '').slice(0, 120),
    statusText: STATUS_LABELS[card?.status] || '状态未知',
    bindingText: card?.binding ? '已绑定' : BINDING_LABELS[card?.bindingMode] || '未绑定',
    claimAsset: claimAsset ? { purpose: 'MINIPROGRAM_CLAIM', format: 'QR', state: claimAsset.state || 'ACTIVE' } : null,
    designVersion: String(options.designVersion || card?.batch?.presentationTemplateKey || SWEET_CARD_DESIGN_VERSION).slice(0, 50),
  }
}

/** Presentation renderer. It accepts display-only fields and cannot decide economic or ownership facts. */
export function renderSweetCardPresentation(model, { claimQrDataUrl = '' } = {}) {
  const qr = claimQrDataUrl
    ? `<rect x="820" y="250" width="290" height="330" rx="28" fill="#fff"/><image href="${escapeXml(claimQrDataUrl)}" x="835" y="265" width="260" height="260"/><text x="965" y="558" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" fill="#8a6071">微信扫码领取甜意卡</text>`
    : `<rect x="820" y="250" width="290" height="290" rx="28" fill="#fff" opacity=".72"/><text x="965" y="395" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" fill="#a78b96">领取入口单独生成</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fff8fb"/><stop offset="1" stop-color="#f7d7e5"/></linearGradient></defs>
  <rect width="1200" height="760" rx="64" fill="url(#bg)"/><circle cx="1060" cy="100" r="220" fill="#be4679" opacity=".08"/>
  <image href="${CANONICAL_LOGO_DATA_URL}" x="80" y="70" width="170" height="76" preserveAspectRatio="xMinYMid meet"/><text x="80" y="175" font-family="Arial,sans-serif" font-size="20" letter-spacing="5" fill="#ad3769">A LITTLE SWEETNESS.</text>
  <text x="80" y="325" font-family="Arial,sans-serif" font-size="82" font-weight="800" fill="#1e293b">${escapeXml(model.faceValueDisplay)}</text><text x="80" y="382" font-family="Arial,sans-serif" font-size="22" fill="#64748b">当前余额 ${escapeXml(model.currentBalanceDisplay)}</text>
  <text x="80" y="446" font-family="Arial,sans-serif" font-size="24" fill="#64748b">${escapeXml(model.recipientText)}</text><text x="80" y="490" font-family="Arial,sans-serif" font-size="20" fill="#8a6071">${escapeXml(model.campaignText)}</text>
  <text x="80" y="620" font-family="monospace" font-size="22" fill="#64748b">${escapeXml(model.maskedCardNo)}</text><text x="80" y="662" font-family="Arial,sans-serif" font-size="20" fill="#94a3b8">${escapeXml(model.validityText)} · ${escapeXml(model.statusText)} · ${escapeXml(model.bindingText)}</text><text x="80" y="705" font-family="Arial,sans-serif" font-size="16" fill="#b19aa3">Design ${escapeXml(model.designVersion)}</text>${qr}</svg>`
}

export function renderPhysicalClaimAsset({ claimQrDataUrl, maskedCardNo, expiresAt }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="980" viewBox="0 0 760 980"><rect width="760" height="980" rx="44" fill="#fff8fb"/><image href="${CANONICAL_LOGO_DATA_URL}" x="210" y="58" width="340" height="120"/><text x="380" y="225" text-anchor="middle" font-family="Arial,sans-serif" font-size="31" font-weight="700" fill="#3e2e26">甜意卡微信领取入口</text><rect x="100" y="285" width="560" height="560" rx="32" fill="#fff"/><image href="${escapeXml(claimQrDataUrl)}" x="125" y="310" width="510" height="510"/><text x="380" y="890" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" fill="#8a6071">${escapeXml(maskedCardNo)} · 领取凭证请通过其他渠道获取</text><text x="380" y="928" text-anchor="middle" font-family="Arial,sans-serif" font-size="17" fill="#a7968b">领取入口有效期至 ${escapeXml(new Date(expiresAt).toISOString().slice(0, 10))}</text></svg>`
}

// Compatibility alias. POS QR input is deliberately ignored by the presentation renderer.
export function renderMinimalSweetCard(input) {
  const cents = Math.round(Number(String(input?.faceValueText || '').replace(/[^0-9.]/g, '')) * 100)
  const card = { initialAmountCents: cents, balanceCents: cents, publicCardNo: input?.publicCardNo, status: 'CREATED', bindingMode: 'NONE', validityType: 'ONE_YEAR' }
  return renderSweetCardPresentation({ ...buildSweetCardPresentation(card, { recipientText: input?.recipient, designVersion: 'minimal-v1-compatible' }), validityText: input?.expiryCopy || '激活后生效' })
}

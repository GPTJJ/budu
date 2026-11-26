import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

/**
 * 回归守卫：sweet_card_audit_logs.credential_id 的外键指向 SweetCardCredential，
 * 而 claimTokens 是 SweetCardClaimToken —— 两个 id 空间不通用。
 * 2026-11-26 生产事故：路由把 claimToken.id 当 credentialId 写审计，
 * 触发 P2003（sweet_card_audit_logs_credential_fkey），转发接口全量 500。
 */
const source = fs.readFileSync(new URL('../server/sweet-card.js', import.meta.url), 'utf8')

function routeBlock() {
  const start = source.indexOf("'/sweet-cards/cards/:id/claim-url-link'")
  assert.ok(start > 0, '未找到 claim-url-link 路由')
  const end = source.indexOf("sweetCardRouter.post(", start + 10)
  return source.slice(start, end > start ? end : start + 4000)
}

test('claim-url-link 审计的 credentialId 取自 SweetCardCredential，而不是 claim token', () => {
  const block = routeBlock()
  assert.match(block, /sweetCardCredential\.findFirst/, '必须解析账号下真实的 SweetCardCredential')
  assert.match(block, /credentialId:\s*linkedCredential\?\.id\s*\|\|\s*null/, '审计 credentialId 必须来自 linkedCredential')
  assert.doesNotMatch(
    block,
    /sweet_card\.claim_url_link_created',[\s\S]{0,240}?credentialId:\s*claimToken\.id/,
    '禁止把 claim token id 写进审计的 credentialId 外键',
  )
})

test('claim token 引用只出现在 metadata 与链接生成处', () => {
  const block = routeBlock()
  assert.match(block, /createClaimShareLink\(\{\s*credentialId:\s*claimToken\.id\s*\}\)/, 'scene 引用的确是 claim token id')
  assert.match(block, /claimTokenId:\s*claimToken\.id/, '审计 metadata 必须留 claimTokenId 便于追溯')
})

test('审计写失败不该把已生成的链接打成 500', () => {
  const block = routeBlock()
  assert.match(block, /catch \(error\)/, '审计写入必须有兜底')
  assert.match(block, /auditState = 'PENDING'/, '审计失败要标记，便于补记')
})

test('缺凭据时返回可识别的 CLAIM_CREDENTIAL_REQUIRED，而不是 500', () => {
  const block = routeBlock()
  assert.match(block, /CLAIM_CREDENTIAL_REQUIRED/, '缺领取凭据必须给 publicCode')
})

test('正式版未包含免密领取页时返回 CLAIM_RELEASE_PAGE_PENDING 提示', () => {
  const block = routeBlock()
  assert.match(block, /SWEET_CARD_CLAIM_RELEASE_READY/, '版本就绪开关必须可配')
  assert.match(block, /CLAIM_RELEASE_PAGE_PENDING/, '版本落后必须显式提示')
})

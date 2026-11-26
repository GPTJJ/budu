import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { _resetMiniprogramTokenAuthority } from '../server/wechat-access-token.js'
import {
  CLAIM_URL_SCHEME_PATH, createClaimShareLink, createClaimUrlLink, createClaimUrlScheme,
  isWechatUrlScheme, isWechatUrlLink,
} from '../server/sweet-card-url-link.js'

const read = (path) => fs.readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
const CREDENTIAL = '7f1d2c3b-4a59-4e6d-8b7a-0c1d2e3f4a5b'
const SCENE = '7f1d2c3b4a594e6d8b7a0c1d2e3f4a5b'
const config = (appId) => ({ enabled: true, appId, appSecret: 'secret', mode: 'test' })

/** 一个按 URL 分流的假 fetch：记录请求体，返回脚本化响应。 */
function mockFetch(handlers) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const target = String(url)
    const body = init?.body ? JSON.parse(init.body) : null
    calls.push({ url: target, body })
    for (const [pattern, reply] of handlers) {
      if (pattern.test(target)) {
        const payload = typeof reply === 'function' ? reply(body, calls) : reply
        if (payload instanceof Error) throw payload
        return { ok: true, json: async () => payload }
      }
    }
    throw new Error(`UNEXPECTED_REQUEST ${target}`)
  }
  return { fetchImpl, calls }
}

const TOKEN = [/cgi-bin\/stable_token/, { access_token: 'tok-1', expires_in: 7200 }]

test('scheme: generates weixin://dl/business link with trial env_version inside jump_wxa', async () => {
  _resetMiniprogramTokenAuthority()
  const { fetchImpl, calls } = mockFetch([
    TOKEN,
    [/wxa\/generatescheme/, { errcode: 0, errmsg: 'ok', openlink: 'weixin://dl/business/?t=AbCd1234EfGh' }],
  ])
  const result = await createClaimUrlScheme({ credentialId: CREDENTIAL, expireDays: 7, config: config('wxscheme1'), fetchImpl })
  assert.equal(result.schemeUrl, 'weixin://dl/business/?t=AbCd1234EfGh')
  assert.equal(result.credentialId, SCENE)
  assert.equal(result.expireDays, 7)
  assert.equal(result.envVersion, 'trial')
  const body = calls.find((c) => /generatescheme/.test(c.url)).body
  assert.deepEqual(body, {
    jump_wxa: { path: CLAIM_URL_SCHEME_PATH, query: `claimToken=${SCENE}`, env_version: 'trial' },
    expire_type: 1,
    expire_interval: 7,
  })
  // 短链参数不能混进 Scheme 请求体：generate_urllink 才用顶层 path/env_version。
  assert.equal(body.path, undefined)
  assert.equal(body.env_version, undefined)
  // 不把 token 明文或凭据 UUID 写进 query。
  assert.ok(!body.jump_wxa.query.includes(CREDENTIAL))
})

test('scheme: explicit envVersion overrides, release for production config', async () => {
  _resetMiniprogramTokenAuthority()
  const { fetchImpl, calls } = mockFetch([
    TOKEN,
    [/wxa\/generatescheme/, { errcode: 0, openlink: 'weixin://dl/business/?t=RrEeLl55Aa' }],
  ])
  await createClaimUrlScheme({ credentialId: CREDENTIAL, config: config('wxscheme2'), fetchImpl, envVersion: 'release' })
  assert.equal(calls.find((c) => /generatescheme/.test(c.url)).body.jump_wxa.env_version, 'release')
})

test('scheme: rejects non-WeChat deep links instead of copying them', async () => {
  _resetMiniprogramTokenAuthority()
  const { fetchImpl } = mockFetch([
    TOKEN,
    [/wxa\/generatescheme/, { errcode: 0, openlink: 'https://evil.example.com/x' }],
  ])
  await assert.rejects(
    createClaimUrlScheme({ credentialId: CREDENTIAL, config: config('wxscheme3'), fetchImpl }),
    (error) => error.publicCode === 'URL_SCHEME_INVALID' && error.status === 503,
  )
  assert.equal(isWechatUrlScheme('weixin://dl/business/?t=AbCd1234EfGh'), true)
  assert.equal(isWechatUrlScheme('weixin://dl/business/?t='), false)
  assert.equal(isWechatUrlScheme('https://wxmpurl.cn/abc'), false)
})

test('scheme: stale token is invalidated and retried exactly once', async () => {
  _resetMiniprogramTokenAuthority()
  let attempt = 0
  const { fetchImpl, calls } = mockFetch([
    [/cgi-bin\/stable_token/, () => ({ access_token: `tok-${++attempt}`, expires_in: 7200 })],
    [/wxa\/generatescheme/, (_body, all) => (
      all.filter((c) => /generatescheme/.test(c.url)).length === 1
        ? { errcode: 40001, errmsg: 'invalid credential' }
        : { errcode: 0, openlink: 'weixin://dl/business/?t=Retry12345Ok' }
    )],
  ])
  const result = await createClaimUrlScheme({ credentialId: CREDENTIAL, config: config('wxscheme4'), fetchImpl })
  assert.equal(result.schemeUrl, 'weixin://dl/business/?t=Retry12345Ok')
  assert.equal(calls.filter((c) => /generatescheme/.test(c.url)).length, 2)
  assert.equal(calls.filter((c) => /stable_token/.test(c.url)).length, 2)
})

test('share link: scheme wins, url link stays available as fallback copy', async () => {
  _resetMiniprogramTokenAuthority()
  const { fetchImpl } = mockFetch([
    TOKEN,
    [/wxa\/generatescheme/, { errcode: 0, openlink: 'weixin://dl/business/?t=PrImArY1234' }],
    [/wxa\/generate_urllink/, { errcode: 0, url_link: 'https://wxmpurl.cn/DhjnRN5cuvh' }],
  ])
  const result = await createClaimShareLink({ credentialId: CREDENTIAL, config: config('wxscheme5'), fetchImpl })
  assert.equal(result.channel, 'WECHAT_URL_SCHEME')
  assert.equal(result.degraded, false)
  assert.equal(result.schemeUrl, 'weixin://dl/business/?t=PrImArY1234')
  assert.equal(result.urlLink, 'https://wxmpurl.cn/DhjnRN5cuvh')
  assert.equal(result.credentialId, SCENE)
})

test('share link: degrades to url link when scheme is refused', async () => {
  _resetMiniprogramTokenAuthority()
  const { fetchImpl } = mockFetch([
    TOKEN,
    [/wxa\/generatescheme/, { errcode: 40098, errmsg: 'invalid path' }],
    [/wxa\/generate_urllink/, { errcode: 0, url_link: 'https://wxmpurl.cn/FaLLbAcK1' }],
  ])
  const result = await createClaimShareLink({ credentialId: CREDENTIAL, config: config('wxscheme6'), fetchImpl })
  assert.equal(result.channel, 'WECHAT_URL_LINK')
  assert.equal(result.degraded, true)
  assert.equal(result.schemeUrl, '')
  assert.equal(result.urlLink, 'https://wxmpurl.cn/FaLLbAcK1')
})

test('share link: both channels failing surfaces the scheme error', async () => {
  _resetMiniprogramTokenAuthority()
  const { fetchImpl } = mockFetch([
    TOKEN,
    [/wxa\/generatescheme/, { errcode: 40098 }],
    [/wxa\/generate_urllink/, { errcode: 40098 }],
  ])
  await assert.rejects(
    createClaimShareLink({ credentialId: CREDENTIAL, config: config('wxscheme7'), fetchImpl }),
    (error) => error.publicCode === 'URL_SCHEME_REJECTED',
  )
})

test('url link: unchanged contract still validates wxmpurl.cn hosts', async () => {
  _resetMiniprogramTokenAuthority()
  const { fetchImpl } = mockFetch([
    TOKEN,
    [/wxa\/generate_urllink/, { errcode: 0, url_link: 'https://wxmpurl.cn/DhjnRN5cuvh' }],
  ])
  const result = await createClaimUrlLink({ credentialId: CREDENTIAL, config: config('wxscheme8'), fetchImpl })
  assert.equal(result.urlLink, 'https://wxmpurl.cn/DhjnRN5cuvh')
  assert.equal(isWechatUrlLink(result.urlLink), true)
  assert.equal(isWechatUrlLink('https://evil.example.com/x'), false)
})

test('wiring: route returns schemeUrl and the share sheet copies the scheme link', () => {
  const route = read('server/sweet-card.js')
  assert.match(route, /createClaimShareLink/)
  assert.match(route, /schemeUrl: link\.schemeUrl/)
  assert.match(route, /urlLink: link\.urlLink/)
  assert.match(route, /channel: link\.channel/)
  const util = read('src/utils/sweetCardShare.js')
  assert.match(util, /requestClaimShareLink/)
  assert.match(util, /isWechatUrlScheme\(schemeUrl\)/)
  const sheet = read('src/components/sweet-card/mobile/SweetCardShareSheet.jsx')
  assert.match(sheet, /requestClaimShareLink/)
  assert.match(sheet, /shareCopy\(amountText, link\)/)
  assert.match(sheet, /copyText\(link\)/)
  // 复制给好友的文案里不能再出现会白屏的中转短链。
  assert.doesNotMatch(sheet, /shareCopy\(amountText, urlLink\)/)
})

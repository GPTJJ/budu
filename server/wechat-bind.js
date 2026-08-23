// 微信绑定（通知中心微信个人提醒的绑定管理）：
// 扫码授权一次建立绑定 → 通知中心生成站内消息后自动检测绑定并推送微信提醒
// 通道：企业微信（qrConnect 扫码） / 公众号（网页授权）；未配置资质时接口返回未开通
import { Router } from 'express'
import crypto from 'node:crypto'
import { prisma, dbReady } from './pg.js'
import { getUserByUsername } from './user-store.js'
import { httpError } from './pos-core.js'
import { canManageAccounts } from '../shared/accountPermissions.js'
import { publicBaseUrl, wechatPersonalConfig, wecomAccessToken } from './notification-center.js'

export const wechatBindRouter = Router()
/** OAuth 回调是公开端点；安全性由数据库一次性 state 保证，不依赖登录 Cookie。 */
export const wechatBindCallbackRouter = Router()
/** 企业微信接收消息服务器验证（公开，无需登录）：GET 校验签名并解密 echostr 应答 */
export const wechatRecvRouter = Router()

const BIND_STATE_TTL_MS = 10 * 60 * 1000
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex')

export function maskWechatIdentity(value) {
  const text = String(value || '')
  if (!text) return ''
  if (text.length <= 2) return '*'.repeat(text.length)
  if (text.length <= 4) return `${text[0]}**${text.at(-1)}`
  return `${text.slice(0, 2)}***${text.slice(-2)}`
}

function htmlEscape(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

async function findSystemUser(username, { requireActive = false } = {}) {
  const user = await getUserByUsername(username)
  if (!user) throw httpError('系统账号不存在', 404)
  if (requireActive && (user.status === 'disabled' || user.role === 'public')) {
    throw httpError('系统账号已停用，不能绑定', 409)
  }
  return user
}

async function saveBinding({ username, channel, openId, nickname, actorUsername, action, stateHash = '' }) {
  try {
    return await prisma.$transaction(async (tx) => {
      if (stateHash) {
        const consumed = await tx.wechatBindState.updateMany({
          where: { stateHash, usedAt: null, expiresAt: { gt: new Date() } },
          data: { usedAt: new Date() },
        })
        if (consumed.count !== 1) throw httpError('绑定请求已失效或已使用，请重新发起', 400)
      }
      const conflict = await tx.wechatBinding.findFirst({
        where: { channel, openId, status: 'active', NOT: { username } },
        select: { id: true },
      })
      if (conflict) throw httpError('该微信身份已绑定其他系统账号，请先解绑', 409)
      const binding = await tx.wechatBinding.upsert({
        where: { username_channel: { username, channel } },
        create: { id: `wb-${crypto.randomUUID()}`, username, channel, openId, nickname, status: 'active' },
        update: { openId, nickname, status: 'active', revokedAt: null, boundAt: new Date() },
      })
      await tx.wechatBindingAuditLog.create({
        data: {
          id: `wba-${crypto.randomUUID()}`,
          bindingId: binding.id,
          targetUsername: username,
          channel,
          action,
          actorUsername,
          identityHint: maskWechatIdentity(openId),
        },
      })
      return binding
    }, { isolationLevel: 'Serializable' })
  } catch (error) {
    if (error?.code === 'P2002' || error?.meta?.code === '23505') {
      throw httpError('该微信身份已绑定其他系统账号，请先解绑', 409)
    }
    throw error
  }
}

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (err) {
    const status = err.status || 500
    if (status >= 500) console.error('[wechat-bind]', err)
    res.status(status).json({ error: err.message || '服务器错误' })
  }
}

/** 当前绑定状态（当前登录用户） */
wechatBindRouter.get('/wechat/bindings', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const rows = await prisma.wechatBinding.findMany({
    where: { username: req.user.username },
    orderBy: { boundAt: 'desc' },
  })
  const cfg = wechatPersonalConfig()
  res.json({
    ok: true,
    configured: Boolean(cfg),
    channel: cfg ? cfg.channel : '',
    rows: rows.map((r) => ({ id: r.id, channel: r.channel, identityHint: maskWechatIdentity(r.openId), status: r.status, boundAt: r.boundAt })),
  })
}))

/** 生成扫码绑定链接（state 绑定当前账号，扫码授权回调后建立绑定） */
wechatBindRouter.post('/wechat/bind-qrcode', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const cfg = wechatPersonalConfig()
  if (!cfg) throw httpError('微信提醒通道未配置（需要企业微信自建应用或公众号资质）', 400)
  const baseUrl = publicBaseUrl()
  if (!baseUrl) throw httpError('PUBLIC_BASE_URL 未配置或不安全，无法生成绑定链接', 503)
  const state = crypto.randomBytes(32).toString('base64url')
  await prisma.wechatBindState.create({
    data: {
      id: `wbs-${crypto.randomUUID()}`,
      stateHash: sha256(state),
      username: req.user.username,
      channel: cfg.channel,
      expiresAt: new Date(Date.now() + BIND_STATE_TTL_MS),
    },
  })
  prisma.wechatBindState.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date() } }, { usedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }] },
  }).catch(() => {})
  let url = ''
  if (cfg.channel === 'wecom') {
    // 企业微信扫码登录（用户扫码授权 → 回调 code）
    const redirect = `${baseUrl}/api/v2/wechat/bind/callback`
    url = `https://open.work.weixin.qq.com/wwopen/sso/qrConnect?appid=${cfg.corpId}&agentid=${cfg.agentId}&redirect_uri=${encodeURIComponent(redirect)}&state=${encodeURIComponent(state)}`
  } else {
    // 公众号网页授权
    const redirect = `${baseUrl}/api/v2/wechat/bind/callback`
    url = `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${cfg.appId}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=snsapi_base&state=${encodeURIComponent(state)}#wechat_redirect`
  }
  res.json({ ok: true, url })
}))

/** 扫码回调：code → 换取 openid → 建立绑定（回调页展示绑定结果） */
wechatBindCallbackRouter.get('/', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const cfg = wechatPersonalConfig()
  if (!cfg) throw httpError('微信提醒通道未配置', 400)
  const code = String(req.query.code || '')
  const state = String(req.query.state || '')
  if (!code || !/^[A-Za-z0-9_-]{40,64}$/.test(state)) {
    return res.status(400).send('<html><body><h3>绑定参数不完整</h3></body></html>')
  }
  const stateHash = sha256(state)
  const stateRow = await prisma.wechatBindState.findUnique({ where: { stateHash } })
  if (!stateRow || stateRow.usedAt || stateRow.expiresAt <= new Date() || stateRow.channel !== cfg.channel) {
    return res.status(400).send('<html><body><h3>绑定请求已失效，请重新发起</h3></body></html>')
  }
  const username = stateRow.username
  await findSystemUser(username, { requireActive: true })
  let openId = ''
  let nickname = ''
  if (cfg.channel === 'wecom') {
    // code 换 userid（企业微信）
    const token = await wecomAccessToken(cfg.corpId, cfg.secret)
    if (!token) throw httpError('企业微信授权服务暂不可用', 502)
    const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo')
    url.searchParams.set('access_token', token)
    url.searchParams.set('code', code)
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) }).then((x) => x.json()).catch(() => ({}))
    // 应用消息 touser 只接受企业内部 userid；外部联系人的 openid 不能用于此通道。
    openId = r.userid || ''
    nickname = r.userid || ''
  } else {
    // code 换 openid（公众号）
    const url = new URL('https://api.weixin.qq.com/sns/oauth2/access_token')
    url.searchParams.set('appid', cfg.appId)
    url.searchParams.set('secret', cfg.secret)
    url.searchParams.set('code', code)
    url.searchParams.set('grant_type', 'authorization_code')
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) }).then((x) => x.json()).catch(() => ({}))
    openId = r.openid || ''
    nickname = r.nickname || ''
  }
  if (!openId) {
    return res.status(400).send('<html><body><h3>微信授权失败，请重试</h3></body></html>')
  }
  await saveBinding({ username, channel: cfg.channel, openId, nickname, actorUsername: username, action: 'oauth_bind', stateHash })
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding-top:80px"><h3>✅ 微信绑定成功（${htmlEscape(username)}）</h3><p>通知中心将向该微信发送站内消息提醒，可关闭此页面返回 budu</p></body></html>`)
}))

/** 解绑 */
wechatBindRouter.post('/wechat/bindings/:id/revoke', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const row = await prisma.wechatBinding.findUnique({ where: { id: req.params.id } })
  if (!row || row.username !== req.user.username) throw httpError('绑定不存在', 404)
  await prisma.$transaction(async (tx) => {
    await tx.wechatBinding.update({
      where: { id: row.id },
      data: { status: 'revoked', revokedAt: new Date() },
    })
    await tx.wechatBindingAuditLog.create({
      data: {
        id: `wba-${crypto.randomUUID()}`,
        bindingId: row.id,
        targetUsername: row.username,
        channel: row.channel,
        action: 'self_revoke',
        actorUsername: req.user.username,
        identityHint: maskWechatIdentity(row.openId),
      },
    })
  })
  res.json({ ok: true })
}))

/**
 * 管理员手动绑定企微 userid（绕过扫码；域名主体校验未通过/员工不便扫码时使用）。
 * 仅 Developer 可操作；写入 wechat_bindings(channel=wecom, openId=userid)。
 */
wechatBindRouter.post('/wechat/bindings/manual', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (!canManageAccounts(req.user)) throw httpError('仅开发者可手动绑定', 403)
  const cfg = wechatPersonalConfig()
  if (!cfg || cfg.channel !== 'wecom') throw httpError('企业微信通道未配置，无法手动绑定', 400)
  const username = String(req.body?.username || '').trim()
  const userid = String(req.body?.userid || '').trim()
  if (!username || username.length > 20) throw httpError('系统账号不正确', 400)
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(userid)) throw httpError('企微 userid 格式不正确', 400)
  await findSystemUser(username, { requireActive: true })
  const binding = await saveBinding({
    username,
    channel: 'wecom',
    openId: userid,
    nickname: userid,
    actorUsername: req.user.username,
    action: 'manual_bind',
  })
  res.json({ ok: true, username, identityHint: maskWechatIdentity(userid), bindingId: binding.id })
}))

/** 管理员查询任意账号的微信绑定状态 */
wechatBindRouter.get('/wechat/bindings/lookup', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (!canManageAccounts(req.user)) throw httpError('仅开发者可查询', 403)
  const username = String(req.query.username || '').trim()
  if (!username || username.length > 20) throw httpError('系统账号不正确', 400)
  await findSystemUser(username)
  const rows = await prisma.wechatBinding.findMany({
    where: { username },
    orderBy: { boundAt: 'desc' },
  })
  res.json({
    ok: true,
    rows: rows.map((r) => ({ channel: r.channel, identityHint: maskWechatIdentity(r.openId), status: r.status, boundAt: r.boundAt })),
  })
}))

/** 测试推送（仅对本人已绑定通道发送一条测试消息） */
wechatBindRouter.post('/wechat/test', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const cfg = wechatPersonalConfig()
  if (!cfg) throw httpError('微信提醒通道未配置', 400)
  const binding = await prisma.wechatBinding.findFirst({
    where: { username: req.user.username, channel: cfg.channel, status: 'active' },
  })
  if (!binding) throw httpError('尚未绑定微信，请先扫码绑定', 400)
  const { sendWechatPersonal } = await import('./notification-center.js')
  const result = await sendWechatPersonal(cfg, binding, {
    title: 'budu 通知测试',
    content: '这是一条微信提醒测试消息。绑定成功，后续业务通知将通过微信提醒您。',
    target: '',
  })
  res.json({ ok: result.ok, configured: true, errcode: result.errcode, errmsg: result.errmsg })
}))

// ---------------- 企业微信接收消息服务器验证（URL/Token/EncodingAESKey 校验） ----------------
export function wecomReceiveConfig() {
  const token = String(process.env.WXWORK_RECV_TOKEN || '').trim()
  const aesKey = String(process.env.WXWORK_RECV_AES_KEY || '').trim()
  if (!token || !/^[A-Za-z0-9]{43}$/.test(aesKey)) return null
  try {
    if (Buffer.from(`${aesKey}=`, 'base64').length !== 32) return null
  } catch {
    return null
  }
  return { token, aesKey }
}

/** sha1 签名校验（企业微信标准：token/timestamp/nonce/echostr 字典序拼接） */
export function wecomSign(token, timestamp, nonce, echostr) {
  const str = [token, timestamp, nonce, echostr].sort().join('')
  return crypto.createHash('sha1').update(str).digest('hex')
}

/** AES-256-CBC 解密（EncodingAESKey → key，IV = key 前 16 字节；PKCS7） */
export function decryptWecomMsg(encodingAESKey, encryptedBase64) {
  const aesKey = Buffer.from(`${encodingAESKey}=`, 'base64')
  if (aesKey.length !== 32) throw new Error('invalid aes key')
  const iv = aesKey.subarray(0, 16)
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv)
  decipher.setAutoPadding(false)
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedBase64, 'base64')), decipher.final()])
  if (decrypted.length < 20) throw new Error('invalid encrypted message')
  // 格式：16 字节 random + 4 字节网络序 msgLen + msg + receiveId
  const content = decrypted.subarray(16)
  const msgLen = content.readUInt32BE(0)
  if (msgLen < 0 || msgLen > content.length - 4) throw new Error('invalid message length')
  return content.subarray(4, 4 + msgLen).toString('utf8')
}

/** 验证 URL：GET ?msg_signature&timestamp&nonce&echostr → 返回解密后的 echostr 明文 */
wechatRecvRouter.get('/', (req, res) => {
  const recv = wecomReceiveConfig()
  if (!recv) return res.status(503).send('callback disabled')
  const { msg_signature, timestamp, nonce, echostr } = req.query
  if (!msg_signature || !timestamp || !nonce || !echostr) {
    return res.status(400).send('invalid params')
  }
  const sign = wecomSign(recv.token, String(timestamp), String(nonce), String(echostr))
  if (sign !== String(msg_signature)) {
    return res.status(403).send('sign mismatch')
  }
  try {
    const plain = decryptWecomMsg(recv.aesKey, String(echostr))
    res.send(plain)
  } catch (e) {
    res.status(500).send('decrypt error')
  }
})

/** 消息推送（POST 加密 JSON）——通知中心二期可接收企微事件；先应答 success 保证验证通过 */
wechatRecvRouter.post('/', (req, res) => {
  if (!wecomReceiveConfig()) return res.status(503).send('callback disabled')
  res.send('success')
})

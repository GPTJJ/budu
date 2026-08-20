// 微信绑定（通知中心微信个人提醒的绑定管理）：
// 扫码授权一次建立绑定 → 通知中心生成站内消息后自动检测绑定并推送微信提醒
// 通道：企业微信（qrConnect 扫码） / 公众号（网页授权）；未配置资质时接口返回未开通
import { Router } from 'express'
import crypto from 'node:crypto'
import { prisma, dbReady } from './pg.js'
import { httpError } from './pos-core.js'
import { wechatPersonalConfig } from './notification-center.js'

export const wechatBindRouter = Router()
/** 企业微信接收消息服务器验证（公开，无需登录）：GET 校验签名并解密 echostr 应答 */
export const wechatRecvRouter = Router()

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
    rows: rows.map((r) => ({ id: r.id, channel: r.channel, nickname: r.nickname, status: r.status, boundAt: r.boundAt })),
  })
}))

/** 生成扫码绑定链接（state 绑定当前账号，扫码授权回调后建立绑定） */
wechatBindRouter.post('/wechat/bind-qrcode', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const cfg = wechatPersonalConfig()
  if (!cfg) throw httpError('微信提醒通道未配置（需要企业微信自建应用或公众号资质）', 400)
  const baseUrl = process.env.PUBLIC_BASE_URL || ''
  const state = `${req.user.username}::${crypto.randomBytes(8).toString('hex')}`
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
  res.json({ ok: true, url, state })
}))

/** 扫码回调：code → 换取 openid → 建立绑定（回调页展示绑定结果） */
wechatBindRouter.get('/wechat/bind/callback', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const cfg = wechatPersonalConfig()
  if (!cfg) throw httpError('微信提醒通道未配置', 400)
  const code = String(req.query.code || '')
  const state = String(req.query.state || '')
  const [username, nonce] = state.split('::')
  if (!code || !username || !nonce) {
    return res.status(400).send('<html><body><h3>绑定参数不完整</h3></body></html>')
  }
  let openId = ''
  let nickname = ''
  if (cfg.channel === 'wecom') {
    // code 换 userid（企业微信）
    const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo?access_token=${await wecomToken(cfg)}&code=${encodeURIComponent(code)}`).then((x) => x.json()).catch(() => ({}))
    openId = r.userid || r.openid || ''
    nickname = r.userid || ''
  } else {
    // code 换 openid（公众号）
    const r = await fetch(`https://api.weixin.qq.com/sns/oauth2/access_token?appid=${cfg.appId}&secret=${cfg.secret}&code=${encodeURIComponent(code)}&grant_type=authorization_code`).then((x) => x.json()).catch(() => ({}))
    openId = r.openid || ''
    nickname = r.nickname || ''
  }
  if (!openId) {
    return res.status(400).send('<html><body><h3>微信授权失败，请重试</h3></body></html>')
  }
  await prisma.wechatBinding.upsert({
    where: { username_channel: { username, channel: cfg.channel } },
    create: { id: `wb-${crypto.randomUUID()}`, username, channel: cfg.channel, openId, nickname, status: 'active' },
    update: { openId, nickname, status: 'active', revokedAt: null },
  })
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding-top:80px"><h3>✅ 微信绑定成功（${username}）</h3><p>通知中心将向该微信发送站内消息提醒，可关闭此页面返回 budu</p></body></html>`)
}))

/** 解绑 */
wechatBindRouter.post('/wechat/bindings/:id/revoke', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const row = await prisma.wechatBinding.findUnique({ where: { id: req.params.id } })
  if (!row || row.username !== req.user.username) throw httpError('绑定不存在', 404)
  await prisma.wechatBinding.update({
    where: { id: row.id },
    data: { status: 'revoked', revokedAt: new Date() },
  })
  res.json({ ok: true })
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
  const ok = await sendWechatPersonal(cfg, binding, {
    title: 'budu 通知测试',
    content: '这是一条微信提醒测试消息。绑定成功，后续业务通知将通过微信提醒您。',
    target: '',
  })
  res.json({ ok, configured: true })
}))

let wecomTokenCache = { token: '', at: 0 }
async function wecomToken(cfg) {
  if (wecomTokenCache.token && Date.now() - wecomTokenCache.at < 7000 * 1000) return wecomTokenCache.token
  try {
    const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${cfg.corpId}&corpsecret=${cfg.secret}`).then((x) => x.json())
    if (r.errcode === 0 && r.access_token) {
      wecomTokenCache = { token: r.access_token, at: Date.now() }
      return r.access_token
    }
    return ''
  } catch {
    return ''
  }
}

// ---------------- 企业微信接收消息服务器验证（URL/Token/EncodingAESKey 校验） ----------------
const RECV_TOKEN = process.env.WXWORK_RECV_TOKEN || 'budu2025'
const RECV_AES_KEY = process.env.WXWORK_RECV_AES_KEY || 'HkmvnowRA81CWOVk7nPPvzpDyhfwZEU8gGNoCUCuS'

/** sha1 签名校验（企业微信标准：token/timestamp/nonce/echostr 字典序拼接） */
function wecomSign(token, timestamp, nonce, echostr) {
  const str = [token, timestamp, nonce, echostr].sort().join('')
  return crypto.createHash('sha1').update(str).digest('hex')
}

/** AES-256-CBC 解密（EncodingAESKey → key，IV = key 前 16 字节；PKCS7） */
function decryptWecomMsg(encodingAESKey, encryptedBase64) {
  const aesKey = Buffer.from(`${encodingAESKey}=`, 'base64')
  const iv = aesKey.subarray(0, 16)
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv)
  decipher.setAutoPadding(false)
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedBase64, 'base64')), decipher.final()])
  // 格式：16 字节 random + 4 字节网络序 msgLen + msg + receiveId
  const content = decrypted.subarray(16)
  const msgLen = content.readUInt32BE(0)
  return content.subarray(4, 4 + msgLen).toString('utf8')
}

/** 验证 URL：GET ?msg_signature&timestamp&nonce&echostr → 返回解密后的 echostr 明文 */
wechatRecvRouter.get('/', (req, res) => {
  const { msg_signature, timestamp, nonce, echostr } = req.query
  if (!msg_signature || !timestamp || !nonce || !echostr) {
    return res.status(400).send('invalid params')
  }
  const sign = wecomSign(RECV_TOKEN, String(timestamp), String(nonce), String(echostr))
  if (sign !== String(msg_signature)) {
    return res.status(403).send('sign mismatch')
  }
  try {
    const plain = decryptWecomMsg(RECV_AES_KEY, String(echostr))
    res.send(plain)
  } catch (e) {
    res.status(500).send('decrypt error')
  }
})

/** 消息推送（POST 加密 JSON）——通知中心二期可接收企微事件；先应答 success 保证验证通过 */
wechatRecvRouter.post('/', (req, res) => {
  res.send('success')
})

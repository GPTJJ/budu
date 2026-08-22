// 通知中心（Notification Center）：系统唯一通知入口
// 业务模块只调用本模块；站内消息 + 通道派发（微信个人提醒/企微群广播），未来可扩展 APP/短信/邮件
// 设计原则：纯增量，不改变现有业务逻辑；微信通道未配置时优雅降级为仅站内
import crypto from 'node:crypto'
import { prisma, dbReady } from './pg.js'
import { loadDb } from './store.js'
import { sendWechatMarkdown } from './wechat-alert.js'

const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/** 微信个人推送通道配置（企业微信自建应用 或 公众号，任一配置即启用；均未配置则跳过） */
export function wechatPersonalConfig() {
  const wecom = {
    corpId: process.env.WXWORK_CORP_ID || '',
    agentId: process.env.WXWORK_AGENT_ID || '',
    secret: process.env.WXWORK_SECRET || '',
  }
  const mp = {
    appId: process.env.MP_APP_ID || '',
    secret: process.env.MP_APP_SECRET || '',
    templateId: process.env.MP_TEMPLATE_ID || '',
  }
  if (wecom.corpId && wecom.agentId && wecom.secret) return { channel: 'wecom', ...wecom }
  if (mp.appId && mp.secret && mp.templateId) return { channel: 'mp', ...mp }
  return null
}

/** 模板占位符渲染：{key} → 数据值（缺失留空） */
export function renderTpl(tpl, data = {}) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => {
    const v = data[k]
    return v === undefined || v === null ? '' : String(v)
  })
}

// ---------------- 内置模板（启动时 ensure） ----------------
const BUILTIN_TEMPLATES = [
  { key: 'approval_todo', name: '审批待办', description: '有新单据待你审批', titleTpl: '待你审批：{title}', contentTpl: '{submitterName} 提交了{templateName}申请「{title}」', target: 'approval', defaultPriority: 'high' },
  { key: 'approval_result', name: '审批结果', description: '审批通过/驳回通知提交人', titleTpl: '{result}：{title}', contentTpl: '你的{templateName}申请「{title}」已被 {approverName} {resultText}', target: 'approval', defaultPriority: 'normal' },
  { key: 'approval_cc', name: '审批抄送', description: '审批通过后抄送相关人', titleTpl: '抄送：{title} 已通过', contentTpl: '{templateName}申请「{title}」已通过审批，请查收', target: 'approval', defaultPriority: 'normal' },
  { key: 'payroll_pending', name: '工资条待签收', description: '员工有新的工资条待签收', titleTpl: '工资条待签收：{employeeName} {period}', contentTpl: '工资周期 {period} · 实发 {amount} 元，请核对并签收', target: 'staff-payroll', defaultPriority: 'high' },
  { key: 'payroll_confirmed', name: '工资条已签收', description: '员工签收工资条通知', titleTpl: '{employeeName} 已签收工资条 {period}', contentTpl: '{employeeName} 已于 {time} 签收工资周期 {period} 的工资条', target: 'staff-payroll', defaultPriority: 'normal' },
  { key: 'transfer_new', name: '新调货申请', description: '有新的调货申请', titleTpl: '新调货申请：{fromStore} → {toStore}', contentTpl: '货品 {count} 种 · 提交人 {submitter}', target: 'inventory-transfer', defaultPriority: 'normal' },
  { key: 'transfer_shipped', name: '调货已发货', description: '调货已发货通知', titleTpl: '调货已发货：{fromStore} → {toStore}', contentTpl: '货品 {count} 种 · 操作人 {operator}', target: 'inventory-transfer', defaultPriority: 'normal' },
  { key: 'purchase_new', name: '新采购申请', description: '有新的采购申请', titleTpl: '新采购申请：{store}', contentTpl: '货品 {count} 种{supplier} · 提交人 {submitter}', target: 'inventory-purchase', defaultPriority: 'normal' },
  { key: 'invoice_new', name: '新发票申请', description: '有新的发票申请', titleTpl: '新发票申请：{store}', contentTpl: '抬头 {company} · 金额 ¥{amount} · 提交人 {submitter}', target: 'finance-invoice', defaultPriority: 'normal' },
  { key: 'mailing_new', name: '新门店邮寄', description: '有新的邮寄发件单', titleTpl: '新门店邮寄：{recipient}', contentTpl: '方式 {method} · 收件人 {recipient} · 提交人 {submitter}', target: 'store-mailing', defaultPriority: 'normal' },
  { key: 'stock_low', name: '库存预警', description: '库存低于安全阈值', titleTpl: '库存预警：{itemName}', contentTpl: '门店 {store} 的「{itemName}」当前库存 {quantity}，低于安全库存 {minQty}', target: 'inventory-purchase', defaultPriority: 'high' },
  { key: 'asset_expire', name: '资产到期提醒', description: '资产证件即将到期', titleTpl: '资产到期提醒：{fileName}', contentTpl: '{fileType} 将于 {expireDate} 到期，请及时办理', target: 'asset-center', defaultPriority: 'high' },
]

/** 启动时 ensure 模板（与现有 ensure 模式一致） */
export async function ensureNotificationTemplates() {
  if (!dbReady()) return
  const now = new Date()
  for (const t of BUILTIN_TEMPLATES) {
    const exists = await prisma.notificationTemplate.findUnique({ where: { key: t.key } })
    if (exists) {
      await prisma.notificationTemplate.update({
        where: { key: t.key },
        data: { name: t.name, description: t.description, titleTpl: t.titleTpl, contentTpl: t.contentTpl, target: t.target, defaultPriority: t.defaultPriority, active: true, updatedAt: now },
      })
    } else {
      await prisma.notificationTemplate.create({ data: { ...t, createdAt: now, updatedAt: now } })
    }
  }
}

/**
 * 站内通知唯一入口：写站内消息 → 投递记录 → 检测微信绑定并推送个人提醒（未配置/未绑定则跳过）
 * @param {object} opt
 * @param {string} opt.username 接收人账号
 * @param {string} opt.templateKey 模板 key（内置模板或自定义）
 * @param {object} opt.data 模板占位符数据
 * @param {string} [opt.title] 覆盖标题
 * @param {string} [opt.content] 覆盖内容
 * @param {string} [opt.priority] 覆盖优先级 high|normal|low
 * @param {string} [opt.target] 覆盖跳转目标
 * @param {string} [opt.refType] 关联业务类型（payroll/approval/transfer/...）
 * @param {string} [opt.refId] 关联业务 id
 * @param {boolean} [opt.ack] 是否需要签收（工资条等）
 * @returns {Promise<object|null>} 站内消息行或 null
 */
export async function notify(opt) {
  if (!opt || !opt.username) return null
  if (!dbReady()) return null
  try {
    const tpl = await prisma.notificationTemplate.findUnique({ where: { key: opt.templateKey } }).catch(() => null)
    const title = opt.title || (tpl ? renderTpl(tpl.titleTpl, opt.data) : opt.templateKey)
    const content = opt.content || (tpl ? renderTpl(tpl.contentTpl, opt.data) : '')
    const priority = opt.priority || (tpl && tpl.defaultPriority) || 'normal'
    const target = opt.target || (tpl && tpl.target) || ''
    const row = await prisma.notification.create({
      data: {
        id: uid('ntf'),
        username: opt.username,
        templateKey: opt.templateKey,
        title,
        content,
        priority,
        status: 'unread',
        ackStatus: opt.ack ? 'pending' : 'none',
        target,
        refType: opt.refType || '',
        refId: opt.refId || '',
      },
    })
    await prisma.notificationDelivery.create({
      data: { id: uid('nld'), notificationId: row.id, channel: 'inapp', status: 'sent' },
    })
    // 异步微信个人提醒（不阻塞业务；未配置通道或未绑定则记录 skipped）
    pushWechat(row, title, content, target).catch(() => {})
    return row
  } catch (e) {
    console.error('[notification-center]', e.message)
    return null
  }
}

/** 微信个人提醒：查绑定 → 按通道推送；未配置通道/未绑定 → skipped */
export async function pushWechat(notification, title, content, target) {
  const cfg = wechatPersonalConfig()
  if (!cfg) {
    await prisma.notificationDelivery.create({
      data: { id: uid('nld'), notificationId: notification.id, channel: 'wechat', status: 'skipped', error: 'wechat channel not configured' },
    }).catch(() => {})
    return
  }
  const binding = await prisma.wechatBinding.findFirst({
    where: { username: notification.username, channel: cfg.channel, status: 'active' },
  }).catch(() => null)
  if (!binding) {
    await prisma.notificationDelivery.create({
      data: { id: uid('nld'), notificationId: notification.id, channel: 'wechat', status: 'skipped', error: 'no binding' },
    }).catch(() => {})
    return
  }
  const result = await sendWechatPersonal(cfg, binding, { title, content, target })
  // 失败时记录通道侧错误码（errcode/errmsg 安全、不泄露密钥），便于排查
  const errDetail = result.ok
    ? ''
    : `send failed (errcode=${result.errcode}${result.errmsg ? ` ${String(result.errmsg).slice(0, 200)}` : ''})`.slice(0, 300)
  await prisma.notificationDelivery.create({
    data: { id: uid('nld'), notificationId: notification.id, channel: 'wechat', status: result.ok ? 'sent' : 'failed', error: errDetail },
  }).catch(() => {})
}

/**
 * 微信个人通道适配器：企业微信应用文本卡片（带跳转 url） / 公众号模板消息。
 * @returns {Promise<{ok:boolean, errcode?:number|string, errmsg?:string}>}
 *   errcode/errmsg 来自通道侧响应（不含任何密钥），供投递记录与测试接口排查。
 *   token 失效类错误（企微 40001/40014/42001、公众号 40001/40014）自动重取后重发一次。
 */
export async function sendWechatPersonal(cfg, binding, { title, content, target }) {
  try {
    const baseUrl = process.env.PUBLIC_BASE_URL || ''
    const jumpUrl = `${baseUrl}${target ? `/?nav=${encodeURIComponent(target)}` : ''}`
    if (cfg.channel === 'wecom') {
      return await sendWecomTextcard(cfg, binding, title, content, jumpUrl)
    }
    if (cfg.channel === 'mp') {
      return await sendMpTemplate(cfg, binding, title, content, jumpUrl)
    }
    return { ok: false, errcode: 'NO_CHANNEL', errmsg: 'unknown channel' }
  } catch (e) {
    console.error('[notification-center] wechat send', e.message)
    return { ok: false, errcode: 'LOCAL_ERROR', errmsg: String(e.message).slice(0, 200) }
  }
}

/** 企业微信自建应用消息：textcard 卡片，点击跳转 budu 页面（touser = 企微 userid） */
async function sendWecomTextcard(cfg, binding, title, content, jumpUrl) {
  const doSend = async (token) => {
    const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: binding.openId, // 企业微信 userid
        msgtype: 'textcard',
        agentid: Number(cfg.agentId),
        textcard: {
          title: title.slice(0, 120),
          description: content.slice(0, 500),
          url: jumpUrl || 'https://budu-hk.online',
          btntxt: '查看详情',
        },
      }),
    })
    const j = await res.json().catch(() => ({}))
    return { ok: res.ok && j.errcode === 0, errcode: j.errcode, errmsg: String(j.errmsg || '').slice(0, 200) }
  }
  const token = await wecomAccessToken(cfg.corpId, cfg.secret)
  if (!token) return { ok: false, errcode: 'TOKEN_FETCH_FAILED', errmsg: '获取企业微信 access_token 失败' }
  const first = await doSend(token)
  if (first.ok) return first
  // access_token 失效类错误：清缓存重取后重发一次
  if ([40001, 40014, 42001].includes(first.errcode)) {
    wecomTokenCache = { token: '', at: 0 }
    const retryToken = await wecomAccessToken(cfg.corpId, cfg.secret)
    if (retryToken) {
      const second = await doSend(retryToken)
      if (second.ok) return { ...second, retried: true }
      return { ...second, retried: true }
    }
  }
  return first
}

/** 公众号模板消息 */
async function sendMpTemplate(cfg, binding, title, content, jumpUrl) {
  const doSend = async (token) => {
    const res = await fetch(`https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: binding.openId,
        template_id: cfg.templateId,
        url: jumpUrl || 'https://budu-hk.online',
        data: {
          first: { value: title.slice(0, 60) },
          keyword1: { value: content.slice(0, 100) },
          keyword2: { value: 'budu' },
          remark: { value: '点击查看详情' },
        },
      }),
    })
    const j = await res.json().catch(() => ({}))
    return { ok: res.ok && j.errcode === 0, errcode: j.errcode, errmsg: String(j.errmsg || '').slice(0, 200) }
  }
  const token = await mpAccessToken(cfg.appId, cfg.secret)
  if (!token) return { ok: false, errcode: 'TOKEN_FETCH_FAILED', errmsg: '获取公众号 access_token 失败' }
  const first = await doSend(token)
  if (first.ok) return first
  if ([40001, 40014].includes(first.errcode)) {
    mpTokenCache = { token: '', at: 0 }
    const retryToken = await mpAccessToken(cfg.appId, cfg.secret)
    if (retryToken) {
      const second = await doSend(retryToken)
      return { ...second, retried: true }
    }
  }
  return first
}

let wecomTokenCache = { token: '', at: 0 }
export async function wecomAccessToken(corpId, secret) {
  if (wecomTokenCache.token && Date.now() - wecomTokenCache.at < 7000 * 1000) return wecomTokenCache.token
  try {
    const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`)
    const j = await res.json()
    if (j.errcode === 0 && j.access_token) {
      wecomTokenCache = { token: j.access_token, at: Date.now() }
      return j.access_token
    }
    return ''
  } catch {
    return ''
  }
}

let mpTokenCache = { token: '', at: 0 }
export async function mpAccessToken(appId, secret) {
  if (mpTokenCache.token && Date.now() - mpTokenCache.at < 7000 * 1000) return mpTokenCache.token
  try {
    const res = await fetch(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${secret}`)
    const j = await res.json()
    if (j.access_token) {
      mpTokenCache = { token: j.access_token, at: Date.now() }
      return j.access_token
    }
    return ''
  } catch {
    return ''
  }
}

/** 测试辅助：重置 access_token 缓存（企微/公众号；仅测试使用） */
export function _resetWechatTokenCaches() {
  wecomTokenCache = { token: '', at: 0 }
  mpTokenCache = { token: '', at: 0 }
}

/** 企微群机器人广播（兼容现状：与 sendWechatMarkdown 行为一致，统一入口） */
export async function broadcast(title, content) {
  return sendWechatMarkdown(title, content)
}

/** 辅助：获取账号用户列表（供抄送/绑定使用） */
export async function listUsernames() {
  const db = await loadDb()
  return (Array.isArray(db.users) ? db.users : []).map((u) => ({ username: u.username, role: u.role, name: u.displayName || u.username }))
}

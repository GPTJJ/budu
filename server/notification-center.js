// 通知中心（Notification Center）：系统唯一通知入口
// 业务模块只调用本模块；站内消息 + 通道派发（微信个人提醒/企微群广播），未来可扩展 APP/短信/邮件
// 设计原则：纯增量，不改变现有业务逻辑；微信通道未配置时优雅降级为仅站内
import crypto from 'node:crypto'
import { prisma, dbReady } from './pg.js'
import { listUsers } from './user-store.js'
import { sendWechatMarkdown } from './wechat-alert.js'
import { mpAccessToken, invalidateMiniprogramToken, _resetMiniprogramTokenAuthority } from './wechat-access-token.js'
import { formatBeijingNotificationTime } from './online-order-notice-format.js'

// 时间格式与订单成交通知文案的纯逻辑集中在零依赖模块中（server/online-order-notice-format.js），
// 这样「通知里会出现哪些信息」可以在无数据库环境下直接做回归断言。这里保持原导出不变。
export { formatBeijingNotificationTime }

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
  if (wecom.corpId && /^\d+$/.test(wecom.agentId) && wecom.secret) return { channel: 'wecom', ...wecom }
  if (mp.appId && mp.secret && mp.templateId) return { channel: 'mp', ...mp }
  return null
}

/** 外部跳转的唯一基址。生产只允许 HTTPS；本地测试可使用 loopback HTTP。 */
export function publicBaseUrl() {
  const raw = String(process.env.PUBLIC_BASE_URL || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    if (url.protocol !== 'https:' && !loopback) return ''
    if (url.username || url.password) return ''
    return url.origin
  } catch {
    return ''
  }
}

const CUSTOMER_REQUEST_NOTIFICATION_ACCOUNT = 'budu'
const CUSTOMER_REQUEST_WECOM_USER_ID = 'dh'

/** 已验证的 BUDU developer 企微固定绑定；绝不按姓名、角色或目录搜索推断。 */
export function developerWecomRecipientBinding() {
  const username = String(process.env.CUSTOMER_REQUEST_WECOM_RECIPIENT_USERNAME || '').trim()
  const userId = String(process.env.CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID || '').trim()
  if (username !== CUSTOMER_REQUEST_NOTIFICATION_ACCOUNT || userId !== CUSTOMER_REQUEST_WECOM_USER_ID) return null
  return { username, userId }
}

/** CustomerRequest 保持使用同一条已验证的精确账号绑定。 */
export function customerRequestWecomRecipientBinding() {
  return developerWecomRecipientBinding()
}

export function customerRequestWecomRecipientUserId() {
  return customerRequestWecomRecipientBinding()?.userId || ''
}

/**
 * 新订单通知接收人：可独立配置；未配置时复用同一条已验证的 BUDU 企微绑定。
 * 与 CustomerRequest 一样，绝不按姓名、角色或通讯录搜索推断接收人。
 */
export function orderPaidWecomRecipientBinding() {
  const username = String(process.env.ORDER_NOTICE_WECOM_RECIPIENT_USERNAME || '').trim()
  const userId = String(process.env.ORDER_NOTICE_WECOM_RECIPIENT_USER_ID || '').trim()
  if (username && userId) return { username, userId }
  return developerWecomRecipientBinding()
}

/** BUDU 站内深链：固定 HTTPS origin，记录 ID 只作为登录后的页面定位提示。 */
export function notificationDeepLink(target, refType = '', refId = '') {
  const baseUrl = publicBaseUrl()
  if (!baseUrl) return ''
  const nav = String(target || '').trim()
  const recordId = String(refId || '').trim()
  if (!['store-mailing', 'finance-invoice', 'inventory-transfer', 'partner-supply'].includes(nav) || !/^[A-Za-z0-9._:-]{1,160}$/.test(recordId)) return ''
  const url = new URL('/', baseUrl)
  url.searchParams.set('nav', nav)
  url.searchParams.set('refType', String(refType || '').slice(0, 40))
  url.searchParams.set('refId', recordId)
  return url.toString()
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
  { key: 'payroll_recalled', name: '工资条已撤回', description: '工资条被管理员撤回通知', titleTpl: '工资条已撤回：{employeeName} {period}', contentTpl: '工资周期 {period} 的工资条已被撤回，不再需要签收；如有疑问请联系管理员', target: 'staff-payroll', defaultPriority: 'high' },
  { key: 'payroll_deleted', name: '工资条已删除', description: '工资条记录被管理员删除通知', titleTpl: '工资条已删除：{employeeName} {period}', contentTpl: '工资周期 {period} 的工资条记录已删除，如有疑问请联系管理员', target: 'staff-payroll', defaultPriority: 'normal' },
  { key: 'transfer_new', name: '新门店调拨', description: '调出门店有新的待备货调拨', titleTpl: '新调拨待备货：{fromStore} → {toStore}', contentTpl: '货品 {count} 种 · 提交人 {submitter}', target: 'inventory-transfer', defaultPriority: 'high' },
  { key: 'transfer_shipped', name: '调拨已发货', description: '门店调拨已发货通知', titleTpl: '调拨已发货：{fromStore} → {toStore}', contentTpl: '货品 {count} 种 · 操作人 {operator}', target: 'inventory-transfer', defaultPriority: 'normal' },
  { key: 'partner_supply_new', name: '新合作商供货', description: '发货门店有新的合作商供货单待备货', titleTpl: '{partner} 有新的供货单待备货', contentTpl: '发货门店 {store} · 产品 {count} 种 · 创建人 {submitter}', target: 'partner-supply', defaultPriority: 'high' },
  { key: 'partner_supply_shipped', name: '合作商供货已发货', description: '合作商供货单发货结果通知创建人', titleTpl: '{partner} 供货单已发货', contentTpl: '发货门店 {store} · 操作人 {operator}', target: 'partner-supply', defaultPriority: 'normal' },
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
    const url = notificationDeepLink(target, opt.refType, opt.refId)
    pushWechat(row, title, content, target, url).catch(() => {})
    return row
  } catch (e) {
    console.error('[notification-center]', e.message)
    return null
  }
}

/** 微信个人提醒：查绑定 → 按通道推送；未配置通道/未绑定 → skipped */
export async function pushWechat(notification, title, content, target, url = '') {
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
  const result = await sendWechatPersonal(cfg, binding, { title, content, target, url })
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
export async function sendWechatPersonal(cfg, binding, { title, content, target, url = '' }) {
  try {
    const baseUrl = publicBaseUrl()
    if (!baseUrl) return { ok: false, errcode: 'CONFIG_ERROR', errmsg: 'PUBLIC_BASE_URL 未配置或不安全' }
    const fallback = new URL('/', baseUrl)
    if (target) fallback.searchParams.set('nav', String(target))
    let jumpUrl = fallback.toString()
    if (url) {
      const supplied = new URL(String(url))
      if (supplied.origin !== baseUrl) return { ok: false, errcode: 'CONFIG_ERROR', errmsg: '跳转地址必须使用 BUDU public origin' }
      jumpUrl = supplied.toString()
    }
    if (cfg.channel === 'wecom') {
      return await sendWecomTextcard(cfg, binding, title, content, jumpUrl)
    }
    if (cfg.channel === 'mp') {
      return await sendMpTemplate(cfg, binding, title, content, jumpUrl)
    }
    return { ok: false, errcode: 'NO_CHANNEL', errmsg: 'unknown channel' }
  } catch {
    console.error('[notification-center] wechat send failed')
    return { ok: false, errcode: 'LOCAL_ERROR', errmsg: 'local delivery error' }
  }
}

/**
 * CustomerRequest 专用企业微信投递。
 * - 站内通知事务提交后调用，失败不回滚业务。
 * - 固定配置 BUDU 账号 → UserID；不查姓名、不查角色、不广播。
 * - 确定性 delivery 主键抢占，HTTP 重试/重复调用/进程重启不会重复发送。
 */
export async function deliverCustomerRequestWecom({
  prismaClient = prisma,
  notification,
  requestId,
  type,
  storeName,
  submittedAt,
}) {
  if (!notification?.id || !requestId || !['MAILING', 'INVOICE'].includes(type)) {
    return { ok: false, status: 'skipped', reason: 'invalid customer request delivery event' }
  }
  const recipientBinding = customerRequestWecomRecipientBinding()
  const recipientUserId = recipientBinding?.userId || ''
  const deliveryId = `nld-csr-wecom-${crypto.createHash('sha256')
    .update(`${requestId}\0${type}\0${recipientBinding?.username || 'missing'}\0${recipientUserId || 'missing'}`)
    .digest('hex')
    .slice(0, 32)}`
  try {
    await prismaClient.notificationDelivery.create({
      data: {
        id: deliveryId,
        notificationId: notification.id,
        channel: 'wecom',
        status: 'pending',
      },
    })
  } catch (error) {
    if (error?.code === 'P2002') return { ok: true, status: 'duplicate' }
    throw error
  }

  const cfg = wechatPersonalConfig()
  if (!recipientUserId || !cfg || cfg.channel !== 'wecom') {
    const reason = !recipientUserId ? 'customer request recipient not configured' : 'wecom app channel not configured'
    await prismaClient.notificationDelivery.update({
      where: { id: deliveryId },
      data: { status: 'skipped', error: reason },
    }).catch(() => {})
    return { ok: false, status: 'skipped', reason }
  }

  const isMailing = type === 'MAILING'
  const title = isMailing ? '【BUDU 新的邮寄信息】' : '【BUDU 新的开票申请】'
  const action = isMailing
    ? '顾客已提交收件信息，请进入 BUDU 核对并安排发货。'
    : '顾客已提交开票资料，请进入 BUDU 核对并处理。'
  const content = [
    action,
    `门店：${String(storeName || '未知门店').slice(0, 80)}`,
    `提交时间：${formatBeijingNotificationTime(submittedAt)}`,
  ].join('\n')
  const url = notificationDeepLink(notification.target, notification.refType, notification.refId)
  const result = await sendWechatPersonal(
    cfg,
    { openId: recipientUserId },
    { title, content, target: notification.target, url },
  )
  const error = result.ok
    ? ''
    : `send failed (errcode=${result.errcode || 'UNKNOWN'}${result.errmsg ? ` ${String(result.errmsg).slice(0, 160)}` : ''})`.slice(0, 240)
  await prismaClient.notificationDelivery.update({
    where: { id: deliveryId },
    data: { status: result.ok ? 'sent' : 'failed', error, sentAt: new Date() },
  }).catch(() => {})
  return {
    ok: result.ok,
    status: result.ok ? 'sent' : 'failed',
    recipientCount: 1,
    retried: Boolean(result.retried),
  }
}

// ---------------- 新订单成交通知（企业微信） ----------------

const ORDER_PAID_NOTIFICATION_PREFIX = 'ntf-omp-'
const ORDER_PAID_DELIVERY_PREFIX = 'nld-omp-wecom-'
const ORDER_PAID_MAX_ATTEMPTS = 5
const orderPaidBackoffMs = attempts => Math.min(300000, 30000 * 2 ** Math.max(0, attempts - 1))

/**
 * 新订单成交通知的站内记录。确定性主键：同一笔结算无论被触发多少次
 * （支付回调重放、对账补扫、结算重放）都只产生一条。
 *
 * 刻意不走 pushWechat：企微投递由 deliverOrderPaidWecom 单独负责，
 * 否则同一条通知会在两个通道适配器上各发一次。
 *
 * @returns {Promise<{row: object|null, created: boolean}>} created=false 表示本次是重放
 */
export async function createOrderPaidNotification({ prismaClient = prisma, settlementId, username, title, content }) {
  const notificationId = `${ORDER_PAID_NOTIFICATION_PREFIX}${crypto.createHash('sha256')
    .update(String(settlementId)).digest('hex').slice(0, 32)}`
  try {
    const row = await prismaClient.notification.create({
      data: {
        id: notificationId, username, templateKey: 'online_order_paid', title, content,
        priority: 'high', status: 'unread', ackStatus: 'none', target: '',
        refType: 'online_order', refId: String(settlementId),
      },
    })
    await prismaClient.notificationDelivery.create({
      data: { id: `${ORDER_PAID_DELIVERY_PREFIX}inapp-${notificationId.slice(ORDER_PAID_NOTIFICATION_PREFIX.length)}`,
        notificationId: row.id, channel: 'inapp', status: 'sent' },
    })
    return { row, created: true }
  } catch (error) {
    if (error?.code === 'P2002') {
      const row = await prismaClient.notification.findUnique({ where: { id: notificationId } }).catch(() => null)
      return { row, created: false }
    }
    throw error
  }
}

/**
 * 新订单成交通知的企业微信投递。
 * - 由业务事务提交后调用；失败不影响订单、支付或结算。
 * - 确定性 delivery 主键抢占：支付回调重放、结算重放或进程重启都不会重复发送。
 * - 失败记录 attempts 与 nextAttemptAt，由 retryOrderPaidNotices 后台补发。
 */
export async function deliverOrderPaidWecom({ prismaClient = prisma, notification, settlementId, title, content }) {
  if (!notification?.id || !/^os-[0-9a-f]{64}$/.test(String(settlementId || ''))) {
    return { ok: false, status: 'skipped', reason: 'invalid order paid delivery event' }
  }
  const binding = orderPaidWecomRecipientBinding()
  const deliveryId = `${ORDER_PAID_DELIVERY_PREFIX}${crypto.createHash('sha256')
    .update(`${settlementId}\0${binding?.username || 'missing'}\0${binding?.userId || 'missing'}`)
    .digest('hex')
    .slice(0, 32)}`
  try {
    await prismaClient.notificationDelivery.create({
      data: { id: deliveryId, notificationId: notification.id, channel: 'wecom', status: 'pending' },
    })
  } catch (error) {
    if (error?.code === 'P2002') return { ok: true, status: 'duplicate' }
    throw error
  }
  return sendOrderPaidDelivery({ prismaClient, deliveryId, binding, notification, title, content })
}

async function sendOrderPaidDelivery({ prismaClient, deliveryId, binding, notification, title, content }) {
  const cfg = wechatPersonalConfig()
  if (!binding?.userId || !cfg || cfg.channel !== 'wecom') {
    const reason = !binding?.userId ? 'order notice recipient not configured' : 'wecom app channel not configured'
    await prismaClient.notificationDelivery.update({
      where: { id: deliveryId }, data: { status: 'skipped', error: reason },
    }).catch(() => {})
    return { ok: false, status: 'skipped', reason }
  }
  const url = notificationDeepLink(notification.target, notification.refType, notification.refId)
  const result = await sendWechatPersonal(cfg, { openId: binding.userId }, { title, content, target: notification.target, url })
  if (result.ok) {
    await prismaClient.notificationDelivery.update({
      where: { id: deliveryId },
      data: { status: 'sent', error: '', sentAt: new Date(), nextAttemptAt: null, attempts: { increment: 1 } },
    }).catch(() => {})
    return { ok: true, status: 'sent' }
  }
  const error = `send failed (errcode=${result.errcode || 'UNKNOWN'}${result.errmsg ? ` ${String(result.errmsg).slice(0, 160)}` : ''})`.slice(0, 240)
  const current = await prismaClient.notificationDelivery.findUnique({ where: { id: deliveryId } }).catch(() => null)
  const attempts = (current?.attempts || 0) + 1
  const exhausted = attempts >= ORDER_PAID_MAX_ATTEMPTS
  await prismaClient.notificationDelivery.update({
    where: { id: deliveryId },
    data: {
      status: 'failed', error, attempts: { increment: 1 },
      nextAttemptAt: exhausted ? null : new Date(Date.now() + orderPaidBackoffMs(attempts)),
    },
  }).catch(() => {})
  return { ok: false, status: 'failed', exhausted }
}

/**
 * 有界后台补发：企业微信短暂故障时补齐送达。
 * 只重试新订单通知（前缀隔离），不改动其它业务既有的投递语义。
 */
export async function retryOrderPaidNotices({ prismaClient = prisma, batchSize = 5 } = {}) {
  if (!dbReady()) return { retried: 0, sent: 0, failed: 0 }
  const rows = await prismaClient.notificationDelivery.findMany({
    where: {
      channel: 'wecom', status: 'failed', id: { startsWith: ORDER_PAID_DELIVERY_PREFIX },
      attempts: { lt: ORDER_PAID_MAX_ATTEMPTS },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
    },
    orderBy: { sentAt: 'asc' }, take: batchSize,
  }).catch(() => [])
  let sent = 0, failed = 0
  for (const row of rows) {
    const notification = await prismaClient.notification.findUnique({ where: { id: row.notificationId } }).catch(() => null)
    if (!notification) continue
    const outcome = await sendOrderPaidDelivery({
      prismaClient, deliveryId: row.id, binding: orderPaidWecomRecipientBinding(), notification,
      title: notification.title, content: notification.content,
    }).catch(() => ({ ok: false }))
    if (outcome.ok) sent++
    else failed++
  }
  return { retried: rows.length, sent, failed }
}

/** 企业微信自建应用消息：textcard 卡片，点击跳转 budu 页面（touser = 企微 userid） */
async function sendWecomTextcard(cfg, binding, title, content, jumpUrl) {
  const doSend = async (token) => {
    const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        touser: binding.openId, // 企业微信 userid
        msgtype: 'textcard',
        agentid: Number(cfg.agentId),
        textcard: {
          title: title.slice(0, 120),
          description: content.slice(0, 500),
          url: jumpUrl,
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
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        touser: binding.openId,
        template_id: cfg.templateId,
        url: jumpUrl,
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
    invalidateMiniprogramToken({ appId: cfg.appId })
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
    const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken')
    url.searchParams.set('corpid', corpId)
    url.searchParams.set('corpsecret', secret)
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
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

// The MiniProgram access_token lives in server/wechat-access-token.js (imported
// above). Do not reintroduce a cache here: one appid must have exactly one token
// authority, or WeChat invalidates the token held by the other cache and both
// start failing intermittently with 40001.
export { mpAccessToken }

/** 测试辅助：重置 access_token 缓存（企微/公众号；仅测试使用） */
export function _resetWechatTokenCaches() {
  wecomTokenCache = { token: '', at: 0 }
  _resetMiniprogramTokenAuthority()
}

/** 企微群机器人广播（兼容现状：与 sendWechatMarkdown 行为一致，统一入口） */
export async function broadcast(title, content) {
  return sendWechatMarkdown(title, content)
}

/** 辅助：获取账号用户列表（供抄送/绑定使用） */
export async function listUsernames() {
  const users = await listUsers()
  return users.map((u) => ({ username: u.username, role: u.role, name: u.displayName || u.username }))
}

// 通知中心 / 企业微信自建应用推送测试（V2.10+ 加固）
//
// 单元部分（无 DB，fetch mock）：
//   - wechatPersonalConfig 通道优先级（企微 > 公众号 > 无）
//   - renderTpl 占位符渲染
//   - sendWechatPersonal 企业微信 textcard 适配器（请求体/截断/跳转 URL）
//   - access_token 缓存复用；token 失效（40014/42001/40001）自动重取重发一次
//   - 非 token 错误不重试；公众号模板消息适配器
//   - 企微接收消息服务器验证：wecomSign 签名 + AES 解密 + GET 验证 URL 端到端
// 集成部分（真实 PostgreSQL 一次性 schema）：
//   - notify() 完整链路：站内消息 + wechat 投递记录（sent / skipped no binding /
//     skipped channel not configured）
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'
const SCHEMA = `ntf_${process.pid}`
// 必须在任何 server 模块动态 import 之前设置：pg.js 的 PrismaClient 在构造时绑定
// DATABASE_URL（globalForPrisma 单例缓存），迟设会导致集成测试拿到无 URL 的实例
const schemaUrl = (() => {
  const url = new URL(ADMIN_URL)
  url.searchParams.set('schema', SCHEMA)
  return url.toString()
})()
process.env.DATABASE_URL = schemaUrl

// ---------------- 环境辅助 ----------------
async function withEnv(env, fn) {
  const saved = {}
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

/** fetch mock：按 URL 片段路由；记录调用（url + 解析后的 body） */
function mockFetch(routes) {
  const calls = []
  const original = global.fetch
  global.fetch = async (url, options = {}) => {
    const text = String(url)
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ url: text, body })
    const hit = routes.find((r) => text.includes(r.match))
    const payload = hit ? hit.respond(calls) : { errcode: -1, errmsg: 'unexpected url' }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return { calls, restore: () => { global.fetch = original } }
}

const WECOM_ENV = {
  WXWORK_CORP_ID: 'ww-corp-1',
  WXWORK_AGENT_ID: '1000002',
  WXWORK_SECRET: 'secret-1',
}
const WECOM_CFG = { channel: 'wecom', corpId: 'ww-corp-1', agentId: '1000002', secret: 'secret-1' }
const MP_ENV = {
  MP_APP_ID: 'wx-app-1',
  MP_APP_SECRET: 'mp-secret-1',
  MP_TEMPLATE_ID: 'TPL-1',
}
const MP_CFG = { channel: 'mp', appId: 'wx-app-1', secret: 'mp-secret-1', templateId: 'TPL-1' }
const BINDING = { openId: 'zhangsan', nickname: 'zhangsan' }

// ---------------- 单元：通道配置 ----------------
test('通知中心：通道配置优先级——企微优先，其次公众号，均未配置为 null', async () => {
  const { wechatPersonalConfig } = await import('../server/notification-center.js')
  await withEnv({ ...WECOM_ENV, ...MP_ENV }, () => {
    assert.equal(wechatPersonalConfig().channel, 'wecom', '企微与公众号同时配置 → 企微优先')
  })
  await withEnv(MP_ENV, () => {
    const cfg = wechatPersonalConfig()
    assert.equal(cfg.channel, 'mp')
    assert.equal(cfg.appId, 'wx-app-1')
  })
  await withEnv({ WXWORK_CORP_ID: 'x', WXWORK_AGENT_ID: 'y' }, () => {
    assert.equal(wechatPersonalConfig(), null, '企微三件套缺一不可')
  })
  await withEnv({ MP_APP_ID: 'x', MP_APP_SECRET: 'y' }, () => {
    assert.equal(wechatPersonalConfig(), null, '公众号三件套缺一不可')
  })
  await withEnv({}, () => {
    assert.equal(wechatPersonalConfig(), null)
  })
})

test('通知中心：renderTpl 占位符渲染（缺失留空，不抛错）', async () => {
  const { renderTpl } = await import('../server/notification-center.js')
  assert.equal(renderTpl('工资条待签收：{employeeName} {period}', { employeeName: '张三', period: '2026年8月' }), '工资条待签收：张三 2026年8月')
  assert.equal(renderTpl('实发 {amount} 元', {}), '实发  元')
  assert.equal(renderTpl('', { a: 1 }), '')
  assert.equal(renderTpl('无占位', null), '无占位')
})

// ---------------- 单元：企业微信应用消息适配器 ----------------
test('企微自建应用：textcard 推送成功——请求体/跳转 URL/标题截断/agentid 数字', async () => {
  const { sendWechatPersonal, _resetWechatTokenCaches } = await import('../server/notification-center.js')
  _resetWechatTokenCaches()
  const m = mockFetch([
    { match: '/cgi-bin/gettoken', respond: () => ({ errcode: 0, access_token: 'TOK1' }) },
    { match: '/cgi-bin/message/send', respond: () => ({ errcode: 0, errmsg: 'ok' }) },
  ])
  try {
    await withEnv({ ...WECOM_ENV, PUBLIC_BASE_URL: 'https://budu.example' }, async () => {
      const longTitle = '待'.repeat(150)
      const result = await sendWechatPersonal(WECOM_CFG, BINDING, {
        title: longTitle,
        content: '工资周期 2026年8月 · 实发 5000.00 元，请核对并签收',
        target: 'staff-payroll',
      })
      assert.equal(result.ok, true)
      assert.equal(result.errcode, 0)
      const send = m.calls.find((c) => c.url.includes('/cgi-bin/message/send'))
      assert.ok(send, '必须调用 message/send')
      assert.equal(send.body.touser, 'zhangsan', 'touser = 企微 userid（绑定 openId）')
      assert.equal(send.body.msgtype, 'textcard')
      assert.equal(send.body.agentid, 1000002, 'agentid 必须为数字')
      assert.equal(send.body.textcard.title.length, 120, '标题截断到 120')
      assert.ok(send.body.textcard.url.includes('https://budu.example/?nav=staff-payroll'), `跳转 URL 错误: ${send.body.textcard.url}`)
      assert.equal(send.body.textcard.btntxt, '查看详情')
      // token 缓存：第二次发送不再请求 gettoken
      await sendWechatPersonal(WECOM_CFG, BINDING, { title: 't', content: 'c', target: '' })
      assert.equal(m.calls.filter((c) => c.url.includes('gettoken')).length, 1, 'access_token 必须缓存复用')
    })
  } finally {
    m.restore()
    _resetWechatTokenCaches()
  }
})

test('企微自建应用：token 失效（40014）→ 清缓存重取并重发一次，成功', async () => {
  const { sendWechatPersonal, _resetWechatTokenCaches } = await import('../server/notification-center.js')
  _resetWechatTokenCaches()
  let tokenCalls = 0
  const m = mockFetch([
    { match: '/cgi-bin/gettoken', respond: () => { tokenCalls += 1; return { errcode: 0, access_token: `TOK${tokenCalls}` } } },
    {
      match: '/cgi-bin/message/send',
      respond: (calls) => {
        const sends = calls.filter((c) => c.url.includes('message/send')).length
        return sends === 1 ? { errcode: 40014, errmsg: 'invalid access_token' } : { errcode: 0, errmsg: 'ok' }
      },
    },
  ])
  try {
    const result = await sendWechatPersonal(WECOM_CFG, BINDING, { title: 't', content: 'c', target: '' })
    assert.equal(result.ok, true)
    assert.equal(result.retried, true, '必须标记为重试成功')
    assert.equal(m.calls.filter((c) => c.url.includes('message/send')).length, 2, '发送两次')
    assert.equal(tokenCalls, 2, 'token 失效后必须重取')
  } finally {
    m.restore()
    _resetWechatTokenCaches()
  }
})

test('企微自建应用：非 token 错误（60011 无权限）不重试，errcode 返回调用方', async () => {
  const { sendWechatPersonal, _resetWechatTokenCaches } = await import('../server/notification-center.js')
  _resetWechatTokenCaches()
  let tokenCalls = 0
  const m = mockFetch([
    { match: '/cgi-bin/gettoken', respond: () => { tokenCalls += 1; return { errcode: 0, access_token: 'TOK1' } } },
    { match: '/cgi-bin/message/send', respond: () => ({ errcode: 60011, errmsg: 'no privilege to access-modify-api' }) },
  ])
  try {
    const result = await sendWechatPersonal(WECOM_CFG, BINDING, { title: 't', content: 'c', target: '' })
    assert.equal(result.ok, false)
    assert.equal(result.errcode, 60011)
    assert.equal(result.retried, undefined, '非 token 错误不得重试')
    assert.equal(m.calls.filter((c) => c.url.includes('message/send')).length, 1)
    assert.equal(tokenCalls, 1)
  } finally {
    m.restore()
    _resetWechatTokenCaches()
  }
})

test('企微自建应用：gettoken 失败 → TOKEN_FETCH_FAILED，不调用发送', async () => {
  const { sendWechatPersonal, _resetWechatTokenCaches } = await import('../server/notification-center.js')
  _resetWechatTokenCaches()
  const m = mockFetch([
    { match: '/cgi-bin/gettoken', respond: () => ({ errcode: 40013, errmsg: 'invalid corpid' }) },
  ])
  try {
    const result = await sendWechatPersonal(WECOM_CFG, BINDING, { title: 't', content: 'c', target: '' })
    assert.equal(result.ok, false)
    assert.equal(result.errcode, 'TOKEN_FETCH_FAILED')
    assert.equal(m.calls.filter((c) => c.url.includes('message/send')).length, 0)
  } finally {
    m.restore()
    _resetWechatTokenCaches()
  }
})

// ---------------- 单元：公众号模板消息适配器 ----------------
test('公众号：模板消息推送成功（请求体结构正确）', async () => {
  const { sendWechatPersonal, _resetWechatTokenCaches } = await import('../server/notification-center.js')
  _resetWechatTokenCaches()
  const m = mockFetch([
    { match: '/cgi-bin/token', respond: () => ({ access_token: 'MPTOK1' }) },
    { match: '/cgi-bin/message/template/send', respond: () => ({ errcode: 0, errmsg: 'ok' }) },
  ])
  try {
    const result = await sendWechatPersonal(MP_CFG, BINDING, { title: '工资条待签收', content: '实发 5000 元', target: 'staff-payroll' })
    assert.equal(result.ok, true)
    const send = m.calls.find((c) => c.url.includes('message/template/send'))
    assert.ok(send)
    assert.equal(send.body.touser, 'zhangsan')
    assert.equal(send.body.template_id, 'TPL-1')
    assert.equal(send.body.data.first.value, '工资条待签收')
  } finally {
    m.restore()
    _resetWechatTokenCaches()
  }
})

// ---------------- 单元：企微接收消息服务器验证（签名 + 解密 + URL 验证） ----------------
function encryptWecomMsg(encodingAESKey, plain, receiveId) {
  const aesKey = Buffer.from(`${encodingAESKey}=`, 'base64')
  const iv = aesKey.subarray(0, 16)
  const random = crypto.randomBytes(16)
  const msgBuf = Buffer.from(plain, 'utf8')
  const msgLen = Buffer.alloc(4)
  msgLen.writeUInt32BE(msgBuf.length, 0)
  const raw = Buffer.concat([random, msgLen, msgBuf, Buffer.from(receiveId, 'utf8')])
  const pad = 32 - (raw.length % 32)
  const padded = Buffer.concat([raw, Buffer.alloc(pad, pad)])
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv)
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64')
}

test('企微接收消息：签名校验 + AES 解密往返 + GET 验证 URL 端到端（含篡改拒绝）', async () => {
  const { wecomSign, decryptWecomMsg, wechatRecvRouter } = await import('../server/wechat-bind.js')
  const TOKEN = 'budu2025' // 与 wechat-bind.js 默认 RECV_TOKEN 一致
  const AES_KEY = 'WOEs16DWhc0hW3U4u4knxGuxRVOHowN+eKrX8Hl+gxU'
  const plain = 'budu-wecom-verify-ok'
  const echostr = encryptWecomMsg(AES_KEY, plain, 'ww-corp-1')
  const timestamp = '1755849600'
  const nonce = 'nonce123'
  const msgSignature = wecomSign(TOKEN, timestamp, nonce, echostr)
  // 解密往返
  assert.equal(decryptWecomMsg(AES_KEY, echostr), plain)
  // 签名排序正确性：篡改任一输入 → 签名不一致
  assert.notEqual(wecomSign(TOKEN, timestamp, nonce, echostr), wecomSign('WRONG', timestamp, nonce, echostr))
  // GET 验证 URL 端到端（真实 express 挂载）
  const expressModule = await import('express')
  const app = expressModule.default()
  app.use('/api/v2/wechat/recv', wechatRecvRouter)
  const server = app.listen(0)
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const okRes = await fetch(`${base}/api/v2/wechat/recv/?msg_signature=${msgSignature}&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}`)
    assert.equal(okRes.status, 200)
    assert.equal(await okRes.text(), plain)
    const badRes = await fetch(`${base}/api/v2/wechat/recv/?msg_signature=deadbeef&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}`)
    assert.equal(badRes.status, 403, '签名不匹配必须拒绝')
  } finally {
    server.close()
  }
})

// ---------------- 集成：notify 完整链路（真实 PostgreSQL） ----------------
let prisma = null
let started = false

function requireStarted(t) {
  if (!started) {
    assert.fail('NOTIFICATION_DB_TEST_NOT_RUN — 前置步骤失败（PostgreSQL 不可用），本断言必须失败而非跳过')
    return false
  }
  return true
}

async function waitFor(predicate, timeoutMs = 4000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  return null
}

test('通知中心集成（真实 PostgreSQL，一次性 schema；不可用 → 套件 FAIL）', async (t) => {
  await t.test('前置：连接本地 PostgreSQL 并部署迁移', async () => {
    const { PrismaClient } = await import('@prisma/client')
    const probe = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
    try {
      await probe.$queryRaw`SELECT 1`
    } catch (error) {
      await probe.$disconnect().catch(() => {})
      throw new Error(`NOTIFICATION_DB_TEST_NOT_RUN — 本地 PostgreSQL 不可用：${error.message}`)
    }
    await probe.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await probe.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`)
    await probe.$disconnect()
    execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: schemaUrl },
      stdio: 'inherit',
      timeout: 180000,
    })
    const { prisma: p } = await import('../server/pg.js')
    prisma = p
    started = true
  })

  await t.test('工资条 notify → 站内消息 + 企微投递记录 sent', async () => {
    if (!requireStarted(t)) return
    const { notify, ensureNotificationTemplates, _resetWechatTokenCaches } = await import('../server/notification-center.js')
    _resetWechatTokenCaches()
    await ensureNotificationTemplates()
    await prisma.wechatBinding.create({
      data: { id: `wb-${process.pid}`, username: 'zhangsan', channel: 'wecom', openId: 'zhangsan', nickname: '张三', status: 'active' },
    })
    const m = mockFetch([
      { match: '/cgi-bin/gettoken', respond: () => ({ errcode: 0, access_token: 'TOK-INT' }) },
      { match: '/cgi-bin/message/send', respond: () => ({ errcode: 0, errmsg: 'ok' }) },
    ])
    try {
      await withEnv(
        { ...WECOM_ENV, PUBLIC_BASE_URL: 'https://budu.example' },
        async () => {
          const row = await notify({
            username: 'zhangsan',
            templateKey: 'payroll_pending',
            data: { employeeName: '张三', period: '2026年8月', amount: '5000.00' },
            priority: 'high',
            target: 'staff-payroll',
            refType: 'payroll',
            refId: 'payroll-1',
            ack: true,
          })
          assert.ok(row, 'notify 必须返回站内消息')
          assert.equal(row.title, '工资条待签收：张三 2026年8月')
          assert.ok(row.content.includes('5000.00'), `内容渲染错误: ${row.content}`)
          assert.equal(row.ackStatus, 'pending')
          assert.equal(row.target, 'staff-payroll')
          // 等待 notify 触发的异步推送完成
          const delivery = await waitFor(async () => {
            const rows = await prisma.notificationDelivery.findMany({ where: { notificationId: row.id, channel: 'wechat' } })
            return rows.length ? rows[0] : null
          })
          assert.ok(delivery, '必须产生 wechat 投递记录')
          assert.equal(delivery.status, 'sent', `投递失败：${delivery.error}`)
          assert.equal(delivery.error, '')
          const inapp = await prisma.notificationDelivery.findFirst({ where: { notificationId: row.id, channel: 'inapp' } })
          assert.equal(inapp.status, 'sent')
          // 推送内容正确（企微侧收到的是渲染后的标题/内容）
          const send = m.calls.find((c) => c.url.includes('message/send'))
          assert.ok(send)
          assert.equal(send.body.textcard.title, '工资条待签收：张三 2026年8月')
        },
      )
    } finally {
      m.restore()
      _resetWechatTokenCaches()
    }
  })

  await t.test('未绑定 → skipped(no binding)；未配置通道 → skipped(channel not configured)', async () => {
    if (!requireStarted(t)) return
    const { pushWechat, _resetWechatTokenCaches } = await import('../server/notification-center.js')
    _resetWechatTokenCaches()
    const row = await prisma.notification.create({
      data: {
        id: `ntf-${process.pid}-nb`,
        username: 'lisi',
        templateKey: 'payroll_pending',
        title: '工资条待签收：李四 2026年8月',
        content: '实发 3000.00 元',
        priority: 'high',
        status: 'unread',
        ackStatus: 'none',
        target: 'staff-payroll',
        refType: 'payroll',
        refId: 'payroll-2',
      },
    })
    const m = mockFetch([
      { match: '/cgi-bin/gettoken', respond: () => ({ errcode: 0, access_token: 'TOK-NB' }) },
    ])
    try {
      // 1) 已配置通道但该用户未绑定
      await withEnv(WECOM_ENV, async () => {
        await pushWechat(row, row.title, row.content, row.target)
        const nb = await prisma.notificationDelivery.findFirst({ where: { notificationId: row.id, channel: 'wechat' } })
        assert.equal(nb.status, 'skipped')
        assert.equal(nb.error, 'no binding')
      })
      // 2) 通道未配置（清空 WXWORK_* / MP_*）
      await withEnv({ WXWORK_CORP_ID: '', WXWORK_AGENT_ID: '', WXWORK_SECRET: '', MP_APP_ID: '', MP_APP_SECRET: '', MP_TEMPLATE_ID: '' }, async () => {
        const row2 = await prisma.notification.create({
          data: {
            id: `ntf-${process.pid}-nc`,
            username: 'wangwu',
            templateKey: 'payroll_pending',
            title: 't',
            content: 'c',
            priority: 'normal',
            status: 'unread',
            ackStatus: 'none',
            target: '',
            refType: '',
            refId: '',
          },
        })
        await pushWechat(row2, 't', 'c', '')
        const nc = await prisma.notificationDelivery.findFirst({ where: { notificationId: row2.id, channel: 'wechat' } })
        assert.equal(nc.status, 'skipped')
        assert.equal(nc.error, 'wechat channel not configured')
      })
      // 通道未配置时不发起任何企微调用
      assert.equal(m.calls.length, 0, '未配置通道时不得调用企微接口')
    } finally {
      m.restore()
      _resetWechatTokenCaches()
    }
  })

  await t.test('清理：删除一次性 schema', async () => {
    if (!started) return
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await prisma.$disconnect()
    started = false
  })
})

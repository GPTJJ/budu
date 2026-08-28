import test from 'node:test'
import assert from 'node:assert/strict'

process.env.PUBLIC_BASE_URL = 'https://budu.example'

const {
  _resetWechatTokenCaches,
  customerRequestWecomRecipientUserId,
  deliverCustomerRequestWecom,
  notificationDeepLink,
} = await import('../server/notification-center.js')

function fakePrisma() {
  const rows = new Map()
  return {
    rows,
    notificationDelivery: {
      async create({ data }) {
        if (rows.has(data.id)) throw Object.assign(new Error('duplicate'), { code: 'P2002' })
        rows.set(data.id, { ...data })
        return rows.get(data.id)
      },
      async update({ where, data }) {
        rows.set(where.id, { ...rows.get(where.id), ...data })
        return rows.get(where.id)
      },
    },
  }
}

function installFetch({ timeout = false } = {}) {
  const original = global.fetch
  const calls = []
  global.fetch = async (url, options = {}) => {
    const href = String(url)
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ href, body })
    if (href.includes('/gettoken')) return Response.json({ errcode: 0, access_token: 'test-token' })
    if (timeout) throw new Error('timeout')
    return Response.json({ errcode: 0, errmsg: 'ok' })
  }
  return { calls, restore: () => { global.fetch = original } }
}

function setWecomEnv(recipient = 'hudonghui-exact-userid') {
  process.env.WXWORK_CORP_ID = 'ww-test'
  process.env.WXWORK_AGENT_ID = '1000002'
  process.env.WXWORK_SECRET = 'test-secret'
  process.env.CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID = recipient
}

const notificationFor = (type) => ({
  id: `ntf-${type.toLowerCase()}`,
  target: type === 'MAILING' ? 'store-mailing' : 'finance-invoice',
  refType: type === 'MAILING' ? 'mailing' : 'invoice',
  refId: `record-${type.toLowerCase()}`,
})

for (const type of ['MAILING', 'INVOICE']) {
  test(`${type} uses one exact recipient, safe content and record deep link`, async () => {
    setWecomEnv()
    _resetWechatTokenCaches()
    const fetchMock = installFetch()
    const prisma = fakePrisma()
    try {
      const notification = notificationFor(type)
      const first = await deliverCustomerRequestWecom({
        prismaClient: prisma,
        notification,
        requestId: `request-${type.toLowerCase()}`,
        type,
        storeName: '测试门店',
        submittedAt: new Date('2026-08-28T07:30:00.000Z'),
      })
      assert.equal(first.status, 'sent')
      assert.equal(first.recipientCount, 1)
      const sends = fetchMock.calls.filter((call) => call.href.includes('/message/send'))
      assert.equal(sends.length, 1)
      assert.equal(sends[0].body.touser, 'hudonghui-exact-userid')
      assert.equal(sends[0].body.touser.includes('|'), false)
      const link = new URL(sends[0].body.textcard.url)
      assert.equal(link.origin, 'https://budu.example')
      assert.equal(link.searchParams.get('nav'), notification.target)
      assert.equal(link.searchParams.get('refId'), notification.refId)
      const message = JSON.stringify(sends[0].body)
      for (const pii of ['13800138000', '完整地址', '完整税号', 'private@example.test']) {
        assert.equal(message.includes(pii), false)
      }
      const duplicate = await deliverCustomerRequestWecom({
        prismaClient: prisma,
        notification,
        requestId: `request-${type.toLowerCase()}`,
        type,
        storeName: '测试门店',
        submittedAt: new Date('2026-08-28T07:30:00.000Z'),
      })
      assert.equal(duplicate.status, 'duplicate')
      assert.equal(fetchMock.calls.filter((call) => call.href.includes('/message/send')).length, 1)
    } finally {
      fetchMock.restore()
      _resetWechatTokenCaches()
    }
  })
}

test('provider timeout is recorded as failed without leaking token or secret', async () => {
  setWecomEnv()
  _resetWechatTokenCaches()
  const fetchMock = installFetch({ timeout: true })
  const prisma = fakePrisma()
  const originalConsoleError = console.error
  const errorLogs = []
  console.error = (...values) => errorLogs.push(values.map(String).join(' '))
  try {
    const result = await deliverCustomerRequestWecom({
      prismaClient: prisma,
      notification: notificationFor('MAILING'),
      requestId: 'request-timeout',
      type: 'MAILING',
      storeName: '测试门店',
      submittedAt: new Date(),
    })
    assert.equal(result.status, 'failed')
    const row = [...prisma.rows.values()][0]
    assert.equal(row.error.includes('test-secret'), false)
    assert.equal(row.error.includes('test-token'), false)
    assert.equal(errorLogs.some((line) => line.includes('test-secret') || line.includes('test-token')), false)
  } finally {
    console.error = originalConsoleError
    fetchMock.restore()
    _resetWechatTokenCaches()
  }
})

test('missing or name-shaped recipient config fails closed without provider call', async () => {
  setWecomEnv('胡东辉')
  _resetWechatTokenCaches()
  const fetchMock = installFetch()
  const prisma = fakePrisma()
  try {
    assert.equal(customerRequestWecomRecipientUserId(), '')
    const result = await deliverCustomerRequestWecom({
      prismaClient: prisma,
      notification: notificationFor('MAILING'),
      requestId: 'request-invalid-recipient',
      type: 'MAILING',
      storeName: '测试门店',
      submittedAt: new Date(),
    })
    assert.equal(result.status, 'skipped')
    assert.equal(fetchMock.calls.length, 0)
    assert.equal(notificationDeepLink('store-mailing', 'mailing', 'record-safe').startsWith('https://budu.example/'), true)
  } finally {
    fetchMock.restore()
    _resetWechatTokenCaches()
  }
})

test('record deep link is consumed into the existing authenticated focus contract', async () => {
  const stored = new Map()
  global.sessionStorage = {
    setItem: (key, value) => stored.set(key, value),
    getItem: (key) => stored.get(key) || null,
    removeItem: (key) => stored.delete(key),
  }
  global.window = {
    location: { pathname: '/', search: '?nav=store-mailing&refType=mailing&refId=record-safe', hash: '' },
    history: { replaceState: (_state, _title, url) => { global.window.replacedUrl = url } },
  }
  const { consumeNotificationDeepLink, takeNotificationRecordFocus } = await import('../src/utils/notificationNavigation.js')
  assert.equal(consumeNotificationDeepLink(), 'store-mailing')
  assert.equal(takeNotificationRecordFocus('store-mailing'), 'record-safe')
  assert.equal(global.window.replacedUrl, '/')
  delete global.window
  delete global.sessionStorage
})

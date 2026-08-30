import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

process.env.PUBLIC_BASE_URL = 'https://budu.example'

const {
  TRANSFER_FALLBACK_REASONS,
  TRANSFER_RECIPIENT_POLICY,
  deliverTransferRequestNotification,
  transferBusinessDate,
  transferItemSummary,
} = await import('../server/transfer-notification.js')
const { sendWechatMarkdownResult, wecomWebhookUrl } = await import('../server/wechat-alert.js')

const PERSONAL_CONFIG = { channel: 'wecom', corpId: 'ww-test', agentId: '1', secret: 'secret' }
const DEVELOPER_BINDING = { username: 'budu', userId: 'dh' }

const employee = (id, name = id) => ({ id, name })
const user = (employeeId) => ({ id: `user-${employeeId}`, username: `account-${employeeId}`, employeeId, status: 'active' })
const binding = (employeeId) => ({ username: `account-${employeeId}`, openId: `wecom-${employeeId}`, channel: 'wecom', status: 'active' })
const shift = (employeeId, time = '') => ({ employeeId, staff: `员工-${employeeId}`, time, note: '' })

const transfer = (overrides = {}) => ({
  id: 'tr-routing-1',
  fromStoreKey: 'guanshe',
  fromStoreName: '北京官舍店',
  storeKey: 'tongying',
  storeName: '北京通盈中心店',
  createdBy: 'requester',
  createdAt: new Date('2026-08-30T03:00:00.000Z'),
  status: 'pending',
  items: [
    { itemCode: 'NO.2', productName: '柠檬', quantity: null, boxQuantity: 0, pieceQuantity: 166 },
    { itemCode: 'NO.10', productName: '香草', quantity: null, boxQuantity: 1, pieceQuantity: 50 },
    { itemCode: 'MAT-1', productName: '冰袋', quantity: 8 },
  ],
  ...overrides,
})

function fakePrisma({ schedules = [], employees = [], users = [], bindings = [], scheduleError = null } = {}) {
  const notifications = new Map()
  const deliveries = new Map()
  return {
    notifications,
    deliveries,
    schedule: {
      async findMany({ where }) {
        if (scheduleError) throw scheduleError
        return schedules.filter((row) => row.storeKey === where.storeKey && row.date === where.date).slice(0, 2)
      },
    },
    employee: {
      async findMany({ where }) {
        return employees.filter((row) => where.id.in.includes(row.id)).map(({ id, name }) => ({ id, name }))
      },
    },
    user: {
      async findMany({ where }) {
        return users.filter((row) => where.employeeId.in.includes(row.employeeId) && row.status === where.status)
      },
    },
    wechatBinding: {
      async findMany({ where }) {
        return bindings.filter((row) => where.username.in.includes(row.username) && row.channel === where.channel && row.status === where.status)
      },
    },
    notification: {
      async create({ data }) {
        if (notifications.has(data.id)) throw Object.assign(new Error('duplicate notification'), { code: 'P2002' })
        notifications.set(data.id, { ...data })
        return notifications.get(data.id)
      },
      async findUnique({ where }) {
        return notifications.get(where.id) || null
      },
    },
    notificationDelivery: {
      async create({ data }) {
        if (deliveries.has(data.id)) throw Object.assign(new Error('duplicate delivery'), { code: 'P2002' })
        deliveries.set(data.id, { ...data })
        return deliveries.get(data.id)
      },
      async update({ where, data }) {
        deliveries.set(where.id, { ...deliveries.get(where.id), ...data })
        return deliveries.get(where.id)
      },
    },
  }
}

function sendHarness() {
  const personal = []
  const group = []
  return {
    personal,
    group,
    sendPersonal: async (_cfg, recipient, message) => {
      personal.push({ recipient, message })
      return { ok: true, errcode: 0, errmsg: 'ok' }
    },
    sendGroup: async (title, content) => {
      group.push({ title, content })
      return { ok: true, errcode: 0, errmsg: 'ok' }
    },
  }
}

async function route(prismaClient, sends, request = transfer()) {
  return deliverTransferRequestNotification({
    prismaClient,
    transfer: request,
    personalConfig: PERSONAL_CONFIG,
    developerBinding: DEVELOPER_BINDING,
    sendPersonal: sends.sendPersonal,
    sendGroup: sends.sendGroup,
  })
}

test('business date is Asia/Shanghai date and item summary preserves box/piece/legacy facts', () => {
  assert.equal(transferBusinessDate('2026-08-29T16:30:00.000Z'), '2026-08-30')
  const summary = transferItemSummary(transfer().items)
  assert.match(summary, /NO\.2 柠檬 166颗/)
  assert.match(summary, /NO\.10 香草 1箱 \+ 50颗/)
  assert.match(summary, /MAT-1 冰袋 8件/)
})

test('group robot requires explicit webhook config and verifies provider errcode', async () => {
  const originalWebhook = process.env.WECHAT_WORK_WEBHOOK_URL
  const originalFetch = global.fetch
  const calls = []
  try {
    delete process.env.WECHAT_WORK_WEBHOOK_URL
    global.fetch = async (...args) => {
      calls.push(args)
      return Response.json({ errcode: 0, errmsg: 'ok' })
    }
    assert.equal(wecomWebhookUrl(), '')
    assert.equal((await sendWechatMarkdownResult('title', 'content')).errcode, 'CONFIG_MISSING')
    assert.equal(calls.length, 0)
    process.env.WECHAT_WORK_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only'
    assert.equal((await sendWechatMarkdownResult('title', 'content')).ok, true)
    assert.equal(calls.length, 1)
    global.fetch = async () => Response.json({ errcode: 93000, errmsg: 'invalid webhook' })
    const failed = await sendWechatMarkdownResult('title', 'content')
    assert.equal(failed.ok, false)
    assert.equal(failed.errcode, 93000)
  } finally {
    global.fetch = originalFetch
    if (originalWebhook === undefined) delete process.env.WECHAT_WORK_WEBHOOK_URL
    else process.env.WECHAT_WORK_WEBHOOK_URL = originalWebhook
  }
})

test('one scheduled employee receives one personal message; normal group and developer are zero', async () => {
  const prismaClient = fakePrisma({
    schedules: [{ id: 'sc-1', storeKey: 'guanshe', date: '2026-08-30', shifts: [shift('e1', '10:00–18:00')] }],
    employees: [employee('e1')], users: [user('e1')], bindings: [binding('e1')],
  })
  const sends = sendHarness()
  const result = await route(prismaClient, sends)
  assert.equal(result.ok, true)
  assert.equal(result.recipientPolicy, TRANSFER_RECIPIENT_POLICY)
  assert.equal(result.groupCount, 0)
  assert.equal(result.developerCount, 0)
  assert.equal(sends.personal.length, 1)
  assert.equal(sends.personal[0].recipient.openId, 'wecom-e1')
  assert.equal(sends.group.length, 0)
  assert.equal([...prismaClient.deliveries.values()].filter((row) => row.channel === 'inapp' && row.status === 'sent').length, 1)
})

test('all scheduled staff across different shifts receive regardless of submission time', async () => {
  const ids = ['e1', 'e2', 'e3']
  const prismaClient = fakePrisma({
    schedules: [{ id: 'sc-1', storeKey: 'guanshe', date: '2026-08-30', shifts: [
      shift('e1', '10:00–18:00'), shift('e2', '13:00–21:00'), shift('e3', '18:00–22:00'),
    ] }],
    employees: ids.map((id) => employee(id)), users: ids.map((id) => user(id)), bindings: ids.map((id) => binding(id)),
  })
  for (const submittedAt of ['2026-08-30T03:00:00.000Z', '2026-08-30T06:00:00.000Z', '2026-08-30T12:00:00.000Z']) {
    const sends = sendHarness()
    const request = transfer({ id: `tr-${submittedAt}`, createdAt: new Date(submittedAt) })
    const result = await route(prismaClient, sends, request)
    assert.equal(result.status, 'scheduled_staff')
    assert.deepEqual(result.scheduledEmployeeIds, ids)
    assert.equal(sends.personal.length, 3)
    assert.equal(sends.group.length, 0)
  }
})

test('duplicate employeeId schedule rows are deduplicated to one personal delivery', async () => {
  const prismaClient = fakePrisma({
    schedules: [{ id: 'sc-1', storeKey: 'guanshe', date: '2026-08-30', shifts: [shift('e1', '早班'), shift('e1', '晚班')] }],
    employees: [employee('e1')], users: [user('e1')], bindings: [binding('e1')],
  })
  const sends = sendHarness()
  const result = await route(prismaClient, sends)
  assert.deepEqual(result.scheduledEmployeeIds, ['e1'])
  assert.equal(sends.personal.length, 1)
})

test('partial missing bindings notify reachable scheduled staff and do not trigger fallback', async () => {
  const ids = ['e1', 'e2', 'e3']
  const prismaClient = fakePrisma({
    schedules: [{ id: 'sc-1', storeKey: 'guanshe', date: '2026-08-30', shifts: ids.map((id) => shift(id)) }],
    employees: ids.map((id) => employee(id)), users: ids.map((id) => user(id)), bindings: [binding('e1'), binding('e2')],
  })
  const sends = sendHarness()
  const result = await route(prismaClient, sends)
  assert.equal(result.status, 'scheduled_staff')
  assert.equal(sends.personal.length, 2)
  assert.equal(sends.group.length, 0)
  assert.equal(result.deliveries.find((row) => row.employeeId === 'e3').status, 'skipped')
  assert.equal(result.developerCount, 0)
})

for (const scenario of [
  {
    name: 'all scheduled staff lack bindings',
    expected: TRANSFER_FALLBACK_REASONS.NO_REACHABLE_SCHEDULED_STAFF,
    data: { schedules: [{ id: 'sc-1', storeKey: 'guanshe', date: '2026-08-30', shifts: [shift('e1')] }], employees: [employee('e1')], users: [user('e1')] },
  },
  {
    name: 'no staff is scheduled for business date (yesterday/tomorrow do not receive)',
    expected: TRANSFER_FALLBACK_REASONS.NO_SCHEDULED_STAFF,
    data: { schedules: [
      { id: 'sc-yesterday', storeKey: 'guanshe', date: '2026-08-29', shifts: [shift('e1')] },
      { id: 'sc-tomorrow', storeKey: 'guanshe', date: '2026-08-31', shifts: [shift('e1')] },
    ], employees: [employee('e1')], users: [user('e1')], bindings: [binding('e1')] },
  },
  {
    name: 'schedule resolver failure',
    expected: TRANSFER_FALLBACK_REASONS.SCHEDULE_RESOLUTION_FAILED,
    data: { scheduleError: new Error('database unavailable') },
  },
  {
    name: 'legacy name-only schedule fails closed without name matching',
    expected: TRANSFER_FALLBACK_REASONS.SCHEDULE_RESOLUTION_FAILED,
    data: { schedules: [{ id: 'sc-legacy', storeKey: 'guanshe', date: '2026-08-30', shifts: [{ staff: '同名员工', time: '早班' }] }] },
  },
]) {
  test(`${scenario.name} => one group + one developer fallback`, async () => {
    const prismaClient = fakePrisma(scenario.data)
    const sends = sendHarness()
    const result = await route(prismaClient, sends)
    assert.equal(result.status, 'fallback')
    assert.equal(result.reason, scenario.expected)
    assert.equal(result.group.status, 'sent')
    assert.equal(result.developer.status, 'sent')
    assert.equal(sends.group.length, 1)
    assert.equal(sends.personal.length, 1)
    assert.equal(sends.personal[0].recipient.openId, 'dh')
  })
}

test('provider failure is recorded and never falls back to group/developer', async () => {
  const prismaClient = fakePrisma({
    schedules: [{ id: 'sc-1', storeKey: 'guanshe', date: '2026-08-30', shifts: [shift('e1')] }],
    employees: [employee('e1')], users: [user('e1')], bindings: [binding('e1')],
  })
  const sends = sendHarness()
  sends.sendPersonal = async () => ({ ok: false, errcode: 60011, errmsg: 'not allowed' })
  const result = await route(prismaClient, sends)
  assert.equal(result.ok, false)
  assert.equal(result.status, 'scheduled_staff')
  assert.equal(sends.group.length, 0)
  const individual = [...prismaClient.deliveries.values()].find((row) => row.channel === 'wecom_individual')
  assert.equal(individual.status, 'failed')
})

test('delivery is idempotent and repeated event does not send duplicates', async () => {
  const prismaClient = fakePrisma({
    schedules: [{ id: 'sc-1', storeKey: 'guanshe', date: '2026-08-30', shifts: [shift('e1')] }],
    employees: [employee('e1')], users: [user('e1')], bindings: [binding('e1')],
  })
  const sends = sendHarness()
  await route(prismaClient, sends)
  await route(prismaClient, sends)
  assert.equal(sends.personal.length, 1)
  assert.equal(sends.group.length, 0)
})

test('fixed four-person and time-of-day routing are absent; other notification entry points remain', () => {
  const source = fs.readFileSync(new URL('../server/transfer-notification.js', import.meta.url), 'utf8')
  const v2 = fs.readFileSync(new URL('../server/v2.js', import.meta.url), 'utf8')
  const notificationCenter = fs.readFileSync(new URL('../server/notification-center.js', import.meta.url), 'utf8')
  for (const forbidden of ['陈文慧', '隋晓', '陈荣梅', '舒敏', 'actualHours', 'startTime', 'endTime', 'transferStoreRecipients', 'notifyTransferStore']) {
    assert.equal(source.includes(forbidden) || v2.includes(forbidden), false, `forbidden transfer routing authority: ${forbidden}`)
  }
  assert.match(source, /employeeId/)
  assert.match(source, /storeKey, date: businessDate/)
  assert.match(notificationCenter, /export async function notify\(opt\)/)
  assert.match(notificationCenter, /deliverCustomerRequestWecom/)
})

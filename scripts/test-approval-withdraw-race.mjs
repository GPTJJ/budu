import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'

// Route-level, deterministic interleaving against disposable in-process PostgreSQL.
process.env.DATABASE_URL = 'postgresql://localhost/approval_pglite'
const db = new PGlite()
await db.exec(`
  CREATE TABLE approval_requests (
    id text PRIMARY KEY, request_no text NOT NULL, template_key text NOT NULL,
    title text NOT NULL, status text NOT NULL, form_data jsonb NOT NULL,
    amount_cents bigint NOT NULL, submitter_username text NOT NULL,
    submitter_name text NOT NULL, approved_at timestamptz, archived_at timestamptz,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE approval_nodes (
    id text PRIMARY KEY, request_id text NOT NULL REFERENCES approval_requests(id),
    node_index integer NOT NULL, approver_username text NOT NULL,
    status text NOT NULL, comment text NOT NULL DEFAULT '', acted_at timestamptz
  );
  CREATE TABLE approval_logs (
    id text PRIMARY KEY, request_id text NOT NULL REFERENCES approval_requests(id),
    action text NOT NULL, username text NOT NULL, detail text NOT NULL
  );
  CREATE TABLE approval_comments (
    id text PRIMARY KEY, request_id text NOT NULL REFERENCES approval_requests(id),
    node_id text, username text NOT NULL, user_role text NOT NULL, content text NOT NULL
  );
  CREATE TABLE approval_notifications (
    id text PRIMARY KEY, request_id text NOT NULL REFERENCES approval_requests(id),
    username text NOT NULL, type text NOT NULL, title text NOT NULL, content text NOT NULL
  );
`)

const users = [
  { id: 'submitter', username: 'submitter', role: 'staff', displayName: 'Submitter', storeKeys: [], permissions: {} },
  { id: 'approver', username: 'approver', role: 'admin', displayName: 'Approver', storeKeys: [], permissions: {} },
]
let readBarrier = null
let sequence = 0
const centerNotifications = []

function holdNextRead() {
  let enter
  let release
  const entered = new Promise((resolve) => { enter = resolve })
  const released = new Promise((resolve) => { release = resolve })
  readBarrier = { enter, released }
  return { entered, release }
}

function toRequest(row) {
  if (!row) return null
  return {
    id: row.id, requestNo: row.request_no, templateKey: row.template_key,
    title: row.title, status: row.status, formData: row.form_data,
    amountCents: row.amount_cents, submitterUsername: row.submitter_username,
    submitterName: row.submitter_name, approvedAt: row.approved_at,
    archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function delegates(client) {
  return {
    approvalRequest: {
      async findUnique({ where }) {
        const result = await client.query('SELECT * FROM approval_requests WHERE id = $1', [where.id])
        const row = toRequest(result.rows[0])
        if (readBarrier) {
          const barrier = readBarrier
          readBarrier = null
          barrier.enter()
          await barrier.released
        }
        return row
      },
      async update({ where, data }) {
        const result = await client.query(
          'UPDATE approval_requests SET status = $1, updated_at = now() WHERE id = $2 RETURNING *',
          [data.status, where.id],
        )
        return toRequest(result.rows[0])
      },
      async updateMany({ where, data }) {
        const result = await client.query(
          'UPDATE approval_requests SET status = $1, approved_at = $2, updated_at = now() WHERE id = $3 AND status = $4 RETURNING id',
          [data.status, data.approvedAt?.toISOString() || null, where.id, where.status],
        )
        return { count: result.rows.length }
      },
    },
    approvalTemplate: {
      async findUnique() { return { key: 'expense', name: '报销审批', approverRule: { type: 'role', role: 'admin' } } },
    },
    user: { async findMany() { return users } },
    approvalNode: {
      async findFirst({ where }) {
        const result = await client.query(
          'SELECT * FROM approval_nodes WHERE request_id = $1 AND status = $2 ORDER BY node_index LIMIT 1',
          [where.requestId, where.status],
        )
        return result.rows[0] ? { id: result.rows[0].id, status: result.rows[0].status } : null
      },
      async update({ where, data }) {
        await client.query(
          'UPDATE approval_nodes SET status = $1, comment = $2, acted_at = $3 WHERE id = $4',
          [data.status, data.comment, data.actedAt.toISOString(), where.id],
        )
      },
    },
    approvalLog: {
      async create({ data }) {
        await client.query(
          'INSERT INTO approval_logs (id, request_id, action, username, detail) VALUES ($1, $2, $3, $4, $5)',
          [data.id, data.requestId, data.action, data.username, data.detail],
        )
      },
    },
    approvalComment: {
      async create({ data }) {
        await client.query(
          'INSERT INTO approval_comments (id, request_id, node_id, username, user_role, content) VALUES ($1, $2, $3, $4, $5, $6)',
          [data.id, data.requestId, data.nodeId, data.username, data.userRole, data.content],
        )
      },
    },
    approvalNotification: {
      async create({ data }) {
        await client.query(
          'INSERT INTO approval_notifications (id, request_id, username, type, title, content) VALUES ($1, $2, $3, $4, $5, $6)',
          [data.id, data.requestId, data.username, data.type, data.title, data.content],
        )
      },
    },
    approvalCc: { async findMany() { return [] } },
  }
}

const fakePrisma = {
  ...delegates(db),
  async $transaction(callback) {
    return db.transaction(async (tx) => callback(delegates(tx)))
  },
  notificationTemplate: { async findUnique() { return null } },
  notification: { async create({ data }) { centerNotifications.push(data); return data } },
  notificationDelivery: { async create({ data }) { return data } },
}
globalThis.__buduPrisma = fakePrisma
const { approvalRouter } = await import('../server/approvals.js')
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  req.user = users.find((user) => user.username === req.header('x-actor')) ||
    { username: 'outsider', role: 'staff' }
  next()
})
app.use('/api/v2', approvalRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise((resolve) => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}/api/v2/approvals/requests`

async function seed(status = 'pending') {
  const id = `approval-race-${++sequence}`
  await db.query(
    `INSERT INTO approval_requests
      (id, request_no, template_key, title, status, form_data, amount_cents, submitter_username, submitter_name)
      VALUES ($1, $2, 'expense', 'isolated approval', $3, '{}', 100, 'submitter', 'Submitter')`,
    [id, id, status],
  )
  await db.query(
    'INSERT INTO approval_nodes (id, request_id, node_index, approver_username, status) VALUES ($1, $2, 1, $3, $4)',
    [`node-${id}`, id, 'approver', ['approved', 'rejected'].includes(status) ? status : 'pending'],
  )
  return id
}

async function post(id, endpoint, actor, body = {}) {
  const response = await fetch(`${base}/${id}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-actor': actor },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}
const withdraw = (id, actor = 'submitter') => post(id, 'withdraw', actor)
const decide = (id, action) => post(id, 'decide', 'approver', { action, comment: action === 'reject' ? '驳回原因' : '同意' })

async function facts(id) {
  await new Promise((resolve) => setImmediate(resolve))
  const [request, nodes, logs, notifications, comments] = await Promise.all([
    db.query('SELECT status FROM approval_requests WHERE id = $1', [id]),
    db.query('SELECT status FROM approval_nodes WHERE request_id = $1', [id]),
    db.query('SELECT action FROM approval_logs WHERE request_id = $1', [id]),
    db.query('SELECT type FROM approval_notifications WHERE request_id = $1', [id]),
    db.query('SELECT content FROM approval_comments WHERE request_id = $1', [id]),
  ])
  return {
    status: request.rows[0].status,
    nodes: nodes.rows.map((row) => row.status),
    logs: logs.rows.map((row) => row.action),
    notifications: notifications.rows.map((row) => row.type),
    comments: comments.rows.map((row) => row.content),
    centerResults: centerNotifications.filter((row) => row.refId === id && row.templateKey === 'approval_result').length,
  }
}

try {
  await test('Approval withdraw / decide controlled interleaving', async (t) => {
    await t.test('pending to withdrawn writes exactly one log', async () => {
      const id = await seed()
      assert.equal((await withdraw(id)).status, 200)
      assert.deepEqual(await facts(id), { status: 'withdrawn', nodes: ['pending'], logs: ['withdraw'], notifications: [], comments: [], centerResults: 0 })
    })
    for (const action of ['approve', 'reject']) {
      await t.test(`pending to ${action} commits matching facts`, async () => {
        const id = await seed()
        assert.equal((await decide(id, action)).status, 200)
        const f = await facts(id)
        assert.equal(f.status, action === 'approve' ? 'approved' : 'rejected')
        assert.deepEqual(f.nodes, [f.status])
        assert.deepEqual(f.logs, [action])
        assert.deepEqual(f.notifications, ['result'])
        assert.equal(f.comments.length, 1)
        assert.equal(f.centerResults, 1)
      })
    }

    for (const action of ['approve', 'reject']) {
      await t.test(`${action} commits after withdraw read pending`, async () => {
        const id = await seed()
        const barrier = holdNextRead()
        const withdrawing = withdraw(id)
        await barrier.entered
        try {
          assert.equal((await decide(id, action)).status, 200)
        } finally {
          barrier.release()
        }
        const withdrawal = await withdrawing
        const f = await facts(id)
        assert.equal(withdrawal.status, 409)
        assert.equal(f.status, action === 'approve' ? 'approved' : 'rejected')
        assert.deepEqual(f.nodes, [action === 'approve' ? 'approved' : 'rejected'])
        assert.deepEqual(f.logs, [action])
        assert.deepEqual(f.notifications, ['result'])
        assert.equal(f.comments.length, 1)
        assert.equal(f.centerResults, 1)
      })
    }

    for (const action of ['approve', 'reject']) {
      await t.test(`withdraw commits after ${action} read pending`, async () => {
        const id = await seed()
        const barrier = holdNextRead()
        const deciding = decide(id, action)
        await barrier.entered
        try {
          assert.equal((await withdraw(id)).status, 200)
        } finally {
          barrier.release()
        }
        assert.equal((await deciding).status, 409)
        assert.deepEqual(await facts(id), { status: 'withdrawn', nodes: ['pending'], logs: ['withdraw'], notifications: [], comments: [], centerResults: 0 })
      })
    }
    await t.test('duplicate withdraw cannot append a second log', async () => {
      const id = await seed()
      assert.equal((await withdraw(id)).status, 200)
      assert.equal((await withdraw(id)).status, 403)
      assert.deepEqual((await facts(id)).logs, ['withdraw'])
    })
    for (const status of ['approved', 'rejected', 'withdrawn']) {
      await t.test(`${status} cannot be withdrawn`, async () => {
        const id = await seed(status)
        assert.equal((await withdraw(id)).status, 403)
        const f = await facts(id)
        assert.equal(f.status, status)
        assert.deepEqual(f.logs, [])
        assert.deepEqual(f.notifications, [])
        assert.deepEqual(f.comments, [])
        assert.equal(f.centerResults, 0)
      })
    }
    await t.test('non-submitter still receives 403', async () => {
      const id = await seed()
      assert.equal((await withdraw(id, 'outsider')).status, 403)
      assert.deepEqual((await facts(id)).logs, [])
      assert.equal((await facts(id)).status, 'pending')
    })
  })
} finally {
  await new Promise((resolve) => server.close(resolve))
  await db.close()
  delete globalThis.__buduPrisma
}

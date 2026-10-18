import { FIXED_STORES } from '../../shared/storeDirectory.js'

const clone = value => structuredClone(value)
const syntheticDeveloper = { id: 'synthetic-store-developer', username: 'store-developer', role: 'developer', status: 'active', storeKeys: [], permissions: {} }

function matches(row, where = {}) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return condition.some(part => matches(row, part))
    if (key === 'AND') return condition.every(part => matches(row, part))
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('in' in condition && !condition.in.includes(row[key])) return false
      if ('not' in condition && row[key] === condition.not) return false
      return true
    }
    return row[key] === condition
  })
}

function project(row, select) {
  if (!row) return null
  return clone(select ? Object.fromEntries(Object.entries(select).filter(([, enabled]) => enabled).map(([key]) => [key, row[key]])) : row)
}

/** Synthetic transactions exercise rollback/replay only; native tests prove PG locks. */
export function createStoreManagementFixture() {
  let state, queue = Promise.resolve()
  const calls = [], rawQueries = [], failures = {}
  const collections = { store: 'stores', user: 'users', sensitiveRecordAudit: 'audits', employee: 'employees', invoice: 'invoices' }
  const db = { calls, rawQueries, failures, actor: clone(syntheticDeveloper) }
  Object.defineProperty(db, 'state', { get: () => state })
  db.reset = () => {
    state = {
      stores: FIXED_STORES.map(store => ({ ...store, active: store.key !== 'chaowai', createdAt: new Date('2026-10-15T00:00:00Z'), operationType: 'DIRECT', salesDataSource: 'manual' })),
      users: [clone(syntheticDeveloper)], audits: [], employees: [], invoices: [],
      facts: [{ id: 'synthetic-history', storeKey: 'chaowai', amountCents: 12345n, stock: 'unchanged' }],
    }
    calls.length = 0; rawQueries.length = 0
    for (const key of Object.keys(failures)) delete failures[key]
  }
  function unique(name, row, except) {
    const fields = name === 'store' ? ['key', 'name'] : name === 'user' ? ['id', 'username'] : ['id']
    if (state[collections[name]].some(other => other !== except && fields.some(key => row[key] !== undefined && other[key] === row[key]))) {
      throw Object.assign(Error('synthetic unique violation'), { code: 'P2002' })
    }
  }
  for (const [name, collection] of Object.entries(collections)) {
    function note(method) {
      calls.push(`${name}.${method}`)
      if (failures[`${name}.${method}`]) throw Error(`synthetic ${name}.${method} unavailable`)
    }
    const sorted = input => {
      let rows = state[collection].filter(row => matches(row, input?.where))
      const order = Array.isArray(input?.orderBy) ? input.orderBy : input?.orderBy ? [input.orderBy] : []
      rows = rows.slice().sort((a, b) => {
        for (const part of order) for (const [key, direction] of Object.entries(part)) {
          const left = a[key] instanceof Date ? +a[key] : a[key], right = b[key] instanceof Date ? +b[key] : b[key]
          if (left < right) return direction === 'desc' ? 1 : -1
          if (left > right) return direction === 'desc' ? -1 : 1
        }
        return 0
      })
      return rows
    }
    db[name] = {
      async findMany(input) { note('findMany'); return sorted(input).map(row => project(row, input?.select)) },
      async findFirst(input) { note('findFirst'); return project(sorted(input)[0], input?.select) },
      async findUnique(input) { note('findUnique'); return project(state[collection].find(row => matches(row, input?.where)), input?.select) },
      async create(input) {
        note('create')
        const row = { ...(name === 'store' ? { operationType: 'UNKNOWN', salesDataSource: 'manual', active: true, district: '' } : {}), createdAt: new Date(), ...clone(input.data) }
        unique(name, row)
        state[collection].push(row)
        return project(row, input?.select)
      },
      async update(input) {
        note('update')
        const existing = state[collection].find(row => matches(row, input.where))
        if (!existing) throw Object.assign(Error('synthetic record not found'), { code: 'P2025' })
        const row = { ...existing, ...clone(input.data) }
        unique(name, row, existing)
        Object.assign(existing, row)
        return project(existing, input?.select)
      },
      async count(input) { note('count'); return sorted(input).length },
    }
  }
  db.employee.aggregate = async () => ({ _max: { employeeNo: state.employees.map(row => row.employeeNo).sort().at(-1) || null } })
  db.$queryRawUnsafe = async (sql, ...params) => { rawQueries.push({ sql, params }); return [{ locked: 'synthetic-only' }] }
  const tx = Object.fromEntries([...Object.keys(collections), '$queryRawUnsafe'].map(key => [key, db[key]]))
  db.$transaction = (handler, options) => {
    calls.push(`transaction:${options?.isolationLevel || 'default'}`)
    const run = queue.then(async () => {
      const before = clone(state)
      try { return await handler(tx) } catch (error) { state = before; throw error }
    })
    queue = run.catch(() => {})
    return run
  }
  db.$disconnect = async () => {}
  db.reset()
  return db
}

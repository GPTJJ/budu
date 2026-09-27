// Gate 2：removedStaff 退出 Current Employee Authority Path。
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  employeeList,
  removeStaff,
  saveLocalStaffList,
} from '../src/utils/selectors.js'
import {
  getUserData,
  resetUserData,
  seedCachedDataForTest,
} from '../src/utils/userData.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const originalFetch = globalThis.fetch

function staff(name, storeKey) {
  return {
    id: `emp-${storeKey}-${name}`,
    name,
    storeKey,
    storeName: storeKey === 'guanshe' ? '北京官舍店' : '北京朝外店',
    type: 'parttime',
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function installStaffWriteMock() {
  const writes = []
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url)
    if (path === '/api/v2/staff-list' && options.method === 'PUT') {
      const payload = JSON.parse(options.body)
      writes.push(payload.staff)
      return json({ rows: payload.staff })
    }
    if (path === '/api/v2/staff' && options.method === 'PUT') return json({ ok: true })
    return json({ error: `unexpected request: ${path}` }, 404)
  }
  return writes
}

afterEach(() => {
  resetUserData()
  globalThis.fetch = originalFetch
})

test('Gate 2 Scenario A: removedStaff 无法隐藏 PG staff-list 返回的员工', () => {
  seedCachedDataForTest({
    staff: [staff('张三', 'guanshe')],
    removedStaff: ['张三'],
  })

  assert.deepEqual(employeeList('all').map((row) => row.name), ['张三'])
})

test('Gate 2 Scenario B: removedStaff 无效且固定门店筛选保持正常', () => {
  seedCachedDataForTest({
    staff: [staff('张三', 'guanshe'), staff('李四', 'chaowai')],
    removedStaff: ['张三', '李四'],
  })

  assert.deepEqual(employeeList('all').map((row) => row.name).sort(), ['张三', '李四'])
  assert.deepEqual(employeeList('guanshe').map((row) => row.name), ['张三'])
})

test('Gate 2 Scenario C: 删除员工只写 PG staff-list，不修改 removedStaff', async () => {
  seedCachedDataForTest({
    staff: [staff('张三', 'guanshe'), staff('李四', 'chaowai')],
    removedStaff: ['历史残留'],
  })
  const writes = installStaffWriteMock()

  await removeStaff('张三')

  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].map((row) => row.name), ['李四'])
  assert.deepEqual(getUserData().staff.map((row) => row.name), ['李四'])
  assert.deepEqual(getUserData().removedStaff, ['历史残留'])
})

test('Gate 2 Scenario D: 重新加入员工无需清除 removedStaff', async () => {
  seedCachedDataForTest({ staff: [], removedStaff: ['张三'] })
  installStaffWriteMock()

  await saveLocalStaffList([staff('张三', 'guanshe')])

  assert.deepEqual(getUserData().removedStaff, ['张三'])
  assert.deepEqual(employeeList('all').map((row) => row.name), ['张三'])
})

test('Gate 2 Scenario E: 当前目录不存在的员工仍可由历史月工资记录补出', () => {
  seedCachedDataForTest({
    staff: [],
    removedStaff: ['王五'],
    entries: {
      '2026-06|guanshe|06-08': {
        inc: 3000,
        ord: 12,
        staff: ['王五'],
      },
    },
  })

  const historical = employeeList('all', '2026-06')
  assert.ok(historical.some((row) => row.name === '王五'))
})

test('Gate 2 Boundary: removedStaff 不得重新进入 Current Employee Authority Path', () => {
  const selectors = fs.readFileSync(path.join(root, 'src/utils/selectors.js'), 'utf8')
  const personnel = fs.readFileSync(path.join(root, 'src/components/PersonnelPage.jsx'), 'utf8')

  assert.ok(!selectors.includes('getRemovedStaff'), 'selectors 当前员工目录不得读取 removedStaff')
  assert.ok(!selectors.includes('commitRemovedStaff'), 'removeStaff 不得写 removedStaff')
  assert.ok(!personnel.includes('getRemovedStaff'), '新增员工不得依赖 removedStaff 查询')
  assert.ok(!personnel.includes('commitRemovedStaff'), '新增员工不得清理 removedStaff')
})

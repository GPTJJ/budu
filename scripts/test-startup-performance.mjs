import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'vite'

class MemoryStorage {
  constructor() {
    this.values = new Map()
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null
  }

  setItem(key, value) {
    this.values.set(key, String(value))
  }

  removeItem(key) {
    this.values.delete(key)
  }
}

globalThis.localStorage = new MemoryStorage()

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
})
const userData = await vite.ssrLoadModule('/src/utils/userData.js')
after(() => vite.close())

test('启动镜像只能被所属账号恢复', () => {
  localStorage.setItem('budu-os-cloud-mirror-v1', JSON.stringify({
    entries: { '2026-08|guanshe|08-20': { inc: 100 } },
    staff: [{ name: '测试员工' }],
  }))
  localStorage.setItem('budu-os-cloud-mirror-owner-v1', 'user-a')

  assert.equal(userData.prepareUserDataForUser('user-a'), true)
  assert.equal(userData.getEntries()['2026-08|guanshe|08-20'].inc, 100)

  userData.resetUserData()
  assert.equal(userData.prepareUserDataForUser('user-b'), false)
  assert.deepEqual(userData.getEntries(), {})
  assert.deepEqual(userData.getStaff(), [])
})

test('PWA 导航使用本地壳优先并后台更新', () => {
  const source = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
  assert.match(source, /caches\.match\('\/'\)/)
  assert.match(source, /return cached \|\| update/)
  assert.match(source, /budu-shell-v10/)
})

test('业务数据接口采用并行拉取', () => {
  const source = fs.readFileSync(new URL('../src/utils/userData.js', import.meta.url), 'utf8')
  assert.match(source, /Promise\.allSettled\(\[/)
  assert.match(source, /onBaseReady\(cached\)/)
})

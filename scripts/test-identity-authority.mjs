// BUDU Data Authority 1.0 — DA-2 Identity Authority Tests
// 冻结：User/Account 读/写权威 = PostgreSQL；登录/鉴权/账号管理不得读 KV users。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')
const app = read('server/app.js')
const userStore = read('server/user-store.js')

test('DA-2: 登录走 PostgreSQL（getUserByUsername），不读 KV users', () => {
  assert.match(app, /app\.post\('\/api\/auth\/login'[\s\S]*?getUserByUsername\(username\)/, 'login 使用 PG 账号查询')
  assert.ok(!/login[\s\S]{0,400}loadDb\(\)\.users\.find\(\(u\) => u\.username === username\)/.test(app), 'login 不再读 KV users')
})

test('DA-2: 鉴权中间件从 PostgreSQL 取号（getUserById）', () => {
  assert.match(app, /requireAuth[\s\S]*?getUserById\(payload\.sub\)/, 'requireAuth 使用 PG')
})

test('DA-2: 账号管理路由全部走 user-store（PG 权威 + KV 镜像）', () => {
  for (const fn of ['listUsers', 'createUser', 'updateUser', 'deleteUser']) {
    assert.ok(app.includes(fn + '('), `app.js 使用 ${fn}`)
  }
  // 关键：账号读写不再直接改 db.users / persist
  assert.ok(!/db\.users\s*=\s*db\.users\.filter/.test(app), '删除账号不再直接改 KV')
  assert.ok(!/db\.users\.push\(user\)/.test(app), '创建账号不再直接写 KV')
})

test('DA-2: user-store 以 PG 为权威、KV 仅为镜像', () => {
  assert.match(userStore, /prisma\.user\.(findUnique|create|update|delete|findMany)/, 'user-store 使用 prisma.user')
  assert.match(userStore, /mirrorUsersToKv/, 'KV 写仅限镜像函数')
  assert.ok(!/loadDb\(\)\.users/.test(userStore), 'user-store 不读 KV users 作为权威')
})

test('DA-2: 服务端账号读者（审批/通知/企微绑定/资产）不再依赖 KV users', () => {
  for (const f of ['server/approvals.js', 'server/notification-center.js', 'server/wechat-bind.js', 'server/asset-center.js']) {
    const src = read(f)
    assert.ok(!src.includes("from './store.js'"), `${f} 不再引用 KV 存储层`)
    assert.ok(!/loadDb\(\)\.users/.test(src), `${f} 不读 KV users`)
  }
})

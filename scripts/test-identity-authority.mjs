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

test('DA-2.2: 员工名单权威 = PG employees（前端 /v2/staff-list，绑定校验 prisma.employee）', () => {
  const userData = read('src/utils/userData.js')
  const ep = read('server/employee-profile.js')
  assert.ok(userData.includes("api('/v2/staff-list')"), '前端从 PG 拉取员工名单')
  assert.ok(ep.includes("employeeProfileRouter.get('/staff-list'") && ep.includes("employeeProfileRouter.put('/staff-list'"), '服务端 staff-list 路由存在')
  assert.match(app, /prisma\.employee\.(findUnique|findMany)[\s\S]{0,200}(绑定员工不存在或已离职|员工不存在)/, '绑定校验使用 PG employees（Gate 20：显式 id findUnique / legacy findMany fail closed）')
  assert.ok(!/\(db\.staff \|\| \[\]\)\.some/.test(app), '绑定校验不再读 KV staff')
  assert.ok(!/loadDb\(\)\.users/.test(ep), 'staff-list 路由不读 KV users')
})

test('DA-2.3: 门店目录固定为四店，PG 只返回白名单且前端无增删入口', () => {
  const userData = read('src/utils/userData.js')
  const settings = read('src/components/SettingsPage.jsx')
  const v2 = read('server/v2.js')
  const directory = read('shared/storeDirectory.js')
  assert.ok(userData.includes("api('/v2/stores')"), '前端从 PG 拉取门店目录')
  assert.ok(!settings.includes("method: 'POST'") || !settings.includes("api('/v2/stores'"), 'SettingsPage 无新增门店入口')
  assert.ok(!settings.includes('门店管理') && !settings.includes('新增门店'), 'SettingsPage 不渲染门店管理 UI')
  assert.ok(v2.includes("v2Router.get('/stores'") && v2.includes("v2Router.post('/stores'") && v2.includes("v2Router.delete('/stores/:key'"), '服务端门店目录路由存在')
  assert.match(v2, /门店目录固定为通盈、官舍、朝外、西单，禁止新增/, '新增门店 API 显式拒绝')
  assert.match(v2, /固定门店不可删除/, '固定门店受防删保护')
  assert.deepEqual([...directory.matchAll(/key: '([^']+)'/g)].map((match) => match[1]), ['tongying', 'guanshe', 'chaowai', 'xidan'])
})

test('DA-2.4: 绑定写入稳定 employeeId（Gate 20：显式 Employee.id 权威 + legacy fail closed，User.employee_id 持久化）', () => {
  assert.match(userStore, /employeeId: row\.employeeId \|\| ''/, 'user-store 透传 employeeId')
  assert.match(app, /const boundEmpId = bindingResult \? bindingResult\.employeeId : ''/, '创建账号时持久化 employeeId（显式绑定权威）')
  assert.match(app, /employeeId: boundEmpId/, '角色更新时持久化 employeeId')
  assert.match(app, /explicitEmployeeId/, '绑定校验接受显式 Employee.id')
  assert.match(app, /matches\.length > 1/, 'legacy 歧义 fail closed（>1 匹配拒绝）')
})

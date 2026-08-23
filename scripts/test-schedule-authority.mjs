// BUDU Data Authority 1.0 — DA-3 Schedule Authority Tests
// 冻结：Schedule 读/写权威 = PostgreSQL；前端不得再读/写 KV schedules。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const page = fs.readFileSync(path.join(root, 'src/components/SchedulePage.jsx'), 'utf8')
const schedServer = fs.readFileSync(path.join(root, 'server/schedule.js'), 'utf8')
const userData = fs.readFileSync(path.join(root, 'src/utils/userData.js'), 'utf8')

test('DA-3: SchedulePage 不再读取/写入 KV schedules', () => {
  assert.ok(!page.includes('getSchedules('), 'SchedulePage 不得调用 getSchedules（KV 读）')
  assert.ok(!page.includes('commitSchedules('), 'SchedulePage 不得调用 commitSchedules（KV 写）')
  assert.ok(page.includes('/v2/schedules'), 'SchedulePage 使用 PG 接口')
  assert.ok(page.includes('setSchedules'), 'SchedulePage 以 PG 数据为状态')
})

test('DA-3: 服务端排班路由为纯 PG 实现', () => {
  assert.ok(schedServer.includes('prisma.schedule.'), '服务端使用 prisma.schedule')
  assert.ok(!schedServer.includes('loadDb('), '服务端排班路由不得读取 KV')
  assert.ok(!schedServer.includes("from './store.js'"), '服务端排班路由不得引用 KV 存储层')
  assert.ok(schedServer.includes("scheduleRouter.get('/schedules'") && schedServer.includes("scheduleRouter.put('/schedules'"), 'GET/PUT 路由存在')
})

test('DA-3: KV getSchedules/commitSchedules 在运行时无调用方（仅存档定义）', () => {
  // SchedulePage 已无调用；确认全 src 无其它调用方
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const st = fs.statSync(full)
      if (st.isDirectory()) walk(full)
      else if (/\.(js|jsx)$/.test(name)) {
        const src = fs.readFileSync(full, 'utf8')
        const lines = src.split('\n')
        lines.forEach((line, i) => {
          if (/getSchedules\(|commitSchedules\(/.test(line) && !line.includes('export function')) {
            assert.fail(`${full}:${i + 1} -> ${line.trim()}`)
          }
        })
      }
    }
  }
  walk(path.join(root, 'src'))
  assert.ok(true, '无其它调用方')
})

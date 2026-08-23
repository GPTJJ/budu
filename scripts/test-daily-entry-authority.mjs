// BUDU Data Authority 1.0 — DA-4 DailyEntry Authority Tests
// 冻结：DailyEntry 读/写权威 = PostgreSQL；KV 仅镜像；禁止 "PG 空 → KV" 静默回退。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const userData = fs.readFileSync(path.join(root, 'src/utils/userData.js'), 'utf8')
const selectors = fs.readFileSync(path.join(root, 'src/utils/selectors.js'), 'utf8')

test('DA-4/DA-5: commitEntries 写序为 PG 先，且不再写 KV 镜像', () => {
  // 提取 commitEntries 函数体
  const start = userData.indexOf('export async function commitEntries')
  assert.ok(start >= 0, 'commitEntries 存在')
  const end = userData.indexOf('\n}\n', start)
  const body = userData.slice(start, end)
  const pgPos = body.indexOf("api('/v2/daily-entries'")
  assert.ok(pgPos >= 0, 'commitEntries 调用 PG 写入')
  assert.ok(!body.includes('syncUserData'), 'commitEntries 不再写 KV 镜像（DA-5）')
  assert.ok(!body.includes('/userdata'), 'commitEntries 不再写 KV 总入口（DA-5）')
})

test('DA-4: commitEntries 在 PG 失败时显式抛错（不写 KV 镜像）', () => {
  const start = userData.indexOf('export async function commitEntries')
  const end = userData.indexOf('\n}\n', start)
  const body = userData.slice(start, end)
  assert.match(body, /failures\.length > 0/, '存在失败计数')
  assert.match(body, /throw new Error\(/, 'PG 失败显式抛错')
  assert.ok(body.indexOf('throw new Error') >= 0, 'PG 失败显式抛错')
})

test('DA-4: loadUserData entries 仅以 PG 为权威（无 KV 初始值/回退）', () => {
  // 1) 不再存在 "PG 空 → 保留 KV entries" 的旧条件
  assert.ok(!userData.includes('v2.rows.length > 0'), '已移除 PG 空则保留 KV 的条件')
  // 2) 基础 KV 数据中的 entries 被显式清空，只等 PG 填充
  assert.match(userData, /cached\.entries = \{\} \/\/ entries 权威为 PG/, '基础 KV entries 不作为初始值')
  // 3) PG 填充逻辑
  assert.match(userData, /if \(v2 && Array\.isArray\(v2\.rows\)\)/, 'PG 返回（含空）即事实')
  // 4) PG 失败仅回退"上一次成功的 PG 缓存"并告警，非 KV 回退
  assert.match(userData, /展示上次 PG 成功缓存/, '失败时保留上次 PG 缓存并告警')
  // 5) legacy localStorage 迁移已退役（DA-5）
  assert.ok(!userData.includes('readLegacy('), 'legacy 迁移函数已移除')
})

test('DA-4: saveLocalEntry/deleteLocalEntry 返回 promise（调用方可感知 PG 失败）', () => {
  assert.match(selectors, /return commitEntries\(next\)/, '包装函数返回 commitEntries 的 promise')
})

// 测试辅助：创建一次性 PostgreSQL schema 并应用全部迁移（Data Authority 测试/集成用）
// 用法：必须在动态 import server 模块之前调用（pg.js 构造时绑定 DATABASE_URL）
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'

export async function createDisposablePgSchema(prefix = 'da') {
  const schema = `${prefix}_${process.pid}_${Date.now().toString(36)}`
  const url = new URL(ADMIN_URL)
  url.searchParams.set('schema', schema)
  const schemaUrl = url.toString()
  const { PrismaClient } = await import('@prisma/client')
  const probe = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  try {
    await probe.$queryRawUnsafe('SELECT 1')
  } catch (error) {
    await probe.$disconnect().catch(() => {})
    throw new Error(`PG_SCHEMA_TEST_NOT_RUN — 本地 PostgreSQL 不可用：${error.message}`)
  }
  await probe.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  await probe.$disconnect()
  execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: schemaUrl },
    stdio: 'inherit',
    timeout: 180000,
  })
  return schemaUrl
}

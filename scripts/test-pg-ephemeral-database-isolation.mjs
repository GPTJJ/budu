import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { fileURLToPath } from 'node:url'
import { migrationNames, assertMigrationHistory } from './migration-rehearsal-plan.mjs'
import {
  createDisposablePgSchema,
  disposablePgDatabaseName,
  dropDisposablePgDatabase,
} from './helpers/test-pg-schema.mjs'

const adminUrl = new URL(process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu')
adminUrl.searchParams.delete('schema')
const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } })
let urlA = ''
let urlB = ''
let dbA
let dbB
let droppedA = false
let droppedB = false

try {
  urlA = await createDisposablePgSchema('isolation_a')
  urlB = await createDisposablePgSchema('isolation_b')
  const nameA = disposablePgDatabaseName(urlA)
  const nameB = disposablePgDatabaseName(urlB)
  assert.notEqual(nameA, nameB)

  dbA = new PrismaClient({ datasources: { db: { url: urlA } } })
  dbB = new PrismaClient({ datasources: { db: { url: urlB } } })
  const [migrationA, migrationB] = await Promise.all([
    dbA.$queryRawUnsafe('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at'),
    dbB.$queryRawUnsafe('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at'),
  ])
  const expected = migrationNames(fileURLToPath(new URL('..', import.meta.url)))
  await assertMigrationHistory(dbA, expected)
  await assertMigrationHistory(dbB, expected)
  for (const rows of [migrationA, migrationB]) {
    const migration64 = rows.find((row) => row.migration_name === '20260905120000_sweet_card_settlement_refund_compatibility')
    assert.ok(migration64?.finished_at)
    assert.equal(migration64.rolled_back_at, null)
  }

  await dbA.$executeRawUnsafe('CREATE TABLE public.gate10b_isolation_marker (id integer PRIMARY KEY)')
  await dbA.$executeRawUnsafe('INSERT INTO public.gate10b_isolation_marker (id) VALUES (1)')
  assert.equal(Number((await dbA.$queryRawUnsafe('SELECT count(*)::int AS count FROM public.gate10b_isolation_marker'))[0].count), 1)
  assert.equal((await dbB.$queryRawUnsafe("SELECT to_regclass('public.gate10b_isolation_marker')::text AS relation"))[0].relation, null)

  await Promise.all([dbA.$disconnect(), dbB.$disconnect()])
  dbA = undefined
  dbB = undefined
  await dropDisposablePgDatabase(urlA)
  droppedA = true
  await dropDisposablePgDatabase(urlB)
  droppedB = true

  const remaining = await admin.$queryRawUnsafe('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [nameA, nameB])
  assert.deepEqual(remaining, [])
  console.log(JSON.stringify({
    result: 'PG_EPHEMERAL_DATABASE_ISOLATION_PASS',
    databaseA: nameA,
    databaseB: nameB,
    distinct: true,
    migrationsA: migrationA.length,
    migrationsB: migrationB.length,
    migration64: 'PASS',
    dataIsolation: 'PASS',
    exactCleanup: 'PASS',
  }))
} finally {
  await dbA?.$disconnect().catch(() => {})
  await dbB?.$disconnect().catch(() => {})
  if (urlA && !droppedA) await dropDisposablePgDatabase(urlA).catch(() => {})
  if (urlB && !droppedB) await dropDisposablePgDatabase(urlB).catch(() => {})
  await admin.$disconnect().catch(() => {})
}

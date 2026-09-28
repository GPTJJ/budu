// Passed through stdin to the frozen runtime image. Never writes business rows.
import { PrismaClient } from '@prisma/client'

const mode = process.env.GATE8G_MODE
const output = { mode }
const db = new PrismaClient()
const one = async (client, sql) => (await client.$queryRawUnsafe(sql))[0]
const database = async client => (await one(client, 'SELECT current_database() AS name'))?.name
const defaultReadonly = async client =>
  (await one(client, 'SHOW default_transaction_read_only'))?.default_transaction_read_only
const readonly = async client =>
  (await one(client, 'SHOW transaction_read_only'))?.transaction_read_only

try {
  if (!['control', 'options', 'explicit'].includes(mode)) throw Error('MODE_INVALID')
  if (mode === 'explicit') {
    output.g5 = await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
      return { database: await database(tx), transactionReadOnly: await readonly(tx) }
    })
  } else {
    output.database = await database(db)
    output.defaultTransactionReadOnly = await defaultReadonly(db)
    output.transactionReadOnly = await readonly(db)
    if (mode === 'options' && output.database === 'budu_bj006' &&
        output.defaultTransactionReadOnly === 'on' && output.transactionReadOnly === 'on') {
      output.g3 = await db.$transaction(async tx => ({
        database: await database(tx), transactionReadOnly: await readonly(tx),
      }))
      if (output.g3.database === 'budu_bj006' && output.g3.transactionReadOnly === 'on') {
        const clients = Array.from({ length: 4 }, () => new PrismaClient())
        try {
          const sessions = await Promise.all(clients.map(async client => {
            const pid = (await one(client, 'SELECT pg_backend_pid() AS pid'))?.pid
            return { pid, transactionReadOnly: await readonly(client) }
          }))
          output.g4 = { sessionCount: sessions.length,
            distinctBackendCount: new Set(sessions.map(session => String(session.pid))).size,
            readonlyOnCount: sessions.filter(session => session.transactionReadOnly === 'on').length }
        } finally {
          await Promise.allSettled(clients.map(client => client.$disconnect()))
        }
      }
    }
  }
} catch (error) {
  const raw = String(error?.code || error?.message || '')
  output.safeCode = /^[A-Z][A-Z0-9_]{0,60}$/.test(raw) ? raw : 'DETAILS_SUPPRESSED'
  output.errorClass = /^[A-Za-z]{1,40}$/.test(error?.name || '') ? error.name : 'UNKNOWN'
  process.exitCode = 1
} finally {
  try { await db.$disconnect() } catch { process.exitCode = 1 }
  process.stdout.write(JSON.stringify(output) + '\n')
}

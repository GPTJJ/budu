import fs from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const databasePath = process.argv[2]
if (!databasePath) throw new Error('PGLITE_PREP_NOT_RUN — 缺少数据库路径')

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const schemaSql = Buffer.concat(chunks).toString('utf8')
if (!schemaSql.trim()) throw new Error('PGLITE_PREP_NOT_RUN — 缺少 schema SQL')

const db = new PGlite(databasePath)
await db.exec(schemaSql)
await db.close()
console.log(JSON.stringify({ result: 'PARTNER_PGLITE_SCHEMA_READY' }))

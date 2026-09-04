import { createHash } from 'node:crypto'
import { prisma } from '../server/pg.js'

const functionNames = [
  'budu_guard_refund_authority',
  'budu_guard_payment_authority',
  'budu_guard_settled_order_proof',
  'budu_validate_refund_contract',
]

const constraintNames = [
  'refunds_mode_source_contract',
  'refunds_source_xor',
]

const functions = await prisma.$queryRawUnsafe(`
  SELECT p.oid::text AS oid,
         n.nspname AS schema,
         p.proname AS name,
         pg_get_function_identity_arguments(p.oid) AS identity_args,
         pg_get_userbyid(p.proowner) AS owner,
         p.prosecdef AS security_definer,
         p.proconfig,
         p.proacl::text AS acl,
         pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = ANY ($1::text[])
  ORDER BY p.proname
`, functionNames)

const constraints = await prisma.$queryRawUnsafe(`
  SELECT c.oid::text AS oid,
         n.nspname AS schema,
         c.conrelid::regclass::text AS relation,
         c.conname AS name,
         c.convalidated AS validated,
         c.condeferrable AS deferrable,
         c.condeferred AS initially_deferred,
         pg_get_constraintdef(c.oid, true) AS definition
  FROM pg_constraint c
  JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE n.nspname = 'public'
    AND c.conname = ANY ($1::text[])
  ORDER BY c.conname
`, constraintNames)

const dependencies = await prisma.$queryRawUnsafe(`
  SELECT p.proname AS function_name,
         d.deptype,
         d.refclassid::regclass::text AS referenced_catalog,
         d.refobjid::text AS referenced_oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_depend d ON d.classid = 'pg_proc'::regclass AND d.objid = p.oid
  WHERE n.nspname = 'public'
    AND p.proname = ANY ($1::text[])
  ORDER BY p.proname, d.refclassid, d.refobjid
`, functionNames)

const triggers = await prisma.$queryRawUnsafe(`
  SELECT t.oid::text AS oid,
         t.tgname AS name,
         t.tgrelid::regclass::text AS relation,
         p.proname AS function_name,
         pg_get_triggerdef(t.oid, true) AS definition
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE NOT t.tgisinternal
    AND n.nspname = 'public'
    AND p.proname = ANY ($1::text[])
  ORDER BY t.tgname
`, functionNames)

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
for (const row of functions) row.checksum = sha256(row.definition)
for (const row of constraints) row.checksum = sha256(row.definition)

console.log(JSON.stringify({ functions, constraints, dependencies, triggers }, null, 2))
await prisma.$disconnect()

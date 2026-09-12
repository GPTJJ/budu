// Test-only historical plan: apply the actual ordered prefix before the target,
// never a current chain with a creator removed but its dependents retained.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
export function migrationNames(root) {
  return fs.readdirSync(path.join(root, 'prisma', 'migrations'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{14}_/.test(entry.name)
      && fs.existsSync(path.join(root, 'prisma', 'migrations', entry.name, 'migration.sql')))
    .map(entry => entry.name).sort()
}
export function copyBeforeMigration(root, destination, target) {
  const names = migrationNames(root)
  assert.ok(names.includes(target), `Missing target migration ${target}`)
  for (const name of names.filter(name => name < target))
    fs.cpSync(path.join(root, 'prisma', 'migrations', name), path.join(destination, 'migrations', name), { recursive: true })
  fs.copyFileSync(path.join(root, 'prisma', 'migrations', 'migration_lock.toml'), path.join(destination, 'migrations', 'migration_lock.toml'))
}
export async function assertMigrationHistory(client, expected) {
  const rows = await client.$queryRawUnsafe('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name')
  assert.ok(rows.every(row => row.finished_at && row.rolled_back_at === null), 'Every planned migration must finish without rollback')
  assert.deepEqual(rows.map(row => row.migration_name), expected)
}

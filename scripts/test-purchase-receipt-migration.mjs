import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createDisposablePgDatabase, dropDisposablePgDatabase } from './helpers/test-pg-schema.mjs';
if (process.env.APP_ENV !== 'test' || process.env.TEST_DATABASE_URL !== 'postgresql://apple@127.0.0.1:55463/postgres') throw Error('Exact owned Gate2 target required');
const baseline = 'edb31cd398e3a330565b5453f42051f3e24005c3';
const output = path.resolve('output/purchase-receipt/migration');
fs.mkdirSync(output, {
  recursive: true
});
const prismaDir = path.join(output, 'prisma');
fs.mkdirSync(path.join(prismaDir, 'migrations'), {
  recursive: true
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const gitFile = name => execFileSync('git', ['show', baseline + ':' + name]);
const oldFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', baseline, 'prisma/migrations'], {
  encoding: 'utf8'
}).trim().split('\n');
const checksums = [];
for (const file of oldFiles) {
  const before = gitFile(file),
    after = fs.readFileSync(file);
  assert.equal(hash(after), hash(before), file);
  const target = path.join(prismaDir, 'migrations', file.slice('prisma/migrations/'.length));
  fs.mkdirSync(path.dirname(target), {
    recursive: true
  });
  fs.writeFileSync(target, before);
  if (file.endsWith('/migration.sql')) checksums.push({
    path: file,
    sha256: hash(before)
  });
}
assert.equal(checksums.length, 87);
fs.writeFileSync(path.join(prismaDir, 'schema.prisma'), gitFile('prisma/schema.prisma'));
const target = await createDisposablePgDatabase('purchase_migration', {
  applyMigrations: false
});
const db = new PrismaClient({
  datasources: {
    db: {
      url: target
    }
  }
});
const deploy = schema => execFileSync(path.resolve('node_modules/.bin/prisma'), ['migrate', 'deploy', '--schema', schema], {
  env: {
    ...process.env,
    DATABASE_URL: target,
    CHECKPOINT_DISABLE: '1',
    PRISMA_HIDE_UPDATE_MESSAGE: '1'
  },
  stdio: 'inherit'
});
const oldRead = async () => ({
  inventory: await db.$queryRawUnsafe('SELECT id,name,category,"isActive","salePriceCents"::text,"costPriceCents"::text,"transferEnabled","partnerReplenishmentEnabled",version FROM "InventoryItem" ORDER BY id'),
  suppliers: await db.$queryRawUnsafe('SELECT * FROM "Supplier" ORDER BY id'),
  purchases: await db.$queryRawUnsafe('SELECT * FROM "PurchaseRequest" ORDER BY id'),
  lines: await db.$queryRawUnsafe('SELECT * FROM "PurchaseItem" ORDER BY id'),
  stock: await db.$queryRawUnsafe('SELECT * FROM "StockBalance" ORDER BY "storeKey","itemId"'),
  ledger: await db.$queryRawUnsafe('SELECT * FROM "StockLedger" ORDER BY id')
});
try {
  deploy(path.join(prismaDir, 'schema.prisma'));
  assert.equal((await db.$queryRawUnsafe('SELECT count(*)::int n FROM "_prisma_migrations"'))[0].n, 87);
  await db.$executeRawUnsafe('INSERT INTO "Store" (key,name) VALUES ($1,$2)', 'synthetic-migration-store', '合成迁移门店');
  await db.$executeRawUnsafe('INSERT INTO "InventoryItem" (id,name,category,"isActive","transferEnabled") VALUES ($1,$2,$3,false,true)', 'synthetic-migration-item', '合成保留商品', 'product');
  await db.$executeRawUnsafe('INSERT INTO "Supplier" (id,name) VALUES ($1,$2)', 'synthetic-migration-supplier', '合成旧供应商');
  for (const status of ['pending', 'received']) {
    await db.$executeRawUnsafe('INSERT INTO "PurchaseRequest" (id,"storeKey",status,"supplierId") VALUES ($1,$2,$3,$4)', 'synthetic-old-' + status, 'synthetic-migration-store', status, 'synthetic-migration-supplier');
    await db.$executeRawUnsafe('INSERT INTO "PurchaseItem" (id,"requestId","itemId","orderedQty","receivedQty") VALUES ($1,$2,$3,10,$4)', 'synthetic-line-' + status, 'synthetic-old-' + status, 'synthetic-migration-item', status === 'received' ? 8 : 0);
  }
  const before = await oldRead(),
    beforeHash = hash(JSON.stringify(before));
  deploy(path.resolve('prisma/schema.prisma'));
  const after = await oldRead();
  assert.equal(hash(JSON.stringify(after)), beforeHash);
  const ledger = await db.$queryRawUnsafe('SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name');
  assert.equal(ledger.length, 88);
  assert(ledger.every(x => x.finished_at && !x.rolled_back_at));
  for (const c of checksums) {
    const name = c.path.split('/')[2];
    assert.equal(ledger.find(x => x.migration_name === name).checksum, c.sha256);
  }
  const item = await db.inventoryItem.findUnique({
    where: {
      id: 'synthetic-migration-item'
    }
  });
  assert.equal(item.purchaseEnabled, false);
  assert.equal(item.procurementSupplierId, null);
  assert.equal(await db.procurementSupplier.count(), 0);
  assert.equal(await db.procurementOrder.count(), 0);
  // Old reader shape remains usable after additive migration. No schema reversal or data deletion.
  await db.procurementSupplier.create({
    data: {
      id: 'synthetic-new-retained',
      name: '合成回退保留采购供应商',
      createdById: 'synthetic-only'
    }
  });
  assert.equal(hash(JSON.stringify(await oldRead())), beforeHash);
  assert.equal(await db.procurementSupplier.count(), 1);
  await db.procurementAudit.create({
    data: {
      id: 'synthetic-retained-audit',
      entityId: 'synthetic-new-retained',
      action: 'SUPPLIER_CREATE',
      actorId: 'synthetic-only',
      actorName: '合成开发者',
      operationKey: 'synthetic-migration-audit',
      payloadHash: 'synthetic'
    }
  });
  await assert.rejects(() => db.$executeRawUnsafe('DELETE FROM "ProcurementAudit" WHERE id=$1', 'synthetic-retained-audit'));
  const retiredSource = fs.readFileSync('server/v2.js', 'utf8');
  assert(retiredSource.includes('旧采购创建已停用，请使用采购入库备单'));
  const report = {
    status: 'PASS',
    baseline,
    oldMigrationCount: 87,
    newMigrationCount: 88,
    checksums,
    before,
    after,
    beforeHash,
    afterHash: hash(JSON.stringify(after)),
    defaults: {
      purchaseEnabled: false,
      procurementSupplierId: null
    },
    newDomainInitiallyEmpty: true,
    oldPendingCount: 1,
    oldPendingTransition: 'STOP_AND_REPORT_NO_AUTOMATIC_CONVERSION',
    rollbackProbe: {
      oldReaderShape: 'PASS',
      newSupplierRetained: 1,
      schemaDownMigration: 'NOT_EXECUTED',
      fullOldAppDeployment: 'NOT_RUN',
      requirement: 'Compatible rollback build must retain legacy write retirement; unpatched old image is unsafe.'
    },
    productionWrites: 0
  };
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log('C11 migration rehearsal PASS');
} finally {
  await db.$disconnect();
  await dropDisposablePgDatabase(target);
}

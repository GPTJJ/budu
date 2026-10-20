import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createDisposablePgDatabase, dropDisposablePgDatabase } from './helpers/test-pg-schema.mjs';
if (process.env.APP_ENV !== 'test' || process.env.TEST_DATABASE_URL !== 'postgresql://apple@127.0.0.1:55463/postgres') throw Error('Exact isolated target required');
const baseline = 'e747fbd1347a9ff4e36a8b5c6de10856a3762da8';
const output = path.resolve('output/purchase-return/migration');
fs.mkdirSync(output,{recursive:true});
const hash = data => createHash('sha256').update(data).digest('hex');
const files = execFileSync('git',['ls-tree','-r','--name-only',baseline,'prisma/migrations'],{encoding:'utf8'}).trim().split('\n');
const checksums = [];
for (const file of [...files,'prisma/schema.prisma']) {
  const bytes = execFileSync('git',['show',baseline+':'+file]);
  if (file.endsWith('migration.sql')) { assert.equal(hash(fs.readFileSync(file)),hash(bytes),file+' changed'); checksums.push({name:file.split('/')[2],checksum:hash(bytes)}); }
  const dest = path.join(output,file); fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.writeFileSync(dest,bytes);
}
const target = await createDisposablePgDatabase('purchase_return_migration',{applyMigrations:false});
const db = new PrismaClient({datasources:{db:{url:target}}});
const deploy = schema => execFileSync(path.resolve('node_modules/.bin/prisma'),['migrate','deploy','--schema',schema],{env:{...process.env,DATABASE_URL:target},stdio:'inherit'});
try {
  deploy(path.join(output,'prisma/schema.prisma'));
  assert.equal((await db.$queryRawUnsafe('SELECT count(*)::int n FROM "_prisma_migrations"'))[0].n,checksums.length);
  await db.$executeRawUnsafe('INSERT INTO "Store"(key,name,active) VALUES ($1,$2,false)','return-migration-store','合成停用门店');
  await db.$executeRawUnsafe('INSERT INTO "InventoryItem"(id,name,category) VALUES ($1,$2,$3)','return-migration-product','合成保留商品','material');
  await db.$executeRawUnsafe('INSERT INTO "ProcurementSupplier"(id,name,"createdById","updatedAt") VALUES ($1,$2,$3,now())','return-migration-supplier','合成供应商','synthetic');
  await db.$executeRawUnsafe('INSERT INTO "ProcurementOrder"(id,"storeKey","supplierId","createdById","createdByName","createRequestKey","createPayloadHash","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,now())','return-migration-order','return-migration-store','return-migration-supplier','synthetic','合成备单人','synthetic-req','synthetic-hash');
  const read = async()=>({stores:await db.$queryRawUnsafe('SELECT * FROM "Store" ORDER BY key'),items:await db.$queryRawUnsafe('SELECT * FROM "InventoryItem" ORDER BY id'),orders:await db.$queryRawUnsafe('SELECT * FROM "ProcurementOrder" ORDER BY id')});
  const before = await read();
  deploy(path.resolve('prisma/schema.prisma'));
  assert.deepEqual(await read(),before);
  const ledger=await db.$queryRawUnsafe('SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name');
  assert.equal(ledger.length,checksums.length+1);
  for(const c of checksums) assert.equal(ledger.find(l=>l.migration_name===c.name).checksum,c.checksum);
  assert(ledger.every(l=>l.finished_at&&!l.rolled_back_at));
  assert.equal(await db.procurementReturn.count(),0);
  const r=await db.procurementReturn.create({data:{id:'return-migration-record',number:'TH-SYNTHETIC',content:{},storeKeys:['return-migration-store'],createdById:'synthetic',createdByName:'合成登记人',createRequestKey:'return-migration-request',createPayloadHash:'synthetic'}});
  await db.procurementReturnProduct.create({data:{returnId:r.id,itemId:'return-migration-product'}});
  await assert.rejects(db.inventoryItem.delete({where:{id:'return-migration-product'}}));
  await assert.rejects(db.$executeRawUnsafe('UPDATE "ProcurementReturn" SET status=$1 WHERE id=$2','INVALID',r.id));
  await assert.rejects(db.$executeRawUnsafe('UPDATE "ProcurementReturn" SET version=0 WHERE id=$1',r.id));
  const evidence={baseline,existingMigrations:checksums.length,newMigrations:1,oldChecksumsUnchanged:true,syntheticRowsUnchanged:true,foreignKeyAndStateChecks:true,productionMigration:false,status:'PASS'};
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(evidence,null,2)); console.log(JSON.stringify(evidence));
} finally {await db.$disconnect();await dropDisposablePgDatabase(target);}

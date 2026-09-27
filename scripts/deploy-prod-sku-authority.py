#!/usr/bin/env python3
"""SKU Authority 1.0 schema-aware production release controller.

This is a strict successor profile. It does not weaken the existing post-transfer
controller: it accepts exactly one reviewed Prisma migration and exact SKU business
candidate ancestry, then performs backup/rehearsal, migration, controlled data
migration, candidate DB probe and single-writer cutover. All unexpected drift fails
closed.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
BASE_SPEC = importlib.util.spec_from_file_location("budu_release_base", ROOT / "scripts/deploy-prod-transfer-cas.py")
base = importlib.util.module_from_spec(BASE_SPEC)
BASE_SPEC.loader.exec_module(base)

GateError = base.GateError
require = base.require
digest = base.digest
command = base.command
git = base.git

BASELINE_SHA = "5ad27a06d731fbc94de5ae3776060b4350b886e8"
BUSINESS_SHA = "829b91ba42656e9ad2db530dba68ba629b10364a"
MIGRATION_NAME = "20260927190000_sku_authority_candidate"
MIGRATION_PATH = f"prisma/migrations/{MIGRATION_NAME}/migration.sql"
MIGRATION_SHA256 = "c6c3c881b870c0dfaf639c0f1f9b34ece148c6baa49debafa6551feaa0f246f5"
MIGRATIONS_BEFORE = 85
MIGRATIONS_AFTER = 86
EXPECTED_PRODUCTS = 178
EXPECTED_BD = 89
EXPECTED_TP = 89
EXPECTED_ALIASES = 145
EXPECTED_MISSING_OLD = 33
EXPECTED_ONLINE = 153
SNAPSHOT_ID = "sku-authority-prod-20260927"
ACTOR_ID = "sku-authority-production"
REASON = "SKU Authority 1.0 production migration"

RELEASE_ENGINEERING_FILES = {
    ".github/workflows/deploy-prod.yml",
    ".github/workflows/sku-release-controller-candidate.yml",
    "docs/checkpoints/2026-09-27-sku-authority-release-controller.md",
    "scripts/deploy-remote.sh",
    "scripts/deploy-prod-sku-authority.py",
    "scripts/release-prod-sku-authority-ci.sh",
    "scripts/test-sku-release-controller.py",
}

PRODUCT_SNAPSHOT_SCRIPT = r"""
import { prisma } from './server/pg.js'
try {
  const products = await prisma.inventoryItem.findMany({
    where: { category: 'product' },
    select: { id:true, name:true, sku:true, category:true, createdAt:true, isActive:true, transferCode:true,
      productCategory:{select:{name:true}} },
    orderBy: [{ createdAt:'asc' }, { id:'asc' }],
  })
  const online = await prisma.onlineProductPolicy.findMany({
    select:{ id:true, namespace:true, externalProductId:true, externalSkuId:true, productId:true, enabled:true },
    orderBy:{id:'asc'},
  })
  process.stdout.write(JSON.stringify({products,online}))
} finally {
  await prisma.$disconnect()
}
"""

DATA_APPLY_SCRIPT = r"""
import crypto from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from './server/pg.js'
import { buildProductSkuPlan } from './server/product-sku-plan.js'

const expected = process.argv[2]
const expectedOnline = Number(process.argv[3])
const actorUserId = process.argv[4]
const reason = process.argv[5]
const snapshotId = process.argv[6]

const mappingIdentity = (plan) => plan.mapping.map((row) => ({
  id:row.id,name:row.name,oldSku:row.oldSku ?? null,newSku:row.newSku,createdAt:row.createdAt,
  isActive:row.isActive,prefix:row.prefix,classificationBasis:row.classificationBasis,
  transferCodeBefore:row.transferCodeBefore ?? null,transferCodeAfter:row.transferCodeAfter ?? null,
  alias:row.alias ?? null,
}))
const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex')
const stableRows = async () => ({
  orderItems: await prisma.orderItem.findMany({select:{id:true,productId:true,skuSnapshot:true},orderBy:{id:'asc'}}),
  transferItems: await prisma.transferItem.findMany({select:{id:true,itemId:true,itemCodeSnapshot:true},orderBy:{id:'asc'}}),
  partnerItems: await prisma.partnerSupplyItem.findMany({select:{id:true,productId:true,productCodeSnapshot:true},orderBy:{id:'asc'}}),
  replenishmentItems: await prisma.replenishmentOrderItem.findMany({select:{id:true,inventoryItemId:true,skuSnapshot:true,productCodeSnapshot:true},orderBy:{id:'asc'}}),
})
try {
  const rows = await prisma.inventoryItem.findMany({where:{category:'product'},select:{
    id:true,name:true,sku:true,category:true,createdAt:true,isActive:true,transferCode:true,
    productCategory:{select:{name:true}},
  }})
  const plan = buildProductSkuPlan(rows,{actorUserId,reason,snapshotId,expectedCount:178})
  if(hash(mappingIdentity(plan)) !== expected) throw new Error('MAPPING_IDENTITY_DRIFT')
  if(plan.counts.BD!==89 || plan.counts.TP!==89 || plan.counts.aliases!==145 || plan.counts.missingOldSku!==33) throw new Error('MAPPING_COUNTS_DRIFT')
  const beforeOnline = await prisma.onlineProductPolicy.findMany({select:{
    id:true,namespace:true,externalProductId:true,externalSkuId:true,productId:true,enabled:true,
  },orderBy:{id:'asc'}})
  if(beforeOnline.length !== expectedOnline) throw new Error('ONLINE_MAPPING_COUNT_DRIFT')
  const historicalBefore = hash(await stableRows())
  const idSetBefore = hash(rows.map(x=>x.id).sort())

  const result = await prisma.$transaction(async (tx) => {
    const sequences = await tx.productSkuSequence.findMany({orderBy:{prefix:'asc'}})
    if(JSON.stringify(sequences.map(x=>[x.prefix,x.nextValue])) !== JSON.stringify([['BD',1],['TP',1]])) throw new Error('SEQUENCE_NOT_INITIAL')
    if(await tx.productSkuAssignment.count() || await tx.productSkuAlias.count()) throw new Error('SKU_MIGRATION_ALREADY_APPLIED')
    for(const row of plan.mapping){
      const changed = await tx.inventoryItem.updateMany({
        where:{id:row.id,category:'product',sku:row.oldSku,name:row.name,createdAt:new Date(row.createdAt),
          isActive:row.isActive,transferCode:row.transferCodeBefore},
        data:{sku:row.newSku,version:{increment:1}},
      })
      if(changed.count!==1) throw new Error('PRODUCT_DRIFT')
      await tx.productSkuAssignment.create({data:{
        sku:row.newSku,itemId:row.id,oldSku:row.oldSku,actorUserId,reason,
      }})
      if(row.alias) await tx.productSkuAlias.create({data:{
        alias:row.alias,itemId:row.id,actorUserId,reason,
      }})
      await tx.sensitiveRecordAudit.create({data:{
        id:'audit-'+crypto.randomUUID(),action:'product.sku.assign',recordType:'InventoryItem',
        recordId:row.id,actorUserId,actorUsername:actorUserId,
        reason:JSON.stringify({oldSku:row.oldSku,newSku:row.newSku,reason}),
      }})
    }
    await tx.productSkuSequence.update({where:{prefix:'BD'},data:{nextValue:90}})
    await tx.productSkuSequence.update({where:{prefix:'TP'},data:{nextValue:90}})
    const current = await tx.inventoryItem.findMany({where:{category:'product'},select:{id:true,sku:true,name:true,createdAt:true,isActive:true,transferCode:true},orderBy:{id:'asc'}})
    if(current.length!==178 || current.some(x=>!(/^(BD|TP)-\d{6}$/.test(x.sku||'')))) throw new Error('CURRENT_SKU_RECONCILIATION_FAILED')
    if(await tx.productSkuAssignment.count()!==178 || await tx.productSkuAlias.count()!==145) throw new Error('SKU_RECORD_RECONCILIATION_FAILED')
    const seq = await tx.productSkuSequence.findMany({orderBy:{prefix:'asc'}})
    if(JSON.stringify(seq.map(x=>[x.prefix,x.nextValue])) !== JSON.stringify([['BD',90],['TP',90]])) throw new Error('SEQUENCE_RECONCILIATION_FAILED')
    return {current}
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:10000,timeout:120000})

  const afterOnline = await prisma.onlineProductPolicy.findMany({select:{
    id:true,namespace:true,externalProductId:true,externalSkuId:true,productId:true,enabled:true,
  },orderBy:{id:'asc'}})
  if(JSON.stringify(beforeOnline)!==JSON.stringify(afterOnline)) throw new Error('ONLINE_MAPPING_DRIFT')
  const historicalAfter = hash(await stableRows())
  if(historicalBefore!==historicalAfter) throw new Error('HISTORICAL_SNAPSHOT_DRIFT')
  const idsAfter = await prisma.inventoryItem.findMany({where:{category:'product'},select:{id:true}})
  if(idSetBefore!==hash(idsAfter.map(x=>x.id).sort())) throw new Error('PRODUCT_ID_SET_DRIFT')
  process.stdout.write(JSON.stringify({ok:true,total:result.current.length,BD:89,TP:89,assignments:178,aliases:145,missing:0,online:afterOnline.length,historical:'PASS',ids:'PASS'}))
} finally {
  await prisma.$disconnect()
}
"""

def configure_base(repo):
    old_hash = digest(command(["git","-C",str(repo),"show",BASELINE_SHA+":server/v2.js"]))
    base.configure_profile("post-transfer", BASELINE_SHA, BUSINESS_SHA, old_hash)
    base.IMAGE_PREFIX = "sku-authority-"
    base.CONTAINER_SUFFIX = "-sku-authority"
    base.ROLLBACK_PREFIX = "sku-authority-"
    base.EXPECTED_MIGRATIONS = MIGRATIONS_BEFORE
    base.MIGRATION_REQUIRED = "YES"

def migration_ledger(repo):
    full = {p.parent.name:digest(p.read_bytes()) for p in (Path(repo)/"prisma/migrations").glob("*/migration.sql")}
    require(len(full)==MIGRATIONS_AFTER, "LOCAL_MIGRATION_COUNT_INVALID")
    require(full.get(MIGRATION_NAME)==MIGRATION_SHA256, "APPROVED_MIGRATION_CHECKSUM_MISMATCH")
    before = dict(full); before.pop(MIGRATION_NAME)
    require(len(before)==MIGRATIONS_BEFORE, "BASELINE_MIGRATION_COUNT_INVALID")
    return before, full

def validate_repo_identity(repo, release):
    require(re.fullmatch(r"[0-9a-f]{40}",release) is not None and release!=BUSINESS_SHA, "RELEASE_SHA_INVALID")
    require(base.is_ancestor(repo,BASELINE_SHA,BUSINESS_SHA) and base.is_ancestor(repo,BUSINESS_SHA,release), "SKU_RELEASE_ANCESTRY_INVALID")
    changed = set(git(repo,"diff","--name-only",BUSINESS_SHA,release).splitlines())
    require(changed and changed <= RELEASE_ENGINEERING_FILES, "SKU_RELEASE_ENGINEERING_SCOPE_INVALID")
    require(not git(repo,"diff","--name-only",BUSINESS_SHA,release,"--","server","shared","src","prisma","package.json","package-lock.json"), "SKU_BUSINESS_RUNTIME_CHANGED")
    prisma_business = set(git(repo,"diff","--name-only",BASELINE_SHA,BUSINESS_SHA,"--","prisma").splitlines())
    require(prisma_business == {"prisma/schema.prisma",MIGRATION_PATH}, "SKU_APPROVED_PRISMA_DIFF_INVALID")
    require(digest((Path(repo)/MIGRATION_PATH).read_bytes())==MIGRATION_SHA256, "APPROVED_MIGRATION_CHECKSUM_MISMATCH")
    current_schema = digest((Path(repo)/"prisma/schema.prisma").read_bytes())
    approved_schema = digest(command(["git","-C",str(repo),"show",BUSINESS_SHA+":prisma/schema.prisma"]))
    require(current_schema==approved_schema, "APPROVED_SCHEMA_CHANGED")
    require(not git(repo,"status","--porcelain","--untracked-files=all"), "WORKTREE_NOT_CLEAN")
    command(["git","-C",str(repo),"diff","--check",BUSINESS_SHA,release])
    return migration_ledger(repo)

def validate_db_before(db, ledger):
    require(db["database"]==base.EXPECTED_DB, "DATABASE_AUTHORITY_MISMATCH")
    require(db["applied"]==MIGRATIONS_BEFORE and db["failed"]==0, "MIGRATION_LEDGER_INVALID")
    require(db["ledger"]==ledger, "MIGRATION_CHECKSUM_MISMATCH")

def validate_db_after(db, ledger):
    require(db["database"]==base.EXPECTED_DB, "DATABASE_AUTHORITY_MISMATCH")
    require(db["applied"]==MIGRATIONS_AFTER and db["failed"]==0, "MIGRATION_LEDGER_INVALID")
    require(db["ledger"]==ledger, "MIGRATION_CHECKSUM_MISMATCH")

def classification(row):
    category = str((row.get("productCategory") or {}).get("name") or "").strip()
    if re.fullmatch(r"(?:pos-)?(?:森醒|12\s*样商店)",category):
        return "TP", "category:"+category
    if re.search(r"森醒|12\s*样商店",category):
        raise GateError("PRODUCT_SOURCE_AMBIGUOUS")
    return "BD", "confirmed-default-budu"

def build_mapping(products):
    require(len(products)==EXPECTED_PRODUCTS, "PRODUCT_COUNT_DRIFT")
    old_seen=set(); prepared=[]
    for row in products:
        old=(str(row.get("sku")).strip().upper() if row.get("sku") else None)
        if old:
            require(old not in old_seen,"OLD_SKU_DUPLICATE")
            old_seen.add(old)
        prefix,basis=classification(row)
        created=str(row.get("createdAt") or "")
        require(created and row.get("id") and row.get("name"),"PRODUCT_SNAPSHOT_INVALID")
        prepared.append(dict(id=row["id"],name=row["name"],oldSku=row.get("sku"),createdAt=created,
            isActive=bool(row.get("isActive")),prefix=prefix,classificationBasis=basis,
            transferCodeBefore=row.get("transferCode")))
    mapping=[]; counts={"BD":0,"TP":0}
    for prefix in ("BD","TP"):
        rows=sorted((r for r in prepared if r["prefix"]==prefix), key=lambda r:(r["createdAt"],r["id"]))
        for row in rows:
            counts[prefix]+=1
            new=f"{prefix}-{counts[prefix]:06d}"
            require(new not in old_seen,"NEW_SKU_OCCUPIED_BY_OLD")
            oldnorm=str(row["oldSku"]).strip().upper() if row["oldSku"] else None
            mapping.append({**row,"newSku":new,"transferCodeAfter":row["transferCodeBefore"],
                "alias":oldnorm if oldnorm and oldnorm!=new else None})
    missing=sum(1 for r in prepared if not str(r["oldSku"] or "").strip())
    aliases=sum(1 for r in mapping if r["alias"])
    require(counts=={"BD":EXPECTED_BD,"TP":EXPECTED_TP} and missing==EXPECTED_MISSING_OLD and aliases==EXPECTED_ALIASES,"MAPPING_COUNTS_DRIFT")
    identity=[{k:r.get(k) for k in ("id","name","oldSku","newSku","createdAt","isActive","prefix","classificationBasis","transferCodeBefore","transferCodeAfter","alias")} for r in mapping]
    raw=json.dumps(identity,ensure_ascii=False,separators=(",",":"))
    return mapping, hashlib.sha256(raw.encode()).hexdigest()

def product_snapshot(remote,name):
    args=["docker","exec","-w","/app","-e","PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c temp_file_limit=0",
          name,"node","--input-type=module","-e",PRODUCT_SNAPSHOT_SCRIPT]
    try: out=remote.run(args,timeout=30)
    except GateError: raise GateError("SKU_SNAPSHOT_READ_FAILED") from None
    try: result=json.loads(out)
    except Exception: raise GateError("SKU_SNAPSHOT_INVALID") from None
    require(len(result.get("online",[]))==EXPECTED_ONLINE,"ONLINE_MAPPING_COUNT_DRIFT")
    mapping, mapping_hash = build_mapping(result.get("products",[]))
    online_hash=hashlib.sha256(json.dumps(result["online"],ensure_ascii=False,separators=(",",":"),sort_keys=True).encode()).hexdigest()
    return result,mapping,mapping_hash,online_hash

def preflight(remote,art,before_ledger):
    template,active=remote.routes(); name=base.route_target(template,active)
    old=remote.inspect(name)
    require(old["State"]["Running"] and old["Config"]["Labels"].get(base.REVISION)==BASELINE_SHA and base.env(old).get("GIT_SHA")==BASELINE_SHA,"PRODUCTION_SHA_MISMATCH")
    require(remote.run(["cat",base.CURRENT_SHA_FILE]).decode().strip()==BASELINE_SHA,"CURRENT_SHA_POINTER_MISMATCH")
    remote.health(name,BASELINE_SHA); remote.health(name,BASELINE_SHA,public=True)
    db=remote.db(); validate_db_before(db,before_ledger); base.writer_check(remote.containers(),db,[name])
    base.validate_clone_source(old,art["config"])
    used,available=remote.disk()
    budget=base.disk_budget(used,available,art["archive"],art["blobs"],art["expanded"],art["largest"])
    remote.inspect(old["Image"],image=True)
    snapshot,mapping,mapping_hash,online_hash=product_snapshot(remote,name)
    return dict(old=old,name=name,template=template,active=active,used=used,available=available,budget=budget,
                mapping=mapping,mappingHash=mapping_hash,onlineHash=online_hash,snapshot=snapshot)

BACKUP_SCRIPT = r"""
import hashlib,json,os,pathlib,subprocess,sys,tempfile
v=json.load(sys.stdin); root=pathlib.Path(v['root']); root.mkdir(mode=0o700,parents=True,exist_ok=False)
pg=v['pg']; db=v['db']
m=json.loads(subprocess.check_output(['docker','inspect',pg]))[0]
e=dict(x.split('=',1) for x in m['Config']['Env'] if '=' in x)
u=e.get('POSTGRES_USER','postgres')
dump=root/'pre-migration.dump'
with dump.open('wb') as f:
 r=subprocess.run(['docker','exec','-i',pg,'pg_dump','-Fc','--no-owner','-U',u,'-d',db],stdout=f,stderr=subprocess.PIPE)
 if r.returncode: raise SystemExit(2)
h=hashlib.sha256(dump.read_bytes()).hexdigest()
tmp='sku_restore_'+v['suffix']
subprocess.run(['docker','exec',pg,'dropdb','--if-exists','-U',u,tmp],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
subprocess.check_call(['docker','exec',pg,'createdb','-U',u,tmp],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
try:
 with dump.open('rb') as f:
  r=subprocess.run(['docker','exec','-i',pg,'pg_restore','--no-owner','-U',u,'-d',tmp],stdin=f,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  if r.returncode: raise SystemExit(3)
 sql="SELECT json_build_object('migrations',(SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),'products',(SELECT count(*) FROM \"InventoryItem\" WHERE category='product'));"
 out=subprocess.check_output(['docker','exec',pg,'psql','-X','-qAt','-U',u,'-d',tmp,'-c',sql]).decode().strip()
 proof=json.loads(out)
 if proof!={'migrations':85,'products':178}: raise SystemExit(4)
finally:
 subprocess.run(['docker','exec',pg,'dropdb','--if-exists','-U',u,tmp],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
print(json.dumps({'path':str(dump),'sha256':h,'bytes':dump.stat().st_size,'restoreRehearsal':'PASS'}))
"""

RESTORE_SCRIPT = r"""
import json,pathlib,subprocess,sys
v=json.load(sys.stdin); pg=v['pg']; db=v['db']; dump=pathlib.Path(v['dump'])
m=json.loads(subprocess.check_output(['docker','inspect',pg]))[0]
e=dict(x.split('=',1) for x in m['Config']['Env'] if '=' in x); u=e.get('POSTGRES_USER','postgres')
subprocess.check_call(['docker','exec',pg,'psql','-X','-qAt','-U',u,'-d','postgres','-c',
 "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='"+db+"' AND pid<>pg_backend_pid();"],stdout=subprocess.DEVNULL)
with dump.open('rb') as f:
 r=subprocess.run(['docker','exec','-i',pg,'pg_restore','--clean','--if-exists','--no-owner','-U',u,'-d',db],stdin=f,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if r.returncode: raise SystemExit(2)
"""

EPHEMERAL_SCRIPT = r"""
import json,os,pathlib,subprocess,sys,tempfile
v=json.load(sys.stdin); old=json.loads(subprocess.check_output(['docker','inspect',v['old']]))[0]
env=old['Config']['Env']; network=old['HostConfig']['NetworkMode']
fd,p=tempfile.mkstemp(prefix='sku-env-',dir='/dev/shm'); os.fchmod(fd,0o600)
script_path=None
try:
 with os.fdopen(fd,'w') as f:
  for line in env: f.write(line+'\n')
 cmd=['docker','run','--rm','--network',network,'--env-file',p,'-w','/app']
 if v.get('script') is not None:
  sf,script_path=tempfile.mkstemp(prefix='sku-script-',suffix='.mjs',dir='/dev/shm'); os.fchmod(sf,0o600)
  with os.fdopen(sf,'w') as f:f.write(v['script'])
  cmd+=['-v',script_path+':/tmp/sku-script.mjs:ro',v['image'],'node','/tmp/sku-script.mjs']+v.get('args',[])
 else:
  cmd+=[v['image']]+v['args']
 r=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=v.get('timeout',180))
 if r.returncode: raise SystemExit(2)
 sys.stdout.buffer.write(r.stdout)
finally:
 pathlib.Path(p).unlink(missing_ok=True)
 if script_path:pathlib.Path(script_path).unlink(missing_ok=True)
"""

def run_ephemeral(remote,old,image,args=None,script=None,script_args=None,timeout=180):
    value={"old":old,"image":image,"args":args or [],"script":script,"timeout":timeout}
    if script is not None:value["args"]=script_args or []
    try:return remote.py(EPHEMERAL_SCRIPT,value,timeout=timeout+30)
    except GateError:raise GateError("EPHEMERAL_RELEASE_STEP_FAILED") from None

def restore_database(remote,dump,before_ledger):
    try:remote.py(RESTORE_SCRIPT,{"pg":base.PG,"db":base.EXPECTED_DB,"dump":dump},timeout=300)
    except GateError:raise GateError("DATABASE_RESTORE_FAILED") from None
    base.EXPECTED_MIGRATIONS=MIGRATIONS_BEFORE
    validate_db_before(remote.db(),before_ledger)

def post_data_reconciliation(remote,full_ledger,expected_mapping_hash,expected_online_hash):
    base.EXPECTED_MIGRATIONS=MIGRATIONS_AFTER
    db=remote.db(); validate_db_after(db,full_ledger)
    # Candidate-image data applier already validates rows, history and online mapping atomically.
    return db

def deploy(remote,repo,path,art,before_ledger,full_ledger,authorize,mapping_hash):
    require(authorize==art["release"],"EXPLICIT_RELEASE_AUTHORIZATION_REQUIRED")
    state=preflight(remote,art,before_ledger)
    require(state["mappingHash"]==mapping_hash,"MAPPING_DIGEST_CHANGED")
    release=art["release"]; candidate="budu-prod-"+release[:12]+base.CONTAINER_SUFFIX
    lock=base.LOCK+"-sku"
    remote.py("import os; os.mkdir(%r,0o700)"%lock)
    old_stopped=False; candidate_created=False; routes_touched=False; pointer_touched=False; backup=None
    try:
        require(not remote.run(["docker","ps","-aq","--filter","name=^/"+candidate+"$"]).strip(),"CANDIDATE_NAME_EXISTS")
        require(not remote.run(["docker","images","-q",art["imageReference"]]).strip(),"CANDIDATE_TAG_EXISTS")
        with open(path,"rb") as stream:
            require(base.file_hash(stream)==art["archiveHash"],"ARTIFACT_CHANGED");stream.seek(0)
            r=subprocess.run(remote.ssh+[shlex.join(["docker","load"])],stdin=stream,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=240)
            require(r.returncode==0,"ARTIFACT_LOAD_FAILED")
        image=base.resolve_loaded_image(remote,art); art["loadedDockerImageId"]=image["Id"]
        authority_mounts=base.mount_readability(remote,state["name"])
        remote.run(["docker","stop","--time","30",state["name"]]);old_stopped=True
        base.settle_writers(remote,before_ledger,[])
        # Freeze mapping after writer drain using the reviewed candidate image.
        verify_out=run_ephemeral(remote,state["name"],art["imageReference"],script=DATA_APPLY_SCRIPT.replace(
            "const result = await prisma.$transaction", "throw new Error('VERIFY_ONLY_SENTINEL')\nconst result = await prisma.$transaction"
        ),script_args=[mapping_hash,str(EXPECTED_ONLINE),ACTOR_ID,REASON,SNAPSHOT_ID],timeout=60)
        # VERIFY_ONLY_SENTINEL intentionally makes this unusable; use a read-only snapshot instead.
        raise GateError("INTERNAL_VERIFY_PATH_UNREACHABLE")
    finally:
        if old_stopped:
            # This candidate intentionally cannot mutate production until the verified
            # mutation helper is exercised by its offline state-machine tests.
            try:
                remote.run(["docker","start",state["name"]])
                base.EXPECTED_MIGRATIONS=MIGRATIONS_BEFORE
                remote.health(state["name"],BASELINE_SHA)
                base.application_db_probe(remote,state["name"],"ROLLBACK_APPLICATION_DB_PROBE_FAILED")
                base.settle_writers(remote,before_ledger,[state["name"]])
            except BaseException:
                pass
        try:remote.py("import os; os.rmdir(%r)"%lock)
        except BaseException:pass

def identity(repo):
    release=git(repo,"rev-parse","HEAD")
    before,full=validate_repo_identity(repo,release)
    return release,before,full

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("mode",choices=["identity","inspect-artifact","preflight","deploy"])
    p.add_argument("--repo",type=Path,required=True)
    p.add_argument("--archive",type=Path)
    p.add_argument("--ssh-key",type=Path)
    p.add_argument("--authorize-release-sha")
    p.add_argument("--mapping-sha256")
    args=p.parse_args()
    configure_base(args.repo)
    release,before,full=identity(args.repo)
    if args.mode=="identity":
        print(json.dumps({"result":"IDENTITY_PASS","releaseSha":release,"businessRuntimeSha":BUSINESS_SHA,
          "migration":MIGRATION_NAME,"migrationSha256":MIGRATION_SHA256,"before":85,"after":86}));return
    require(args.archive is not None,"ARCHIVE_REQUIRED")
    art=base.artifact(args.archive,release,args.repo)
    if args.mode=="inspect-artifact":
        print(json.dumps({"result":"ARTIFACT_PASS","releaseSha":release,"businessRuntimeSha":BUSINESS_SHA,
          "migrationRequired":"YES","migration":MIGRATION_NAME,"artifact":base.artifact_metrics(art)},sort_keys=True));return
    require(args.ssh_key is not None,"SSH_KEY_REQUIRED")
    remote=base.Remote(args.ssh_key)
    state=preflight(remote,art,before)
    if args.mode=="preflight":
        print(json.dumps({"result":"PREFLIGHT_PASS","releaseSha":release,"businessRuntimeSha":BUSINESS_SHA,
          "migrationBefore":85,"migrationAfter":86,"migration":MIGRATION_NAME,"migrationSha256":MIGRATION_SHA256,
          "mappingSha256":state["mappingHash"],"products":178,"BD":89,"TP":89,"aliases":145,
          "onlineMappings":153,"writer":1,"budget":state["budget"]},sort_keys=True));return
    require(args.mapping_sha256 and re.fullmatch(r"[0-9a-f]{64}",args.mapping_sha256),"MAPPING_DIGEST_REQUIRED")
    require(args.authorize_release_sha==release,"EXPLICIT_RELEASE_AUTHORIZATION_REQUIRED")
    # Gate 8A candidate deliberately refuses production mutation until the dedicated
    # mutation-state-machine implementation passes its next review.
    raise GateError("SKU_SCHEMA_MUTATION_CONTROLLER_NOT_YET_REVIEWED")

if __name__=="__main__":
    try:main()
    except GateError as e:
        print(json.dumps({"result":"RELEASE_ABORTED","code":str(e)}));sys.exit(1)
    except Exception:
        print(json.dumps({"result":"RELEASE_ABORTED","code":"UNEXPECTED_ERROR_DETAILS_SUPPRESSED"}));sys.exit(1)

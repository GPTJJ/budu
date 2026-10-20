#!/usr/bin/env python3
"""Exact PURCHASE-RETURN-001 L89 -> L90 contract using existing BG primitives.
No generic migration/count override. Preflight never claims a lock or imports.
"""
import argparse,copy,hashlib,importlib.util,json,os,pathlib,re,signal,stat,subprocess,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('guarded',Path(__file__).with_name('deploy-prod-transfer-cas.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
PROOF_HASH='146f87b896b789f6c7978915973095fd021b1969e287f049b44602e093a620c5'
BASE='e747fbd1347a9ff4e36a8b5c6de10856a3762da8'
BUSINESS='afeeeb558c454f4e67964f642618a9703709ca11'
MIGRATION='20261020000000_procurement_return'
SQL_HASH='e652a2ce87e11eda56858bafd86a5d670721f68cd6fc1a1dbdad93912b510107'
PROOF='docs/checkpoints/2026-10-20-purchase-return-release-live.json'
ENGINEERING={'docs/checkpoints/2026-10-20-purchase-return-release-live.json', 'scripts/deploy-prod-purchase-return.py', '.github/workflows/release-build-only.yml', 'docs/checkpoints/2026-10-20-purchase-return-release-001.md', 'scripts/test-purchase-return-release.py'}
BASE_CONTROLLER_HASH='e4206fa68019770ef82a8a37c3359c75164d18a749f555f0e844c6eeada02e03'
require=m.require

def identity(repo,release):
    require(m.git(repo,'rev-parse','HEAD')==release and re.fullmatch('[0-9a-f]{40}',release) is not None,'PURCHASE_RETURN_EXACT_SHA_REQUIRED')
    require(m.git(repo,'branch','--show-current')=='codex/purchase-return-001-release','PURCHASE_RETURN_BRANCH_INVALID')
    require(not m.git(repo,'status','--porcelain','--untracked-files=all'),'WORKTREE_NOT_CLEAN')
    require(m.git(repo,'rev-parse',release+'^')==BUSINESS and m.is_ancestor(repo,BASE,BUSINESS),'PURCHASE_RETURN_LINEAGE_INVALID')
    changes=set(m.git(repo,'diff','--name-only',BUSINESS,release).splitlines())
    require(changes==ENGINEERING,'PURCHASE_RETURN_ENGINEERING_SCOPE_INVALID')
    require(m.digest((repo/'scripts/deploy-prod-transfer-cas.py').read_bytes())==BASE_CONTROLLER_HASH,'BASE_CONTROLLER_CHANGED')
    ledger={p.parent.name:m.digest(p.read_bytes()) for p in (repo/'prisma/migrations').glob('*/migration.sql')}
    old={Path(p).parent.name:m.digest(m.command(['git','-C',str(repo),'show',BASE+':'+p])) for p in m.git(repo,'ls-tree','-r','--name-only',BASE,'prisma/migrations').splitlines() if p.endswith('/migration.sql')}
    require(len(old)==89 and ledger=={**old,MIGRATION:SQL_HASH},'PURCHASE_RETURN_FULL_LEDGER_MISMATCH')
    sql=(repo/'prisma/migrations'/MIGRATION/'migration.sql').read_text();require(m.digest(sql.encode())==SQL_HASH,'PURCHASE_RETURN_SQL_CHANGED')
    proof=json.loads((repo/PROOF).read_text())
    require(m.digest((repo/PROOF).read_bytes())==PROOF_HASH and proof['sha']==BASE and proof['ledger']==old,'PURCHASE_RETURN_PROOF_CHANGED')
    m.configure_profile('post-transfer',BASE,BUSINESS,proof['runtimeHash'])
    return {'release':release,'ledger':ledger,'oldLedger':old,'sql':sql,'proof':proof,'helper':(repo/'scripts/clone-production-container.py').read_text()}

def schema(remote):
    return m.procurement_query(remote,"""SELECT json_build_object(
      'returnTable',to_regclass('public."ProcurementReturn"') IS NOT NULL,
      'productTable',to_regclass('public."ProcurementReturnProduct"') IS NOT NULL,
      'auditIndex',to_regclass('public."ProcurementAudit_entityId_createdAt_idx"') IS NOT NULL,
      'foreignKeys',(SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('public."ProcurementReturnProduct"') AND contype='f' AND convalidated),
      'checks',(SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('public."ProcurementReturn"') AND contype='c' AND convalidated));""")

def database(remote,v,phase):
    db=remote.db();expected=v['oldLedger'] if phase==89 else v['ledger']
    require(phase in (89,90) and db['database']==m.EXPECTED_DB and db['ledger']==expected and db['applied']==len(expected)==phase
            and db['failed']==db['rolledBack']==0 and db['pgVersion']=='16.14','PURCHASE_RETURN_DATABASE_CONTRACT')
    require(db.get('check')=={'validated':True,'definition':m.SHIPPING_CHECK_NEW} and db.get('invalidFacts')==0,'PURCHASE_RETURN_EXISTING_TRANSFER_CONSTRAINT')
    # The only addition to the original procurement schema is this audit index.
    needle="tablename IN (SELECT name FROM names)),\n 'trigger'"
    require(m.PROCUREMENT_SCHEMA_SQL.count(needle)==1,'PROCUREMENT_SCHEMA_GUARD_CHANGED')
    original=m.PROCUREMENT_SCHEMA_SQL.replace(needle,"tablename IN (SELECT name FROM names) AND indexname<>'ProcurementAudit_entityId_createdAt_idx'),\n 'trigger'")
    require(m.procurement_query(remote,original).get('schemaMd5')==m.procurement_contract()['schemaMd5'],'PURCHASE_RETURN_EXISTING_PROCUREMENT_SCHEMA')
    expectedShape={'returnTable':phase==90,'productTable':phase==90,'auditIndex':phase==90,'foreignKeys':2 if phase==90 else 0,'checks':2 if phase==90 else 0}
    require(schema(remote)==expectedShape,'PURCHASE_RETURN_SCHEMA_CONTRACT')
    return db

def rollback_eligible(remote,v):
    db=remote.db();database(remote,v,db['applied'])
    # The additive tables and all return/audit rows remain during app rollback.
    return {'eligible':True,'returnSchemaRetained':db['applied']==90,'businessDataDeleted':False}

def writer(remote,v,state,names,standby=False):
    rows=remote.containers()
    if standby:
        c=m.bg_lifecycle(remote,v,state,'standby');require(sum(x['Id']==c['Id'] for x in rows)==1,'BG_CANDIDATE_CHANGED');rows=[x for x in rows if x['Id']!=c['Id']]
    db=database(remote,v,state['phase']);m.writer_check(rows,db,names);return db

def mount_contract(c,proof):
    # Docker enumerates resolved Mounts in map order. Anchor the complete
    # unchanged HostConfig, then compare every resolved field without ordering.
    require(m.digest(json.dumps(c['HostConfig'],sort_keys=True).encode())==proof['resourcesHash'],'PURCHASE_RETURN_RESOURCES_CHANGED')
    host=c['HostConfig'];require(host.get('Binds') is None and isinstance(host.get('Mounts'),list),'PURCHASE_RETURN_MOUNT_CONTRACT')
    expected=[]
    for x in host['Mounts']:
        require(set(x)<= {'Type','Source','Target','ReadOnly'} and all(k in x for k in ['Type','Source','Target']),'PURCHASE_RETURN_MOUNT_OPTIONS_CHANGED')
        if x['Type']=='bind':
            expected.append({'Type':'bind','Source':x['Source'],'Destination':x['Target'],'Mode':'','RW':not x.get('ReadOnly',False),'Propagation':'rprivate'})
        elif x['Type']=='volume':
            require(re.fullmatch('[a-zA-Z0-9_.-]+',x['Source']) is not None,'PURCHASE_RETURN_VOLUME_IDENTITY')
            expected.append({'Type':'volume','Name':x['Source'],'Source':'/var/lib/docker/volumes/'+x['Source']+'/_data','Destination':x['Target'],'Driver':'local','Mode':'z','RW':not x.get('ReadOnly',False),'Propagation':''})
        else:raise m.GateError('PURCHASE_RETURN_MOUNT_TYPE_CHANGED')
    require(len({x['Destination'] for x in expected})==len(expected),'PURCHASE_RETURN_MOUNT_DUPLICATE')
    require(sorted(c['Mounts'],key=lambda x:x['Destination'])==sorted(expected,key=lambda x:x['Destination']),'PURCHASE_RETURN_MOUNTS_CHANGED')
    return {'count':len(expected),'unorderedIdentitySha256':m.digest(json.dumps(sorted(expected,key=lambda x:x['Destination']),sort_keys=True).encode()),'originalHostConfigHashMatched':True}

def old_guard(remote,v,phase=89):
    p=v['proof'];c=remote.inspect(p['container'])
    require(c['Id']==p['id'] and c['Image']==p['image'] and c['Config']['Labels']==p['labels']
            and m.env(c).get('GIT_SHA')==BASE and m.env(c).get('BUDU_RUNTIME_MODE')=='standby','PURCHASE_RETURN_OLD_IDENTITY')
    require(c['State']['Running'] and c['State'].get('Health',{}).get('Status')=='healthy','PURCHASE_RETURN_OLD_NOT_HEALTHY')
    t,a=remote.routes();require(t==a and m.digest(t.encode())==p['routeHash'] and m.route_target(t,a)==p['container'],'PURCHASE_RETURN_ROUTE_CHANGED')
    require(remote.run(['cat',m.CURRENT_SHA_FILE]).decode().strip()==BASE,'PURCHASE_RETURN_POINTER_CHANGED')
    remote.health(c['Id'],BASE);remote.health(c['Id'],BASE,True)
    h=json.loads(remote.run(['docker','exec',c['Id'],'wget','-qO-','http://127.0.0.1:3000/api/health']))
    require(h.get('runtimeMode')=='active' and h.get('appStartupTasksStarted')==h.get('processBackgroundTasksStarted')==1,'PURCHASE_RETURN_OLD_NOT_ACTIVE')
    m.application_db_probe(remote,c['Id'],'PURCHASE_RETURN_OLD_DB_PROBE')
    require(remote.run(['docker','exec',c['Id'],'sha256sum','/app/server/v2.js']).decode().split()[0]==p['runtimeHash'],'PURCHASE_RETURN_RUNTIME_CHANGED')
    mount_contract(c,p)
    db=writer(remote,v,{'phase':phase},[p['container']]);return c,db

def capacity_plan(v,db):
    art=v['art'];limits=m.shipping_resources(db)
    retained=sum(art[k] for k in ('archive','blobs','expanded'))
    return {'version':'PURCHASE_RETURN_RETAINED_ARCHIVE_PHASES_V1','release':v['release'],
            'archiveHash':art['archiveHash'],'dbBytes':db['dbBytes'],'pgVersion':db['pgVersion'],'limits':limits,
            'import':retained+art['largest']+m.RESERVE+limits['walLimit'],
            'database':retained+m.RESERVE+sum(limits.values())}



def retained_archive(remote,v,expected=None):
    code="""import os,json,sys,stat,hashlib,pathlib
v=json.load(sys.stdin);p=pathlib.Path('/opt/budu/.rollback-assets/blue-green-'+v['release'])/'exact-e.tar'
assert p.parent.resolve()==p.parent and p.parent.stat().st_dev==os.stat('/').st_dev
fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
with os.fdopen(fd,'rb') as f:
 s=os.fstat(f.fileno());assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1
 h=hashlib.sha256()
 for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 identity=lambda q:(q.st_dev,q.st_ino,q.st_mode,q.st_nlink,q.st_uid,q.st_gid,q.st_size,q.st_mtime_ns,q.st_ctime_ns)
 assert identity(os.fstat(f.fileno()))==identity(s) and identity(p.lstat())==identity(s)
 assert s.st_size==v['bytes'] and h.hexdigest()==v['sha256']
 print(json.dumps({'device':s.st_dev,'inode':s.st_ino,'bytes':s.st_size,'sha256':h.hexdigest()}))
"""
    receipt=json.loads(remote.py(code,{'release':v['release'],'bytes':v['art']['archive'],'sha256':v['art']['archiveHash']},timeout=60))
    require(receipt.get('bytes')==v['art']['archive'] and receipt.get('sha256')==v['art']['archiveHash']
            and (expected is None or receipt==expected),'PURCHASE_RETURN_RETAINED_ARCHIVE_CHANGED')
    return receipt


def capacity(remote,v,phase,proof=None):
    """Original gate, monotonically accumulated across proven phase changes.

    No allowance is removed because of a caller's phase string alone. The
    archive remains in the plan and actual retained bytes remain in df.
    """
    art=v['art'];plan=v['capacityPlan'];limits=v['limits']
    require(plan==capacity_plan(v,{'dbBytes':plan['dbBytes'],'pgVersion':plan['pgVersion']}) and limits==plan['limits'],
            'PURCHASE_RETURN_CAPACITY_PLAN_CHANGED')
    cap=art.get('capacityLedger');previous=cap.get('phase') if cap else None
    evidence=None
    if phase=='PURCHASE_RETURN_PRE_IMPORT':
        require(previous in (None,phase),'PURCHASE_RETURN_CAPACITY_PHASE_INVALID')
        future=plan['import']
    else:
        order={'PURCHASE_RETURN_IMPORTED':'PURCHASE_RETURN_PRE_IMPORT','PURCHASE_RETURN_BACKUP_RETAINED':'PURCHASE_RETURN_IMPORTED',
               'PURCHASE_RETURN_DB90':'PURCHASE_RETURN_BACKUP_RETAINED','PURCHASE_RETURN_FINAL':'PURCHASE_RETURN_DB90'}
        require(previous==order.get(phase) and phase in order,'PURCHASE_RETURN_CAPACITY_PHASE_INVALID')
        require(cap.get('plan')==plan,'PURCHASE_RETURN_CAPACITY_PLAN_CHANGED')
        require(isinstance(proof,dict),'PURCHASE_RETURN_CAPACITY_PROOF_MISSING')
        if phase=='PURCHASE_RETURN_IMPORTED':
            # Full original identity/storage/committed-chain barrier. A load
            # receipt or phase name alone never retires import temporary space.
            storage=m.b2_barrier(remote,art,proof,cap)
            require(proof.get('serverSha256BeforeImport') is True,'B2_IMPORT_UNKNOWN')
            cap['archiveIdentity']=retained_archive(remote,v)
            evidence={'importReceipt':proof,'storage':storage,'archiveIdentity':cap['archiveIdentity']}
            future=m.RESERVE+sum(limits.values())
        elif phase=='PURCHASE_RETURN_BACKUP_RETAINED':
            retained_archive(remote,v,cap['archiveIdentity'])
            flags=['backupTerminationVerified','exporterTerminated','dumpTerminated',
                   'restoreStopped','restoreProcessTerminated','restoreVerified']
            require(proof.get('result')=='PASS' and all(proof.get(k) is True for k in flags)
                    and proof.get('releaseSha')==v['release'] and proof.get('restoreContainer')=='budu-bg-restore-'+v['release'][:12]
                    and proof.get('pgVersion')=='16.14'
                    and bool(proof.get('sourceSnapshotFingerprint'))
                    and proof.get('sourceSnapshotFingerprint')==proof.get('restoredFingerprint')
                    and type(proof.get('backupBytes')) is int and 0<proof['backupBytes']<=limits['backupLimit']
                    and type(proof.get('restoreAllocatedBytes')) is int and 0<proof['restoreAllocatedBytes']<=limits['restoreLimit']
                    and re.fullmatch('[0-9a-f]{64}',proof.get('backupSha256','')) is not None,
                    'PURCHASE_RETURN_BACKUP_UNVERIFIED')
            evidence={'backup':proof};future=m.RESERVE+limits['walLimit']+limits['migratorLimit']
        elif phase=='PURCHASE_RETURN_DB90':
            retained_archive(remote,v,cap['archiveIdentity'])
            require(proof.get('result')=='PASS' and proof.get('terminated') is True
                    and proof.get('transactionAtomic') is True and proof.get('returncode')==0,
                    'PURCHASE_RETURN_MIGRATION_UNVERIFIED')
            database(remote,v,90);evidence={'migration':proof,'ledger':v['ledger']};future=m.RESERVE
        else:
            retained_archive(remote,v,cap['archiveIdentity'])
            require(proof.get('phase')==90,'PURCHASE_RETURN_CAPACITY_PROOF_MISSING')
            m.bg_lifecycle(remote,v,proof,'active');writer(remote,v,proof,[proof['candidate']])
            require(m.route_target(*remote.routes())==proof['candidate']
                    and not remote.inspect(v['proof']['id'])['State']['Running'],'PURCHASE_RETURN_FINAL_UNVERIFIED')
            remote.health(proof['candidate'],v['release'],True)
            evidence={'candidateId':proof['candidateId'],'runtime':'active','writer':1};future=m.RESERVE
    used,available=remote.disk()
    if cap is None:
        cap={'baselineUsed':used,'baselineAvailable':available,'peak':0,
             'baselineCommitted':sorted(m.b2_committed(remote)),'plan':copy.deepcopy(plan)}
        art['capacityLedger']=cap
    require(cap.get('plan')==plan,'PURCHASE_RETURN_CAPACITY_PLAN_CHANGED')
    if evidence is not None:
        cap.setdefault('phaseReceipts',[]).append({'from':previous,'to':phase,'evidence':copy.deepcopy(evidence)})
    cap['phase']=phase
    try:return m.b1_capacity_gate(cap,used,available,future,planned=max(plan['import'],plan['database']))
    except m.GateError:
        print(json.dumps({'stage':'CAPACITY_BLOCKED','capacityLedger':cap,'dfRaw':remote.run(['df','-Pk','/']).decode()}),flush=True)
        raise

def preflight(remote,v):
    c,db=old_guard(remote,v);m.validate_clone_source(c,v['art']['config'])
    m.mount_readability(remote,c['Id']);m.b1_storage(remote)
    lock=json.loads(remote.py("import json,pathlib; p=pathlib.Path('/run/lock/budu-transfer-cas-release'); print(json.dumps({'present':p.exists(),'symlink':p.is_symlink()}))"))
    require(lock=={'present':False,'symlink':False},'PURCHASE_RETURN_LOCK_PRESENT')
    root='/opt/budu/.rollback-assets/blue-green-'+v['release']
    require(remote.run(['test','!','-e',root])==b'','PURCHASE_RETURN_RELEASE_ROOT_EXISTS')
    limits=m.shipping_resources(db);v['limits']=limits
    v['capacityPlan']=capacity_plan(v,db)
    budget=capacity(remote,v,'PURCHASE_RETURN_PRE_IMPORT')
    return {'result':'PREFLIGHT_PASS','sha':v['release'],'old':v['proof']['sha'],'writer':1,'dbApplied':89,'dbFailed':0,'lockAbsent':True,
            'budget':budget,'capacityLedger':v['art']['capacityLedger'],'migrationLimits':limits,'dfRaw':remote.run(['df','-Pk','/']).decode()}

def migration_script(v):
    require(m.digest(v['sql'].encode())==SQL_HASH and v['ledger']=={**v['oldLedger'],MIGRATION:SQL_HASH} and len(v['oldLedger'])==89,'PURCHASE_RETURN_SQL_CONTRACT')
    old=json.dumps(v['oldLedger'],sort_keys=True).replace("'","''")
    return """BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s';
LOCK TABLE "_prisma_migrations" IN SHARE ROW EXCLUSIVE MODE;
DO $purchase_return$ BEGIN
IF (SELECT count(*) FROM "_prisma_migrations")<>89 OR
 EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) OR
 (SELECT jsonb_object_agg(migration_name,checksum) FROM "_prisma_migrations") IS DISTINCT FROM 'REPLACE_LEDGER'::jsonb OR
 to_regclass('public."ProcurementReturn"') IS NOT NULL OR
 to_regclass('public."ProcurementReturnProduct"') IS NOT NULL OR
 to_regclass('public."ProcurementAudit_entityId_createdAt_idx"') IS NOT NULL
THEN RAISE EXCEPTION 'PURCHASE_RETURN_LEDGER_OR_SCHEMA_CHANGED'; END IF; END $purchase_return$;
""".replace('REPLACE_LEDGER',old)+v['sql']+f'''\nINSERT INTO "_prisma_migrations"(id,checksum,migration_name,finished_at,applied_steps_count) VALUES ('{v['release'][:32]}','{SQL_HASH}','{MIGRATION}',clock_timestamp(),1); COMMIT;\n'''

PURCHASE_RETURN_MIGRATION_CODE=m.SHIPPING_BOUNDED_DUMP_CODE+r'''
import json,sys
v=json.load(sys.stdin);pg=json.loads(subprocess.check_output(['docker','inspect',v['pg']]))[0]
e=dict(x.split('=',1) for x in pg['Config']['Env']);user=e.get('POSTGRES_USER','postgres')
marker='budu_purchase_return_migrate_'+v['release'][:12];p=None
base=['docker','exec','-i','-e','PGOPTIONS=-c application_name='+marker,'-e','PGAPPNAME='+marker,v['pg'],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',user,'-d',v['database']]
result={'result':'FAIL','terminated':False,'transactionAtomic':True}
try:
 p=subprocess.Popen(base,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 out,err=p.communicate(v['transaction'].encode(),timeout=45)
 result.update(result='PASS' if p.returncode==0 else 'FAIL',returncode=p.returncode)
 if p.returncode:result['code']='PURCHASE_RETURN_MIGRATION_FAILED'
except BaseException as e:result['code']='PURCHASE_RETURN_MIGRATION_UNKNOWN';result['errorType']=type(e).__name__
finally:
 previous=signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGHUP,signal.SIGTERM,signal.SIGINT})
 try:
  if p is not None:stop_backup_process(p)
  cleanup=base.copy();cleanup[4]='PGOPTIONS=-c statement_timeout=8000 -c application_name='+marker+'_cleanup';cleanup[6]='PGAPPNAME='+marker+'_cleanup'
  predicate="datname='"+v['database']+"' AND application_name='"+marker+"' AND pid<>pg_backend_pid()"
  for sql in ['SELECT pg_terminate_backend(pid,5000) FROM pg_stat_activity WHERE '+predicate+';','SELECT count(*) FROM pg_stat_activity WHERE '+predicate+';']:
   r=subprocess.run(cleanup,input=sql.encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15);assert r.returncode==0
  assert r.stdout.strip()==b'0';result['terminated']=True
 except BaseException:result.update(result='FAIL',code='PURCHASE_RETURN_MIGRATION_TERMINATION_UNVERIFIED')
 finally:signal.pthread_sigmask(signal.SIG_SETMASK,previous)
print(json.dumps(result))
'''

def lock(remote,v,action,receipt=None):
    return m.bg_script(remote,m.BG_LOCK_CODE,{'path':m.LOCK,'action':action,'fresh':True,'stale':{'present':False,'openReferences':[]},'release':v['release'],'receipt':receipt})

def recover_old(remote,v):
    c=remote.inspect(v['proof']['id']);require(c['Image']==v['proof']['image'],'PURCHASE_RETURN_ROLLBACK_IMAGE_CHANGED')
    if not c['State']['Running']:remote.run(['docker','start',c['Id']])
    gv=dict(v,art={'release':BASE,'loadedDockerImageId':c['Image'],'imageReference':c['Config']['Image']})
    gs={'candidate':v['proof']['container'],'candidateId':c['Id'],'lifecycleSince':remote.inspect(c['Id'])['State']['StartedAt']}
    m.bg_lifecycle(remote,gv,gs,'standby');m.bg_promote(remote,gv,gs);m.bg_lifecycle(remote,gv,gs,'active')

def execute(remote,v,stream):
    state={'candidate':'budu-prod-'+v['release'][:12]+'-post-transfer','phase':89};stage='PREFLIGHT';owned=False;keep=True;result={}
    try:
        preflight(remote,v);g,db=old_guard(remote,v);state['g']=g
        receipt=lock(remote,v,'claim');owned=True
        root='/opt/budu/.rollback-assets/blue-green-'+v['release'];state['root']=root
        remote.py("import json,pathlib,sys,os;v=json.load(sys.stdin);os.umask(0o077);p=pathlib.Path(v['root']);p.mkdir(mode=0o700);(p/'manifest.json').write_text(json.dumps(v['manifest'],sort_keys=True))",{'root':root,'manifest':{'releaseSha':v['release'],'businessSha':BUSINESS,'migration':MIGRATION,'sqlHash':SQL_HASH,'rollback':v['proof']}})
        stage='IMPORT';imp=m.bg_import(stream,v['art'],root);v['art']['loadedDockerImageId']=m.resolve_loaded_image(remote,v['art'])['Id']
        capacity(remote,v,'PURCHASE_RETURN_IMPORTED',imp)
        stage='PRISMA_PROBE'
        probe="import {PrismaClient,Prisma} from '@prisma/client';for(const name of ['ProcurementReturn','ProcurementReturnProduct'])if(!Prisma.dmmf.datamodel.models.some(x=>x.name===name))throw Error('PRISMA_RETURN_MODEL');const p=new PrismaClient();try{await p.$queryRawUnsafe('SELECT 1');process.stdout.write('BG_PRE_MIGRATION_PROBE_OK\\n')}finally{await p.$disconnect()}"
        pr=m.bg_script(remote,m.BG_PROBE_CODE,{'old':g['Id'],'name':'budu-bg-probe-'+v['release'][:12],'release':v['release'],'image':v['art']['imageReference'],'imageId':v['art']['loadedDockerImageId'],'script':probe},60)
        require(pr.get('result')=='PASS' and pr.get('terminated') is True,'PURCHASE_RETURN_PRISMA_PROBE_UNVERIFIED')
        stage='SNAPSHOT_BACKUP';state['backupAttempted']=True
        b=m.bg_script(remote,m.BG_SNAPSHOT_CODE,{'root':root,'pg':m.PG,'database':m.EXPECTED_DB,'limits':v['limits'],'release':v['release'],'restore':'budu-bg-restore-'+v['release'][:12]});state['backup']=b
        require(b.get('result')=='PASS' and all(b.get(k) is True for k in ['backupTerminationVerified','exporterTerminated','dumpTerminated','restoreStopped','restoreProcessTerminated','restoreVerified']) and b['sourceSnapshotFingerprint']==b['restoredFingerprint'],'PURCHASE_RETURN_BACKUP_UNVERIFIED')
        old_guard(remote,v);capacity(remote,v,'PURCHASE_RETURN_BACKUP_RETAINED',b)
        stage='ATOMIC_PURCHASE_RETURN_MIGRATION';state['migrationAttempted']=True
        mig=m.bg_script(remote,PURCHASE_RETURN_MIGRATION_CODE,{'pg':m.PG,'database':m.EXPECTED_DB,'release':v['release'],'transaction':migration_script(v)},60);state['migration']=mig
        require(mig.get('result')=='PASS' and mig.get('terminated') is True,'PURCHASE_RETURN_MIGRATION_UNVERIFIED')
        state['phase']=90;old_guard(remote,v,90);capacity(remote,v,'PURCHASE_RETURN_DB90',mig)
        stage='CANDIDATE';m.bg_clone(remote,v,state);name=state['candidate'];remote.health(name,v['release']);m.bg_lifecycle(remote,v,state,'standby')
        authority=m.mount_readability(remote,g['Id']);m.runtime_checks(remote,name,v['art']['runtimeHash'],authority);m.application_db_probe(remote,name,'PURCHASE_RETURN_CANDIDATE_DB_PROBE')
        sqlprobe="import {PrismaClient} from '@prisma/client';const p=new PrismaClient();try{await p.procurementReturn.findMany({take:1,select:{id:true,status:true}});await p.procurementReturnProduct.findMany({take:1});process.stdout.write('PURCHASE_RETURN_SCHEMA_OK\\n')}finally{await p.$disconnect()}"
        require(remote.run(['docker','exec','-e','PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=8000',name,'node','--input-type=module','-e',sqlprobe])==b'PURCHASE_RETURN_SCHEMA_OK\n','PURCHASE_RETURN_COLUMN_READ_FAILED')
        writer(remote,v,state,[v['proof']['container']],True);state['standbyVerified']=True
        t=v['template'];next_routes=t.replace('http://'+v['proof']['container']+':3000','http://'+name+':3000');require(next_routes.count('http://'+name+':3000')==3,'CUTOVER_ROUTE_COUNT_INVALID')
        stage='STOP_G';state['gStopAttempted']=True;remote.run(['docker','stop','--time','30',g['Id']]);require(not remote.inspect(g['Id'])['State']['Running'],'BG_G_STOP_UNVERIFIED')
        stage='ZERO_WRITER';writer(remote,v,state,[],True)
        stage='PROMOTION';m.bg_promote(remote,v,state);m.bg_lifecycle(remote,v,state,'active');writer(remote,v,state,[name])
        stage='CUTOVER';m.replace_routes(remote,next_routes,next_routes);remote.health(name,v['release'],True);m.application_db_probe(remote,name,'PURCHASE_RETURN_CANDIDATE_DB_PROBE');writer(remote,v,state,[name])
        require(m.route_target(*remote.routes())==name,'FINAL_ROUTE_CHANGED');capacity(remote,v,'PURCHASE_RETURN_FINAL',state)
        m.write_authority(remote,m.CURRENT_SHA_FILE,v['release']+'\n');require(remote.run(['cat',m.CURRENT_SHA_FILE]).decode().strip()==v['release'],'FINAL_POINTER_FAILED')
        require(not remote.inspect(g['Id'])['State']['Running'] and remote.inspect(g['Image'],image=True)['Id']==g['Image'],'ROLLBACK_ASSET_CHANGED')
        result={'result':'DEPLOY_COMPLETE','releaseSha':v['release'],'businessSha':BUSINESS,'dbApplied':90,'dbFailed':0,'writer':1,'runtimeMode':'active','route':name,'internalHealth':'PASS','publicHealth':'PASS','applicationDbProbe':'PASS','backup':b,'migration':mig,'oldStopped':True,'importReceipt':imp}
        saved=m.bg_script(remote,m.BG_EVIDENCE_CODE,{'root':root,'result':dict(result,capacityLedger=v['art'].get('capacityLedger'))});require(saved.get('result')=='PASS','EVIDENCE_UNVERIFIED');keep=False
    except BaseException as e:
        result={'result':'DEPLOY_BLOCKED','stage':stage,'code':str(e) if isinstance(e,m.GateError) else 'PURCHASE_RETURN_UNKNOWN','errorType':type(e).__name__}
        try:
            m.bg_owned_stop(remote,v,state)
            db=remote.db();state['phase']=db['applied'];database(remote,v,state['phase'])
            if state.get('gStopAttempted'):
                writer(remote,v,state,[]);r=rollback_eligible(remote,v);result['rollbackAdmission']=r
                require(r['eligible'],'ROLLBACK_PURCHASE_RETURN_INCOMPATIBLE')
                recover_old(remote,v);m.replace_routes(remote,v['template'],v['active']);m.write_authority(remote,m.CURRENT_SHA_FILE,BASE+'\n');writer(remote,v,state,[v['proof']['container']]);remote.health(v['proof']['container'],BASE,True);result['recovery']='OLD_ACTIVE_RESTORED'
            else:writer(remote,v,state,[v['proof']['container']]);remote.health(v['proof']['container'],BASE,True);result['recovery']='OLD_UNCHANGED'
            # Failed or uncertain attempts retain ownership; no automatic retry/lock cleanup.
        except BaseException as secondary:result['recovery']='UNKNOWN_RETAIN_LOCK';result['secondaryType']=type(secondary).__name__
    finally:
        if owned and not keep:
            try:lock(remote,v,'release',receipt);result['releaseLockReleased']=True
            except BaseException:result.update(result='DEPLOY_BLOCKED',releaseLockReleased=False,code='LOCK_RELEASE_UNVERIFIED')
        else:result['releaseLockReleased']=False
        result.update(capacityLedger=v['art'].get('capacityLedger'),capacityTelemetry=m.CAPACITY_TELEMETRY)
    return result


def bootstrap_source():
    base=Path(m.__file__).read_text().rsplit("\nif __name__ == '__main__':",1)[0]
    own=Path(__file__).read_text();body=own[own.index('PROOF_HASH='):own.index('\ndef main():')]
    imports="import argparse,copy,hashlib,json,os,pathlib,re,signal,stat,subprocess,sys,types\nfrom pathlib import Path\n"
    code=imports+"m=types.ModuleType('guarded');exec(compile("+repr(base)+",'<guarded>','exec'),m.__dict__)\n"+body
    code+="\nv=json.loads(sys.stdin.buffer.readline())\nm.configure_profile('post-transfer',BASE,BUSINESS,v['proof']['runtimeHash'])\ndef interrupted(*a):raise m.GateError('PURCHASE_RETURN_INTERRUPTED')\nfor sig in (signal.SIGHUP,signal.SIGTERM,signal.SIGINT):signal.signal(sig,interrupted)\nprint(json.dumps(execute(m.LocalRemote(),v,sys.stdin.buffer)),flush=True)\n"
    return code

def completed(result,release):
    require(all(result.get(k)==x for k,x in {'result':'DEPLOY_COMPLETE','releaseSha':release,'dbApplied':90,'dbFailed':0,'writer':1,'runtimeMode':'active','internalHealth':'PASS','publicHealth':'PASS','applicationDbProbe':'PASS','oldStopped':True,'releaseLockReleased':True}.items()),'PURCHASE_RETURN_DEPLOY_NOT_COMPLETE')


def parse_execution(out,returncode,release):
    require(returncode==0,'PURCHASE_RETURN_TRANSPORT_UNKNOWN')
    try:records=[json.loads(line) for line in out.splitlines() if line.strip()]
    except (ValueError,UnicodeError):raise m.GateError('PURCHASE_RETURN_RECEIPT_INVALID') from None
    terminal=[x for x in records if isinstance(x,dict) and 'result' in x]
    require(len(terminal)==1 and records[-1] is terminal[0],'PURCHASE_RETURN_RECEIPT_INCOMPLETE')
    completed(terminal[0],release);return terminal[0]



def transport(command,chunks,timeout=1800):
    """One deadline for sending and waiting; never signal a remote process.

    Drain both output pipes during upload to avoid SSH backpressure deadlocks.
    Partial output survives timeout/early close; only the local SSH child is
    killed. The caller must treat every such outcome as remote state UNKNOWN.
    """
    import selectors,time
    deadline=time.monotonic()+timeout
    p=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,bufsize=0)
    output={'stdout':bytearray(),'stderr':bytearray()};error=None;pending=memoryview(b'')
    iterator=iter(chunks)
    with selectors.DefaultSelector() as sel:
        for pipe,event,name in [(p.stdin,selectors.EVENT_WRITE,'stdin'),(p.stdout,selectors.EVENT_READ,'stdout'),(p.stderr,selectors.EVENT_READ,'stderr')]:
            os.set_blocking(pipe.fileno(),False);sel.register(pipe,event,name)
        try:
            while sel.get_map():
                left=deadline-time.monotonic()
                if left<=0:
                    error='PURCHASE_RETURN_TRANSPORT_TIMEOUT_UNKNOWN';break
                for key,events in sel.select(min(left,0.2)):
                    pipe=key.fileobj
                    if key.data=='stdin':
                        try:
                            if not pending:pending=memoryview(next(iterator))
                            if pending:pending=pending[os.write(pipe.fileno(),pending[:65536]):]
                        except StopIteration:
                            sel.unregister(pipe);pipe.close()
                        except BlockingIOError:pass
                        except OSError:
                            error='PURCHASE_RETURN_TRANSPORT_WRITE_UNKNOWN';sel.unregister(pipe);pipe.close()
                    else:
                        try:chunk=os.read(pipe.fileno(),65536)
                        except BlockingIOError:continue
                        if chunk:output[key.data].extend(chunk)
                        else:sel.unregister(pipe);pipe.close()
            if error!='PURCHASE_RETURN_TRANSPORT_TIMEOUT_UNKNOWN':
                try:p.wait(timeout=max(0,deadline-time.monotonic()))
                except subprocess.TimeoutExpired:error='PURCHASE_RETURN_TRANSPORT_TIMEOUT_UNKNOWN'
        finally:
            # This is strictly the child Popen PID, never killpg/SSH a kill.
            if p.poll() is None:p.kill()
            p.wait(timeout=5)
            # Preserve already buffered bytes without waiting for remote EOF.
            drain_deadline=time.monotonic()+0.5
            for key in list(sel.get_map().values()):
                if key.data!='stdin':
                    while time.monotonic()<drain_deadline:
                        try:chunk=os.read(key.fileobj.fileno(),65536)
                        except BlockingIOError:break
                        if not chunk:break
                        output[key.data].extend(chunk)
                key.fileobj.close()
    return bytes(output['stdout']),bytes(output['stderr']),p.returncode,error


def deploy(remote,v,archive,authorized):
    require(authorized==v['release'],'EXACT_RELEASE_AUTHORIZATION_REQUIRED')
    # One on-host controller owns mutations and failure recovery, as in existing BG flow.
    code=bootstrap_source()
    loader="import json,sys;exec(compile(json.loads(sys.stdin.buffer.readline()),'<budu-pickup>','exec'))"
    import shlex
    def chunks():
        yield json.dumps(code).encode()+b'\n'
        yield json.dumps(v).encode()+b'\n'
        with open(archive,'rb') as src:
            yield from iter(lambda:src.read(65536),b'')
    out,err,rc,error=transport(remote.ssh+[shlex.join(['sudo','-n','python3','-u','-c',loader])],chunks())
    sys.stdout.buffer.write(out);sys.stdout.buffer.flush();sys.stderr.buffer.write(err);sys.stderr.buffer.flush()
    require(error is None,error or 'PURCHASE_RETURN_TRANSPORT_UNKNOWN')
    parse_execution(out,rc,v['release'])

def main():
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['identity','inspect-artifact','preflight','deploy']);p.add_argument('--repo',type=Path,required=True);p.add_argument('--release-sha',required=True);p.add_argument('--archive',type=Path);p.add_argument('--ssh-key');p.add_argument('--authorize-release-sha');a=p.parse_args()
    v=identity(a.repo,a.release_sha)
    if a.mode=='identity':print(json.dumps({'result':'IDENTITY_PASS','sha':v['release'],'migration':MIGRATION,'sqlHash':SQL_HASH,'oldLedgerCount':89,'newLedgerCount':90}));return
    require(a.archive is not None,'ARCHIVE_REQUIRED');art=m.artifact(a.archive,a.release_sha,a.repo);art['capacityProfile']='STORE_PURCHASE_RETURN_FULL_L88_TO_L89';v['art']=art
    print(json.dumps({'stage':'ARTIFACT_METRICS','metrics':m.artifact_metrics(art)}),flush=True)
    if a.mode=='inspect-artifact':print(json.dumps({'result':'ARTIFACT_IDENTITY_PASS','archiveSha256':art['archiveHash'],'archiveBytes':art['archive'],'release':v['release']}));return
    require(a.ssh_key is not None,'SSH_REQUIRED');remote=m.Remote(a.ssh_key);v['template'],v['active']=remote.routes()
    if a.mode=='preflight':print(json.dumps(preflight(remote,v)));return
    deploy(remote,v,a.archive,a.authorize_release_sha)

if __name__=='__main__':
    try:main()
    except m.GateError as e:print(json.dumps({'result':'BLOCKED','code':str(e),'capacityTelemetry':m.CAPACITY_TELEMETRY}),flush=True);raise SystemExit(1)

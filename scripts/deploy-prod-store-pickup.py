#!/usr/bin/env python3
"""Exact STORE-PICKUP-001 L88 -> L89 contract using existing BG primitives.
No generic migration/count override. Preflight never claims a lock or imports.
"""
import argparse,copy,hashlib,importlib.util,json,os,pathlib,re,signal,stat,subprocess,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('guarded',Path(__file__).with_name('deploy-prod-transfer-cas.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
PROOF_HASH='0ec347b91e55fdfff9bb8f22427b23868823a781ad389a6c7825a2af82f1702e'
BASE='74eb7d87c0de0d5d493c66284d72267029340d05'
BUSINESS='6aa23c5dfe8649fd987eaba099046cc8fc67862b'
MIGRATION='20261018114000_store_pickup_enabled'
SQL_HASH='205ac6c3396db33bd97f77fe762ca81c3029c9a6cab8d430bbf4a3e467a665c0'
PROOF='docs/checkpoints/2026-10-18-store-pickup-live.json'
ENGINEERING={'scripts/deploy-prod-store-pickup.py','scripts/test-store-pickup-release.py','.github/workflows/release-build-only.yml',PROOF}
BASE_CONTROLLER_HASH='e4206fa68019770ef82a8a37c3359c75164d18a749f555f0e844c6eeada02e03'
require=m.require

def identity(repo,release):
    require(m.git(repo,'rev-parse','HEAD')==release and re.fullmatch('[0-9a-f]{40}',release) is not None,'PICKUP_EXACT_SHA_REQUIRED')
    require(m.git(repo,'branch','--show-current')=='codex/store-pickup-001-release','PICKUP_BRANCH_INVALID')
    require(not m.git(repo,'status','--porcelain','--untracked-files=all'),'WORKTREE_NOT_CLEAN')
    require(m.git(repo,'rev-parse',BUSINESS+'^')==BASE and m.is_ancestor(repo,BUSINESS,release) and release!=BUSINESS,'PICKUP_LINEAGE_INVALID')
    require(not m.git(repo,'rev-list','--merges',BUSINESS+'..'+release),'PICKUP_MERGE_UNREVIEWED')
    changes=set(m.git(repo,'diff','--name-only',BUSINESS,release).splitlines())
    history=set(m.git(repo,'log','--format=','--name-only',BUSINESS+'..'+release).splitlines())-{''}
    require(changes==ENGINEERING and history==ENGINEERING,'PICKUP_ENGINEERING_SCOPE_INVALID')
    require(m.digest((repo/'scripts/deploy-prod-transfer-cas.py').read_bytes())==BASE_CONTROLLER_HASH,'BASE_CONTROLLER_CHANGED')
    ledger={p.parent.name:m.digest(p.read_bytes()) for p in (repo/'prisma/migrations').glob('*/migration.sql')}
    old={Path(p).parent.name:m.digest(m.command(['git','-C',str(repo),'show',BASE+':'+p])) for p in m.git(repo,'ls-tree','-r','--name-only',BASE,'prisma/migrations').splitlines() if p.endswith('/migration.sql')}
    require(len(old)==88 and ledger=={**old,MIGRATION:SQL_HASH},'PICKUP_FULL_LEDGER_MISMATCH')
    sql=(repo/'prisma/migrations'/MIGRATION/'migration.sql').read_text();require(m.digest(sql.encode())==SQL_HASH,'PICKUP_SQL_CHANGED')
    proof=json.loads((repo/PROOF).read_text())
    require(m.digest((repo/PROOF).read_bytes())==PROOF_HASH and proof['sha']==BASE and proof['ledger']==old,'PICKUP_PROOF_CHANGED')
    m.configure_profile('post-transfer',BASE,BUSINESS,proof['runtimeHash'])
    return {'release':release,'ledger':ledger,'oldLedger':old,'sql':sql,'proof':proof,'helper':(repo/'scripts/clone-production-container.py').read_text()}

def schema(remote):
    return m.procurement_query(remote,"SELECT coalesce(json_agg(json_build_object('type',data_type,'nullable',is_nullable,'default',column_default)),'[]') FROM information_schema.columns WHERE table_schema='public' AND table_name='Store' AND column_name='pickup_enabled';")

def database(remote,v,phase):
    db=remote.db();expected=v['oldLedger'] if phase==88 else v['ledger']
    require(phase in (88,89) and db['database']==m.EXPECTED_DB and db['ledger']==expected and db['applied']==len(expected)==phase
            and db['failed']==db['rolledBack']==0 and db['pgVersion']=='16.14','PICKUP_DATABASE_CONTRACT')
    require(db.get('check')=={'validated':True,'definition':m.SHIPPING_CHECK_NEW} and db.get('invalidFacts')==0,'PICKUP_EXISTING_TRANSFER_CONSTRAINT')
    require(m.procurement_query(remote,m.PROCUREMENT_SCHEMA_SQL).get('schemaMd5')==m.procurement_contract()['schemaMd5'],'PICKUP_EXISTING_PROCUREMENT_SCHEMA')
    shape=schema(remote)
    require(shape==([] if phase==88 else [{'type':'boolean','nullable':'NO','default':'true'}]),'PICKUP_COLUMN_CONTRACT')
    return db

def rollback_eligible(remote,v):
    db=remote.db()
    database(remote,v,db['applied'])
    if db['applied']==88:return {'eligible':True,'activePickupDisabled':0,'columnRetained':False}
    count=m.procurement_query(remote,'SELECT count(*) FROM "Store" WHERE active=true AND pickup_enabled=false;')
    return {'eligible':count==0,'activePickupDisabled':count,'columnRetained':True}

def writer(remote,v,state,names,standby=False):
    rows=remote.containers()
    if standby:
        c=m.bg_lifecycle(remote,v,state,'standby');require(sum(x['Id']==c['Id'] for x in rows)==1,'BG_CANDIDATE_CHANGED');rows=[x for x in rows if x['Id']!=c['Id']]
    db=database(remote,v,state['phase']);m.writer_check(rows,db,names);return db

def mount_contract(c,proof):
    # Docker enumerates resolved Mounts in map order. Anchor the complete
    # unchanged HostConfig, then compare every resolved field without ordering.
    require(m.digest(json.dumps(c['HostConfig'],sort_keys=True).encode())==proof['resourcesHash'],'PICKUP_RESOURCES_CHANGED')
    host=c['HostConfig'];require(host.get('Binds') is None and isinstance(host.get('Mounts'),list),'PICKUP_MOUNT_CONTRACT')
    expected=[]
    for x in host['Mounts']:
        require(set(x)<= {'Type','Source','Target','ReadOnly'} and all(k in x for k in ['Type','Source','Target']),'PICKUP_MOUNT_OPTIONS_CHANGED')
        if x['Type']=='bind':
            expected.append({'Type':'bind','Source':x['Source'],'Destination':x['Target'],'Mode':'','RW':not x.get('ReadOnly',False),'Propagation':'rprivate'})
        elif x['Type']=='volume':
            require(re.fullmatch('[a-zA-Z0-9_.-]+',x['Source']) is not None,'PICKUP_VOLUME_IDENTITY')
            expected.append({'Type':'volume','Name':x['Source'],'Source':'/var/lib/docker/volumes/'+x['Source']+'/_data','Destination':x['Target'],'Driver':'local','Mode':'z','RW':not x.get('ReadOnly',False),'Propagation':''})
        else:raise m.GateError('PICKUP_MOUNT_TYPE_CHANGED')
    require(len({x['Destination'] for x in expected})==len(expected),'PICKUP_MOUNT_DUPLICATE')
    require(sorted(c['Mounts'],key=lambda x:x['Destination'])==sorted(expected,key=lambda x:x['Destination']),'PICKUP_MOUNTS_CHANGED')
    return {'count':len(expected),'unorderedIdentitySha256':m.digest(json.dumps(sorted(expected,key=lambda x:x['Destination']),sort_keys=True).encode()),'originalHostConfigHashMatched':True}

def old_guard(remote,v,phase=88):
    p=v['proof'];c=remote.inspect(p['container'])
    require(c['Id']==p['id'] and c['Image']==p['image'] and c['Config']['Labels']==p['labels']
            and m.env(c).get('GIT_SHA')==BASE and m.env(c).get('BUDU_RUNTIME_MODE')=='standby','PICKUP_OLD_IDENTITY')
    require(c['State']['Running'] and c['State'].get('Health',{}).get('Status')=='healthy','PICKUP_OLD_NOT_HEALTHY')
    t,a=remote.routes();require(t==a and m.digest(t.encode())==p['routeHash'] and m.route_target(t,a)==p['container'],'PICKUP_ROUTE_CHANGED')
    require(remote.run(['cat',m.CURRENT_SHA_FILE]).decode().strip()==BASE,'PICKUP_POINTER_CHANGED')
    remote.health(c['Id'],BASE);remote.health(c['Id'],BASE,True)
    h=json.loads(remote.run(['docker','exec',c['Id'],'wget','-qO-','http://127.0.0.1:3000/api/health']))
    require(h.get('runtimeMode')=='active' and h.get('appStartupTasksStarted')==h.get('processBackgroundTasksStarted')==1,'PICKUP_OLD_NOT_ACTIVE')
    m.application_db_probe(remote,c['Id'],'PICKUP_OLD_DB_PROBE')
    require(remote.run(['docker','exec',c['Id'],'sha256sum','/app/server/v2.js']).decode().split()[0]==p['runtimeHash'],'PICKUP_RUNTIME_CHANGED')
    mount_contract(c,p)
    db=writer(remote,v,{'phase':phase},[p['container']]);return c,db

def capacity(remote,v,phase,future):
    try:return m.bg_capacity(remote,v['art'],phase,future)
    except m.GateError:
        print(json.dumps({'stage':'CAPACITY_BLOCKED','capacityLedger':v['art'].get('capacityLedger'),'dfRaw':remote.run(['df','-Pk','/']).decode()}),flush=True)
        raise

def preflight(remote,v):
    c,db=old_guard(remote,v);m.validate_clone_source(c,v['art']['config'])
    m.mount_readability(remote,c['Id']);m.b1_storage(remote)
    lock=json.loads(remote.py("import json,pathlib; p=pathlib.Path('/run/lock/budu-transfer-cas-release'); print(json.dumps({'present':p.exists(),'symlink':p.is_symlink()}))"))
    require(lock=={'present':False,'symlink':False},'PICKUP_LOCK_PRESENT')
    root='/opt/budu/.rollback-assets/blue-green-'+v['release']
    require(remote.run(['test','!','-e',root])==b'','PICKUP_RELEASE_ROOT_EXISTS')
    limits=m.shipping_resources(db);v['limits']=limits
    future=sum(v['art'][k] for k in ('archive','blobs','expanded','largest'))+m.RESERVE+sum(limits.values())
    budget=capacity(remote,v,'PICKUP_PRE_IMPORT',future)
    return {'result':'PREFLIGHT_PASS','sha':v['release'],'old':v['proof']['sha'],'writer':1,'dbApplied':88,'dbFailed':0,'lockAbsent':True,
            'budget':budget,'capacityLedger':v['art']['capacityLedger'],'migrationLimits':limits,'dfRaw':remote.run(['df','-Pk','/']).decode()}

def migration_script(v):
    require(m.digest(v['sql'].encode())==SQL_HASH and v['ledger']=={**v['oldLedger'],MIGRATION:SQL_HASH} and len(v['oldLedger'])==88,'PICKUP_SQL_CONTRACT')
    old=json.dumps(v['oldLedger'],sort_keys=True).replace("'","''")
    return '''BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s';
LOCK TABLE "_prisma_migrations" IN SHARE ROW EXCLUSIVE MODE;
DO $pickup$ BEGIN
IF (SELECT count(*) FROM "_prisma_migrations")<>88 OR
 EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) OR
 (SELECT jsonb_object_agg(migration_name,checksum) FROM "_prisma_migrations") IS DISTINCT FROM 'REPLACE_LEDGER'::jsonb OR
 EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='Store' AND column_name='pickup_enabled')
THEN RAISE EXCEPTION 'PICKUP_LEDGER_OR_SCHEMA_CHANGED'; END IF; END $pickup$;
'''.replace('REPLACE_LEDGER',old)+v['sql']+"\nINSERT INTO \"_prisma_migrations\"(id,checksum,migration_name,finished_at,applied_steps_count) VALUES ('"+v['release'][:32]+"','"+SQL_HASH+"','"+MIGRATION+"',clock_timestamp(),1); COMMIT;\n"

PICKUP_MIGRATION_CODE=m.SHIPPING_BOUNDED_DUMP_CODE+r'''
import json,sys
v=json.load(sys.stdin);pg=json.loads(subprocess.check_output(['docker','inspect',v['pg']]))[0]
e=dict(x.split('=',1) for x in pg['Config']['Env']);user=e.get('POSTGRES_USER','postgres')
marker='budu_pickup_migrate_'+v['release'][:12];p=None
base=['docker','exec','-i','-e','PGOPTIONS=-c application_name='+marker,'-e','PGAPPNAME='+marker,v['pg'],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',user,'-d',v['database']]
result={'result':'FAIL','terminated':False,'transactionAtomic':True}
try:
 p=subprocess.Popen(base,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 out,err=p.communicate(v['transaction'].encode(),timeout=45)
 result.update(result='PASS' if p.returncode==0 else 'FAIL',returncode=p.returncode)
 if p.returncode:result['code']='PICKUP_MIGRATION_FAILED'
except BaseException as e:result['code']='PICKUP_MIGRATION_UNKNOWN';result['errorType']=type(e).__name__
finally:
 previous=signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGHUP,signal.SIGTERM,signal.SIGINT})
 try:
  if p is not None:stop_backup_process(p)
  cleanup=base.copy();cleanup[4]='PGOPTIONS=-c statement_timeout=8000 -c application_name='+marker+'_cleanup';cleanup[6]='PGAPPNAME='+marker+'_cleanup'
  predicate="datname='"+v['database']+"' AND application_name='"+marker+"' AND pid<>pg_backend_pid()"
  for sql in ['SELECT pg_terminate_backend(pid,5000) FROM pg_stat_activity WHERE '+predicate+';','SELECT count(*) FROM pg_stat_activity WHERE '+predicate+';']:
   r=subprocess.run(cleanup,input=sql.encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15);assert r.returncode==0
  assert r.stdout.strip()==b'0';result['terminated']=True
 except BaseException:result.update(result='FAIL',code='PICKUP_MIGRATION_TERMINATION_UNVERIFIED')
 finally:signal.pthread_sigmask(signal.SIG_SETMASK,previous)
print(json.dumps(result))
'''

def lock(remote,v,action,receipt=None):
    return m.bg_script(remote,m.BG_LOCK_CODE,{'path':m.LOCK,'action':action,'fresh':True,'stale':{'present':False,'openReferences':[]},'release':v['release'],'receipt':receipt})

def recover_old(remote,v):
    c=remote.inspect(v['proof']['id']);require(c['Image']==v['proof']['image'],'PICKUP_ROLLBACK_IMAGE_CHANGED')
    if not c['State']['Running']:remote.run(['docker','start',c['Id']])
    gv=dict(v,art={'release':BASE,'loadedDockerImageId':c['Image'],'imageReference':c['Config']['Image']})
    gs={'candidate':v['proof']['container'],'candidateId':c['Id'],'lifecycleSince':remote.inspect(c['Id'])['State']['StartedAt']}
    m.bg_lifecycle(remote,gv,gs,'standby');m.bg_promote(remote,gv,gs);m.bg_lifecycle(remote,gv,gs,'active')

def execute(remote,v,stream):
    state={'candidate':'budu-prod-'+v['release'][:12]+'-post-transfer','phase':88};stage='PREFLIGHT';owned=False;keep=True;result={}
    try:
        preflight(remote,v);g,db=old_guard(remote,v);state['g']=g
        receipt=lock(remote,v,'claim');owned=True
        root='/opt/budu/.rollback-assets/blue-green-'+v['release'];state['root']=root
        remote.py("import json,pathlib,sys,os;v=json.load(sys.stdin);os.umask(0o077);p=pathlib.Path(v['root']);p.mkdir(mode=0o700);(p/'manifest.json').write_text(json.dumps(v['manifest'],sort_keys=True))",{'root':root,'manifest':{'releaseSha':v['release'],'businessSha':BUSINESS,'migration':MIGRATION,'sqlHash':SQL_HASH,'rollback':v['proof']}})
        stage='IMPORT';imp=m.bg_import(stream,v['art'],root);v['art']['loadedDockerImageId']=m.resolve_loaded_image(remote,v['art'])['Id'];m.b2_barrier(remote,v['art'],imp,v['art']['capacityLedger'])
        capacity(remote,v,'PICKUP_IMPORTED',m.RESERVE+sum(v['limits'].values()))
        stage='PRISMA_PROBE'
        probe="import {PrismaClient,Prisma} from '@prisma/client';const f=Prisma.dmmf.datamodel.models.find(x=>x.name==='Store').fields.find(x=>x.name==='pickupEnabled');if(!f||f.dbName!=='pickup_enabled'||f.type!=='Boolean'||!f.isRequired)throw Error('PRISMA_PICKUP_FIELD');const p=new PrismaClient();try{await p.$queryRawUnsafe('SELECT 1');process.stdout.write('BG_PRE_MIGRATION_PROBE_OK\\n')}finally{await p.$disconnect()}"
        pr=m.bg_script(remote,m.BG_PROBE_CODE,{'old':g['Id'],'name':'budu-bg-probe-'+v['release'][:12],'release':v['release'],'image':v['art']['imageReference'],'imageId':v['art']['loadedDockerImageId'],'script':probe},60)
        require(pr.get('result')=='PASS' and pr.get('terminated') is True,'PICKUP_PRISMA_PROBE_UNVERIFIED')
        stage='SNAPSHOT_BACKUP';state['backupAttempted']=True
        b=m.bg_script(remote,m.BG_SNAPSHOT_CODE,{'root':root,'pg':m.PG,'database':m.EXPECTED_DB,'limits':v['limits'],'release':v['release'],'restore':'budu-bg-restore-'+v['release'][:12]});state['backup']=b
        require(b.get('result')=='PASS' and all(b.get(k) is True for k in ['backupTerminationVerified','exporterTerminated','dumpTerminated','restoreStopped','restoreProcessTerminated','restoreVerified']) and b['sourceSnapshotFingerprint']==b['restoredFingerprint'],'PICKUP_BACKUP_UNVERIFIED')
        old_guard(remote,v);capacity(remote,v,'PICKUP_BACKUP_RETAINED',m.RESERVE+v['limits']['walLimit']+v['limits']['migratorLimit'])
        stage='ATOMIC_PICKUP_MIGRATION';state['migrationAttempted']=True
        mig=m.bg_script(remote,PICKUP_MIGRATION_CODE,{'pg':m.PG,'database':m.EXPECTED_DB,'release':v['release'],'transaction':migration_script(v)},60);state['migration']=mig
        require(mig.get('result')=='PASS' and mig.get('terminated') is True,'PICKUP_MIGRATION_UNVERIFIED')
        state['phase']=89;old_guard(remote,v,89);capacity(remote,v,'PICKUP_DB89',m.RESERVE)
        stage='CANDIDATE';m.bg_clone(remote,v,state);name=state['candidate'];remote.health(name,v['release']);m.bg_lifecycle(remote,v,state,'standby')
        authority=m.mount_readability(remote,g['Id']);m.runtime_checks(remote,name,v['art']['runtimeHash'],authority);m.application_db_probe(remote,name,'PICKUP_CANDIDATE_DB_PROBE')
        sqlprobe="import {PrismaClient} from '@prisma/client';const p=new PrismaClient();try{await p.store.findMany({select:{key:true,pickupEnabled:true}});process.stdout.write('PICKUP_SCHEMA_OK\\n')}finally{await p.$disconnect()}"
        require(remote.run(['docker','exec','-e','PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=8000',name,'node','--input-type=module','-e',sqlprobe])==b'PICKUP_SCHEMA_OK\n','PICKUP_COLUMN_READ_FAILED')
        writer(remote,v,state,[v['proof']['container']],True);state['standbyVerified']=True
        t=v['template'];next_routes=t.replace('http://'+v['proof']['container']+':3000','http://'+name+':3000');require(next_routes.count('http://'+name+':3000')==3,'CUTOVER_ROUTE_COUNT_INVALID')
        stage='STOP_G';state['gStopAttempted']=True;remote.run(['docker','stop','--time','30',g['Id']]);require(not remote.inspect(g['Id'])['State']['Running'],'BG_G_STOP_UNVERIFIED')
        stage='ZERO_WRITER';writer(remote,v,state,[],True)
        stage='PROMOTION';m.bg_promote(remote,v,state);m.bg_lifecycle(remote,v,state,'active');writer(remote,v,state,[name])
        stage='CUTOVER';m.replace_routes(remote,next_routes,next_routes);remote.health(name,v['release'],True);m.application_db_probe(remote,name,'PICKUP_CANDIDATE_DB_PROBE');writer(remote,v,state,[name])
        require(m.route_target(*remote.routes())==name,'FINAL_ROUTE_CHANGED');capacity(remote,v,'PICKUP_FINAL',0)
        m.write_authority(remote,m.CURRENT_SHA_FILE,v['release']+'\n');require(remote.run(['cat',m.CURRENT_SHA_FILE]).decode().strip()==v['release'],'FINAL_POINTER_FAILED')
        require(not remote.inspect(g['Id'])['State']['Running'] and remote.inspect(g['Image'],image=True)['Id']==g['Image'],'ROLLBACK_ASSET_CHANGED')
        result={'result':'DEPLOY_COMPLETE','releaseSha':v['release'],'businessSha':BUSINESS,'dbApplied':89,'dbFailed':0,'writer':1,'runtimeMode':'active','route':name,'internalHealth':'PASS','publicHealth':'PASS','applicationDbProbe':'PASS','backup':b,'migration':mig,'oldStopped':True,'importReceipt':imp}
        saved=m.bg_script(remote,m.BG_EVIDENCE_CODE,{'root':root,'result':dict(result,capacityLedger=v['art'].get('capacityLedger'))});require(saved.get('result')=='PASS','EVIDENCE_UNVERIFIED');keep=False
    except BaseException as e:
        result={'result':'DEPLOY_BLOCKED','stage':stage,'code':str(e) if isinstance(e,m.GateError) else 'PICKUP_UNKNOWN','errorType':type(e).__name__}
        try:
            m.bg_owned_stop(remote,v,state)
            db=remote.db();state['phase']=db['applied'];database(remote,v,state['phase'])
            if state.get('gStopAttempted'):
                writer(remote,v,state,[]);r=rollback_eligible(remote,v);result['rollbackAdmission']=r
                if not r['eligible']:
                    # Never expose closed pickup locations via old code. Restore the new writer instead.
                    require(state.get('candidateId'),'ROLLBACK_PICKUP_INCOMPATIBLE')
                    remote.run(['docker','start',state['candidateId']]);state['lifecycleSince']=remote.inspect(state['candidateId'])['State']['StartedAt']
                    m.bg_lifecycle(remote,v,state,'standby');m.bg_promote(remote,v,state);m.bg_lifecycle(remote,v,state,'active')
                    route=v['template'].replace('http://'+v['proof']['container']+':3000','http://'+state['candidate']+':3000')
                    m.replace_routes(remote,route,route);m.write_authority(remote,m.CURRENT_SHA_FILE,v['release']+'\n');writer(remote,v,state,[state['candidate']]);remote.health(state['candidate'],v['release'],True)
                    result['recovery']='NEW_WRITER_RESTORED_OLD_ROLLBACK_DENIED';keep=True
                else:
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
    code+="\nv=json.loads(sys.stdin.buffer.readline())\nm.configure_profile('post-transfer',BASE,BUSINESS,v['proof']['runtimeHash'])\ndef interrupted(*a):raise m.GateError('PICKUP_INTERRUPTED')\nfor sig in (signal.SIGHUP,signal.SIGTERM,signal.SIGINT):signal.signal(sig,interrupted)\nprint(json.dumps(execute(m.LocalRemote(),v,sys.stdin.buffer)),flush=True)\n"
    return code

def completed(result,release):
    require(all(result.get(k)==x for k,x in {'result':'DEPLOY_COMPLETE','releaseSha':release,'dbApplied':89,'dbFailed':0,'writer':1,'runtimeMode':'active','internalHealth':'PASS','publicHealth':'PASS','applicationDbProbe':'PASS','oldStopped':True,'releaseLockReleased':True}.items()),'PICKUP_DEPLOY_NOT_COMPLETE')


def parse_execution(out,returncode,release):
    require(returncode==0,'PICKUP_TRANSPORT_UNKNOWN')
    try:records=[json.loads(line) for line in out.splitlines() if line.strip()]
    except (ValueError,UnicodeError):raise m.GateError('PICKUP_RECEIPT_INVALID') from None
    terminal=[x for x in records if isinstance(x,dict) and 'result' in x]
    require(len(terminal)==1 and records[-1] is terminal[0],'PICKUP_RECEIPT_INCOMPLETE')
    completed(terminal[0],release);return terminal[0]


def deploy(remote,v,archive,authorized):
    require(authorized==v['release'],'EXACT_RELEASE_AUTHORIZATION_REQUIRED')
    # One on-host controller owns mutations and failure recovery, as in existing BG flow.
    code=bootstrap_source()
    loader="import json,sys;exec(compile(json.loads(sys.stdin.buffer.readline()),'<budu-pickup>','exec'))"
    import shlex
    p=subprocess.Popen(remote.ssh+[shlex.join(['sudo','-n','python3','-u','-c',loader])],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    feed_error=False
    try:
        p.stdin.write(json.dumps(code).encode()+b'\n');p.stdin.write(json.dumps(v).encode()+b'\n')
        with open(archive,'rb') as src:
            for b in iter(lambda:src.read(1024**2),b''):p.stdin.write(b)
    except OSError:feed_error=True
    finally:
        try:p.stdin.close()
        except OSError:feed_error=True
        p.stdin=None
    try:out,err=p.communicate(timeout=1800)
    except subprocess.TimeoutExpired:
        # Stop only this local transport; remote ownership/recovery remains authoritative.
        p.kill();out,err=p.communicate();sys.stdout.buffer.write(out);sys.stdout.buffer.flush();sys.stderr.buffer.write(err);sys.stderr.buffer.flush()
        raise m.GateError('PICKUP_TRANSPORT_TIMEOUT_UNKNOWN') from None
    sys.stdout.buffer.write(out);sys.stdout.buffer.flush();sys.stderr.buffer.write(err);sys.stderr.buffer.flush()
    require(not feed_error,'PICKUP_TRANSPORT_WRITE_UNKNOWN')
    parse_execution(out,p.returncode,v['release'])

def main():
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['identity','inspect-artifact','preflight','deploy']);p.add_argument('--repo',type=Path,required=True);p.add_argument('--release-sha',required=True);p.add_argument('--archive',type=Path);p.add_argument('--ssh-key');p.add_argument('--authorize-release-sha');a=p.parse_args()
    v=identity(a.repo,a.release_sha)
    if a.mode=='identity':print(json.dumps({'result':'IDENTITY_PASS','sha':v['release'],'migration':MIGRATION,'sqlHash':SQL_HASH,'oldLedgerCount':88,'newLedgerCount':89}));return
    require(a.archive is not None,'ARCHIVE_REQUIRED');art=m.artifact(a.archive,a.release_sha,a.repo);art['capacityProfile']='STORE_PICKUP_FULL_L88_TO_L89';v['art']=art
    print(json.dumps({'stage':'ARTIFACT_METRICS','metrics':m.artifact_metrics(art)}),flush=True)
    if a.mode=='inspect-artifact':print(json.dumps({'result':'ARTIFACT_IDENTITY_PASS','archiveSha256':art['archiveHash'],'archiveBytes':art['archive'],'release':v['release']}));return
    require(a.ssh_key is not None,'SSH_REQUIRED');remote=m.Remote(a.ssh_key);v['template'],v['active']=remote.routes()
    if a.mode=='preflight':print(json.dumps(preflight(remote,v)));return
    deploy(remote,v,a.archive,a.authorize_release_sha)

if __name__=='__main__':
    try:main()
    except m.GateError as e:print(json.dumps({'result':'BLOCKED','code':str(e),'capacityTelemetry':m.CAPACITY_TELEMETRY}),flush=True);raise SystemExit(1)

#!/usr/bin/env python3
"""CI-only Prisma DB probe against local disposable PostgreSQL containers."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import tempfile
import signal
import threading
import contextlib
import io
import copy
import re
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('release', Path(__file__).with_name('deploy-prod-transfer-cas.py'))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
ROOT = Path(__file__).resolve().parent.parent

# Run inside the exact OLD application source/image. The three facts exercise
# legacy items and both physical units; all are synthetic isolated DB fixtures.
FIXTURE_JS = r'''
import assert from 'node:assert/strict';
import {prisma} from './server/pg.js';
try {
 await prisma.store.createMany({data:[{key:'guanshe',name:'CI sender'},{key:'tongying',name:'CI receiver'}]});
 await prisma.inventoryItem.createMany({data:[{id:'ci-material',name:'CI material',category:'material',transferEnabled:true},{id:'ci-box',name:'CI product',category:'product',transferEnabled:true}]});
 await prisma.user.create({data:{id:'ci-developer',username:'ci-developer',role:'developer',status:'active',passwordHash:'fixture_only_not_loginable'}});
 await prisma.$transaction(async tx=>{
 await tx.transferRequest.create({data:{id:'ci-over',purpose:'TEST',status:'shipped',fromStoreKey:'guanshe',toStoreKey:'tongying',createdBy:'CI',shippedBy:'CI',shippedAt:new Date('2026-10-02T00:00:00Z'),items:{create:[
  {id:'ci-legacy',itemId:'ci-material',quantity:4,quantityUnit:'legacy',shippedQuantity:2},
  {id:'ci-box-row',itemId:'ci-box',quantity:4,quantityUnit:'box',shippedQuantity:4,unitWeightGramsSnapshot:1500},
  {id:'ci-piece-row',itemId:'ci-box',quantity:4,quantityUnit:'piece',shippedQuantity:0,unitWeightGramsSnapshot:6}]}}});
 await tx.orderPurposeAudit.create({data:{id:'ci-purpose-audit',operationKey:'ci-purpose-audit',action:'CREATE_TEST',orderType:'transfer',orderId:'ci-over',orderNo:'ci-over',actorId:'ci-developer',actorRole:'developer',reason:'Isolated migration compatibility fixture',afterPurpose:'TEST',snapshot:{id:'ci-over',purpose:'TEST'},safety:{isolated:true,externalNotifications:'SUPPRESSED'},deletedCounts:{}}});
 });
 await assert.rejects(prisma.transferItem.update({where:{id:'ci-legacy'},data:{shippedQuantity:6}}));
 process.stdout.write('OLD_CHECK_FIXTURES_OK\n');
} finally {await prisma.$disconnect()}
'''

SNAPSHOT_JS = r'''
import {prisma} from './server/pg.js';import {createHash} from 'node:crypto';
try {
 const tables=await prisma.$queryRawUnsafe("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename");
 const facts=[];for(const {tablename} of tables){
  const rows=await prisma.$queryRawUnsafe('SELECT to_jsonb(t) row FROM "'+tablename.replaceAll('"','""')+'" t ORDER BY to_jsonb(t)::text');
  facts.push([tablename,rows.length,createHash('sha256').update(JSON.stringify(rows)).digest('hex')]);
 }
 const ledger=await prisma.$queryRawUnsafe('SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name');
 const check=(await prisma.$queryRawUnsafe(`SELECT convalidated,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='"TransferItem"'::regclass AND conname='TransferItem_shippedQuantity_valid'`))[0];
 const version=(await prisma.$queryRawUnsafe("SELECT current_setting('server_version') version"))[0].version;
 process.stdout.write(JSON.stringify({facts,ledger,check,version})+'\n');
}finally{await prisma.$disconnect()}
'''

PHASE_JS = r'''
import {prisma} from './server/pg.js';
try {
 const phase=await prisma.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  const rows=await tx.$queryRawUnsafe(`SELECT json_build_object(
   'database',current_database(),
   'applied',(SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
   'failed',(SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL),
   'rolledBack',(SELECT count(*) FROM _prisma_migrations WHERE rolled_back_at IS NOT NULL),
   'ledger',(SELECT json_object_agg(migration_name,checksum) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
   'check',(SELECT json_build_object('validated',convalidated,'definition',pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid='"TransferItem"'::regclass AND conname='TransferItem_shippedQuantity_valid'),
   'invalidFacts',(SELECT count(*) FROM "TransferItem" WHERE "shippedQuantity"<0 OR "shippedQuantity">999999),
   'clients',(SELECT coalesce(json_agg(distinct coalesce(host(client_addr),'LOCAL_SOCKET')),'[]') FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()),
   'pgVersion',current_setting('server_version'),'dbBytes',pg_database_size(current_database())) AS phase`);
  return rows[0].phase;
 });process.stdout.write(JSON.stringify(phase)+'\n');
}finally{await prisma.$disconnect()}
'''

OVER_FACTS_JS = r'''
import assert from 'node:assert/strict';import {prisma} from './server/pg.js';
try {for(const id of ['ci-legacy','ci-box-row','ci-piece-row']){
 await prisma.transferItem.update({where:{id},data:{shippedQuantity:6}});
 for(const value of [-1,1000000])await assert.rejects(prisma.transferItem.update({where:{id},data:{shippedQuantity:value}}));
}process.stdout.write('ACTUAL_6_PRESERVED_OK\n')}finally{await prisma.$disconnect()}
'''

OLD_COMPAT_JS = r'''
import assert from 'node:assert/strict';import express from 'express';import * as XLSX from 'xlsx';
import {prisma} from './server/pg.js';import {v2Router} from './server/v2.js';
import {buildTransferExportData,createTransferExportWorkbook} from './src/utils/storeTransferExport.js';
let server;try{
 const app=express();app.use((req,res,next)=>{req.user={username:'CI',role:'manager',storeKeys:['guanshe']};next()});app.use('/api/v2',v2Router);
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/v2/transfer-requests?status=shipped');assert.equal(response.status,200);
 const {rows}=await response.json();const record=rows.find(row=>row.id==='ci-over');assert.ok(record);
 const material=record.items.find(row=>row.itemId==='ci-material');const product=record.items.find(row=>row.itemId==='ci-box');
 assert.equal(material.quantity,4);assert.equal(material.shippedQuantity,6);
 assert.equal(product.boxQuantity,4);assert.equal(product.pieceQuantity,4);assert.equal(product.shippedBoxQuantity,6);assert.equal(product.shippedPieceQuantity,6);
 const data=buildTransferExportData([record]);assert.equal(data.detailRows.find(row=>row.名称==='CI material')['申请数量（件）'],4);assert.equal(data.detailRows.find(row=>row.名称==='CI material')['实发数量（件）'],6);
 assert.equal(record.storeKey,'tongying');assert.equal(record.fromStoreKey,'guanshe');assert.ok(record.storeName);
 assert.equal(data.summaryRows.find(row=>row.门店===record.storeName&&row.名称==='CI material').调入数量,6);
 assert.equal(data.summaryRows.find(row=>row.门店===record.storeName&&row.名称==='CI product').调入箱数,6);
 assert.equal(data.summaryRows.find(row=>row.门店===record.storeName&&row.名称==='CI product').调入散颗数,6);
 const {workbook}=createTransferExportWorkbook([record]);const encoded=XLSX.write(workbook,{type:'buffer',bookType:'xlsx'});const decoded=XLSX.read(encoded,{type:'buffer'});
 const details=XLSX.utils.sheet_to_json(decoded.Sheets['调拨明细']);assert.equal(details.find(row=>row.名称==='CI material')['实发数量（件）'],6);
 assert.equal(details.find(row=>row.名称==='CI product').实发箱数,6);assert.equal(details.find(row=>row.名称==='CI product').实发散颗数,6);
 assert.ok(decoded.Sheets['调拨汇总']);assert.equal(await prisma.transferItem.count({where:{shippedQuantity:6}}),3);
 process.stdout.write('OLD_APP_HTTP_SUMMARY_XLSX_ACTUAL6_OK\n');
}finally{if(server)await new Promise(resolve=>server.close(resolve));await prisma.$disconnect()}
'''


def validate_snapshots(before, after):
    if (before['version'].split()[0] != '16.14' or after['version'].split()[0] != '16.14'
            or before['facts'] != after['facts'] or len(before['ledger']) != 85 or len(after['ledger']) != 86):
        raise RuntimeError('PG16_FULL_MIGRATION_FACTS_FAILED')
    expected = {p.parent.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'prisma/migrations').glob('*/migration.sql')}
    for snapshot, names in ((before,set(expected)-{release.SHIPPING_MIGRATION}),(after,set(expected))):
        rows=snapshot['ledger']
        if set(row['migration_name'] for row in rows)!=names or any(not row['finished_at'] or row['rolled_back_at'] or row['checksum']!=expected[row['migration_name']] for row in rows):
            raise RuntimeError('PG16_FULL_LEDGER_FAILED')
    if before['check'] != {'convalidated':True,'definition':release.SHIPPING_CHECK_OLD} or after['check'] != {'convalidated':True,'definition':release.SHIPPING_CHECK_NEW}:
        raise RuntimeError('PG16_FULL_CHECK_FAILED')


def native_pg16():
    """Optional local proof: exact source trees, pinned CLI and owned loopback DBs."""
    admin=os.environ.get('TEST_DATABASE_URL',''); parsed=urlsplit(admin)
    bindir=Path(os.environ['TEST_SHIPPING_PG16_BIN'])
    if (os.environ.get('TEST_SHIPPING_PG16_NATIVE')!='1' or parsed.hostname not in ('127.0.0.1','localhost')
            or parsed.path != '/postgres' or parsed.scheme not in ('postgresql','postgres')):
        raise RuntimeError('NATIVE_ISOLATED_PG16_REQUIRED')
    def checked(args, data=None, cwd=ROOT, env=None):
        result=subprocess.run(args,input=data,cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=300)
        if result.returncode:raise RuntimeError('NATIVE_PG16_COMMAND_FAILED')
        return result.stdout
    if checked([str(bindir/'postgres'),'--version']).decode().strip()!='postgres (PostgreSQL) 16.14':raise RuntimeError('NATIVE_PG16_VERSION')
    cli=ROOT/'node_modules/prisma/build/index.js'
    locked=json.loads((ROOT/'package-lock.json').read_text())['packages']['node_modules/prisma']['version']
    installed=json.loads((ROOT/'node_modules/prisma/package.json').read_text())['version']
    if locked!='6.19.3' or installed!=locked or cli.is_symlink() or not cli.is_file():raise RuntimeError('NATIVE_PINNED_PRISMA_CLI_FAILED')
    base='shipping_pg16_'+str(os.getpid()); names=(base,base+'_restore',base+'_gap')
    def sql(database,text):return checked([str(bindir/'psql'),admin.rsplit('/',1)[0]+'/'+database,'-X','-qAt','-v','ON_ERROR_STOP=1'],text.encode())
    with tempfile.TemporaryDirectory(prefix='shipping-pg16-proof-') as directory:
        work=Path(directory);old=work/'old';old.mkdir()
        archive=checked(['git','archive',release.SHIPPING_OLD_SHA]);checked(['tar','-x','-C',str(old)],archive)
        (old/'node_modules').symlink_to(ROOT/'node_modules',target_is_directory=True)
        created=[]
        url=admin.rsplit('/',1)[0]+'/'+base
        def js(code,database=base):
            return checked(['node','--input-type=module','-'],code.encode(),old,{**os.environ,'APP_ENV':'test','NODE_ENV':'test','DATABASE_URL':admin.rsplit('/',1)[0]+'/'+database})
        def migrate(schema,database=base):
            checked(['node',str(cli),'migrate','deploy','--schema',str(schema)],env={**os.environ,'DATABASE_URL':admin.rsplit('/',1)[0]+'/'+database})
        # Only this native test's imported module uses its OWNED loopback DB as
        # authority. No deployment input or production count override is added.
        release.configure_profile('post-transfer',release.SHIPPING_OLD_SHA,release.SHIPPING_BUSINESS_SHA,
                                  hashlib.sha256((old/'server/v2.js').read_bytes()).hexdigest())
        expected={p.parent.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'prisma/migrations').glob('*/migration.sql')}
        baseline=release.before_ledger(expected);failures=[]
        def phase(database,ledger,rejected=None):
            previous_db=release.EXPECTED_DB
            try:
                release.EXPECTED_DB=database
                observed=json.loads(js(PHASE_JS,database))
                try:release.validate_database(observed,ledger)
                except release.GateError as error:
                    if str(error)!=rejected:raise RuntimeError('NATIVE_PHASE_REJECTION_CODE_INVALID') from None
                    failures.append({'databaseSuffix':database.removeprefix(base),'rejection':str(error)})
                else:
                    if rejected:raise RuntimeError('NATIVE_PHASE_NOT_CLOSED')
            finally:release.EXPECTED_DB=previous_db
        try:
            for name in names:
                sql('postgres','CREATE DATABASE "'+name+'";');created.append(name)
            migrate(old/'prisma/schema.prisma');js(FIXTURE_JS)
            phase(base,baseline)
            before=json.loads(js(SNAPSHOT_JS));dump=work/'L85.dump'
            dump.write_bytes(checked([str(bindir/'pg_dump'),url,'-Fc','--no-owner','--no-acl']));dump.chmod(0o600)
            for target in names[1:]:
                checked([str(bindir/'pg_restore'),'--dbname',admin.rsplit('/',1)[0]+'/'+target,'--exit-on-error','--no-owner','--no-acl',str(dump)])
                if json.loads(js(SNAPSHOT_JS,target))!=before:raise RuntimeError('NATIVE_RESTORE_PROOF_FAILED')
            migrate(ROOT/'prisma/schema.prisma');after=json.loads(js(SNAPSHOT_JS));validate_snapshots(before,after)
            phase(base,expected)
            js(OVER_FACTS_JS);js(OLD_COMPAT_JS)
            # Old CHECK cannot be restored over actual 6. Failure is SQLSTATE
            # 23514, and the whole transaction must leave L86 and all facts intact.
            overship=json.loads(js(SNAPSHOT_JS))
            reverse='BEGIN; ALTER TABLE "TransferItem" DROP CONSTRAINT "TransferItem_shippedQuantity_valid"; ALTER TABLE "TransferItem" ADD CONSTRAINT "TransferItem_shippedQuantity_valid" '+release.SHIPPING_CHECK_OLD+'; COMMIT;'
            rejected=subprocess.run([str(bindir/'psql'),url,'-X','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate'],input=reverse.encode(),capture_output=True,timeout=30)
            if rejected.returncode==0 or b'23514' not in rejected.stderr or json.loads(js(SNAPSHOT_JS))!=overship:
                raise RuntimeError('NATIVE_REVERSE_CHECK_DID_NOT_PRESERVE_ACTUAL6')
            phase(base,expected);js(OLD_COMPAT_JS)
            # Simulate the actual SQL-commit/ledger gap in a separate restored DB.
            sql(names[2],(ROOT/'prisma/migrations'/release.SHIPPING_MIGRATION/'migration.sql').read_text())
            gap=json.loads(js(SNAPSHOT_JS,names[2]))
            if len(gap['ledger'])!=85 or gap['check']['definition']!=release.SHIPPING_CHECK_NEW:raise RuntimeError('NATIVE_GAP_FIXTURE_FAILED')
            phase(names[2],baseline,'SHIPPING_DATABASE_PHASE_INVALID')
            phase(names[2],expected,'MIGRATION_LEDGER_INVALID')
            sql(names[2],"INSERT INTO _prisma_migrations(id,checksum,migration_name,started_at,applied_steps_count) VALUES ('native-unfinished','"+release.SHIPPING_SQL_HASH+"','"+release.SHIPPING_MIGRATION+"',now(),0);")
            phase(names[2],expected,'MIGRATION_LEDGER_INVALID')
            migrate(ROOT/'prisma/schema.prisma',names[1])
            sql(names[1],"UPDATE _prisma_migrations SET checksum='"+'f'*64+"' WHERE migration_name='"+release.SHIPPING_MIGRATION+"';")
            phase(names[1],expected,'MIGRATION_CHECKSUM_MISMATCH')
            # Real no-output PG client and a real SIGTERM exercise the SAME
            # bounded dump function. Only the test's own marker connections end.
            cancellation=[]
            for mode in ('deadline','signal'):
                marker='native_shipping_backup_'+str(os.getpid())+'_'+mode
                target=url+'?application_name='+marker
                previous_handler=signal.getsignal(signal.SIGTERM);timer=None
                def interrupted(*_):raise release.GateError('INTERRUPTED')
                try:
                    if mode=='signal':
                        signal.signal(signal.SIGTERM,interrupted)
                        timer=threading.Timer(0.3,lambda:os.kill(os.getpid(),signal.SIGTERM));timer.start()
                    try:
                        release.bounded_backup_dump([str(bindir/'psql'),target,'-X','-qAt','-c','SELECT pg_sleep(60)'],
                            work/('cancel-'+mode+'.dump'),1024,time.monotonic()+(0.4 if mode=='deadline' else 5))
                    except TimeoutError:
                        if mode!='deadline':raise
                    except release.GateError as error:
                        if mode!='signal' or str(error)!='INTERRUPTED':raise
                    else:raise RuntimeError('NATIVE_BACKUP_CANCEL_DID_NOT_OCCUR')
                finally:
                    if timer:timer.cancel();timer.join(timeout=1)
                    signal.signal(signal.SIGTERM,previous_handler)
                    predicate="datname='"+base+"' AND application_name='"+marker+"' AND pid<>pg_backend_pid()"
                    sql('postgres','SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE '+predicate+';')
                    if sql('postgres','SELECT count(*) FROM pg_stat_activity WHERE '+predicate+';').strip()!=b'0':
                        raise RuntimeError('NATIVE_BACKUP_CONNECTION_UNVERIFIED')
                phase(base,expected);cancellation.append({'mode':mode,'childAndConnectionsTerminated':True})
            output={'pgVersion':'16.14','oldSourceSha':release.SHIPPING_OLD_SHA,'migrationsBefore':85,'migrationsAfter':86,
                    'sqlSha256':release.SHIPPING_SQL_HASH,'tableFingerprints':before['facts'],'actualOldHttpSummaryExcel':'PASS',
                    'isolatedDumpRestore':'PASS','sqlCommitLedgerGap':'OBSERVED','backupBytes':dump.stat().st_size,
                    'realPhaseRejections':failures,'reverseCheckAtomicPreservation':'PASS','realBackupCancellation':cancellation,
                    'pinnedLocalCliVersion':installed,'pinnedLocalCliSha256':hashlib.sha256(cli.read_bytes()).hexdigest(),
                    'finalLinuxArtifactValidated':False}
            print(json.dumps(output,sort_keys=True))
        finally:
            cleanup_errors=[]
            for name in reversed(created):
                try:sql('postgres','DROP DATABASE "'+name+'" WITH (FORCE);')
                except Exception:cleanup_errors.append(name)
            if cleanup_errors:raise RuntimeError('NATIVE_OWNED_DATABASE_CLEANUP_FAILED')


def docker(*args, timeout=30):
    result = subprocess.run(['docker', *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError('ISOLATED_DOCKER_COMMAND_FAILED')
    return result.stdout.decode().strip()


class LocalDocker:
    def run(self, args, data=None, timeout=60):
        if args[0] != 'docker' or data is not None:
            raise RuntimeError('ISOLATED_PROBE_COMMAND_INVALID')
        try:
            result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise release.GateError('COMMAND_UNAVAILABLE_OR_TIMEOUT') from None
        if result.returncode:
            raise release.GateError('COMMAND_FAILED')
        return result.stdout


def shipping_pg16_ci(image, old_image, network, pg, fixture_url):
    if os.environ.get('GITHUB_REF') != 'refs/heads/'+release.SHIPPING_BRANCH:
        raise RuntimeError('SHIPPING_CI_BRANCH_REQUIRED')
    for tag, sha in ((image,os.environ['GITHUB_SHA']),(old_image,release.SHIPPING_OLD_SHA)):
        config=json.loads(docker('image','inspect',tag))[0]
        if config['Config']['Labels'][release.REVISION]!=sha or config['Os']!='linux' or config['Architecture']!='amd64':
            raise RuntimeError('SHIPPING_CI_IMAGE_IDENTITY_FAILED')
        if docker('run','--rm','--network','none','--entrypoint','node',tag,'-e',release.SHIPPING_CLI_PROBE)!='PINNED_PRISMA_CLI_OK':
            raise RuntimeError('SHIPPING_CI_PINNED_CLI_FAILED')
    def node(tag,code,url=fixture_url):
        return docker('run','--rm','--network',network,'-e','DATABASE_URL='+url,
                      '-e','NODE_ENV=test','-e','APP_ENV=test','--entrypoint','node',tag,
                      '--input-type=module','-e',code,timeout=180)
    def migrate(tag):
        docker('run','--rm','--network',network,'-e','DATABASE_URL='+fixture_url,'--entrypoint','node',tag,
               '/app/node_modules/prisma/build/index.js','migrate','deploy','--schema','/app/prisma/schema.prisma',timeout=180)
    migrate(old_image);node(old_image,FIXTURE_JS)
    before=json.loads(node(old_image,SNAPSHOT_JS))
    result=subprocess.run(['docker','exec',pg,'pg_dump','-U','postgres','-d','probe_fixture','-Fc','--no-owner','--no-acl'],capture_output=True,timeout=180)
    if result.returncode:raise RuntimeError('SHIPPING_CI_DUMP_FAILED')
    backup=result.stdout
    for name in ('probe_restore','probe_gap'):
        docker('exec',pg,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres','-c','CREATE DATABASE '+name)
        restored=subprocess.run(['docker','exec','-i',pg,'pg_restore','-U','postgres','-d',name,'--exit-on-error','--no-owner','--no-acl'],input=backup,capture_output=True,timeout=180)
        if restored.returncode or json.loads(node(old_image,SNAPSHOT_JS,fixture_url.rsplit('/',1)[0]+'/'+name))!=before:
            raise RuntimeError('SHIPPING_CI_RESTORE_FAILED')
    migrate(image);after=json.loads(node(old_image,SNAPSHOT_JS));validate_snapshots(before,after)
    node(image,OVER_FACTS_JS)
    # Old source performs a real HTTP read, summary and serialized XLSX roundtrip.
    # It sees and preserves actual 6 against immutable requested 4 after rollback.
    node(old_image,OLD_COMPAT_JS)
    gap=subprocess.run(['docker','exec','-i',pg,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','probe_gap'],
                       input=(ROOT/'prisma/migrations'/release.SHIPPING_MIGRATION/'migration.sql').read_bytes(),capture_output=True,timeout=60)
    snapshot=json.loads(node(old_image,SNAPSHOT_JS,fixture_url.rsplit('/',1)[0]+'/probe_gap'))
    if gap.returncode or len(snapshot['ledger'])!=85 or snapshot['check']['definition']!=release.SHIPPING_CHECK_NEW:
        raise RuntimeError('SHIPPING_CI_COMMIT_LEDGER_GAP_FAILED')
    print('PG16_FULL_MIGRATION=PASS L85_TO_L86=PASS EXACT_SQL_CHECKSUM=PASS BACKUP_RESTORE=PASS OLD_APP_HTTP_SUMMARY_XLSX_ACTUAL6=PASS COMMIT_LEDGER_GAP=OBSERVED')


def controller_ci_guard():
    # This is a test entrypoint, never a deployment adapter or SSH target.
    if (os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_OS') != 'Linux'
            or sys.platform != 'linux' or os.geteuid() != 0
            or os.environ.get('GITHUB_REPOSITORY') != 'GPTJJ/budu'
            or os.environ.get('GITHUB_REF') != 'refs/heads/'+release.SHIPPING_BRANCH
            or os.environ.get('TEST_SHIPPING_CONTROLLER_CI') != '1'
            or os.environ.get('DOCKER_HOST') not in (None, 'unix:///var/run/docker.sock')
            or os.environ.get('DOCKER_CONTEXT') or not os.environ.get('RUNNER_TEMP')):
        raise RuntimeError('SHIPPING_CONTROLLER_ISOLATED_LINUX_CI_REQUIRED')


class ControllerCiRemote(release.LocalRemote):
    """Real local Docker/PG/files, with explicitly labelled CI infrastructure.

    execute_loaded, backup helper, migrator, rollback, writer gates, application
    runtime/DB probes and route replacement are NOT mocked. Production host
    storage metadata and Docker's automatic fixture DNS aliases are adapters;
    neither is production admission evidence. Disk bytes are real except for
    the one labelled post-L86 insufficient-space injection.
    """
    def __init__(self, root, network, old, candidate, mode):
        self.root=Path(root);self.network=network;self.old=old;self.candidate=candidate;self.mode=mode
        self.events=[];self.writer_samples=[];self.disk_samples=[];self.host_storage=None
        self.alias_adaptations=[];self.migrator_started=False;self.injected=False

    def run(self, args, data=None, timeout=60):
        if args and args[0] in ('ssh','scp','curl'):
            raise RuntimeError('CI_EXTERNAL_TARGET_FORBIDDEN')
        result=super().run(args,data,timeout)
        if args == ['docker','info','--format','{{json .}}']:
            info=json.loads(result)
            self.host_storage={k:info.get(k) for k in ('ServerVersion','Driver','DockerRootDir','DriverStatus')}
            info.update(ServerVersion='29.1.3',Driver='overlayfs',DockerRootDir='/var/lib/docker',
                        DriverStatus=[['driver-type','io.containerd.snapshotter.v1']])
            return json.dumps(info).encode()
        if args[:2] in (['docker','stop'],['docker','start']):
            self.events.append({'action':args[1],'container':args[-1]})
            if args[1]=='start' and args[-1]=='budu-shipping-migrator-'+os.environ['GITHUB_SHA'][:12]:
                self.migrator_started=True
        return result

    def inspect(self, name, image=False):
        value=super().inspect(name,image)
        if not image and name==self.old:
            value=copy.deepcopy(value)
            for key,endpoint in value['NetworkSettings']['Networks'].items():
                aliases=endpoint.get('Aliases') or []
                if key!=self.network or set(aliases)-{self.old,value['Id'][:12]}:
                    raise RuntimeError('CI_UNEXPECTED_NETWORK_ALIAS')
                if aliases:self.alias_adaptations.append(aliases)
                endpoint['Aliases']=None
        return value

    def py(self, code, value=None, timeout=60):
        if value and 'root' in value:
            expected='/opt/budu/.rollback-assets/'+release.ROLLBACK_PREFIX+os.environ['GITHUB_SHA']
            if value['root']!=expected:raise RuntimeError('CI_ROLLBACK_PATH_ESCAPE')
            value={**value,'root':str(self.root/'rollback'/Path(expected).name)}
        if code==release.SHIPPING_BACKUP_RESTORE_CODE and self.mode=='backup_limit':
            value={**value,'limits':{**value['limits'],'backupLimit':16}}
            self.injected=True
        return super().py(code,value,timeout)

    def containers(self):
        objects=super().containers()
        writers=release.writer_names(objects)
        if len(writers)>1:raise RuntimeError('CI_MULTIPLE_REAL_APP_OR_MIGRATOR_WRITERS')
        self.writer_samples.append(writers)
        return objects

    def disk(self):
        actual=super().disk();sample={'used':actual[0],'available':actual[1],'injected':False}
        if self.mode=='post_l86_disk' and self.migrator_started:
            db=super().db()
            if db['applied']==86 and db['failed']==0:
                if not self.injected:
                    docker('exec',release.PG,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d',release.EXPECTED_DB,
                           '-c','UPDATE "TransferItem" SET "shippedQuantity"=6 WHERE id IN (\'ci-legacy\',\'ci-box-row\',\'ci-piece-row\')')
                sample['injected']=True;self.injected=True
                self.disk_samples.append(sample)
                return actual[0],1024**2
        self.disk_samples.append(sample)
        return actual

    def health(self, name, sha, public=False):
        if not public:return super().health(name,sha)
        # A real local Nginx HTTP request; no public production URL or host port.
        for _ in range(20):
            try:
                h=json.loads(self.run(['docker','exec',release.NGINX,'wget','-qO-',
                                      'http://127.0.0.1/api/health'],timeout=10))
                if h.get('ok') is True and h.get('dbOk') is True and h.get('gitSha') in (sha,sha[:12]):
                    if self.mode=='post_cutover_failure' and name==self.candidate and not self.injected:
                        docker('exec','-w','/app',name,'node','--input-type=module','-e',OVER_FACTS_JS)
                        self.injected=True
                        raise release.GateError('HEALTH_FAILED')
                    return
            except (ValueError,release.GateError):
                if self.injected:raise
            time.sleep(0.25)
        raise release.GateError('HEALTH_FAILED')


def shipping_controller_ci(image,old_image,archive):
    controller_ci_guard()
    # Root is needed by the SAME backup helper to inspect the restore's 0700
    # postgres-owned files. Git trust is process-scoped, including direct ancestry
    # subprocesses in identity(); no global/local Git config is changed.
    git_keys=('GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0')
    git_before={key:os.environ.get(key) for key in git_keys}
    os.environ.update(GIT_CONFIG_COUNT='1',GIT_CONFIG_KEY_0='safe.directory',GIT_CONFIG_VALUE_0=str(ROOT))
    release.configure_profile('post-transfer',release.SHIPPING_OLD_SHA,release.SHIPPING_BUSINESS_SHA,
        hashlib.sha256(release.command(['git','-c','safe.directory='+str(ROOT),'-C',str(ROOT),
                                       'show',release.SHIPPING_OLD_SHA+':server/v2.js'])).hexdigest())
    identity,ledger=release.identity(ROOT);sha=os.environ['GITHUB_SHA']
    if identity!=sha or image!=release.image_reference(sha):raise RuntimeError('CI_EXACT_SOURCE_REQUIRED')
    old_config=json.loads(docker('image','inspect',old_image))[0]
    if (old_image!='budu-api:shipping-old-68cee84efe30' or old_config['Config'].get('Labels',{}).get(release.REVISION)!=release.SHIPPING_OLD_SHA
            or old_config['Os']!='linux' or old_config['Architecture']!='amd64'):
        raise RuntimeError('CI_EXACT_OLD_IMAGE_REQUIRED')
    for tag in (image,old_image):
        if docker('run','--rm','--network','none','--entrypoint','node',tag,'-e',release.SHIPPING_CLI_PROBE)!='PINNED_PRISMA_CLI_OK':
            raise RuntimeError('CI_REAL_PINNED_PRISMA_CLI_REQUIRED')
    art=release.artifact(archive,sha,ROOT)
    ledger={p.parent.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'prisma/migrations').glob('*/migration.sql')}
    helper=(ROOT/'scripts/clone-production-container.py').read_text()
    cases=[]
    with tempfile.TemporaryDirectory(prefix='shipping-controller-',dir=os.environ['RUNNER_TEMP']) as directory:
        root=Path(directory);root.chmod(0o700)
        suffix=root.name.removeprefix('shipping-controller-');network='shipping-ci-net-'+suffix;pg='shipping-ci-pg-'+suffix
        database='shipping_ci_'+suffix.replace('-','_');url='postgresql://postgres:fixture_only@'+pg+':5432/'+database
        globals_before={key:getattr(release,key) for key in ('PG','EXPECTED_DB','NGINX','TEMPLATE','CURRENT_SHA_FILE','LOCK')}
        release.PG=pg;release.EXPECTED_DB=database
        owned={};reserved=set();network_id=None
        def remove_owned(name):
            if not docker('ps','-aq','--filter','name=^/'+name+'$'):return
            current=json.loads(docker('inspect',name))[0]
            if name in owned:
                if current['Id']!=owned[name]:raise RuntimeError('CI_CLEANUP_OWNERSHIP_CHANGED')
            elif name.startswith('budu-shipping-restore-'):
                if (current['Config'].get('Labels',{}).get('budu.shipping-restore')!=sha
                        or not any(m.get('Source','').startswith(str(root)+'/') for m in current['Mounts'])):
                    raise RuntimeError('CI_RESTORE_CLEANUP_OWNERSHIP_INVALID')
            elif (name not in reserved or current['HostConfig']['NetworkMode']!=network
                  or current['Config'].get('Labels',{}).get(release.REVISION)!=sha
                  or current['Image']!=art.get('loadedDockerImageId')):
                raise RuntimeError('CI_APP_MIGRATOR_CLEANUP_OWNERSHIP_INVALID')
            # ID protects against a name race; -v removes only its anonymous volumes.
            docker('rm','-f','-v',current['Id'])
        try:
            network_id=docker('network','create','--internal',network)
            if json.loads(docker('network','inspect',network))[0]['Internal'] is not True:raise RuntimeError('CI_NETWORK_EGRESS_NOT_BLOCKED')
            owned[pg]=docker('run','-d','--name',pg,'--network',network,'-e','POSTGRES_PASSWORD=fixture_only','postgres:16.14',timeout=180)
            for _ in range(60):
                ready=subprocess.run(['docker','exec',pg,'pg_isready','-U','postgres'],capture_output=True,timeout=5)
                if ready.returncode==0:break
                time.sleep(0.25)
            else:raise RuntimeError('CI_POSTGRES_NOT_READY')
            docker('pull','nginx:1.28-alpine',timeout=180)
            for index,mode in enumerate(('success','post_cutover_failure','post_l86_disk','backup_limit')):
                case_root=root/str(index);case_root.mkdir(mode=0o700);(case_root/'rollback').mkdir(mode=0o700)
                old='shipping-ci-old-'+suffix;nginx='shipping-ci-nginx-'+suffix
                candidate='budu-prod-'+sha[:12]+release.CONTAINER_SUFFIX
                migrator='budu-shipping-migrator-'+sha[:12];restore='budu-shipping-restore-'+sha[:12]
                names=(old,nginx,candidate,migrator,restore)
                for name in names:
                    if docker('ps','-aq','--filter','name=^/'+name+'$'):raise RuntimeError('CI_OWNED_NAME_EXISTS')
                reserved.update((candidate,migrator,restore))
                release.NGINX=nginx;release.TEMPLATE=str(case_root/'template');release.CURRENT_SHA_FILE=str(case_root/'current-sha');release.LOCK=str(case_root/'lock')
                docker('exec',pg,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-c','CREATE DATABASE '+database)
                docker('run','--rm','--network',network,'-e','DATABASE_URL='+url,'--entrypoint','node',old_image,
                       '/app/node_modules/prisma/build/index.js','migrate','deploy','--schema','/app/prisma/schema.prisma',timeout=180)
                docker('run','--rm','--network',network,'-e','DATABASE_URL='+url,'-e','APP_ENV=test','--entrypoint','node',old_image,
                       '--input-type=module','-e',FIXTURE_JS)
                data=case_root/'data';data.mkdir(mode=0o700);os.chown(data,1000,1000)
                routes='server { listen 80; location / { proxy_pass http://'+old+':3000; } location /api/ { proxy_pass http://'+old+':3000; } location /health-proxy { proxy_pass http://'+old+':3000; } }\n'
                (case_root/'template').write_text(routes);(case_root/'current-sha').write_text(release.SHIPPING_OLD_SHA+'\n')
                conf=case_root/'conf';conf.mkdir();(conf/'budu.conf').write_text(routes)
                owned[old]=docker('create','--name',old,'--network',network,'--restart','unless-stopped','--log-driver','json-file',
                       '--label','budu.production-role=candidate','--label',release.REVISION+'='+release.SHIPPING_OLD_SHA,
                       '-e','DATABASE_URL='+url,'-e','APP_ENV=test','-e','DATA_STORE=file','-e','DATA_DIR=/app/server/data',
                       '-e','WECHAT_PAY_ENABLED=0','-e','ALIPAY_ENABLED=0','-e','GIT_SHA='+release.SHIPPING_OLD_SHA,
                       '-e','CUSTOMER_REQUEST_WECOM_RECIPIENT_USERNAME=budu','-e','CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID=dh',
                       '--mount','type=bind,source='+str(data)+',target=/app/server/data',old_image)
                docker('start',old)
                for _ in range(150):
                    info=json.loads(docker('inspect',old))[0]
                    if info['State'].get('Health',{}).get('Status')=='healthy':break
                    if not info['State']['Running']:raise RuntimeError('CI_REAL_OLD_APP_START_FAILED')
                    time.sleep(0.5)
                else:raise RuntimeError('CI_REAL_OLD_APP_NOT_HEALTHY')
                owned[nginx]=docker('run','-d','--name',nginx,'--network',network,'--mount','type=bind,source='+str(conf)+',target=/etc/nginx/conf.d',
                                   'nginx:1.28-alpine')
                remote=ControllerCiRemote(case_root,network,old,candidate,mode)
                release.application_db_probe(remote,old,'ROLLBACK_APPLICATION_DB_PROBE_FAILED')
                art['loadedDockerImageId']=release.resolve_loaded_image(remote,art)['Id']
                (case_root/'lock').mkdir(mode=0o700)
                expected={'post_cutover_failure':('PUBLIC_HEALTH','HEALTH_FAILED'),
                          'post_l86_disk':('SHIPPING_CHECK_MIGRATION','SHIPPING_MIGRATION_DISK_GATE_FAILED'),
                          'backup_limit':('SHIPPING_BACKUP_RESTORE','SHIPPING_BACKUP_RESTORE_UNVERIFIED')}.get(mode)
                result=io.StringIO()
                try:
                    with contextlib.redirect_stdout(result):
                        release.execute_loaded(remote,art,ledger,helper,remote.inspect(old)['Id'],release.digest(routes.encode()))
                except release.GateError as error:
                    if expected!=(error.failure_stage,str(error)) or error.deployment_result!='DEPLOY_ROLLED_BACK':raise RuntimeError('CI_CONTROLLER_ROLLBACK_RESULT_INVALID') from None
                else:
                    if expected or json.loads(result.getvalue())['result']!='DEPLOY_COMPLETE':raise RuntimeError('CI_CONTROLLER_EXPECTED_FAILURE_MISSING')
                final=remote.db();expected_ledger=release.before_ledger(ledger) if mode=='backup_limit' else ledger
                release.validate_database(final,expected_ledger)
                writer=candidate if mode=='success' else old
                release.writer_check(remote.containers(),final,[writer])
                if release.route_target(*remote.routes())!=writer or (case_root/'current-sha').read_text().strip()!=(sha if mode=='success' else release.SHIPPING_OLD_SHA):raise RuntimeError('CI_ROUTE_OR_POINTER_NOT_RECONCILED')
                if (case_root/'lock').exists():raise RuntimeError('CI_KNOWN_PHASE_LOCK_NOT_RELEASED')
                if mode in ('post_cutover_failure','post_l86_disk'):
                    docker('exec','-w','/app',old,'node','--input-type=module','-e',OLD_COMPAT_JS)
                cleanup_count=docker('exec',pg,'psql','-X','-qAt','-U','postgres','-d',database,'-c',
                    "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND (application_name LIKE 'budu_shipping_backup_%' OR application_name='budu_shipping_migrator') AND pid<>pg_backend_pid()")
                if cleanup_count!='0':raise RuntimeError('CI_BACKUP_OR_MIGRATOR_CONNECTIONS_REMAIN')
                proof_path=case_root/'rollback'/(release.ROLLBACK_PREFIX+sha)/'backup-restore-proof.json'
                backup=json.loads(proof_path.read_text()) if proof_path.exists() else None
                if mode!='backup_limit' and (not backup or not backup['terminationVerified'] or not backup['restoreVerified'] or remote.inspect(restore)['State']['Running']):raise RuntimeError('CI_REAL_BACKUP_RESTORE_NOT_PROVEN')
                starts=[event for event in remote.events if event=={'action':'start','container':migrator}]
                if len(starts)!=(0 if mode=='backup_limit' else 1) or (mode!='success' and not remote.injected):raise RuntimeError('CI_MIGRATOR_OR_INJECTION_NOT_OBSERVED')
                cases.append({'case':mode,'controller':'execute_loaded','result':'PASS','migrations':final['applied'],
                              'check':final['check'],'writer':writer,'writerSamples':remote.writer_samples,'events':remote.events,
                              'diskSamples':remote.disk_samples,'backupRestoreProof':backup,'backupAndMigratorConnections':0,
                              'actual6OldHttpSummaryXlsx':mode in ('post_cutover_failure','post_l86_disk'),'failureInjection':expected,
                              'hostStorageActual':remote.host_storage,'hostStorageGate':'CI_FIXTURE_ADAPTER_PRODUCTION_UNVERIFIED',
                              'automaticDnsAliasAdaptations':remote.alias_adaptations,'lockRemoved':True})
                for name in names:
                    remove_owned(name)
                docker('exec',pg,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-c','DROP DATABASE '+database+' WITH (FORCE)')
            report={'scope':'ISOLATED_LINUX_CI_REAL_CONTROLLER_NOT_PRODUCTION_ADMISSION','releaseSha':sha,
                    'oldSha':release.SHIPPING_OLD_SHA,'businessSha':release.SHIPPING_BUSINESS_SHA,
                    'controllerSha256':hashlib.sha256((ROOT/'scripts/deploy-prod-transfer-cas.py').read_bytes()).hexdigest(),
                    'archiveSha256':art['archiveHash'],'loadedImageId':art['loadedDockerImageId'],'cases':cases,
                    'realExecuteLoaded':True,'realBackupRestoreHelper':True,'realImageMigrator':True,
                    'realApplicationContainers':True,'sleepProbeIsBusinessWriterEvidence':False,
                    'productionHostStorageValidated':False,'productionActions':False}
        finally:
            for name in set(owned)|reserved:
                remove_owned(name)
            if network_id:
                if json.loads(docker('network','inspect',network))[0]['Id']!=network_id:
                    raise RuntimeError('CI_NETWORK_CLEANUP_OWNERSHIP_CHANGED')
                docker('network','rm',network)
            for key,value in globals_before.items():setattr(release,key,value)
            for key,value in git_before.items():
                if value is None:os.environ.pop(key,None)
                else:os.environ[key]=value
    report['ownedResourcesRemoved']=True
    target=Path(os.environ['RUNNER_TEMP'])/'shipping-controller-proof.json'
    target.write_text(json.dumps(report,sort_keys=True,indent=2)+'\n');target.chmod(0o644)
    print('ISOLATED_REAL_CONTROLLER_CASES=4_PASS HOST_STORAGE=CI_ADAPTER_PRODUCTION_UNVERIFIED PRODUCTION_ADMISSION=NO')


def main(image, old_image=None):
    if (os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_OS') != 'Linux'
            or os.environ.get('DOCKER_HOST') not in (None, 'unix:///var/run/docker.sock')
            or os.environ.get('DOCKER_CONTEXT')):
        raise RuntimeError('ISOLATED_RUNNER_REQUIRED')
    suffix = os.environ['GITHUB_RUN_ID'] + '-' + os.environ.get('GITHUB_RUN_ATTEMPT', '1')
    network = 'probe-net-' + suffix
    pg = 'probe-pg-' + suffix
    old = 'probe-old-' + suffix
    candidate = 'probe-candidate-' + suffix
    bad = 'probe-bad-' + suffix
    names = (old, candidate, bad)
    fixture_url = 'postgresql://postgres:fixture_only@' + pg + ':5432/probe_fixture'
    bad_url = 'postgresql://postgres:fixture_only@no-such-pg:5432/probe_fixture'

    def writers(expected):
        running = set(docker('ps', '--format', '{{.Names}}').splitlines())
        if set(names) & running != set(expected):
            raise RuntimeError('ISOLATED_WRITER_COUNT_INVALID')

    try:
        docker('network', 'create', network)
        docker('run', '-d', '--name', pg, '--network', network,
               '-e', 'POSTGRES_PASSWORD=fixture_only', '-e', 'POSTGRES_DB=probe_fixture',
               'postgres:16.14', timeout=180)
        for _ in range(30):
            ready = subprocess.run(['docker', 'exec', pg, 'pg_isready', '-U', 'postgres', '-d', 'probe_fixture'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('ISOLATED_POSTGRES_NOT_READY')
        if old_image is not None:
            shipping_pg16_ci(image,old_image,network,pg,fixture_url)
        for name, url in ((old, fixture_url), (candidate, fixture_url), (bad, bad_url)):
            docker('create', '--name', name, '--network', network,
                   '-e', 'DATABASE_URL=' + url, '--entrypoint', 'sleep',
                   old_image if name==old and old_image else image, '600')
        remote = LocalDocker()
        docker('start', old)
        writers([old])
        docker('stop', old)
        writers([])
        docker('start', candidate)
        writers([candidate])
        release.application_db_probe(remote, candidate, 'CANDIDATE_APPLICATION_DB_PROBE_FAILED')
        switch_point_reached = True
        docker('stop', candidate)
        writers([])
        docker('start', old)
        release.application_db_probe(remote, old, 'ROLLBACK_APPLICATION_DB_PROBE_FAILED')
        writers([old])

        docker('stop', old)
        writers([])
        docker('start', bad)
        writers([bad])
        switch_point_reached_after_failure = False
        try:
            release.application_db_probe(remote, bad, 'CANDIDATE_APPLICATION_DB_PROBE_FAILED')
        except release.GateError as error:
            if str(error) != 'CANDIDATE_APPLICATION_DB_PROBE_FAILED':
                raise RuntimeError('ISOLATED_FAILURE_CODE_INVALID') from None
        else:
            switch_point_reached_after_failure = True
        if not switch_point_reached or switch_point_reached_after_failure:
            raise RuntimeError('ISOLATED_SWITCH_GATE_INVALID')
        docker('stop', bad)
        writers([])
        docker('start', old)
        release.application_db_probe(remote, old, 'ROLLBACK_APPLICATION_DB_PROBE_FAILED')
        writers([old])
        print('ISOLATED_SLEEP_DB_PROBE=PASS PROBE_FAILURE_RECOVERY=PASS BUSINESS_WRITER_EVIDENCE=NO')
    finally:
        for name in (*names, pg):
            subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, check=False)
        subprocess.run(['docker', 'network', 'rm', network], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, check=False)


if __name__ == '__main__':
    try:
        if sys.argv[1] == '--native-pg16':
            native_pg16()
        elif sys.argv[1] == '--shipping-controller-ci':
            if len(sys.argv)!=5:raise RuntimeError('CI_CONTROLLER_ARGUMENTS_INVALID')
            shipping_controller_ci(*sys.argv[2:])
        else:
            main(sys.argv[1],sys.argv[2] if len(sys.argv)==3 else None)
    except BaseException as error:
        if len(sys.argv)>1 and sys.argv[1]=='--shipping-controller-ci':
            code=str(error)
            print(json.dumps({'scope':'ISOLATED_SHIPPING_CONTROLLER_CI',
                'code':code if re.fullmatch('[A-Z][A-Z0-9_:]{1,100}',code) else 'DETAILS_SUPPRESSED',
                'stage':getattr(error,'failure_stage','CI_FIXTURE')}),file=sys.stderr)
        else:print('CANDIDATE_DB_PROBE_INTEGRATION_FAILED', file=sys.stderr)
        raise SystemExit(1) from None

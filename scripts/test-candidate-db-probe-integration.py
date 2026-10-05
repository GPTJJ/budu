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
import shutil
import signal
import threading
import contextlib
import io
import copy
import re
import ast
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


def ci_operation(args):
    """Finite operation labels; never serialize argv, env, URLs or stderr."""
    if not args or args[0] != 'docker':return 'LOCAL_HELPER'
    if args[1:2] == ['exec']:
        for token,label in (('psql','DATABASE_SQL'),('node','APPLICATION_NODE'),('wget','LOCAL_HEALTH'),
                            ('nginx','NGINX_CONTROL'),('pg_dump','DATABASE_DUMP'),('pg_restore','DATABASE_RESTORE')):
            if token in args:return label
        return 'DOCKER_EXEC'
    verb=args[1] if len(args)>1 else ''
    return {'inspect':'DOCKER_INSPECT','image':'DOCKER_IMAGE','info':'DOCKER_INFO',
            'ps':'DOCKER_LIST','run':'DOCKER_RUN','create':'DOCKER_CREATE','start':'DOCKER_START',
            'stop':'DOCKER_STOP','rm':'DOCKER_REMOVE','network':'DOCKER_NETWORK',
            'pull':'DOCKER_PULL','logs':'DOCKER_LOGS','update':'DOCKER_UPDATE'}.get(verb,'DOCKER_OTHER')


def docker(*args, timeout=30):
    try:
        result = subprocess.run(['docker', *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, check=False)
    except (OSError,subprocess.TimeoutExpired):
        error=release.GateError('COMMAND_UNAVAILABLE_OR_TIMEOUT');error.ci_operation=ci_operation(['docker',*args])
        raise error from None
    if result.returncode:
        error=RuntimeError('ISOLATED_DOCKER_COMMAND_FAILED');error.ci_operation=ci_operation(['docker',*args])
        raise error
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
            or os.environ.get('GITHUB_REF') not in ('refs/heads/'+release.SHIPPING_BRANCH,
                                                   'refs/heads/'+release.SHIPPING_DIAGNOSTIC_BRANCH,
                                                   'refs/heads/'+release.SHIPPING_BACKUP_DIAGNOSTIC_BRANCH)
            or os.environ.get('TEST_SHIPPING_CONTROLLER_CI') != '1'
            or os.environ.get('DOCKER_HOST') not in (None, 'unix:///var/run/docker.sock')
            or os.environ.get('DOCKER_CONTEXT') or not os.environ.get('RUNNER_TEMP')
            or not re.fullmatch('[0-9a-f]{40}',os.environ.get('GITHUB_SHA',''))):
        raise RuntimeError('SHIPPING_CONTROLLER_ISOLATED_LINUX_CI_REQUIRED')


BACKUP_HELPER_SHA = '08f5738100617198bcb6fd37aeb072a9d95bcbd18ba9251c69dd6184382393e4'
HELPER_FUNCTIONS = {'<module>':'MODULE','run':'RUN','sql':'SQL','fingerprints':'FINGERPRINTS',
    'bounded_backup_dump':'DUMP','stop_backup_process':'STOP_CHILD','allocated':'ALLOCATED','<genexpr>':'ALLOCATION_SCAN'}
HELPER_MODULE_PHASES = {57:'SOURCE_INSPECT',73:'SOURCE_FINGERPRINT',75:'DUMP',76:'RESTORE_DIRECTORY',
    79:'RESTORE_NAME',81:'RESTORE_CREATE',85:'RESTORE_START',88:'RESTORE_READY',93:'RESTORE_READY',
    91:'RESTORE_VERSION',94:'RESTORE_INPUT',95:'RESTORE_LOAD_START',98:'RESTORE_ALLOCATION',99:'RESTORE_DEADLINE',
    101:'RESTORE_EXIT',104:'RESTORE_CHILD_STOP',106:'RESTORED_FINGERPRINT',107:'FACTS_COMPARE',
    115:'SOURCE_CONNECTION_TERMINATE',116:'SOURCE_CONNECTION_COUNT',117:'SOURCE_CONNECTION_COUNT',
    119:'RESTORE_INSPECT',122:'RESTORE_IDENTITY',123:'RESTORE_STOP',124:'RESTORE_STOP_VERIFY',
    127:'FINAL_ALLOCATION',128:'FINAL_ALLOCATION',132:'PROOF_WRITE',133:'PROOF_OUTPUT'}
HELPER_DUMP_PHASES = {16:'DUMP_FILE_OPEN',18:'DUMP_START',21:'DUMP_DEADLINE',22:'DUMP_READ',24:'DUMP_READ',
    27:'DUMP_LIMIT',30:'DUMP_DEADLINE',31:'DUMP_EXIT',32:'DUMP_FSYNC',37:'DUMP_CHILD_STOP',38:'DUMP_STDOUT_CLOSE'}
HELPER_PHASES = frozenset(HELPER_MODULE_PHASES.values())|frozenset(HELPER_DUMP_PHASES.values())|{
    'SOURCE_TABLE_LIST','SOURCE_TABLE_FINGERPRINT','SOURCE_SEQUENCE_FINGERPRINT',
    'RESTORED_TABLE_LIST','RESTORED_TABLE_FINGERPRINT','RESTORED_SEQUENCE_FINGERPRINT',
    'PROOF_VALIDATION','SPACE_GATE','HELPER_UNKNOWN'}
HELPER_CODES = frozenset(node.args[0].value for node in ast.walk(ast.parse(release.SHIPPING_BACKUP_RESTORE_CODE))
    if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id in ('RuntimeError','TimeoutError')
    and node.args and isinstance(node.args[0],ast.Constant) and isinstance(node.args[0].value,str))|{
    'HELPER_PERMISSION_DENIED','HELPER_FILE_IO_FAILED','HELPER_FILE_NOT_FOUND','HELPER_COMMAND_TIMEOUT',
    'HELPER_DECODE_FAILED','HELPER_DETAILS_SUPPRESSED','HELPER_CAPTURE_UNVERIFIED','HELPER_STDERR_CLASSIFIED','INTERRUPTED'}
STDERR_CLASSES = frozenset({'DATABASE_MISSING','CONNECTION_FAILED','PERMISSION_DENIED','SQL_SYNTAX',
    'RESTORE_ERRORS','VERSION_MISMATCH','EMPTY','OTHER'})
HELPER_META_INTS = {'tableCount','restoredTableCount','backupBytes','restoreAllocatedBytes','remainingConnections'}
HELPER_META_BOOLS = {'cleanupComplete','restoreCreated','fingerprintsMatch','tableCountsMatch','restoreVerified',
    'terminationVerified','versionMatches','releaseMatches','dumpWithinLimit','restoreWithinLimit'}
CI_CASES = ('success','post_cutover_failure','post_l86_disk','backup_limit')
CI_OPERATIONS = frozenset(ci_operation(['docker',verb]) for verb in
    ('inspect','image','info','ps','run','create','start','stop','rm','network','pull','logs','update','other')) | frozenset({
    'LOCAL_HELPER','DATABASE_SQL','APPLICATION_NODE','LOCAL_HEALTH','NGINX_CONTROL','DATABASE_DUMP',
    'DATABASE_RESTORE','DOCKER_EXEC','BACKUP_RESTORE_HELPER','MIGRATOR_CREATE_HELPER','CLONE_HELPER',
    'CONTAINER_CLEANUP','DATABASE_CLEANUP','NETWORK_CLEANUP','TEMP_DIRECTORY_CLEANUP','DIAGNOSTIC_WRITE',
    'LOCK_CLEANUP_HELPER'})


def ci_code_catalog():
    # Only literal gate codes in the exact reviewed source are eligible. An
    # arbitrary uppercase exception, raw subprocess output or credential is not.
    codes=set(release.SAFE_CONTROLLER_CODES)|{'DETAILS_SUPPRESSED','CI_DIAGNOSTIC_WRITE_FAILED','ROLLBACK_APPLICATION_DB_PROBE_FAILED',
        'ARTIFACT_DISK_GATE_FAIL:POST_DEPLOY_HEADROOM'}
    for path in (Path(release.__file__),Path(__file__)):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node,ast.Call):
                name=node.func.id if isinstance(node.func,ast.Name) else getattr(node.func,'attr','')
                index=1 if name=='require' else 0
                if name in ('require','GateError','RuntimeError') and len(node.args)>index:
                    value=node.args[index]
                    if isinstance(value,ast.Constant) and isinstance(value.value,str) and re.fullmatch('[A-Z][A-Z0-9_:]{1,100}',value.value):
                        codes.add(value.value)
    return frozenset(codes)


CI_CODES = ci_code_catalog()|HELPER_CODES
CI_CONTROLLER_RESULTS = ('DEPLOY_ROLLED_BACK','DEPLOY_BLOCKED','DEPLOY_ABORTED','DEPLOY_COMPLETE','UNKNOWN')


def validate_ci_diagnostic_records(records,sha):
    assert re.fullmatch('[0-9a-f]{40}',sha)
    assert isinstance(records,list) and 1 <= len(records) <= 32
    labels=CI_OPERATIONS|{'PRIMARY','CLEANUP','HOST_STORAGE_CI_ADAPTER_PRODUCTION_UNVERIFIED',
        'DNS_CI_ADAPTER_PRODUCTION_UNVERIFIED'}|{'CONTROLLER_'+value for value in CI_CONTROLLER_RESULTS}|{
        'REQUESTED_'+case.upper() for case in CI_CASES}|{'EXPECTED_STAGE_'+stage for stage in release.SAFE_CONTROLLER_STAGES}|{
        'EXPECTED_CODE_'+code for code in CI_CODES}
    for row in records:
        assert set(row)=={'exactSHA','case','completedCases','stage','code','result','injection'}
        assert row['exactSHA']==sha and row['case'] in (*CI_CASES,'SETUP','UNVERIFIED')
        assert row['completedCases']==list(CI_CASES[:len(row['completedCases'])])
        assert row['stage'] in release.SAFE_CONTROLLER_STAGES|{'CI_FIXTURE','CI_CLEANUP','CI_DIAGNOSTIC'}
        assert row['code'] in CI_CODES and row['result'] in ('FAILED','UNVERIFIED')
        assert isinstance(row['injection'],list) and 1 <= len(row['injection']) <= 8
        for label in row['injection']:
            if isinstance(label,str):
                assert label in labels|{'HELPER_PRIMARY','HELPER_CLEANUP','BACKUP_HELPER_SHA_'+BACKUP_HELPER_SHA}
            else:validate_helper_label(label)


def validate_helper_label(value):
    assert isinstance(value,dict)
    kind=value.get('kind')
    if kind=='HELPER_FRAME':
        assert set(value)=={'kind','function','line','phase'}
        assert value['function'] in set(HELPER_FUNCTIONS.values())|{'PROOF','SPACE'}
        assert type(value['line']) is int and 1 <= value['line'] <= 4000 and value['phase'] in HELPER_PHASES
    elif kind=='HELPER_META':
        assert set(value) <= {'kind','returnCode'}|HELPER_META_INTS|HELPER_META_BOOLS
        for key,item in value.items():
            if key in HELPER_META_INTS:assert type(item) is int and 0 <= item <= 2**63-1
            if key in HELPER_META_BOOLS:assert type(item) is bool
            if key=='returnCode':assert type(item) is int and -64 <= item <= 255
    elif kind=='HELPER_STDERR':
        assert set(value)=={'kind','stream','classes','retainedBytes','truncated','drainComplete'}
        assert value['stream'] in ('DUMP','RESTORE','COMMAND')
        assert isinstance(value['classes'],list) and 1 <= len(value['classes']) <= 8
        assert all(item in STDERR_CLASSES for item in value['classes'])
        assert type(value['retainedBytes']) is int and 0 <= value['retainedBytes'] <= 65536
        assert type(value['truncated']) is bool and type(value['drainComplete']) is bool
    else:raise AssertionError('HELPER_LABEL_INVALID')


def stderr_classes(data):
    # Match bounded bytes directly; never decode, print or persist stderr.
    patterns=((rb'database .{0,128} does not exist','DATABASE_MISSING'),
        (rb'connection.*(?:failed|refused)|could not connect|no such file or directory','CONNECTION_FAILED'),
        (rb'permission denied|operation not permitted','PERMISSION_DENIED'),
        (rb'syntax error','SQL_SYNTAX'),(rb'errors ignored on restore|pg_restore: error','RESTORE_ERRORS'),
        (rb'version mismatch|server version.*pg_dump version','VERSION_MISMATCH'))
    return [code for pattern,code in patterns if re.search(pattern,data,re.I)] or ['EMPTY' if not data else 'OTHER']


class HelperStderrCapture:
    """CI-only tee for the two helper clients whose stderr is discarded.

    Total retained bytes <=56KiB, two 4KiB readers. Drain beyond the cap to
    avoid pipe deadlock. No argv, stdout, gates, deadlines or signals change.
    """
    def __init__(self):
        self.original=subprocess.Popen;self.streams=[];self.lock=threading.Lock();self.retained=0
        self.final=[];self.closed=False

    def __enter__(self):
        if hashlib.sha256(release.SHIPPING_BACKUP_RESTORE_CODE.encode()).hexdigest()!=BACKUP_HELPER_SHA:
            raise RuntimeError('CI_BACKUP_HELPER_HASH_CHANGED')
        subprocess.Popen=self.popen
        return self

    def popen(self,*args,**kwargs):
        frame=sys._getframe(1);stream=None
        if frame.f_code.co_filename=='shipping-backup-restore' and kwargs.get('stderr')==subprocess.DEVNULL:
            if frame.f_code.co_name=='bounded_backup_dump' and frame.f_lineno==18:stream='DUMP'
            elif frame.f_code.co_name=='<module>' and HELPER_MODULE_PHASES.get(frame.f_lineno)=='RESTORE_LOAD_START':stream='RESTORE'
        if not stream:return self.original(*args,**kwargs)
        kwargs={**kwargs,'stderr':subprocess.PIPE};process=self.original(*args,**kwargs)
        entry={'stream':stream,'data':bytearray(),'truncated':False,'done':False,'process':process}
        def drain():
            try:
                while True:
                    block=os.read(process.stderr.fileno(),4096)
                    if not block:entry['done']=True;break
                    with self.lock:
                        retained=0 if self.closed else min(len(block),max(0,57344-self.retained))
                        entry['data'].extend(block[:retained]);self.retained+=retained
                        entry['truncated']|=retained<len(block)
            except (OSError,ValueError):pass
        entry['thread']=threading.Thread(target=drain,daemon=True);self.streams.append(entry);entry['thread'].start()
        return process

    def snapshot(self):
        rows=[]
        for entry in self.streams:
            entry['thread'].join(timeout=1)
        with self.lock:
            self.closed=True
            for entry in self.streams:
                rows.append({'kind':'HELPER_STDERR','stream':entry['stream'],'classes':stderr_classes(entry['data']),
                    'retainedBytes':len(entry['data']),'truncated':entry['truncated'],'drainComplete':entry['done']})
                entry['data'].clear()
        self.final=rows
        return rows

    def __exit__(self,*unused):
        subprocess.Popen=self.original
        try:self.snapshot()
        except BaseException:pass
        for entry in self.streams:
            if entry['done']:
                try:entry['process'].stderr.close()
                except OSError:pass


def helper_metadata(frames):
    values={'kind':'HELPER_META'}
    for frame in frames:
        scope=frame.f_locals
        for old,new in (('tables','tableCount'),('after_tables','restoredTableCount'),('total','backupBytes'),('extent','restoreAllocatedBytes')):
            item=scope.get(old)
            if type(item) is int and 0<=item<=2**63-1:values[new]=item
        for old,new in (('cleanup_complete','cleanupComplete'),('created','restoreCreated')):
            item=scope.get(old)
            if type(item) is bool:values[new]=item
        before,after=scope.get('before'),scope.get('after')
        if all(isinstance(item,str) and re.fullmatch('[0-9a-f]{64}',item) for item in (before,after)):
            values['fingerprintsMatch']=before==after
        if type(scope.get('tables')) is int and type(scope.get('after_tables')) is int:
            values['tableCountsMatch']=scope['tables']==scope['after_tables']
        remaining=scope.get('remaining')
        if isinstance(remaining,bytes) and re.fullmatch(rb'[0-9]{1,8}\s*',remaining):values['remainingConnections']=int(remaining)
        for name in ('p','process','restore_process'):
            item=scope.get(name);rc=getattr(item,'returncode',None)
            if type(rc) is int and -64<=rc<=255:values['returnCode']=rc
        result=scope.get('result');limits=scope.get('limits');art=scope.get('art')
        if frame.f_code.co_name=='shipping_backup_restore' and isinstance(result,dict):
            for key in ('restoreVerified','terminationVerified'):
                if type(result.get(key)) is bool:values[key]=result[key]
            values['versionMatches']=result.get('pgVersion')=='16.14'
            values['releaseMatches']=isinstance(art,dict) and result.get('releaseSha')==art.get('release')
            for key in ('tableCount','backupBytes','restoreAllocatedBytes'):
                if type(result.get(key)) is int and 0<=result[key]<=2**63-1:values[key]=result[key]
            if isinstance(limits,dict):
                for key,bound,label in (('backupBytes','backupLimit','dumpWithinLimit'),('restoreAllocatedBytes','restoreLimit','restoreWithinLimit')):
                    if type(result.get(key)) is int and type(limits.get(bound)) is int:values[label]=0<result[key]<=limits[bound]
    return values


def helper_failures(error):
    """Read exception contexts even after raise-from-None; never serialize locals."""
    if hashlib.sha256(release.SHIPPING_BACKUP_RESTORE_CODE.encode()).hexdigest()!=BACKUP_HELPER_SHA:return []
    chain=[];seen=set();current=error
    while current is not None and id(current) not in seen and len(chain)<8:
        seen.add(id(current));chain.append(current);current=current.__context__ or current.__cause__
    records=[]
    for original in reversed(chain):
        frames=[];details=[];tb=original.__traceback__;module=None
        while tb is not None:
            frame=tb.tb_frame;name=frame.f_code.co_name
            if frame.f_code.co_filename=='shipping-backup-restore' and name in HELPER_FUNCTIONS:
                frames.append(frame)
                if name=='<module>':module=tb.tb_lineno
                details.append({'kind':'HELPER_FRAME','function':HELPER_FUNCTIONS[name],'line':tb.tb_lineno,'phase':'HELPER_UNKNOWN'})
            elif frame.f_code.co_filename==release.__file__ and name in ('shipping_backup_restore','shipping_disk_gate'):
                frames.append(frame);details.append({'kind':'HELPER_FRAME','function':'PROOF' if name=='shipping_backup_restore' else 'SPACE',
                    'line':tb.tb_lineno,'phase':'PROOF_VALIDATION' if name=='shipping_backup_restore' else 'SPACE_GATE'})
            tb=tb.tb_next
        if not frames:continue
        if not any(frame.f_code.co_filename=='shipping-backup-restore' for frame in frames):
            # A wrapper rethrow at shipping_backup_restore is not a second
            # cleanup error. Keep direct returned-proof/space failures only.
            if not any(frame.f_code.co_name=='shipping_disk_gate' or isinstance(frame.f_locals.get('result'),dict)
                       for frame in frames):continue
        phase=HELPER_MODULE_PHASES.get(module,'HELPER_UNKNOWN')
        for detail in details:
            if detail['function']=='DUMP':phase=HELPER_DUMP_PHASES.get(detail['line'],phase)
            if detail['function']=='FINGERPRINTS' and HELPER_MODULE_PHASES.get(module) in ('SOURCE_FINGERPRINT','RESTORED_FINGERPRINT'):
                phase=('SOURCE_' if HELPER_MODULE_PHASES[module]=='SOURCE_FINGERPRINT' else 'RESTORED_')+{63:'TABLE_LIST',68:'TABLE_FINGERPRINT',69:'SEQUENCE_FINGERPRINT'}.get(detail['line'],'FINGERPRINT')
        for detail in details:
            if detail['phase']=='HELPER_UNKNOWN':detail['phase']=phase if phase in HELPER_PHASES else 'HELPER_UNKNOWN'
        code=str(original)
        if code not in HELPER_CODES|release.SAFE_CONTROLLER_CODES:
            code=('HELPER_PERMISSION_DENIED' if isinstance(original,OSError) and original.errno in (1,13) else
                  'HELPER_FILE_NOT_FOUND' if isinstance(original,FileNotFoundError) else
                  'HELPER_FILE_IO_FAILED' if isinstance(original,OSError) else
                  'HELPER_COMMAND_TIMEOUT' if isinstance(original,subprocess.TimeoutExpired) else
                  'HELPER_DECODE_FAILED' if isinstance(original,(json.JSONDecodeError,UnicodeError)) else 'HELPER_DETAILS_SUPPRESSED')
        labels=['HELPER_PRIMARY' if not records else 'HELPER_CLEANUP','BACKUP_HELPER_SHA_'+BACKUP_HELPER_SHA,*details[-4:],helper_metadata(frames)]
        for frame in frames:
            value=frame.f_locals.get('p');data=getattr(value,'stderr',None)
            if isinstance(data,bytes):
                bounded=memoryview(data)[:65536]
                labels.append({'kind':'HELPER_STDERR','stream':'COMMAND','classes':stderr_classes(bounded),
                    'retainedBytes':len(bounded),'truncated':len(data)>65536,'drainComplete':True});break
        records.append({'code':code,'injection':labels[:8]})
    return records


class CiFailureDiagnostics:
    def __init__(self, target, sha):
        self.target=Path(target);self.sha=sha if re.fullmatch('[0-9a-f]{40}',sha or '') else 'UNVERIFIED'
        self.case='SETUP';self.completed=[];self.records=[]
        self.primary_error=None;self.primary_traceback=None;self.cleanup_error=None

    def record(self,error,source,operation=None):
        code=str(error);stage=getattr(error,'failure_stage','CI_CLEANUP' if source=='CLEANUP' else 'CI_FIXTURE')
        stage=stage if stage in release.SAFE_CONTROLLER_STAGES|{'CI_CLEANUP','CI_FIXTURE','CI_DIAGNOSTIC'} else 'UNKNOWN'
        operation=operation or getattr(error,'ci_operation','LOCAL_HELPER')
        controller=getattr(error,'deployment_result','UNKNOWN')
        labels=[source,operation if operation in CI_OPERATIONS else 'LOCAL_HELPER',
                'HOST_STORAGE_CI_ADAPTER_PRODUCTION_UNVERIFIED','DNS_CI_ADAPTER_PRODUCTION_UNVERIFIED',
                'CONTROLLER_'+(controller if controller in CI_CONTROLLER_RESULTS else 'UNKNOWN')]
        if self.case in CI_CASES:labels.append('REQUESTED_'+self.case.upper())
        expected=getattr(error,'ci_expected_failure',None)
        if isinstance(expected,tuple) and len(expected)==2 and expected[0] in release.SAFE_CONTROLLER_STAGES and expected[1] in CI_CODES:
            labels.extend(('EXPECTED_STAGE_'+expected[0],'EXPECTED_CODE_'+expected[1]))
        row={'exactSHA':self.sha,'case':self.case if self.case in (*CI_CASES,'SETUP') else 'UNVERIFIED',
             'completedCases':[case for case in self.completed if case in CI_CASES],
             'stage':stage,'code':code if code in CI_CODES else 'DETAILS_SUPPRESSED',
             'result':'FAILED' if source=='PRIMARY' else 'UNVERIFIED','injection':labels}
        if len(self.records)<32:self.records.append(row)
        self.write()
        return row

    def write(self):
        # Outside the owned resource directory: capture the primary BEFORE its
        # cleanup. Recording failure cannot replace the original exception.
        temporary=None
        try:
            fd,name=tempfile.mkstemp(prefix='shipping-diagnostic-',dir=self.target.parent)
            temporary=Path(name)
            with os.fdopen(fd,'w') as output:output.write(json.dumps(self.records,sort_keys=True,indent=2)+'\n')
            temporary.chmod(0o644);os.replace(temporary,self.target)
        except BaseException:
            print(json.dumps({'exactSHA':self.sha,'case':self.case,'completedCases':self.completed,
                'stage':'CI_DIAGNOSTIC','code':'CI_DIAGNOSTIC_WRITE_FAILED','result':'UNVERIFIED',
                'injection':['CLEANUP','DIAGNOSTIC_WRITE']}),file=sys.stderr)
        finally:
            if temporary:
                try:temporary.unlink(missing_ok=True)
                except BaseException:pass

    def primary(self,error):
        if error is self.cleanup_error:return
        if self.primary_error is None:
            self.primary_error=error;self.primary_traceback=error.__traceback__
            self.record(error,'PRIMARY')
            try:
                for detail in helper_failures(error):
                    row={'exactSHA':self.sha,'case':self.case,'completedCases':self.completed.copy(),
                        'stage':'SHIPPING_BACKUP_RESTORE','code':detail['code'],'result':'UNVERIFIED','injection':detail['injection']}
                    if len(self.records)<32:self.records.append(row)
                for detail in getattr(error,'ci_helper_stderr',[]):
                    row={'exactSHA':self.sha,'case':self.case,'completedCases':self.completed.copy(),
                        'stage':'SHIPPING_BACKUP_RESTORE','code':'HELPER_STDERR_CLASSIFIED','result':'UNVERIFIED',
                        'injection':['BACKUP_HELPER_SHA_'+BACKUP_HELPER_SHA,detail]}
                    if len(self.records)<32:self.records.append(row)
                self.write()
            except BaseException:pass

    def cleanup(self,action,operation):
        try:action()
        except BaseException as error:
            if self.cleanup_error is None:self.cleanup_error=error
            self.record(error,'CLEANUP',operation)

    def raise_cleanup(self):
        if self.cleanup_error is not None:raise self.cleanup_error


def verify_controller_failure(error,expected):
    if (expected != (getattr(error,'failure_stage',None),str(error))
            or getattr(error,'deployment_result',None) != 'DEPLOY_ROLLED_BACK'):
        error.ci_expected_failure=expected
        raise error


class ControllerCiRemote(release.LocalRemote):
    """Real local Docker/PG/files, with explicitly labelled CI infrastructure.

    execute_loaded, backup helper, migrator, rollback, writer gates, application
    runtime/DB probes and route replacement are NOT mocked. Production host
    storage metadata and Docker's automatic fixture DNS aliases are adapters;
    neither is production admission evidence. Disk bytes are real except for
    the one labelled post-L86 insufficient-space injection.
    """
    def __init__(self, root, network, old, candidate, mode, db_network=None):
        self.root=Path(root);self.network=network;self.db_network=db_network or network;self.old=old;self.candidate=candidate;self.mode=mode
        self.events=[];self.writer_samples=[];self.disk_samples=[];self.host_storage=None
        self.alias_adaptations=[];self.migrator_started=False;self.injected=False;self.migrator_prestart_networks=None

    def run(self, args, data=None, timeout=60):
        if args and args[0] in ('ssh','scp','curl'):
            raise RuntimeError('CI_EXTERNAL_TARGET_FORBIDDEN')
        if args[:2]==['docker','start'] and args[-1]=='budu-shipping-migrator-'+os.environ['GITHUB_SHA'][:12]:
            created=super().inspect(args[-1])
            self.migrator_prestart_networks={k:v.get('NetworkID') for k,v in created['NetworkSettings']['Networks'].items()}
        try:result=super().run(args,data,timeout)
        except BaseException as error:
            error.ci_operation=ci_operation(args)
            raise
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
                if key not in (self.network,self.db_network) or set(aliases)-{self.old,value['Id'][:12]}:
                    raise RuntimeError('CI_UNEXPECTED_NETWORK_ALIAS')
                if aliases:self.alias_adaptations.append(aliases)
                endpoint['Aliases']=None
        if not image and name=='budu-shipping-migrator-'+os.environ.get('GITHUB_SHA','')[:12] and value['State'].get('Status')=='created':
            print(json.dumps({'scope':'ISOLATED_CI_MIGRATOR_NETWORK_METADATA','releaseSha':os.environ['GITHUB_SHA'],
                'networkMode':value['HostConfig']['NetworkMode'],
                'networkIds':{k:v.get('NetworkID') for k,v in value['NetworkSettings']['Networks'].items()}}),file=sys.stderr)
        return value

    def py(self, code, value=None, timeout=60):
        if value and 'root' in value:
            expected='/opt/budu/.rollback-assets/'+release.ROLLBACK_PREFIX+os.environ['GITHUB_SHA']
            if release.procurement_migration() and release.EXPECTED_OLD_SHA==release.procurement_contract()['rollbackSha']:
                if re.fullmatch(re.escape(expected)+r'-resume-[0-9a-f]{16}',value['root']):expected=value['root']
            if value['root']!=expected:raise RuntimeError('CI_ROLLBACK_PATH_ESCAPE')
            value={**value,'root':str(self.root/'rollback'/Path(expected).name)}
        if code==release.SHIPPING_BACKUP_RESTORE_CODE and self.mode=='backup_limit':
            value={**value,'limits':{**value['limits'],'backupLimit':16}}
            self.injected=True
        capture=HelperStderrCapture() if code==release.SHIPPING_BACKUP_RESTORE_CODE else contextlib.nullcontext()
        try:
            with capture:return super().py(code,value,timeout)
        except BaseException as error:
            if isinstance(capture,HelperStderrCapture):error.ci_helper_stderr=capture.final
            error.ci_operation=('BACKUP_RESTORE_HELPER' if code==release.SHIPPING_BACKUP_RESTORE_CODE else
                'MIGRATOR_CREATE_HELPER' if code==release.SHIPPING_MIGRATOR_CREATE_CODE else
                'CLONE_HELPER' if value and 'helper' in value else
                'LOCK_CLEANUP_HELPER' if code.startswith('import os; os.rmdir(') else 'LOCAL_HELPER')
            raise

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
    diagnostics=CiFailureDiagnostics(Path(os.environ['RUNNER_TEMP'])/'shipping-controller-diagnostic.json',os.environ.get('GITHUB_SHA'))
    # Root is needed by the SAME backup helper to inspect the restore's 0700
    # postgres-owned files. Git trust is process-scoped, including direct ancestry
    # subprocesses in identity(); no global/local Git config is changed.
    git_keys=('GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0')
    git_before={key:os.environ.get(key) for key in git_keys}
    os.environ.update(GIT_CONFIG_COUNT='1',GIT_CONFIG_KEY_0='safe.directory',GIT_CONFIG_VALUE_0=str(ROOT))
    try:
        _shipping_controller_ci(image,old_image,archive,diagnostics)
    except BaseException as error:
        if diagnostics.primary_error is not None and error is not diagnostics.primary_error:
            diagnostics.cleanup(lambda: (_ for _ in ()).throw(error),'TEMP_DIRECTORY_CLEANUP')
            raise diagnostics.primary_error.with_traceback(diagnostics.primary_traceback) from None
        if diagnostics.primary_error is None and diagnostics.cleanup_error is not None and error is not diagnostics.cleanup_error:
            diagnostics.cleanup(lambda: (_ for _ in ()).throw(error),'TEMP_DIRECTORY_CLEANUP')
            raise diagnostics.cleanup_error from None
        diagnostics.primary(error)
        raise
    finally:
        for key,value in git_before.items():
            if value is None:os.environ.pop(key,None)
            else:os.environ[key]=value


def _shipping_controller_ci(image,old_image,archive,diagnostics):
    release.configure_profile('post-transfer',release.SHIPPING_OLD_SHA,release.SHIPPING_BUSINESS_SHA,
        hashlib.sha256(release.command(['git','-c','safe.directory='+str(ROOT),'-C',str(ROOT),
                                       'show',release.SHIPPING_OLD_SHA+':server/v2.js'])).hexdigest())
    identity,ledger=(release.backup_diagnostic_identity(ROOT) if os.environ['GITHUB_REF']=='refs/heads/'+release.SHIPPING_BACKUP_DIAGNOSTIC_BRANCH else
                     release.diagnostic_identity(ROOT) if os.environ['GITHUB_REF']=='refs/heads/'+release.SHIPPING_DIAGNOSTIC_BRANCH
                     else release.identity(ROOT));sha=os.environ['GITHUB_SHA']
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
        suffix=root.name.removeprefix('shipping-controller-');network='shipping-ci-net-'+suffix;db_network='shipping-ci-db-net-'+suffix;pg='shipping-ci-pg-'+suffix
        database='shipping_ci_'+suffix.replace('-','_');url='postgresql://postgres:fixture_only@'+pg+':5432/'+database
        globals_before={key:getattr(release,key) for key in ('PG','EXPECTED_DB','NGINX','TEMPLATE','CURRENT_SHA_FILE','LOCK')}
        release.PG=pg;release.EXPECTED_DB=database
        owned={};reserved=set();network_id=None;db_network_id=None
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
            db_network_id=docker('network','create','--internal',db_network)
            if json.loads(docker('network','inspect',db_network))[0]['Internal'] is not True:raise RuntimeError('CI_NETWORK_EGRESS_NOT_BLOCKED')
            owned[pg]=docker('run','-d','--name',pg,'--network',db_network,'-e','POSTGRES_PASSWORD=fixture_only','postgres:16.14',timeout=180)
            for _ in range(60):
                ready=subprocess.run(['docker','exec',pg,'pg_isready','-U','postgres'],capture_output=True,timeout=5)
                if ready.returncode==0:break
                time.sleep(0.25)
            else:raise RuntimeError('CI_POSTGRES_NOT_READY')
            primary_probe = "const net=require('node:net');const u=new URL(process.env.DATABASE_URL);const s=net.createConnection({host:u.hostname,port:5432});s.setTimeout(2000);s.on('connect',()=>{s.destroy();process.exit(3)});const done=()=>{s.destroy();process.stdout.write('PRIMARY_NETWORK_DB_UNREACHABLE');};s.once('error',done);s.once('timeout',done);"
            if docker('run','--rm','--network',network,'-e','DATABASE_URL='+url,'--entrypoint','node',image,'-e',primary_probe)!='PRIMARY_NETWORK_DB_UNREACHABLE':raise RuntimeError('CI_PRIMARY_NETWORK_UNEXPECTED_DB_ACCESS')
            docker('pull','nginx:1.28-alpine',timeout=180)
            for index,mode in enumerate(CI_CASES):
                diagnostics.case=mode
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
                docker('run','--rm','--network',db_network,'-e','DATABASE_URL='+url,'--entrypoint','node',old_image,
                       '/app/node_modules/prisma/build/index.js','migrate','deploy','--schema','/app/prisma/schema.prisma',timeout=180)
                docker('run','--rm','--network',db_network,'-e','DATABASE_URL='+url,'-e','APP_ENV=test','--entrypoint','node',old_image,
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
                docker('network','connect',db_network,old)
                docker('start',old)
                for _ in range(150):
                    info=json.loads(docker('inspect',old))[0]
                    if info['State'].get('Health',{}).get('Status')=='healthy':break
                    if not info['State']['Running']:raise RuntimeError('CI_REAL_OLD_APP_START_FAILED')
                    time.sleep(0.5)
                else:raise RuntimeError('CI_REAL_OLD_APP_NOT_HEALTHY')
                owned[nginx]=docker('run','-d','--name',nginx,'--network',network,'--mount','type=bind,source='+str(conf)+',target=/etc/nginx/conf.d',
                                   'nginx:1.28-alpine')
                remote=ControllerCiRemote(case_root,network,old,candidate,mode,db_network)
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
                    verify_controller_failure(error,expected)
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
                old_networks=remote.inspect(old)['NetworkSettings']['Networks']
                if set(old_networks)!={network,db_network}:raise RuntimeError('CI_DUAL_NETWORK_SOURCE_REQUIRED')
                migrator_networks=remote.inspect(migrator)['NetworkSettings']['Networks'] if mode!='backup_limit' else None
                if migrator_networks is not None and ({k:v.get('NetworkID') for k,v in migrator_networks.items()}!={k:v.get('NetworkID') for k,v in old_networks.items()}):raise RuntimeError('CI_MIGRATOR_NETWORK_PARITY_FAILED')
                starts=[event for event in remote.events if event=={'action':'start','container':migrator}]
                if len(starts)!=(0 if mode=='backup_limit' else 1) or (mode!='success' and not remote.injected):raise RuntimeError('CI_MIGRATOR_OR_INJECTION_NOT_OBSERVED')
                cases.append({'case':mode,'controller':'execute_loaded','result':'PASS','migrations':final['applied'],
                              'check':final['check'],'writer':writer,'writerSamples':remote.writer_samples,'events':remote.events,
                              'diskSamples':remote.disk_samples,'backupRestoreProof':backup,'backupAndMigratorConnections':0,
                              'actual6OldHttpSummaryXlsx':mode in ('post_cutover_failure','post_l86_disk'),'failureInjection':expected,
                              'hostStorageActual':remote.host_storage,'hostStorageGate':'CI_FIXTURE_ADAPTER_PRODUCTION_UNVERIFIED',
                              'automaticDnsAliasAdaptations':remote.alias_adaptations,'lockRemoved':True,
                              'secondaryDbNetworkTopology':True,'migratorNetworksMatchOld':migrator_networks is not None,
                              'migratorPreStartNetworks':remote.migrator_prestart_networks})
                for name in names:
                    diagnostics.cleanup(lambda name=name: remove_owned(name),'CONTAINER_CLEANUP')
                diagnostics.cleanup(lambda: docker('exec',pg,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-c',
                    'DROP DATABASE '+database+' WITH (FORCE)'),'DATABASE_CLEANUP')
                diagnostics.raise_cleanup()
                diagnostics.completed.append(mode)
            report={'scope':'ISOLATED_LINUX_CI_REAL_CONTROLLER_NOT_PRODUCTION_ADMISSION','releaseSha':sha,
                    'primaryOnlyDbProbe':'PRIMARY_NETWORK_DB_UNREACHABLE','secondaryDbNetworkTopology':True,
                    'oldSha':release.SHIPPING_OLD_SHA,'businessSha':release.SHIPPING_BUSINESS_SHA,
                    'controllerSha256':hashlib.sha256((ROOT/'scripts/deploy-prod-transfer-cas.py').read_bytes()).hexdigest(),
                    'archiveSha256':art['archiveHash'],'loadedImageId':art['loadedDockerImageId'],'cases':cases,
                    'realExecuteLoaded':True,'realBackupRestoreHelper':True,'realImageMigrator':True,
                    'realApplicationContainers':True,'sleepProbeIsBusinessWriterEvidence':False,
                    'productionHostStorageValidated':False,'productionActions':False}
        except BaseException as error:
            diagnostics.primary(error)
            raise
        finally:
            for name in set(owned)|reserved:
                diagnostics.cleanup(lambda name=name: remove_owned(name),'CONTAINER_CLEANUP')
            def remove_network():
                if json.loads(docker('network','inspect',network))[0]['Id']!=network_id:
                    raise RuntimeError('CI_NETWORK_CLEANUP_OWNERSHIP_CHANGED')
                docker('network','rm',network)
            if network_id:diagnostics.cleanup(remove_network,'NETWORK_CLEANUP')
            def remove_db_network():
                if json.loads(docker('network','inspect',db_network))[0]['Id']!=db_network_id:
                    raise RuntimeError('CI_NETWORK_CLEANUP_OWNERSHIP_CHANGED')
                docker('network','rm',db_network)
            if db_network_id:diagnostics.cleanup(remove_db_network,'NETWORK_CLEANUP')
            for key,value in globals_before.items():setattr(release,key,value)
    diagnostics.raise_cleanup()
    report['ownedResourcesRemoved']=True
    target=Path(os.environ['RUNNER_TEMP'])/'shipping-controller-proof.json'
    target.write_text(json.dumps(report,sort_keys=True,indent=2)+'\n');target.chmod(0o644)
    print('ISOLATED_REAL_CONTROLLER_CASES=4_PASS HOST_STORAGE=CI_ADAPTER_PRODUCTION_UNVERIFIED PRODUCTION_ADMISSION=NO')


def material_controller_ci_guard():
    # This is a test entrypoint, never a deployment adapter or SSH target.
    if (os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_OS') != 'Linux'
            or sys.platform != 'linux' or os.geteuid() != 0
            or os.environ.get('GITHUB_REPOSITORY') != 'GPTJJ/budu'
            or os.environ.get('GITHUB_REF') != 'refs/heads/'+release.material_contract()['branch']
            or os.environ.get('TEST_MATERIAL_CONTROLLER_CI') != '1'
            or os.environ.get('DOCKER_HOST') not in (None, 'unix:///var/run/docker.sock')
            or os.environ.get('DOCKER_CONTEXT') or not os.environ.get('RUNNER_TEMP')
            or not re.fullmatch('[0-9a-f]{40}',os.environ.get('GITHUB_SHA',''))):
        raise RuntimeError('MATERIAL_CONTROLLER_ISOLATED_LINUX_CI_REQUIRED')


MATERIAL_FIXTURE_JS = FIXTURE_JS.replace(
    'await assert.rejects(prisma.transferItem.update({where:{id:\'ci-legacy\'},data:{shippedQuantity:6}}));',
    "for(const id of ['ci-legacy','ci-box-row','ci-piece-row'])await prisma.transferItem.update({where:{id},data:{shippedQuantity:6}});"
).replace("process.stdout.write('OLD_CHECK_FIXTURES_OK\\n');", r'''
 await prisma.productCategory.create({data:{id:'pc-munt7jhp-8a5lke',name:'物料',sortOrder:10}});
 await prisma.inventoryItem.createMany({data:Array.from({length:25},(_,i)=>({id:'ci-extra-material-'+i,name:'CI material '+i,category:'material',transferEnabled:true,isActive:false}))});
 await prisma.inventoryItem.createMany({data:['BUDU-BALLSWL-001','BUDU-BALLSWL-002','BUDU-BWDWL-001','BUDU-BDWL-001'].map((sku,i)=>({id:'ci-protected-'+i,name:'CI protected '+i,sku,category:'product',productCategoryId:'pc-munt7jhp-8a5lke',salePriceCents:10n,costPriceCents:10n,isActive:false,transferEnabled:true,partnerReplenishmentEnabled:true,partnerOrderUnit:'NATIVE',partnerMinOrderBaseQty:1,partnerOrderStepBaseQty:1,unit:'个'}))});
 process.stdout.write('MATERIAL_Q86_FIXTURES_OK\n');
''')
# Run 37082232871 proved startup refreshes only these two template timestamps.
# Preserve every other field and row; keep the existing additive quote projection.
MATERIAL_SNAPSHOT_JS = SNAPSHOT_JS.replace(
 "const rows=await prisma.$queryRawUnsafe('SELECT to_jsonb(t) row FROM \"'+tablename.replaceAll('\"','\"\"')+'\" t ORDER BY to_jsonb(t)::text');",
 "const projection='(to_jsonb(t)-$$partnerMaterialPriceCents$$'+(['approval_templates','notification_templates'].includes(tablename)?'-$$updated_at$$':'')+')';\n  const rows=await prisma.$queryRawUnsafe('SELECT '+projection+' row FROM \"'+tablename.replaceAll('\"','\"\"')+'\" t ORDER BY '+projection+'::text');"
)
# Retain the complete projected facts hash. Additional detail derives from the
# SAME captured rows; only hashes travel to Python, never values to diagnostics.
MATERIAL_ROW_DETAIL_JS = r'''
 const primary=(await prisma.$queryRawUnsafe(`SELECT k.column_name FROM information_schema.table_constraints c JOIN information_schema.key_column_usage k ON k.constraint_name=c.constraint_name AND k.table_schema=c.table_schema AND k.table_name=c.table_name WHERE c.constraint_type='PRIMARY KEY' AND c.table_schema='public' AND c.table_name=$1 ORDER BY k.ordinal_position`,tablename)).map(v=>v.column_name);
 const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 const details=Object.create(null);
 for(const {row} of rows){
  const key=digest(primary.length?primary.map(field=>[field,row[field]]):row);
  const fields=Object.create(null);
  for(const field of Object.keys(row))fields[field]=digest(row[field]);
  details[key]=fields;
 }
 rowDetails[tablename]={primaryKey:primary.length>0,rows:details};
'''
MATERIAL_SNAPSHOT_JS = MATERIAL_SNAPSHOT_JS.replace('const facts=[];','const facts=[];const rowDetails=Object.create(null);').replace(
 "facts.push([tablename,rows.length,createHash('sha256').update(JSON.stringify(rows)).digest('hex')]);",
 "facts.push([tablename,rows.length,createHash('sha256').update(JSON.stringify(rows)).digest('hex')]);"+MATERIAL_ROW_DETAIL_JS
).replace('JSON.stringify({facts,ledger,check,version})','JSON.stringify({facts,ledger,check,version,rowDetails})')


def material_fact_difference(before,after):
    """Metadata-only diagnostic; comparison still rejects EVERY facts mismatch."""
    left={name:(count,fingerprint) for name,count,fingerprint in before['facts']}
    right={name:(count,fingerprint) for name,count,fingerprint in after['facts']}
    changed=[name for name in sorted(set(left)|set(right)) if left.get(name)!=right.get(name)]
    report={'totalChangedTables':len(changed),'truncated':len(changed)>128,'tables':[]}
    def identifier(value):
        return value if isinstance(value,str) and re.fullmatch('[A-Za-z_][A-Za-z0-9_]{0,127}',value) else 'UNVERIFIED_IDENTIFIER'
    def fingerprint(value):
        return value if isinstance(value,str) and re.fullmatch('[0-9a-f]{64}',value) else 'UNVERIFIED'
    for name in changed[:128]:
        a=before.get('rowDetails',{}).get(name,{})
        b=after.get('rowDetails',{}).get(name,{})
        old=a.get('rows',{});new=b.get('rows',{})
        fields={};changed_rows=0
        primary=a.get('primaryKey') is True and b.get('primaryKey') is True
        if primary:
            for key in set(old)&set(new):
                columns=[field for field in set(old[key])|set(new[key]) if old[key].get(field)!=new[key].get(field)]
                if columns:changed_rows+=1
                for column in columns:fields[column]=fields.get(column,0)+1
        row={'table':identifier(name),'beforeCount':left.get(name,(None,None))[0],
             'afterCount':right.get(name,(None,None))[0],
             'beforeFingerprint':fingerprint(left.get(name,(None,None))[1]),
             'afterFingerprint':fingerprint(right.get(name,(None,None))[1]),
             'addedRows':len(set(new)-set(old)) if primary else None,
             'removedRows':len(set(old)-set(new)) if primary else None,
             'unmatchedRowFingerprintsAdded':len(set(new)-set(old)),
             'unmatchedRowFingerprintsRemoved':len(set(old)-set(new)),
             'primaryKeyAvailable':primary,'matchedRowsChanged':changed_rows if primary else None,
             'changedFields':[{'field':identifier(field),'rowCount':fields[field]} for field in sorted(fields)[:128]],
             'fieldsTruncated':len(fields)>128}
        report['tables'].append(row)
    return report


class MaterialCiFailureDiagnostics(CiFailureDiagnostics):
    def record(self,error,source,operation=None):
        row=super().record(error,source,operation)
        if hasattr(error,'material_fact_difference'):
            row['materialFactDifference']=error.material_fact_difference
            self.write()
        return row


class MaterialControllerCiRemote(ControllerCiRemote):
    def disk(self):
        # Preserve actual disk measurement, without the old L86 fixture's DML.
        actual=release.LocalRemote.disk(self)
        sample={'used':actual[0],'available':actual[1],'injected':False}
        if self.mode=='post_l86_disk' and self.migrator_started:
            db=super().db()
            if db['applied']==87 and db['failed']==0:
                self.injected=True;sample['injected']=True;self.disk_samples.append(sample)
                return actual[0],1024**2
        self.disk_samples.append(sample)
        return actual


def material_controller_ci(image,old_image,archive):
    material_controller_ci_guard()
    diagnostics=MaterialCiFailureDiagnostics(Path(os.environ['RUNNER_TEMP'])/'material-controller-diagnostic.json',os.environ.get('GITHUB_SHA'))
    # Root is needed by the SAME backup helper to inspect the restore's 0700
    # postgres-owned files. Git trust is process-scoped, including direct ancestry
    # subprocesses in identity(); no global/local Git config is changed.
    git_keys=('GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0')
    git_before={key:os.environ.get(key) for key in git_keys}
    os.environ.update(GIT_CONFIG_COUNT='1',GIT_CONFIG_KEY_0='safe.directory',GIT_CONFIG_VALUE_0=str(ROOT))
    try:
        _material_controller_ci(image,old_image,archive,diagnostics)
    except BaseException as error:
        if diagnostics.primary_error is not None and error is not diagnostics.primary_error:
            diagnostics.cleanup(lambda: (_ for _ in ()).throw(error),'TEMP_DIRECTORY_CLEANUP')
            raise diagnostics.primary_error.with_traceback(diagnostics.primary_traceback) from None
        if diagnostics.primary_error is None and diagnostics.cleanup_error is not None and error is not diagnostics.cleanup_error:
            diagnostics.cleanup(lambda: (_ for _ in ()).throw(error),'TEMP_DIRECTORY_CLEANUP')
            raise diagnostics.cleanup_error from None
        diagnostics.primary(error)
        raise
    finally:
        for key,value in git_before.items():
            if value is None:os.environ.pop(key,None)
            else:os.environ[key]=value


def _material_controller_ci(image,old_image,archive,diagnostics):
    release.configure_profile('post-transfer',release.material_contract()['oldSha'],release.material_contract()['businessSha'],
        hashlib.sha256(release.command(['git','-c','safe.directory='+str(ROOT),'-C',str(ROOT),
                                       'show',release.material_contract()['oldSha']+':server/v2.js'])).hexdigest())
    identity,ledger=release.identity(ROOT);sha=os.environ['GITHUB_SHA']
    if identity!=sha or image!=release.image_reference(sha):raise RuntimeError('CI_EXACT_SOURCE_REQUIRED')
    old_config=json.loads(docker('image','inspect',old_image))[0]
    if (old_image!='budu-api:material-old-72c780c1dbb5' or old_config['Config'].get('Labels',{}).get(release.REVISION)!=release.material_contract()['oldSha']
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
        suffix=root.name.removeprefix('shipping-controller-');network='shipping-ci-net-'+suffix;db_network='shipping-ci-db-net-'+suffix;pg='shipping-ci-pg-'+suffix
        database='shipping_ci_'+suffix.replace('-','_');url='postgresql://postgres:fixture_only@'+pg+':5432/'+database
        globals_before={key:getattr(release,key) for key in ('PG','EXPECTED_DB','NGINX','TEMPLATE','CURRENT_SHA_FILE','LOCK')}
        release.PG=pg;release.EXPECTED_DB=database
        owned={};reserved=set();network_id=None;db_network_id=None
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
            db_network_id=docker('network','create','--internal',db_network)
            if json.loads(docker('network','inspect',db_network))[0]['Internal'] is not True:raise RuntimeError('CI_NETWORK_EGRESS_NOT_BLOCKED')
            owned[pg]=docker('run','-d','--name',pg,'--network',db_network,'-e','POSTGRES_PASSWORD=fixture_only','postgres:16.14',timeout=180)
            for _ in range(60):
                ready=subprocess.run(['docker','exec',pg,'pg_isready','-U','postgres'],capture_output=True,timeout=5)
                if ready.returncode==0:break
                time.sleep(0.25)
            else:raise RuntimeError('CI_POSTGRES_NOT_READY')
            primary_probe = "const net=require('node:net');const u=new URL(process.env.DATABASE_URL);const s=net.createConnection({host:u.hostname,port:5432});s.setTimeout(2000);s.on('connect',()=>{s.destroy();process.exit(3)});const done=()=>{s.destroy();process.stdout.write('PRIMARY_NETWORK_DB_UNREACHABLE');};s.once('error',done);s.once('timeout',done);"
            if docker('run','--rm','--network',network,'-e','DATABASE_URL='+url,'--entrypoint','node',image,'-e',primary_probe)!='PRIMARY_NETWORK_DB_UNREACHABLE':raise RuntimeError('CI_PRIMARY_NETWORK_UNEXPECTED_DB_ACCESS')
            docker('pull','nginx:1.28-alpine',timeout=180)
            for index,mode in enumerate(CI_CASES):
                diagnostics.case=mode
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
                docker('run','--rm','--network',db_network,'-e','DATABASE_URL='+url,'--entrypoint','node',old_image,
                       '/app/node_modules/prisma/build/index.js','migrate','deploy','--schema','/app/prisma/schema.prisma',timeout=180)
                docker('run','--rm','--network',db_network,'-e','DATABASE_URL='+url,'-e','APP_ENV=test','--entrypoint','node',old_image,
                       '--input-type=module','-e',MATERIAL_FIXTURE_JS)
                data=case_root/'data';data.mkdir(mode=0o700);os.chown(data,1000,1000)
                routes='server { listen 80; location / { proxy_pass http://'+old+':3000; } location /api/ { proxy_pass http://'+old+':3000; } location /health-proxy { proxy_pass http://'+old+':3000; } }\n'
                (case_root/'template').write_text(routes);(case_root/'current-sha').write_text(release.material_contract()['oldSha']+'\n')
                conf=case_root/'conf';conf.mkdir();(conf/'budu.conf').write_text(routes)
                owned[old]=docker('create','--name',old,'--network',network,'--restart','unless-stopped','--log-driver','json-file',
                       '--label','budu.production-role=candidate','--label',release.REVISION+'='+release.material_contract()['oldSha'],
                       '-e','DATABASE_URL='+url,'-e','APP_ENV=test','-e','DATA_STORE=file','-e','DATA_DIR=/app/server/data',
                       '-e','WECHAT_PAY_ENABLED=0','-e','ALIPAY_ENABLED=0','-e','GIT_SHA='+release.material_contract()['oldSha'],
                       '-e','CUSTOMER_REQUEST_WECOM_RECIPIENT_USERNAME=budu','-e','CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID=dh',
                       '--mount','type=bind,source='+str(data)+',target=/app/server/data',old_image)
                docker('network','connect',db_network,old)
                docker('start',old)
                for _ in range(150):
                    info=json.loads(docker('inspect',old))[0]
                    if info['State'].get('Health',{}).get('Status')=='healthy':break
                    if not info['State']['Running']:raise RuntimeError('CI_REAL_OLD_APP_START_FAILED')
                    time.sleep(0.5)
                else:raise RuntimeError('CI_REAL_OLD_APP_NOT_HEALTHY')
                owned[nginx]=docker('run','-d','--name',nginx,'--network',network,'--mount','type=bind,source='+str(conf)+',target=/etc/nginx/conf.d',
                                   'nginx:1.28-alpine')
                remote=MaterialControllerCiRemote(case_root,network,old,candidate,mode,db_network)
                before_snapshot=json.loads(docker('exec','-w','/app',old,'node','--input-type=module','-e',MATERIAL_SNAPSHOT_JS))
                before_facts=before_snapshot['facts']
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
                    verify_controller_failure(error,expected)
                else:
                    if expected or json.loads(result.getvalue())['result']!='DEPLOY_COMPLETE':raise RuntimeError('CI_CONTROLLER_EXPECTED_FAILURE_MISSING')
                writer=candidate if mode=='success' else old
                after_snapshot=json.loads(docker('exec','-w','/app',writer,'node','--input-type=module','-e',MATERIAL_SNAPSHOT_JS))
                after_facts=after_snapshot['facts']
                if before_facts!=after_facts:
                    error=RuntimeError('CI_MATERIAL_BUSINESS_FACTS_CHANGED')
                    error.material_fact_difference=material_fact_difference(before_snapshot,after_snapshot)
                    raise error
                final=remote.db();expected_ledger=release.before_ledger(ledger) if mode=='backup_limit' else ledger
                release.validate_database(final,expected_ledger)
                release.writer_check(remote.containers(),final,[writer])
                if release.route_target(*remote.routes())!=writer or (case_root/'current-sha').read_text().strip()!=(sha if mode=='success' else release.material_contract()['oldSha']):raise RuntimeError('CI_ROUTE_OR_POINTER_NOT_RECONCILED')
                if (case_root/'lock').exists():raise RuntimeError('CI_KNOWN_PHASE_LOCK_NOT_RELEASED')
                if mode in ('post_cutover_failure','post_l86_disk'):
                    docker('exec','-w','/app',old,'node','--input-type=module','-e',OLD_COMPAT_JS)
                cleanup_count=docker('exec',pg,'psql','-X','-qAt','-U','postgres','-d',database,'-c',
                    "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND (application_name LIKE 'budu_shipping_backup_%' OR application_name='budu_shipping_migrator') AND pid<>pg_backend_pid()")
                if cleanup_count!='0':raise RuntimeError('CI_BACKUP_OR_MIGRATOR_CONNECTIONS_REMAIN')
                proof_path=case_root/'rollback'/(release.ROLLBACK_PREFIX+sha)/'backup-restore-proof.json'
                backup=json.loads(proof_path.read_text()) if proof_path.exists() else None
                if mode!='backup_limit' and (not backup or not backup['terminationVerified'] or not backup['restoreVerified'] or remote.inspect(restore)['State']['Running']):raise RuntimeError('CI_REAL_BACKUP_RESTORE_NOT_PROVEN')
                old_networks=remote.inspect(old)['NetworkSettings']['Networks']
                if set(old_networks)!={network,db_network}:raise RuntimeError('CI_DUAL_NETWORK_SOURCE_REQUIRED')
                migrator_networks=remote.inspect(migrator)['NetworkSettings']['Networks'] if mode!='backup_limit' else None
                if migrator_networks is not None and ({k:v.get('NetworkID') for k,v in migrator_networks.items()}!={k:v.get('NetworkID') for k,v in old_networks.items()}):raise RuntimeError('CI_MIGRATOR_NETWORK_PARITY_FAILED')
                starts=[event for event in remote.events if event=={'action':'start','container':migrator}]
                if len(starts)!=(0 if mode=='backup_limit' else 1) or (mode!='success' and not remote.injected):raise RuntimeError('CI_MIGRATOR_OR_INJECTION_NOT_OBSERVED')
                cases.append({'case':mode,'controller':'execute_loaded','result':'PASS','migrations':final['applied'],
                              'check':final['check'],'materialSchema':final['materialSchema'],'allBusinessTableFactsUnchanged':True,'writer':writer,'writerSamples':remote.writer_samples,'events':remote.events,
                              'diskSamples':remote.disk_samples,'backupRestoreProof':backup,'backupAndMigratorConnections':0,
                              'actual6OldHttpSummaryXlsx':mode in ('post_cutover_failure','post_l86_disk'),'failureInjection':expected,
                              'hostStorageActual':remote.host_storage,'hostStorageGate':'CI_FIXTURE_ADAPTER_PRODUCTION_UNVERIFIED',
                              'automaticDnsAliasAdaptations':remote.alias_adaptations,'lockRemoved':True,
                              'secondaryDbNetworkTopology':True,'migratorNetworksMatchOld':migrator_networks is not None,
                              'migratorPreStartNetworks':remote.migrator_prestart_networks})
                for name in names:
                    diagnostics.cleanup(lambda name=name: remove_owned(name),'CONTAINER_CLEANUP')
                diagnostics.cleanup(lambda: docker('exec',pg,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-c',
                    'DROP DATABASE '+database+' WITH (FORCE)'),'DATABASE_CLEANUP')
                diagnostics.raise_cleanup()
                diagnostics.completed.append(mode)
            report={'scope':'ISOLATED_MATERIAL_Q86_L87_REAL_CONTROLLER_NOT_PRODUCTION_ADMISSION','releaseSha':sha,
                    'primaryOnlyDbProbe':'PRIMARY_NETWORK_DB_UNREACHABLE','secondaryDbNetworkTopology':True,
                    'oldSha':release.material_contract()['oldSha'],'businessSha':release.material_contract()['businessSha'],
                    'controllerSha256':hashlib.sha256((ROOT/'scripts/deploy-prod-transfer-cas.py').read_bytes()).hexdigest(),
                    'archiveSha256':art['archiveHash'],'loadedImageId':art['loadedDockerImageId'],'cases':cases,
                    'realExecuteLoaded':True,'realBackupRestoreHelper':True,'realImageMigrator':True,
                    'realApplicationContainers':True,'sleepProbeIsBusinessWriterEvidence':False,
                    'productionHostStorageValidated':False,'productionActions':False}
        except BaseException as error:
            diagnostics.primary(error)
            raise
        finally:
            for name in set(owned)|reserved:
                diagnostics.cleanup(lambda name=name: remove_owned(name),'CONTAINER_CLEANUP')
            def remove_network():
                if json.loads(docker('network','inspect',network))[0]['Id']!=network_id:
                    raise RuntimeError('CI_NETWORK_CLEANUP_OWNERSHIP_CHANGED')
                docker('network','rm',network)
            if network_id:diagnostics.cleanup(remove_network,'NETWORK_CLEANUP')
            def remove_db_network():
                if json.loads(docker('network','inspect',db_network))[0]['Id']!=db_network_id:
                    raise RuntimeError('CI_NETWORK_CLEANUP_OWNERSHIP_CHANGED')
                docker('network','rm',db_network)
            if db_network_id:diagnostics.cleanup(remove_db_network,'NETWORK_CLEANUP')
            for key,value in globals_before.items():setattr(release,key,value)
    diagnostics.raise_cleanup()
    report['ownedResourcesRemoved']=True
    target=Path(os.environ['RUNNER_TEMP'])/'material-controller-proof.json'
    target.write_text(json.dumps(report,sort_keys=True,indent=2)+'\n');target.chmod(0o644)
    print('ISOLATED_MATERIAL_REAL_CONTROLLER_CASES=4_PASS HOST_STORAGE=CI_ADAPTER_PRODUCTION_UNVERIFIED PRODUCTION_ADMISSION=NO')


# Procurement fixture entrypoint: exact hosted Linux source, internal networks,
# synthetic rows, no production credentials or external notification target.
def procurement_controller_ci_guard():
    if (os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_OS')!='Linux'
            or sys.platform!='linux' or os.geteuid()!=0 or os.environ.get('GITHUB_REPOSITORY')!='GPTJJ/budu'
            or os.environ.get('GITHUB_REF') not in ('refs/heads/'+release.procurement_contract()['branch'],'refs/heads/'+release.B1_BRANCH,'refs/heads/'+release.B2_BRANCH)
            or os.environ.get('TEST_PROCUREMENT_CONTROLLER_CI')!='1'
            or os.environ.get('DOCKER_HOST') not in (None,'unix:///var/run/docker.sock')
            or os.environ.get('DOCKER_CONTEXT') or not os.environ.get('RUNNER_TEMP')
            or not re.fullmatch('[0-9a-f]{40}',os.environ.get('GITHUB_SHA',''))):
        raise RuntimeError('PROCUREMENT_CONTROLLER_ISOLATED_LINUX_CI_REQUIRED')


PROCUREMENT_FIXTURE_JS = FIXTURE_JS.replace(
    "await assert.rejects(prisma.transferItem.update({where:{id:'ci-legacy'},data:{shippedQuantity:6}}));",
    "await prisma.supplier.create({data:{id:'ci-old-supplier',name:'CI old supplier'}});"
    "await prisma.purchaseRequest.create({data:{id:'ci-old-purchase',storeKey:'guanshe',supplierId:'ci-old-supplier',status:'received',items:{create:[{id:'ci-old-purchase-line',itemId:'ci-material',orderedQty:4,receivedQty:6}]}}});"
)
PROCUREMENT_SNAPSHOT_JS = SNAPSHOT_JS.replace(
    "tablename<>'_prisma_migrations'", "tablename<>'_prisma_migrations' AND tablename NOT LIKE 'Procurement%'"
).replace(
 "const rows=await prisma.$queryRawUnsafe('SELECT to_jsonb(t) row FROM \"'+tablename.replaceAll('\"','\"\"')+'\" t ORDER BY to_jsonb(t)::text');",
 "const projection='(to_jsonb(t)'+(tablename==='InventoryItem'?'-$$purchaseEnabled$$-$$procurementSupplierId$$':'')+(['approval_templates','notification_templates'].includes(tablename)?'-$$updated_at$$':'')+')';\n  const rows=await prisma.$queryRawUnsafe('SELECT '+projection+' row FROM \"'+tablename.replaceAll('\"','\"\"')+'\" t ORDER BY '+projection+'::text');"
)
PROCUREMENT_RETAINED_FIXTURE_JS=r'''
import {prisma} from './server/pg.js';
try {await prisma.$transaction(async tx=>{
 await tx.procurementSupplier.create({data:{id:'ci-new-supplier',name:'CI new supplier',createdById:'ci-developer'}});
 await tx.procurementOrder.create({data:{id:'ci-new-order',storeKey:'guanshe',supplierId:'ci-new-supplier',status:'ORDERED',createdById:'ci-developer',createdByName:'CI',createRequestKey:'ci-new-order',createPayloadHash:'fixture',lines:{create:[{id:'ci-new-line',inventoryItemId:'ci-material',productNameSnapshot:'CI material',unitSnapshot:'克',orderedQty:'10.000',linePosition:0}]}}});
 await tx.procurementReceipt.create({data:{id:'ci-new-receipt',orderId:'ci-new-order',sequence:1,status:'PENDING',receivedDate:new Date('2026-10-04'),registeredById:'ci-developer',submittedById:'ci-developer',submittedByName:'CI',createRequestKey:'ci-new-receipt',createPayloadHash:'fixture'}});
 await tx.procurementReceiptLine.create({data:{id:'ci-new-receipt-line',orderId:'ci-new-order',receiptId:'ci-new-receipt',orderLineId:'ci-new-line',receivedQty:'9.980'}});
 await tx.procurementAudit.create({data:{id:'ci-new-audit',entityId:'ci-new-receipt',orderId:'ci-new-order',action:'SUBMIT_RECEIPT',actorId:'ci-developer',actorName:'CI',operationKey:'ci-new-audit',payloadHash:'fixture'}});
 await tx.procurementNotificationEvent.createMany({data:['SENT','FAILED','UNKNOWN'].map((status,i)=>({id:'ci-new-event-'+i,receiptId:'ci-new-receipt',submissionRevision:1,recipientUserId:'ci-isolated-'+i,notificationId:'ci-new-event-'+i,status}))});
});process.stdout.write('SYNTHETIC_PROCUREMENT_ROWS_CREATED');}finally{await prisma.$disconnect()}
'''


def verify_procurement_recovery_facts(from_ledger, before, after, old_before, old_after, schema):
    # The exact L88 migration creates seven empty tables. L87 has none to
    # retain; L88 recovery must retain every existing row hash without change.
    if old_before!=old_after:raise RuntimeError('CI_FORMAL_RECOVERY_PROTECTED_FACTS_CHANGED')
    if schema.get('schemaMd5')!=release.procurement_contract()['schemaMd5']:
        raise RuntimeError('CI_FORMAL_RECOVERY_PROCUREMENT_SCHEMA_CHANGED')
    if from_ledger==87:
        expected=[{'name':name,'count':0,'hash':hashlib.md5(b'').hexdigest()} for name in sorted(release.PROCUREMENT_TABLES)]
        if before!=[] or after!=expected:raise RuntimeError('CI_FORMAL_RECOVERY_L87_EMPTY_TABLES_INVALID')
        policy='L87_ABSENT_TO_L88_SEVEN_EMPTY_TABLES'
    elif from_ledger==88:
        if sorted(row['name'] for row in before)!=sorted(release.PROCUREMENT_TABLES) or after!=before:
            raise RuntimeError('CI_FORMAL_RECOVERY_PROCUREMENT_FACTS_CHANGED')
        policy='L88_STRICT_EXISTING_ROW_HASHES_UNCHANGED'
    else:raise RuntimeError('CI_FORMAL_RECOVERY_LEDGER_INVALID')
    return {'fromLedger':from_ledger,'toLedger':88,'newTablePolicy':policy,
            'protectedOldFactsUnchanged':True,'procurementSchemaMd5':schema['schemaMd5'],
            'before':before,'after':after}


def wait_owned_procurement_rollback_healthy(remote, name, container_id, image_id, sha, mode):
    # CI fixture readiness only: observe actual Docker state before the formal
    # controller. Never synthesize Health or relax its independent health gate.
    rollback_sha=release.procurement_contract()['rollbackSha']
    cases=('post_cutover_failure','backup_limit','post_restore_failure','post_migrator_create_failure')
    valid=(mode in cases and re.fullmatch('[0-9a-f]{40}',sha or '')
           and re.fullmatch('[0-9a-f]{64}',container_id or '')
           and re.fullmatch('sha256:[0-9a-f]{64}',image_id or '')
           and name=='budu-prod-'+rollback_sha[:12]+'-purchase-compat-'+sha[:12])
    started=time.monotonic();deadline=started+75
    proof={'scope':'OWNED_PROCUREMENT_CI_R','case':mode if mode in cases else 'INVALID',
           'exactSHA':sha if valid else 'INVALID','rollbackSHA':rollback_sha,
           'expectedContainerIdHash':hashlib.sha256(container_id.encode()).hexdigest() if valid else 'INVALID',
           'expectedImageId':image_id if valid else 'INVALID','timeoutSeconds':75,
           'observations':[],'result':'FAILED','code':'CI_RECOVERY_R_INSPECT_UNVERIFIED'}
    try:
        if not valid:raise RuntimeError('CI_RECOVERY_R_IDENTITY_INVALID')
        for _ in range(151):
            remaining=deadline-time.monotonic()
            if remaining<=0:raise RuntimeError('CI_RECOVERY_R_HEALTH_TIMEOUT')
            try:
                values=json.loads(remote.run(['docker','inspect',name],timeout=min(10,remaining)))
                if not isinstance(values,list) or len(values)!=1 or not isinstance(values[0],dict):
                    raise RuntimeError('CI_RECOVERY_R_INSPECT_UNVERIFIED')
                current=values[0];config=current.get('Config',{});state=current.get('State',{})
                matches={'containerId':current.get('Id')==container_id,'name':current.get('Name')=='/'+name,
                         'imageId':current.get('Image')==image_id,
                         'imageReference':config.get('Image')==release.image_reference(rollback_sha),
                         'revision':config.get('Labels',{}).get(release.REVISION)==rollback_sha,
                         'gitSHA':release.env(current).get('GIT_SHA')==rollback_sha}
                status=state.get('Status');health=state.get('Health',{}).get('Status')
                proof['observations'].append({'elapsedMs':max(0,round((time.monotonic()-started)*1000)),
                    'stateStatus':status if status in ('created','running','paused','restarting','removing','exited','dead') else 'UNVERIFIED',
                    'running':state.get('Running') if type(state.get('Running')) is bool else 'UNVERIFIED',
                    'restarting':state.get('Restarting') if type(state.get('Restarting')) is bool else 'UNVERIFIED',
                    'paused':state.get('Paused') if type(state.get('Paused')) is bool else 'UNVERIFIED',
                    'healthStatus':health if health in ('starting','healthy','unhealthy') else 'UNVERIFIED',
                    'identityMatches':matches})
            except Exception:
                raise RuntimeError('CI_RECOVERY_R_INSPECT_UNVERIFIED') from None
            if not all(matches.values()):raise RuntimeError('CI_RECOVERY_R_IDENTITY_INVALID')
            if (state.get('Running') is not True or status!='running'
                    or state.get('Restarting') is not False or state.get('Paused') is not False):
                raise RuntimeError('CI_RECOVERY_R_NOT_RUNNING')
            if time.monotonic()>=deadline:raise RuntimeError('CI_RECOVERY_R_HEALTH_TIMEOUT')
            if health=='healthy':
                proof.update(result='READY',code='DOCKER_HEALTHY');return proof
            if health!='starting':raise RuntimeError('CI_RECOVERY_R_HEALTH_UNVERIFIED')
            remaining=deadline-time.monotonic()
            if remaining<=0:raise RuntimeError('CI_RECOVERY_R_HEALTH_TIMEOUT')
            time.sleep(min(0.5,remaining))
        raise RuntimeError('CI_RECOVERY_R_HEALTH_TIMEOUT')
    except RuntimeError as error:
        proof['code']=str(error) if str(error) in (
            'CI_RECOVERY_R_IDENTITY_INVALID','CI_RECOVERY_R_INSPECT_UNVERIFIED',
            'CI_RECOVERY_R_NOT_RUNNING','CI_RECOVERY_R_HEALTH_TIMEOUT',
            'CI_RECOVERY_R_HEALTH_UNVERIFIED') else 'DETAILS_SUPPRESSED'
        raise
    finally:
        # Log safe State/Health observations on both success and failure; raw
        # inspect Env, Health.Log, command output and exceptions stay private.
        print(json.dumps({'procurementRReadiness':proof},sort_keys=True),file=sys.stderr)


class ProcurementControllerCiRemote(ControllerCiRemote):
    def __init__(self,*args,**kwargs):
        self.reserved_resources=kwargs.pop('reserved_resources',set())
        super().__init__(*args,**kwargs);self.rollback_fault=None;self.rollback_fault_injected=False
        self.attempt_resources={};self.latest_restore=None;self.latest_migrator=None;self.restore_verified=False
        self.compatible_name='budu-prod-'+release.procurement_contract()['rollbackSha'][:12]+'-purchase-compat-'+os.environ['GITHUB_SHA'][:12]

    def is_compatible(self,name):
        if name==self.compatible_name:return True
        if not re.fullmatch('[0-9a-f]{64}',name):return False
        if not release.LocalRemote.run(self,['docker','ps','-aq','--filter','name=^/'+self.compatible_name+'$']).strip():return False
        return name==release.LocalRemote.inspect(self,self.compatible_name)['Id']

    def compatible_running(self):
        if not release.LocalRemote.run(self,['docker','ps','-aq','--filter','name=^/'+self.compatible_name+'$']).strip():return False
        return release.LocalRemote.inspect(self,self.compatible_name)['State']['Running']

    def run(self,args,data=None,timeout=60):
        if (self.rollback_fault=='stop' and args[:2]==['docker','stop'] and self.is_compatible(args[-1])):
            self.rollback_fault_injected=True;raise release.GateError('COMMAND_FAILED')
        if args[:2]==['docker','start'] and self.attempt_resources.get(args[-1])=='migrator':
            created=release.LocalRemote.inspect(self,args[-1])
            self.migrator_prestart_networks={k:v.get('NetworkID') for k,v in created['NetworkSettings']['Networks'].items()}
        result=super().run(args,data,timeout)
        if args[:2]==['docker','start'] and self.attempt_resources.get(args[-1])=='migrator':self.migrator_started=True
        if self.rollback_fault in ('runtime','prisma') and self.compatible_name in args:
            if self.rollback_fault=='runtime' and args[-2:]==['sha256sum','/app/server/v2.js']:
                self.rollback_fault_injected=True;return ('0'*64+'  source').encode()
            if self.rollback_fault=='prisma' and '--input-type=module' in args:
                self.rollback_fault_injected=True;raise release.GateError('COMMAND_FAILED')
        return result

    def py(self,code,value=None,timeout=60):
        if 'run_loaded_controller(v)' in code and value and 'art' in value:
            # CI transport adapter for the SAME formal deploy handoff. Execute
            # the exact loaded controller against real owned Docker/PG/files.
            out=io.StringIO()
            try:
                with contextlib.redirect_stdout(out):
                    release.execute_loaded(self,value['art'],value['ledger'],value['helper'],value['oldId'],value['routeHash'])
            except release.GateError as error:
                return json.dumps({'result':error.deployment_result,'failureGate':error.failure_stage,'code':str(error)})
            return out.getvalue()
        if code in (release.SHIPPING_BACKUP_RESTORE_CODE,release.SHIPPING_MIGRATOR_CREATE_CODE):
            role='restore' if code==release.SHIPPING_BACKUP_RESTORE_CODE else 'migrator'
            name=value['restore' if role=='restore' else 'name']
            pattern='budu-shipping-'+role+'-'+os.environ['GITHUB_SHA'][:12]
            if release.EXPECTED_OLD_SHA==release.procurement_contract()['rollbackSha']:pattern+=r'-resume-[0-9a-f]{16}'
            if not re.fullmatch(pattern,name):raise RuntimeError('CI_ATTEMPT_RESOURCE_NAME_INVALID')
            self.attempt_resources[name]=role;self.reserved_resources.add(name)
            if role=='restore':self.latest_restore=name
            else:self.latest_migrator=name
        result=super().py(code,value,timeout)
        if code==release.SHIPPING_BACKUP_RESTORE_CODE:self.restore_verified=True
        if code==release.SHIPPING_MIGRATOR_CREATE_CODE and self.mode=='post_migrator_create_failure':
            self.injected=True;raise release.GateError('COMMAND_FAILED')
        if value and not self.rollback_fault_injected:
            if self.rollback_fault=='routes' and value.get('path')==release.TEMPLATE and 'http://'+self.compatible_name+':3000' in value.get('text',''):
                self.rollback_fault_injected=True;raise release.GateError('COMMAND_FAILED')
            if self.rollback_fault=='pointer' and value.get('path')==release.CURRENT_SHA_FILE and value.get('text','').strip()==release.procurement_contract()['rollbackSha']:
                self.rollback_fault_injected=True;raise release.GateError('COMMAND_FAILED')
            if (self.rollback_fault=='facts' and value.get('sql','').startswith('SELECT json_agg(row_to_json(v)')
                    and 'ProcurementAudit' in value['sql'] and self.compatible_running()):
                facts=json.loads(result);facts[0]['hash']='0'*32;self.rollback_fault_injected=True
                return json.dumps(facts)
        return result

    def disk(self):
        actual=release.LocalRemote.disk(self);sample={'used':actual[0],'available':actual[1],'injected':False}
        if self.mode=='post_restore_failure' and self.restore_verified:
            self.injected=True;sample['injected']=True;sample['ledgerAtInjection']=87
            self.disk_samples.append(sample);return actual[0],1024**2
        # Retain the legacy diagnostic case key; trigger is explicitly L88.
        if self.mode=='post_l86_disk' and self.migrator_started:
            db=super().db()
            if db['applied']==88 and db['failed']==0:
                self.injected=True;sample['injected']=True;sample['ledgerAtInjection']=88
                self.disk_samples.append(sample);return actual[0],1024**2
        self.disk_samples.append(sample);return actual

    def health(self,name,sha,public=False):
        if not public:
            result=release.LocalRemote.health(self,name,sha)
            if name==self.compatible_name and self.rollback_fault in ('health','stop'):
                self.rollback_fault_injected=True;raise release.GateError('HEALTH_FAILED')
            return result
        for _ in range(20):
            try:
                h=json.loads(self.run(['docker','exec',release.NGINX,'wget','-qO-','http://127.0.0.1/api/health'],timeout=10))
                if h.get('ok') is True and h.get('dbOk') is True and h.get('gitSha') in (sha,sha[:12]):
                    if self.mode=='post_cutover_failure' and name==self.candidate and not self.injected:
                        docker('exec','-w','/app',name,'node','--input-type=module','-e',PROCUREMENT_RETAINED_FIXTURE_JS)
                        self.retained_before_rollback=release.procurement_facts(self)
                        self.injected=True;raise release.GateError('HEALTH_FAILED')
                    if name==self.compatible_name and self.rollback_fault=='public':
                        self.rollback_fault_injected=True;raise release.GateError('HEALTH_FAILED')
                    return
            except (ValueError,release.GateError):
                if self.injected:raise
            time.sleep(.25)
        raise release.GateError('HEALTH_FAILED')



def b2_allocation_ci(archive, compatible_archive):
    """Offline exact B1 E/R physical allocation, both empty-daemon orders.

    No production transport, data or credentials. Observed import peaks are
    explicitly lower bounds; conservative L/W/reserve budgets are not reduced.
    """
    branch='refs/heads/codex/purchase-receipt-b2-capacity-fasttrack'
    if (os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('GITHUB_REF')!=branch
            or os.environ.get('GITHUB_REPOSITORY')!='GPTJJ/budu' or os.environ.get('RUNNER_OS')!='Linux'
            or sys.platform!='linux' or os.geteuid()!=0 or not os.environ.get('RUNNER_TEMP')):
        raise RuntimeError('B2_ISOLATED_RUNNER_REQUIRED')
    exact='7364b050ea58a7dc0e4227eaa8cbdd8c8d1c5524'
    expected={'E':'8c2e92a0c9a4f74d598893f875a87c3579c99cdf5e1e3414220822cd70236f4b',
              'R':'fd7d56c195c4b0fff477d5e9ebf263919d385a4b4f152fad8753c5855ec4afed'}
    paths={'E':Path(archive).resolve(),'R':Path(compatible_archive).resolve()}
    proof={'scope':'ISOLATED_EXACT_B1_E_FIXED_R_ALLOCATION_NOT_PRODUCTION',
           'sourceSha':os.environ['GITHUB_SHA'],'exactESha':exact,'productionAccess':False,
           'orders':{},'peakSamplesAreLowerBounds':True,'sampleDBBytes':164142103,
           'sampleFreeBytes':15964217344,'productionUsedBytes':'UNAVAILABLE'}
    output=Path(os.environ['RUNNER_TEMP'])/'b2-allocation-proof.json'
    def save():output.write_text(json.dumps(proof,indent=2)+'\n')
    save()
    keys=('GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0')
    before={k:os.environ.get(k) for k in keys}
    os.environ.update(GIT_CONFIG_COUNT='1',GIT_CONFIG_KEY_0='safe.directory',GIT_CONFIG_VALUE_0=str(ROOT))
    try:
        for role,path in paths.items():
            with path.open('rb') as stream:
                if hashlib.file_digest(stream,'sha256').hexdigest()!=expected[role]:raise RuntimeError('B2_EXACT_ARCHIVE_REQUIRED')
        release.configure_profile('post-transfer',release.procurement_contract()['oldSha'],release.procurement_contract()['businessSha'],
            hashlib.sha256(release.command(['git','-C',str(ROOT),'show',release.procurement_contract()['oldSha']+':server/v2.js'])).hexdigest())
        # The measured E contains its exact 7364 scripts, not this new harness.
        # Validate the entire payload against an immutable exact Git checkout.
        with tempfile.TemporaryDirectory(prefix='b2-exact-source-',dir=os.environ['RUNNER_TEMP']) as source:
            subprocess.run(['git','clone','--quiet','--no-hardlinks','--no-checkout',str(ROOT),source],check=True)
            subprocess.run(['git','-C',source,'checkout','--quiet','--detach',exact],check=True)
            arts={'E':release.artifact(paths['E'],exact,source),'R':release.compatibility_artifact(source,paths['R'])}
        proof['artifacts']={role:{k:a[k] for k in ('release','archive','archiveHash','archiveConfigDigest','blobs','expanded','largest','layers','imageReference')} for role,a in arts.items()}
        with tempfile.TemporaryDirectory(prefix='b2-model-',dir=os.environ['RUNNER_TEMP']) as td:
            root=Path(td);tag=root.name+':fixture'
            subprocess.run(['docker','build','--tag',tag,'-'],input=b'FROM docker:29.1.3-dind\nRUN apk add --no-cache python3 coreutils\n',check=True,timeout=240)
            for order in ('RE','ER'):
                mount=root/order;mount.mkdir();disk=root/(order+'.ext4')
                with disk.open('wb') as f:f.truncate(24*1024**3)
                subprocess.run(['mkfs.ext4','-q','-F',str(disk)],check=True)
                subprocess.run(['mount','-o','loop',str(disk),str(mount)],check=True)
                name=root.name+'-'+order;ident=None
                try:
                    for sub in ('docker','containerd','staging'):(mount/sub).mkdir()
                    boot="containerd --root /var/lib/containerd --state /run/containerd --address /run/containerd/containerd.sock >/tmp/containerd.log 2>&1 &\nfor i in $(seq 1 60); do test -S /run/containerd/containerd.sock && break; sleep 1; done\nexec dockerd --containerd /run/containerd/containerd.sock --containerd-namespace moby --feature containerd-snapshotter --iptables=false --ip6tables=false --bridge=none --host unix:///var/run/docker.sock"
                    ident=docker('run','-d','--privileged','--network','none','--name',name,'--label','budu.b2-model='+os.environ['GITHUB_SHA'],
                        '--mount','type=bind,source='+str(mount/'docker')+',target=/var/lib/docker',
                        '--mount','type=bind,source='+str(mount/'containerd')+',target=/var/lib/containerd',
                        '--mount','type=bind,source='+str(mount/'staging')+',target=/fixture/staging',
                        '--tmpfs','/run','--entrypoint','sh',tag,'-c',boot)
                    def run(args,timeout=60):return subprocess.check_output(['docker','exec',name,*args],timeout=timeout)
                    for _ in range(60):
                        ready=subprocess.run(['docker','exec',name,'docker','info','--format','{{.ServerVersion}}'],capture_output=True)
                        if ready.returncode==0:break
                        time.sleep(1)
                    else:raise RuntimeError('B2_DAEMON_NOT_READY')
                    def allocated():return sum(int(subprocess.check_output(['du','-sx','--block-size=1',str(mount/s)]).split()[0]) for s in ('docker','containerd'))
                    def df():return tuple(map(int,subprocess.check_output(['df','-B1','--output=used,avail',str(mount)]).decode().splitlines()[1].split()))
                    def inventory():
                        code=release.B1_STORAGE_CODE.replace("os.stat('/')","os.stat('/var/lib/docker')")
                        return json.loads(subprocess.check_output(['docker','exec','-i',name,'python3','-B','-c',code],input=b'null'))
                    info=json.loads(run(['docker','info','--format','{{json .}}']));assert info['LiveRestoreEnabled'] is False
                    base=allocated();bu,bf=df();entry={'beforeAllocated':base,'beforeUsed':bu,'beforeFree':bf,'imports':[],'liveRestore':False};proof['orders'][order]=entry
                    for role in order:
                        a=arts[role];pre=allocated();u,f=df();samples=[];done=threading.Event();errors=[]
                        staged=mount/'staging'/'R.tar'
                        if role=='R':shutil.copyfile(paths[role],staged)
                        def sample():
                            while not done.is_set():
                                try:samples.append({'allocated':allocated(),'used':df()[0]})
                                except BaseException as e:errors.append(type(e).__name__)
                                done.wait(.2)
                        observer=threading.Thread(target=sample);observer.start()
                        receipt={'bytes':0,'sha256':None,'serverProcessWaited':False,'boundedChunkBytes':1024**2}
                        proc=subprocess.Popen(['docker','exec','-i',name,'docker','load'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
                        try:
                            h=hashlib.sha256()
                            with paths[role].open('rb') as stream:
                                while chunk:=stream.read(1024**2):
                                    h.update(chunk);receipt['bytes']+=len(chunk);proc.stdin.write(chunk)
                            proc.stdin.close();proc.stdin=None
                            _,stderr=proc.communicate(timeout=300)
                            receipt.update(returncode=proc.returncode,sha256=h.hexdigest(),serverProcessWaited=True)
                            if proc.returncode:raise RuntimeError('B2_IMPORT_FAILED:'+stderr.decode(errors='replace')[-400:])
                        finally:
                            done.set();observer.join(timeout=60)
                            if proc.poll() is None:proc.kill();proc.wait()
                        if errors or observer.is_alive():raise RuntimeError('B2_SAMPLE_FAILED')
                        inv=inventory();image=json.loads(run(['docker','image','inspect',a['imageReference']]))[0]
                        release.validate_loaded_image(image,a)
                        post=allocated();after_import=df();samples.append({'allocated':post,'used':after_import[0]})
                        row={'role':role,'beforeAllocated':pre,'afterAllocated':post,'actualIncrementalAllocation':post-pre,
                             'beforeUsed':u,'beforeFree':f,'afterImportUsed':after_import[0],'afterImportFree':after_import[1],
                             'observedAllocatedPeakIncrement':max(x['allocated'] for x in samples)-pre,
                             'observedFilesystemPeakIncrement':max(x['used'] for x in samples)-u,'samples':samples,'receipt':receipt,
                             'identity':'PASS','inventory':inv,'imageId':image['Id']}
                        if role=='R':
                            owned=staged.stat();staged.unlink();au,af=df()
                            if af-after_import[1]<owned.st_blocks*512:raise RuntimeError('B2_R_ARCHIVE_RELEASE_NOT_OBSERVED')
                            row['archiveRelease']={'allocated':owned.st_blocks*512,'released':af-after_import[1],'afterFree':af}
                        entry['imports'].append(row);save()
                    entry.update(afterAllocated=allocated(),afterUsed=df()[0],afterFree=df()[1]);save()
                finally:
                    if ident:
                        owned=json.loads(docker('inspect',name))[0]
                        if owned['Id']!=ident or owned['Config']['Labels'].get('budu.b2-model')!=os.environ['GITHUB_SHA']:raise RuntimeError('B2_OWNERSHIP_CHANGED')
                        docker('rm','-f','-v',ident)
                    subprocess.run(['umount',str(mount)],check=True)
        re_order=proof['orders']['RE']['imports'];er_order=proof['orders']['ER']['imports']
        r=re_order[0]['actualIncrementalAllocation'];e=er_order[0]['actualIncrementalAllocation'];union=proof['orders']['RE']['afterAllocated']-proof['orders']['RE']['beforeAllocated']
        proof.update(result='PASS',rStandaloneAllocated=r,eStandaloneAllocated=e,eIncrementalAfterR=re_order[1]['actualIncrementalAllocation'],
                     rIncrementalAfterE=er_order[1]['actualIncrementalAllocation'],unionAllocated=union,
                     sharedAllocationBenefit=r+e-union,productionChanges=0)
    except BaseException as error:
        proof.update(result='FAIL',error=type(error).__name__+':'+str(error)[:600]);save();raise
    finally:
        for k,v in before.items():
            if v is None:os.environ.pop(k,None)
            else:os.environ[k]=v
        save()
    print('B2_EXACT_BIDIRECTIONAL_ALLOCATION_PASS',flush=True)


def b1_import_ci(archive, compatible_archive, sha, b2=False):
    """Real Docker 29.1.3/containerd import on an owned ext4 loop filesystem.

    The only transport adaptations are local docker-exec, an owned staging
    directory, and the filesystem root for a nested daemon. Never SSH. Capacity
    formulas, archive helper, import process, image identity and daemon inventory
    are the actual controller. DB growth is synthetic here; real PG16.14
    dump/restore/migration runs separately in the b1_success controller case.
    """
    procurement_controller_ci_guard()
    print('B1_ISOLATED_IMPORT_BEGIN',flush=True)
    proof={'productionAccess':False,'filesystemRootAdapter':'OWNED_EXT4_MOUNT',
           'dbSource':'SYNTHETIC_SIZE_ONLY_REAL_PG_IN_SEPARATE_CASE'}
    with tempfile.TemporaryDirectory(prefix='b1-import-',dir=os.environ['RUNNER_TEMP']) as d:
        root=Path(d);mount=root/'fs';mount.mkdir();disk=root/'disk.ext4'
        with disk.open('wb') as f:f.truncate(24*1024**3)
        subprocess.run(['mkfs.ext4','-q','-F',str(disk)],check=True,stdout=subprocess.DEVNULL)
        subprocess.run(['mount','-o','loop',str(disk),str(mount)],check=True)
        name='b1-dind-'+root.name;tag=name+':fixture';ident=None
        staging_before=release.STAGING_ROOT
        try:
            for part in ('docker','containerd','staging'):(mount/part).mkdir(mode=0o700)
            os.chown(mount/'staging',1000,1000)
            dockerfile='FROM docker:29.1.3-dind\nRUN apk add --no-cache python3 coreutils sudo && adduser -D -u 1000 ubuntu\n'
            subprocess.run(['docker','build','--tag',tag,'-'],input=dockerfile.encode(),check=True,timeout=240)
            boot="containerd --root /var/lib/containerd --state /run/containerd --address /run/containerd/containerd.sock >/tmp/containerd.log 2>&1 &\nfor i in $(seq 1 60); do test -S /run/containerd/containerd.sock && break; sleep 1; done\nexec dockerd --containerd /run/containerd/containerd.sock --containerd-namespace moby --feature containerd-snapshotter --iptables=false --ip6tables=false --bridge=none --host unix:///var/run/docker.sock"
            ident=docker('run','-d','--privileged',*(['--cgroupns=private'] if b2 else []),'--network','none','--name',name,
                '--label','budu.b1-fixture='+sha,'--mount','type=bind,source='+str(mount/'docker')+',target=/var/lib/docker',
                '--mount','type=bind,source='+str(mount/'containerd')+',target=/var/lib/containerd',
                '--mount','type=bind,source='+str(mount/'staging')+',target=/fixture/staging',
                '--mount','type=bind,source='+str(Path(compatible_archive).resolve())+',target=/fixture-r.tar,readonly',
                '--tmpfs','/run','--entrypoint',('/usr/local/bin/dind' if b2 else 'sh'),tag,*(['sh'] if b2 else []),'-c',boot)
            if b2 and json.loads(docker('inspect',name))[0]['HostConfig']['CgroupnsMode']!='private':raise RuntimeError('B2_PRIVATE_CGROUP_REQUIRED')
            for _ in range(60):
                ready=subprocess.run(['docker','exec',name,'docker','info','--format','{{.ServerVersion}}'],capture_output=True)
                if ready.returncode==0:break
                time.sleep(1)
            else:raise RuntimeError('B1_CI_DAEMON_NOT_READY')
            class Nested:
                def run(self,args,data=None,timeout=60):
                    assert args[0] in ('docker','python3') or (b2 and args[0]=='ctr')
                    return subprocess.run(['docker','exec','-i',name,*args],input=data,capture_output=True,check=True,timeout=timeout).stdout
                def py(self,code,value=None,timeout=60):
                    if code==release.B1_STORAGE_CODE:
                        assert code.count("os.stat('/')")==1
                        code=code.replace("os.stat('/')","os.stat('/var/lib/docker')")
                    try:return self.run(['python3','-B','-c',code],json.dumps(value).encode(),timeout).decode()
                    except subprocess.CalledProcessError as error:
                        # This daemon has only synthetic/public artifacts and
                        # no secrets. Preserve a bounded helper traceback;
                        # production transport remains redacted and unchanged.
                        print(json.dumps({'b1OwnedFixtureHelperFailure':error.stderr.decode(errors='replace').splitlines()[-(24 if b2 else 6):]}),file=sys.stderr)
                        raise
                def inspect(self,ref,image=False):return json.loads(self.run(['docker',*(['image'] if image else []),'inspect',ref]))[0]
                def disk(self):
                    return tuple(map(int,subprocess.check_output(['df','-B1','--output=used,avail',str(mount)]).decode().splitlines()[1].split()))
                def db(self):return {'dbBytes':164142103,'pgVersion':'16.14'}
            remote=Nested()
            allocation_tool=remote.run(['python3','-c',"import subprocess;print(subprocess.check_output(['du','--version']).decode().splitlines()[0])"]).decode().strip()
            if 'GNU coreutils' not in allocation_tool:raise RuntimeError('B1_CI_GNU_DU_REQUIRED')
            proof['allocationTool']=allocation_tool
            print(json.dumps({'b1AllocationTool':allocation_tool}),flush=True)
            art=release.artifact(archive,sha,ROOT)
            art['compatibility']=release.compatibility_artifact(ROOT,compatible_archive)
            if b2:
                remote.ssh=['docker','exec','-i',name,'sh','-c']
                return b2_owned_import_steps(remote,mount,archive,compatible_archive,sha)
            print('B1_FIXED_R_BASELINE_IMPORT',flush=True)
            remote.run(['docker','load','-i','/fixture-r.tar'],timeout=240)
            rid=release.b1_fixed_r(remote,art);storage=release.b1_storage(remote)
            u,f=remote.disk();cap={'baselineUsed':u,'baselineAvailable':f,'fixedRImageId':rid,'phase':'PRE_IMPORT','peak':0,'token':os.urandom(16).hex(),'retainedArtifactBudget':art['blobs']+art['expanded']}
            remote.b1_capacity=cap;art['capacityLedger']=cap
            envelope=release.b1_envelope(art,remote.db())
            release.b1_capacity_gate(cap,u,f,envelope['import'],max(envelope.values()))
            release.STAGING_ROOT='/fixture/staging';release.b1_stage(remote,art,'claim')
            tar=mount/'staging'/(sha+'.tar');meta=mount/'staging'/(sha+'.json')
            shutil.copyfile(archive,tar);meta.write_text(json.dumps({'release':sha,'sha256':art['archiveHash'],'bytes':art['archive']}))
            for p in (tar,meta):p.chmod(0o600);os.chown(p,1000,1000)
            owned=release.b1_stage(remote,art,'inspect');cap.update(phase='UPLOADED',archiveAllocated=owned['allocated'])
            u,f=remote.disk();release.b1_capacity_gate(cap,u,f,envelope['import']-art['archive'],max(envelope.values()))
            print('B1_EXACT_E_IMPORT',flush=True)
            cap['importReceipt']=json.loads(remote.run(['python3','-B','-c',release.B1_IMPORT_CODE,'/fixture/staging/'+sha+'.tar',art['archiveHash'],str(art['archive'])],timeout=300))
            print('B1_SERVER_BARRIER_AND_ARCHIVE_RELEASE',flush=True)
            release.b1_archive_release(remote,art)
            assert not tar.exists() and remote.inspect(art['compatibility']['imageReference'],True)['Id']==rid
            proof.update(result='PASS',baselineStorage=storage,finalStorage=release.b1_storage(remote),
                capacityLedger=cap,artifactEnvelope=envelope,fixedRImageId=rid,
                exactArchiveRemoved=True,fixedRPreserved=True,archiveHash=art['archiveHash'],
                dockerVersion=remote.run(['docker','version','--format','{{.Server.Version}}']).decode().strip(),
                serverImportReceipt=cap['importReceipt'])
        finally:
            release.STAGING_ROOT=staging_before
            if ident:
                owned=json.loads(docker('inspect',name))[0]
                if owned['Id']!=ident or owned['Config']['Labels'].get('budu.b1-fixture')!=sha:raise RuntimeError('B1_CI_CLEANUP_OWNERSHIP_CHANGED')
                docker('rm','-f','-v',ident)
            subprocess.run(['umount',str(mount)],check=True)
    print('B1_ISOLATED_IMPORT_PASS',flush=True)
    return proof



def b2_retained_ci(archive, compatible_archive):
    """Focused real fresh-candidate proof; no production transport or full CI."""
    procurement_controller_ci_guard()
    if os.environ['GITHUB_REF']!='refs/heads/'+release.B2_BRANCH:
        raise RuntimeError('B2_ISOLATED_RUNNER_REQUIRED')
    keys=('GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0')
    before={key:os.environ.get(key) for key in keys}
    os.environ.update(GIT_CONFIG_COUNT='1',GIT_CONFIG_KEY_0='safe.directory',GIT_CONFIG_VALUE_0=str(ROOT))
    try:
        release.configure_profile('post-transfer',release.procurement_contract()['oldSha'],release.procurement_contract()['businessSha'],
            hashlib.sha256(release.command(['git','-C',str(ROOT),'show',release.procurement_contract()['oldSha']+':server/v2.js'])).hexdigest())
        sha,_=release.identity(ROOT)
        if sha!=os.environ['GITHUB_SHA']:raise RuntimeError('CI_EXACT_SOURCE_REQUIRED')
        proof=b1_import_ci(archive,compatible_archive,sha,b2=True)
        target=Path(os.environ['RUNNER_TEMP'])/'b2-retained-proof.json'
        target.write_text(json.dumps(proof,sort_keys=True,indent=2)+'\n');target.chmod(0o644)
    except BaseException as error:
        code=str(error) if isinstance(error,release.GateError) else 'ISOLATED_FOCUSED_SETUP_FAILED'
        target=Path(os.environ['RUNNER_TEMP'])/'b2-retained-proof.json'
        target.write_text(json.dumps({'result':'FAILED','code':code,'sourceSha':os.environ['GITHUB_SHA'],
            'productionAccess':False},sort_keys=True,indent=2)+'\n');target.chmod(0o644)
        print('B2_FOCUSED_FAILURE='+code,file=sys.stderr)
        raise
    finally:
        for key,value in before.items():
            if value is None:os.environ.pop(key,None)
            else:os.environ[key]=value


def b2_owned_import_steps(remote,mount,archive,compatible_archive,sha):
    """Actual B2 import through DB barrier, on the owned nested filesystem.

    Production app authority is deliberately absent in this import fixture;
    that adapter is explicit. Full real PG/application/cutover/rollback uses
    execute_loaded in the independent PG16.14 cases. No production transport.
    """
    from unittest.mock import patch
    art=release.artifact(archive,sha,ROOT)
    art.update(capacityProfile='B2',compatibility=release.compatibility_artifact(ROOT,compatible_archive),
               compatibilityPath=str(compatible_archive))
    before=(release.STAGING_ROOT,release.LOCK);release.STAGING_ROOT='/fixture/staging';release.LOCK='/fixture/staging/b2-lock'
    phases=[];original_py=remote.py;handoff=[]
    state={'old':{'Id':'EXPLICIT_SYNTHETIC_AUTHORITY_ADAPTER'},'template':'ISOLATED_IMPORT_ONLY'}
    def fixture_preflight(target,artifact,ledger,imported=False):
        if imported:
            release.b1_db_gate(target);release.b1_fixed_r(target,artifact,target.b1_capacity);release.b1_storage(target)
            phases.append('DB_READY');return state
        storage=release.b1_storage(target);release.b2_absent(target,artifact);u,f=target.disk()
        cap=artifact.get('capacityLedger')
        if cap is None:
            cap={'baselineUsed':u,'baselineAvailable':f,'phase':'R_PRE_IMPORT','peak':0,
                 'token':os.urandom(16).hex(),'baselineCommitted':sorted(release.b2_committed(target)),'baselineStorage':storage}
            artifact['capacityLedger']=cap
        target.b1_capacity=cap;envelope=release.b1_envelope(artifact['compatibility'],target.db())['import']
        future=envelope-(artifact['compatibility']['archive'] if cap['phase']=='R_UPLOADED' else 0)
        outside=max(0,u-cap['baselineUsed']-cap.get('archiveAllocated',0))
        release.b1_capacity_gate(cap,u,f,future,envelope+outside);phases.append(cap['phase']);return state
    def fixture_upload(target,path,artifact):
        tar=mount/'staging'/(artifact['release']+'.tar');meta=tar.with_suffix('.json')
        shutil.copyfile(path,tar);meta.write_text(json.dumps({'release':artifact['release'],'sha256':artifact['archiveHash'],'bytes':artifact['archive']}))
        for p in (tar,meta):p.chmod(0o600);os.chown(p,1000,1000)
        return '/fixture/staging/'+tar.name
    def fixture_py(code,value=None,timeout=60):
        if code.endswith('run_loaded_controller(v)\n'):
            handoff.append(value);return json.dumps({'result':'DEPLOY_COMPLETE','fixture':'IMPORT_TO_DB_BARRIER_ONLY'})
        return original_py(code,value,timeout)
    proof={'productionAccess':False,'productionAuthorityAdapter':'EXPLICIT_SYNTHETIC_IMPORT_ONLY',
           'handoffAdapter':'NO_DB_OR_APPLICATION_OR_CUTOVER_IN_THIS_FIXTURE',
           'realPgAndApplication':'INDEPENDENT_PG16_14_B2_SUCCESS_AND_ROLLBACK_CASES',
           'filesystemRootAdapter':'OWNED_EXT4_MOUNT','dbSource':'SYNTHETIC_SIZE_ONLY',
           'daemonInitializer':'OFFICIAL_IMAGE_DIND_WRAPPER_PRIVATE_CGROUP_ONLY'}
    try:
        with patch.object(release,'b2_preflight',side_effect=fixture_preflight),patch.object(release,'stage_artifact',side_effect=fixture_upload),patch.object(remote,'py',side_effect=fixture_py):
            release.b2_deploy(remote,ROOT,archive,art,{},sha)
        cap=art['capacityLedger'];r=art['compatibility'];release.b1_fixed_r(remote,art,cap)
        assert len(handoff)==1 and cap['phase']=='DB' and cap['rArchiveRelease']['verified']
        # Test-only user sample, never a production constant or admission.
        # The actual measured cumulative peak must fit the requested sample F;
        # a larger hosted loop filesystem cannot manufacture B2 viability.
        sample_free=15964217344;sample_peak=cap['peak']
        proof['userSampleCapacity']={'inputSource':'USER_HISTORICAL_B_F_NOT_PRODUCTION_ADMISSION',
            'dbBytes':remote.db()['dbBytes'],'freeBytes':sample_free,'peak':sample_peak,
            'projectedFree':sample_free-sample_peak,'sixGiB':sample_peak<=release.ABSOLUTE_MAX_PEAK,
            'tenGiB':sample_free-sample_peak>=release.MIN_PROJECTED_AVAILABLE,
            'ninetyPercent':'CONDITIONAL_FROM_USER_OLD_90_PASS' if sample_peak<=6444543065 else 'UNVERIFIED',
            'productionUsedBytes':'UNAVAILABLE'}
        if not proof['userSampleCapacity']['sixGiB']:raise release.GateError('B1_CAPACITY_6GIB')
        if not proof['userSampleCapacity']['tenGiB']:raise release.GateError('B1_CAPACITY_10GIB')
        assert not (mount/'staging'/(sha+'.tar')).exists() and not (mount/'staging'/(r['release']+'.tar')).exists()
        faults=[]
        for role,artifact,receipt in [('R',r,cap['rImportReceipt']),('E',art,cap['eImportReceipt'])]:
            for field,value in [('serverWaitComplete',False),('archiveHash','0'*64),('archiveBytes',artifact['archive']-1),('returncode',1)]:
                bad={**receipt,field:value}
                try:release.b2_barrier(remote,artifact,bad,cap)
                except release.GateError as error:
                    assert str(error)=='B2_IMPORT_UNKNOWN';faults.append(role+':'+field)
                else:raise RuntimeError('B2_INTERRUPTED_BARRIER_NOT_REJECTED')
        # Real server wait/hash failure, using the exact E bytes but deliberately
        # wrong transport identity. No additional image or production access.
        bad={**art,'archiveHash':'0'*64}
        try:release.b2_stream(remote,archive,bad)
        except release.GateError as error:
            assert str(error)=='B2_IMPORT_UNKNOWN';faults.append('E:REAL_SERVER_HASH_FAILURE')
        else:raise RuntimeError('B2_BAD_STREAM_NOT_REJECTED')
        with tempfile.NamedTemporaryFile(dir=os.environ['RUNNER_TEMP']) as partial:
            with Path(archive).open('rb') as source:partial.write(source.read(65536));partial.flush()
            try:release.b2_stream(remote,partial.name,art)
            except release.GateError as error:
                assert str(error)=='B2_IMPORT_UNKNOWN';faults.append('E:REAL_TRUNCATED_STREAM')
            else:raise RuntimeError('B2_TRUNCATED_STREAM_NOT_REJECTED')
        with patch.object(remote,'db',return_value={'dbBytes':release.GIB,'pgVersion':'16.14'}):
            try:release.b1_db_gate(remote)
            except release.GateError as error:
                assert str(error)=='B1_CAPACITY_6GIB';faults.append('FRESH_DB_GROWTH')
            else:raise RuntimeError('B2_STALE_DB_NOT_REJECTED')
        final_storage=release.b1_storage(remote)
        base=['ctr','--address','/run/containerd/containerd.sock','--namespace','moby','snapshots','--snapshotter','overlayfs']
        remote.run(base+['prepare','b2-owned-residual-active'])
        try:release.b1_storage(remote)
        except release.GateError:faults.append('REAL_RESIDUAL_ACTIVE_SNAPSHOT')
        else:raise RuntimeError('B2_ACTIVE_RESIDUAL_NOT_REJECTED')
        remote.run(base+['commit','b2-owned-residual-committed','b2-owned-residual-active'])
        try:release.b2_barrier(remote,art,cap['eImportReceipt'],cap)
        except release.GateError as error:
            assert str(error)=='B2_STORAGE_UNKNOWN';faults.append('REAL_RESIDUAL_COMMITTED_SNAPSHOT')
        else:raise RuntimeError('B2_COMMITTED_RESIDUAL_NOT_REJECTED')
        proof.update(result='PASS',phaseAuthorityChecks=phases,capacityLedger=cap,finalStorage=final_storage,
                     fixedRPreserved=True,noTargetEArchive=True,realServerStream=True,
                     sharedCreditSource=cap['sharedProof']['source'],failureTests=faults)
    except BaseException as error:
        code=str(error) if isinstance(error,release.GateError) else 'ISOLATED_HELPER_FAILED'
        proof.update(result='FAILED',code=code,capacityLedger=art.get('capacityLedger'),
            eArtifact={k:art[k] for k in ('archive','blobs','expanded','largest','archiveHash','rootfsDiffIds')},
            rArtifact={k:art['compatibility'][k] for k in ('archive','blobs','expanded','largest','archiveHash')})
        target=Path(os.environ['RUNNER_TEMP'])/'b2-controller-import-diagnostic.json'
        target.write_text(json.dumps(proof,sort_keys=True,indent=2)+'\n');target.chmod(0o644)
        print('B2_ISOLATED_CAPACITY_PROOF='+json.dumps(proof,sort_keys=True),flush=True)
        raise
    finally:release.STAGING_ROOT,release.LOCK=before
    print('B2_ACTUAL_CONTROLLER_IMPORT_DB_BARRIER_PASS',flush=True)
    return proof


def procurement_controller_ci(image,old_image,compatible_image,archive,compatible_archive):
    procurement_controller_ci_guard()
    diagnostics=CiFailureDiagnostics(Path(os.environ['RUNNER_TEMP'])/'procurement-controller-diagnostic.json',os.environ.get('GITHUB_SHA'))
    # Root is needed by the SAME backup helper to inspect the restore's 0700
    # postgres-owned files. Git trust is process-scoped, including direct ancestry
    # subprocesses in identity(); no global/local Git config is changed.
    git_keys=('GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0')
    git_before={key:os.environ.get(key) for key in git_keys}
    os.environ.update(GIT_CONFIG_COUNT='1',GIT_CONFIG_KEY_0='safe.directory',GIT_CONFIG_VALUE_0=str(ROOT))
    try:
        _procurement_controller_ci(image,old_image,compatible_image,archive,compatible_archive,diagnostics)
    except BaseException as error:
        if diagnostics.primary_error is not None and error is not diagnostics.primary_error:
            diagnostics.cleanup(lambda: (_ for _ in ()).throw(error),'TEMP_DIRECTORY_CLEANUP')
            raise diagnostics.primary_error.with_traceback(diagnostics.primary_traceback) from None
        if diagnostics.primary_error is None and diagnostics.cleanup_error is not None and error is not diagnostics.cleanup_error:
            diagnostics.cleanup(lambda: (_ for _ in ()).throw(error),'TEMP_DIRECTORY_CLEANUP')
            raise diagnostics.cleanup_error from None
        diagnostics.primary(error)
        raise
    finally:
        for key,value in git_before.items():
            if value is None:os.environ.pop(key,None)
            else:os.environ[key]=value


def _procurement_controller_ci(image,old_image,compatible_image,archive,compatible_archive,diagnostics):
    release.configure_profile('post-transfer',release.procurement_contract()['oldSha'],release.procurement_contract()['businessSha'],
        hashlib.sha256(release.command(['git','-c','safe.directory='+str(ROOT),'-C',str(ROOT),
                                       'show',release.procurement_contract()['oldSha']+':server/v2.js'])).hexdigest())
    identity,ledger=release.identity(ROOT);sha=os.environ['GITHUB_SHA']
    if identity!=sha or image!=release.image_reference(sha):raise RuntimeError('CI_EXACT_SOURCE_REQUIRED')
    old_config=json.loads(docker('image','inspect',old_image))[0]
    if (old_image!='budu-api:procurement-old-edb31cd398e3' or old_config['Config'].get('Labels',{}).get(release.REVISION)!=release.procurement_contract()['oldSha']
            or old_config['Os']!='linux' or old_config['Architecture']!='amd64'):
        raise RuntimeError('CI_EXACT_OLD_IMAGE_REQUIRED')
    if compatible_image!=release.image_reference(release.procurement_contract()['rollbackSha']):raise RuntimeError('CI_EXACT_COMPATIBLE_IMAGE_REQUIRED')
    for tag in (image,old_image,compatible_image):
        if docker('run','--rm','--network','none','--entrypoint','node',tag,'-e',release.SHIPPING_CLI_PROBE)!='PINNED_PRISMA_CLI_OK':
            raise RuntimeError('CI_REAL_PINNED_PRISMA_CLI_REQUIRED')
    art=release.artifact(archive,sha,ROOT)
    art['compatibility']=release.compatibility_artifact(ROOT,compatible_archive)
    b1_proof=b1_import_ci(archive,compatible_archive,sha) if (release.B1_IDENTITY or release.B2_IDENTITY) else None
    b2_proof=b1_import_ci(archive,compatible_archive,sha,b2=True) if release.B2_IDENTITY else None
    ledger={p.parent.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'prisma/migrations').glob('*/migration.sql')}
    helper=(ROOT/'scripts/clone-production-container.py').read_text()
    cases=[]
    with tempfile.TemporaryDirectory(prefix='shipping-controller-',dir=os.environ['RUNNER_TEMP']) as directory:
        root=Path(directory);root.chmod(0o700)
        suffix=root.name.removeprefix('shipping-controller-');network='shipping-ci-net-'+suffix;db_network='shipping-ci-db-net-'+suffix;pg='shipping-ci-pg-'+suffix
        database='shipping_ci_'+suffix.replace('-','_');url='postgresql://postgres:fixture_only@'+pg+':5432/'+database
        globals_before={key:getattr(release,key) for key in ('PG','EXPECTED_DB','NGINX','TEMPLATE','CURRENT_SHA_FILE','LOCK')}
        release.PG=pg;release.EXPECTED_DB=database
        owned={};reserved=set();network_id=None;db_network_id=None
        def remove_owned(name):
            if not docker('ps','-aq','--filter','name=^/'+name+'$'):return
            current=json.loads(docker('inspect',name))[0]
            if name in owned:
                if current['Id']!=owned[name]:raise RuntimeError('CI_CLEANUP_OWNERSHIP_CHANGED')
            elif name.startswith('budu-shipping-restore-'):
                if (current['Config'].get('Labels',{}).get('budu.shipping-restore')!=sha
                        or not any(m.get('Source','').startswith(str(root)+'/') for m in current['Mounts'])):
                    raise RuntimeError('CI_RESTORE_CLEANUP_OWNERSHIP_INVALID')
            elif name.startswith('budu-prod-'+release.procurement_contract()['rollbackSha'][:12]+'-purchase-compat-'):
                if (name not in reserved or current['HostConfig']['NetworkMode']!=network or current['Config'].get('Labels',{}).get(release.REVISION)!=release.procurement_contract()['rollbackSha'] or current['Image']!=art['compatibility'].get('loadedDockerImageId')):raise RuntimeError('CI_COMPATIBILITY_CLEANUP_OWNERSHIP_INVALID')
            elif (name not in reserved or current['HostConfig']['NetworkMode']!=network
                  or current['Config'].get('Labels',{}).get(release.REVISION)!=sha
                  or current['Image']!=art.get('loadedDockerImageId')):
                raise RuntimeError('CI_APP_MIGRATOR_CLEANUP_OWNERSHIP_INVALID')
            # ID protects against a name race; -v removes only its anonymous volumes.
            docker('rm','-f','-v',current['Id'])
        try:
            network_id=docker('network','create','--internal',network)
            if json.loads(docker('network','inspect',network))[0]['Internal'] is not True:raise RuntimeError('CI_NETWORK_EGRESS_NOT_BLOCKED')
            db_network_id=docker('network','create','--internal',db_network)
            if json.loads(docker('network','inspect',db_network))[0]['Internal'] is not True:raise RuntimeError('CI_NETWORK_EGRESS_NOT_BLOCKED')
            owned[pg]=docker('run','-d','--name',pg,'--network',db_network,'-e','POSTGRES_PASSWORD=fixture_only','postgres:16.14',timeout=180)
            for _ in range(60):
                ready=subprocess.run(['docker','exec',pg,'pg_isready','-U','postgres'],capture_output=True,timeout=5)
                if ready.returncode==0:break
                time.sleep(0.25)
            else:raise RuntimeError('CI_POSTGRES_NOT_READY')
            primary_probe = "const net=require('node:net');const u=new URL(process.env.DATABASE_URL);const s=net.createConnection({host:u.hostname,port:5432});s.setTimeout(2000);s.on('connect',()=>{s.destroy();process.exit(3)});const done=()=>{s.destroy();process.stdout.write('PRIMARY_NETWORK_DB_UNREACHABLE');};s.once('error',done);s.once('timeout',done);"
            if docker('run','--rm','--network',network,'-e','DATABASE_URL='+url,'--entrypoint','node',image,'-e',primary_probe)!='PRIMARY_NETWORK_DB_UNREACHABLE':raise RuntimeError('CI_PRIMARY_NETWORK_UNEXPECTED_DB_ACCESS')
            docker('pull','nginx:1.28-alpine',timeout=180)
            case_specs=[(mode,None) for mode in (*CI_CASES,'post_restore_failure','post_migrator_create_failure')]+[('post_cutover_failure',fault) for fault in ('health','runtime','prisma','facts','routes','pointer','public','stop')]
            if release.B1_IDENTITY or release.B2_IDENTITY:case_specs.append(('b1_success',None))
            if release.B2_IDENTITY:case_specs.append(('b2_success',None))
            for index,(mode,rollback_fault) in enumerate(case_specs):
                b1_case=mode=='b1_success';b2_case=mode=='b2_success'
                if b1_case or b2_case:mode='success'
                art['capacityProfile']='B2' if b2_case else 'B1' if b1_case else 'LEGACY'
                art.pop('capacityLedger',None)
                release.configure_profile('post-transfer',release.procurement_contract()['oldSha'],release.procurement_contract()['businessSha'],release.digest(release.command(['git','-C',str(ROOT),'show',release.procurement_contract()['oldSha']+':server/v2.js'])))
                diagnostics.case=mode
                case_root=root/str(index);case_root.mkdir(mode=0o700);(case_root/'rollback').mkdir(mode=0o700)
                old='shipping-ci-old-'+suffix;nginx='shipping-ci-nginx-'+suffix
                candidate='budu-prod-'+sha[:12]+release.CONTAINER_SUFFIX
                compatible='budu-prod-'+release.procurement_contract()['rollbackSha'][:12]+'-purchase-compat-'+sha[:12]
                migrator='budu-shipping-migrator-'+sha[:12];restore='budu-shipping-restore-'+sha[:12]
                names=(old,nginx,candidate,migrator,restore,compatible)
                for name in names:
                    if docker('ps','-aq','--filter','name=^/'+name+'$'):raise RuntimeError('CI_OWNED_NAME_EXISTS')
                reserved.update((candidate,migrator,restore,compatible))
                release.NGINX=nginx;release.TEMPLATE=str(case_root/'template');release.CURRENT_SHA_FILE=str(case_root/'current-sha');release.LOCK=str(case_root/'lock')
                docker('exec',pg,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-c','CREATE DATABASE '+database)
                docker('run','--rm','--network',db_network,'-e','DATABASE_URL='+url,'--entrypoint','node',old_image,
                       '/app/node_modules/prisma/build/index.js','migrate','deploy','--schema','/app/prisma/schema.prisma',timeout=180)
                docker('run','--rm','--network',db_network,'-e','DATABASE_URL='+url,'-e','APP_ENV=test','--entrypoint','node',old_image,
                       '--input-type=module','-e',PROCUREMENT_FIXTURE_JS)
                data=case_root/'data';data.mkdir(mode=0o700);os.chown(data,1000,1000)
                routes='server { listen 80; location / { proxy_pass http://'+old+':3000; } location /api/ { proxy_pass http://'+old+':3000; } location /health-proxy { proxy_pass http://'+old+':3000; } }\n'
                (case_root/'template').write_text(routes);(case_root/'current-sha').write_text(release.procurement_contract()['oldSha']+'\n')
                conf=case_root/'conf';conf.mkdir();(conf/'budu.conf').write_text(routes)
                owned[old]=docker('create','--name',old,'--network',network,'--restart','unless-stopped','--log-driver','json-file',
                       '--label','budu.production-role=candidate','--label',release.REVISION+'='+release.procurement_contract()['oldSha'],
                       '-e','DATABASE_URL='+url,'-e','APP_ENV=test','-e','DATA_STORE=file','-e','DATA_DIR=/app/server/data',
                       '-e','WECHAT_PAY_ENABLED=0','-e','ALIPAY_ENABLED=0','-e','GIT_SHA='+release.procurement_contract()['oldSha'],
                       '-e','CUSTOMER_REQUEST_WECOM_RECIPIENT_USERNAME=budu','-e','CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID=dh',
                       '--mount','type=bind,source='+str(data)+',target=/app/server/data',old_image)
                docker('network','connect',db_network,old)
                docker('start',old)
                for _ in range(150):
                    info=json.loads(docker('inspect',old))[0]
                    if info['State'].get('Health',{}).get('Status')=='healthy':break
                    if not info['State']['Running']:raise RuntimeError('CI_REAL_OLD_APP_START_FAILED')
                    time.sleep(0.5)
                else:raise RuntimeError('CI_REAL_OLD_APP_NOT_HEALTHY')
                owned[nginx]=docker('run','-d','--name',nginx,'--network',network,'--mount','type=bind,source='+str(conf)+',target=/etc/nginx/conf.d',
                                   'nginx:1.28-alpine')
                remote=ProcurementControllerCiRemote(case_root,network,old,candidate,mode,db_network,reserved_resources=reserved)
                remote.rollback_fault=rollback_fault
                before_snapshot=json.loads(docker('exec','-w','/app',old,'node','--input-type=module','-e',PROCUREMENT_SNAPSHOT_JS))
                before_facts=before_snapshot['facts']
                release.application_db_probe(remote,old,'ROLLBACK_APPLICATION_DB_PROBE_FAILED')
                art['loadedDockerImageId']=release.resolve_loaded_image(remote,art)['Id']
                art['compatibility']['loadedDockerImageId']=release.resolve_loaded_image(remote,art['compatibility'])['Id']
                (case_root/'lock').mkdir(mode=0o700)
                expected={'post_cutover_failure':('PUBLIC_HEALTH','HEALTH_FAILED'),
                          'post_l86_disk':('SHIPPING_CHECK_MIGRATION','SHIPPING_MIGRATION_DISK_GATE_FAILED'),
                          'post_restore_failure':('SHIPPING_BACKUP_RESTORE','SHIPPING_MIGRATION_DISK_GATE_FAILED'),
                          'post_migrator_create_failure':('SHIPPING_CHECK_MIGRATION','COMMAND_FAILED'),
                          'backup_limit':('SHIPPING_BACKUP_RESTORE','SHIPPING_BACKUP_RESTORE_UNVERIFIED')}.get(mode)
                if b1_case or b2_case:
                    # DB-stage fixture: the E/R images are already loaded in this
                    # owned runner baseline. Fresh import/barrier/release is
                    # independently exercised by b1_import_ci below.
                    used,available=remote.disk()
                    art['capacityLedger']={'baselineUsed':used,'baselineAvailable':available,
                        'phase':'DB','peak':0,'fixedRImageId':art['compatibility']['loadedDockerImageId'],
                        'retainedArtifactBudget':art['blobs']+art['expanded'],
                        'fixture':'PRELOADED_DB_STAGE_ONLY'}
                result=io.StringIO()
                try:
                    with contextlib.redirect_stdout(result):
                        release.execute_loaded(remote,art,ledger,helper,remote.inspect(old)['Id'],release.digest(routes.encode()))
                except release.GateError as error:
                    if rollback_fault:
                        code='PROCUREMENT_ROLLBACK_WRITER_STOP_UNVERIFIED' if rollback_fault=='stop' else 'ROLLBACK_UNVERIFIED_MANUAL_ATTENTION_REQUIRED'
                        if error.deployment_result!='DEPLOY_BLOCKED' or error.failure_stage!='PUBLIC_HEALTH' or str(error)!=code:raise
                    else:verify_controller_failure(error,expected)
                else:
                    if expected or json.loads(result.getvalue())['result']!='DEPLOY_COMPLETE':raise RuntimeError('CI_CONTROLLER_EXPECTED_FAILURE_MISSING')
                writer=candidate if mode=='success' else compatible
                rollback_failure=None;recovery=None
                if rollback_fault:
                    failure_path=case_root/'rollback'/(release.ROLLBACK_PREFIX+sha)/'procurement-rollback-failure.json'
                    rollback_failure=json.loads(failure_path.read_text())
                    if not remote.rollback_fault_injected or not (case_root/'lock').exists():raise RuntimeError('CI_ROLLBACK_FAILURE_NOT_CONTAINED')
                    if rollback_fault=='stop':
                        if rollback_failure['zeroWriterVerification']!='UNVERIFIED':raise RuntimeError('CI_STOP_FAILURE_FALSE_ZERO_WRITER')
                        release.writer_check(remote.containers(),remote.db(),[compatible])
                    else:
                        if rollback_failure['zeroWriterVerification']!='VERIFIED_ZERO_WRITERS':raise RuntimeError('CI_ROLLBACK_ZERO_WRITER_UNVERIFIED')
                        release.writer_check(remote.containers(),remote.db(),[])
                    after_snapshot=json.loads(docker('run','--rm','--network',db_network,'-e','DATABASE_URL='+url,'--entrypoint','node',old_image,'--input-type=module','-e',PROCUREMENT_SNAPSHOT_JS))
                    writer=compatible if rollback_fault=='stop' else None
                else:
                    after_snapshot=json.loads(docker('exec','-w','/app',writer,'node','--input-type=module','-e',PROCUREMENT_SNAPSHOT_JS))
                if before_facts!=after_snapshot['facts']:raise RuntimeError('CI_PROCUREMENT_PROTECTED_FACTS_CHANGED')
                final=remote.db();expected_ledger=release.before_ledger(ledger) if mode in ('backup_limit','post_restore_failure','post_migrator_create_failure') else ledger
                release.validate_database(final,expected_ledger)
                if not rollback_fault:
                    release.writer_check(remote.containers(),final,[writer])
                    if release.route_target(*remote.routes())!=writer or (case_root/'current-sha').read_text().strip()!=(sha if mode=='success' else release.procurement_contract()['rollbackSha']):raise RuntimeError('CI_ROUTE_OR_POINTER_NOT_RECONCILED')
                    if (case_root/'lock').exists():raise RuntimeError('CI_KNOWN_PHASE_LOCK_NOT_RELEASED')
                if mode!='success' and any(event=={'action':'start','container':old} for event in remote.events):raise RuntimeError('CI_LEGACY_WRITER_RESTARTED')
                retained=release.procurement_facts(remote)
                if mode=='post_cutover_failure' and (retained!=remote.retained_before_rollback or len(retained)!=7 or not all(row['count']>0 for row in retained)):raise RuntimeError('CI_PROCUREMENT_RETAINED_ROWS_CHANGED')
                if not rollback_fault and mode in ('post_cutover_failure','backup_limit','post_restore_failure','post_migrator_create_failure'):
                    # Full formal deploy of the SAME E, reusing its exact loaded
                    # tag/stopped container, existing R, and previous evidence root.
                    old_r_id=remote.inspect(compatible)['Id'];old_e_id=remote.inspect(candidate)['Id'] if mode=='post_cutover_failure' else None
                    readiness=wait_owned_procurement_rollback_healthy(
                        remote,compatible,old_r_id,art['compatibility']['loadedDockerImageId'],sha,mode)
                    from_ledger=final['applied']
                    previous_resources={name:remote.inspect(name)['Id'] for name in remote.attempt_resources
                                        if remote.run(['docker','ps','-aq','--filter','name=^/'+name+'$']).strip()}
                    remote.old=compatible;remote.mode='success'
                    release.configure_profile('post-transfer',release.procurement_contract()['rollbackSha'],release.procurement_contract()['businessSha'],release.digest(release.command(['git','-C',str(ROOT),'show',release.procurement_contract()['rollbackSha']+':server/v2.js'])))
                    with contextlib.redirect_stdout(io.StringIO()):release.deploy(remote,ROOT,Path(archive),art,ledger,sha)
                    final=remote.db();release.validate_database(final,ledger);release.writer_check(remote.containers(),final,[candidate])
                    if release.route_target(*remote.routes())!=candidate or (case_root/'current-sha').read_text().strip()!=sha or (case_root/'lock').exists():raise RuntimeError('CI_FORMAL_SAME_E_RECOVERY_FAILED')
                    if old_e_id and remote.inspect(candidate)['Id']!=old_e_id:raise RuntimeError('CI_EXACT_E_CONTAINER_NOT_REUSED')
                    if remote.inspect(compatible)['Id']!=old_r_id or remote.inspect(compatible)['State']['Running']:raise RuntimeError('CI_FORMAL_R_IDENTITY_OR_STOP_INVALID')
                    recovery_snapshot=json.loads(docker('exec','-w','/app',candidate,'node','--input-type=module','-e',PROCUREMENT_SNAPSHOT_JS))
                    fact_verification=verify_procurement_recovery_facts(from_ledger,retained,release.procurement_facts(remote),before_facts,recovery_snapshot['facts'],final['procurementSchema'])
                    if any(remote.inspect(name)['Id']!=ident or remote.inspect(name)['State']['Running'] for name,ident in previous_resources.items()):raise RuntimeError('CI_PREVIOUS_ATTEMPT_RESOURCES_CHANGED')
                    recovery={'controller':'deploy -> execute_loaded','sameExactReleaseSha':sha,'fromLedger':from_ledger,'toLedger':88,'existingRIdPreserved':True,'existingEIdReused':old_e_id is not None,'originalEvidenceRootPreserved':(case_root/'rollback'/(release.ROLLBACK_PREFIX+sha)/'manifest.json').is_file(),'newRecoveryRoots':len(list((case_root/'rollback').glob(release.ROLLBACK_PREFIX+sha+'-resume-*'))),'newStagingFiles':0,
                              'sourceRReadiness':readiness,'procurementFactVerification':fact_verification,'previousAttemptResourcesPreserved':previous_resources,
                              'attemptResources':dict(remote.attempt_resources)}
                    if recovery['newRecoveryRoots']!=1:raise RuntimeError('CI_RECOVERY_EVIDENCE_ROOT_INVALID')
                    writer=candidate
                cleanup_count=docker('exec',pg,'psql','-X','-qAt','-U','postgres','-d',database,'-c',
                    "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND (application_name LIKE 'budu_shipping_backup_%' OR application_name='budu_shipping_migrator') AND pid<>pg_backend_pid()")
                if cleanup_count!='0':raise RuntimeError('CI_BACKUP_OR_MIGRATOR_CONNECTIONS_REMAIN')
                proof_path=case_root/'rollback'/(release.ROLLBACK_PREFIX+sha)/'backup-restore-proof.json'
                if recovery and recovery['fromLedger']==87:
                    proof_path=next((case_root/'rollback').glob(release.ROLLBACK_PREFIX+sha+'-resume-*'))/'backup-restore-proof.json'
                backup=json.loads(proof_path.read_text()) if proof_path.exists() else None
                if (mode!='backup_limit' or recovery) and (not backup or not backup['terminationVerified'] or not backup['restoreVerified'] or remote.inspect(backup['restoreContainer'])['State']['Running']):raise RuntimeError('CI_REAL_BACKUP_RESTORE_NOT_PROVEN')
                old_networks=remote.inspect(old)['NetworkSettings']['Networks']
                if set(old_networks)!={network,db_network}:raise RuntimeError('CI_DUAL_NETWORK_SOURCE_REQUIRED')
                migrator_networks=remote.inspect(remote.latest_migrator)['NetworkSettings']['Networks'] if remote.latest_migrator else None
                if migrator_networks is not None and ({k:v.get('NetworkID') for k,v in migrator_networks.items()}!={k:v.get('NetworkID') for k,v in old_networks.items()}):raise RuntimeError('CI_MIGRATOR_NETWORK_PARITY_FAILED')
                starts=[event for event in remote.events if event['action']=='start' and remote.attempt_resources.get(event['container'])=='migrator']
                if len(starts)!=(0 if mode=='backup_limit' and not recovery else 1) or (mode!='success' and not remote.injected):raise RuntimeError('CI_MIGRATOR_OR_INJECTION_NOT_OBSERVED')
                cases.append({'case':'b2_success' if b2_case else 'b1_success' if b1_case else ('r_unverified_'+rollback_fault) if rollback_fault else 'post_l88_disk' if mode=='post_l86_disk' else mode,'controller':'execute_loaded','result':'PASS','migrations':final['applied'],
                              'procurementSchema':final['procurementSchema'],'protectedOldBusinessFactsUnchanged':True,'retainedProcurementFacts':retained,'legacyWriterNeverRestarted':True,'writer':writer,'writerSamples':remote.writer_samples,'events':remote.events,
                              'capacityLedger':art.get('capacityLedger'),'diskSamples':remote.disk_samples,'backupRestoreProof':backup,'backupAndMigratorConnections':0,
                              'rollbackSha':release.procurement_contract()['rollbackSha'] if mode!='success' else None,'failureInjection':expected,
                              'hostStorageActual':remote.host_storage,'hostStorageGate':'CI_FIXTURE_ADAPTER_PRODUCTION_UNVERIFIED',
                              'automaticDnsAliasAdaptations':remote.alias_adaptations,'lockRemoved':not rollback_fault,'rollbackFailure':rollback_failure,'formalSameERecovery':recovery,
                              'secondaryDbNetworkTopology':True,'migratorNetworksMatchOld':migrator_networks is not None,
                              'migratorPreStartNetworks':remote.migrator_prestart_networks})
                for name in sorted(set(names)|set(remote.attempt_resources)):
                    diagnostics.cleanup(lambda name=name: remove_owned(name),'CONTAINER_CLEANUP')
                diagnostics.cleanup(lambda: docker('exec',pg,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-c',
                    'DROP DATABASE '+database+' WITH (FORCE)'),'DATABASE_CLEANUP')
                diagnostics.raise_cleanup()
                diagnostics.completed.append(mode)
            report={'scope':'ISOLATED_PROCUREMENT_G87_L88_REAL_CONTROLLER_NOT_PRODUCTION_ADMISSION','releaseSha':sha,
                    'primaryOnlyDbProbe':'PRIMARY_NETWORK_DB_UNREACHABLE','secondaryDbNetworkTopology':True,
                    'oldSha':release.procurement_contract()['oldSha'],'businessSha':release.procurement_contract()['businessSha'],'compatibleRollbackSha':release.procurement_contract()['rollbackSha'],'compatibleArchiveSha256':art['compatibility']['archiveHash'],
                    'controllerSha256':hashlib.sha256((ROOT/'scripts/deploy-prod-transfer-cas.py').read_bytes()).hexdigest(),
                    'archiveSha256':art['archiveHash'],'loadedImageId':art['loadedDockerImageId'],'cases':cases,
                    'realExecuteLoaded':True,'realBackupRestoreHelper':True,'realImageMigrator':True,
                    'realApplicationContainers':True,'sleepProbeIsBusinessWriterEvidence':False,
                    'productionHostStorageValidated':False,'productionActions':False}
        except BaseException as error:
            diagnostics.primary(error)
            raise
        finally:
            for name in set(owned)|reserved:
                diagnostics.cleanup(lambda name=name: remove_owned(name),'CONTAINER_CLEANUP')
            def remove_network():
                if json.loads(docker('network','inspect',network))[0]['Id']!=network_id:
                    raise RuntimeError('CI_NETWORK_CLEANUP_OWNERSHIP_CHANGED')
                docker('network','rm',network)
            if network_id:diagnostics.cleanup(remove_network,'NETWORK_CLEANUP')
            def remove_db_network():
                if json.loads(docker('network','inspect',db_network))[0]['Id']!=db_network_id:
                    raise RuntimeError('CI_NETWORK_CLEANUP_OWNERSHIP_CHANGED')
                docker('network','rm',db_network)
            if db_network_id:diagnostics.cleanup(remove_db_network,'NETWORK_CLEANUP')
            for key,value in globals_before.items():setattr(release,key,value)
    diagnostics.raise_cleanup()
    report['ownedResourcesRemoved']=True
    if release.B1_IDENTITY or release.B2_IDENTITY:
        report['b1Import']=b1_proof
        if b2_proof:report['b2Import']=b2_proof
        report['liveRestoreFalseFullDr']='DEFERRED_BY_USER_RELEASE_OVERRIDE'
    target=Path(os.environ['RUNNER_TEMP'])/'procurement-controller-proof.json'
    target.write_text(json.dumps(report,sort_keys=True,indent=2)+'\n');target.chmod(0o644)
    print('ISOLATED_PROCUREMENT_REAL_CONTROLLER_CASES=14_PASS SAME_EXACT_E_FORMAL_RECOVERIES=4_PASS HOST_STORAGE=CI_ADAPTER_PRODUCTION_UNVERIFIED PRODUCTION_ADMISSION=NO')


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
        elif sys.argv[1] == '--b2-retained-ci':
            if len(sys.argv)!=4:raise RuntimeError('B2_FOCUSED_ARGUMENTS_INVALID')
            b2_retained_ci(*sys.argv[2:])
        elif sys.argv[1] == '--b2-allocation-ci':
            if len(sys.argv)!=4:raise RuntimeError('B2_MODEL_ARGUMENTS_INVALID')
            b2_allocation_ci(*sys.argv[2:])
        elif sys.argv[1] == '--procurement-controller-ci':
            if len(sys.argv)!=7:raise RuntimeError('CI_CONTROLLER_ARGUMENTS_INVALID')
            procurement_controller_ci(*sys.argv[2:])
        elif sys.argv[1] == '--material-controller-ci':
            if len(sys.argv)!=5:raise RuntimeError('CI_CONTROLLER_ARGUMENTS_INVALID')
            material_controller_ci(*sys.argv[2:])
        elif sys.argv[1] == '--shipping-controller-ci':
            if len(sys.argv)!=5:raise RuntimeError('CI_CONTROLLER_ARGUMENTS_INVALID')
            shipping_controller_ci(*sys.argv[2:])
        else:
            main(sys.argv[1],sys.argv[2] if len(sys.argv)==3 else None)
    except BaseException as error:
        if len(sys.argv)>1 and sys.argv[1]=='--shipping-controller-ci':
            code=str(error);stage=getattr(error,'failure_stage','CI_FIXTURE')
            print(json.dumps({'exactSHA':os.environ.get('GITHUB_SHA','UNVERIFIED'),
                'case':'UNVERIFIED','completedCases':[],
                'code':code if code in CI_CODES else 'DETAILS_SUPPRESSED',
                'stage':stage if stage in release.SAFE_CONTROLLER_STAGES else 'CI_FIXTURE',
                'result':'FAILED','injection':['PRIMARY']}),file=sys.stderr)
        else:print('CANDIDATE_DB_PROBE_INTEGRATION_FAILED', file=sys.stderr)
        raise SystemExit(1) from None

#!/usr/bin/env python3
"""Finite P1 contract tests. Optional Docker proof is synthetic and production-free."""
import argparse
import copy
import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
import uuid

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('p1_release',ROOT/'scripts/deploy-prod-transfer-cas.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
CONTRACT=ROOT/'scripts/p1-release-contract.json'


def hash_path(path):
    with Path(path).open('rb') as stream:return r.file_hash(stream)


def p1_node_version(value):
    match=re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)',value.strip())
    assert match is not None,'P1_NODE_VERSION_UNKNOWN'
    version=tuple(int(x) for x in match.groups())
    assert version[0]==22 and version>=(22,13,0),'P1_PDFJS_NODE_VERSION_INCOMPATIBLE'
    return value.strip()


def bound():
    c=json.loads(CONTRACT.read_text())
    r.configure_profile('post-transfer',r.P1_OLD_SHA,r.P1_BUSINESS_SHA if re.fullmatch('[0-9a-f]{40}',r.P1_BUSINESS_SHA) else r.P1_BASE_SHA,'a'*64)
    r.P1_CONTRACT=c
    return c


class P1ContractTests(unittest.TestCase):
    def setUp(self):
        self.c=bound()

    def test_unbound_contract_fails_closed(self):
        if not re.fullmatch('[0-9a-f]{40}',r.P1_BUSINESS_SHA):
            self.assertFalse(r.p1_release())
            with self.assertRaisesRegex(r.GateError,'P1_CONTRACT_UNBOUND'):r.p1_contract()
        else:
            self.assertTrue(r.p1_release())
            self.assertEqual(self.c['businessSha'],r.P1_BUSINESS_SHA)

    def test_original_capacity_thresholds_and_no_waiver(self):
        self.assertEqual((r.MAX_PROJECTED_USAGE,r.MIN_PROJECTED_AVAILABLE,r.ABSOLUTE_MAX_PEAK),(90,10*r.GIB,6*r.GIB))
        self.assertIsNone(r.CAPACITY_WAIVER)
        with self.assertRaises(r.GateError):
            r.b1_capacity_gate({'baselineUsed':70*r.GIB,'baselineAvailable':14*r.GIB,'peak':0,'phase':'TEST'},70*r.GIB,14*r.GIB,5*r.GIB)

    def test_migrator_uses_actual_connection_options(self):
        value='postgresql://fixture:synthetic@isolated-pg:5432/p1_fixture?schema=public'
        bounded=r.p1_migrator_url(value);parsed=urlsplit(bounded)
        self.assertEqual((parsed.netloc,parsed.path),('fixture:synthetic@isolated-pg:5432','/p1_fixture'))
        self.assertEqual(parse_qs(parsed.query),{'schema':['public'],'options':[r.P1_MIGRATOR_OPTIONS]})
        self.assertIn("v['options']",r.p1_migrator_create_code())
        compile(r.p1_migrator_create_code(),'<p1-migrator>','exec')
        self.assertIn('migrate',r.SHIPPING_MIGRATOR_CREATE_CODE)
        self.assertIn('deploy',r.SHIPPING_MIGRATOR_CREATE_CODE)
        self.assertNotIn('INSERT INTO _prisma_migrations',r.p1_migrator_create_code())
        with self.assertRaises(r.GateError):r.p1_migrator_url(value+'&schema=public')

    def test_exact_node_minor_required_for_formal_node22_images(self):
        self.assertEqual(p1_node_version('v22.13.0'),'v22.13.0')
        self.assertEqual(p1_node_version('v22.23.3\n'),'v22.23.3')
        for value in ('v22.12.99','v20.19.0','v24.0.0','22','UNKNOWN'):
            with self.assertRaises(AssertionError):p1_node_version(value)

    def test_schema_and_migration_bytes_not_rewritten(self):
        path=ROOT/'prisma/migrations'/r.P1_MIGRATION/'migration.sql'
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),r.P1_SQL_HASH)
        self.assertEqual(len(list((ROOT/'prisma/migrations').glob('*/migration.sql'))),89)
        self.assertEqual(subprocess.check_output(['git','show',r.P1_BASE_SHA+':prisma/migrations/'+r.P1_MIGRATION+'/migration.sql'],cwd=ROOT),path.read_bytes())

    def test_unknown_phase_recovery_never_starts_g(self):
        class Fake:
            calls=[]
            def db(self):return {'database':'unknown'}
            def run(self,args,**kw):self.calls.append(args);return b''
        remote=Fake()
        state={'migration_phase':'UNKNOWN','p1Owned':[]}
        with patch.object(r,'validate_database',side_effect=r.GateError('P1_DATABASE_PHASE_UNKNOWN')):
            with self.assertRaises(r.GateError):r.p1_safe_rollback(remote,state,{})
        self.assertFalse(any(call[:2]==['docker','start'] for call in remote.calls))

    def test_pre_migration_restore_rejects_started_unknown_and_unterminated_backup(self):
        for state,code in (({'p1MigrationStarted':True,'migration_phase':'L88'},'P1_DATABASE_PHASE_UNKNOWN'),
                           ({'migration_phase':'UNKNOWN'},'P1_DATABASE_PHASE_UNKNOWN'),
                           ({'migration_phase':'L88','backup_attempted':True,'backup_termination_verified':False},'SHIPPING_BACKUP_TERMINATION_UNVERIFIED')):
            class Fake:
                calls=[]
                def run(self,args,**kw):self.calls.append(args);return b''
            remote=Fake()
            with self.assertRaisesRegex(r.GateError,code):r.p1_restore_pre_migration_g(remote,state,{})
            self.assertFalse(any(call[:2]==['docker','start'] for call in remote.calls))

    def test_pre_migration_restore_requires_exact_l88_before_start(self):
        class Fake:
            calls=[]
            def db(self):return {'applied':88,'failed':1}
            def run(self,args,**kw):self.calls.append(args);return b''
        remote=Fake();state={'p1Owned':[],'migration_phase':'L88','backup_attempted':True,'backup_termination_verified':True}
        with patch.object(r,'before_ledger',return_value={}),patch.object(r,'validate_database',side_effect=r.GateError('P1_DATABASE_PHASE_UNKNOWN')):
            with self.assertRaises(r.GateError):r.p1_restore_pre_migration_g(remote,state,{})
        self.assertFalse(any(call[:2]==['docker','start'] for call in remote.calls))

    def test_pre_migration_stopped_g_restores_existing_active_lifecycle(self):
        binding=self.c['live'];name=binding['containerName']
        g={'Id':binding['containerId'],'Image':binding['imageId'],'Config':{'Labels':binding['containerLabels'],
            'Env':['GIT_SHA='+r.P1_OLD_SHA,'BUDU_RUNTIME_MODE=standby'],'Image':'exact-original-g'},'State':{'Running':False,'StartedAt':'fixture'}}
        class Fake:
            def __init__(self):self.calls=[]
            def db(self):return {}
            def inspect(self,*_):return copy.deepcopy(g)
            def routes(self):return ('original','original')
            def health(self,*_,**kw):pass
            def run(self,args,**kw):
                self.calls.append(args)
                if args[0]=='cat':return (r.P1_OLD_SHA+'\n').encode()
                if args[:2]==['docker','exec']:return json.dumps({'runtimeMode':'active','appStartupTasksStarted':1,'processBackgroundTasksStarted':1}).encode()
                return b''
        remote=Fake();state={'p1Owned':[],'migration_phase':'L88','backup_attempted':True,'backup_termination_verified':True,
            'old':g,'name':name,'template':'original','active':'original','authority_mounts':[]}
        calls=[]
        with patch.object(r,'p1_contract',return_value=self.c),patch.object(r,'before_ledger',return_value={}),             patch.object(r,'validate_database'),patch.object(r,'settle_writers'),patch.object(r,'application_db_probe'),             patch.object(r,'runtime_checks'),patch.object(r,'bg_lifecycle',side_effect=lambda *args:calls.append(args[-1])),             patch.object(r,'bg_promote',side_effect=lambda *args:calls.append('promote')):
            r.p1_restore_pre_migration_g(remote,state,{})
        self.assertEqual(calls,['standby','promote','active'])
        self.assertEqual([x for x in remote.calls if x[:2]==['docker','start']],[['docker','start',g['Id']]])
        self.assertTrue(state['originalGRestoredBeforeMigration'])

    def test_transfer_probe_exact_tenth_same_ssh_and_no_remote_mutation(self):
        data=b'0123456789'*101
        with tempfile.TemporaryDirectory() as directory:
            archive=Path(directory)/'image.tar';archive.write_bytes(data)
            art={'release':'f'*40,'archive':len(data),'archiveHash':hashlib.sha256(data).hexdigest()}
            calls=[]
            class Remote:
                ssh=['ssh','-i','fixture-key','-o','BatchMode=yes','fixture@isolated']
                def run(self,args,data=None,timeout=None):
                    calls.append((args,data,timeout))
                    return json.dumps({'sampleBytes':len(data),'sampleSha256':hashlib.sha256(data).hexdigest(),'verified':True}).encode()
            with patch.object(r,'p1_release',return_value=True),patch('sys.stdout',io.StringIO()):
                proof=r.p1_transfer_probe(Remote(),archive,art)
            self.assertEqual(calls[0][1],data[:101]);self.assertEqual(calls[0][2],60)
            self.assertEqual(proof['sampleBytes'],101)
            self.assertEqual(proof['remoteFilesWritten'],0);self.assertFalse(proof['productionDatabaseAccess'])
            for token in ('open(', 'pathlib','docker','psql','subprocess','DATABASE_URL'):
                self.assertNotIn(token,r.P1_TRANSFER_PROBE_CODE)

    def test_real_probe_reader_checks_exact_bytes_and_hash(self):
        data=b'fixture sample bytes'*4096
        expected=hashlib.sha256(data).hexdigest()
        result=subprocess.run(['python3','-c',r.P1_TRANSFER_PROBE_CODE,str(len(data)),expected],input=data,
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
        self.assertEqual(result.returncode,0)
        self.assertEqual(json.loads(result.stdout),{'sampleBytes':len(data),'sampleSha256':expected,'verified':True})
        short=subprocess.run(['python3','-c',r.P1_TRANSFER_PROBE_CODE,str(len(data)),expected],input=data[:-1],
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
        self.assertNotEqual(short.returncode,0)

    def test_verified_existing_staging_skips_probe_and_full_upload(self):
        data=b'0123456789'*101
        with tempfile.TemporaryDirectory() as directory:
            archive=Path(directory)/'image.tar';archive.write_bytes(data)
            art={'release':'f'*40,'archive':len(data),'archiveHash':hashlib.sha256(data).hexdigest()}
            remote=type('Remote',(),{'ssh':['ssh','fixture@isolated'],'run':lambda *a,**k:b'rsync fixture'})()
            complete={'complete':True,'bytes':len(data),'verified':True}
            verified={'verified':True,'path':'/fixture/exact.tar','bytes':len(data),'sha256':art['archiveHash']}
            with patch.object(r,'p1_release',return_value=True),patch.object(r.shutil,'which',return_value='/fixture/rsync'),                 patch.object(r,'p1_complete_staging',return_value=complete),patch.object(r,'staging_action',return_value=verified) as stage,                 patch.object(r,'p1_transfer_probe') as probe,patch.object(r.subprocess,'run') as upload,patch('sys.stdout',io.StringIO()):
                self.assertEqual(r.stage_artifact(remote,archive,art),'/fixture/exact.tar')
            probe.assert_not_called();upload.assert_not_called();self.assertEqual(stage.call_args.args[-1],'verify')

    def test_transfer_probe_blocked_never_starts_full_rsync(self):
        data=b'0123456789'*101
        with tempfile.TemporaryDirectory() as directory:
            archive=Path(directory)/'image.tar';archive.write_bytes(data)
            art={'release':'f'*40,'archive':len(data),'archiveHash':hashlib.sha256(data).hexdigest()}
            class Remote:
                ssh=['ssh','fixture@isolated']
                def run(self,args,**kw):
                    if args[0]=='rsync':return b'rsync fixture'
                    raise r.GateError('COMMAND_UNAVAILABLE_OR_TIMEOUT')
            with patch.object(r,'p1_release',return_value=True),patch.object(r.shutil,'which',return_value='/fixture/rsync'),                 patch.object(r,'staging_action',return_value={'complete':False,'bytes':0}),                 patch.object(r,'p1_complete_staging',return_value={'complete':False}),patch.object(r.subprocess,'run') as upload,patch('sys.stdout',io.StringIO()):
                with self.assertRaisesRegex(r.GateError,'P1_TRANSFER_PROBE_BLOCKED'):r.stage_artifact(Remote(),archive,art)
            upload.assert_not_called()

    def test_p1_full_upload_has_one_bounded_attempt_and_keeps_partial(self):
        data=b'0123456789'*101
        with tempfile.TemporaryDirectory() as directory:
            archive=Path(directory)/'image.tar';archive.write_bytes(data)
            art={'release':'f'*40,'archive':len(data),'archiveHash':hashlib.sha256(data).hexdigest()}
            remote=type('Remote',(),{'ssh':['ssh','fixture@isolated'],'run':lambda *a,**k:b'rsync fixture'})()
            outcome=type('Result',(),{'returncode':255})()
            with patch.object(r,'p1_release',return_value=True),patch.object(r.shutil,'which',return_value='/fixture/rsync'),                 patch.object(r,'staging_action',return_value={'complete':False,'bytes':0}) as stage,                 patch.object(r,'p1_complete_staging',return_value={'complete':False}),patch.object(r,'p1_transfer_probe',return_value={'estimatedFullSeconds':100}),                 patch.object(r.subprocess,'run',return_value=outcome) as upload,patch('sys.stdout',io.StringIO()):
                with self.assertRaises(r.GateError):r.stage_artifact(remote,archive,art)
            self.assertEqual(upload.call_count,1);self.assertLessEqual(upload.call_args.kwargs['timeout'],200)
            self.assertEqual(stage.call_count,1)
            self.assertIn('--partial',upload.call_args.args[0]);self.assertNotIn('--delete',upload.call_args.args[0])

    def test_actual_bound_official_license_exceptions_pass_without_edit(self):
        release=r.git(ROOT,'rev-parse','HEAD')
        r.p1_license_diff_check(ROOT,release)
        self.assertEqual(len(r.P1_LICENSE_DIFF_EXCEPTIONS),4)
        self.assertEqual(self.c['branch'],r.P1_BRANCH)

    def test_unbound_or_changed_official_licenses_are_rejected(self):
        release=r.git(ROOT,'rev-parse','HEAD')
        for name,expected in r.P1_LICENSE_DIFF_EXCEPTIONS.items():
            for broken in ('missing','changed'):
                c=copy.deepcopy(self.c)
                if broken=='missing':c['sourceHashes'].pop(name)
                else:c['sourceHashes'][name]='0'*64
                with patch.object(r,'P1_CONTRACT',c):
                    with self.assertRaisesRegex(r.GateError,'P1_LICENSE_EXCEPTION_UNBOUND'):r.p1_license_diff_check(ROOT,release)
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)
            for name in r.P1_LICENSE_DIFF_EXCEPTIONS:
                path=target/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes((ROOT/name).read_bytes())
            first=target/next(iter(r.P1_LICENSE_DIFF_EXCEPTIONS));first.write_bytes(first.read_bytes()+b'changed')
            with self.assertRaisesRegex(r.GateError,'P1_LICENSE_EXCEPTION_DRIFT'):r.p1_license_diff_check(target,release)

    def test_only_four_literal_paths_excluded_other_whitespace_still_checked(self):
        # Actual Git fixture validates pathspec semantics, including another
        # license/resource and application code with newly introduced whitespace.
        with tempfile.TemporaryDirectory() as directory:
            repo=Path(directory)
            def git(*args):return subprocess.check_output(['git','-C',str(repo),*args],stderr=subprocess.DEVNULL).decode().strip()
            git('init','-q');git('config','user.email','p1-fixture@example.invalid');git('config','user.name','P1 fixture')
            (repo/'README').write_text('fixture\n');git('add','.');git('commit','-qm','baseline');before=git('rev-parse','HEAD')
            for name in r.P1_LICENSE_DIFF_EXCEPTIONS:
                path=repo/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes((ROOT/name).read_bytes())
            git('add','.');git('commit','-qm','official vendor data');business=git('rev-parse','HEAD')
            c=copy.deepcopy(self.c);c.update(oldSha=before,businessSha=business)
            with patch.object(r,'EXPECTED_OLD_SHA',before),patch.object(r,'P1_OLD_SHA',before),                 patch.object(r,'P1_BUSINESS_SHA',business),patch.object(r,'RUNTIME_SHA',business),patch.object(r,'P1_CONTRACT',c):
                r.p1_license_diff_check(repo,business)
                for filename in ('server/guard.js','public/pdfjs/6.4.299/wasm/LICENSE_PDFJS_QCMS'):
                    path=repo/filename;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('must reject trailing space   \n')
                    git('add','.');git('commit','-qm','invalid fixture whitespace');release=git('rev-parse','HEAD')
                    with self.assertRaisesRegex(r.GateError,'COMMAND_FAILED'):r.p1_license_diff_check(repo,release)
                    path.write_text('valid fixture\n');git('add','.');git('commit','-qm','restore valid fixture whitespace')
                    r.p1_license_diff_check(repo,git('rev-parse','HEAD'))

    def test_legacy_profiles_have_unchanged_migration_contract(self):
        r.configure_profile('post-transfer',r.SHIPPING_OLD_SHA,r.SHIPPING_BUSINESS_SHA,'a'*64)
        self.assertFalse(r.p1_release());self.assertEqual(r.migration_before_phase(),'L85')
        self.assertEqual(r.migration_target(),r.SHIPPING_MIGRATION)
        r.configure_profile('post-transfer',r.procurement_contract()['oldSha'],r.procurement_contract()['businessSha'],'a'*64)
        self.assertFalse(r.p1_release());self.assertEqual(r.migration_before_phase(),'L87')
        self.assertEqual(r.migration_after_phase(),'L88')

    def test_no_automatic_p1_publish_or_failure_notification(self):
        workflow=(ROOT/'.github/workflows/deploy-prod.yml').read_text()
        self.assertNotIn('  push:',workflow)
        self.assertIn("if: failure() && github.ref != 'refs/heads/"+r.P1_BRANCH+"'",workflow)
        build=(ROOT/'.github/workflows/release-build-only.yml').read_text()
        push=build.split('  push:',1)[1].split('\nenv:',1)[0]
        self.assertNotIn(r.P1_BRANCH,push)
        self.assertIn('python3 scripts/test-p1-release-contract.py --prisma-timeout-proof',build)

    def test_real_frozen_identity_when_engineering_commit_exists(self):
        if not r.p1_release():self.skipTest('business SHA remains intentionally unbound')
        head=r.git(ROOT,'rev-parse','HEAD')
        if r.git(ROOT,'branch','--show-current')!=r.P1_BRANCH or r.git(ROOT,'status','--porcelain','--untracked-files=all'):
            self.skipTest('clean r2 engineering candidate not committed yet')
        if r.git(ROOT,'rev-list','--parents','-n','1',head)!=head+' '+r.P1_BUSINESS_SHA:
            self.skipTest('engineering child not committed yet')
        release,ledger=r.identity(ROOT)
        self.assertEqual((release,len(ledger)),(head,89))


def bind_contract(business,live_json):
    assert re.fullmatch('[0-9a-f]{40}',business)
    assert r.git(ROOT,'rev-list','--parents','-n','1',business)==business+' '+r.P1_BASE_SHA
    paths=r.git(ROOT,'diff','--name-only',r.P1_OLD_SHA,business).splitlines()
    c=json.loads(CONTRACT.read_text());c['businessSha']=business
    c['sourceHashes']={p:hashlib.sha256(subprocess.check_output(['git','show',business+':'+p],cwd=ROOT)).hexdigest() for p in paths}
    manifest={p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'dist').rglob('*') if p.is_file()}
    assert 'dist/index.html' in manifest
    c['frontendManifest']=manifest
    package=ROOT/'node_modules/pdfjs-dist'
    assert json.loads((package/'package.json').read_text())['version']=='6.4.299'
    resource_paths=[package/'LICENSE',*package.glob('cmaps/*.bcmap'),package/'cmaps/LICENSE',
        *package.glob('standard_fonts/*.pfb'),*package.glob('standard_fonts/*.ttf'),*package.glob('standard_fonts/LICENSE*'),
        *(package/'wasm'/name for name in ('jbig2.wasm','openjpeg.wasm','qcms_bg.wasm','jbig2_nowasm_fallback.js','openjpeg_nowasm_fallback.js')),
        *package.glob('wasm/LICENSE*'),package/'iccs/CGATS001Compat-v2-micro.icc',package/'iccs/LICENSE',
        *(package/'web/images'/('annotation-'+name+'.svg') for name in ('check','comment','help','insert','key','newparagraph','note','paragraph'))]
    resources={}
    for p in resource_paths:
        payload=p.read_bytes();h=hashlib.sha256(payload).hexdigest();key=p.relative_to(package).as_posix()
        relative=key.removeprefix('web/')
        source='public/pdfjs/6.4.299/'+relative;emitted='dist/pdfjs/6.4.299/'+relative
        assert manifest.get(emitted)==h, 'P1_PDF_RESOURCE_MISSING:'+key
        assert subprocess.check_output(['git','show',business+':'+source],cwd=ROOT)==payload,'P1_PDF_PUBLIC_SOURCE_MISMATCH:'+key
        resources[key]={'hash':h,'path':emitted}
    worker=package/'legacy/build/pdf.worker.min.mjs';worker_hash=hashlib.sha256(worker.read_bytes()).hexdigest()
    worker_paths=[name for name,h in manifest.items() if h==worker_hash and name.endswith('.mjs')]
    assert len(worker_paths)==1,'P1_PDF_WORKER_MISSING'
    resources['legacy/build/pdf.worker.min.mjs']={'hash':worker_hash,'path':worker_paths[0]}
    c['pdfResources']=resources
    live=json.loads(Path(live_json).read_text());c['live']['containerLabels']=live['containerLabels'];c['live']['imageLabels']=live['imageLabels']
    CONTRACT.write_text(json.dumps(c,ensure_ascii=False,sort_keys=True,indent=2)+'\n')
    for path in (ROOT/'scripts/deploy-prod-transfer-cas.py',ROOT/'.github/workflows/release-build-only.yml'):
        source=path.read_text();assert 'P1_BUSINESS_SHA_UNBOUND' in source
        path.write_text(source.replace('P1_BUSINESS_SHA_UNBOUND',business))
    print(json.dumps({'boundBusinessSha':business,'sourceFileCount':len(paths),'frontendFileCount':len(manifest)}))


def prisma_timeout_proof(tags,archives=None,builder_node_proof=None):
    # Fresh unique local Docker objects. No secrets, host port, business mounts,
    # deployment target, SSH, real customers, or production database are accepted.
    c=bound();assert r.p1_release();assert len(tags)==2
    image_bindings=[]
    for tag,sha in zip(tags,(r.git(ROOT,'rev-parse','HEAD'),r.P1_BUSINESS_SHA)):
        assert tag=='budu-api:post-transfer-'+sha[:12]
        meta=json.loads(subprocess.check_output(['docker','image','inspect',tag]))[0]
        assert meta['Architecture']=='amd64' and meta['Os']=='linux'
        assert meta['Config']['Labels']=={r.REVISION:sha}
        node_version=p1_node_version(subprocess.check_output(['docker','run','--rm','--network','none','--entrypoint','node',tag,'--version'],text=True))
        image_bindings.append({'sha':sha,'imageId':meta['Id'],'rootfsDiffIds':meta['RootFS']['Layers'],'nodeVersion':node_version})
    builder_proof=json.loads(Path(builder_node_proof).read_text()) if builder_node_proof else None
    if builder_proof:verify_builder_node_proof(builder_proof)
    token=uuid.uuid4().hex[:12];network='budu-p1-fixture-'+token;pg=network+'-pg'
    def run(args,data=None,timeout=60,success=True):
        out=subprocess.run(args,input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
        if success and out.returncode:raise AssertionError('P1_ISOLATED_COMMAND_FAILED')
        return out
    def sql(text):return run(['docker','exec','-i',pg,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','p1_fixture'],text.encode()).stdout
    def cli(tag,text,expect=True,timeout=60):
        value=r.p1_migrator_url('postgresql://postgres@'+pg+':5432/p1_fixture?schema=public')
        return run(['docker','run','--rm','-i','--network',network,'-e','DATABASE_URL='+value,'--entrypoint','node',tag,'/app/node_modules/prisma/build/index.js','db','execute','--stdin','--schema','/app/prisma/schema.prisma'],text.encode(),timeout,expect)
    run(['docker','network','create','--internal',network])
    try:
        run(['docker','run','-d','--name',pg,'--network',network,'--restart','no','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=p1_fixture','postgres:16.14-bookworm'],timeout=180)
        for _ in range(60):
            if run(['docker','exec',pg,'pg_isready','-U','postgres','-d','p1_fixture'],success=False).returncode==0:break
            time.sleep(.5)
        assert sql("SELECT current_setting('server_version');").decode().strip().startswith('16.14')
        sql('CREATE TABLE lock_fixture (id INTEGER);')
        results=[]
        for tag in tags:
            cli(tag,r.P1_SETTINGS_SQL)
            blocker=subprocess.Popen(['docker','exec',pg,'psql','-X','-qAt','-U','postgres','-d','p1_fixture','-c','BEGIN; LOCK TABLE lock_fixture IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(8); COMMIT;'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            try:
                for _ in range(40):
                    if sql("SELECT count(*) FROM pg_locks WHERE relation='lock_fixture'::regclass AND mode='AccessExclusiveLock' AND granted;").strip()==b'1':break
                    time.sleep(.05)
                started=time.monotonic();failed=cli(tag,'ALTER TABLE lock_fixture ADD COLUMN forbidden INTEGER;',False);elapsed=time.monotonic()-started
                assert failed.returncode!=0 and 1.5<=elapsed<7
            finally:blocker.wait(timeout=10)
            started=time.monotonic();failed=cli(tag,'SELECT pg_sleep(40);',False,50);statement=time.monotonic()-started
            assert failed.returncode!=0 and 29<=statement<39
            assert sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='budu_p1_migrator';").strip()==b'0'
            results.append({'tag':tag,'settingsVerified':True,'lockTimeoutSeconds':elapsed,'statementTimeoutSeconds':statement,'zeroSessionsAfterFailure':True})
        # Establish the real 88-entry baseline through formal pinned Prisma.
        # Nothing is inserted into _prisma_migrations by a handwritten SQL path.
        databases=('p1_fixture','p1_failed','p1_interrupted')
        def sql_db(database,text):
            assert database in databases
            return run(['docker','exec','-i',pg,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],text.encode()).stdout
        with tempfile.TemporaryDirectory(prefix='budu-p1-migration-fixture-') as directory:
            root=Path(directory);shutil.copy(ROOT/'prisma/schema.prisma',root/'schema.prisma')
            migrations=root/'migrations';migrations.mkdir()
            for original in (ROOT/'prisma/migrations').glob('*/migration.sql'):
                if original.parent.name==r.P1_MIGRATION:continue
                dest=migrations/original.parent.name;dest.mkdir();shutil.copy(original,dest/'migration.sql')
            (migrations/'migration_lock.toml').write_text('provider = "postgresql"\n')
            def migration_args(database,name=None):
                value=r.p1_migrator_url('postgresql://postgres@'+pg+':5432/'+database+'?schema=public')
                return ['docker','run',*(['--name',name] if name else ['--rm']),'--network',network,
                    '-e','DATABASE_URL='+value,'-v',str(root)+':/fixture:ro','--entrypoint','node',tags[0],
                    '/app/node_modules/prisma/build/index.js','migrate','deploy','--schema','/fixture/schema.prisma']
            run(migration_args('p1_fixture'),timeout=180)
            assert sql("SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;").strip()==b'88'
            # Baselines are local synthetic template copies, never production restores.
            sql('CREATE DATABASE p1_failed TEMPLATE p1_fixture; CREATE DATABASE p1_interrupted TEMPLATE p1_fixture;')
            migration=migrations/r.P1_MIGRATION;migration.mkdir()
            shutil.copy(ROOT/'prisma/migrations'/r.P1_MIGRATION/'migration.sql',migration/'migration.sql')
            blocker=subprocess.Popen(['docker','exec',pg,'psql','-X','-qAt','-U','postgres','-d','p1_failed','-c','BEGIN; LOCK TABLE approval_requests IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(8); COMMIT;'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            try:
                for _ in range(40):
                    if sql_db('p1_failed',"SELECT count(*) FROM pg_locks WHERE relation='approval_requests'::regclass AND mode='AccessExclusiveLock' AND granted;").strip()==b'1':break
                    time.sleep(.05)
                started=time.monotonic();failed=run(migration_args('p1_failed'),timeout=15,success=False)
                migration_lock=time.monotonic()-started;assert failed.returncode!=0 and 1.5<=migration_lock<7
            finally:blocker.wait(timeout=10)
            failure=json.loads(sql_db('p1_failed',"SELECT json_build_object('applied',(SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),'failed',(SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL),'column',(SELECT count(*) FROM information_schema.columns WHERE table_name='approval_requests' AND column_name='content_version'),'counter',to_regclass('public.approval_request_daily_sequences') IS NOT NULL,'sessions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='budu_p1_migrator'));"))
            assert failure=={'applied':88,'failed':1,'column':0,'counter':False,'sessions':0}
            # Interrupt the exact migrator while DDL is waiting; prove Docker exit
            # and PostgreSQL zero clients before any recovery decision.
            interrupted=network+'-migrator';child=None
            blocker=subprocess.Popen(['docker','exec',pg,'psql','-X','-qAt','-U','postgres','-d','p1_interrupted','-c','BEGIN; LOCK TABLE approval_requests IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(8); COMMIT;'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            try:
                for _ in range(40):
                    if sql_db('p1_interrupted',"SELECT count(*) FROM pg_locks WHERE relation='approval_requests'::regclass AND mode='AccessExclusiveLock' AND granted;").strip()==b'1':break
                    time.sleep(.05)
                child=subprocess.Popen(migration_args('p1_interrupted',interrupted),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                for _ in range(80):
                    if sql_db('p1_interrupted',"SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='budu_p1_migrator';").strip()!=b'0':break
                    time.sleep(.025)
                else:raise AssertionError('P1_INTERRUPTED_MIGRATOR_NOT_OBSERVED')
                run(['docker','stop','--time','1',interrupted],timeout=10);child.wait(timeout=10)
                current=json.loads(run(['docker','inspect',interrupted]).stdout)[0]
                assert current['State']['Running'] is False
                for _ in range(40):
                    if sql_db('p1_interrupted',"SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='budu_p1_migrator';").strip()==b'0':break
                    time.sleep(.05)
                else:raise AssertionError('P1_INTERRUPTED_MIGRATOR_SESSIONS_UNKNOWN')
                interrupted_ledger=json.loads(sql_db('p1_interrupted',"SELECT json_build_object('applied',(SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),'failed',(SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL));"))
                assert interrupted_ledger['applied']==88 and interrupted_ledger['failed'] in (0,1)
            finally:
                run(['docker','rm','-f',interrupted],success=False)
                if child:child.wait(timeout=10)
                blocker.wait(timeout=10)
            run(migration_args('p1_fixture'),timeout=180)
            assert sql("SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;").strip()==b'89'
        assert sql("SELECT checksum FROM _prisma_migrations WHERE migration_name='"+r.P1_MIGRATION+"' AND finished_at IS NOT NULL;").strip().decode()==r.P1_SQL_HASH
        # Use the public schema query directly, without a fake positive result.
        schema_code=r.p1_database_details.__code__.co_consts
        query=next(x for x in schema_code if isinstance(x,str) and x.startswith('BEGIN READ ONLY; SELECT json_build_object('))
        schema=json.loads(sql(query))
        assert schema==c['schemaL89']
        # Exact E and R lifecycle on the migrated synthetic authority. Reuse
        # the production promotion/lifecycle/Prisma/fact helpers directly.
        r.PG=pg;r.EXPECTED_DB='p1_fixture'
        class FixtureRemote:
            def run(self,args,data=None,timeout=60):
                assert args[0] in ('docker','sh')
                return run(args,data,timeout).stdout
            def inspect(self,ref,image=False):
                return json.loads(self.run(['docker','image','inspect',ref] if image else ['docker','inspect',ref]))[0]
            def py(self,code,value=None,timeout=60):
                return run(['python3','-c',code],json.dumps(value).encode() if value is not None else None,timeout).stdout
        remote=FixtureRemote();lifecycle=[];apps=[]
        def app_start(tag,sha,suffix):
            name=network+'-'+suffix
            args=['docker','create','--name',name,'--network',network,'--restart','no',
                '--label','budu.production-role=candidate','--label',r.REVISION+'='+sha]
            for key,value in {'DATABASE_URL':'postgresql://postgres@'+pg+':5432/p1_fixture?schema=public',
                'APP_ENV':'test','NODE_ENV':'test','DATA_STORE':'file','DATA_DIR':'/app/server/data',
                'WECHAT_PAY_ENABLED':'0','ALIPAY_ENABLED':'0','GIT_SHA':sha,'BUDU_RUNTIME_MODE':'standby',
                'CUSTOMER_REQUEST_WECOM_RECIPIENT_USERNAME':'budu','CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID':'dh'}.items():
                args.extend(['-e',key+'='+value])
            args.append(tag);run(args);apps.append(name);run(['docker','start',name])
            for _ in range(120):
                probe=run(['docker','exec',name,'wget','-qO-','http://127.0.0.1:3000/api/health'],success=False)
                if probe.returncode==0 and json.loads(probe.stdout).get('dbOk') is True:break
                if remote.inspect(name)['State']['Running'] is False:raise AssertionError('P1_FIXTURE_APP_START_FAILED')
                time.sleep(.25)
            else:raise AssertionError('P1_FIXTURE_APP_HEALTH_TIMEOUT')
            current=remote.inspect(name)
            art={'release':sha,'loadedDockerImageId':current['Image'],'imageReference':tag}
            state={'candidate':name,'candidateId':current['Id'],'lifecycleSince':current['State']['StartedAt']}
            r.bg_lifecycle(remote,{'art':art},state,'standby')
            r.application_db_probe(remote,name,'CANDIDATE_APPLICATION_DB_PROBE_FAILED')
            return art,state
        try:
            art,state=app_start(tags[0],r.git(ROOT,'rev-parse','HEAD'),'e')
            r.bg_promote(remote,{'art':art},state);r.bg_lifecycle(remote,{'art':art},state,'active')
            r.application_db_probe(remote,state['candidate'],'CANDIDATE_APPLICATION_DB_PROBE_FAILED')
            run(['docker','stop','--time','10',state['candidate']]);assert not remote.inspect(state['candidate'])['State']['Running']
            assert sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND client_addr IS NOT NULL;").strip()==b'0'
            sql("INSERT INTO approval_request_daily_sequences(day,value) VALUES('2099-01-01',17); INSERT INTO approval_requests(id,request_no,template_key,form_data,submitter_username,title,status,amount_cents) VALUES('p1-recovery-fixture','AP-20990101-0017','expense','{}','p1_fixture','fixture','draft',0); UPDATE approval_requests SET title='updated fixture' WHERE id='p1-recovery-fixture';")
            assert sql("SELECT content_version FROM approval_requests WHERE id='p1-recovery-fixture';").strip()==b'2'
            before=r.p1_facts(remote)
            art,recovery=app_start(tags[1],r.P1_BUSINESS_SHA,'r')
            r.bg_promote(remote,{'art':art},recovery);r.bg_lifecycle(remote,{'art':art},recovery,'active')
            r.application_db_probe(remote,recovery['candidate'],'ROLLBACK_APPLICATION_DB_PROBE_FAILED')
            assert r.p1_facts(remote)==before
            assert sql("SELECT content_version FROM approval_requests WHERE id='p1-recovery-fixture';").strip()==b'2'
            assert sql("SELECT value FROM approval_request_daily_sequences WHERE day='2099-01-01';").strip()==b'17'
            lifecycle=[{'sha':r.git(ROOT,'rev-parse','HEAD'),'standby':True,'promotion':'active','startupCounts':[1,1],'stoppedBeforeR':True},
                {'sha':r.P1_BUSINESS_SHA,'standby':True,'promotion':'active','startupCounts':[1,1],'retainedFactHash':before,'versionRetained':2,'counterRetained':17,'prismaSelect1':True}]
        finally:
            for name in apps:run(['docker','rm','-f',name],success=False)
        proof={'result':'P1_ISOLATED_PRISMA_PROOF_PASS','pgVersion':'16.14','migrationChecksum':r.P1_SQL_HASH,'schemaL89':schema,'images':results,'imageBindings':image_bindings,'releaseSha':r.git(ROOT,'rev-parse','HEAD'),'businessSha':r.P1_BUSINESS_SHA,'contractSha256':hashlib.sha256(CONTRACT.read_bytes()).hexdigest(),'archiveHashes':[hash_path(p) for p in archives] if archives else None,'builderNodeProof':builder_proof,'lifecycle':lifecycle,'migrationLockFailure':failure,'migrationLockTimeoutSeconds':migration_lock,'interruptedMigratorStopped':True,'interruptedMigratorLedger':interrupted_ledger,'productionAccess':False}
        target=Path(os.environ.get('RUNNER_TEMP',tempfile.gettempdir()))/'p1-prisma-timeout-proof.json'
        target.write_text(json.dumps(proof,sort_keys=True,indent=2)+'\n');print(json.dumps(proof))
    finally:
        run(['docker','rm','-f',pg],success=False)
        run(['docker','network','rm',network],success=False)


def builder_node_stage_proof(tags,contexts):
    bound();assert r.p1_release() and len(tags)==len(contexts)==2
    records=[]
    for tag,directory,sha in zip(tags,contexts,(r.git(ROOT,'rev-parse','HEAD'),r.P1_BUSINESS_SHA)):
        assert tag=='budu-p1-builder:'+sha[:12]
        image=json.loads(subprocess.check_output(['docker','image','inspect',tag]))[0]
        assert image['Os']=='linux' and image['Architecture']=='amd64'
        assert image['Config']['Labels'].get(r.REVISION)==sha
        frozen=subprocess.check_output(['git','show',sha+':Dockerfile'],cwd=ROOT)
        assert (Path(directory)/'Dockerfile').read_bytes()==frozen
        script="const fs=require('fs'),crypto=require('crypto');for(const [p,h] of Object.entries(JSON.parse(process.argv[1]))){if(crypto.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex')!==h)process.exit(1)}process.stdout.write(process.version+'\\n');"
        node=p1_node_version(subprocess.check_output(['docker','run','--rm','--network','none','--entrypoint','node',tag,'-e',script,json.dumps(r.p1_contract()['frontendManifest'],separators=(',',':'))],text=True))
        records.append({'sha':sha,'tree':r.git(ROOT,'rev-parse',sha+'^{tree}'),
            'dockerfileSha256':hashlib.sha256(frozen).hexdigest(),'builderImageId':image['Id'],'nodeVersion':node})
    proof={'releaseSha':r.git(ROOT,'rev-parse','HEAD'),'businessSha':r.P1_BUSINESS_SHA,'contexts':records}
    verify_builder_node_proof(proof)
    target=Path(os.environ.get('RUNNER_TEMP',tempfile.gettempdir()))/'p1-builder-node-proof.json'
    target.write_text(json.dumps(proof,sort_keys=True,indent=2)+'\n')
    print(json.dumps({'result':'P1_BUILDER_NODE_STAGE_PROOF_PASS','proof':proof}))


def verify_builder_node_proof(proof):
    assert proof['releaseSha']==r.git(ROOT,'rev-parse','HEAD') and proof['businessSha']==r.P1_BUSINESS_SHA
    assert len(proof['contexts'])==2
    for record,sha in zip(proof['contexts'],(proof['releaseSha'],proof['businessSha'])):
        assert record['sha']==sha and record['tree']==r.git(ROOT,'rev-parse',sha+'^{tree}')
        assert record['dockerfileSha256']==hashlib.sha256(subprocess.check_output(['git','show',sha+':Dockerfile'],cwd=ROOT)).hexdigest()
        assert re.fullmatch('sha256:[0-9a-f]{64}',record['builderImageId'])
        p1_node_version(record['nodeVersion'])


def verify_retained_proof(proof_path,e_archive,r_archive):
    c=bound();assert r.p1_release()
    proof=json.loads(Path(proof_path).read_text())
    assert proof['result']=='P1_ISOLATED_PRISMA_PROOF_PASS' and proof['productionAccess'] is False
    assert proof['releaseSha']==r.git(ROOT,'rev-parse','HEAD') and proof['businessSha']==r.P1_BUSINESS_SHA
    assert proof['contractSha256']==hashlib.sha256(CONTRACT.read_bytes()).hexdigest()
    assert proof['archiveHashes']==[hash_path(p) for p in (e_archive,r_archive)]
    verify_builder_node_proof(proof['builderNodeProof'])
    assert len(proof['imageBindings'])==2
    for image in proof['imageBindings']:p1_node_version(image['nodeVersion'])
    assert proof['schemaL89']==c['schemaL89'] and proof['migrationChecksum']==r.P1_SQL_HASH
    assert len(proof['images'])==len(proof['lifecycle'])==2 and proof['interruptedMigratorStopped'] is True
    assert all(x['settingsVerified'] is True and x['zeroSessionsAfterFailure'] is True for x in proof['images'])
    assert all(x['promotion']=='active' and x['standby'] is True and x['startupCounts']==[1,1] for x in proof['lifecycle'])
    assert proof['lifecycle'][1]['versionRetained']==2 and proof['lifecycle'][1]['counterRetained']==17
    assert proof['migrationLockFailure']=={'applied':88,'failed':1,'column':0,'counter':False,'sessions':0}
    print(json.dumps({'result':'P1_RETAINED_PROOF_PASS','releaseSha':proof['releaseSha'],'businessSha':r.P1_BUSINESS_SHA}))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--bind',nargs=2,metavar=('BUSINESS_SHA','LIVE_LABELS_JSON'))
    parser.add_argument('--prisma-timeout-proof',nargs=2,metavar=('E_IMAGE','R_IMAGE'));parser.add_argument('--archives',nargs=2);parser.add_argument('--builder-node-proof');parser.add_argument('--builder-stage-proof',nargs=2);parser.add_argument('--source-contexts',nargs=2);parser.add_argument('--verify-retained-proof',nargs=3)
    args,rest=parser.parse_known_args()
    if args.bind:bind_contract(*args.bind)
    elif args.prisma_timeout_proof:prisma_timeout_proof(args.prisma_timeout_proof,args.archives,args.builder_node_proof)
    elif args.verify_retained_proof:verify_retained_proof(*args.verify_retained_proof)
    elif args.builder_stage_proof:builder_node_stage_proof(args.builder_stage_proof,args.source_contexts)
    else:unittest.main(argv=[__file__,*rest])

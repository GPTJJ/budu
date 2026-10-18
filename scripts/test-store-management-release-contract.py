#!/usr/bin/env python3
"""Offline release contract tests. No production access or business writes."""
import contextlib
import copy
import importlib.util
import inspect
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('release', ROOT/'scripts/deploy-prod-transfer-cas.py')
r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)
LIVE = json.loads((ROOT/r.STORE_PROOF).read_text())
LEDGER = LIVE['ledger']


def configure():
    r.configure_profile('post-transfer', r.STORE_BASE, r.STORE_BUSINESS, '0'*64)
    r.BG_ACTIVE=True; r.BG_LIVE=copy.deepcopy(LIVE)
    r.STORE_IDENTITY=True; r.STORE_RELEASE_SHA='a'*40


class IdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory(); cls.repo=Path(cls.tmp.name)/'repo'
        subprocess.run(['git','clone','--shared','--no-checkout',str(ROOT),str(cls.repo)],check=True,capture_output=True)
        cls.git('checkout','-B',r.STORE_BRANCH,r.STORE_BUSINESS)
        for name in r.STORE_FILES:
            target=cls.repo/name; target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/name,target)
        cls.git('add',*sorted(r.STORE_FILES));cls.git('-c','user.name=Contract Test','-c','user.email=test@invalid','commit','-m','Scoped engineering fixture')
        cls.sha=cls.git('rev-parse','HEAD')
    @classmethod
    def tearDownClass(cls):cls.tmp.cleanup()
    @classmethod
    def git(cls,*args):return subprocess.check_output(['git','-C',str(cls.repo),*args],stderr=subprocess.DEVNULL,text=True).strip()
    def setUp(self):configure();r.STORE_IDENTITY=False;r.STORE_RELEASE_SHA=None
    def test_correct_frozen_identity(self):
        r.store_identity(self.repo,self.sha)
        self.assertTrue(r.STORE_IDENTITY);self.assertEqual(r.STORE_RELEASE_SHA,self.sha)
        self.assertFalse(r.migration_enabled());self.assertTrue(r.procurement_hotfix())
    def test_wrong_base_business_and_missing_lifecycle(self):
        for name,value in [('EXPECTED_OLD_SHA','f'*40),('RUNTIME_SHA','f'*40),('BG_ACTIVE',False),('THIN_MODE',True)]:
            with self.subTest(name=name),patch.object(r,name,value),self.assertRaises(r.GateError):r.store_identity(self.repo,self.sha)
    def test_edited_business_rejected(self):
        file=self.repo/'server/v2.js';original=file.read_bytes()
        try:
            file.write_bytes(original+b'\n// unauthorized edit\n');self.git('add','server/v2.js')
            self.git('-c','user.name=Contract Test','-c','user.email=test@invalid','commit','-m','Negative business mutation')
            with self.assertRaisesRegex(r.GateError,'STORE_ENGINEERING_SCOPE_INVALID'):r.store_identity(self.repo,self.git('rev-parse','HEAD'))
        finally:self.git('reset','--hard',self.sha) # disposable fixture only
    def test_live_proof_missing_or_wrong(self):
        for key,value in [('runtimeMode','standby'),('LIVE_G_IMAGE_ID','sha256:'+'f'*64),('appStartupTasksStarted',0),('routeHash','f'*64),('DB_FAILED',1)]:
            v=copy.deepcopy(LIVE);v[key]=value
            with self.subTest(key=key),self.assertRaises(r.GateError):r.store_live_proof(v)
    def test_omitted_cli_contract_fails_closed(self):
        for args in [[],['--release-profile','post-transfer','--expected-production-sha',r.STORE_BASE,'--business-base-sha',r.STORE_BUSINESS]]:
            result=subprocess.run([sys.executable,str(self.repo/'scripts/deploy-prod-transfer-cas.py'),'identity','--repo',str(self.repo),*args],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0);self.assertIn('STORE_EXPLICIT_CONTRACT_REQUIRED',result.stdout)
    def test_full_cli_identity(self):
        result=subprocess.run([sys.executable,str(self.repo/'scripts/deploy-prod-transfer-cas.py'),'identity','--repo',str(self.repo),'--release-profile','post-transfer','--expected-production-sha',r.STORE_BASE,'--business-base-sha',r.STORE_BUSINESS,'--blue-green-live-proof',str(self.repo/r.STORE_PROOF)],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stdout);self.assertIn('IDENTITY_PASS',result.stdout)


class LedgerAndEntryTests(unittest.TestCase):
    def setUp(self):configure()
    def database(self):return {'database':r.EXPECTED_DB,'applied':88,'failed':0,'rolledBack':0,'ledger':dict(LEDGER),'procurementSchema':{'schemaMd5':r.procurement_contract()['schemaMd5']}}
    def test_exact_88_and_no_migration(self):
        r.validate_database(self.database(),LEDGER);self.assertFalse(r.migration_enabled());self.assertEqual(r.before_ledger(LEDGER),LEDGER)
    def test_checksum_failed_rolledback_missing_rejected(self):
        for kind in ['checksum','failed','rolledBack','missing','database']:
            db=self.database()
            if kind=='checksum':db['ledger'][next(iter(LEDGER))]='f'*64
            elif kind=='missing':db['ledger'].pop(next(iter(LEDGER)))
            elif kind=='database':db[kind]='other'
            else:db[kind]=1
            with self.subTest(kind=kind),self.assertRaises(r.GateError):r.validate_database(db,LEDGER)
    def value(self):return {'art':{'release':'a'*40,'capacityProfile':r.STORE_PROFILE,'runtimeHash':r.STORE_RUNTIME_HASH},'ledger':LEDGER,'live':LIVE,'businessTree':r.STORE_TREE,'waiver':None,'migrationSql':None,'compatibilityProof':None}
    def test_remote_bootstrap_same_contract(self):
        v=self.value();r.store_remote_bootstrap(v);self.assertTrue(r.store_art_scope(v['art']))
        for key in ['businessTree','live','ledger']:
            bad=copy.deepcopy(v);bad[key]={} if key!='businessTree' else 'f'*40
            with self.subTest(key=key),self.assertRaises(r.GateError):r.store_remote_bootstrap(bad)
        for key in ['migrationSql','waiver','compatibilityProof']:
            bad=copy.deepcopy(v);bad[key]='unexpected'
            with self.subTest(key=key),self.assertRaises(r.GateError):r.store_remote_bootstrap(bad)
    def test_remote_runtime_hash_and_wrong_base_rejected(self):
        v=self.value();v['art']['runtimeHash']='f'*64
        with self.assertRaises(r.GateError):r.store_remote_bootstrap(v)
        with patch.object(r,'EXPECTED_OLD_SHA','f'*40),self.assertRaises(r.GateError):r.store_remote_bootstrap(self.value())
    def test_ci_and_remote_wiring(self):
        shell=(ROOT/'scripts/release-prod-post-transfer-ci.sh').read_text();workflow=(ROOT/'.github/workflows/release-build-only.yml').read_text()
        self.assertIn('PROFILE+=(--blue-green-live-proof',shell)
        self.assertIn('store-management:',workflow);self.assertIn(r.STORE_BUSINESS,workflow);self.assertIn(r.STORE_BASE,workflow)
        self.assertIn('store_remote_bootstrap(v)',inspect.getsource(r.bg_deploy))
        self.assertIn('bg_bind(args.repo,release,art,BG_LIVE)',inspect.getsource(r.main))
        self.assertIn('bg_g_guard(remote,value)',inspect.getsource(r.preflight))
    def test_old_contract_keeps_original_protection(self):
        r.configure_profile('post-transfer',r.STORE_BASE,'f'*40,'0'*64);r.BG_ACTIVE=False
        self.assertFalse(r.store_release());self.assertFalse(r.procurement_hotfix())
        self.assertEqual(r.EXPECTED_MIGRATIONS,85)
        with self.assertRaises(r.GateError):r.validate_database(self.database(),LEDGER)
    def test_single_writer_rejects_two_or_unknown_clients(self):
        def container(name,ip):return {'Name':'/'+name,'Config':{'Env':['DATABASE_URL=postgresql://test@db/budu_bj006']},'NetworkSettings':{'Networks':{'n':{'IPAddress':ip}}}}
        g=container('G','10.0.0.1');e=container('E','10.0.0.2')
        r.writer_check([g],{'clients':['10.0.0.1']},['G'])
        with self.assertRaises(r.GateError):r.writer_check([g,e],{'clients':[]},['G'])
        with self.assertRaises(r.GateError):r.writer_check([g],{'clients':['10.0.0.9']},['G'])
    def test_capacity_no_waiver(self):
        cap={'baselineUsed':70*r.GIB,'baselineAvailable':14*r.GIB,'peak':0,'phase':'test'}
        with self.assertRaises(r.GateError):r.b1_capacity_gate(cap,70*r.GIB,14*r.GIB,5*r.GIB)


class LifecycleTests(unittest.TestCase):
    def setUp(self):configure()
    def test_old_standby_is_promoted_before_recovery_completes(self):
        c={'Id':r.STORE_LIVE_ID,'Image':r.STORE_IMAGE_ID,'State':{'Running':True,'StartedAt':'now'},'Config':{'Labels':{r.REVISION:r.STORE_BASE},'Env':['GIT_SHA='+r.STORE_BASE],'Image':'old'}}
        class Remote:
            def inspect(self,*args):return c
        events=[]
        with patch.object(r,'bg_lifecycle',side_effect=lambda *a:events.append(a[-1])),patch.object(r,'bg_promote',side_effect=lambda *a:events.append('promote')):
            r.bg_recover_g(Remote(),{'live':LIVE},c)
        self.assertEqual(events,['standby','promote','active'])
    def test_lifecycle_requires_counts_markers_and_mutation_denial(self):
        art={'release':'a'*40};state={'candidate':'E','candidateId':'e'*64}
        health={'ok':True,'dbOk':True,'gitSha':'a'*40,'runtimeMode':'standby','appStartupTasksStarted':0,'processBackgroundTasksStarted':0}
        class Remote:
            def run(self,args,**kw):
                if 'wget' in args:return json.dumps(health).encode()
                if args[:2]==['sh','-c']:return ('BUDU_RUNTIME_STANDBY_READY sha='+'a'*40).encode()
                if 'node' in args:return b'BG_MUTATION_BLOCKED\n'
                raise AssertionError(args)
        with patch.object(r,'bg_candidate_identity',return_value={'Id':'e'*64,'State':{'Running':True}}):
            r.bg_lifecycle(Remote(),{'art':art},state,'standby')
            health['appStartupTasksStarted']=1
            with self.assertRaises(r.GateError):r.bg_lifecycle(Remote(),{'art':art},state,'standby')
    def test_full_image_clone_drops_only_old_thin_labels(self):
        g={'Id':r.STORE_LIVE_ID,'Image':r.STORE_IMAGE_ID,'Config':{'Labels':copy.deepcopy(LIVE['containerLabels'])}}
        art={'release':'a'*40,'capacityProfile':r.STORE_PROFILE}
        result=r.thin_clone_source(g,art)
        self.assertEqual(result['Config']['Labels'],{r.REVISION:r.STORE_BASE,'budu.production-role':'candidate'})
        self.assertEqual(g['Config']['Labels'],LIVE['containerLabels'])
        g['Image']='sha256:'+'f'*64
        with self.assertRaises(r.GateError):r.thin_clone_source(g,art)
    def attempt(self,fault=None):
        configure();events=[];run={'G':True,'E':False};active={'G':True,'E':False};route=['G']
        live=dict(LIVE,LIVE_G_CONTAINER='G');g={'Id':r.STORE_LIVE_ID,'Image':r.STORE_IMAGE_ID,'State':{'Running':True}}
        art={'release':'a'*40,'capacityProfile':r.STORE_PROFILE,'config':{},'runtimeHash':r.STORE_RUNTIME_HASH,'imageReference':'exact','archive':10,'blobs':20,'expanded':30,'largest':10}
        v={'art':art,'live':live,'ledger':LEDGER,'template':' '.join(['proxy_pass http://G:3000;']*3),'active':' '.join(['proxy_pass http://G:3000;']*3),'migrationSql':None,'compatibilityProof':None}
        def event(name):
            events.append(name)
            if name==fault:raise r.GateError('INJECTED')
        class Remote:
            def inspect(self,name,image=False):
                if image:return {'Id':g['Image']}
                return dict(g,State={'Running':run['G']})
            def run(self,args,**kw):
                if args[:2]==['docker','stop']:event('stopG');run['G']=False;active['G']=False
                elif args[:2]==['docker','start']:event('restartG');run['G']=True;active['G']=False
                elif 'BG_PROCUREMENT_SCHEMA_OK' in str(args):return b'BG_PROCUREMENT_SCHEMA_OK\n'
                elif args[:1]==['cat']:return (art['release']+'\n').encode()
                return b''
            def py(self,*a,**kw):return b''
            def health(self,*a,**kw):pass
            def routes(self):return (' '.join(['proxy_pass http://'+route[0]+':3000;']*3),)*2
            def db(self):return {'applied':88}
        def guard(*a):event('guard');return g,{'pgVersion':'16.14'}
        def clone(remote,value,state):event('createE');run['E']=True;state.update(candidate='E',candidateId='e'*64,candidateAttempted=True)
        def lifecycle(remote,value,state,mode):event(mode);self.assertEqual(active['E'],mode=='active')
        def writer(remote,value,state,names,standby=False):
            event('zero' if not names else 'writer');self.assertEqual(sorted(names),sorted(k for k in run if run[k] and active[k]));return {}
        def promote(*a):event('promote');self.assertFalse(run['G']);active['E']=True
        def recover(*a):event('recoverActive');self.assertFalse(run['E']);active['G']=True
        def stop(*a):event('stopE');run['E']=active['E']=False
        def routes(remote,t,a):
            name='E' if 'http://E:' in t else 'G';event('route'+name)
            self.assertTrue(active[name]);route[0]=name
        def script(remote,code,*a,**kw):
            if code==r.BG_PROBE_CODE:return {'result':'PASS','terminated':True}
            if code==r.BG_EVIDENCE_CODE:event('evidence');return {'result':'PASS'}
            self.fail('Unexpected migration/seed/backup helper')
        patches={'bg_g_guard':guard,'validate_clone_source':lambda *a:None,'b1_storage':lambda *a:None,'bg_lock':lambda *a:{},'bg_capacity':lambda *a:None,'resolve_loaded_image':lambda *a:{'Id':'sha256:'+'e'*64},'bg_e_barrier':lambda *a:None,'bg_script':script,'bg_clone':clone,'bg_lifecycle':lifecycle,'mount_readability':lambda *a:[],'runtime_checks':lambda *a:None,'application_db_probe':lambda *a:None,'bg_writer':writer,'bg_promote':promote,'bg_recover_g':recover,'replace_routes':routes,'write_authority':lambda *a:None,'bg_owned_stop':stop}
        with contextlib.ExitStack() as stack:
            for name,fn in patches.items():stack.enter_context(patch.object(r,name,side_effect=fn))
            result=r.bg_execute(Remote(),v,lambda root:{})
        return result,events,run,active,route
    def test_zero_writer_before_promotion(self):
        result,e,run,active,route=self.attempt();self.assertEqual(result['result'],'DEPLOY_COMPLETE',result)
        self.assertLess(e.index('standby'),e.index('stopG'));self.assertLess(e.index('stopG'),e.index('zero'));self.assertLess(e.index('zero'),e.index('promote'));self.assertEqual(route,['E'])
    def test_failures_restore_actual_active_G(self):
        for fault in ['standby','promote','routeE','evidence']:
            with self.subTest(fault=fault):
                result,e,run,active,route=self.attempt(fault);self.assertEqual(result['code'],'INJECTED',result);self.assertNotIn('secondaryRecoveryCode',result)
                self.assertTrue(run['G'] and active['G']);self.assertFalse(run['E']);self.assertEqual(route,['G'])
                if 'restartG' in e:self.assertLess(e.index('stopE'),e.index('restartG'));self.assertLess(e.index('recoverActive'),e.index('routeG'))


if __name__ == '__main__':unittest.main(verbosity=2)

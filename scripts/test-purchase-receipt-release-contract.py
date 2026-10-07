#!/usr/bin/env python3
"""Offline procurement release admission and closed rollback safety contracts."""
import ast
import copy
import contextlib
import importlib.util
import io
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest
import os
import tempfile
import types
from unittest.mock import patch
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('procurement_release',ROOT/'scripts/deploy-prod-transfer-cas.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
C=r.procurement_contract()
LEDGER={p.parent.name:r.digest(p.read_bytes()) for p in (ROOT/'prisma/migrations').glob('*/migration.sql')}

class AdmissionTests(unittest.TestCase):
    def setUp(self):r.configure_profile('post-transfer',C['oldSha'],C['businessSha'],'0'*64)
    def db(self,count):
        ledger=r.before_ledger(LEDGER) if count==87 else dict(LEDGER)
        return {'database':r.EXPECTED_DB,'applied':count,'failed':0,'rolledBack':0,'ledger':ledger,
                'procurementSchema':{'tables':[],'inventoryColumns':[]} if count==87 else {'schemaMd5':C['schemaMd5']} }
    def identity_git(self,repo,*args):
        if args==('branch','--show-current'):return C['branch']
        if args[:1]==('rev-list',):return 'a'*40+' '+C['businessSha']
        if args[:1]==('diff',):
            if args[2]==C['businessSha']:return '\n'.join(sorted(C['engineeringFiles']))
            if args[3]==C['rollbackSha']:return ''
            return 'prisma/schema.prisma\nprisma/migrations/'+C['migration']+'/migration.sql'
        raise AssertionError(args)
    def test_reviewed_identity(self):
        with patch.object(r,'git',side_effect=self.identity_git),patch.object(r,'is_ancestor',return_value=True):
            r.validate_procurement_identity(ROOT,'a'*40)
    def test_wrong_branch_parent_scope_and_compatible_schema_rejected(self):
        failures=[(('branch','--show-current'),'wrong','PROCUREMENT_RELEASE_IDENTITY_INVALID'),
                  (('rev-list','--parents','-n','1','a'*40),'a'*40+' '+'b'*40,'PROCUREMENT_RELEASE_IDENTITY_INVALID'),
                  (('diff','--name-only',C['businessSha'],'a'*40),'server/app.js','PROCUREMENT_ENGINEERING_SCOPE_INVALID'),
                  (('diff','--name-only',C['oldSha'],C['rollbackSha'],'--','prisma'),'prisma/schema.prisma','PROCUREMENT_COMPATIBILITY_IDENTITY_INVALID')]
        for key,value,code in failures:
            with self.subTest(code=code),patch.object(r,'git',side_effect=lambda repo,*args: value if args==key else self.identity_git(repo,*args)),patch.object(r,'is_ancestor',return_value=True):
                with self.assertRaisesRegex(r.GateError,code):r.validate_procurement_identity(ROOT,'a'*40)
    def test_exact_sql_identity(self):
        with patch.object(r,'git',side_effect=self.identity_git),patch.object(r,'is_ancestor',return_value=True),patch.object(r,'digest',return_value='wrong'):
            with self.assertRaisesRegex(r.GateError,'PROCUREMENT_MIGRATION_IDENTITY_INVALID'):r.validate_procurement_identity(ROOT,'a'*40)
    def test_full_ledger_and_schema_87_88(self):
        self.assertEqual(len(LEDGER),88)
        for count in (87,88):
            db=self.db(count);r.validate_database(db,db['ledger'])
            self.assertEqual(r.procurement_existing_ledger(db,LEDGER),db['ledger'])
    def test_ledger_checksum_failure_rollback_and_schema_drift_rejected(self):
        for key,value in [('failed',1),('rolledBack',1),('applied',89),('database','other')]:
            db=self.db(88);db[key]=value
            with self.subTest(key=key),self.assertRaisesRegex(r.GateError,'MIGRATION_LEDGER_INVALID'):r.validate_database(db,LEDGER)
        db=self.db(88);db['ledger'][C['migration']]='wrong'
        with self.assertRaisesRegex(r.GateError,'MIGRATION_LEDGER_INVALID'):r.validate_database(db,LEDGER)
        for count,schema in [(87,{'tables':['ProcurementAudit'],'inventoryColumns':[]}),(88,{'schemaMd5':'wrong'})]:
            db=self.db(count);db['procurementSchema']=schema
            with self.subTest(count=count),self.assertRaisesRegex(r.GateError,'PROCUREMENT_SCHEMA_INVALID'):r.validate_database(db,db['ledger'])
    def test_compatibility_resume_is_only_reviewed_sha(self):
        r.configure_profile('post-transfer',C['rollbackSha'],C['businessSha'],'0'*64);self.assertTrue(r.procurement_migration())
        r.configure_profile('post-transfer','b'*40,C['businessSha'],'0'*64);self.assertFalse(r.procurement_migration())
    def test_no_other_migration_relaxation(self):
        r.configure_profile('post-transfer',r.SHIPPING_OLD_SHA,r.SHIPPING_BUSINESS_SHA,'0'*64)
        self.assertTrue(r.shipping_migration());self.assertFalse(r.procurement_migration())
        shipping={str(i):'0'*64 for i in range(85)};shipping[r.SHIPPING_MIGRATION]=r.SHIPPING_SQL_HASH
        self.assertEqual(len(r.before_ledger(shipping)),85)
        r.configure_profile('post-transfer',r.material_contract()['oldSha'],r.material_contract()['businessSha'],'0'*64)
        self.assertTrue(r.material_migration());self.assertFalse(r.procurement_migration())
        self.assertEqual(len(r.before_ledger({k:v for k,v in LEDGER.items() if k!=C['migration']})),86)
    def test_thresholds_and_full_model_a(self):
        self.assertEqual((r.MAX_ARCHIVE,r.ABSOLUTE_MAX_PEAK,r.MIN_PROJECTED_AVAILABLE,r.RESERVE,r.MAX_PROJECTED_USAGE),(768*1024**2,6*r.GIB,10*r.GIB,512*1024**2,90))
        result=r.disk_budget(10*r.GIB,20*r.GIB,100,200,300,400)
        self.assertEqual(result['peakIncrement'],1000+r.RESERVE)
        with self.assertRaisesRegex(r.GateError,'DYNAMIC_HEADROOM'):r.disk_budget(50*r.GIB,10*r.GIB,100,200,300,400)
    def test_hash_queries_cannot_expand_to_unrelated_tables(self):
        with self.assertRaisesRegex(r.GateError,'PROCUREMENT_FACT_SCOPE_INVALID'):r.procurement_facts(None,['User'])
        self.assertNotIn('INSERT',r.PROCUREMENT_SCHEMA_SQL);self.assertNotIn('UPDATE',r.PROCUREMENT_SCHEMA_SQL)

class Recorder:
    def __init__(self):self.events=[]
    def containers(self):return [{'Name':'/C2'}]
    def run(self,args,**kwargs):self.events.append(('run',args));return b''
    def py(self,code,value=None,**kwargs):self.events.append(('py',code));return ''
    def health(self,name,sha,public=False):self.events.append(('health',name,sha,public))

class RollbackTests(unittest.TestCase):
    def setUp(self):
        r.configure_profile('post-transfer',C['oldSha'],C['businessSha'],'0'*64);self.remote=Recorder()
        self.state={'name':'G','candidate':'C2','candidate_attempted':True,'old_stop_attempted':True,
                    'migration_phase':'L88','template':' '.join(['http://G:3000']*3),
                    'compatibility_name':'R3','compatibility':{'release':C['rollbackSha']},'helper':'helper'}
    def guards(self,facts=None):
        remote=self.remote
        stack=contextlib.ExitStack()
        stack.enter_context(patch.object(r,'settle_writers',side_effect=lambda remote,ledger,names:remote.events.append(('writers',len(ledger),names))))
        stack.enter_context(patch.object(r,'clone_compatible_app',side_effect=lambda remote,*args:remote.events.append(('clone','R3'))))
        stack.enter_context(patch.object(r,'procurement_facts',side_effect=facts if facts is not None else lambda remote,*args:remote.events.append(('facts',)) or ['preserved']))
        stack.enter_context(patch.object(r,'replace_routes',side_effect=lambda remote,t,a:remote.events.append(('routes',t,a))))
        stack.enter_context(patch.object(r,'write_authority',side_effect=lambda remote,p,t:remote.events.append(('pointer',t))))
        return stack
    def test_both_known_phases_always_compatible_writer_after_zero_drain(self):
        for phase,count in [('L87',87),('L88',88)]:
            self.remote.events=[];self.state['migration_phase']=phase
            with self.guards():r.rollback(self.remote,self.state,LEDGER)
            events=self.remote.events
            self.assertEqual(events[:3],[('run',['docker','stop','--time','30','C2']),('writers',count,[]),('facts',)])
            self.assertLess(events.index(('writers',count,[])),events.index(('clone','R3')))
            self.assertEqual([e for e in events if e[0]=='run'],[('run',['docker','stop','--time','30','C2'])])
            self.assertEqual([e for e in events if e[0]=='pointer'],[('pointer',C['rollbackSha']+'\n')])
            self.assertTrue(all(e[1].count('http://R3:3000')==3 for e in events if e[0]=='routes'))
            self.assertEqual(events[-1],('writers',count,['R3']))
    def test_candidate_stop_failure_never_clones_or_changes_routes(self):
        with self.guards(),patch.object(self.remote,'run',side_effect=r.GateError('COMMAND_FAILED')):
            with self.assertRaisesRegex(r.GateError,'COMMAND_FAILED'):r.rollback(self.remote,self.state,LEDGER)
        self.assertEqual(self.remote.events,[])
    def test_retained_facts_change_prevents_route_and_pointer(self):
        with self.guards(facts=[['before'],['changed']]):
            with self.assertRaisesRegex(r.GateError,'PROCUREMENT_RETAINED_FACTS_CHANGED'):r.rollback(self.remote,self.state,LEDGER)
        self.assertFalse(any(e[0] in ('routes','pointer') for e in self.remote.events))
    def test_unknown_phase_and_unterminated_backup_remain_closed(self):
        for changes,code in [({'migration_phase':'UNKNOWN'},'SHIPPING_MIGRATION_STATE_UNKNOWN'),({'backup_attempted':True},'SHIPPING_BACKUP_TERMINATION_UNVERIFIED')]:
            state={**self.state,**changes}
            with self.guards(),self.assertRaisesRegex(r.GateError,code):r.rollback(self.remote,state,LEDGER)
            self.assertEqual(self.remote.events,[])
    def test_cloner_failure_never_restarts_legacy_writer(self):
        with self.guards(),patch.object(r,'clone_compatible_app',side_effect=r.GateError('COMMAND_FAILED')):
            with self.assertRaisesRegex(r.GateError,'COMMAND_FAILED'):r.rollback(self.remote,self.state,LEDGER)
        self.assertFalse(any(e[0]=='run' and e[1][:2]==['docker','start'] for e in self.remote.events))

class SourceIsolationTests(unittest.TestCase):
    def test_shared_transport_backup_clone_and_disk_code_preserved(self):
        before=subprocess.check_output(['git','-C',str(ROOT),'show',C['businessSha']+':scripts/deploy-prod-transfer-cas.py'],text=True)
        after=(ROOT/'scripts/deploy-prod-transfer-cas.py').read_text()
        def sections(source):
            return {n.name:ast.get_source_segment(source,n) for n in ast.parse(source).body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
        left=sections(before);right=sections(after)
        dispatch="    if vars(remote).get('b1_capacity') is not None:\n        return b1_db_gate(remote, resources)\n"
        self.assertEqual(right['shipping_disk_gate'].count(dispatch),1)
        right['shipping_disk_gate']=right['shipping_disk_gate'].replace(dispatch,'',1)
        staging="    code=STAGING_CODE\n    if art.get('capacityProfile') == 'B1':\n        require(action in ('prepare','verify'), 'B1_ARCHIVE_UNVERIFIED')\n        # Invalid uploads are evidence, never cleanup candidates. Only the B1\n        # exact-ownership helper may end this release's archive lifecycle.\n        code=code.replace('current.unlink(); meta.unlink()', 'pass # B1 retain invalid upload')\n"
        self.assertEqual(right['staging_action'].count(staging),1)
        right['staging_action']=right['staging_action'].replace(staging,'',1).replace('remote.py(code,','remote.py(STAGING_CODE,',1)
        for name in ('stage_artifact','staging_action','shipping_disk_gate','shipping_resources',
                     'clone_parity','validate_clone_source','application_db_probe','writer_check','disk_budget',
                     'validate_loaded_image','resolve_loaded_image','replace_routes','write_authority','check_controller_result'):
            self.assertEqual(left[name],right[name],name)
        # Backup helper logic is unchanged; migrator retains only the existing
        # finite ledger/fact adaptations plus the attempt name argument.
        self.assertEqual(left['shipping_backup_restore'],right['shipping_backup_restore'].replace(
            "migration_attempt_container(state,'restore',art['release'])","'budu-shipping-restore-'+art['release'][:12]"))
        self.assertEqual(left['shipping_migrate'],right['shipping_migrate'].replace(
            "migration_attempt_container(state,'migrator',art['release'])","'budu-shipping-migrator-'+art['release'][:12]").replace(
            "state.get('before_ledger',before_ledger(ledger))","before_ledger(ledger)").replace(
            "    if procurement_migration():\n        require(procurement_facts(remote,('InventoryItem','Supplier','PurchaseRequest','PurchaseItem','StockBalance','StockLedger'))==state['procurement_old_facts'], 'PROCUREMENT_RETAINED_FACTS_CHANGED')\n",''))
    def test_existing_production_workflow_and_business_unchanged(self):
        paths=['.github/workflows/deploy-prod.yml','scripts/deploy-remote.sh','Dockerfile','prisma/schema.prisma','server/purchase-receipt.js']
        for path in paths:
            expected=subprocess.check_output(['git','-C',str(ROOT),'show',C['businessSha']+':'+path])
            self.assertEqual((ROOT/path).read_bytes(),expected,path)
    def test_compatible_import_precedes_candidate_upload_and_refreshes_admission(self):
        source=(ROOT/'scripts/deploy-prod-transfer-cas.py').read_text()
        deploy=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=='deploy')
        body=ast.get_source_segment(source,deploy)
        positions=[body.index(token) for token in ("compatible_path=stage_artifact", "staging_action(remote,compatible,'cleanup')",'preflight(remote,art,ledger)', 'staged = stage_artifact(remote, path, art)','handed_off = True')]
        self.assertEqual(positions,sorted(positions))
        self.assertIn("if not handed_off and (not staging_started or staging_complete) and (not import_started or import_complete)",body)
    def test_isolated_controller_calls_actual_execute_loaded_with_exact_compatible_tar(self):
        source=(ROOT/'scripts/test-candidate-db-probe-integration.py').read_text()
        nodes={n.name:n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef)}
        body=ast.get_source_segment(source,nodes['_procurement_controller_ci'])
        self.assertIn('release.execute_loaded(remote,art,ledger,helper',body)
        self.assertIn('release.compatibility_artifact(ROOT,compatible_archive)',body)
        self.assertIn("writer=candidate if mode=='success' else compatible",body)
        self.assertIn('retained!=remote.retained_before_rollback',body)
        self.assertIn("'--internal'",body)
        self.assertNotIn('OLD_COMPAT_JS',body)
        self.assertNotIn("docker('start',old)",body[body.index('release.execute_loaded'):])
        recovery=next(n for n in ast.walk(nodes['_procurement_controller_ci']) if isinstance(n,ast.If)
                      and ast.get_source_segment(source,n.test)=="not rollback_fault and mode in ('post_cutover_failure','backup_limit','post_restore_failure','post_migrator_create_failure')")
        recovery_body=ast.get_source_segment(source,recovery)
        self.assertEqual(body.count('wait_owned_procurement_rollback_healthy('),1)
        self.assertLess(recovery_body.index('wait_owned_procurement_rollback_healthy('),recovery_body.index('release.deploy('))
        self.assertIn("remote,compatible,old_r_id,art['compatibility']['loadedDockerImageId'],sha,mode",recovery_body)
        self.assertIn("'sourceRReadiness':readiness",recovery_body)

class ControllerFailureTests(unittest.TestCase):
    setUp=RollbackTests.setUp
    guards=RollbackTests.guards
    def execute_failure(self,unknown=False):
        state={**self.state,'old':{'Id':'old-id','Image':'old-image'},'active':self.state['template'],
               'migration_phase':'L87','before_ledger':r.before_ledger(LEDGER),'migrationResources':{},
               'candidate_attempted':False,'old_stop_attempted':False}
        art={'release':'a'*40,'compatibility':{'release':C['rollbackSha']},'imageReference':'fixture',
             'loadedDockerImageId':'image-id','archiveConfigDigest':'digest'}
        def backup(remote,state,*args):
            state['backup_attempted']=True;state['backup_termination_verified']=True
            if not unknown:raise r.GateError('SHIPPING_BACKUP_RESTORE_UNVERIFIED')
            return {}
        def migrate(remote,state,*args):
            state.update(migration_phase='UNKNOWN',migrator='migrator')
            raise r.GateError('COMMAND_FAILED')
        with self.guards(),patch.object(r,'preflight',return_value=state),patch.object(r,'resolve_loaded_image'),\
                patch.object(r,'mount_readability',return_value={}),patch.object(r,'signal') as signals,\
                patch.object(r,'shipping_backup_restore',side_effect=backup),patch.object(r,'shipping_migrate',side_effect=migrate),\
                patch.object(self.remote,'routes',create=True,return_value=(state['template'],state['active'])),\
                patch.object(self.remote,'inspect',create=True,return_value={'State':{'Running':False}}):
            signals.SIGHUP=1;signals.SIGTERM=15;signals.SIGINT=2
            with self.assertRaises(r.GateError) as caught:
                r.execute_loaded(self.remote,art,LEDGER,'helper','old-id',r.digest(state['template'].encode()))
        return caught.exception
    def test_known_backup_failure_recovers_to_compatible_and_releases_lock(self):
        error=self.execute_failure()
        self.assertEqual(error.deployment_result,'DEPLOY_ROLLED_BACK')
        self.assertIn(('clone','R3'),self.remote.events)
        self.assertEqual(self.remote.events[-1],('py','import os; os.rmdir(%r)' % r.LOCK))
        self.assertFalse(any(e[0]=='run' and e[1][:2]==['docker','start'] for e in self.remote.events))
    def test_unknown_migration_keeps_lock_and_never_starts_any_app(self):
        error=self.execute_failure(unknown=True)
        self.assertEqual(str(error),'ROLLBACK_UNVERIFIED_MANUAL_ATTENTION_REQUIRED')
        self.assertEqual(error.deployment_result,'DEPLOY_BLOCKED')
        self.assertFalse(any(e[0]=='clone' or (e[0]=='run' and e[1][:2]==['docker','start']) for e in self.remote.events))
        self.assertFalse(any(e[0]=='py' and 'os.rmdir' in e[1] for e in self.remote.events))

# Infrastructure model only. The tested calls are the production deploy,
# execute_loaded, rollback, clone_compatible_app, and writer/identity gates.
_SHARED_SPEC=importlib.util.spec_from_file_location('shared_fixture',ROOT/'scripts/test-deploy-prod-transfer-cas.py')
_SHARED=importlib.util.module_from_spec(_SHARED_SPEC);_SHARED_SPEC.loader.exec_module(_SHARED)
_CI_SPEC=importlib.util.spec_from_file_location('procurement_ci_fixture',ROOT/'scripts/test-candidate-db-probe-integration.py')
_CI=importlib.util.module_from_spec(_CI_SPEC);_CI_SPEC.loader.exec_module(_CI)

def empty_procurement_facts():
    return [{'name':name,'count':0,'hash':hashlib.md5(b'').hexdigest()} for name in sorted(r.PROCUREMENT_TABLES)]

class ProcurementModel:
    def __init__(self,phase=87):
        self.events=[];self.objects={};self.phase=phase;self.pointer=C['oldSha'];self.lock=True;self.roots=set();self.fail=None;self.stop_fail=False;self.evidence=None;self.facts_calls=0;self.cleanup_started=False;self.candidate_public_failure=False
        self.new_facts=[{'name':name,'count':1,'hash':hashlib.md5(name.encode()).hexdigest()} for name in sorted(r.PROCUREMENT_TABLES)]
        self.old_facts=[{'name':name,'count':1,'hash':hashlib.md5(name.encode()).hexdigest()} for name in ('InventoryItem','Supplier','PurchaseRequest','PurchaseItem','StockBalance','StockLedger')]
        self.helper_resources=[];self.fail_after_restore=False;self.fail_after_migrator_create=False
        self.sha='a'*40;self.ename='budu-prod-'+self.sha[:12]+r.CONTAINER_SUFFIX
        self.rname='budu-prod-'+C['rollbackSha'][:12]+'-purchase-compat-'+self.sha[:12]
        self.old=copy.deepcopy(_SHARED.original());self.old.update(Name='/G',Id='g-id',Image='sha256:'+'1'*64)
        self.old['Config']['Env']=[('GIT_SHA='+C['oldSha']) if x.startswith('GIT_SHA=') else x for x in self.old['Config']['Env']]
        self.old['Config']['Labels'][r.REVISION]=C['oldSha'];self.old['Config']['Image']=r.image_reference(C['oldSha']);self.old['State'].update(Status='running',Restarting=False)

        for i,endpoint in enumerate(self.old['NetworkSettings']['Networks'].values()):endpoint['NetworkID']=str(i+1)*64
        self.objects['G']=self.old;self.template=self.active='\n'.join(['proxy_pass http://G:3000;']*3)
        def art(sha,key):return {'release':sha,'archive':100,'blobs':100,'expanded':100,'largest':100,'archiveHash':'0'*64,'archiveConfigDigest':'sha256:'+'c'*64,'imageReference':r.image_reference(sha),'loadedDockerImageId':'sha256:'+key*64,'rootfsDiffIds':['sha256:'+'d'*64],'layers':[],'config':copy.deepcopy(self.old['Config']),'runtimeHash':'0'*64}
        self.art=art(self.sha,'e');self.art['compatibility']=art(C['rollbackSha'],'f');self.art['compatibilityPath']='/fixture/compatible.tar';self.ssh=['NO_EXTERNAL_TRANSPORT']
    def inspect(self,name,image=False):
        if image:
            for art in (self.art,self.art['compatibility']):
                if name==art['imageReference']:
                    config=copy.deepcopy(art['config']);config['Labels'][r.REVISION]=art['release']
                    return {'Id':art['loadedDockerImageId'],'Config':config,'RepoTags':[name],'RootFS':{'Layers':art['rootfsDiffIds']},'Size':1024,'Os':'linux','Architecture':'amd64'}
            return {'Id':name}
        return copy.deepcopy(next(v for k,v in self.objects.items() if name in (k,v['Id'])))
    def containers(self):return copy.deepcopy([v for v in self.objects.values() if v['State']['Running']])
    def routes(self):return self.template,self.active
    def disk(self):
        if self.fail_after_restore and any(role=='restore' for role,name in self.helper_resources):
            self.fail_after_restore=False;return 20*r.GIB,1024**2
        return 20*r.GIB,60*r.GIB
    def db(self):
        ledger=r.before_ledger(LEDGER) if self.phase==87 else LEDGER
        clients=[v['NetworkSettings']['Networks']['net']['IPAddress'] for v in self.containers()]
        if (self.fail=='writer' and any(v['Name']=='/'+self.rname for v in self.containers())) or (self.fail=='final-writer' and self.pointer==C['rollbackSha'] and any(v['Name']=='/'+self.rname for v in self.containers())) or (self.fail=='zero' and self.cleanup_started):clients=['203.0.113.253']
        return {'database':r.EXPECTED_DB,'applied':self.phase,'failed':0,'rolledBack':0,'ledger':ledger,'clients':clients,
                'pgVersion':'16.14','dbBytes':1024,'procurementSchema':{'tables':[],'inventoryColumns':[]} if self.phase==87 else {'schemaMd5':C['schemaMd5']}}
    def health(self,name,sha,public=False):
        if name==self.ename and public and self.candidate_public_failure:
            self.candidate_public_failure=False;raise r.GateError('HEALTH_FAILED')
        if name==self.rname and (self.fail==('public' if public else 'health') or self.fail=='zero'):raise r.GateError('HEALTH_FAILED')
    def run(self,args,data=None,timeout=60):
        self.events.append(tuple(args))
        if args[:3]==['docker','ps','-aq']:
            name=args[-1].removeprefix('name=^/').removesuffix('$');return self.objects[name]['Id'].encode() if name in self.objects else b''
        if args[:3]==['docker','images','-q']:return self.inspect(args[-1],True)['Id'].encode()
        if args[:3]==['docker','network','inspect']:
            networks=self.old['NetworkSettings']['Networks'];return json.dumps([{'Name':name,'Id':networks[name]['NetworkID']} for name in args[3:]]).encode()
        if args[:2] in (['docker','start'],['docker','stop']):
            current=next(v for k,v in self.objects.items() if args[-1] in (k,v['Id']))
            if args[1]=='stop' and current['Name']=='/'+self.rname and self.stop_fail:raise r.GateError('COMMAND_FAILED')
            if args[1]=='stop' and current['Name']=='/'+self.rname:self.cleanup_started=True
            current['State'].update(Running=args[1]=='start',Status='running' if args[1]=='start' else 'exited')
            if args[1]=='start' and current['Config']['Labels'].get('budu.production-role')=='migrator':
                self.phase=88;self.new_facts=empty_procurement_facts();current['State'].update(Running=False,Status='exited',ExitCode=0)
            self.assert_single_writer();return b''
        if args==['cat',r.CURRENT_SHA_FILE]:return self.pointer.encode()
        if args[-2:]==['sha256sum','/app/server/v2.js']:
            return (('1'*64 if args[2]==self.rname and self.fail=='runtime' else '0'*64)+'  source').encode()
        if 'mount-readability' in args:return b'READABLE'
        if '--input-type=module' in args:
            if self.rname in args and self.fail=='prisma':return b'WRONG\n'
            return r.APPLICATION_DB_PROBE_OK
        if args[:3]==['docker','run','--rm']:return b'PINNED_PRISMA_CLI_OK\n'
        if args[:2]==['docker','info']:return json.dumps({'ServerVersion':'29.1.3','Driver':'overlayfs','DockerRootDir':'/var/lib/docker','DriverStatus':[['driver-type','io.containerd.snapshotter.v1']]}).encode()
        if args[:4]==['docker','exec','-i',r.NGINX]:self.active=data.decode()
        return b''
    def assert_single_writer(self):assert len(self.containers())<=1,'MULTIPLE_MODEL_WRITERS'
    def py(self,code,value=None,timeout=60):
        if 'run_loaded_controller(v)' in code:
            try:
                with contextlib.redirect_stdout(io.StringIO()) as out:r.execute_loaded(self,value['art'],value['ledger'],value['helper'],value['oldId'],value['routeHash'])
                return out.getvalue()
            except r.GateError as error:return json.dumps({'result':error.deployment_result,'failureGate':error.failure_stage,'code':str(error)})
        if code==r.SHIPPING_BACKUP_RESTORE_CODE:
            name=value['restore']
            if name in self.objects:raise AssertionError('RESTORE_NAME_EXISTS')
            self.helper_resources.append(('restore',name))
            self.objects[name]={'Id':name+'-id','Name':'/'+name,'State':{'Running':False,'Status':'exited'},'Config':{'Labels':{'budu.shipping-restore':self.sha}}}
            return json.dumps({'backupBytes':1024,'restoreAllocatedBytes':1024,'restoreVerified':True,'pgVersion':'16.14',
                               'terminationVerified':True,'releaseSha':self.sha,'tableCount':118,'restoreContainer':name})
        if code==r.SHIPPING_MIGRATOR_CREATE_CODE:
            name=value['name']
            if name in self.objects:raise AssertionError('MIGRATOR_NAME_EXISTS')
            self.helper_resources.append(('migrator',name))
            current=copy.deepcopy(self.objects[value['old']]);current.update(Id=name+'-id',Name='/'+name,Image=self.art['loadedDockerImageId'])
            current['State'].update(Running=False,Status='created',ExitCode=0)
            current['Config'].update(Image=self.art['imageReference'],Labels={'budu.production-role':'migrator',r.REVISION:self.sha},
                Env=[key+'='+val for key,val in {**r.env({'Config':self.art['config']}),'DATABASE_URL':r.env(current)['DATABASE_URL'],
                     'PGOPTIONS':'-c application_name=budu_shipping_migrator'}.items()],Entrypoint=['node'],
                Cmd=['/app/node_modules/prisma/build/index.js','migrate','deploy','--schema','/app/prisma/schema.prisma'])
            current['HostConfig'].update(ReadonlyRootfs=True,RestartPolicy={'Name':'no','MaximumRetryCount':0},
                Tmpfs={'/tmp':'rw,nosuid,size=128m'},LogConfig={'Type':'json-file','Config':{'max-size':'1m','max-file':'1'}})
            current['Mounts']=[{'Type':'tmpfs','Destination':'/tmp'}];self.objects[name]=current
            if self.fail_after_migrator_create:
                self.fail_after_migrator_create=False;raise r.GateError('COMMAND_FAILED')
            return b''
        if 'os.stat(p).st_dev' in code:return b'true'
        if value and 'helper' in value and 'candidate' in value:
            name=value['candidate'];source=self.objects[value['old']];current=copy.deepcopy(source)
            art=self.art['compatibility'] if value['sha']==C['rollbackSha'] else self.art
            current.update(Id=name+'-id',Name='/'+name,Image=art['loadedDockerImageId']);current['Config']['Image']=art['imageReference'];current['Config']['Labels'][r.REVISION]=value['sha']
            current['Config']['Env']=[('GIT_SHA='+value['sha']) if x.startswith('GIT_SHA=') else x for x in current['Config']['Env']]
            current['State'].update(Running=True,Status='running');self.objects[name]=current;self.assert_single_writer()
            if name==self.rname and self.fail=='identity':current['Config']['Labels'][r.REVISION]='b'*40
            if name==self.rname and self.fail=='helper':raise r.GateError('COMMAND_FAILED')
        if value and 'manifest' in value:
            assert value['root'] not in self.roots,'ROOT_COLLISION';self.roots.add(value['root'])
        if value and value.get('path')==r.TEMPLATE:
            self.template=value['text']
            if self.rname in self.template and self.fail=='routes':raise r.GateError('COMMAND_FAILED')
        if value and value.get('path')==r.CURRENT_SHA_FILE:
            self.pointer=value['text'].strip()
            if self.pointer==C['rollbackSha'] and self.fail=='pointer':raise r.GateError('COMMAND_FAILED')
        if value and 'evidence' in value:self.evidence=copy.deepcopy(value['evidence'])
        if 'os.rmdir' in code:self.lock=False
        return b''
    def facts(self,remote,*args):
        self.facts_calls+=1
        if args:return copy.deepcopy(self.old_facts)
        return ['changed'] if self.fail=='facts' and self.facts_calls%2==0 else copy.deepcopy(self.new_facts) if self.phase==88 else []

class FormalProcurementRecoveryTests(unittest.TestCase):
    def setUp(self):r.configure_profile('post-transfer',C['oldSha'],C['businessSha'],'0'*64)
    def failure(self,model):
        def backup(remote,state,*args):
            state['backup_attempted']=True;state['backup_termination_verified']=True
            raise r.GateError('SHIPPING_BACKUP_RESTORE_UNVERIFIED')
        with patch.object(r,'procurement_facts',side_effect=model.facts),patch.object(r,'shipping_backup_restore',side_effect=backup),patch.object(r.time,'sleep'),patch.object(r,'signal') as signal:
            signal.SIGHUP=1;signal.SIGINT=2;signal.SIGTERM=15
            with self.assertRaises(r.GateError) as caught:r.execute_loaded(model,model.art,LEDGER,'helper','g-id',r.digest(model.template.encode()))
        return caught.exception
    def test_full_controller_chain_stops_r_after_every_unverified_stage(self):
        for fault in ('helper','health','runtime','prisma','writer','facts','routes','pointer','public','final-writer'):
            with self.subTest(fault=fault):
                model=ProcurementModel();model.fail=fault;error=self.failure(model)
                self.assertEqual(error.deployment_result,'DEPLOY_BLOCKED');self.assertTrue(model.lock)
                self.assertEqual(r.writer_names(model.containers()),[])
                self.assertEqual(model.evidence['zeroWriterVerification'],'VERIFIED_ZERO_WRITERS')
                self.assertTrue(model.evidence['stopAttempted']);self.assertEqual(model.evidence['stopResult'],'STOPPED')
                self.assertNotIn(('docker','start','G'),model.events)
                if fault=='routes':self.assertEqual(model.evidence['routeTarget'],'UNVERIFIED_OR_PARTIAL')
                if fault=='pointer':self.assertEqual(model.evidence['currentSha'],C['rollbackSha'])
    def test_stop_failure_explicitly_reports_writer_unverified(self):
        model=ProcurementModel();model.fail='health';model.stop_fail=True;error=self.failure(model)
        self.assertEqual(str(error),'PROCUREMENT_ROLLBACK_WRITER_STOP_UNVERIFIED');self.assertTrue(model.lock)
        self.assertEqual(r.writer_names(model.containers()),[model.rname])
        self.assertEqual(model.evidence['zeroWriterVerification'],'UNVERIFIED');self.assertEqual(model.evidence['stopResult'],'UNVERIFIED')
    def test_unknown_r_identity_or_zero_writer_failure_is_never_claimed_closed(self):
        for fault in ('identity','zero'):
            with self.subTest(fault=fault):
                model=ProcurementModel();model.fail=fault;error=self.failure(model)
                self.assertEqual(str(error),'PROCUREMENT_ROLLBACK_WRITER_STOP_UNVERIFIED');self.assertTrue(model.lock)
                self.assertEqual(model.evidence['zeroWriterVerification'],'UNVERIFIED')
                if fault=='identity':
                    self.assertEqual(r.writer_names(model.containers()),[model.rname])
                    self.assertFalse(model.evidence['stopAttempted'])

    def test_formal_deploy_recovers_same_exact_e_with_existing_tag_container_root_and_r(self):
        for phase in (87,88):
            with self.subTest(phase=phase):
                r.configure_profile('post-transfer',C['oldSha'],C['businessSha'],'0'*64)
                model=ProcurementModel();model.fail=None
                error=self.failure(model);self.assertEqual(error.deployment_result,'DEPLOY_ROLLED_BACK');model.phase=phase
                # Leave a real-shaped stopped exact-E container from a cutover
                # failure, plus its tag, old evidence directory, and existing R.
                current=copy.deepcopy(model.objects[model.rname]);current.update(Name='/'+model.ename,Id='e-existing-id',Image=model.art['loadedDockerImageId']);current['Config']['Image']=model.art['imageReference'];current['Config']['Labels'][r.REVISION]=model.sha
                current['Config']['Env']=[('GIT_SHA='+model.sha) if x.startswith('GIT_SHA=') else x for x in current['Config']['Env']];current['State'].update(Running=False,Status='exited');model.objects[model.ename]=current
                r.configure_profile('post-transfer',C['rollbackSha'],C['businessSha'],'0'*64);model.fail=None
                def migrate(remote,state,*args):model.phase=88;model.new_facts=empty_procurement_facts();state['migration_phase']='L88'
                def backup(remote,state,*args):state.update(backup_attempted=True,backup_termination_verified=True);return {}
                retained=model.facts(model);old_facts=copy.deepcopy(model.old_facts)
                with patch.object(r,'procurement_facts',side_effect=model.facts),patch.object(r,'shipping_backup_restore',side_effect=backup),patch.object(r,'shipping_migrate',side_effect=migrate),patch.object(r,'signal') as signal,contextlib.redirect_stdout(io.StringIO()):
                    signal.SIGHUP=1;signal.SIGINT=2;signal.SIGTERM=15
                    if phase==88:
                        model.candidate_public_failure=True
                        with self.assertRaisesRegex(r.GateError,'HEALTH_FAILED'):
                            r.deploy(model,ROOT,Path('/unused/exactE.tar'),model.art,LEDGER,model.sha)
                        self.assertEqual(r.writer_names(model.containers()),[model.rname])
                        self.assertEqual(model.objects[model.rname]['Id'],model.rname+'-id')
                    r.deploy(model,ROOT,Path('/unused/exactE.tar'),model.art,LEDGER,model.sha)
                verification=_CI.verify_procurement_recovery_facts(phase,retained,model.facts(model),old_facts,model.old_facts,model.db()['procurementSchema'])
                self.assertEqual(verification['fromLedger'],phase)
                self.assertEqual(model.pointer,model.sha);self.assertEqual(r.writer_names(model.containers()),[model.ename]);self.assertFalse(model.lock)
                self.assertEqual(model.objects[model.ename]['Id'],'e-existing-id');self.assertEqual(len(model.roots),3 if phase==88 else 2)
                self.assertIn(('docker','start','e-existing-id'),model.events)
                self.assertNotIn(('docker','start','G'),model.events)
                self.assertFalse(any(event[:2]==('docker','load') or event[:2]==('docker','rm') for event in model.events))
                r.configure_profile('post-transfer',C['oldSha'],C['businessSha'],'0'*64)

    def test_r87_retry_preserves_completed_restore_and_created_migrator_and_uses_unique_names(self):
        for fault in ('post_restore','post_migrator_create'):
            with self.subTest(fault=fault):
                r.configure_profile('post-transfer',C['oldSha'],C['businessSha'],'0'*64)
                model=ProcurementModel();model.fail_after_restore=fault=='post_restore';model.fail_after_migrator_create=fault=='post_migrator_create'
                old_facts=copy.deepcopy(model.old_facts)
                with patch.object(r,'procurement_facts',side_effect=model.facts),patch.object(r.time,'sleep'),patch.object(r,'signal') as signal,contextlib.redirect_stdout(io.StringIO()):
                    signal.SIGHUP=1;signal.SIGINT=2;signal.SIGTERM=15
                    with self.assertRaises(r.GateError) as caught:
                        r.execute_loaded(model,model.art,LEDGER,'helper','g-id',r.digest(model.template.encode()))
                    self.assertEqual(caught.exception.deployment_result,'DEPLOY_ROLLED_BACK');self.assertEqual(model.phase,87)
                    retained=model.facts(model);self.assertEqual(retained,[])
                    previous={name:copy.deepcopy(model.objects[name]) for role,name in model.helper_resources}
                    self.assertEqual(len(previous),1 if fault=='post_restore' else 2)
                    r.configure_profile('post-transfer',C['rollbackSha'],C['businessSha'],'0'*64)
                    r.deploy(model,ROOT,Path('/unused/exactE.tar'),model.art,LEDGER,model.sha)
                self.assertEqual(model.phase,88);self.assertEqual(r.writer_names(model.containers()),[model.ename]);self.assertFalse(model.lock)
                self.assertEqual(model.objects[model.rname]['Id'],model.rname+'-id')
                self.assertTrue(all(model.objects[name]==value for name,value in previous.items()))
                new_names=[name for role,name in model.helper_resources if name not in previous]
                self.assertEqual(len(new_names),2)
                root=next(name for name in model.roots if '-resume-' in name);token=root.split('-resume-')[1]
                self.assertEqual(set(new_names),{'budu-shipping-'+role+'-'+model.sha[:12]+'-resume-'+token for role in ('restore','migrator')})
                verification=_CI.verify_procurement_recovery_facts(87,retained,model.facts(model),old_facts,model.old_facts,model.db()['procurementSchema'])
                self.assertEqual(verification['after'],empty_procurement_facts())
                self.assertFalse(any(event[:2]==('docker','rm') for event in model.events))

    def test_reuse_checks_exact_id_image_environment_resources_mounts_and_networks(self):
        model=ProcurementModel();self.failure(model)
        old=model.inspect(model.rname);current=copy.deepcopy(old)
        current.update(Name='/'+model.ename,Id='e-reuse-id',Image=model.art['loadedDockerImageId'])
        current['Config']['Image']=model.art['imageReference'];current['Config']['Labels'][r.REVISION]=model.sha
        current['Config']['Env']=[('GIT_SHA='+model.sha) if x.startswith('GIT_SHA=') else x for x in current['Config']['Env']]
        current['State'].update(Running=False,Status='exited')
        r.configure_profile('post-transfer',C['rollbackSha'],C['businessSha'],'0'*64)
        mutations=[lambda v:v.update(Image='sha256:'+'9'*64),
                   lambda v:v['Config'].update(Image='unreviewed:tag'),
                   lambda v:v['Config']['Env'].append('UNREVIEWED=1'),
                   lambda v:v['HostConfig'].update(ReadonlyRootfs=True),
                   lambda v:v['Mounts'][0].update(Source='/unreviewed'),
                   lambda v:v['NetworkSettings']['Networks']['net'].update(NetworkID='9'*64),
                   lambda v:v['NetworkSettings']['Networks']['net'].update(Aliases=['unreviewed']),
                   lambda v:v['NetworkSettings']['Networks']['net'].update(IPAMConfig={'IPv4Address':'203.0.113.1'})]
        for index,mutate in enumerate(mutations):
            bad=copy.deepcopy(current);mutate(bad);model.objects[model.ename]=bad
            with self.subTest(mutation=index),self.assertRaises(r.GateError):r.procurement_stopped_candidate(model,{'old':old},model.art)
        model.objects[model.ename]=current
        self.assertEqual(r.procurement_stopped_candidate(model,{'old':old},model.art),'e-reuse-id')

    def test_reuse_refuses_running_or_metadata_changed_e(self):
        model=ProcurementModel(88);current=copy.deepcopy(model.old);current.update(Name='/'+model.ename,Id='unknown',Image=model.art['loadedDockerImageId']);model.objects[model.ename]=current
        r.configure_profile('post-transfer',C['rollbackSha'],C['businessSha'],'0'*64)
        with self.assertRaisesRegex(r.GateError,'PROCUREMENT_REUSE_NOT_STOPPED'):r.procurement_stopped_candidate(model,{'old':model.old},model.art)
        current['State'].update(Running=False,Status='exited');current['Image']='sha256:'+'9'*64
        with self.assertRaises(r.GateError):r.procurement_stopped_candidate(model,{'old':model.old},model.art)

class ReadinessClock:
    def __init__(self):self.now=0;self.sleeps=[]
    def monotonic(self):return self.now
    def sleep(self,seconds):self.sleeps.append(seconds);self.now+=seconds


class ReadinessRemote:
    def __init__(self,model,samples,clock,inspect_delay=0):
        self.model=model;self.samples=samples;self.clock=clock;self.inspect_delay=inspect_delay;self.calls=[]
    def run(self,args,data=None,timeout=60):
        assert args==['docker','inspect',self.model.rname] and data is None
        self.calls.append((args,timeout));self.clock.now+=self.inspect_delay
        sample=self.samples[min(len(self.calls)-1,len(self.samples)-1)]
        if isinstance(sample,Exception):raise sample
        if not isinstance(sample,dict):return sample
        self.model.objects[self.model.rname]=copy.deepcopy(sample)
        return json.dumps([sample]).encode()


class ProcurementRReadinessTests(unittest.TestCase):
    def setUp(self):
        r.configure_profile('post-transfer',C['oldSha'],C['businessSha'],'0'*64)
        _CI.release.configure_profile('post-transfer',C['oldSha'],C['businessSha'],'0'*64)
        self.model=ProcurementModel()
        error=FormalProcurementRecoveryTests.failure(self,self.model)
        self.assertEqual(error.deployment_result,'DEPLOY_ROLLED_BACK')
        self.model.objects[self.model.rname]['Id']='9'*64
        self.model.objects[self.model.rname]['State'].update(Paused=False,Restarting=False)
        self.current=self.model.inspect(self.model.rname);self.clock=ReadinessClock();self.stderr=io.StringIO()
        self.image=self.model.art['compatibility']['loadedDockerImageId']
    def sample(self,health):
        value=copy.deepcopy(self.current);value['State']['Health']={'Status':health,'Log':[{'Output':'FIXTURE_SECRET_HEALTH_LOG'}]}
        value['Config']['Env'].append('FIXTURE_SECRET=FIXTURE_SECRET_ENV')
        return value
    def observe(self,samples,mode='post_cutover_failure',inspect_delay=0,**overrides):
        self.remote=ReadinessRemote(self.model,samples,self.clock,inspect_delay)
        args={'name':self.model.rname,'container_id':'9'*64,'image_id':self.image,'sha':self.model.sha,'mode':mode,**overrides}
        with patch.object(_CI.time,'monotonic',side_effect=self.clock.monotonic),patch.object(_CI.time,'sleep',side_effect=self.clock.sleep),contextlib.redirect_stderr(self.stderr):
            return _CI.wait_owned_procurement_rollback_healthy(self.remote,**args)
    def proof(self):
        lines=self.stderr.getvalue().splitlines();self.assertEqual(len(lines),1)
        value=json.loads(lines[0])['procurementRReadiness']
        for secret in ('FIXTURE_SECRET','postgresql://','9'*64):self.assertNotIn(secret,lines[0])
        return value
    def test_four_entrypoints_wait_for_actual_health_then_unchanged_controller_preflight_passes(self):
        for mode in ('post_cutover_failure','backup_limit','post_restore_failure','post_migrator_create_failure'):
            with self.subTest(mode=mode):
                self.stderr=io.StringIO();self.clock=ReadinessClock()
                model_events=copy.deepcopy(self.model.events)
                proof=self.observe([self.sample('starting'),self.sample('healthy')],mode)
                self.assertEqual(proof['result'],'READY');self.assertEqual(self.proof(),proof)
                self.assertEqual([row['healthStatus'] for row in proof['observations']],['starting','healthy'])
                self.assertTrue(all(all(row['identityMatches'].values()) for row in proof['observations']))
                self.assertEqual(self.model.events,model_events)
                self.assertEqual(len(self.remote.calls),2);self.assertEqual(self.clock.sleeps,[0.5])
                r.configure_profile('post-transfer',C['rollbackSha'],C['businessSha'],'0'*64)
                state=r.preflight(self.model,self.model.art,LEDGER)
                self.assertEqual(state['old']['Id'],'9'*64);self.assertEqual(state['name'],self.model.rname)
    def test_already_healthy_needs_no_sleep(self):
        self.assertEqual(self.observe([self.sample('healthy')])['result'],'READY')
        self.assertEqual(self.clock.sleeps,[]);self.assertEqual(len(self.remote.calls),1);self.proof()
    def test_permanent_starting_times_out_boundedly_without_controller_mutation(self):
        events=copy.deepcopy(self.model.events)
        with self.assertRaisesRegex(RuntimeError,'CI_RECOVERY_R_HEALTH_TIMEOUT'):self.observe([self.sample('starting')])
        proof=self.proof();self.assertEqual(proof['result'],'FAILED');self.assertEqual(self.clock.now,75)
        self.assertLessEqual(len(self.remote.calls),151);self.assertEqual(self.model.events,events)
        self.assertTrue(all(0<timeout<=10 for args,timeout in self.remote.calls))
    def test_unhealthy_missing_and_unknown_health_fail_immediately(self):
        for health in ('unhealthy',None,'FIXTURE_SECRET_STATE'):
            with self.subTest(health=health):
                self.stderr=io.StringIO();sample=self.sample(health)
                if health is None:sample['State'].pop('Health')
                with self.assertRaisesRegex(RuntimeError,'CI_RECOVERY_R_HEALTH_UNVERIFIED'):self.observe([sample])
                self.assertEqual(len(self.remote.calls),1);self.proof()
    def test_exit_pause_restart_or_unknown_state_never_proceeds_even_when_healthy(self):
        for changed in ({'Running':False,'Status':'exited'},{'Paused':True},{'Restarting':True},
                        {'Status':'FIXTURE_SECRET_STATE'},{'Running':1},{'Restarting':None},{'Paused':None}):
            with self.subTest(changed=changed):
                self.stderr=io.StringIO();sample=self.sample('healthy');sample['State'].update(changed)
                with self.assertRaisesRegex(RuntimeError,'CI_RECOVERY_R_NOT_RUNNING'):self.observe([sample])
                self.assertEqual(len(self.remote.calls),1);self.proof()
    def test_any_identity_drift_after_starting_fails_before_formal_controller(self):
        mutations=[lambda v:v.update(Id='8'*64),lambda v:v.update(Name='/other-case'),
                   lambda v:v.update(Image='sha256:'+'8'*64),lambda v:v['Config'].update(Image='other:tag'),
                   lambda v:v['Config']['Labels'].update({r.REVISION:'b'*40}),
                   lambda v:v['Config'].update(Env=['GIT_SHA='+'b'*40])]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.stderr=io.StringIO();self.clock=ReadinessClock();changed=self.sample('healthy');mutate(changed)
                with self.assertRaisesRegex(RuntimeError,'CI_RECOVERY_R_IDENTITY_INVALID'):
                    self.observe([self.sample('starting'),changed])
                proof=self.proof();self.assertEqual(len(proof['observations']),2)
                self.assertFalse(all(proof['observations'][-1]['identityMatches'].values()))
    def test_out_of_scope_case_name_sha_id_and_image_fail_without_inspect(self):
        for values in ({'mode':'success'},{'name':'other-case'},{'sha':'FIXTURE_SECRET_SHA'},
                       {'container_id':'FIXTURE_SECRET_ID'},{'image_id':'FIXTURE_SECRET_IMAGE'}):
            with self.subTest(values=values):
                self.stderr=io.StringIO()
                with self.assertRaisesRegex(RuntimeError,'CI_RECOVERY_R_IDENTITY_INVALID'):self.observe([self.sample('healthy')],**values)
                self.assertEqual(self.remote.calls,[]);self.proof()
    def test_slow_inspect_healthy_after_deadline_is_failure(self):
        with self.assertRaisesRegex(RuntimeError,'CI_RECOVERY_R_HEALTH_TIMEOUT'):
            self.observe([self.sample('healthy')],inspect_delay=75)
        self.assertEqual(self.remote.calls[0][1],10);self.proof()
    def test_inspect_timeout_shrinks_to_remaining_deadline(self):
        with self.assertRaisesRegex(RuntimeError,'CI_RECOVERY_R_HEALTH_TIMEOUT'):
            self.observe([self.sample('starting')],inspect_delay=9)
        self.assertLess(self.remote.calls[-1][1],10);self.assertGreater(self.remote.calls[-1][1],0);self.proof()
    def test_inspect_command_and_malformed_output_are_redacted_failures(self):
        for sample in (RuntimeError('FIXTURE_SECRET_COMMAND'),b'FIXTURE_SECRET_BAD_JSON',b'[]',b'[{},{}]',{'Config':None}):
            with self.subTest(sample=sample):
                self.stderr=io.StringIO()
                with self.assertRaisesRegex(RuntimeError,'CI_RECOVERY_R_INSPECT_UNVERIFIED'):self.observe([sample])
                self.assertEqual(self.proof()['code'],'CI_RECOVERY_R_INSPECT_UNVERIFIED')
    def test_unchanged_production_preflight_still_rejects_starting(self):
        self.model.objects[self.model.rname]['State']['Health']={'Status':'starting'}
        r.configure_profile('post-transfer',C['rollbackSha'],C['businessSha'],'0'*64)
        with self.assertRaisesRegex(r.GateError,'PRODUCTION_NOT_HEALTHY'):r.preflight(self.model,self.model.art,LEDGER)
        self.assertEqual(self.model.objects[self.model.rname]['State']['Health']['Status'],'starting')


class ProcurementRecoveryFactsTests(unittest.TestCase):
    def test_l87_creates_exact_seven_empty_tables_with_unchanged_old_facts(self):
        before=[['InventoryItem',2,'fixed-old-row-hash']];schema={'schemaMd5':C['schemaMd5']}
        proof=_CI.verify_procurement_recovery_facts(87,[],empty_procurement_facts(),before,copy.deepcopy(before),schema)
        self.assertTrue(proof['protectedOldFactsUnchanged'])
        self.assertEqual(proof['newTablePolicy'],'L87_ABSENT_TO_L88_SEVEN_EMPTY_TABLES')
    def test_l87_rejects_missing_extra_populated_or_wrong_hash_tables_and_old_fact_or_schema_drift(self):
        expected=empty_procurement_facts();old=[['InventoryItem',2,'unchanged']];schema={'schemaMd5':C['schemaMd5']}
        populated=copy.deepcopy(expected);populated[0]['count']=1
        wrong_hash=copy.deepcopy(expected);wrong_hash[0]['hash']='0'*32
        for after in (expected[:-1],expected+[{'name':'Other','count':0,'hash':hashlib.md5(b'').hexdigest()}],populated,wrong_hash):
            with self.subTest(after=after),self.assertRaises(RuntimeError):_CI.verify_procurement_recovery_facts(87,[],after,old,old,schema)
        for before,after_old,after_schema in [(expected,old,schema),([],[],schema),([],old,{'schemaMd5':'wrong'})]:
            with self.assertRaises(RuntimeError):_CI.verify_procurement_recovery_facts(87,before,expected,old,after_old,after_schema)
    def test_l88_retains_exact_populated_row_hashes_and_rejects_every_changed_table(self):
        model=ProcurementModel(88);before=model.facts(model);schema=model.db()['procurementSchema']
        self.assertEqual(_CI.verify_procurement_recovery_facts(88,before,copy.deepcopy(before),model.old_facts,model.old_facts,schema)['newTablePolicy'],'L88_STRICT_EXISTING_ROW_HASHES_UNCHANGED')
        for index in range(7):
            after=copy.deepcopy(before);after[index]['hash']='0'*32
            with self.subTest(table=index),self.assertRaisesRegex(RuntimeError,'CI_FORMAL_RECOVERY_PROCUREMENT_FACTS_CHANGED'):
                _CI.verify_procurement_recovery_facts(88,before,after,model.old_facts,model.old_facts,schema)
        with self.assertRaises(RuntimeError):_CI.verify_procurement_recovery_facts(88,before,before[:-1],model.old_facts,model.old_facts,schema)


class B1CapacityTests(unittest.TestCase):
    ART={'archive':566876672,'blobs':566856143,'expanded':2096529408,'largest':1155686400}
    DB={'dbBytes':164142103,'pgVersion':'16.14'}
    def ledger(self,used=60*r.GIB,free=15964217344):
        return {'baselineUsed':used,'baselineAvailable':free,'phase':'PRE_IMPORT','peak':0,'retainedArtifactBudget':self.ART['blobs']+self.ART['expanded']}
    def test_old_model_fail_and_b1_both_envelopes_without_budget_reduction(self):
        limits=r.shipping_resources(self.DB)
        old=sum(self.ART.values())+r.RESERVE+sum(limits.values())
        self.assertEqual(old,6444543065);self.assertGreater(old,6*r.GIB)
        envelope=r.b1_envelope(self.ART,self.DB)
        self.assertEqual(envelope,{'import':5154070502,'database':4721979993})
        ledger=self.ledger();result=r.b1_capacity_gate(ledger,ledger['baselineUsed'],ledger['baselineAvailable'],envelope['import'],max(envelope.values()))
        self.assertEqual(result['projectedAvailable'],10810146842)
        self.assertEqual(limits,{'backupLimit':395393070,'restoreLimit':760861765,'walLimit':231250967,'migratorLimit':134217728})
    def test_six_gib_exact_plus_minus_one(self):
        for offset in (-1,0,1):
            ledger=self.ledger(0,100*r.GIB)
            if offset==1:
                with self.assertRaisesRegex(r.GateError,'B1_CAPACITY_6GIB'):r.b1_capacity_gate(ledger,0,100*r.GIB,6*r.GIB+offset)
            else:self.assertEqual(r.b1_capacity_gate(ledger,0,100*r.GIB,6*r.GIB+offset)['peak'],6*r.GIB+offset)
    def test_ten_gib_exact_plus_minus_one(self):
        for offset in (-1,0,1):
            free=11*r.GIB+offset;ledger=self.ledger(0,free)
            if offset==-1:
                with self.assertRaisesRegex(r.GateError,'B1_CAPACITY_10GIB'):r.b1_capacity_gate(ledger,0,free,r.GIB)
            else:self.assertEqual(r.b1_capacity_gate(ledger,0,free,r.GIB)['projectedAvailable'],10*r.GIB+offset)
    def test_ninety_percent_exact_plus_minus_one(self):
        total=200*r.GIB;future=r.GIB
        for offset in (-1,0,1):
            used=179*r.GIB+offset;free=total-used;ledger=self.ledger(used,free)
            if offset==1:
                with self.assertRaisesRegex(r.GateError,'B1_CAPACITY_90PCT'):r.b1_capacity_gate(ledger,used,free,future)
            else:r.b1_capacity_gate(ledger,used,free,future)
    def test_cumulative_not_per_phase_reset_or_repeated_charge(self):
        ledger=self.ledger();u=ledger['baselineUsed'];f=ledger['baselineAvailable'];env=r.b1_envelope(self.ART,self.DB)
        r.b1_capacity_gate(ledger,u,f,env['import'],max(env.values()))
        archive=self.ART['archive'];h=self.ART['blobs']+self.ART['expanded']
        for phase,actual,future in [('UPLOADED',archive,env['import']-archive),('IMPORT_TERMINATED_AND_ACCOUNTED',archive+h,r.RESERVE+r.shipping_resources(self.DB)['walLimit']),('DB',h,env['database']-h)]:
            ledger['phase']=phase
            for repeat in range(2):r.b1_capacity_gate(ledger,u+actual,f-actual,future)
        self.assertEqual(ledger['peak'],env['import']);self.assertEqual(len(ledger['observations']),7)
        # A new phase cannot reset either cumulative peak or remaining space.
        with self.assertRaisesRegex(r.GateError,'B1_CAPACITY_6GIB'):r.b1_capacity_gate(ledger,u+5*r.GIB,f-5*r.GIB,2*r.GIB)
    def test_no_credit_for_unrelated_deletion_or_filesystem_change(self):
        ledger=self.ledger(free=30*r.GIB);u=ledger['baselineUsed'];f=ledger['baselineAvailable']
        r.b1_capacity_gate(ledger,u,f,5*r.GIB)
        self.assertEqual(r.b1_capacity_gate(ledger,u-r.GIB,f+r.GIB,0)['peak'],5*r.GIB)
        with self.assertRaisesRegex(r.GateError,'B1_FILESYSTEM_CHANGED'):r.b1_capacity_gate(ledger,u,f+1,0)
    def test_fresh_db_and_df_each_gate_growth_is_not_stale(self):
        cap=self.ledger();cap['phase']='DB';remote=types.SimpleNamespace(b1_capacity=cap)
        reads=[];db=dict(self.DB);u=cap['baselineUsed'];f=cap['baselineAvailable'];h=self.ART['blobs']+self.ART['expanded']
        remote.db=lambda:(reads.append('db') or dict(db));remote.disk=lambda:(reads.append('df') or (u+h,f-h))
        first=r.b1_db_gate(remote);second=r.b1_db_gate(remote)
        self.assertEqual(first['peak'],second['peak']);self.assertEqual(reads,['db','df','db','df'])
        db['dbBytes']=r.GIB
        with self.assertRaisesRegex(r.GateError,'B1_CAPACITY_6GIB'):r.b1_db_gate(remote)
        cap['phase']='UPLOADED'
        with self.assertRaisesRegex(r.GateError,'B1_PHASE_INVALID'):r.b1_db_gate(remote)
    def test_unrelated_free_cannot_mask_fresh_db_growth(self):
        cap=self.ledger(free=30*r.GIB);cap['phase']='DB';cap['peak']=5154070502
        remote=types.SimpleNamespace(b1_capacity=cap,db=lambda:{'dbBytes':700*1024**2,'pgVersion':'16.14'},
            disk=lambda:(cap['baselineUsed']-r.GIB,cap['baselineAvailable']+r.GIB))
        with self.assertRaisesRegex(r.GateError,'B1_CAPACITY_6GIB'):r.b1_db_gate(remote)
    def test_retained_backup_restore_counted_actual_not_future_twice(self):
        cap=self.ledger();cap['phase']='DB';limits=r.shipping_resources(self.DB)
        h=self.ART['blobs']+self.ART['expanded'];used=cap['baselineUsed']+h+limits['backupLimit']+limits['restoreLimit']
        remote=types.SimpleNamespace(b1_capacity=cap,db=lambda:dict(self.DB),disk=lambda:(used,cap['baselineUsed']+cap['baselineAvailable']-used))
        result=r.b1_db_gate(remote,{k:limits[k] for k in ('walLimit','migratorLimit')})
        self.assertEqual(result['peak'],r.b1_envelope(self.ART,self.DB)['database'])
        self.assertEqual(cap['phase'],'DB_RETAINED')
    def test_exact_b1_controller_identity_and_entire_commit_chain(self):
        legacy=AdmissionTests().identity_git
        for fault in (None,'ancestor','merge','scope','business','same-e'):
            def git(repo,*args):
                if args==('branch','--show-current'):return r.B1_BRANCH
                if args[:2]==('rev-list','--merges'):return 'b'*40 if fault=='merge' else ''
                if args[:1]==('log',):return 'server/v2.js' if fault=='scope' else '\n'.join(sorted(r.B1_FILES))
                if args[:3]==('diff','--name-only',r.B1_BASE):return 'server/v2.js' if fault=='business' else ''
                return legacy(repo,*args)
            with self.subTest(fault=fault),patch.object(r,'B1_IDENTITY',False),patch.object(r,'git',side_effect=git),patch.object(r,'is_ancestor',return_value=fault!='ancestor'):
                if fault:
                    with self.assertRaises(r.GateError):r.validate_procurement_identity(ROOT,r.B1_BASE if fault=='same-e' else 'a'*40)
                else:r.validate_procurement_identity(ROOT,'a'*40)
    def test_fixed_r_exact_id_required_without_import(self):
        art={'compatibility':{'release':C['rollbackSha']}}
        with patch.object(r,'resolve_loaded_image',return_value={'Id':'fixed-r'}):
            self.assertEqual(r.b1_fixed_r(None,art),'fixed-r')
            with self.assertRaisesRegex(r.GateError,'B1_R_BASELINE_UNVERIFIED'):r.b1_fixed_r(None,art,{'fixedRImageId':'changed'})
        with patch.object(r,'resolve_loaded_image',side_effect=r.GateError('missing')):
            with self.assertRaisesRegex(r.GateError,'B1_R_BASELINE_UNVERIFIED'):r.b1_fixed_r(None,art)
    def test_unknown_import_receipt_and_storage_proof_fail_closed(self):
        for proof in ({},{'terminated':True},{'terminated':True,'activeIngest':1,'unknownSnapshots':0,'allocatedRoots':{'x':1}},
                      {'terminated':True,'activeIngest':0,'unknownSnapshots':1,'allocatedRoots':{'x':1}}):
            with self.subTest(proof=proof),self.assertRaisesRegex(r.GateError,'B1_IMPORT_UNKNOWN'):
                r.b1_storage(types.SimpleNamespace(py=lambda *args:json.dumps(proof)))
    def test_real_storage_parser_rejects_active_ingest_unknown_snapshot_and_driver(self):
        baseinfo={'ServerVersion':'29.1.3','Driver':'overlayfs','DockerRootDir':'/var/lib/docker','DriverStatus':[['driver-type','io.containerd.snapshotter.v1']]}
        for mutation in ('valid','ingest','snapshot','driver','short-id','bad-header','command-failure'):
            info=copy.deepcopy(baseinfo)
            if mutation=='driver':info['Driver']='overlay2'
            def run(args,**kw):
                if mutation=='command-failure':raise subprocess.CalledProcessError(1,args)
                if args[:2]==['docker','info']:return json.dumps(info).encode()
                if args[:2]==['docker','ps']:return (('a'*12 if mutation=='short-id' else 'a'*64)+'\n').encode()
                if args[-2:]==['content','active']:return ('REF SIZE AGE\n'+('held 4B 1s\n' if mutation=='ingest' else '')).encode()
                if args[-1]=='list':return (('UNKNOWN\n' if mutation=='bad-header' else 'KEY PARENT KIND\n')+('unowned Active\n' if mutation=='snapshot' else 'a'*64+' Active\nlayer Committed\n')).encode()
                if args[0]=='du':return b'4096 path\n'
                raise AssertionError(args)
            out=io.StringIO()
            with patch('sys.stdin',io.StringIO('{}')),patch('sys.stdout',out),patch('subprocess.check_output',side_effect=run),patch('os.stat',return_value=types.SimpleNamespace(st_dev=1)),patch.object(Path,'is_symlink',return_value=False):
                if mutation=='valid':exec(compile(r.B1_STORAGE_CODE,'b1-storage','exec'),{})
                else:
                    with self.assertRaises((AssertionError,subprocess.CalledProcessError)):exec(compile(r.B1_STORAGE_CODE,'b1-storage','exec'),{})
            if mutation=='valid':self.assertEqual(json.loads(out.getvalue())['activeIngest'],0)


class B1ImportBarrierTests(unittest.TestCase):
    def attempt(self,fault=None):
        art={**B1CapacityTests.ART,'archiveHash':'c'*64,'release':'a'*40}
        cap={'baselineUsed':60*r.GIB,'baselineAvailable':15964217344,'phase':'UPLOADED','peak':5154070502,'retainedArtifactBudget':art['blobs']+art['expanded'],
             'importReceipt':{'serverWaitComplete':True,'returncode':0,'archiveHash':art['archiveHash'],'archiveBytes':art['archive'],'archiveInode':17}}
        art['capacityLedger']=cap;events=[];released=False
        if fault=='receipt':cap['importReceipt']['serverWaitComplete']=False
        proof={'inode':17,'device':1,'allocated':art['archive'],'path':'fixture'}
        if fault=='inode':proof['inode']=18
        h=art['blobs']+art['expanded']
        def disk():
            events.append('df');actual=h+(0 if released and fault!='no-free' else art['archive'])
            return cap['baselineUsed']+actual,cap['baselineAvailable']-actual
        def db():
            events.append('db')
            return {**B1CapacityTests.DB,'dbBytes':r.GIB if released and fault=='db-growth' else 164142103}
        remote=types.SimpleNamespace(b1_capacity=cap,db=db,disk=disk)
        def stage(remote,art,action,proof=None):
            nonlocal released
            events.append(action)
            if fault=='ownership' and action=='inspect':raise r.GateError('B1_ARCHIVE_UNVERIFIED')
            if action=='cleanup':released=True
            return {'inode':18 if fault=='inode' else 17,'device':1,'allocated':art['archive'],'path':'fixture'}
        def storage(remote):
            events.append('storage')
            if fault=='ingest':raise r.GateError('B1_IMPORT_UNKNOWN')
            return {}
        def image(remote,art):
            events.append('image')
            if fault=='image':raise r.GateError('LOADED_ARTIFACT_MISMATCH')
            return {'Id':'synthetic-e'}
        def fixed(*args):
            events.append('fixed-r')
            if fault=='fixed-r':raise r.GateError('B1_R_BASELINE_UNVERIFIED')
        with patch.object(r,'b1_stage',side_effect=stage),patch.object(r,'b1_storage',side_effect=storage),patch.object(r,'resolve_loaded_image',side_effect=image),patch.object(r,'b1_fixed_r',side_effect=fixed):
            try:result=r.b1_archive_release(remote,art)
            except r.GateError as error:return events,cap,str(error)
        return events,cap,result
    def test_real_release_barrier_order_and_fresh_db_df(self):
        events,cap,result=self.attempt()
        self.assertEqual(events,['image','fixed-r','storage','inspect','image','storage','df','db','cleanup','released','storage','df','db','df'])
        self.assertEqual(cap['phase'],'DB');self.assertTrue(cap['archiveRelease']['verified'])
        self.assertEqual(result['peak'],5154070502)
    def test_unknown_or_wrong_ownership_never_get_cleanup_credit(self):
        for fault in ('receipt','inode','ownership','ingest','image','fixed-r'):
            with self.subTest(fault=fault):
                events,cap,error=self.attempt(fault)
                self.assertIsInstance(error,str);self.assertNotIn('cleanup',events);self.assertNotIn('archiveRelease',cap)
    def test_unlink_without_actual_release_holds(self):
        events,cap,error=self.attempt('no-free')
        self.assertEqual(error,'B1_ARCHIVE_RELEASE_NOT_OBSERVED');self.assertEqual(cap['phase'],'IMPORT_TERMINATED_AND_ACCOUNTED')
        self.assertNotIn('archiveRelease',cap);self.assertEqual(events[-1],'df')
    def test_post_cleanup_db_growth_holds_before_db_work(self):
        events,cap,error=self.attempt('db-growth')
        self.assertEqual(error,'B1_CAPACITY_6GIB');self.assertEqual(events[-2:],['db','df'])
    def test_deploy_has_no_r_import_no_second_import_and_releases_before_handoff(self):
        source=(ROOT/'scripts/deploy-prod-transfer-cas.py').read_text()
        node=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=='b1_deploy')
        body=ast.get_source_segment(source,node)
        self.assertEqual(body.count("remote.run(['python3','-c',B1_IMPORT_CODE"),1)
        self.assertNotIn('compatibilityPath',body)
        self.assertLess(body.index('b1_archive_release(remote,art)'),body.index('run_loaded_controller(v)'))
        self.assertNotIn('os.rmdir',body)


class B1PreflightTests(unittest.TestCase):
    def test_same_legacy_output_fields_and_fresh_storage_guards(self):
        r.configure_profile('post-transfer',C['oldSha'],C['businessSha'],'0'*64)
        model=ProcurementModel();model.art['capacityProfile']='B1'
        storage={'terminated':True,'activeIngest':0,'unknownSnapshots':0,'allocatedRoots':{'docker':1,'containerd':1}}
        with patch.object(r,'b1_storage',return_value=storage):
            state=r.preflight(model,model.art,LEDGER)
            self.assertTrue({'dfHuman','dockerSystemDf','diskUsed','diskAvailable','budget','old','name','template','active','migrationResources','before_ledger','migration_phase'}<=set(state))
            original=model.run
            def changed(args,*a,**kw):
                if args[:2]==['docker','info']:return json.dumps({'ServerVersion':'unknown','Driver':'overlayfs'}).encode()
                return original(args,*a,**kw)
            with patch.object(model,'run',side_effect=changed),self.assertRaisesRegex(r.GateError,'DOCKER_STORAGE_MODEL_CHANGED'):
                r.preflight(model,model.art,LEDGER)
            with patch.object(model,'py',return_value='false'),self.assertRaisesRegex(r.GateError,'DOCKER_FILESYSTEM_MODEL_CHANGED'):
                r.preflight(model,model.art,LEDGER)

class B1FormalPathTests(unittest.TestCase):
    def attempt(self,fault=None):
        r.configure_profile('post-transfer',C['oldSha'],C['businessSha'],'0'*64)
        class Model(ProcurementModel):
            def __init__(self):
                super().__init__();self.lock=False;self.imported=False;self.archive_present=False;self.cleaned=False
                self.art.update(B1CapacityTests.ART);self.art['capacityProfile']='B1';self.order=[]
            def disk(self):
                growth=(self.art['archive'] if self.archive_present or (self.cleaned and fault=='no-free') else 0)+(self.art['blobs']+self.art['expanded'] if self.imported else 0)
                return 60*r.GIB+growth,15964217344-growth
            def db(self):
                value=super().db();value['dbBytes']=r.GIB if self.cleaned and fault=='db-growth' else 164142103;return value
            def run(self,args,data=None,timeout=60):
                if args[:3]==['docker','images','-q'] and args[-1]==self.art['imageReference'] and not self.imported:return b''
                if args[:3]==['python3','-c',r.B1_IMPORT_CODE]:
                    self.order.append('import');self.imported=True
                    if fault=='transport':raise r.GateError('COMMAND_UNAVAILABLE_OR_TIMEOUT')
                    return json.dumps({'returncode':0,'serverWaitComplete':True,'archiveHash':self.art['archiveHash'],'archiveBytes':self.art['archive'],'archiveInode':17}).encode()
                if args[:2]==['docker','stop'] and args[-1] in ('G','g-id'):
                    self.order.append('stop-old');assert self.cleaned,'OLD_WRITER_STOPPED_BEFORE_ARCHIVE_RELEASE'
                return super().run(args,data,timeout)
            def py(self,code,value=None,timeout=60):
                if code=='import os; os.mkdir(%r,0o700)' % r.LOCK:self.lock=True;return b''
                if code==r.B1_STORAGE_CODE:
                    if self.imported and fault=='ingest':return '{}'
                    return json.dumps({'terminated':True,'activeIngest':0,'unknownSnapshots':0,'allocatedRoots':{'docker':1,'containerd':1}})
                if code==r.B1_STAGE_CODE:
                    action=value['action'];self.order.append(action)
                    if action=='cleanup':
                        assert self.old['State']['Running'];self.cleaned=True;self.archive_present=False
                    return json.dumps({'claimed':True} if action=='claim' else {'released':True} if action=='released' else {'inode':17,'device':1,'allocated':self.art['archive'],'path':'fixture'})
                return super().py(code,value,timeout)
        model=Model()
        def upload(*args):model.order.append('upload');model.archive_present=True;return 'fixture'
        with patch.object(r,'stage_artifact',side_effect=upload),patch.object(r,'procurement_facts',side_effect=model.facts),patch.object(r,'signal') as signals,contextlib.redirect_stdout(io.StringIO()):
            signals.SIGHUP=1;signals.SIGTERM=15;signals.SIGINT=2
            try:r.deploy(model,ROOT,Path('fixture'),model.art,LEDGER,model.sha)
            except r.GateError as error:return model,str(error)
        return model,None
    def test_real_b1_deploy_execute_loaded_order(self):
        model,error=self.attempt();self.assertIsNone(error)
        self.assertEqual(model.phase,88);self.assertEqual(model.pointer,model.sha);self.assertFalse(model.lock)
        self.assertLess(model.order.index('cleanup'),model.order.index('stop-old'))
        self.assertEqual(model.order.count('import'),1);self.assertEqual(r.writer_names(model.containers()),[model.ename])
        self.assertEqual(model.art['capacityLedger']['peak'],5154070502)
    def test_transport_unknown_ingest_no_free_and_db_growth_never_stop_old_writer(self):
        for fault in ('transport','ingest','no-free','db-growth'):
            with self.subTest(fault=fault):
                model,error=self.attempt(fault);self.assertIsNotNone(error)
                self.assertNotIn('stop-old',model.order);self.assertTrue(model.lock)
                self.assertEqual(r.writer_names(model.containers()),['G'])
                self.assertEqual(model.order.count('import'),1)
                if fault in ('transport','ingest'):self.assertNotIn('cleanup',model.order)

class B1ArchiveTests(unittest.TestCase):
    def helper(self,value):
        import pwd
        # Only the Unix account mapping is adapted to the unprivileged local
        # test user. CI Linux executes real /proc reader and mmap checks.
        original_iterdir=Path.iterdir
        def iterdir(p):
            if str(p)=='/proc':return iter([Path('/proc')/str(os.getpid())]) if sys.platform=='linux' else iter(())
            return original_iterdir(p)
        out=io.StringIO()
        with patch('sys.stdin',io.StringIO(json.dumps(value))),patch('sys.stdout',out),patch('pwd.getpwnam',return_value=types.SimpleNamespace(pw_uid=os.getuid())),patch.object(Path,'iterdir',iterdir):
            exec(compile(r.B1_STAGE_CODE,'b1-owned-archive','exec'),{})
        return json.loads(out.getvalue())
    def fixture(self,root):
        data=b'synthetic archive\n'*4096;sha='a'*40
        v={'root':str(root.resolve()),'release':sha,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'token':'test-release-owner','action':'claim'}
        root.chmod(0o700);self.helper(v)
        tar=root/(sha+'.tar');meta=root/(sha+'.json')
        tar.write_bytes(data);meta.write_text(json.dumps({k:v[k] for k in ('release','sha256','bytes')}))
        tar.chmod(0o600);meta.chmod(0o600)
        return v,tar,meta
    def test_exact_release_and_wrong_identity_never_cleaned(self):
        for mutation in ('sha','size','symlink','hardlink','uid','mode','token','metadata'):
            with self.subTest(mutation=mutation),tempfile.TemporaryDirectory() as d:
                root=Path(d).resolve();v,tar,meta=self.fixture(root)
                if mutation=='sha':tar.write_bytes(b'x'*v['bytes'])
                elif mutation=='size':tar.write_bytes(b'x')
                elif mutation=='symlink':other=root/'other';tar.rename(other);tar.symlink_to(other)
                elif mutation=='hardlink':os.link(tar,root/'other')
                elif mutation=='mode':tar.chmod(0o644)
                elif mutation=='token':v['token']='wrong'
                elif mutation=='metadata':meta.write_text('{}')
                v['action']='cleanup';v.update(inode=tar.stat().st_ino,device=tar.stat().st_dev,allocated=tar.stat().st_blocks*512)
                if mutation=='uid':
                    original=Path.lstat
                    def altered(p):
                        value=original(p)
                        if p==tar:return types.SimpleNamespace(st_mode=value.st_mode,st_nlink=value.st_nlink,st_uid=os.getuid()+1)
                        return value
                    with patch.object(Path,'lstat',altered),self.assertRaises(AssertionError):self.helper(v)
                else:
                    with self.assertRaises(AssertionError):self.helper(v)
                self.assertTrue(tar.exists());self.assertTrue(meta.exists())
    def test_exact_owned_release_and_unrelated_r_preserved(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d).resolve();v,tar,meta=self.fixture(root);fixed=root/'fixed-r.tar';fixed.write_bytes(b'KEEP R')
            proof=self.helper({**v,'action':'inspect'})
            self.helper({**v,**proof,'action':'cleanup'});self.helper({**v,**proof,'action':'released'})
            self.assertFalse(tar.exists());self.assertEqual(fixed.read_bytes(),b'KEEP R')
    def test_existing_archive_cannot_be_claimed_or_deleted(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d).resolve();v,tar,meta=self.fixture(root)
            with self.assertRaises(AssertionError):self.helper(v)
            self.assertTrue(tar.exists())
    @unittest.skipUnless(sys.platform=='linux','real /proc readers require hosted Linux')
    def test_open_reader_and_mmap_block_cleanup(self):
        import mmap
        with tempfile.TemporaryDirectory() as d:
            root=Path(d).resolve();v,tar,meta=self.fixture(root)
            with tar.open('rb') as stream:
                with self.assertRaises(AssertionError):self.helper({**v,'action':'inspect'})
                mapping=mmap.mmap(stream.fileno(),0,access=mmap.ACCESS_READ)
            try:
                with self.assertRaises(AssertionError):self.helper({**v,'action':'inspect'})
            finally:mapping.close()
            self.helper({**v,'action':'inspect'})


class ReleaseModelClock:
    def __init__(self):self.now=0;self.sleeps=[]
    def monotonic(self):return self.now
    def sleep(self,seconds):self.sleeps.append(seconds);self.now+=seconds


class B2FormalPathTests(unittest.TestCase):
    def attempt(self,fault=None,fresh_artifact=False,capacity_waiver=False):
        r.configure_profile('post-transfer',C['oldSha'],C['businessSha'],'0'*64)
        class Model(ProcurementModel):
            def __init__(self):
                super().__init__();self.lock=False;self.r_imported=False;self.e_imported=False;self.archive_present=False;self.cleaned=False;self.order=[]
                self.art.update(archive=566899200,blobs=566872461,expanded=2096597408,largest=1155686400,capacityProfile='B2')
                self.art['layers']=[{'chainId':'common'},{'chainId':'e-only'}]
                self.art['compatibility'].update(archive=566753792,blobs=566730271,expanded=2095460288,largest=1155686400,
                    layers=[{'chainId':'common'},{'chainId':'r-only'}])
                self.e_image=super().inspect(self.art['imageReference'],True)
                if fresh_artifact:self.art.pop('loadedDockerImageId')
                if fault=='stale-e-id':self.art['loadedDockerImageId']='sha256:'+'0'*64
                self.shared_inputs=[];self.release_observations=0
                self.baseline_used=175*r.GIB if fault=='capacity-90' else 60*r.GIB
                self.baseline_free=25*r.GIB if fault=='capacity-90' else 15964217344
            def disk(self):
                self.order.append('fresh-df')
                if self.cleaned and not self.e_imported:self.release_observations+=1
                if self.cleaned and fault=='df-unknown':raise r.GateError('COMMAND_UNAVAILABLE_OR_TIMEOUT')
                delayed=self.cleaned and fault=='delayed-free' and self.release_observations<2
                growth=(self.art['compatibility']['archive'] if self.archive_present or self.cleaned and fault=='no-free' or delayed else 0)
                growth+=(2177372160 if self.r_imported else 0)+(192827392 if self.e_imported else 0)
                if self.cleaned:
                    growth+={'unrelated-writes':64*1024**2,'capacity-6':4*r.GIB,
                             'capacity-10':2400*1024**2,'capacity-90':3*r.GIB,
                             'unrelated-deletion':-4*r.GIB}.get(fault,0)
                return self.baseline_used+growth,self.baseline_free-growth
            def db(self):
                self.order.append('fresh-db');value=super().db()
                value['dbBytes']=r.GIB if self.e_imported and fault=='db-growth' else 164142103;return value
            def inspect(self,name,image=False):
                if image and name==self.art['compatibility']['imageReference'] and (not self.r_imported or self.e_imported and fault=='r-lost'):
                    raise r.GateError('LOADED_ARTIFACT_MISMATCH')
                if image and name==self.art['imageReference'] and self.e_imported and fault=='wrong-e':
                    image=copy.deepcopy(self.e_image);image['RootFS']['Layers']=['wrong'];return image
                if image and name==self.art['imageReference']:return copy.deepcopy(self.e_image)
                return super().inspect(name,image)
            def run(self,args,data=None,timeout=60):
                if args[:3]==['docker','images','-q'] and args[-1]==self.art['imageReference'] and not self.e_imported:return b''
                if args[:3]==['python3','-c',r.B1_IMPORT_CODE]:
                    self.order.append('r-import');self.r_imported=True
                    if fault=='r-interrupted':raise r.GateError('COMMAND_UNAVAILABLE_OR_TIMEOUT')
                    a=self.art['compatibility'];return json.dumps({'returncode':0,'serverWaitComplete':fault!='r-wait','archiveHash':a['archiveHash'],'archiveBytes':a['archive'],'archiveInode':17}).encode()
                if args[:2]==['docker','stop'] and args[-1] in ('G','g-id'):
                    self.order.append('stop-old');assert self.cleaned and self.r_imported and self.e_imported
                return super().run(args,data,timeout)
            def py(self,code,value=None,timeout=60):
                if code=='import os; os.mkdir(%r,0o700)' % r.LOCK:self.lock=True;return b''
                if code==r.B2_ABSENT_CODE:
                    self.order.append('r-absent');return json.dumps({'absent':fault not in ('r-present','wrong-r')})
                if code==r.B2_SHARED_CODE:
                    self.order.append('shared-proof')
                    self.shared_inputs.append(copy.deepcopy(value))
                    if fault=='shared-unknown' or self.e_imported and fault=='retained-unknown':raise r.GateError('COMMAND_FAILED')
                    role='r' if not self.e_imported else 'e'
                    shared=1985757184;unique=2177372160-shared if role=='r' else 2178584576-shared
                    return json.dumps({'verified':True,'creditedBytes':0 if fault=='no-shared' else shared,'source':'SYNTHETIC_FRESH_ALLOCATION_FIXTURE',
                        'ownedAllocatedBytes':2177372160 if role=='r' else 2178584576,'metadataAllocated':0,'ownedExtraBlobs':{},
                        'ownedLayers':[{'chainId':'common','contentDigest':'common','snapshotAllocated':shared,'blobAllocated':0},
                            {'chainId':role+'-only','contentDigest':role+'-only','snapshotAllocated':unique,'blobAllocated':0}]})
                if code==r.B1_STORAGE_CODE:
                    self.order.append('storage')
                    if self.r_imported and fault=='r-ingest' or self.e_imported and fault=='e-ingest' or self.cleaned and fault=='post-cleanup-ingest':return '{}'
                    if self.cleaned and fault=='post-cleanup-snapshot':
                        return json.dumps({'terminated':True,'activeIngest':0,'unknownSnapshots':1,'allocatedRoots':{'docker':1,'containerd':1}})
                    return json.dumps({'terminated':True,'activeIngest':0,'unknownSnapshots':0,'allocatedRoots':{'docker':1,'containerd':1}})
                if code==r.B1_STAGE_CODE:
                    action=value['action'];self.order.append(action)
                    if action=='released' and fault=='released-proof':raise r.GateError('COMMAND_FAILED')
                    if action=='cleanup':
                        if fault in ('cleanup-ownership','cleanup-reader'):raise r.GateError('COMMAND_FAILED')
                        assert self.r_imported and not self.e_imported and self.old['State']['Running']
                        assert value['inode']==17 and value['device']==1 and value['allocated']==self.art['compatibility']['archive']
                        self.cleaned=True;self.archive_present=False
                    return json.dumps({'claimed':True} if action=='claim' else {'released':True} if action=='released' else {'inode':18 if fault=='inode' else 17,'device':1,'allocated':self.art['compatibility']['archive'],'path':'fixture'})
                return super().py(code,value,timeout)
        model=Model()
        if capacity_waiver:
            r.configure_capacity_waiver({'releaseSha':model.sha,'parentSha':r.B2_CAPACITY_WAIVER_PARENT},model.art,emit=False)
        def upload(*args):model.order.append('r-upload');model.archive_present=True;return 'fixture'
        def stream(remote,path,art):
            model.order.append('e-stream');assert model.cleaned and model.r_imported;model.e_imported=True
            if fault=='e-interrupted':raise r.GateError('B2_IMPORT_UNKNOWN')
            return {'serverWaitComplete':fault!='e-wait','returncode':0,'archiveBytes':art['archive'],'archiveHash':art['archiveHash'],'targetArchiveFiles':0}
        def committed(remote):
            keys=({'common','r-only'} if model.r_imported else set())|({'e-only'} if model.e_imported else set())
            return keys|({'unknown'} if model.e_imported and fault=='residual' else set())
        clock=ReleaseModelClock()
        with patch.object(r.time,'monotonic',side_effect=clock.monotonic),patch.object(r.time,'sleep',side_effect=clock.sleep),patch.object(r,'stage_artifact',side_effect=upload),patch.object(r,'b2_stream',side_effect=stream),patch.object(r,'b2_committed',side_effect=committed),patch.object(r,'procurement_facts',side_effect=model.facts),patch.object(r,'signal') as signals,contextlib.redirect_stdout(io.StringIO()):
            signals.SIGHUP=1;signals.SIGTERM=15;signals.SIGINT=2
            try:r.deploy(model,ROOT,Path('fixture'),model.art,LEDGER,model.sha)
            except r.GateError as error:return model,str(error)
        return model,None
    def test_b2_actual_deploy_and_execute_loaded_sequential_order(self):
        model,error=self.attempt();self.assertIsNone(error)
        self.assertEqual(model.phase,88);self.assertEqual(model.pointer,model.sha);self.assertFalse(model.lock)
        expected=['r-upload','r-import','cleanup','shared-proof','e-stream','shared-proof','stop-old']
        self.assertEqual([x for x in model.order if x in expected],expected)
        cap=model.art['capacityLedger'];self.assertEqual(cap['peak'],5152752630)
        self.assertTrue(cap['rArchiveRelease']['verified']);self.assertEqual(cap['eImportReceipt']['targetArchiveFiles'],0)
        self.assertEqual(cap['eAdmission']['dbBytes'],164142103)
        self.assertLessEqual(cap['eAdmission']['planned'],cap['peak'])
        self.assertEqual(r.writer_names(model.containers()),[model.ename])
    def test_fresh_artifact_pins_validated_e_identity_before_retained_proof(self):
        model,error=self.attempt(fresh_artifact=True)
        self.assertIsNone(error)
        self.assertEqual(model.art['loadedDockerImageId'],model.e_image['Id'])
        self.assertEqual(model.order.count('shared-proof'),2)
        self.assertEqual(model.phase,88)
        forward,retained=model.shared_inputs
        self.assertEqual(retained['imageId'],model.e_image['Id'])
        self.assertEqual(retained['rLayers'],forward['eLayers'])
        self.assertEqual(retained['eLayers'],forward['rLayers'])
        self.assertEqual(retained['configDigest'],model.art['archiveConfigDigest'])
    def test_stale_identity_and_retained_unknown_fail_closed_after_e_import(self):
        for fault,code,count in [('stale-e-id','LOADED_IMAGE_CHANGED',1),('retained-unknown','B2_SHARED_UNKNOWN',2)]:
            with self.subTest(fault=fault):
                model,error=self.attempt(fault)
                self.assertEqual(error,code)
                self.assertTrue(model.e_imported)
                self.assertEqual(model.order.count('shared-proof'),count)
                self.assertNotIn('stop-old',model.order)
                self.assertTrue(model.old['State']['Running'])
                self.assertTrue(model.lock)
    def test_r_present_wrong_r_stop_before_lock_or_upload(self):
        for fault in ('r-present','wrong-r'):
            model,error=self.attempt(fault);self.assertEqual(error,'B2_R_NOT_ABSENT')
            self.assertFalse(model.lock);self.assertNotIn('r-upload',model.order)
    def test_r_interrupted_unverified_or_unknown_never_cleanup_or_stream(self):
        for fault in ('r-interrupted','r-wait','r-ingest','inode'):
            with self.subTest(fault=fault):
                model,error=self.attempt(fault);self.assertIsNotNone(error)
                self.assertNotIn('cleanup',model.order);self.assertNotIn('e-stream',model.order);self.assertTrue(model.old['State']['Running']);self.assertTrue(model.lock)
    def test_unobserved_reclaim_still_requires_actual_capacity_and_shared_admission(self):
        for fault in ('no-free','shared-unknown','no-shared'):
            with self.subTest(fault=fault):
                model,error=self.attempt(fault);self.assertIsNotNone(error);self.assertNotIn('e-stream',model.order)
                self.assertTrue(model.old['State']['Running'])
        self.assertEqual(self.attempt('no-free')[1],'B1_CAPACITY_10GIB')
        self.assertEqual(self.attempt('no-shared')[1],'B1_CAPACITY_6GIB')
    def test_e_interrupted_wrong_identity_residual_or_db_growth_never_stop_old(self):
        for fault in ('e-interrupted','e-wait','e-ingest','wrong-e','residual','r-lost','db-growth'):
            with self.subTest(fault=fault):
                model,error=self.attempt(fault);self.assertIsNotNone(error)
                self.assertNotIn('stop-old',model.order);self.assertTrue(model.old['State']['Running']);self.assertTrue(model.lock)
    def test_archive_release_precedes_fresh_df_db_and_no_e_file(self):
        model,error=self.attempt();self.assertIsNone(error)
        between=model.order[model.order.index('cleanup')+1:model.order.index('e-stream')]
        self.assertIn('fresh-df',between);self.assertIn('fresh-db',between);self.assertIn('shared-proof',between)
        self.assertEqual(model.order.count('r-upload'),1)
    def test_unsettled_df_is_admitted_only_by_fresh_actual_capacity(self):
        model,error=self.attempt('delayed-free')
        self.assertIsNone(error)
        self.assertGreaterEqual(model.release_observations,2)
        self.assertTrue(model.art['capacityLedger']['rArchiveRelease']['verified'])
        self.assertEqual(model.art['capacityLedger']['rArchiveRelease']['allocated'],model.art['compatibility']['archive'])
        self.assertLess(model.order.index('released'),model.order.index('e-stream'))
        after_cleanup=model.order[model.order.index('cleanup')+1:model.order.index('e-stream')]
        self.assertEqual(after_cleanup[:2],['released','storage'])
        self.assertGreaterEqual(after_cleanup.count('fresh-df'),2)
        self.assertEqual(model.phase,88);self.assertEqual(r.writer_names(model.containers()),[model.ename])
    def test_absence_or_post_cleanup_ingest_failure_precedes_fresh_capacity(self):
        for fault,code in [('released-proof','B1_ARCHIVE_UNVERIFIED'),('post-cleanup-ingest','B1_IMPORT_UNKNOWN')]:
            with self.subTest(fault=fault):
                model,error=self.attempt(fault)
                self.assertEqual(error,code);self.assertEqual(model.release_observations,0)
                self.assertNotIn('rArchiveRelease',model.art['capacityLedger'])
                self.assertNotIn('e-stream',model.order);self.assertTrue(model.old['State']['Running']);self.assertTrue(model.lock)

class B2CapacityWaiverTests(unittest.TestCase):
    def setUp(self):r.configure_profile('post-transfer',C['oldSha'],C['businessSha'],'0'*64)
    def tearDown(self):r.configure_profile('post-transfer',C['oldSha'],C['businessSha'],'0'*64)
    def enable(self):
        r.configure_capacity_waiver({'releaseSha':'a'*40,'parentSha':r.B2_CAPACITY_WAIVER_PARENT},
                                   {'release':'a'*40,'capacityProfile':'B2'},emit=False)
    def test_all_and_only_authorized_capacity_codes_are_telemetry(self):
        self.enable()
        expected={'B1_CAPACITY_6GIB','B1_CAPACITY_10GIB','B1_CAPACITY_90PCT',
            'ARTIFACT_DISK_GATE_FAIL:ABSOLUTE_PEAK','ARTIFACT_DISK_GATE_FAIL:DYNAMIC_HEADROOM',
            'ARTIFACT_DISK_GATE_FAIL:POST_IMPORT_HEADROOM','ARTIFACT_DISK_GATE_FAIL:POST_DEPLOY_HEADROOM',
            'SHIPPING_MIGRATION_DISK_GATE_FAILED'}
        self.assertEqual(r.CAPACITY_WAIVER_CODES,expected)
        for code in expected:r.capacity_require(False,code,{'phase':'FOCUSED'})
        self.assertEqual({x['guard'] for x in r.CAPACITY_TELEMETRY},expected)
        self.assertTrue(all(x['waived'] for x in r.CAPACITY_TELEMETRY))
        for code in ('COMMAND_FAILED','ENOSPC','B1_FILESYSTEM_CHANGED','B2_SHARED_UNKNOWN',
                     'B1_ARCHIVE_UNVERIFIED','B1_IMPORT_UNKNOWN','DATABASE_AUTHORITY_MISMATCH',
                     'WRITER_TRANSITION_FAILED','HEALTH_FAILED'):
            with self.subTest(code=code),self.assertRaisesRegex(r.GateError,code):
                r.capacity_require(False,code,{})
    def test_exact_scope_and_profile_reset(self):
        receipt={'releaseSha':'a'*40,'parentSha':r.B2_CAPACITY_WAIVER_PARENT}
        art={'release':'a'*40,'capacityProfile':'B2'}
        for bad,artifact in [({**receipt,'parentSha':'b'*40},art),
                             ({**receipt,'releaseSha':'c'*40},art),
                             (receipt,{**art,'capacityProfile':'B1'}),
                             (receipt,{**art,'capacityProfile':'LEGACY'})]:
            with self.assertRaisesRegex(r.GateError,'B2_CAPACITY_WAIVER_SCOPE_INVALID'):
                r.configure_capacity_waiver(bad,artifact,emit=False)
        r.configure_profile('post-transfer',r.SHIPPING_OLD_SHA,r.SHIPPING_BUSINESS_SHA,'0'*64)
        with self.assertRaisesRegex(r.GateError,'B2_CAPACITY_WAIVER_SCOPE_INVALID'):
            r.configure_capacity_waiver(receipt,art,emit=False)
        r.configure_profile('post-transfer',C['oldSha'],C['businessSha'],'0'*64);self.enable()
        r.configure_profile('post-transfer',C['oldSha'],C['businessSha'],'0'*64)
        self.assertIsNone(r.CAPACITY_WAIVER)
        with self.assertRaisesRegex(r.GateError,'B1_CAPACITY_6GIB'):
            r.capacity_require(False,'B1_CAPACITY_6GIB',{})
    def test_original_formula_history_and_complete_numeric_telemetry(self):
        self.enable();used=95*r.GIB;available=5*r.GIB;cap=B1CapacityTests().ledger(used,available)
        first=r.b1_capacity_gate(cap,used,available,7*r.GIB,8*r.GIB)
        self.assertEqual(first['peak'],8*r.GIB);self.assertEqual(first['projectedAvailable'],-3*r.GIB)
        later=r.b1_capacity_gate(cap,used-4*r.GIB,available+4*r.GIB,0)
        self.assertEqual(later['peak'],8*r.GIB);self.assertEqual(later['projectedAvailable'],-3*r.GIB)
        self.assertEqual(set(first),{'phase','used','available','retained','future','planned','peak','projectedAvailable','projectedUsage'})
        self.assertTrue(all(type(first[k]) is int for k in first if k!='phase'))
        with self.assertRaisesRegex(r.GateError,'B1_FILESYSTEM_CHANGED'):r.b1_capacity_gate(cap,used,available+1,0)
        with self.assertRaisesRegex(r.GateError,'B1_CAPACITY_INVALID'):r.b1_capacity_gate(cap,used,available,-1)
        r.disk_budget(used,available,500*1024**2,r.GIB,5*r.GIB,r.GIB)
        remote=types.SimpleNamespace(disk=lambda:(used,available))
        r.shipping_disk_gate(remote,r.shipping_resources(B1CapacityTests.DB),B1CapacityTests.ART)
        with self.assertRaisesRegex(r.GateError,'ARTIFACT_SIZE_INVALID'):r.disk_budget(used,available,0,1,1,1)
        with self.assertRaisesRegex(r.GateError,'SHIPPING_PG16_REQUIRED'):r.shipping_resources({'pgVersion':'15','dbBytes':1})
    def test_real_b2_path_capacity_shortfalls_continue_with_original_writer_order(self):
        for fault in ('capacity-6','capacity-10','capacity-90','no-shared'):
            with self.subTest(fault=fault):
                model,error=B2FormalPathTests().attempt(fault,capacity_waiver=True)
                self.assertIsNone(error);self.assertEqual(model.pointer,model.sha);self.assertEqual(model.phase,88)
                self.assertEqual(model.order.count('shared-proof'),2);self.assertFalse(model.lock)
                self.assertEqual(r.writer_names(model.containers()),[model.ename])
                self.assertTrue(any(x['waived'] for x in r.CAPACITY_TELEMETRY))
    def test_real_b2_noncapacity_failures_still_keep_old_writer_and_lock(self):
        for fault in ('cleanup-reader','released-proof','post-cleanup-ingest','post-cleanup-snapshot',
                      'shared-unknown','retained-unknown','wrong-e','r-interrupted','e-interrupted','df-unknown'):
            with self.subTest(fault=fault):
                model,error=B2FormalPathTests().attempt(fault,capacity_waiver=True)
                self.assertIsNotNone(error);self.assertNotIn('stop-old',model.order)
                self.assertTrue(model.old['State']['Running']);self.assertTrue(model.lock)

class B2ArchiveReleaseTests(unittest.TestCase):
    def test_unrelated_writes_after_exact_release_use_real_capacity(self):
        model,error=B2FormalPathTests().attempt('unrelated-writes')
        self.assertIsNone(error)
        cap=model.art['capacityLedger'];proof=cap['rArchiveRelease']
        self.assertTrue(proof['verified'])
        self.assertEqual(proof['source'],'b1_stage_cleanup_released_and_b1_storage')
        self.assertLess(proof['afterAvailable']-proof['beforeAvailable'],proof['allocated'])
        ready=next(x for x in cap['observations'] if x['phase']=='R_READY')
        self.assertEqual(ready['retained'],2177372160+64*1024**2)
        self.assertEqual(ready['available'],cap['baselineAvailable']-ready['retained'])
        self.assertEqual(ready['future'],r.RESERVE+r.shipping_resources(B1CapacityTests.DB)['walLimit'])
        self.assertEqual(model.phase,88);self.assertEqual(model.pointer,model.sha)
        after_cleanup=model.order[model.order.index('cleanup')+1:]
        self.assertEqual(after_cleanup[:3],['released','storage','fresh-df'])

    def test_real_capacity_shortfall_returns_exact_original_guard(self):
        for fault,code in [('capacity-6','B1_CAPACITY_6GIB'),
                           ('capacity-10','B1_CAPACITY_10GIB'),
                           ('capacity-90','B1_CAPACITY_90PCT')]:
            with self.subTest(fault=fault):
                model,error=B2FormalPathTests().attempt(fault)
                self.assertEqual(error,code)
                self.assertTrue(model.art['capacityLedger']['rArchiveRelease']['verified'])
                self.assertEqual(model.art['capacityLedger']['phase'],'R_READY')
                self.assertNotIn('shared-proof',model.order);self.assertNotIn('e-stream',model.order)
                self.assertNotIn('stop-old',model.order);self.assertTrue(model.old['State']['Running']);self.assertTrue(model.lock)

    def test_ownership_absence_reader_ingest_or_snapshot_unknown_blocks_capacity(self):
        for fault,code in [('cleanup-ownership','B1_ARCHIVE_UNVERIFIED'),
                           ('cleanup-reader','B1_ARCHIVE_UNVERIFIED'),
                           ('released-proof','B1_ARCHIVE_UNVERIFIED'),
                           ('post-cleanup-ingest','B1_IMPORT_UNKNOWN'),
                           ('post-cleanup-snapshot','B1_IMPORT_UNKNOWN')]:
            with self.subTest(fault=fault):
                model,error=B2FormalPathTests().attempt(fault)
                self.assertEqual(error,code);self.assertEqual(model.release_observations,0)
                self.assertNotIn('rArchiveRelease',model.art['capacityLedger'])
                self.assertNotIn('shared-proof',model.order);self.assertNotIn('e-stream',model.order)
                self.assertTrue(model.old['State']['Running']);self.assertTrue(model.lock)

    def test_unrelated_deletion_cannot_erase_historical_peak_or_baseline(self):
        model,error=B2FormalPathTests().attempt('unrelated-deletion')
        self.assertIsNone(error)
        cap=model.art['capacityLedger'];historical=cap['observations'][0]['peak']
        ready=next(x for x in cap['observations'] if x['phase']=='R_READY')
        self.assertLess(ready['used'],cap['baselineUsed'])
        self.assertGreater(ready['available'],cap['baselineAvailable'])
        self.assertEqual(cap['baselineAvailable'],15964217344)
        self.assertEqual(cap['peak'],historical);self.assertEqual(ready['peak'],historical)
        self.assertEqual(ready['projectedAvailable'],cap['baselineAvailable']-historical)
        self.assertTrue(all(x['peak']>=historical for x in cap['observations']))

    def test_fresh_df_unknown_is_not_misclassified_as_archive_failure(self):
        model,error=B2FormalPathTests().attempt('df-unknown')
        self.assertEqual(error,'COMMAND_UNAVAILABLE_OR_TIMEOUT')
        self.assertNotIn('shared-proof',model.order);self.assertNotIn('e-stream',model.order)
        self.assertTrue(model.old['State']['Running']);self.assertTrue(model.lock)

    def test_actual_released_helper_rejects_reappeared_archive_path(self):
        fixture=B1ArchiveTests()
        with tempfile.TemporaryDirectory() as d:
            root=Path(d).resolve();value,archive,_=fixture.fixture(root)
            proof=fixture.helper({**value,'action':'inspect'})
            fixture.helper({**value,**proof,'action':'cleanup'})
            archive.write_bytes(b'unexpected archive')
            with self.assertRaises(AssertionError):fixture.helper({**value,**proof,'action':'released'})
            self.assertTrue(archive.exists())

    def test_actual_cleanup_helper_rejects_reader_on_every_platform(self):
        import pwd
        fixture=B1ArchiveTests()
        with tempfile.TemporaryDirectory() as d:
            root=Path(d).resolve();value,archive,_=fixture.fixture(root)
            proof=fixture.helper({**value,'action':'inspect'})
            proc=root/'12345';(proc/'fd').mkdir(parents=True)
            (proc/'fd'/'7').symlink_to(archive);(proc/'maps').write_text('')
            original_iterdir=Path.iterdir
            def iterdir(path):return iter([proc]) if str(path)=='/proc' else original_iterdir(path)
            payload={**value,**proof,'action':'cleanup'}
            with patch('sys.stdin',io.StringIO(json.dumps(payload))),patch('sys.stdout',io.StringIO()),patch('pwd.getpwnam',return_value=types.SimpleNamespace(pw_uid=os.getuid())),patch.object(Path,'iterdir',iterdir):
                with self.assertRaises(AssertionError):exec(compile(r.B1_STAGE_CODE,'exact-archive-reader-proof','exec'),{})
            self.assertTrue(archive.exists());self.assertTrue((root/(value['release']+'.b1-owner')).exists())

class B2GuardTests(unittest.TestCase):
    def test_absence_unknown_is_not_absent(self):
        for response in ('{}','{"absent":false}','{"absent":1}','not json'):
            with self.subTest(response=response),self.assertRaises(r.GateError):
                r.b2_absent(types.SimpleNamespace(py=lambda *a:response),{'compatibility':{'imageReference':'r','release':C['rollbackSha'],'archiveConfigDigest':'config'}})
    def test_actual_absence_helper_tag_revision_and_exact_id(self):
        value={'tag':'r','release':C['rollbackSha'],'config':'sha256:'+'b'*64}
        for present in ('none','tag','revision','config','error'):
            def run(args,**kw):
                if present=='error':raise subprocess.CalledProcessError(1,args)
                match=('reference=' in args[-1] and present=='tag') or ('label=' in args[-1] and present=='revision') or (args[-1]=='--no-trunc' and present=='config')
                return (value['config'] if match else '').encode()
            output=io.StringIO()
            with patch('sys.stdin',io.StringIO(json.dumps(value))),patch('sys.stdout',output),patch('subprocess.check_output',side_effect=run):
                if present=='error':
                    with self.assertRaises(subprocess.CalledProcessError):exec(r.B2_ABSENT_CODE,{})
                else:
                    exec(r.B2_ABSENT_CODE,{});self.assertEqual(json.loads(output.getvalue())['absent'],present=='none')
    def test_b2_identity_ancestry_scope_payload_and_merge_are_exact(self):
        legacy=AdmissionTests().identity_git
        for fault in (None,'same-e','ancestor','merge','sixth','business'):
            def git(repo,*args):
                if args==('branch','--show-current'):return r.B2_BRANCH
                if args==('rev-list','--merges',r.B2_BASE+'..'+'a'*40):return 'b'*40 if fault=='merge' else ''
                if args[:1]==('log',):return 'server/v2.js' if fault=='sixth' else '\n'.join(sorted(r.B1_FILES))
                if args[:3]==('diff','--name-only',r.B2_BASE):return 'server/v2.js' if fault=='business' else ''
                if args==('rev-list','--parents','-n','1','a'*40):return 'a'*40+' '+r.B2_BASE
                return legacy(repo,*args)
            with patch.object(r,'git',side_effect=git),patch.object(r,'is_ancestor',return_value=fault!='ancestor'):
                if fault:
                    with self.assertRaises(r.GateError):r.validate_procurement_identity(ROOT,r.B2_BASE if fault=='same-e' else 'a'*40)
                else:r.validate_procurement_identity(ROOT,'a'*40)
    def test_real_shared_helper_preserves_owned_container_id_and_committed_parent(self):
        # Execute the actual helper against synthetic API/filesystem boundaries.
        # This checks ownership cleanup and credit proof, not a duplicate helper.
        import stat
        cid='c'*64;token='fixture';release='a'*40
        data={'a':b'layer-a','b':b'layer-b','config':b'config','manifest':b'manifest'}
        digests={k:'sha256:'+hashlib.sha256(v).hexdigest() for k,v in data.items()}
        layers=[{'chainId':name,'index':i,'diffId':name,'contentDigest':digests[name],
                 'expandedPhysicalBytes':16384,'blobBytes':len(data[name])} for i,name in enumerate(('a','b'))]
        value={'tag':'synthetic-r','imageId':digests['manifest'],'configDigest':digests['config'],
               'token':token,'release':release,'rLayers':layers,'eLayers':layers[:1]}
        for fault in (None,'parent','ownership'):
            events=[];output=io.StringIO()
            def run(args,**kw):
                self.assertTrue(all(isinstance(x,str) for x in args),'OWNED_CONTAINER_ID_WAS_REPLACED')
                events.append(args)
                if args[:2]==['docker','inspect']:
                    obj={'Id':digests['manifest']} if args[-1]=='synthetic-r' else {'Id':cid,'State':{'Pid':321,'Running':True},'Config':{'Labels':{'budu.b2-proof':'wrong' if fault=='ownership' else release}}}
                    return json.dumps([obj]).encode()
                if args[:2]==['docker','ps']:return b''
                if args[:2]==['docker','create']:return cid.encode()
                if args[:2] in (['docker','start'],['docker','rm']):return b''
                if args[-3:]==['content','list','--quiet']:return '\n'.join(digests.values()).encode()
                if args[-2]=='info':return json.dumps({'Kind':'Committed','Parent':'wrong' if fault=='parent' else '' if args[-1]=='a' else 'a'}).encode()
                if args[0]=='du':return b'4096 path'
                raise AssertionError(args)
            def info(path):
                number=int(str(path).split('/snapshots/')[1].split('/')[0]) if '/snapshots/' in str(path) else 9
                return types.SimpleNamespace(st_dev=1,st_ino=number,st_blocks=8,st_nlink=1,st_mode=stat.S_IFREG|0o600,st_size=7,st_mtime_ns=1,st_ctime_ns=1)
            def read(path,*args,**kw):
                self.assertEqual(str(path),'/proc/321/mountinfo')
                return '1 0 0:1 / / ro - overlay overlay ro,lowerdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/2/fs:/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/1/fs\n'
            def opened(path,*args,**kw):
                digest='sha256:'+path.name
                return io.BytesIO(next(v for k,v in data.items() if digests[k]==digest))
            with patch('sys.stdin',io.StringIO(json.dumps(value))),patch('sys.stdout',output),patch('subprocess.check_output',side_effect=run),patch.object(Path,'read_text',read),patch.object(Path,'stat',info),patch.object(Path,'lstat',info),patch.object(Path,'resolve',lambda p:p),patch.object(Path,'open',opened),patch('os.stat',side_effect=info),patch('os.lstat',side_effect=info),patch('os.walk',return_value=[('/var/lib/containerd',[],[])]):
                if fault:
                    with self.assertRaises(AssertionError):exec(compile(r.B2_SHARED_CODE,'b2-real-shared-helper','exec'),{})
                else:
                    exec(compile(r.B2_SHARED_CODE,'b2-real-shared-helper','exec'),{})
                    proof=json.loads(output.getvalue());self.assertTrue(proof['verified']);self.assertEqual(proof['creditedBytes'],8192+len(data['a']))
                    self.assertEqual(len(proof['ownedLayers']),2)
            removals=[a for a in events if a[:2]==['docker','rm']]
            self.assertEqual(removals,[] if fault=='ownership' else [['docker','rm','-f',cid]])
    def test_real_import_fixture_initializes_private_dind_without_production_adapter(self):
        source=(ROOT/'scripts/test-candidate-db-probe-integration.py').read_text()
        body=next(ast.get_source_segment(source,n) for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=='b1_import_ci')
        self.assertIn("'/usr/local/bin/dind' if b2 else 'sh'",body)
        self.assertIn("['--cgroupns=private'] if b2 else []",body)
        self.assertNotIn('--cgroupns=host',body)
        self.assertNotIn('apparmor=unconfined',body)
    def test_b2_preserves_b1_budget_and_shipping_resource_code(self):
        source=(ROOT/'scripts/deploy-prod-transfer-cas.py').read_text()
        base=subprocess.check_output(['git','-C',str(ROOT),'show',r.B2_BASE+':scripts/deploy-prod-transfer-cas.py'],text=True)
        def nodes(s):return {n.name:ast.get_source_segment(s,n) for n in ast.parse(s).body if isinstance(n,ast.FunctionDef)}
        for name in ('b1_capacity_gate','b1_db_gate','b1_envelope','shipping_resources','disk_budget','shipping_disk_gate','b1_deploy','rollback'):
            self.assertEqual(nodes(source)[name],nodes(base)[name],name)


class B2ArtifactReuseTests(unittest.TestCase):
    def test_native_tmpfs_result_is_read_in_running_namespace_and_validated_before_owned_cleanup(self):
        import re
        sha='a'*40;network='b2-purchase-'+sha[:12];pg=network+'-pg';candidate=network+'-runtime'
        ids=re.findall(r"await test\('([^']+)'",(ROOT/'scripts/test-purchase-receipt-native.mjs').read_text())
        native={'results':[{'id':name,'status':'PASS'} for name in ids],
                'raceEvidence':[{'label':'real-row-lock','waiting':2}],'externalAttempts':[]}
        calls=[]
        def docker(*args,**kwargs):
            calls.append(args)
            if args[:2]==('image','inspect'):
                return json.dumps([{'Id':'exact-image','Config':{'User':'node','Labels':{_CI.release.REVISION:sha}}}])
            if args[:2]==('network','create'):return 'owned-network'
            if args[:2]==('network','inspect'):
                return json.dumps([{'Id':'owned-network','Internal':True,'Labels':{'budu.b2-purchase':sha}}])
            if args[0]=='run':return 'owned-pg'
            if args[0]=='create':return 'owned-runtime'
            if args[:3]==('exec',pg,'psql'):
                self.assertEqual(args[args.index('-d')+1],'postgres')
                return '160014' if args[-1]=='SHOW server_version_num' else '0'
            if args[0]=='inspect':
                return json.dumps([{'Id':'owned-pg' if args[1]==pg else 'owned-runtime','Config':{'Labels':{'budu.b2-purchase':sha}}}])
            return ''
        def read_result(args,**kwargs):
            self.assertEqual(args,['docker','exec',candidate,'cat','/app/output/purchase-receipt/native-results.json'])
            self.assertIn(('start',candidate),calls)
            self.assertFalse(any(row[0]=='rm' for row in calls))
            return json.dumps(native).encode()
        with tempfile.TemporaryDirectory() as td,patch.dict(os.environ,{'GITHUB_REF':'refs/heads/'+_CI.release.B2_BRANCH,'GITHUB_SHA':sha,'RUNNER_TEMP':td}),\
                patch.object(_CI,'procurement_controller_ci_guard'),patch.object(_CI,'docker',side_effect=docker),\
                patch.object(_CI.subprocess,'run',return_value=types.SimpleNamespace(returncode=0,stdout='',stderr='')),\
                patch.object(_CI.subprocess,'check_output',side_effect=read_result) as reader,contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(_CI.b2_purchase_runtime_ci('exact-tag',sha)['nativeCases'],len(ids))
            reader.assert_called_once()
        self.assertIn(('rm','-f','-v','owned-runtime'),calls)
        self.assertIn(('rm','-f','-v','owned-pg'),calls)
        self.assertIn(('network','rm','owned-network'),calls)

    def test_native_runtime_proof_requires_full_suite_pg16_14_real_lock_barriers_and_cleanup(self):
        import re
        ids=re.findall(r"await test\('([^']+)'",(ROOT/'scripts/test-purchase-receipt-native.mjs').read_text())
        native={'results':[{'id':name,'status':'PASS'} for name in ids],
                'raceEvidence':[{'label':'real-row-lock','waiting':2}],'externalAttempts':[]}
        proof=_CI.b2_validate_purchase_runtime(native,'160014','0')
        self.assertEqual(proof['nativeCases'],len(ids));self.assertEqual(proof['legacyRetirement'],'PASS')
        for fault in ('missing','missing-retirement','duplicate','failed','external','no-race','unblocked','pg-version','database-remains'):
            value=copy.deepcopy(native);version='160014';leftovers='0'
            if fault=='missing':value['results'].pop()
            elif fault=='missing-retirement':value['results']=[row for row in value['results'] if row['id']!='C06']
            elif fault=='duplicate':value['results'].append(value['results'][0])
            elif fault=='failed':value['results'][0]['status']='FAIL'
            elif fault=='external':value['externalAttempts']=[{'origin':'https://denied.invalid'}]
            elif fault=='no-race':value['raceEvidence']=[]
            elif fault=='unblocked':value['raceEvidence'][0]['waiting']=1
            elif fault=='pg-version':version='160013'
            else:leftovers='1'
            with self.subTest(fault=fault),self.assertRaisesRegex(RuntimeError,'B2_PURCHASE_RUNTIME_PROOF_INVALID'):
                _CI.b2_validate_purchase_runtime(value,version,leftovers)
    def test_truncated_fault_requires_residual_ingest_rejection_and_is_terminal(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as td,patch.dict(os.environ,{'RUNNER_TEMP':td}):
            archive=Path(td)/'image.tar';archive.write_bytes(b'x'*70000)
            for fault in ('residual','clear','failed-open','dirty-baseline','ended','not-active','wrong-transport'):
                ref='b2-owned-ingest-'+'12'*8
                remote=types.SimpleNamespace(run=Mock(side_effect=[b'REF SIZE AGE\n'+(b'owned 1 1s\n' if fault=='dirty-baseline' else b''),
                    b'REF SIZE AGE\n'+(b'owned 1 1s\n' if fault!='clear' else b''),
                    *([b'REF SIZE AGE\n'+(ref+' 4096 1s\n').encode()] if fault!='not-active' else [b'REF SIZE AGE\n']*50)]),
                    ssh=['docker','exec','-i','owned-fixture','sh','-c'] if fault!='wrong-transport' else ['ssh','denied'])
                stream=Mock(side_effect=_CI.release.GateError('B2_IMPORT_UNKNOWN'))
                storage=Mock(side_effect=None if fault=='failed-open' else _CI.release.GateError('B1_IMPORT_UNKNOWN'))
                writer=Mock();writer.poll.return_value=0 if fault=='ended' else None
                with self.subTest(fault=fault),patch.object(_CI.release,'b2_stream',stream),patch.object(_CI.release,'b1_storage',storage),\
                        patch.object(_CI.subprocess,'Popen',return_value=writer) as popen,\
                        patch.object(_CI.os,'urandom',return_value=b'\x12'*8),patch.object(_CI.time,'sleep'):
                    if fault not in ('residual','clear'):
                        with self.assertRaisesRegex(RuntimeError,'B2_RESIDUAL_INGEST_NOT_REJECTED|B2_FAULT_BASELINE_INGEST_NOT_CLEAR|B2_OWNED_INGEST_'):
                            _CI.b2_truncated_stream_ci(remote,archive,{})
                    else:
                        result=_CI.b2_truncated_stream_ci(remote,archive,{})
                        self.assertTrue(result['truncatedStreamRejected'])
                        self.assertTrue(result['residualIngestRejected'])
                        self.assertTrue(result['heldOwnedIngestGuardVerified'])
                        self.assertEqual(storage.call_count,1)
                        self.assertIn(ref,popen.call_args[0][0][-1])
                    if fault not in ('dirty-baseline','wrong-transport'):
                        writer.stdin.close.assert_called_once();writer.wait.assert_called_once_with(timeout=10)
        body=ast.get_source_segment((ROOT/'scripts/test-candidate-db-probe-integration.py').read_text(),
            next(n for n in ast.parse((ROOT/'scripts/test-candidate-db-probe-integration.py').read_text()).body
                 if isinstance(n,ast.FunctionDef) and n.name=='b2_owned_import_steps'))
        after=body.split('terminal_fault=b2_truncated_stream_ci',1)[1]
        for token in ('b1_storage(','b1_db_gate(','b2_barrier(','content\',\'delete'):self.assertNotIn(token,after)
    def test_exact_source_context_matches_official_umask_without_losing_executable_bits(self):
        import tarfile
        data=io.BytesIO()
        with tarfile.open(fileobj=data,mode='w') as archive:
            directory=tarfile.TarInfo('bin');directory.type=tarfile.DIRTYPE;directory.mode=0o775;archive.addfile(directory)
            for name,mode in [('package.json',0o664),('bin/executable',0o775)]:
                member=tarfile.TarInfo(name);member.mode=mode;member.size=5;archive.addfile(member,io.BytesIO(b'exact'))
        data.seek(0)
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);_CI.b2_source_from_tar(data,root)
            for name,mode in [('package.json',0o644),('bin',0o755),('bin/executable',0o755)]:
                self.assertEqual((root/name).stat().st_mode&0o777,mode)
            self.assertEqual((root/'package.json').read_bytes(),b'exact')
            self.assertEqual((root/'bin/executable').read_bytes(),b'exact')
    def test_random_fixture_image_names_with_underscores_are_valid_docker_repositories(self):
        for name in ('b1-dind-b1-import-_cxb2x8j','b1-dind-b1-import-a__b_', 'b2-model-_abc_123'):
            tag=_CI.ci_fixture_image_tag(name)
            self.assertRegex(tag,r'^[a-z0-9]+(?:-+[a-z0-9]+)*:fixture$')
            self.assertNotIn('_',tag)
        for name in ('/tmp/b1-import-abcd','unknown','b2-model-ABCD'):
            with self.assertRaisesRegex(RuntimeError,'CI_FIXTURE_IMAGE_NAME_INVALID'): _CI.ci_fixture_image_tag(name)
    def test_fixed_r_oci_keeps_exact_compressed_blobs_and_rejects_identity_drift(self):
        import tarfile,gzip
        layer=gzip.compress(b'exact R layer',mtime=0);blob=r.digest(layer)
        config=b'fixed R config';config_digest='sha256:'+r.digest(config)
        manifest=json.dumps({'config':{'digest':config_digest},'layers':[{'digest':'sha256:'+blob}]}).encode()
        manifest_digest='sha256:'+r.digest(manifest)
        files={'blobs/sha256/'+blob:layer,'blobs/sha256/'+r.digest(config):config,
               'blobs/sha256/'+r.digest(manifest):manifest,
               'index.json':json.dumps({'manifests':[{'digest':manifest_digest}]}).encode(),
               'oci-layout':b'{"imageLayoutVersion":"1.0.0"}'}
        fixed={'archiveConfigDigest':config_digest,'layers':[{'contentDigest':'sha256:'+blob}]}
        for fault in (None,'config','layer','corrupt-blob'):
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as td:
                root=Path(td);archive=root/'R.tar';bad=copy.deepcopy(fixed)
                if fault=='config':bad['archiveConfigDigest']='sha256:'+'0'*64
                if fault=='layer':bad['layers'][0]['contentDigest']='sha256:'+'0'*64
                with tarfile.open(archive,mode='w') as out:
                    for name,value in files.items():
                        if fault=='corrupt-blob' and name=='blobs/sha256/'+blob:value=b'corrupt'
                        member=tarfile.TarInfo(name);member.size=len(value);out.addfile(member,io.BytesIO(value))
                if fault:
                    with self.assertRaisesRegex(RuntimeError,'B2_FIXED_R_OCI_'): _CI.b2_fixed_r_oci(archive,root/'layout',bad)
                else:
                    context=_CI.b2_fixed_r_oci(archive,root/'layout',fixed)
                    self.assertEqual(context,'oci-layout://'+str(root/'layout')+'@'+manifest_digest)
                    self.assertEqual((root/'layout/blobs/sha256'/blob).read_bytes(),layer)
    def test_final_manifests_reject_stale_missing_content_type_mode_and_owner(self):
        original={'app/server/v2.js':{'type':'file','size':3,'sha256':'abc','mode':0o644,'uid':1000,'gid':1000},
                  'app/scripts/tool':{'type':'symlink','target':'real','mode':0o777,'uid':0,'gid':0}}
        self.assertTrue(_CI.b2_compare_manifests(original,copy.deepcopy(original))['verified'])
        for fault in ('extra','missing','size','sha256','mode','uid','gid','type','target'):
            candidate=copy.deepcopy(original)
            if fault=='extra':candidate['app/server/obsolete.js']=candidate['app/server/v2.js']
            elif fault=='missing':candidate.pop('app/server/v2.js')
            elif fault=='target':candidate['app/scripts/tool']['target']='wrong'
            else:candidate['app/server/v2.js'][fault]='wrong'
            with self.subTest(fault=fault):self.assertFalse(_CI.b2_compare_manifests(original,candidate)['verified'])
    def archive(self,root,mode):
        import tarfile
        code=b'current v2';script=b'current script'
        (root/'server').mkdir();(root/'server/v2.js').write_bytes(code)
        expected={'app/server/v2.js':r.digest(code),'app/scripts/current.py':r.digest(script)}
        layers=[]
        rows=[{'app/server/v2.js':b'old v2','app/scripts/obsolete.py':b'old'},
              {'app/.wh.server':b'','app/.wh.scripts':b'x' if mode=='invalid-whiteout' else b''},
              {'app/server/v2.js':code,'app/scripts/current.py':script}]
        if mode=='stale':rows[1].pop('app/.wh.scripts')
        if mode=='missing':rows[2].pop('app/scripts/current.py')
        for row in rows:
            out=io.BytesIO()
            with tarfile.open(fileobj=out,mode='w') as archive:
                for name,value in row.items():
                    member=tarfile.TarInfo(name);member.size=len(value);member.mode=0o644
                    archive.addfile(member,io.BytesIO(value))
            layers.append(out.getvalue())
        sha='a'*40;config=json.dumps({'os':'linux','architecture':'amd64','config':{'Labels':{r.REVISION:sha}},
            'rootfs':{'diff_ids':['sha256:'+r.digest(x) for x in layers]}}).encode()
        files={'config.json':config,'manifest.json':json.dumps([{'Config':'config.json','RepoTags':[r.image_reference(sha)],
            'Layers':['layer'+str(i)+'.tar' for i in range(len(layers))]}]).encode()}
        files.update({'layer'+str(i)+'.tar':x for i,x in enumerate(layers)})
        path=root/'image.tar'
        with tarfile.open(path,mode='w') as archive:
            for name,value in files.items():
                member=tarfile.TarInfo(name);member.size=len(value);archive.addfile(member,io.BytesIO(value))
        return path,sha,expected
    def test_actual_archive_validation_merges_b2_deletions_and_remains_fail_closed(self):
        for mode,error in [('correct',None),('stale','EXTRA_STALE_RUNTIME_FILE'),
                           ('missing','ARTIFACT_RUNTIME_PAYLOAD_MISMATCH'),('invalid-whiteout','B2_WHITEOUT_INVALID')]:
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);path,sha,expected=self.archive(root,mode)
                with patch.object(r,'B2_IDENTITY',True),patch.object(r,'runtime_payload',return_value=expected),patch.object(r,'migration_enabled',return_value=False):
                    if error:
                        with self.assertRaisesRegex(r.GateError,error):r.artifact(path,sha,root)
                    else:self.assertEqual(r.artifact(path,sha,root)['runtimeHash'],expected['app/server/v2.js'])
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);path,sha,expected=self.archive(root,'correct')
            with patch.object(r,'B2_IDENTITY',False),patch.object(r,'runtime_payload',return_value=expected),patch.object(r,'migration_enabled',return_value=False):
                with self.assertRaises(r.GateError):r.artifact(path,sha,root)
    def test_reuse_builder_preserves_dependencies_and_replaces_all_payload_roots(self):
        body=ast.get_source_segment((ROOT/'scripts/test-candidate-db-probe-integration.py').read_text(),
            next(n for n in ast.parse((ROOT/'scripts/test-candidate-db-probe-integration.py').read_text()).body
                 if isinstance(n,ast.FunctionDef) and n.name=='b2_build_reusing_r_ci'))
        for token in ('--cache-from','rsha+\':\'+path','B2_EXACT_R_BASE_LAYER_PREFIX_REQUIRED','npx prisma generate','b2_compare_images','b1_import_ci'):
            self.assertIn(token,body)
        for path in ('dist','server','brand/web','shared','src/utils','prisma','scripts'):self.assertIn('/app/'+path,body)
        derived=body.split("derived.write_text(",1)[1].split("final=root/",1)[0]
        self.assertNotIn('npm ci',derived)
        self.assertIn('USER root',derived);self.assertIn('USER node',derived)


class BlueGreenLifecycleTests(unittest.TestCase):
    def test_background_groups_standby_default_promotion_and_failure(self):
        # Execute the real index lifecycle with enabled provider adapters; none
        # of these adapters contacts a provider or production.
        script=r'''const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
const source=fs.readFileSync(process.argv[1],'utf8').split('\n').filter(x=>!x.startsWith('import ')).join('\n');
async function attempt(mode,fault=false){const calls=[],logs=[],handlers={},runtime={state:mode??'active',appTasksStarted:0,processTasksStarted:0};let exit;
const context={process:{env:{...(mode===undefined?{}:{BUDU_RUNTIME_MODE:mode}),GIT_SHA:'a'.repeat(40)},on:(s,f)=>handlers[s]=f,exit:c=>{exit=c}},console:{log:x=>logs.push(x),error:x=>logs.push(x)},APP_ENV:'prod',APP_VERSION:'test',GIT_SHA:'a'.repeat(40),prisma:{},Sentry:{},paymentService:{},
validateConfig:()=>{},loadOnlineCheckoutConfig:()=>({}),createOnlineCheckoutRuntime:()=>({start:()=>{calls.push('online');if(fault)throw Error('FAULT')}}),
wechatPayStatus:()=>({enabled:true}),alipayStatus:()=>({enabled:true}),providerReconcilerEnvConfig:()=>({}),refundReconcilerEnvConfig:()=>({}),startProviderReconciler:p=>calls.push(p),startProviderRefundReconciler:()=>calls.push('refund'),
createApp:()=>{runtime.startAppStartupTasks=async()=>{runtime.appTasksStarted++;calls.push('app')};return {locals:{buduRuntime:runtime},listen:(_p,_h,f)=>f()}}};vm.runInNewContext(source,context);
if(mode===undefined){assert.deepEqual(calls,['online','wechat_pay','alipay','refund']);assert.equal(handlers.SIGUSR2,undefined);return}
assert.deepEqual(calls,[]);assert(logs.some(x=>x.includes('BUDU_RUNTIME_STANDBY_READY')));
handlers.SIGUSR2();await new Promise(r=>setImmediate(r));
if(fault){assert.equal(exit,1);assert.equal(runtime.state,'failed');assert(logs.some(x=>x.includes('BUDU_RUNTIME_PROMOTION_FAILED')));assert(!logs.some(x=>x.includes('BUDU_RUNTIME_PROMOTION_COMPLETE')));return}
assert.deepEqual(calls,['app','online','wechat_pay','alipay','refund']);assert.equal(runtime.state,'active');assert.equal(runtime.processTasksStarted,1);handlers.SIGUSR2();await new Promise(r=>setImmediate(r));assert.equal(calls.length,5);assert.equal(runtime.appTasksStarted,1);assert(logs.some(x=>x.includes('BUDU_RUNTIME_ALREADY_ACTIVE')))}
(async()=>{await attempt();await attempt('standby');await attempt('standby',true);console.log('BG_BACKGROUND_LIFECYCLE_PASS')})().catch(()=>process.exit(1));'''
        output=subprocess.check_output(['node','-e',script,str(ROOT/'server/index.js')],stderr=subprocess.DEVNULL,timeout=30)
        self.assertEqual(output,b'BG_BACKGROUND_LIFECYCLE_PASS\n')

class BlueGreenControllerTests(unittest.TestCase):
    def attempt(self,fault=None,hotfix=False,hotfix_base=None):
        base=(hotfix_base or r.BG_HOTFIX_BASE) if hotfix else C['rollbackSha']
        r.configure_profile('post-transfer',base,base if hotfix else C['businessSha'],'0'*64);r.BG_ACTIVE=True
        r.configure_capacity_waiver({'releaseSha':'a'*40,'parentSha':r.bg_release_base()},{'release':'a'*40,'capacityProfile':'B2'},emit=False)
        events=[];route=['G'];running={'G':True,'E':False};promoted=[False];dbcount=[88 if hotfix else 87]
        g={'Id':'g'*64,'Image':'sha256:'+'b'*64,'State':{'Running':True},'HostConfig':{'NetworkMode':'n'}}
        live={'LIVE_G_CONTAINER':'G','LIVE_G_CONTAINER_ID':g['Id'],'LIVE_G_IMAGE_ID':g['Image'],'LIVE_G_SHA':base,'POINTER_SHA':base if hotfix else C['oldSha']}
        template=' '.join(['proxy_pass http://G:3000;']*3)
        art={'release':'a'*40,'capacityProfile':'B2','config':{},'runtimeHash':'h','imageReference':'image','archive':100,'blobs':200,'expanded':300,'largest':100}
        proof={'result':'PASS','oldRuntimeExactSource':C['rollbackSha'],'additiveMigrationSqlHash':C['sqlHash'],'oldPrismaDb88':'PASS','oldInternalHealthDb88':'PASS','pgVersion':'16.14'}
        v={'art':art,'live':live,'ledger':LEDGER,'template':template,'active':template,'compatibilityProof':proof,'migrationSql':(ROOT/'prisma/migrations'/C['migration']/'migration.sql').read_text()}
        def event(e):
            events.append(e)
            if e==fault:raise r.GateError('BG_INJECTED_FAILURE')
        class Remote:
            def inspect(self,name,image=False):
                if image:return {'Id':g['Image']}
                if name in ('G',g['Id']):return dict(g,State={'Running':running['G']})
                return {'Id':'e'*64,'State':{'Running':running['E']}}
            def run(self,args,**kw):
                if args[:2]==['docker','stop']:event('stopG');running['G']=False
                if args[:2]==['docker','start']:event('restartG');running['G']=True
                if 'BG_PROCUREMENT_SCHEMA_OK' in str(args):event('schemaProbe');return b'BG_PROCUREMENT_SCHEMA_OK\n'
                if args[:1]==['cat']:return (art['release']+'\n').encode()
                return b''
            def py(self,*args,**kw):return b''
            def health(self,name,sha,public=False):event('publicE' if public and name=='E' else 'health')
            def routes(self):return (' '.join(['proxy_pass http://'+route[0]+':3000;']*3),)*2
            def db(self):return {'applied':dbcount[0]}
        remote=Remote()
        def gguard(*args):event('Gguard');self.assertTrue(running['G']);return g,{'dbBytes':1,'pgVersion':'16.14'}
        def clone(*args):event('createE');state=args[2];state.update(candidate='E',candidateId='e'*64,candidateAttempted=True);running['E']=True
        def lifecycle(*args):
            mode=args[-1];event('standby' if mode=='standby' else 'active');self.assertTrue(running['E']);self.assertEqual(promoted[0],mode=='active');return {}
        def writer(*args):
            names=args[3];event('zero' if names==[] else 'writer');actual=['G'] if running['G'] else []
            if running['E'] and promoted[0]:actual.append('E')
            self.assertEqual(sorted(actual),sorted(names));return {}
        def promote(*args):event('promote');self.assertFalse(running['G']);self.assertTrue(args[2]['standbyVerified']);promoted[0]=True
        def ownedstop(*args):event('stopE');running['E']=False
        def routes(*args):event('routeE' if 'http://E:' in args[1] else 'routeG');route[0]='E' if 'http://E:' in args[1] else 'G'
        def pointer(*args):event('pointerE' if args[2].strip()==art['release'] else 'pointerG')
        def script(remote,code,value,*args,**kw):
            if code==r.BG_EVIDENCE_CODE:event('evidence');return {'result':'PASS'}
            if code==r.BG_PROBE_CODE:event('probe');return {'result':'PASS','terminated':True}
            if code==r.BG_SNAPSHOT_CODE:
                self.assertFalse(hotfix,'hotfix must not backup/restore');event('backup');return dict(result='PASS',**{k:True for k in ('backupTerminationVerified','exporterTerminated','dumpTerminated','restoreStopped','restoreProcessTerminated','restoreVerified')},sourceSnapshotFingerprint='x',restoredFingerprint='x',pgVersion='16.14')
            if code==r.BG_ATOMIC_MIGRATION_CODE:self.assertFalse(hotfix,'hotfix must not migrate');event('migration');dbcount[0]=88;return {'result':'PASS','terminated':True}
            raise AssertionError('unknown helper')
        def lock(*args):event('lock-'+args[2]);return {}
        patches={'bg_g_guard':gguard,'validate_clone_source':lambda *a:None,'b1_storage':lambda *a:True,'bg_lock':lock,'shipping_resources':lambda *a:{'walLimit':1,'migratorLimit':1},'bg_capacity':lambda remote,art,*a:art.setdefault('capacityLedger',{'baselineCommitted':[]}),'resolve_loaded_image':lambda *a:{'Id':'sha256:'+'c'*64},'b2_barrier':lambda *a:True,'bg_script':script,'bg_clone':clone,'bg_lifecycle':lifecycle,'mount_readability':lambda *a:[],'runtime_checks':lambda *a:event('runtime'),'application_db_probe':lambda *a:event('dbProbe'),'bg_writer':writer,'bg_promote':promote,'replace_routes':routes,'write_authority':pointer,'bg_owned_stop':ownedstop,'bg_recover_g':lambda *a:event('recoverGActive')}
        with contextlib.ExitStack() as stack:
            for name,fn in patches.items():stack.enter_context(patch.object(r,name,side_effect=fn))
            result=r.bg_execute(remote,v,lambda root:{'serverSha256BeforeImport':True})
        r.BG_ACTIVE=False
        return result,events,running,route
    def test_success_exact_handover_order(self):
        result,e,run,route=self.attempt();self.assertEqual(result['result'],'DEPLOY_COMPLETE');self.assertTrue(result['releaseLockReleased'])
        self.assertLess(e.index('standby'),e.index('stopG'));self.assertLess(e.index('stopG'),e.index('zero'));self.assertLess(e.index('zero'),e.index('promote'));self.assertLess(e.index('promote'),e.index('routeE'));self.assertLess(e.index('publicE'),e.index('pointerE'));self.assertEqual(run,{'G':False,'E':True})
    def test_pre_handover_failures_preserve_live_G(self):
        for fault in ('probe','backup','migration','standby','runtime','dbProbe','schemaProbe'):
            with self.subTest(fault=fault):
                result,e,run,route=self.attempt(fault);self.assertEqual(result['code'],'BG_INJECTED_FAILURE');self.assertNotIn('stopG',e);self.assertNotIn('promote',e);self.assertTrue(run['G']);self.assertFalse(run['E']);self.assertEqual(route,['G'])
    def test_promotion_and_cutover_failure_stop_E_before_G_restart(self):
        for fault in ('promote','routeE','publicE','evidence'):
            with self.subTest(fault=fault):
                result,e,run,route=self.attempt(fault);self.assertEqual(result['rootFailure']['code'],'BG_INJECTED_FAILURE');self.assertNotIn('secondaryRecoveryCode',result);self.assertLess(e.index('stopE'),e.index('restartG'));self.assertTrue(run['G']);self.assertFalse(run['E']);self.assertEqual(route,['G'])
    def test_E_only_source_contains_no_R_lifecycle(self):
        for fn in (r.bg_deploy,r.bg_execute,r.bg_import,r.bg_clone,r.bg_owned_stop):
            node=next(n for n in ast.parse((ROOT/'scripts/deploy-prod-transfer-cas.py').read_text()).body if isinstance(n,ast.FunctionDef) and n.name==fn.__name__)
            source=ast.get_source_segment((ROOT/'scripts/deploy-prod-transfer-cas.py').read_text(),node)
            for forbidden in ('compatibility_artifact(','b1_fixed_r(','b2_absent(','procurement_rollback(','docker image rm','docker volume','prune'):
                self.assertNotIn(forbidden,source)
    def test_exact_waiver_and_physical_guards(self):
        r.configure_profile('post-transfer',C['rollbackSha'],C['businessSha'],'0'*64);r.BG_ACTIVE=True
        art={'release':'a'*40,'capacityProfile':'B2'};receipt={'releaseSha':'a'*40,'parentSha':r.BG_BASE}
        r.configure_capacity_waiver(receipt,art,emit=False)
        ledger={'baselineUsed':100*r.GIB,'baselineAvailable':r.GIB,'phase':'BG'}
        r.b1_capacity_gate(ledger,100*r.GIB,r.GIB,20*r.GIB)
        for code in ('BG_ENOSPC','BG_EIO','MIGRATION_LEDGER_INVALID','WRITER_COUNT_INVALID','HEALTH_FAILED','B2_IMPORT_UNKNOWN','B1_FILESYSTEM_CHANGED'):
            with self.subTest(code=code),self.assertRaises(r.GateError):r.capacity_require(False,code,{})
        for key,bad in [('releaseSha','b'*40),('parentSha',r.B2_CAPACITY_WAIVER_PARENT)]:
            with self.subTest(key=key),self.assertRaises(r.GateError):r.configure_capacity_waiver(dict(receipt,**{key:bad}),art)
        r.BG_ACTIVE=False
    def test_standby_does_not_hide_its_DB_sessions_or_other_containers(self):
        r.configure_profile('post-transfer',C['rollbackSha'],C['businessSha'],'0'*64)
        rows=[{'Name':'/G','Id':'g','Config':{'Env':['DATABASE_URL=postgresql://x/budu_bj006']},'NetworkSettings':{'Networks':{'n':{'IPAddress':'1.1.1.1'}}}},{'Name':'/E','Id':'e','Config':{'Env':['DATABASE_URL=postgresql://x/budu_bj006']},'NetworkSettings':{'Networks':{'n':{'IPAddress':'1.1.1.2'}}}}]
        class Remote:
            def containers(self):return rows
            def db(self):return {'clients':['1.1.1.2']}
        state={'candidateId':'e','phase':88};v={'live':{},'ledger':LEDGER}
        with patch.object(r,'bg_lifecycle',return_value={'Id':'e'}),patch.object(r,'validate_database'):
            with self.assertRaisesRegex(r.GateError,'UNKNOWN_DB_CLIENT_OR_OLD_WRITER'):r.bg_writer(Remote(),v,state,['G'],True)
        self.assertEqual(r.writer_names(rows),['G','E'])



class ProcurementPurposeHotfixTests(unittest.TestCase):
    attempt=BlueGreenControllerTests.attempt
    def setUp(self):
        r.configure_profile('post-transfer',r.BG_HOTFIX_BASE,r.BG_HOTFIX_BASE,'0'*64);r.BG_ACTIVE=True
    def tearDown(self):r.BG_ACTIVE=False
    def test_hotfix_success_skips_backup_restore_migration_and_keeps_handover(self):
        result,e,run,route=self.attempt(hotfix=True)
        self.assertEqual(result['result'],'DEPLOY_COMPLETE');self.assertEqual(result['dbApplied'],88)
        self.assertEqual(result['backupProof']['result'],'NOT_REQUIRED_NO_SCHEMA_CHANGE')
        self.assertEqual(result['migrationProof']['result'],'NOT_REQUIRED_DB_ALREADY_88')
        for forbidden in ('backup','migration'):self.assertNotIn(forbidden,e)
        self.assertLess(e.index('schemaProbe'),e.index('stopG'));self.assertLess(e.index('stopG'),e.index('zero'))
        self.assertLess(e.index('zero'),e.index('promote'));self.assertLess(e.index('publicE'),e.index('pointerE'))
        self.assertEqual(run,{'G':False,'E':True});self.assertEqual(route,['E']);self.assertTrue(result['releaseLockReleased'])
    def test_hotfix_failure_recovers_same_G_lifecycle_before_route(self):
        for fault in ('probe','standby','schemaProbe','promote','routeE','publicE','evidence'):
            result,e,run,route=self.attempt(fault,hotfix=True)
            self.assertEqual(result['code'],'BG_INJECTED_FAILURE');self.assertNotIn('secondaryRecoveryCode',result)
            self.assertEqual(run,{'G':True,'E':False});self.assertEqual(route,['G'])
            if 'stopG' in e:
                self.assertLess(e.index('stopE'),e.index('restartG'));self.assertLess(e.index('restartG'),e.index('recoverGActive'))
                self.assertLess(e.index('recoverGActive'),e.index('routeG'))
            else:self.assertNotIn('recoverGActive',e)
            self.assertNotIn('migration',e);self.assertNotIn('backup',e)
    def test_exact_db88_schema_checksums_and_no_migration(self):
        self.assertTrue(r.procurement_hotfix());self.assertFalse(r.migration_enabled());self.assertEqual(r.before_ledger(LEDGER),LEDGER)
        db={'database':r.EXPECTED_DB,'applied':88,'failed':0,'rolledBack':0,'ledger':LEDGER,'procurementSchema':{'schemaMd5':C['schemaMd5']}}
        r.validate_database(db,LEDGER)
        for key,bad in [('applied',87),('failed',1),('rolledBack',1),('database','other'),('ledger',{})]:
            with self.subTest(key=key),self.assertRaises(r.GateError):r.validate_database(dict(db,**{key:bad}),LEDGER)
        with self.assertRaises(r.GateError):r.validate_database(dict(db,procurementSchema={'schemaMd5':'wrong'}),LEDGER)
    def test_hotfix_waiver_exact_binding_and_other_guards_fail_closed(self):
        art={'release':'a'*40,'capacityProfile':'B2'};receipt={'releaseSha':'a'*40,'parentSha':r.BG_HOTFIX_BASE}
        r.configure_capacity_waiver(receipt,art,emit=False)
        r.b1_capacity_gate({'baselineUsed':100*r.GIB,'baselineAvailable':r.GIB,'phase':'HOTFIX'},100*r.GIB,r.GIB,20*r.GIB)
        self.assertTrue(any(x['waived'] for x in r.CAPACITY_TELEMETRY))
        for code in ('BG_ENOSPC','BG_EIO','B2_IMPORT_UNKNOWN','B1_FILESYSTEM_CHANGED','MIGRATION_LEDGER_INVALID','WRITER_COUNT_INVALID','HEALTH_FAILED','BG_LIFECYCLE_FAILED'):
            with self.subTest(code=code),self.assertRaises(r.GateError):r.capacity_require(False,code,{})
        for key,bad in [('releaseSha','b'*40),('parentSha',r.BG_BASE)]:
            with self.assertRaises(r.GateError):r.configure_capacity_waiver(dict(receipt,**{key:bad}),art)
        r.BG_ACTIVE=False
        with self.assertRaises(r.GateError):r.configure_capacity_waiver(receipt,art)
    def test_exact_hotfix_parent_and_business_file_scope(self):
        release='a'*40
        def git(repo,*args):
            if args==('branch','--show-current'):return r.B2_BRANCH
            if args[0]=='rev-list':return release+' '+r.BG_HOTFIX_BASE
            if args[0]=='diff' and args[-1]=='prisma':return ''
            if args[0]=='diff' and '--' in args:return 'server/purchase-receipt.js'
            return '\n'.join(sorted(r.BG_HOTFIX_FILES))
        with patch.object(r,'git',side_effect=git):r.validate_procurement_identity(ROOT,release)
        failures=[(('rev-list','--parents','-n','1',release),release+' '+r.BG_BASE),
                  (('diff','--name-only',r.BG_HOTFIX_BASE,release),'server/other.js'),
                  (('branch','--show-current'),'wrong')]
        for key,bad in failures:
            with self.assertRaises(r.GateError),patch.object(r,'git',side_effect=lambda repo,*args:bad if args==key else git(repo,*args)):
                r.validate_procurement_identity(ROOT,release)
    def test_recovery_promotes_qualified_exact_G_with_new_start_markers(self):
        c={'Id':'g'*64,'Image':'sha256:'+'b'*64,'Config':{'Image':'exact-G','Env':['GIT_SHA='+r.BG_HOTFIX_BASE,'BUDU_RUNTIME_MODE=standby'],'Labels':{r.REVISION:r.BG_HOTFIX_BASE}},'State':{'Running':True,'StartedAt':'2026-10-06T00:00:00Z'}}
        live={'LIVE_G_CONTAINER':'G','LIVE_G_CONTAINER_ID':c['Id'],'LIVE_G_IMAGE_ID':c['Image'],'LIVE_G_SHA':r.BG_HOTFIX_BASE}
        events=[]
        class Remote:
            def inspect(self,*a):return c
        def lifecycle(remote,value,state,mode):
            events.append(mode);self.assertEqual(value['art']['release'],r.BG_HOTFIX_BASE);self.assertEqual(state['lifecycleSince'],c['State']['StartedAt'])
        with patch.object(r,'bg_lifecycle',side_effect=lifecycle),patch.object(r,'bg_promote',side_effect=lambda *a:events.append('promote')):
            r.bg_recover_g(Remote(),{'live':live},c)
        self.assertEqual(events,['standby','promote','active'])
        with self.assertRaises(r.GateError):r.bg_recover_g(Remote(),{'live':dict(live,LIVE_G_CONTAINER_ID='x'*64)},c)
    def test_new_hotfix_lock_never_adopts_existing_lock(self):
        value={'art':{'release':'a'*40},'live':{'releaseLock':{'present':False,'openReferences':[]}}}
        with patch.object(r,'bg_script',return_value={}) as call:r.bg_lock(None,value,'claim')
        self.assertTrue(call.call_args[0][2]['fresh']);self.assertIn('p.mkdir(mode=0o700)',r.BG_LOCK_CODE)
        self.assertIn("q['present'] is False",r.BG_LOCK_CODE);self.assertIn('os.O_EXCL|os.O_NOFOLLOW',r.BG_LOCK_CODE)


class TransferCacheReleaseTests(unittest.TestCase):
    def setUp(self):
        r.configure_profile('post-transfer',r.BG_TRANSFER_BASE,r.BG_TRANSFER_BASE,'0'*64);r.BG_ACTIVE=True
    def tearDown(self):r.BG_ACTIVE=False
    def attempt(self,fault=None):return BlueGreenControllerTests.attempt(self,fault,True,r.BG_TRANSFER_BASE)
    def test_transfer_success_is_E_only_DB88_no_backup_no_migration(self):
        result,e,run,route=self.attempt()
        self.assertEqual(result['result'],'DEPLOY_COMPLETE');self.assertEqual(result['dbApplied'],88)
        self.assertEqual(result['backupProof']['result'],'NOT_REQUIRED_NO_SCHEMA_CHANGE');self.assertEqual(result['migrationProof']['result'],'NOT_REQUIRED_DB_ALREADY_88')
        self.assertNotIn('backup',e);self.assertNotIn('migration',e)
        self.assertLess(e.index('schemaProbe'),e.index('stopG'));self.assertLess(e.index('stopG'),e.index('zero'));self.assertLess(e.index('zero'),e.index('promote'))
        self.assertLess(e.index('publicE'),e.index('pointerE'));self.assertEqual(run,{'G':False,'E':True});self.assertTrue(result['releaseLockReleased'])
    def test_transfer_failure_preserves_or_recovers_exact_G(self):
        for fault in ('probe','standby','schemaProbe','promote','routeE','publicE','evidence'):
            result,e,run,route=self.attempt(fault)
            self.assertEqual(result['code'],'BG_INJECTED_FAILURE');self.assertNotIn('secondaryRecoveryCode',result)
            self.assertEqual(run,{'G':True,'E':False});self.assertEqual(route,['G'])
            if 'stopG' in e:
                self.assertLess(e.index('stopE'),e.index('restartG'));self.assertLess(e.index('recoverGActive'),e.index('routeG'))
            self.assertNotIn('migration',e);self.assertNotIn('backup',e)
    def test_transfer_binding_allows_only_single_exact_business_file(self):
        release='a'*40
        def git(repo,*args):
            if args==('branch','--show-current'):return r.B2_BRANCH
            if args[0]=='rev-list':return release+' '+r.BG_TRANSFER_BASE
            if args[0]=='diff' and args[-1]=='prisma':return ''
            if args[0]=='diff' and '--' in args:return 'src/utils/userData.js'
            return '\n'.join(sorted(r.BG_TRANSFER_FILES))
        with patch.object(r,'git',side_effect=git):r.validate_procurement_identity(ROOT,release)
        businessArgs=('diff','--name-only',r.BG_TRANSFER_BASE,release,'--','server','prisma','shared','src','brand','Dockerfile','package.json','package-lock.json')
        failures=[(('rev-list','--parents','-n','1',release),release+' '+r.BG_HOTFIX_BASE),
                  (('diff','--name-only',r.BG_TRANSFER_BASE,release),'src/utils/other.js'),
                  (businessArgs,'src/utils/userData.js\nserver/purchase-receipt.js'),
                  (businessArgs,'src/components/StoreTransferPage.jsx')]
        for key,bad in failures:
            with self.subTest(key=key),self.assertRaises(r.GateError),patch.object(r,'git',side_effect=lambda repo,*args:bad if args==key else git(repo,*args)):
                r.validate_procurement_identity(ROOT,release)
    def test_transfer_waiver_is_exact_and_other_profiles_and_physical_guards_fail_closed(self):
        self.assertTrue(r.procurement_hotfix());self.assertFalse(r.migration_enabled());self.assertEqual(r.bg_release_base(),r.BG_TRANSFER_BASE)
        art={'release':'a'*40,'capacityProfile':'B2'};receipt={'releaseSha':'a'*40,'parentSha':r.BG_TRANSFER_BASE}
        r.configure_capacity_waiver(receipt,art,emit=False)
        r.b1_capacity_gate({'baselineUsed':100*r.GIB,'baselineAvailable':r.GIB,'phase':'TRANSFER'},100*r.GIB,r.GIB,20*r.GIB)
        self.assertTrue(any(x['waived'] for x in r.CAPACITY_TELEMETRY))
        for code in ('BG_ENOSPC','BG_EIO','B2_IMPORT_UNKNOWN','B1_FILESYSTEM_CHANGED','MIGRATION_LEDGER_INVALID','WRITER_COUNT_INVALID','HEALTH_FAILED'):
            with self.assertRaises(r.GateError):r.capacity_require(False,code,{})
        for key,bad in [('releaseSha','b'*40),('parentSha',r.BG_HOTFIX_BASE)]:
            with self.assertRaises(r.GateError):r.configure_capacity_waiver(dict(receipt,**{key:bad}),art)
        r.configure_profile('post-transfer','b'*40,r.BG_TRANSFER_BASE,'0'*64)
        self.assertFalse(r.procurement_hotfix())
        with self.assertRaises(r.GateError):r.configure_capacity_waiver(receipt,art)
    def test_transfer_bind_requires_matching_live_G_pointer_and_DB88(self):
        release='a'*40;r.B2_IDENTITY=True
        art={'release':release,'capacityProfile':'B2'}
        live={'result':'LIVE_G_PROVEN','LIVE_G_SHA':r.BG_TRANSFER_BASE,'POINTER_SHA':r.BG_TRANSFER_BASE,'DB_APPLIED':88,'DB_FAILED':0,'LIVE_G_CONTAINER_ID':'b'*64,'LIVE_G_IMAGE_ID':'sha256:'+'c'*64}
        with patch.object(r,'git',return_value=release+' '+r.BG_TRANSFER_BASE):
            r.bg_bind(ROOT,release,art,live)
            for key,bad in [('DB_APPLIED',87),('DB_FAILED',1),('LIVE_G_SHA',r.BG_HOTFIX_BASE),('POINTER_SHA',r.BG_HOTFIX_BASE)]:
                with self.assertRaises(r.GateError):r.bg_bind(ROOT,release,art,dict(live,**{key:bad}))
    def test_transfer_exact_db88_guard_remains_strict(self):
        self.assertEqual(r.before_ledger(LEDGER),LEDGER)
        db={'database':r.EXPECTED_DB,'applied':88,'failed':0,'rolledBack':0,'ledger':LEDGER,'procurementSchema':{'schemaMd5':C['schemaMd5']}}
        r.validate_database(db,LEDGER)
        for key,bad in [('applied',87),('failed',1),('rolledBack',1),('ledger',{})]:
            with self.assertRaises(r.GateError):r.validate_database(dict(db,**{key:bad}),LEDGER)



class FinalHotfixBundleReleaseTests(unittest.TestCase):
    def setUp(self):
        r.configure_profile('post-transfer',r.BG_BUNDLE_BASE,r.BG_BUNDLE_BASE,'0'*64);r.BG_ACTIVE=True;r.B2_IDENTITY=True
    def tearDown(self):r.BG_ACTIVE=False;r.CAPACITY_WAIVER=None
    def fake_git(self,repo,*args):
        release='a'*40
        if args==('branch','--show-current'):return r.B2_BRANCH
        if args==('rev-list','--parents','-n','1',release):return release+' '+r.BG_BUNDLE_PARENT
        if args==('diff','--name-only',r.BG_BUNDLE_PARENT,release):return '\n'.join(sorted(r.BG_BUNDLE_RELEASE_FILES))
        if args==('diff','--name-only',r.BG_BUNDLE_ORIGIN,release):return '\n'.join(sorted(r.BG_BUNDLE_BUSINESS_FILES|r.BG_BUNDLE_FOCUSED_FILES|r.BG_BUNDLE_RELEASE_FILES))
        if args==('diff','--name-only',r.BG_BUNDLE_ORIGIN,release,'--','prisma'):return ''
        if args==('diff','--name-only',r.BG_BUNDLE_ORIGIN,release,'--','server','prisma','shared','src','brand','Dockerfile','package.json','package-lock.json'):return '\n'.join(sorted(r.BG_BUNDLE_BUSINESS_FILES))
        raise AssertionError(args)
    def test_exact_reviewed_parent_live_base_and_cumulative_bundle_allowed(self):
        with patch.object(r,'git',side_effect=self.fake_git):r.validate_procurement_identity(ROOT,'a'*40)
        self.assertEqual(r.bg_hotfix_base(),r.BG_BUNDLE_BASE);self.assertEqual(r.bg_release_base(),r.BG_BUNDLE_PARENT)
        self.assertTrue(r.procurement_hotfix());self.assertFalse(r.migration_enabled())
        planned=set(subprocess.check_output(['git','-C',str(ROOT),'diff','--name-only',r.BG_BUNDLE_BASE,r.BG_BUNDLE_PARENT],text=True).splitlines()) | r.BG_BUNDLE_RELEASE_FILES
        self.assertEqual(planned,r.BG_BUNDLE_FILES)
    def test_wrong_ancestry_and_any_extra_business_or_schema_file_fail_closed(self):
        release='a'*40;business=('diff','--name-only',r.BG_BUNDLE_ORIGIN,release,'--','server','prisma','shared','src','brand','Dockerfile','package.json','package-lock.json')
        failures=[(('rev-list','--parents','-n','1',release),release+' '+r.BG_BUNDLE_BASE),
                  (('diff','--name-only',r.BG_BUNDLE_PARENT,release),'scripts/deploy-prod-transfer-cas.py\nserver/other.js'),
                  (('diff','--name-only',r.BG_BUNDLE_ORIGIN,release),self.fake_git(ROOT,'diff','--name-only',r.BG_BUNDLE_ORIGIN,release)+'\ntests/other.spec.mjs'),
                  (('diff','--name-only',r.BG_BUNDLE_ORIGIN,release,'--','prisma'),'prisma/migrations/new/migration.sql')]
        for path in ('server/other.js','server/app.js','server/index.js','prisma/schema.prisma','src/other.jsx','shared/other.js','package.json'):
            failures.append((business,'\n'.join(sorted(r.BG_BUNDLE_BUSINESS_FILES|{path}))))
        for key,bad in failures:
            with self.subTest(key=key,bad=bad),self.assertRaises(r.GateError),patch.object(r,'git',side_effect=lambda repo,*args:bad if args==key else self.fake_git(repo,*args)):
                r.validate_procurement_identity(ROOT,release)
        with patch.object(r,'digest',return_value='wrong'),patch.object(r,'git',side_effect=self.fake_git),self.assertRaisesRegex(r.GateError,'BG_LIFECYCLE_IDENTITY_INVALID'):
            r.validate_procurement_identity(ROOT,release)
    def test_wrong_live_base_and_non_BG_profiles_cannot_adopt_bundle(self):
        for old,business,profile in [(r.BG_BUNDLE_ORIGIN,r.BG_BUNDLE_BASE,'post-transfer'),(r.BG_BUNDLE_BASE,r.BG_BUNDLE_PARENT,'post-transfer')]:
            r.configure_profile(profile,old,business,'0'*64)
            self.assertFalse(r.procurement_hotfix())
            with patch.object(r,'git',side_effect=self.fake_git),self.assertRaises(r.GateError):r.validate_procurement_identity(ROOT,'a'*40)
        with self.assertRaisesRegex(r.GateError,'FIRST_ROLLOUT_IDENTITY_OVERRIDE_FORBIDDEN'):
            r.configure_profile('transfer-first',r.BG_BUNDLE_BASE,r.BG_BUNDLE_BASE,'0'*64)
    def test_bundle_exact_waiver_and_unchanged_noncapacity_failures(self):
        art={'release':'a'*40,'capacityProfile':'B2'};receipt={'releaseSha':'a'*40,'parentSha':r.BG_BUNDLE_PARENT}
        r.configure_capacity_waiver(receipt,art,emit=False)
        r.b1_capacity_gate({'baselineUsed':100*r.GIB,'baselineAvailable':r.GIB,'phase':'BUNDLE'},100*r.GIB,r.GIB,20*r.GIB)
        self.assertTrue(any(x['waived'] for x in r.CAPACITY_TELEMETRY))
        for code in ('BG_ENOSPC','BG_EIO','B2_IMPORT_UNKNOWN','B1_FILESYSTEM_CHANGED','MIGRATION_LEDGER_INVALID','WRITER_COUNT_INVALID','HEALTH_FAILED','BG_LIFECYCLE_FAILED','FINAL_HOTFIX_BUNDLE_READ_PROBE_FAILED'):
            with self.assertRaises(r.GateError):r.capacity_require(False,code,{})
        for key,bad in [('releaseSha','b'*40),('parentSha',r.BG_BUNDLE_BASE)]:
            with self.assertRaises(r.GateError):r.configure_capacity_waiver(dict(receipt,**{key:bad}),art)
        r.BG_ACTIVE=False
        with self.assertRaises(r.GateError):r.configure_capacity_waiver(receipt,art)
    def test_bind_requires_real_G_DB88_and_transfer_authority(self):
        live={'result':'LIVE_G_PROVEN','LIVE_G_SHA':r.BG_BUNDLE_BASE,'POINTER_SHA':r.BG_BUNDLE_BASE,'DB_APPLIED':88,'DB_FAILED':0,'LIVE_G_CONTAINER_ID':'b'*64,'LIVE_G_IMAGE_ID':'sha256:'+'c'*64,'TRANSFER_PG_AUTHORITY':'PASS','TRANSFER_API_AUTHORITY':'PASS','TRANSFER_RECORD_ID':'tr-approved'}
        with patch.object(r,'git',return_value='a'*40+' '+r.BG_BUNDLE_PARENT):
            r.bg_bind(ROOT,'a'*40,{'release':'a'*40,'capacityProfile':'B2'},live)
            for key,bad in [('LIVE_G_SHA',r.BG_BUNDLE_ORIGIN),('POINTER_SHA',r.BG_BUNDLE_ORIGIN),('DB_APPLIED',87),('DB_FAILED',1),('TRANSFER_PG_AUTHORITY','FAIL'),('TRANSFER_API_AUTHORITY','FAIL'),('TRANSFER_RECORD_ID','')]:
                with self.assertRaises(r.GateError):r.bg_bind(ROOT,'a'*40,{'release':'a'*40,'capacityProfile':'B2'},dict(live,**{key:bad}))
    def test_existing_controller_E_only_no_migration_and_same_G_recovery(self):
        result,e,running,route=BlueGreenControllerTests.attempt(self,hotfix=True,hotfix_base=r.BG_BUNDLE_BASE)
        self.assertEqual(result['result'],'DEPLOY_COMPLETE');self.assertTrue(result['releaseLockReleased']);self.assertEqual(route,['E'])
        for forbidden in ('backup','migration'):self.assertNotIn(forbidden,e)
        self.assertLess(e.index('standby'),e.index('stopG'));self.assertLess(e.index('stopG'),e.index('zero'));self.assertLess(e.index('zero'),e.index('promote'));self.assertLess(e.index('promote'),e.index('routeE'))
        for fault in ('probe','standby','promote','routeE','publicE'):
            result,e,running,route=BlueGreenControllerTests.attempt(self,fault,True,r.BG_BUNDLE_BASE)
            self.assertEqual(result['code'],'BG_INJECTED_FAILURE');self.assertEqual(route,['G']);self.assertEqual(running,{'G':True,'E':False})
            if 'stopG' in e:self.assertLess(e.index('stopE'),e.index('restartG'));self.assertLess(e.index('restartG'),e.index('recoverGActive'))
            self.assertNotIn('backup',e);self.assertNotIn('migration',e)
    def test_read_adapter_uses_actual_cookie_contract_and_only_gets(self):
        script=r"""import http from 'node:http';import fs from 'node:fs';
const value=JSON.parse(fs.readFileSync(0,'utf8'));const calls=[];
const server=http.createServer((req,res)=>{calls.push([req.method,req.url,req.headers.cookie]);res.setHeader('Content-Type','application/json');
if(req.method!=='GET'||req.headers.cookie!=='budu_token=opaque'){res.writeHead(401);return res.end('{}')}
const path=req.url;if(path==='/api/health')return res.end(JSON.stringify({ok:true,dbOk:true,gitSha:'a'.repeat(40),runtimeMode:'standby'}));
res.end(JSON.stringify({rows:path==='/api/v2/transfer-requests'?[{id:'tr-approved'}]:[]}))});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const fetchOriginal=globalThis.fetch;
globalThis.fetch=(url,args)=>fetchOriginal(String(url).replace(':3000',':'+server.address().port),args);
process.argv=[process.argv[0],'tr-approved','a'.repeat(40),'standby'];process.env.JWT_SECRET='synthetic-only';
const item={id:'tr-approved',createdAt:new Date('2026-10-06T10:49:00Z'),createdBy:'synthetic',deletedAt:null};
const prefix=`const tx={$executeRawUnsafe:async()=>{},$queryRawUnsafe:async sql=>sql.startsWith('SHOW')?[{transaction_read_only:'on'}]:[{name:'budu_bj006'}],transferRequest:{findMany:async()=>[item]},user:{findFirst:async()=>({id:'synthetic'})},procurementSupplier:{findFirst:async()=>null},procurementOrder:{findFirst:async()=>null},inventoryItem:{findFirst:async()=>null}};const prisma={$transaction:async fn=>fn(tx),$disconnect:async()=>{}};const signToken=()=> 'opaque';`;
let failed=false;try{await eval('(async()=>{'+value.code.replace("import {prisma} from './server/pg.js';import {signToken} from './server/auth.js';",prefix).replace("import crypto from 'node:crypto';","const crypto=(await import('node:crypto')).default;")+'})()')}catch{failed=true}
finally{await new Promise(resolve=>server.close(resolve))}
if(failed!==value.fail)process.exit(1);if(!calls.length||calls.some(c=>c[0]!=='GET'))process.exit(1);
"""
        for code,fail in [(r.BG_BUNDLE_READ_CODE,False),(r.BG_BUNDLE_READ_CODE.replace("Cookie:'budu_token='+token","Authorization:'Bearer '+token"),True)]:
            result=subprocess.run(['node','--input-type=module','-e',script],input=json.dumps({'code':code,'fail':fail}).encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
            self.assertEqual(result.returncode,0,'cookie-contract read adapter regression')


    def test_owned_standby_reset_rechecks_identity_sessions_and_G_before_handover(self):
        release='a'*40;events=[];changed=None
        before={'Id':'e','Image':'sha256:'+'e'*64,'State':{'Running':True,'StartedAt':'old'},'Config':{'Env':['GIT_SHA='+release],'Labels':{}},'HostConfig':{'Memory':1},'Mounts':[{'Type':'bind','Source':'same','Destination':'/data','RW':True}]}
        value={'art':{'release':release},'live':{'LIVE_G_CONTAINER':'G','LIVE_G_CONTAINER_ID':'g','LIVE_G_SHA':r.BG_BUNDLE_BASE,'POINTER_SHA':r.BG_BUNDLE_BASE},'template':'G','active':'G'}
        class Remote:
            def routes(self):return ('G','G')
            def run(self,args,**kw):
                if args[0]=='cat':return (r.BG_BUNDLE_BASE+'\n').encode()
                events.append(args[1]);return b''
            def inspect(self,name):return dict(before,State={'Running':False})
            def health(self,name,*args,**kw):events.append('health'+name)
        def writer(*args):events.append('writerStoppedE' if not args[-1] else 'writerStandbyE');return {}
        state={'candidate':'E','candidateId':'e','bundleReadonlyProof':{'result':'PASS'}}
        after=dict(before,State={'Running':True,'StartedAt':'new'})
        with patch.object(r,'bg_lifecycle',side_effect=lambda *a:events.append('lifecycle') or before),patch.object(r,'bg_candidate_identity',return_value=after),patch.object(r,'bg_writer',side_effect=writer),patch.object(r,'application_db_probe',side_effect=lambda *a:events.append('prisma')):
            r.bg_bundle_reset_standby(Remote(),value,state)
        self.assertTrue(state['bundleStandbyResetVerified']);self.assertEqual(state['lifecycleSince'],'new')
        self.assertLess(events.index('stop'),events.index('writerStoppedE'));self.assertLess(events.index('writerStoppedE'),events.index('start'));self.assertLess(events.index('start'),events.index('prisma'));self.assertLess(events.index('prisma'),events.index('writerStandbyE'))
        for field,bad in [('Id','g'),('Image','other'),('Config',{}),('HostConfig',{}),('Mounts',[])]:
            events.clear();state={'candidate':'E','candidateId':'e','bundleReadonlyProof':{'result':'PASS'}}
            with patch.object(r,'bg_lifecycle',return_value=before),patch.object(r,'bg_candidate_identity',return_value=dict(after,**{field:bad})),patch.object(r,'bg_writer',side_effect=writer),self.assertRaises(r.GateError):
                r.bg_bundle_reset_standby(Remote(),value,state)
        state={'candidate':'E','candidateId':'g','bundleReadonlyProof':{'result':'PASS'}}
        with self.assertRaisesRegex(r.GateError,'FINAL_HOTFIX_BUNDLE_RESET_SCOPE_INVALID'):r.bg_bundle_reset_standby(Remote(),value,state)
        state={'candidate':'E','candidateId':'e','bundleReadonlyProof':{'result':'PASS'}}
        with patch.object(r,'bg_lifecycle',return_value=before),patch.object(r,'bg_writer',side_effect=r.GateError('UNKNOWN_DB_CLIENT_OR_OLD_WRITER')),self.assertRaises(r.GateError):
            r.bg_bundle_reset_standby(Remote(),value,state)
        self.assertNotIn('start',events[-1:])

    def test_read_probe_is_readonly_and_reference_failures_block(self):
        proof={'result':'PASS','database':r.EXPECTED_DB,'referenceId':'tr-approved','transferPgAuthority':'PASS','transferApiAuthority':'PASS','procurementReadonly':'PASS'}
        class Remote:
            def run(self,args,**kw):
                self.args=args;return json.dumps(proof).encode()
        remote=Remote();self.assertEqual(r.bg_bundle_read_probe(remote,'E','tr-approved','a'*40,'standby'),proof)
        self.assertIn('SET TRANSACTION READ ONLY',r.BG_BUNDLE_READ_CODE)
        self.assertIn('transaction_read_only',r.BG_BUNDLE_READ_CODE)
        self.assertIn("headers:{Cookie:'budu_token='+token}",r.BG_BUNDLE_READ_CODE)
        self.assertNotIn('Authorization:',r.BG_BUNDLE_READ_CODE)
        for token in ('/v2/transfer-requests','suppliers','items','orders'):self.assertIn(token,r.BG_BUNDLE_READ_CODE)
        for token in ('POST','PATCH','PUT','DELETE','migrate deploy'):self.assertNotIn(token,r.BG_BUNDLE_READ_CODE)
        proof['referenceId']='wrong'
        with self.assertRaises(r.GateError):r.bg_bundle_read_probe(remote,'E','tr-approved','a'*40,'standby')
        proof['referenceId']='tr-approved';proof['transferApiAuthority']='FAIL'
        with self.assertRaises(r.GateError):r.bg_bundle_read_probe(remote,'E','tr-approved','a'*40,'standby')

if __name__=='__main__':unittest.main(verbosity=2)

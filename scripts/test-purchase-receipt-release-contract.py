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

if __name__=='__main__':unittest.main(verbosity=2)

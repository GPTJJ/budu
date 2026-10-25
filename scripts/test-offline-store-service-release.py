#!/usr/bin/env python3
"""Release-control tests only. No SSH, business send, or production mutation."""
import copy
from contextlib import ExitStack
import importlib.util
import json
from pathlib import Path
import signal
import subprocess
import sys
import unittest
from unittest.mock import patch

PATH=Path(__file__).with_name('deploy-prod-offline-store-services.py')
SPEC=importlib.util.spec_from_file_location('offline_release_under_test',PATH)
p=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(p)


def shared_fixture():
    c=p.contract();cid='a'*64;image='sha256:'+'b'*64;rows=[]
    for layer in c['layers'][:21]:
        rows.append({**{k:layer[k] for k in ['index','chainId','contentDigest','diffId']},
          'snapshotKind':'Committed','parent':c['layers'][layer['index']-1]['chainId'] if layer['index'] else '',
          'snapshotAllocatedBytes':layer['expandedPhysicalBytes'],'snapshotCreditBytes':layer['expandedPhysicalBytes'],
          'blobAllocatedBytes':layer['blobBytes'],'blobCreditBytes':layer['blobBytes'],
          'blobStatus':'HASH_STAT_AND_CONTENT_REF_VERIFIED'})
    closure=[{'Name':cid,'Kind':'Active','Parent':rows[-1]['chainId']}]
    closure += [{'Name':x['chainId'],'Kind':'Committed','Parent':x['parent']} for x in reversed(rows)]
    blobs=sum(x['blobCreditBytes'] for x in rows);snapshots=sum(x['snapshotCreditBytes'] for x in rows)
    sharing={'status':'PASS_READONLY_LIVE_ROOTFS_COMMITTED_AND_HASHED_CONTENT','imageId':image,'liveContainerId':cid,
      'activeIngest':0,'unknownSnapshots':0,'newProofContainerCreated':False,'nonImageInitSnapshotsCredited':False,
      'driver':'overlayfs','dockerServerVersion':'29.1.3','containerdVersionLines':['Server:','  Version:  2.2.1'],
      'containerdServerBinarySha256':'69c4c734aba514436e60deae20f043dbbe7e215b0f4882b8fc3ead9529704990',
      'backendBinaryIdentitySource':'UNIX_SOCKET_PEERCRED_PROC_EXE',
      'actualLiveParentClosure':closure,'layers':rows,'sharedPrefixLayers':len(rows),
      'blobCreditBytes':blobs,'snapshotCreditBytes':snapshots,'totalCreditBytes':blobs+snapshots}
    return sharing,{'imageId':image,'containerId':cid}


class FrozenIdentityTests(unittest.TestCase):
    def test_fixed_source_and_exact_single_migration(self):
        c=p.contract()
        self.assertEqual(len(c['beforeLedger']),90);self.assertEqual(len(c['afterLedger']),91)
        self.assertEqual(set(c['afterLedger'])-set(c['beforeLedger']),{c['migration']})
        self.assertEqual(c['afterLedger'][c['migration']],c['migrationSqlSha256'])

    def test_runtime_payload_and_prisma_dist_are_frozen(self):
        c=p.contract();self.assertEqual(len(c['sourcePayloadFiles']),783)
        self.assertTrue(any(x.startswith('dist/') for x in c['sourcePayloadFiles']))
        for x in ['server/store-service-api.js','server/store-service-notifications.js','prisma/schema.prisma','package-lock.json']:
            self.assertIn(x,c['sourcePayloadFiles'])
        self.assertEqual(p.sha(p.canonical(c['sourcePayloadFiles'])),c['sourcePayloadTreeSha256'])

    def test_formal_guards_unchanged(self):
        c=p.contract()['guardrails']
        self.assertEqual(c['minAvailableBytes'],10*1024**3)
        self.assertEqual(c['maxUsagePercent'],90)
        self.assertEqual(c['absoluteMaxAdditionalPeakBytes'],6*1024**3)
        self.assertEqual(c['ordinaryReserveBytes'],512*1024**2)
        self.assertIsNone(p.m.CAPACITY_WAIVER)

    def test_atomic_sql_has_exact_ledger_and_domain_bounds(self):
        c=p.contract();v={'sql':(PATH.parent.parent/'prisma/migrations'/c['migration']/'migration.sql').read_text(),
                         'oldLedger':c['beforeLedger'],'ledger':c['afterLedger']}
        sql=p.migration_script(v)
        self.assertTrue(sql.startswith('BEGIN;'));self.assertTrue(sql.endswith('COMMIT;\n'))
        self.assertIn('LOCK TABLE "_prisma_migrations"',sql)
        self.assertLess(sql.index(v['sql']),sql.index('INSERT INTO "_prisma_migrations"'))
        self.assertIn('>100000',sql);self.assertIn('>67108864',sql)
        self.assertNotIn('UPDATE "Invoice"',sql)

    def test_changed_sql_or_ledger_refused(self):
        c=p.contract();v={'sql':'SELECT 1;','oldLedger':c['beforeLedger'],'ledger':c['afterLedger']}
        with self.assertRaises(p.m.GateError):p.migration_script(v)

    def test_recovery_uses_active_mode_without_claiming_all_writes_blocked(self):
        c=p.contract();self.assertEqual(c['compatibleRecallRuntimeMode'],'active')
        self.assertTrue(c['compatibleFlagsAreNotAllModuleReadOnly'])
        self.assertEqual(c['compatibleRecallFlags']['STORE_SERVICE_RUNTIME_ENABLED'],'1')
        for key in ['STORE_SERVICE_SUBMISSIONS_ENABLED','STORE_SERVICE_QR_ENABLED','STORE_SERVICE_SEND_ENABLED']:
            self.assertEqual(c['compatibleRecallFlags'][key],'0')
        self.assertFalse(c['oldA86RollbackAfterNewServiceOpenedAllowed'])


class SharedSpaceTests(unittest.TestCase):
    def setUp(self):self.s,self.proof=shared_fixture()
    def test_exact_data_accepted(self):self.assertEqual(p.validate_sharing(self.s,self.proof),self.s['totalCreditBytes'])
    def reject(self,change):
        change(self.s)
        with self.assertRaises(p.m.GateError):p.validate_sharing(self.s,self.proof)
    def test_tag_only_or_other_source_refused(self):self.reject(lambda s:s.update(imageId='sha256:'+'c'*64))
    def test_active_ingest_refused(self):self.reject(lambda s:s.update(activeIngest=1))
    def test_unknown_snapshot_refused(self):self.reject(lambda s:s.update(unknownSnapshots=1))
    def test_changed_containerd_version_refused(self):self.reject(lambda s:s.update(containerdVersionLines=['Server:',' Version: 2.3.0']))
    def test_same_version_other_binary_refused(self):self.reject(lambda s:s.update(containerdServerBinarySha256='0'*64))
    def test_other_docker_version_refused(self):self.reject(lambda s:s.update(dockerServerVersion='29.8.2'))
    def test_unhashed_blob_refused(self):self.reject(lambda s:s['layers'][0].update(blobStatus='MISSING'))
    def test_snapshot_credit_cannot_exceed_actual(self):self.reject(lambda s:s['layers'][0].update(snapshotAllocatedBytes=0))
    def test_credit_cannot_exceed_reviewed_budget(self):self.reject(lambda s:s['layers'][0].update(snapshotCreditBytes=s['layers'][0]['snapshotCreditBytes']+4096))
    def test_duplicate_layer_refused(self):self.reject(lambda s:s['layers'].__setitem__(1,copy.deepcopy(s['layers'][0])))
    def test_parent_graph_mismatch_refused(self):self.reject(lambda s:s['actualLiveParentClosure'][1].update(Parent='unexpected'))
    def test_credit_total_mismatch_refused(self):self.reject(lambda s:s.update(totalCreditBytes=s['totalCreditBytes']+1))
    def test_nonimage_init_not_credited(self):
        s=self.s;first=s['actualLiveParentClosure'][0];parent=first['Parent'];init='d'*64+'-init'
        first['Parent']=init;s['actualLiveParentClosure'].insert(1,{'Name':init,'Kind':'Committed','Parent':parent})
        self.assertEqual(p.validate_sharing(s,self.proof),s['totalCreditBytes'])
    def test_transient_shared_ingest_not_ignored(self):
        plan=p.capacity_plan(self.s,self.proof,{'dbBytes':186571799,'pgVersion':'16.14'})
        self.assertEqual(plan['transientImportBytes'],343955852)
        self.assertEqual(plan['retainedArchiveDatabase']-plan['database'],p.contract()['archiveBytes'])
        self.assertEqual(plan['existingAssetDeletionCredit'],0)


class OriginalCapacityGuardTests(unittest.TestCase):
    def gate(self,used,free,future,peak=0):
        ledger={'baselineUsed':used,'baselineAvailable':free,'phase':'UNIT_SYNTHETIC','peak':peak}
        return p.m.b1_capacity_gate(ledger,used,free,future,planned=peak)
    def test_ten_gib_floor_cannot_be_waived(self):
        with self.assertRaises(p.m.GateError):self.gate(60*1024**3,11*1024**3,2*1024**3)
    def test_absolute_six_gib_cannot_be_waived(self):
        with self.assertRaises(p.m.GateError):self.gate(10*1024**3,50*1024**3,7*1024**3)
    def test_ninety_percent_cannot_be_waived(self):
        with self.assertRaises(p.m.GateError):self.gate(900*1024**3,100*1024**3,1)
    def test_prior_peak_not_erased_by_deletion(self):
        used,free=60*1024**3,20*1024**3
        ledger={'baselineUsed':used,'baselineAvailable':free,'phase':'UNIT_RELEASED_NEW_ARCHIVE','peak':5*1024**3}
        p.m.b1_capacity_gate(ledger,used-1024**3,free+1024**3,512*1024**2)
        self.assertEqual(ledger['peak'],5*1024**3)


class WriterAndTerminationTests(unittest.TestCase):
    def row(self,name,ident,ip):
        return {'Name':'/'+name,'Id':ident,'Config':{'Env':['DATABASE_URL=postgresql://fixture@db/budu_bj006']},
                'NetworkSettings':{'Networks':{'isolated':{'IPAddress':ip}}}}
    def test_standby_persistent_db_client_not_exempted(self):
        a=self.row('writer','a','10.0.0.2');b=self.row('standby','b','10.0.0.3')
        class Remote:
            def containers(self):return [a,b]
        with patch.object(p,'database',return_value={'clients':['10.0.0.2','10.0.0.3']}),patch.object(p.m,'bg_lifecycle',return_value=b):
            with self.assertRaises(p.m.GateError):p.writer(Remote(),{}, {'phase':90},['writer'],{'candidate':'standby'})
    def test_standby_without_client_does_not_add_second_writer(self):
        a=self.row('writer','a','10.0.0.2');b=self.row('standby','b','10.0.0.3')
        class Remote:
            def containers(self):return [a,b]
        with patch.object(p,'database',return_value={'clients':['10.0.0.2']}),patch.object(p.m,'bg_lifecycle',return_value=b):
            p.writer(Remote(),{}, {'phase':90},['writer'],{'candidate':'standby'})
    def test_unknown_client_refused(self):
        a=self.row('writer','a','10.0.0.2')
        class Remote:
            def containers(self):return [a]
        with patch.object(p,'database',return_value={'clients':['10.0.0.99']}):
            with self.assertRaises(p.m.GateError):p.writer(Remote(),{}, {'phase':90},['writer'])
    def test_l90_observation_does_not_override_unterminated_migrator(self):
        with self.assertRaises(p.m.GateError):p.termination_admitted({'migrationAttempted':True,'migration':{'terminated':False}})
    def test_partial_backup_cleanup_does_not_admit_writer(self):
        with self.assertRaises(p.m.GateError):p.termination_admitted({'backupAttempted':True,'backup':{'backupTerminationVerified':True}})
    def test_all_termination_receipts_required(self):
        b={k:True for k in ['backupTerminationVerified','exporterTerminated','dumpTerminated','restoreStopped','restoreProcessTerminated']}
        p.termination_admitted({'backupAttempted':True,'backup':b,'migrationAttempted':True,'migration':{'terminated':True}})


class BoundedHelperTests(unittest.TestCase):
    def test_helpers_compile_and_dump_loop_checks_budgets(self):
        code=p.bounded_backup_code();compile(code,'bounded-backup','exec');compile(p.MIGRATION_CODE,'bounded-migration','exec')
        self.assertIn('dump_process=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)\n            while True:\n                _offline_disk_guard();_offline_wal_guard()',code)
        self.assertIn('if not cleanup:_offline_disk_guard();_offline_wal_guard()',code)
        self.assertIn('while p.poll() is None:\n  _offline_disk_guard();_offline_wal_guard()',p.MIGRATION_CODE)
    def test_bootstrap_catches_transport_signals_in_one_host_process(self):
        code=p.bootstrap_source()+"\nimport time\ntry:\n signal.raise_signal(signal.SIGTERM)\nexcept m.GateError:\n print('CONTROLLED_SIGNAL')\n"
        child=subprocess.run([sys.executable,'-c',"import sys;exec(compile(sys.stdin.read(),'<bundled-test>','exec'))"],input=code,capture_output=True,text=True,timeout=10)
        self.assertEqual(child.returncode,0,child.stderr[-600:]);self.assertEqual(child.stdout.strip(),'CONTROLLED_SIGNAL')


class KnownRouteRecoveryTests(unittest.TestCase):
    def test_each_known_partial_pair_can_converge(self):
        for template,active in [('old','old'),('new','old'),('old','new'),('new','new')]:
            with self.subTest(template=template,active=active):self.assertEqual(p.admit_known_route_pair(template,active,'old','new'),'new')
    def test_unknown_external_route_is_never_overwritten(self):
        for template,active in [('other','old'),('new','other')]:
            with self.subTest(template=template,active=active),self.assertRaises(p.m.GateError):p.admit_known_route_pair(template,active,'old','new')


class CompatibleRecoveryControlFlowTests(unittest.TestCase):
    """Inject transport failures into the real recovery and route primitives.

    The Docker/route backend is a deterministic local fake. These cases prove
    controller convergence, not a real Nginx reload or production availability.
    """
    def run_recovery(self,fault=None,unknown_external_change=False):
        c=p.contract();old='synthetic-current';new='budu-prod-'+c['sourceSha'][:12]+'-service-recall'
        routes='\n'.join('proxy_pass http://'+old+':3000;' for _ in range(3))
        env={'GIT_SHA':c['sourceSha'],'STORE_SERVICE_RUNTIME_ENABLED':'1'}
        source={'Id':'synthetic-source-id','Name':'/'+old,'Image':c['ociManifest'],
          'Config':{'Labels':{p.m.REVISION:c['sourceSha']},'Env':[k+'='+v for k,v in env.items()]},
          'HostConfig':{'NetworkMode':'synthetic'},'Mounts':[], 'State':{'Running':True}}
        proof={'containerId':source['Id'],'containerName':old,'environmentHash':p.sha(p.canonical(env)),
          'hostConfigHash':p.sha(p.canonical(source['HostConfig'])),'mountsHash':p.sha(p.canonical([])),
          'labelsHash':p.sha(p.canonical(source['Config']['Labels']))}
        plan={'import':2275674267,'database':2747613570}
        v={'release':c['sourceSha'],'proof':proof,'art':{},'capacityPlan':plan,
           'recoveryCapacityLedger':{'baselineUsed':10*1024**3,'baselineAvailable':40*1024**3,
                                    'phase':'SYNTHETIC','peak':plan['database'],'plan':plan}}
        class Backend:
            def __init__(self):
                self.template=self.active=routes;self.injected=False;self.events=[];self.mode='standby'
            def fail(self,stage):
                if stage==fault and not self.injected:
                    self.injected=True;self.events.append('INJECTED_'+stage)
                    if unknown_external_change:self.active='EXTERNAL_UNRECOGNIZED_ROUTE'
                    raise p.m.GateError('SYNTHETIC_'+stage)
            def inspect(self,name):
                if name==source['Id']:return source
                return {'Id':'synthetic-candidate-id','Name':'/'+new,'State':{'Running':True}}
            def disk(self):return 10*1024**3,40*1024**3
            def routes(self):return self.template,self.active
            def py(self,code,value=None,timeout=60):
                if value and value.get('path')==p.m.TEMPLATE:
                    self.template=value['text'];self.events.append('TEMPLATE_WRITE');self.fail('FIRST_WRITE')
                    return b''
                raise AssertionError('Unexpected remote Python operation')
            def run(self,args,data=None,timeout=60):
                if args==['test','!','-e',p.m.LOCK]:return b''
                if args[:3]==['docker','stop','--time']:
                    source['State']['Running']=False;self.events.append('OLD_STOP');return b''
                if args[:4]==['docker','exec','-i',p.m.NGINX]:
                    self.active=data.decode();self.events.append('ACTIVE_WRITE');self.fail('SECOND_WRITE');return b''
                if args==['docker','exec',p.m.NGINX,'nginx','-t']:
                    self.events.append('NGINX_TEST');self.fail('NGINX_TEST');return b''
                if args==['docker','exec',p.m.NGINX,'nginx','-s','reload']:
                    self.events.append('NGINX_RELOAD');self.fail('NGINX_RELOAD');return b''
                raise AssertionError('Unexpected remote command')
            def health(self,name,release,public=False):
                self.events.append('PUBLIC_HEALTH' if public else 'HEALTH')
                if public:self.fail('PUBLIC_HEALTH')
        remote=Backend();locks=[]
        def lock(r,code,value,**kwargs):
            self.assertIs(code,p.m.BG_LOCK_CODE);locks.append(value['action']);return {'syntheticReceipt':True}
        def clone(r,value,state,src,name,flags):
            self.assertEqual(flags,c['compatibleRecallFlags'])
            state.update(candidate=name,candidateId='synthetic-candidate-id')
        def lifecycle(r,value,state,mode):
            self.assertEqual(remote.mode,mode);return remote.inspect(state['candidateId'])
        def promote(r,value,state):remote.mode='active'
        with ExitStack() as stack:
            for target,name,replacement in [
              (p.m,'configure_profile',lambda *a:None),(p.m,'bg_script',lock),
              (p.m,'resolve_loaded_image',lambda *a:{'Id':c['ociManifest']}),
              (p,'database',lambda *a:{'phase':91}), (p,'clone_standby',clone),
              (p,'writer',lambda *a:None),(p,'runtime_probe',lambda *a:None),
              (p.m,'bg_lifecycle',lifecycle),(p.m,'bg_promote',promote)]:
                stack.enter_context(patch.object(target,name,replacement))
            result=p.execute_compatible_recall(remote,v)
        return result,remote,locks,routes.replace('http://'+old+':3000','http://'+new+':3000')

    def test_normal_active_recovery_releases_owned_lock(self):
        result,remote,locks,new=self.run_recovery()
        self.assertEqual(result['result'],'COMPATIBLE_RECALL_ACTIVE')
        self.assertEqual(remote.routes(),(new,new));self.assertEqual(locks,['claim','release'])

    def test_known_partial_route_faults_converge_but_retain_failure_lock(self):
        for point in ['FIRST_WRITE','SECOND_WRITE','NGINX_TEST','NGINX_RELOAD','PUBLIC_HEALTH']:
            with self.subTest(fault=point):
                result,remote,locks,new=self.run_recovery(point)
                self.assertTrue(remote.injected);self.assertEqual(remote.routes(),(new,new))
                self.assertEqual(result['result'],'COMPATIBLE_RECALL_BLOCKED')
                self.assertEqual(result['recovery'],'KNOWN_PARTIAL_ROUTES_CONVERGED_VERIFIED_L91_RECALL')
                self.assertTrue(result['serviceAvailableVerified']);self.assertTrue(result['lockRetained'])
                self.assertEqual(locks,['claim'])

    def test_external_route_drift_preserved_and_recovery_not_claimed(self):
        result,remote,locks,new=self.run_recovery('NGINX_RELOAD',True)
        self.assertEqual(remote.active,'EXTERNAL_UNRECOGNIZED_ROUTE')
        self.assertEqual(result['recovery'],'UNVERIFIED_RETAIN_LOCK_NO_BLIND_RESTART')
        self.assertNotIn('serviceAvailableVerified',result);self.assertEqual(locks,['claim'])


if __name__=='__main__':unittest.main(verbosity=2)

#!/usr/bin/env python3
"""Offline only. No Docker/SSH/DB/network/subprocess execution is permitted."""
import sys
sys.dont_write_bytecode = True
import copy
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch, Mock

SPEC = importlib.util.spec_from_file_location('release', Path(__file__).with_name('deploy-prod-transfer-cas.py'))
r = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(r)
NEW = 'a' * 40
OLD_NAME = 'current-production'
NAME = 'budu-prod-' + NEW[:12] + '-transfer-cas'
LEDGER = {str(i): 'b'*64 for i in range(85)}
ROUTES = '\n'.join(['proxy_pass http://current-production:3000;']*3 + ['proxy_pass http://isolated-test:3000/api/;'])


def original():
    return {'Id':'old-id','Name':'/'+OLD_NAME,'Image':'sha256:old-image',
            'State':{'Running':True,'Health':{'Status':'healthy'}},
            'Config':{'Env':['GIT_SHA='+r.EXPECTED_OLD_SHA,
                             'DATABASE_URL=postgresql://role:FIXTURE_ONLY@pg/'+r.EXPECTED_DB,
                             'CUSTOMER_REQUEST_WECOM_RECIPIENT_USERNAME=budu',
                             'CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID=dh'],
                      'Labels':{r.REVISION:r.EXPECTED_OLD_SHA,'budu.production-role':'candidate'},
                      'User':'node','WorkingDir':'/app','Entrypoint':['docker-entrypoint.sh'],
                      'Cmd':['sh','-c','node scripts/validate-runtime-config.mjs && node server/index.js'],
                      'ExposedPorts':{'3000/tcp':{}},'Healthcheck':{'Test':['CMD-SHELL','health']},'StopSignal':None},
            'HostConfig':{**r.HOST_DEFAULTS,'RestartPolicy':{'Name':'unless-stopped','MaximumRetryCount':0},
                          'PortBindings':{},'PublishAllPorts':False,'NetworkMode':'net',
                          'ReadonlyRootfs':False,'CapAdd':None,'CapDrop':None,'Privileged':False,
                          'SecurityOpt':None,'LogConfig':{'Type':'json-file','Config':{}},'GroupAdd':['0'],'Init':None},
            'Mounts':[{'Type':'bind','Source':'/run/existing-secret','Destination':'/run/secrets/a','RW':False},
                      {'Type':'volume','Name':'existing-data','Source':'/var/lib/data','Destination':'/app/server/data','RW':True}],
            'NetworkSettings':{'Networks':{'net':{'IPAddress':'172.20.0.3','Aliases':[]},'web':{'IPAddress':'172.18.0.2','Aliases':None}}}}


def art():
    return {'release':NEW,'archive':500*1024**2,'blobs':500*1024**2,
            'expanded':1600*1024**2,'largest':700*1024**2,
            'archiveConfigDigest':'sha256:'+'c'*64,'imageReference':r.image_reference(NEW),
            'loadedDockerImageId':'sha256:'+'e'*64,'rootfsDiffIds':['sha256:'+'d'*64],
            'config':copy.deepcopy(original()['Config']),'runtimeHash':r.OLD_V2_HASH}


def loaded_image(image_id=None):
    a=art();config=copy.deepcopy(a['config']);config['Labels'][r.REVISION]=NEW
    return {'Id':image_id or a['loadedDockerImageId'],'Os':'linux','Architecture':'amd64',
            'RepoTags':[a['imageReference']],'RootFS':{'Type':'layers','Layers':a['rootfsDiffIds']},
            'Size':2*r.GIB,'Config':config}


class Fake:
    def __init__(self):
        self.old=original();self.new=None;self.running=[self.old];self.template=ROUTES;self.active=ROUTES
        self.fail=None;self.events=[];self.maxwriters=1;self.db_override={};self.pointer=r.EXPECTED_OLD_SHA
        self.manifests=[];self.cloneImages=[]
        self.readability={}
    def inspect(self,name,image=False):
        if image:
            if name==r.image_reference(NEW):return loaded_image()
            return {'Id':name}
        return copy.deepcopy(self.old if name in (OLD_NAME,self.old['Id']) else self.new)
    def containers(self):return copy.deepcopy(self.running)
    def routes(self):return self.template,self.active
    def disk(self):return 43356397568,17232801792
    def db(self):
        return {'database':r.EXPECTED_DB,'applied':85,'failed':0,'ledger':LEDGER,
                'clients':[c['NetworkSettings']['Networks']['net']['IPAddress'] for c in self.running],**self.db_override}
    def health(self,name,sha,public=False):
        self.events.append(('health',name,sha,public))
        if self.fail=='health' and name==NAME:
            self.fail=None;raise r.GateError('MOCK_HEALTH_FAILURE')
        if self.fail=='public' and name==NAME and public:
            self.fail=None;raise r.GateError('MOCK_PUBLIC_FAILURE')
    def run(self,args,data=None,timeout=60):
        self.events.append(tuple(args))
        if args[:2]==['docker','exec'] and '--input-type=module' in args:
            name=args[args.index('--input-type=module')-2]
            self.events.append(('db-probe',name,timeout))
            if name==NAME and self.fail in ('db-dns','db-refused','db-query','db-timeout'):
                failure=self.fail;self.fail=None
                raise r.GateError('COMMAND_UNAVAILABLE_OR_TIMEOUT' if failure=='db-timeout' else 'COMMAND_FAILED')
            if name==NAME and self.fail=='db-bad-output':
                self.fail=None;return b'WRONG_RESULT\n'
            if name==OLD_NAME and self.fail=='old-db':
                raise r.GateError('COMMAND_FAILED')
            return r.APPLICATION_DB_PROBE_OK
        if args==['cat',r.CURRENT_SHA_FILE]:return self.pointer.encode()
        if args[-2:]==['sha256sum','/app/server/v2.js']:return (r.OLD_V2_HASH+'  /app/server/v2.js').encode()
        if args[:2]==['sh','-c'] and 'docker logs --tail' in args[2] and self.fail=='critical-log' and NAME in args[2]:
            self.fail=None;return b'FATAL fixture startup failure'
        if args[:2]==['docker','exec'] and 'mount-readability' in args:
            assert any(c['Name'].lstrip('/')==args[2] for c in self.running), 'PROBED_STOPPED_CONTAINER'
            if args[2]==NAME and self.fail=='secret-read':
                self.fail=None;return b'UNREADABLE'
            return b'READABLE' if self.readability.get((args[2],args[-1]),True) else b'UNREADABLE'
        if args[:2]==['docker','info']:
            return json.dumps({'ServerVersion':'29.1.3','Driver':'overlayfs','DockerRootDir':'/var/lib/docker',
                               'DriverStatus':[['driver-type','io.containerd.snapshotter.v1']]}).encode()
        if args[:2]==['docker','stop']:
            if self.fail=='candidate-stop' and args[-1]==NAME:raise r.GateError('STOP_FAILED')
            self.running=[c for c in self.running if c['Name'].lstrip('/')!=args[-1]]
        if args[:2]==['docker','start']:
            assert args[-1]==OLD_NAME
            if self.fail=='old-start':raise r.GateError('START_FAILED')
            self.running=[self.old]
        if args[:2]==['docker','update']:
            self.new['HostConfig']['RestartPolicy']=copy.deepcopy(self.old['HostConfig']['RestartPolicy'])
        if args[:4]==['docker','exec','-i',r.NGINX]:
            if self.fail=='active-write':
                self.fail=None;raise r.GateError('ACTIVE_WRITE_FAILED')
            self.active=data.decode()
        if args[-3:]==['nginx','-s','reload'] and self.fail=='reload':
            self.fail=None;raise r.GateError('RELOAD_FAILED')
        return b''
    def py(self,code,value=None,timeout=60):
        if 'same_fs' in code or 'os.stat(p).st_dev' in code:return b'true'
        if value and 'helper' in value:
            self.events.append(('create-start',NAME))
            assert not self.running, 'candidate started while old writer running'
            self.new=copy.deepcopy(self.old)
            self.new['Name']='/'+NAME;self.new['Id']='new-id';self.new['Image']=art()['loadedDockerImageId']
            self.new['Config']['Image']=value['image'];self.cloneImages.append(value['image'])
            self.new['Config']['Env']=[x if not x.startswith('GIT_SHA=') else 'GIT_SHA='+NEW for x in self.new['Config']['Env']]
            self.new['Config']['Labels'][r.REVISION]=NEW
            self.new['HostConfig']['RestartPolicy']={'Name':'no','MaximumRetryCount':0}
            self.new['NetworkSettings']['Networks']['net']['IPAddress']='172.20.0.4'
            self.running.append(self.new);self.maxwriters=max(self.maxwriters,len(self.running))
            if self.fail=='helper-after-start':
                self.fail=None;raise r.GateError('HELPER_FAILED')
        elif value and 'manifest' in value:
            self.manifests.append(value['manifest'])
        elif value and value.get('path')==r.CURRENT_SHA_FILE:
            self.pointer=value['text'].strip()
            if self.fail=='pointer-after':
                self.fail=None;raise r.GateError('POINTER_WRITE_FAILED')
        elif value and value.get('path')==r.TEMPLATE:
            self.template=value['text']
        self.events.append(('py', 'route' if value and 'text' in value else 'metadata'))
        return b''


class Gates(unittest.TestCase):
    def setUp(self):
        mode=patch.object(r,'MEASURE_ONLY',False);mode.start();self.addCleanup(mode.stop)
        # A stray call to actual process/network tooling fails the test immediately.
        self.no_process=patch.object(r.subprocess,'run',side_effect=AssertionError('REAL_PROCESS_FORBIDDEN'))
        self.no_process.start();self.addCleanup(self.no_process.stop)
        self.sleep=patch.object(r.time,'sleep');self.sleep.start();self.addCleanup(self.sleep.stop)
        self.signals=patch.object(r.signal,'signal');self.signals.start();self.addCleanup(self.signals.stop)
    def fail(self,code,fn,*args,**kwargs):
        with self.assertRaisesRegex(r.GateError,code):fn(*args,**kwargs)
    def test_correct_preflight(self):
        f=Fake();v=r.preflight(f,art(),LEDGER);self.assertEqual(v['name'],OLD_NAME);self.assertLessEqual(v['budget']['projectedUsage'],85)
        self.assertFalse(any(e[0]=='create-start' for e in f.events))
    def test_wrong_production_sha(self):
        f=Fake();f.old['Config']['Labels'][r.REVISION]=NEW
        self.fail('PRODUCTION_SHA',r.preflight,f,art(),LEDGER)
    def test_wrong_db(self):
        f=Fake();f.db_override['database']='other';self.fail('DATABASE_AUTHORITY',r.preflight,f,art(),LEDGER)
    def test_wrong_migration_count(self):
        f=Fake();f.db_override['applied']=84;self.fail('MIGRATION_LEDGER',r.preflight,f,art(),LEDGER)
    def test_failed_migration(self):
        f=Fake();f.db_override['failed']=1;self.fail('MIGRATION_LEDGER',r.preflight,f,art(),LEDGER)
    def test_wrong_checksum(self):
        f=Fake();f.db_override['ledger']={};self.fail('MIGRATION_CHECKSUM',r.preflight,f,art(),LEDGER)
    def test_disk_low(self):
        f=Fake();f.disk=lambda:(50*r.GIB,5*r.GIB);self.fail('ARTIFACT_DISK_GATE_FAIL',r.preflight,f,art(),LEDGER)
    def test_disk_percent_threshold(self):
        f=Fake();f.disk=lambda:(50*r.GIB,8*r.GIB);self.fail('ARTIFACT_DISK_GATE_FAIL',r.preflight,f,art(),LEDGER)
    def test_artifact_peak_cap(self):
        a=art();a['expanded']=4*r.GIB;self.fail('ARTIFACT_DISK_GATE_FAIL:ABSOLUTE_PEAK',r.preflight,Fake(),a,LEDGER)
    def test_exact_allowlist_pass(self):
        r.validate_identity(NEW,r.RELEASE_BASE,True,r.ALLOWLIST,[],True)
    def test_wrong_ancestry(self):
        self.fail('ANCESTRY',r.validate_identity,NEW,r.EXPECTED_OLD_SHA,False,r.ALLOWLIST,[],True)
    def test_outside_allowlist(self):
        self.fail('ALLOWLIST',r.validate_identity,NEW,r.RELEASE_BASE,True,r.ALLOWLIST|{'server/v2.js'},[],True)
    def test_schema_changed(self):
        self.fail('SCHEMA_CHANGED',r.validate_identity,NEW,r.RELEASE_BASE,True,r.ALLOWLIST,['prisma/schema.prisma'],True)
    def test_dirty_tree(self):
        self.fail('WORKTREE_NOT_CLEAN',r.validate_identity,NEW,r.RELEASE_BASE,True,r.ALLOWLIST,[],False)
    def test_old_release_parent_cannot_authorize_new_ci_release(self):
        self.fail('ANCESTRY',r.validate_identity,NEW,r.RUNTIME_SHA,True,r.ALLOWLIST,[],True)
    def test_loaded_image_identity_and_size(self):
        a=art(); image=loaded_image()
        image['Config']['Labels'][r.REVISION]=NEW
        r.validate_loaded_image(image,a)
        for field,value,code in [('Os','windows','ARTIFACT'),('Architecture','arm64','ARTIFACT'),('Id','wrong','ARTIFACT'),('Size',5*r.GIB,'SIZE')]:
            with self.subTest(field=field):
                wrong=copy.deepcopy(image);wrong[field]=value
                self.fail(code,r.validate_loaded_image,wrong,a)
        wrong=copy.deepcopy(image);wrong['Config']['WorkingDir']='/wrong'
        self.fail('CONFIG',r.validate_loaded_image,wrong,a)
    def test_two_writers(self):
        f=Fake();other=copy.deepcopy(f.old);other['Name']='/other';f.running.append(other)
        self.fail('WRITER_COUNT',r.preflight,f,art(),LEDGER)
    def test_url_spelling_does_not_hide_writer(self):
        f=Fake();other=copy.deepcopy(f.old);other['Name']='/other';other['Config']['Env'][1]+='?schema=public';f.running.append(other)
        self.fail('WRITER_COUNT',r.preflight,f,art(),LEDGER)
    def test_unknown_db_client(self):
        f=Fake();f.db_override['clients']=['172.20.0.99'];self.fail('UNKNOWN_DB_CLIENT',r.preflight,f,art(),LEDGER)
    def test_route_conflict(self):
        f=Fake();f.active+='\n# drift';self.fail('NGINX_AUTHORITY',r.preflight,f,art(),LEDGER)
    def test_route_count(self):
        self.fail('ROUTE_COUNT',r.route_target,ROUTES.replace('proxy_pass http://current-production:3000;','',1),ROUTES.replace('proxy_pass http://current-production:3000;','',1))
    def test_unsupported_port_binding(self):
        f=Fake();f.old['HostConfig']['PortBindings']={'3000/tcp':[{'HostPort':'9999'}]};self.fail('PORT_BINDINGS',r.preflight,f,art(),LEDGER)
    def test_resource_drift_rejected(self):
        f=Fake();f.old['HostConfig']['Memory']=1024**3;self.fail('RESOURCE_PROFILE_CHANGED',r.preflight,f,art(),LEDGER)
    def test_dns_empty_representations_equivalent(self):
        for expected, actual in ((None, []), ([], None), (None, None), ([], [])):
            with self.subTest(expected=expected, actual=actual), patch.dict(r.HOST_DEFAULTS, {'Dns': expected}):
                f=Fake();f.old['HostConfig']['Dns']=actual
                self.assertEqual(r.preflight(f,art(),LEDGER)['name'],OLD_NAME)
    def test_nonempty_dns_drift_rejected(self):
        for expected, actual in ((None, ['8.8.8.8']), ([], ['8.8.8.8']),
                                 (['8.8.8.8'], ['1.1.1.1']), (['8.8.8.8'], [])):
            with self.subTest(expected=expected, actual=actual), patch.dict(r.HOST_DEFAULTS, {'Dns': expected}):
                f=Fake();f.old['HostConfig']['Dns']=actual
                self.fail('SOURCE_RESOURCE_PROFILE_CHANGED',r.preflight,f,art(),LEDGER)
    def test_dns_empty_does_not_mask_other_resource_drift(self):
        f=Fake();f.old['HostConfig']['Dns']=[];f.old['HostConfig']['Memory']=1024**3
        self.fail('SOURCE_RESOURCE_PROFILE_CHANGED',r.preflight,f,art(),LEDGER)
        f=Fake();f.old['HostConfig']['Dns']=[];f.old['HostConfig']['DnsSearch']=None
        self.fail('SOURCE_RESOURCE_PROFILE_CHANGED',r.preflight,f,art(),LEDGER)
    def test_restart_policy_admission(self):
        f=Fake();f.old['HostConfig']['RestartPolicy']['Name']='always';self.fail('RESTART_POLICY',r.preflight,f,art(),LEDGER)
    def test_clone_dns_empty_representations_equivalent(self):
        for old_dns, new_dns in ((None, []), ([], None), (None, None), ([], [])):
            with self.subTest(old=old_dns, candidate=new_dns):
                a=original();b=copy.deepcopy(a)
                a['HostConfig']['Dns']=old_dns;b['HostConfig']['Dns']=new_dns
                r.clone_parity(a,b,r.EXPECTED_OLD_SHA)
    def test_clone_dns_identical_nonempty_preserved(self):
        a=original();a['HostConfig']['Dns']=['8.8.8.8','1.1.1.1'];b=copy.deepcopy(a)
        r.clone_parity(a,b,r.EXPECTED_OLD_SHA)
    def test_clone_dns_real_or_invalid_differences_rejected(self):
        pairs=((None,['8.8.8.8']),([],['8.8.8.8']),(['8.8.8.8'],None),
               (['8.8.8.8'],[]),(['8.8.8.8'],['1.1.1.1']),
               (['8.8.8.8','1.1.1.1'],['1.1.1.1','8.8.8.8']),
               ([],''),([],False),([],{}))
        for old_dns, new_dns in pairs:
            with self.subTest(old=old_dns, candidate=new_dns):
                a=original();b=copy.deepcopy(a)
                a['HostConfig']['Dns']=old_dns;b['HostConfig']['Dns']=new_dns
                self.fail('CLONE_RESOURCE_PROFILE_MISMATCH',r.clone_parity,a,b,r.EXPECTED_OLD_SHA)
    def test_clone_dns_empty_does_not_mask_other_resource_drift(self):
        for field, value in (('Memory',1024**3),('CpuShares',512),('NanoCpus',10**9),
                             ('DnsSearch',None),('DnsOptions',None)):
            with self.subTest(field=field):
                a=original();b=copy.deepcopy(a)
                a['HostConfig']['Dns']=[];b['HostConfig']['Dns']=None
                b['HostConfig'][field]=value
                self.fail('CLONE_RESOURCE_PROFILE_MISMATCH',r.clone_parity,a,b,r.EXPECTED_OLD_SHA)
    def test_empty_dns_clone_reaches_db_probe_before_switch(self):
        for old_dns, new_dns in (([],None),(None,[])):
            with self.subTest(old=old_dns,candidate=new_dns):
                f=Fake();f.old['HostConfig']['Dns']=old_dns
                original_py=f.py
                def clone_with_docker_dns(code,value=None,timeout=60):
                    result=original_py(code,value,timeout)
                    if value and 'helper' in value:f.new['HostConfig']['Dns']=new_dns
                    return result
                with patch.object(f,'py',side_effect=clone_with_docker_dns), patch('sys.stdout',new=io.StringIO()):
                    r.execute_loaded(f,art(),LEDGER,'fixture-helper','old-id',r.digest(ROUTES.encode()))
                self.assertEqual(f.maxwriters,1);self.assertEqual(f.pointer,NEW)
                self.assertEqual(f.running,[f.new]);self.assertEqual(f.active.count(NAME),3)
                self.assertLess(f.events.index(('docker','stop','--time','30',OLD_NAME)),f.events.index(('create-start',NAME)))
                self.assertLess(f.events.index(('db-probe',NAME,r.APPLICATION_DB_PROBE_TIMEOUT)),f.events.index(('py','route')))
    def test_real_clone_resource_drift_rolls_back_before_switch(self):
        for field,value in (('Dns',['8.8.8.8']),('Memory',1024**3)):
            with self.subTest(field=field):
                f=Fake();f.old['HostConfig']['Dns']=[]
                original_py=f.py
                def clone_with_resource_drift(code,value_input=None,timeout=60):
                    result=original_py(code,value_input,timeout)
                    if value_input and 'helper' in value_input:
                        f.new['HostConfig']['Dns']=None;f.new['HostConfig'][field]=value
                    return result
                with patch.object(f,'py',side_effect=clone_with_resource_drift):
                    with self.assertRaisesRegex(r.GateError,'CLONE_RESOURCE_PROFILE_MISMATCH') as raised:
                        r.execute_loaded(f,art(),LEDGER,'fixture-helper','old-id',r.digest(ROUTES.encode()))
                self.assertEqual(raised.exception.failure_stage,'CANDIDATE_CLONE_PARITY')
                self.assertEqual(raised.exception.deployment_result,'DEPLOY_ROLLED_BACK')
                self.assertEqual(f.running,[f.old]);self.assertEqual(f.maxwriters,1)
                self.assertEqual(f.routes(),(ROUTES,ROUTES));self.assertEqual(f.pointer,r.EXPECTED_OLD_SHA)
                self.assertNotIn(('py','route'),f.events)
                self.assertNotIn(('db-probe',NAME,r.APPLICATION_DB_PROBE_TIMEOUT),f.events)
                self.assertIn(('db-probe',OLD_NAME,r.APPLICATION_DB_PROBE_TIMEOUT),f.events)
    def test_group_inheritance_enforced(self):
        a=original();b=copy.deepcopy(a);b['HostConfig']['GroupAdd']=[]
        self.fail('CLONE_HOST_CONFIG',r.clone_parity,a,b,r.EXPECTED_OLD_SHA)
    def test_env_drift_enforced(self):
        a=original();b=copy.deepcopy(a);b['Config']['Env'].append('UNEXPECTED=true')
        self.fail('CLONE_ENV',r.clone_parity,a,b,r.EXPECTED_OLD_SHA)
    def test_cutover_succeeds_single_writer(self):
        f=Fake()
        codes=[];original_py=f.py
        def record_py(code,value=None,timeout=60):
            codes.append(code)
            return original_py(code,value,timeout)
        with patch.object(f,'py',side_effect=record_py),patch('sys.stdout',new=io.StringIO()):
            r.execute_loaded(f,art(),LEDGER,'fixture-helper','old-id',r.digest(ROUTES.encode()))
        self.assertTrue(any('os.rmdir' in code and r.LOCK in code for code in codes))
        self.assertEqual(f.maxwriters,1);self.assertEqual(f.running[0]['Name'],'/'+NAME)
        self.assertEqual(f.active.count(NAME),3);self.assertIn('isolated-test',f.active);self.assertEqual(f.pointer,NEW)
        self.assertEqual(f.cloneImages,[art()['imageReference']])
        manifest=f.manifests[0]
        self.assertEqual(manifest['candidateImageReference'],art()['imageReference'])
        self.assertEqual(manifest['candidateLoadedImageId'],art()['loadedDockerImageId'])
        self.assertEqual(manifest['candidateArchiveConfigDigest'],art()['archiveConfigDigest'])
        self.assertEqual(manifest['oldSha'],r.EXPECTED_OLD_SHA)
        self.assertNotIn('candidateImage',manifest)
        stop=f.events.index(('docker','stop','--time','30',OLD_NAME));start=f.events.index(('create-start',NAME));self.assertLess(stop,start)
        health=f.events.index(('health',NAME,NEW,False))
        probe=f.events.index(('db-probe',NAME,r.APPLICATION_DB_PROBE_TIMEOUT))
        switch=f.events.index(('py','route'))
        self.assertLess(start,health);self.assertLess(health,probe);self.assertLess(probe,switch)
        command=next(e for e in f.events if e[:2]==('docker','exec') and '--input-type=module' in e)
        self.assertEqual(command[command.index('--input-type=module')-2],NAME)
        self.assertIn("SELECT 1 AS ok",command[-1]);self.assertNotIn(r.PG,command)
        self.assertIn('default_transaction_read_only=on',command[command.index('-e')+1])
        self.assertNotIn('DATABASE_URL',str(command))
        self.assertEqual(f.maxwriters,1)
    def test_candidate_application_db_probe_failures_restore_exact_old(self):
        for failure in ('db-dns','db-refused','db-query','db-timeout','db-bad-output'):
            with self.subTest(failure=failure):
                f=Fake();f.fail=failure
                with self.assertRaisesRegex(r.GateError,'CANDIDATE_APPLICATION_DB_PROBE_FAILED') as raised:
                    r.execute_loaded(f,art(),LEDGER,'fixture-helper','old-id',r.digest(ROUTES.encode()))
                self.assertEqual(raised.exception.failure_stage,'CANDIDATE_APPLICATION_DB_PROBE')
                self.assertEqual(raised.exception.deployment_result,'DEPLOY_ROLLED_BACK')
                self.assertEqual(f.running,[f.old]);self.assertEqual(f.maxwriters,1)
                self.assertEqual(f.routes(),(ROUTES,ROUTES));self.assertEqual(f.pointer,r.EXPECTED_OLD_SHA)
                self.assertNotIn(('py','route'),f.events)
                candidate_probe=f.events.index(('db-probe',NAME,r.APPLICATION_DB_PROBE_TIMEOUT))
                candidate_stop=f.events.index(('docker','stop','--time','30',NAME))
                old_start=f.events.index(('docker','start',OLD_NAME))
                old_health=f.events.index(('health',OLD_NAME,r.EXPECTED_OLD_SHA,False),old_start)
                old_probe=f.events.index(('db-probe',OLD_NAME,r.APPLICATION_DB_PROBE_TIMEOUT))
                self.assertLess(candidate_probe,candidate_stop)
                self.assertLess(candidate_stop,old_start)
                self.assertLess(old_start,old_health)
                self.assertLess(old_health,old_probe)
                r.writer_check(f.containers(),f.db(),[OLD_NAME])
    def test_candidate_db_probe_failure_and_rollback_failure_is_severe(self):
        f=Fake();f.fail='db-query'
        original_run=f.run
        def fail_old_start(args,data=None,timeout=60):
            if args==['docker','start',OLD_NAME]:raise r.GateError('START_FAILED')
            return original_run(args,data,timeout)
        with patch.object(f,'run',side_effect=fail_old_start):
            with self.assertRaisesRegex(r.GateError,'CANDIDATE_DB_PROBE_FAILED_AND_ROLLBACK_FAILED') as raised:
                r.execute_loaded(f,art(),LEDGER,'fixture-helper','old-id',r.digest(ROUTES.encode()))
        self.assertEqual(raised.exception.failure_stage,'CANDIDATE_APPLICATION_DB_PROBE')
        self.assertEqual(raised.exception.deployment_result,'DEPLOY_BLOCKED')
        self.assertNotIn(('py','route'),f.events)
    def test_candidate_probe_failure_boundary_is_fixed_and_secret_safe(self):
        f=Fake();f.fail='db-query';output=io.StringIO()
        value={'art':art(),'ledger':LEDGER,'helper':'fixture-helper',
               'oldId':'old-id','routeHash':r.digest(ROUTES.encode())}
        with patch.object(r,'LocalRemote',return_value=f),patch('sys.stdout',new=output):
            r.run_loaded_controller(value)
        self.assertEqual(json.loads(output.getvalue()),
                         {'result':'DEPLOY_ROLLED_BACK',
                          'failureGate':'CANDIDATE_APPLICATION_DB_PROBE',
                          'code':'CANDIDATE_APPLICATION_DB_PROBE_FAILED'})
        self.assertNotIn('FIXTURE_ONLY',output.getvalue())
    def test_old_app_db_probe_failure_prevents_rollback_complete(self):
        f=Fake();f.fail='db-query'
        original_run=f.run
        def fail_old_db(args,data=None,timeout=60):
            if args[:2]==['docker','exec'] and '--input-type=module' in args and OLD_NAME in args:
                raise r.GateError('COMMAND_FAILED')
            return original_run(args,data,timeout)
        with patch.object(f,'run',side_effect=fail_old_db):
            self.fail('CANDIDATE_DB_PROBE_FAILED_AND_ROLLBACK_FAILED',r.execute_loaded,
                      f,art(),LEDGER,'fixture-helper','old-id',r.digest(ROUTES.encode()))
    def test_post_transfer_probe_rollback_restores_exact_production_sha(self):
        production='2fa28a6399c8a9f4fd70188d8df077f0b411589e'
        with patch.object(r,'EXPECTED_OLD_SHA',production):
            f=Fake();f.fail='db-refused'
            self.fail('CANDIDATE_APPLICATION_DB_PROBE_FAILED',r.execute_loaded,
                      f,art(),LEDGER,'fixture-helper','old-id',r.digest(ROUTES.encode()))
            self.assertEqual(f.running,[f.old])
            self.assertIn(('health',OLD_NAME,production,True),f.events)
            self.assertEqual(f.pointer,production)
            r.writer_check(f.containers(),f.db(),[OLD_NAME])
    def test_mutation_m1_skip_probe_is_rejected(self):
        f=Fake();f.fail='db-query'
        with patch.object(r,'application_db_probe',return_value=None),patch('sys.stdout',new=io.StringIO()):
            with self.assertRaises(AssertionError):
                with self.assertRaisesRegex(r.GateError,'CANDIDATE_APPLICATION_DB_PROBE_FAILED'):
                    r.execute_loaded(f,art(),LEDGER,'fixture-helper','old-id',r.digest(ROUTES.encode()))
    def test_mutation_m2_failure_as_success_is_rejected(self):
        f=Fake();f.fail='db-query';original_run=f.run
        def false_success(args,data=None,timeout=60):
            if args[:2]==['docker','exec'] and '--input-type=module' in args:
                return r.APPLICATION_DB_PROBE_OK
            return original_run(args,data,timeout)
        with patch.object(f,'run',side_effect=false_success),patch('sys.stdout',new=io.StringIO()):
            with self.assertRaises(AssertionError):
                with self.assertRaisesRegex(r.GateError,'CANDIDATE_APPLICATION_DB_PROBE_FAILED'):
                    r.execute_loaded(f,art(),LEDGER,'fixture-helper','old-id',r.digest(ROUTES.encode()))
    def test_mutation_m3_postgres_container_target_is_rejected(self):
        original_probe=r.application_db_probe
        def wrong_target(remote,name,code):
            return original_probe(remote,r.PG,code)
        f=Fake()
        with patch.object(r,'application_db_probe',side_effect=wrong_target),patch('sys.stdout',new=io.StringIO()):
            r.execute_loaded(f,art(),LEDGER,'fixture-helper','old-id',r.digest(ROUTES.encode()))
        probe_target=next(e[1] for e in f.events if e[0]=='db-probe')
        with self.assertRaises(AssertionError):
            assert probe_target==NAME
    def test_mutation_m4_no_old_restart_is_rejected(self):
        f=Fake();f.fail='db-query'
        def incomplete_rollback(remote,state,ledger):
            remote.run(['docker','stop','--time','30',state['candidate']])
        with patch.object(r,'rollback',side_effect=incomplete_rollback):
            self.fail('CANDIDATE_APPLICATION_DB_PROBE_FAILED',r.execute_loaded,
                      f,art(),LEDGER,'fixture-helper','old-id',r.digest(ROUTES.encode()))
        with self.assertRaises(AssertionError):
            assert f.running==[f.old]
    def test_cutover_failure_matrix_restores_old(self):
        for failure in ['helper-after-start','health','secret-read','critical-log','active-write','reload','public','pointer-after']:
            with self.subTest(failure=failure):
                f=Fake();f.fail=failure
                with self.assertRaises(r.GateError):r.execute_loaded(f,art(),LEDGER,'fixture-helper','old-id',r.digest(ROUTES.encode()))
                self.assertEqual(f.running,[f.old]);self.assertEqual(f.routes(),(ROUTES,ROUTES));self.assertEqual(f.maxwriters,1)
                self.assertIn(('health',OLD_NAME,r.EXPECTED_OLD_SHA,True),f.events)
    def test_post_cutover_disk_failure_restores_old(self):
        f=Fake()
        with patch.object(f,'disk',side_effect=[(40*r.GIB,16*r.GIB),(50*r.GIB,8*r.GIB)]):
            self.fail('POST_DEPLOY_HEADROOM',r.execute_loaded,f,art(),LEDGER,'fixture-helper','old-id',r.digest(ROUTES.encode()))
        self.assertEqual(f.running,[f.old]);self.assertEqual(f.routes(),(ROUTES,ROUTES))
        self.assertEqual(f.pointer,r.EXPECTED_OLD_SHA);self.assertEqual(f.maxwriters,1)
    def test_rollback_cannot_start_old_until_candidate_stopped(self):
        f=Fake();f.running=[];f.py('',{'helper':'fixture','image':r.image_reference(NEW)});f.fail='candidate-stop'
        self.fail('STOP_FAILED',r.rollback,f,{'candidate_attempted':True,'old_stop_attempted':True,'candidate':NAME,'name':OLD_NAME},LEDGER)
        self.assertNotIn(('docker','start',OLD_NAME),f.events)
    def test_rollback_target(self):
        self.assertEqual(r.EXPECTED_OLD_SHA,'fc57da5a6e6611c66ed1db286336dc0e1752d69c')
    def test_authority_change_before_stop(self):
        f=Fake()
        self.fail('AUTHORITY_CHANGED',r.execute_loaded,f,art(),LEDGER,'helper','different-id',r.digest(ROUTES.encode()))
        self.assertFalse(any(e[:2]==('docker','stop') for e in f.events))
    def test_missing_authorization_prevents_io(self):
        self.fail('AUTHORIZATION',r.deploy,Fake(),Path('.'),Path('not-present'),art(),LEDGER,None)
    def test_artifact_import_timeout_is_explicit_and_keeps_uncertain_lock(self):
        class ImportRemote:
            ssh=['ssh','fixture']
            def __init__(self):self.codes=[];self.commands=[]
            def py(self,code,value=None,timeout=60):self.codes.append(code);return b''
            def run(self,args,data=None,timeout=60):self.commands.append(args);return b''
        remote=ImportRemote()
        with tempfile.TemporaryDirectory() as directory:
            archive=Path(directory)/'image.tar';archive.write_bytes(b'fixture archive')
            a=art();a['archiveHash']=r.digest(archive.read_bytes());a['layers']=[]
            state={'diskUsed':40*r.GIB,'diskAvailable':20*r.GIB,'budget':{},'old':{'Id':'old-id'},'template':ROUTES}
            with patch.object(r,'preflight',return_value=state),\
                 patch.object(r,'stage_artifact',return_value='/opt/budu/.release-staging/'+NEW+'.tar'),\
                 patch.object(r.subprocess,'run',side_effect=r.subprocess.TimeoutExpired('docker load',1800)) as load,\
                 patch('sys.stdout',new=io.StringIO()):
                self.fail('ARTIFACT_LOAD_TIMEOUT',r.deploy,remote,Path(directory),archive,a,LEDGER,NEW)
            self.assertEqual(load.call_args.kwargs['timeout'],1800)
            self.assertNotIn('stdin',load.call_args.kwargs)
            self.assertIn('/opt/budu/.release-staging/'+NEW+'.tar',load.call_args.args[0][-1])
            self.assertIn("['docker','load','-i',sys.argv[1]]",r.LOCAL_IMPORT_CODE)
        self.assertEqual(len(remote.codes),1)
        self.assertIn('os.mkdir',remote.codes[0])
        self.assertFalse(any(cmd[:2]==['docker','stop'] for cmd in remote.commands))
    def test_completed_artifact_import_hands_off_lock(self):
        class ImportRemote:
            ssh=['ssh','fixture']
            def __init__(self):self.codes=[]
            def py(self,code,value=None,timeout=60):
                self.codes.append(code)
                return json.dumps({'result':'DEPLOY_COMPLETE'}).encode() if value else b''
            def run(self,args,data=None,timeout=60):return b''
            def disk(self):return 41*r.GIB,19*r.GIB
        remote=ImportRemote()
        with tempfile.TemporaryDirectory() as directory:
            archive=Path(directory)/'image.tar';archive.write_bytes(b'fixture archive')
            a=art();a['archiveHash']=r.digest(archive.read_bytes());a['layers']=[]
            state={'diskUsed':40*r.GIB,'diskAvailable':20*r.GIB,'budget':{},'old':{'Id':'old-id'},'template':ROUTES}
            with patch.object(r,'preflight',return_value=state),\
                 patch.object(r,'stage_artifact',return_value='/opt/budu/.release-staging/'+NEW+'.tar'),\
                 patch.object(r,'staging_action',return_value={'cleaned':True}) as cleanup,\
                 patch.object(r.subprocess,'run',return_value=type('Result',(),{'returncode':0,'stdout':b'{"returncode":0,"elapsedSeconds":1.5}'})()) as load,\
                 patch.object(r,'resolve_loaded_image',return_value=loaded_image()),\
                 patch('sys.stdout',new=io.StringIO()):
                r.deploy(remote,Path(__file__).resolve().parents[1],archive,a,LEDGER,NEW)
            self.assertEqual(load.call_args.kwargs['timeout'],1800)
            self.assertEqual(cleanup.call_args.args[-1],'cleanup')
        self.assertEqual(len(remote.codes),2)
        self.assertIn('os.mkdir',remote.codes[0])
        self.assertIn('run_loaded_controller',remote.codes[1])
    def test_uncertain_upload_keeps_lock_and_never_imports(self):
        class UploadRemote:
            def __init__(self):self.codes=[]
            def py(self,code,value=None,timeout=60):self.codes.append(code);return b''
            def run(self,args,data=None,timeout=60):return b''
        remote=UploadRemote(); a=art(); a['layers']=[]
        state={'diskUsed':40*r.GIB,'diskAvailable':20*r.GIB,'budget':{}}
        with patch.object(r,'preflight',return_value=state),\
             patch.object(r,'stage_artifact',side_effect=r.GateError('ARTIFACT_UPLOAD_FAILED_PARTIAL_RETAINED')),\
             patch.object(r.subprocess,'run',side_effect=AssertionError('IMPORT_MUST_NOT_RUN')),\
             patch('sys.stdout',io.StringIO()):
            self.fail('ARTIFACT_UPLOAD_FAILED_PARTIAL_RETAINED',r.deploy,remote,Path('.'),Path('fixture'),a,LEDGER,NEW)
        self.assertEqual(len(remote.codes),1)
        self.assertIn('os.mkdir',remote.codes[0])
    def test_forbidden_steps_absent(self):
        source=Path(r.__file__).read_text()
        for forbidden in ['prisma migrate','docker prune','076e6e0','fe4a725']:
            self.assertNotIn(forbidden,source)
        helper_body=r.SHIPPING_BACKUP_RESTORE_CODE[len(r.SHIPPING_BOUNDED_DUMP_CODE):]
        self.assertNotIn('pg_dump',source.replace(helper_body,''))
        self.assertFalse(r.shipping_migration())
        self.assertEqual(r.MIGRATION_REQUIRED,'NO')
    def test_remote_payload_compiles(self):
        source=Path(r.__file__).read_text().rsplit("\nif __name__ == '__main__':",1)[0]
        compile(source,'remote-controller','exec')


class StagedArtifactTests(unittest.TestCase):
    def setUp(self):
        import os
        import types
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()/'stage'
        self.code=r.STAGING_CODE.replace('/opt/budu/.release-staging',str(self.root))
        self.account=types.SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid())
        self.data=b'exact artifact fixture'
        self.value={'release':NEW,'sha256':r.digest(self.data),'bytes':len(self.data)}
        self.part=self.root/(NEW+'.tar.part'); self.final=self.root/(NEW+'.tar')

    def stage(self,action,**changes):
        value={**self.value,'action':action,**changes}
        output=io.StringIO()
        with patch('sys.stdin',io.StringIO(json.dumps(value))),patch('sys.stdout',output),\
             patch('pwd.getpwnam',return_value=self.account):
            try: exec(compile(self.code,'staging-helper','exec'),{})
            except SystemExit: pass
        return json.loads(output.getvalue())

    def test_partial_bytes_are_retained_and_completed_atomically(self):
        import stat
        first=self.stage('prepare')
        self.assertEqual(first['bytes'],0)
        self.assertEqual(stat.S_IMODE(self.part.stat().st_mode),0o600)
        self.part.write_bytes(self.data[:7])
        resumed=self.stage('prepare')
        self.assertEqual(resumed['bytes'],7)
        self.assertEqual(self.part.read_bytes(),self.data[:7])
        self.part.write_bytes(self.data)
        result=self.stage('verify')
        self.assertTrue(result['verified']); self.assertEqual(result['sha256'],self.value['sha256'])
        self.assertFalse(self.part.exists()); self.assertEqual(self.final.read_bytes(),self.data)
        self.assertTrue(self.stage('prepare')['complete'])
        self.assertEqual(self.stage('cleanup'),{'cleaned':True})
        self.assertFalse(self.final.exists())

    def test_different_runner_artifact_cannot_reset_existing_partial(self):
        self.stage('prepare'); self.part.write_bytes(self.data[:7])
        result=self.stage('prepare',sha256='0'*64)
        self.assertEqual(result['error'],'STAGING_ARTIFACT_IDENTITY_CONFLICT')
        self.assertEqual(self.part.read_bytes(),self.data[:7])

    def test_hash_or_size_mismatch_deletes_only_exact_staging_files(self):
        for broken in (b'x'*len(self.data),self.data[:-1]):
            self.stage('prepare'); self.part.write_bytes(broken)
            other=self.root/'unrelated'; other.write_bytes(b'keep')
            result=self.stage('verify')
            self.assertEqual(result['error'],'STAGING_SIZE_OR_SHA256_MISMATCH')
            self.assertFalse(self.part.exists()); self.assertFalse(self.final.exists())
            self.assertEqual(other.read_bytes(),b'keep')

    def test_staging_symlink_is_rejected_without_touching_target(self):
        self.stage('prepare'); self.part.unlink()
        other=self.root/'other'; other.write_bytes(b'keep')
        self.part.symlink_to(other)
        self.assertEqual(self.stage('prepare')['error'],'STAGING_FILE_UNSAFE')
        self.assertEqual(other.read_bytes(),b'keep')

    def test_rsync_retry_reuses_same_partial_and_separate_timeout(self):
        remote=type('Remote',(),{'ssh':['ssh','-i','key','ubuntu@host'],
                                'run':lambda *args,**kwargs:b'rsync 3.2.7'})()
        archive=Path(self.temp.name)/'image.tar'; archive.write_bytes(self.data)
        a={'release':NEW,'archiveHash':self.value['sha256'],'archive':len(self.data)}
        states=[{'complete':False,'bytes':7},
                {'verified':True,'path':str(self.final),'bytes':len(self.data),'sha256':self.value['sha256']}]
        outcomes=[type('Result',(),{'returncode':255})(),type('Result',(),{'returncode':0})()]
        with patch.object(r.shutil,'which',return_value='/usr/bin/rsync'),\
             patch.object(r,'staging_action',side_effect=states),\
             patch.object(r.subprocess,'run',side_effect=outcomes) as sync,\
             patch('sys.stdout',io.StringIO()):
            self.assertEqual(r.stage_artifact(remote,archive,a),str(self.final))
        self.assertEqual(sync.call_count,2)
        self.assertEqual(sync.call_args_list[0].args,sync.call_args_list[1].args)
        args=sync.call_args.args[0]
        self.assertIn('--partial',args); self.assertIn('--append-verify',args)
        self.assertIn('--chmod=F600',args); self.assertNotIn('--delete',args)
        self.assertTrue(args[-1].endswith(NEW+'.tar.part'))
        self.assertGreater(sync.call_args.kwargs['timeout'],1800)


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        m=patch.object(r,'runtime_payload',side_effect=lambda p:{'app/server/v2.js':r.digest((p/'server/v2.js').read_bytes())})
        m.start();self.addCleanup(m.stop)
    def make(self,root,**kw):
        (root/'server').mkdir();(root/'server/v2.js').write_bytes(b'CAS fixture')
        layer_buffer=io.BytesIO()
        with tarfile.open(fileobj=layer_buffer,mode='w') as t:
            content=kw.get('body',b'CAS fixture');m=tarfile.TarInfo('app/server/v2.js');m.size=len(content);t.addfile(m,io.BytesIO(content))
        raw=layer_buffer.getvalue();blob=gzip.compress(raw) if kw.get('gzip',True) else raw
        config={'os':'linux','architecture':kw.get('arch','amd64'),'config':{'Labels':{r.REVISION:NEW}},
                'rootfs':{'diff_ids':['sha256:'+hashlib.sha256(raw).hexdigest()]}}
        if kw.get('bad_hash'):config['rootfs']['diff_ids']=['sha256:'+'0'*64]
        cb=json.dumps(config).encode();manifest=[{'Config':'config.json','RepoTags':[kw.get('tag','budu-api:transfer-cas-'+NEW[:12])],'Layers':['layer.tar']}]
        files=[('config.json',cb),('layer.tar',blob)]
        if kw.get('oci'):
            cp='blobs/sha256/'+r.digest(cb);lp='blobs/sha256/'+r.digest(blob)
            manifest[0]['Config']=cp;manifest[0]['Layers']=[lp]
            im=json.dumps({'schemaVersion':2,'config':{'digest':'sha256:'+r.digest(cb)},'layers':[{'digest':'sha256:'+r.digest(blob)}]}).encode()
            index=json.dumps({'schemaVersion':2,'manifests':[{'digest':'sha256:'+r.digest(im),'annotations':{'io.containerd.image.name':kw.get('annotation','budu-api:transfer-cas-'+NEW[:12])}}]}).encode()
            files=[(cp,cb),(lp,blob),('blobs/sha256/'+r.digest(im),im),('index.json',index),('oci-layout',b'{"imageLayoutVersion":"1.0.0"}')]
        if kw.get('extra'):files.append(('unreviewed-layer.tar',blob))
        files.append(('manifest.json',json.dumps(manifest).encode()))
        p=root/'image.tar'
        with tarfile.open(p,mode='w') as t:
            for name,data in files:
                m=tarfile.TarInfo(name);m.size=len(data);t.addfile(m,io.BytesIO(data))
        return p
    def test_gzip_expansion_measured(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);a=r.artifact(self.make(root),NEW,root)
            self.assertGreater(a['expanded'],a['blobs']);self.assertEqual(a['largest'],a['expanded'])
    def test_oci_and_docker_manifests_agree(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);r.artifact(self.make(root,oci=True),NEW,root)
    def test_buildkit_normalized_tag_names(self):
        for full_manifest in (False, True):
            with tempfile.TemporaryDirectory() as d:
                root=Path(d);tag='budu-api:transfer-cas-'+NEW[:12]
                r.artifact(self.make(root,oci=True,tag=('docker.io/library/' if full_manifest else '')+tag,
                                    annotation='docker.io/library/'+tag),NEW,root)
    def test_different_registry_or_tag_rejected(self):
        for kw in ({'tag':'other/budu-api:transfer-cas-'+NEW[:12]},
                   {'oci':True,'annotation':'evil.example/budu-api:transfer-cas-'+NEW[:12]},
                   {'tag':'budu-api:transfer-cas-'+r.EXPECTED_OLD_SHA[:12]}):
            with tempfile.TemporaryDirectory() as d:
                root=Path(d)
                with self.assertRaisesRegex(r.GateError,'TAG'):
                    r.artifact(self.make(root,**kw),NEW,root)
    def test_unreviewed_archive_member_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);p=self.make(root,extra=True)
            with self.assertRaisesRegex(r.GateError,'UNREVIEWED_ARCHIVE'):r.artifact(p,NEW,root)
    def test_plain_layer_supported(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);r.artifact(self.make(root,gzip=False),NEW,root)
    def test_architecture_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);p=self.make(root,arch='arm64')
            with self.assertRaisesRegex(r.GateError,'PLATFORM'):r.artifact(p,NEW,root)
    def test_wrong_code_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);p=self.make(root,body=b'old code')
            with self.assertRaisesRegex(r.GateError,'BUSINESS_CODE'):r.artifact(p,NEW,root)
    def test_diff_hash_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);p=self.make(root,bad_hash=True)
            with self.assertRaisesRegex(r.GateError,'DIFF_ID'):r.artifact(p,NEW,root)

class MeasurementTests(unittest.TestCase):
    def fixture(self):
        a=art()
        a.update(archive=600*1024**2,blobs=600*1024**2,expanded=2400*1024**2,largest=1100*1024**2)
        a['layers']=[{'index':0,'blobBytes':600*1024**2,'expandedPhysicalBytes':2400*1024**2,
                      'diffId':'sha256:diff','contentDigest':'sha256:blob','chainId':'sha256:chain'}]
        p={'rootfsDiffIds':['sha256:diff'],'diskUsed':45*r.GIB,'diskAvailable':12*r.GIB,
           'storage':{'ServerVersion':'29.1.3','Driver':'overlayfs','DriverStatus':[]},
           'metadata':{'metadataAvailable':True,'snapshotProof':{},'contentProof':{}}}
        return a,p
    def test_measurement_locked_and_deploy_rejected_before_io(self):
        self.assertFalse(r.MEASURE_ONLY)
        with patch.object(r,'MEASURE_ONLY',True), patch.object(r,'command',side_effect=AssertionError('IO_FORBIDDEN')):
            with self.assertRaisesRegex(r.GateError,'MEASURE_ONLY_DEPLOY_FORBIDDEN'):
                r.deploy(None,None,None,None,None,None)
            with self.assertRaisesRegex(r.GateError,'MEASURE_ONLY_DEPLOY_FORBIDDEN'):
                r.execute_loaded(None,None,None,None,None,None)
            with patch.object(sys,'argv',['release','deploy','--repo','.']):
                with self.assertRaisesRegex(r.GateError,'MEASURE_ONLY_DEPLOY_FORBIDDEN'):r.main()
    def test_production_read_adapter_rejects_mutations(self):
        remote=r.MeasurementRemote('fixture-key')
        mutations=[['docker','load'],['docker','create','image'],['docker','start','old'],
                   ['docker','stop','old'],['docker','exec',r.NGINX,'nginx','-s','reload'],
                   ['sudo','-n','python3','-c','open("/tmp/file","w")'],['sh','-c','touch /tmp/file']]
        with patch.object(r,'command',side_effect=AssertionError('IO_FORBIDDEN')):
            for args in mutations:
                with self.subTest(args=args),self.assertRaisesRegex(r.GateError,'REMOTE_MUTATION_FORBIDDEN'):
                    remote.run(args)
    def test_full_metrics_survive_cap_failure(self):
        a,_=self.fixture();m=r.artifact_metrics(a)
        self.assertEqual(m['CURRENT_FORMULA_PEAK_BYTES'],5212*1024**2)
        self.assertEqual(m['EXCESS_OVER_4GIB_BYTES'],1116*1024**2)
        self.assertEqual(r.ABSOLUTE_MAX_PEAK,6*r.GIB);self.assertEqual(r.RESERVE,512*1024**2)
        a['expanded']=4*r.GIB
        self.assertGreater(r.artifact_metrics(a)['CURRENT_FORMULA_PEAK_BYTES'],r.ABSOLUTE_MAX_PEAK)
        with self.assertRaisesRegex(r.GateError,'ARTIFACT_DISK_GATE_FAIL'):
            r.disk_budget(0,100*r.GIB,a['archive'],a['blobs'],a['expanded'],a['largest'])
    def test_same_diff_without_chain_proof_is_not_snapshot_reuse(self):
        a,p=self.fixture();m=r.disk_models(a,p)
        self.assertEqual(m['SHARED_LAYER_COUNT'],1)
        self.assertEqual(m['REUSABLE_SNAPSHOT_LAYER_COUNT'],0)
        self.assertEqual(m['UNIQUE_CANDIDATE_EXPANDED_BYTES'],a['expanded'])
    def test_unknown_content_and_snapshot_never_discounted(self):
        a,p=self.fixture();p['metadata']['metadataAvailable']=False
        m=r.disk_models(a,p)
        self.assertEqual(m['SHARED_COMPRESSED_BLOB_BYTES'],'UNKNOWN')
        self.assertEqual(m['MODELED_UNIQUE_BLOB_BYTES'],a['blobs'])
        self.assertEqual(m['UNIQUE_CANDIDATE_EXPANDED_BYTES'],a['expanded'])
    def test_confirmed_reuse_retains_shared_blob_ingest_staging(self):
        a,p=self.fixture();p['metadata']['snapshotProof']['sha256:chain']=True
        p['metadata']['contentProof']['sha256:blob']={'present':True,'fileBytes':a['layers'][0]['blobBytes']}
        m=r.disk_models(a,p)
        self.assertEqual(m['UNIQUE_CANDIDATE_EXPANDED_BYTES'],0)
        self.assertEqual(m['models']['MODEL_C_LAYER_REUSE_CONSERVATIVE']['PEAK_INCREMENT_BYTES'],r.RESERVE)
        self.assertEqual(m['models']['MODEL_C_INGEST_STAGING_CHECK']['PEAK_INCREMENT_BYTES'],a['blobs']+r.RESERVE)
    def test_ci_import_cannot_execute_on_local_or_production_host(self):
        with patch.dict(r.os.environ,{},clear=True),patch.object(r.subprocess,'Popen',side_effect=AssertionError('PROCESS_FORBIDDEN')):
            with self.assertRaisesRegex(r.GateError,'CI_MEASUREMENT_HOST_REQUIRED'):
                r.ci_import_measurement(None,None)
    def test_metadata_script_is_read_only_and_compiles(self):
        compile(r.MEASUREMENT_METADATA_SCRIPT,'readonly-metadata','exec')
        for forbidden in ('.write_', '.mkdir(', '.unlink(', "'load'", "'import'", "'delete'", "'remove'", "'pull'"):
            self.assertNotIn(forbidden,r.MEASUREMENT_METADATA_SCRIPT)
    def test_measurement_pipeline_never_calls_deploy_or_cap_gate(self):
        a,p=self.fixture()
        ci={'CI_IMAGE_SIZE':5*r.GIB,'storage':{'ServerVersion':'28.0.4','Driver':'overlay2'}}
        with patch.object(r,'MEASURE_ONLY',True),patch.object(r,'ci_import_measurement',return_value=ci),patch.object(r,'production_measurement',return_value=p),\
             patch.object(r,'deploy',side_effect=AssertionError('DEPLOY_FORBIDDEN')),\
             patch.object(r,'disk_budget',side_effect=AssertionError('CAP_MUST_NOT_HIDE_METRICS')):
            result=r.measure_release(None,None,a,None,'fixture-key')
        self.assertEqual(result['PRODUCTION_OPERATIONAL_CHANGES'],0)
        self.assertFalse(result['PRODUCTION_DEPLOYED'])
        self.assertEqual(result['artifactMetrics']['DOCKER_IMAGE_INSPECT_SIZE_GIB'],5)
        self.assertEqual(result['ciImport']['REPRESENTATIVENESS'],'NOT_DIRECTLY_REPRESENTATIVE')




class LoadedIdentityTests(unittest.TestCase):
    def test_config_addressed_store_passes(self):
        a=art();a['loadedDockerImageId']=a['archiveConfigDigest'];image=loaded_image(a['archiveConfigDigest'])
        with patch.object(r.Remote,'inspect',return_value=image):
            self.assertEqual(r.resolve_loaded_image(r.Remote('unused'),a)['Id'],a['archiveConfigDigest'])
    def test_manifest_addressed_store_passes(self):
        a=art();image=loaded_image();self.assertNotEqual(image['Id'],a['archiveConfigDigest'])
        with patch.object(r.Remote,'run',return_value=json.dumps([image]).encode()) as call:
            self.assertEqual(r.resolve_loaded_image(r.Remote('unused'),a),image)
        call.assert_called_once_with(['docker','image','inspect',a['imageReference']])
    def test_wrong_missing_and_multiple_repo_tags_fail(self):
        for tags in ([],None,['budu-api:wrong'],[art()['imageReference'],'budu-api:other'],[art()['imageReference']]*2):
            image=loaded_image();image['RepoTags']=tags
            with self.subTest(tags=tags),self.assertRaisesRegex(r.GateError,'TAG_MISMATCH'):
                r.validate_loaded_image(image,art())
    def test_missing_or_ambiguous_inspect_result_fails(self):
        for objects in ([],[loaded_image(),loaded_image()]):
            with patch.object(r.Remote,'run',return_value=json.dumps(objects).encode()),self.assertRaisesRegex(r.GateError,'IDENTITY_NOT_UNIQUE'):
                r.resolve_loaded_image(r.Remote('unused'),art())
    def test_wrong_release_label_fails(self):
        image=loaded_image();image['Config']['Labels'][r.REVISION]=r.EXPECTED_OLD_SHA
        with self.assertRaisesRegex(r.GateError,'ARTIFACT_MISMATCH'):r.validate_loaded_image(image,art())
    def test_wrong_architecture_or_platform_fails(self):
        for key,value in [('Architecture','arm64'),('Os','windows')]:
            image=loaded_image();image[key]=value
            with self.subTest(key=key),self.assertRaisesRegex(r.GateError,'ARTIFACT_MISMATCH'):
                r.validate_loaded_image(image,art())
    def test_rootfs_mismatch_or_missing_fails(self):
        for fs in ({},{'Layers':[]},{'Layers':['sha256:'+'f'*64]}):
            image=loaded_image();image['RootFS']=fs
            with self.subTest(fs=fs),self.assertRaisesRegex(r.GateError,'ROOTFS_MISMATCH'):
                r.validate_loaded_image(image,art())
    def test_every_config_identity_field_enforced(self):
        for key in r.IDENTITY_KEYS:
            image=loaded_image();image['Config'][key]='wrong'
            with self.subTest(key=key),self.assertRaisesRegex(r.GateError,'CONFIG_MISMATCH'):
                r.validate_loaded_image(image,art())
    def test_exact_reference_required_before_lookup(self):
        for ref in (art()['archiveConfigDigest'],'budu-api:transfer-cas-aaaa','budu-api:other'):
            a=art();a['imageReference']=ref
            with patch.object(r.Remote,'run',side_effect=AssertionError('LOOKUP_FORBIDDEN')),self.assertRaisesRegex(r.GateError,'REFERENCE_INVALID'):
                r.resolve_loaded_image(r.Remote('unused'),a)
    def test_retag_after_load_is_rejected(self):
        with patch.object(r.Remote,'inspect',return_value=loaded_image('sha256:'+'f'*64)),self.assertRaisesRegex(r.GateError,'LOADED_IMAGE_CHANGED'):
            r.resolve_loaded_image(r.Remote('unused'),art())
    def test_candidate_image_id_and_reference_enforced(self):
        a=art();candidate={'Image':a['loadedDockerImageId'],'Config':{'Image':a['imageReference']}}
        r.validate_candidate_image(candidate,a)
        for bad in ({'Image':a['archiveConfigDigest'],'Config':candidate['Config']},
                    {'Image':candidate['Image'],'Config':{'Image':a['archiveConfigDigest']}}):
            with self.assertRaisesRegex(r.GateError,'CANDIDATE_IMAGE_IDENTITY'):r.validate_candidate_image(bad,a)
    def test_no_config_digest_runtime_lookup_or_prefix_fallback(self):
        source=Path(r.__file__).read_text()
        self.assertNotIn("art['imageId']",source)
        self.assertNotIn("inspect(art['archiveConfigDigest']",source)
        self.assertNotIn("'image':art['archiveConfigDigest']",source)
        self.assertIn("cli+['image','inspect',art['imageReference']]",source)
    def test_archive_returns_separate_identity_evidence(self):
        suite=ArchiveTests();suite.setUp()
        try:
            with tempfile.TemporaryDirectory() as d:
                root=Path(d);a=r.artifact(suite.make(root,oci=True),NEW,root)
                self.assertEqual(a['imageReference'],r.image_reference(NEW))
                self.assertRegex(a['archiveConfigDigest'],r'^sha256:[0-9a-f]{64}$')
                self.assertEqual(a['rootfsDiffIds'],[x['diffId'] for x in a['layers']])
                self.assertNotIn('imageId',a)
        finally:suite.doCleanups()
    def test_full_runtime_payload_mismatch_remains_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);path=ArchiveTests().make(root)
            with patch.object(r,'runtime_payload',return_value={'app/server/v2.js':r.digest(b'CAS fixture'),'app/package.json':'missing'}):
                with self.assertRaisesRegex(r.GateError,'ARTIFACT_RUNTIME_PAYLOAD_MISMATCH'):
                    r.artifact(path,NEW,root)

class DynamicDiskTests(unittest.TestCase):
    # Exact measured archive from the previous hosted-runner audit; final build
    # must still be independently measured and admitted against fresh disk.
    MEASURED = (566605824, 566585075, 2094616576, 1155629056)
    def budget(self, used=43356397568, available=17232801792, peak=None):
        values=list(self.MEASURED)
        if peak is not None:values[2]=peak-values[0]-values[1]-values[3]-r.RESERVE
        return r.disk_budget(used,available,*values)
    def test_exact_measured_artifact_and_cleaned_baseline_pass(self):
        b=self.budget()
        self.assertAlmostEqual(b['peakIncrement']/r.GIB,4.582393396,places=8)
        self.assertEqual(b['projectedUsage'],80)
        self.assertGreater(b['projectedAvailable']/r.GIB,11.46)
    def test_rounded_4_58_peak_passes_current_baseline(self):
        self.assertEqual(self.budget(peak=round(4.58*r.GIB))['projectedUsage'],80)
    def test_absolute_six_gib_boundary(self):
        self.budget(used=30*r.GIB,available=30*r.GIB,peak=6*r.GIB)
        with self.assertRaisesRegex(r.GateError,'ARTIFACT_DISK_GATE_FAIL:ABSOLUTE_PEAK'):
            self.budget(used=30*r.GIB,available=30*r.GIB,peak=6*r.GIB+1)
    def test_usage_alone_fails_even_with_ten_gib_available(self):
        with self.assertRaisesRegex(r.GateError,'DYNAMIC_HEADROOM'):
            self.budget(used=90*r.GIB,available=15*r.GIB)
    def test_available_alone_fails_even_with_low_usage(self):
        with self.assertRaisesRegex(r.GateError,'DYNAMIC_HEADROOM'):
            self.budget(used=10*r.GIB,available=14*r.GIB)
    def test_exact_dynamic_boundaries(self):
        b=self.budget(used=80*r.GIB,available=20*r.GIB,peak=5*r.GIB)
        self.assertEqual(b['projectedUsage'],85)
        self.assertEqual(self.budget(used=20*r.GIB,available=15*r.GIB,peak=5*r.GIB)['projectedAvailable'],10*r.GIB)
        with self.assertRaisesRegex(r.GateError,'DYNAMIC_HEADROOM'):
            self.budget(used=20*r.GIB,available=15*r.GIB-1,peak=5*r.GIB)
    def test_old_eighty_one_percent_baseline_fails(self):
        with self.assertRaisesRegex(r.GateError,'DYNAMIC_HEADROOM'):
            self.budget(used=48656379904,available=11932819456)
    def test_other_artifact_bounds_remain_unchanged(self):
        self.assertEqual(r.MAX_ARCHIVE,768*1024**2)
        self.assertEqual(r.MAX_LAYER_STREAM,4*r.GIB)
        self.assertEqual(r.MAX_IMAGE_SIZE,4*r.GIB)
        self.assertEqual(r.MAX_MEMBERS,150000)
    def test_post_import_gate_fails_before_old_writer_stop(self):
        f=Fake();f.disk=lambda:(40*r.GIB,10*r.GIB)
        with patch.object(r.signal,'signal'),self.assertRaisesRegex(r.GateError,'POST_IMPORT_HEADROOM'):
            r.execute_loaded(f,art(),LEDGER,'fixture','old-id',r.digest(ROUTES.encode()))
        self.assertFalse(any(e[:2]==('docker','stop') for e in f.events))

class MountParityTests(unittest.TestCase):
    setUp = Gates.setUp
    fail = Gates.fail

    def candidate(self, old_readable=True, new_readable=True):
        f=Fake();destination=f.old['Mounts'][0]['Destination']
        f.readability[(OLD_NAME,destination)]=old_readable
        baseline=r.mount_readability(f,OLD_NAME)
        f.running=[];f.py('',{'helper':'fixture','image':r.image_reference(NEW)})
        f.new['HostConfig']['RestartPolicy']=copy.deepcopy(f.old['HostConfig']['RestartPolicy'])
        f.readability[(NAME,destination)]=new_readable
        return f,baseline

    def check(self,f,baseline):r.runtime_checks(f,NAME,r.OLD_V2_HASH,baseline)
    def test_readable_to_readable(self):self.check(*self.candidate(True,True))
    def test_readable_to_unreadable(self):self.fail('READABILITY_PARITY',self.check,*self.candidate(True,False))
    def test_unreadable_to_unreadable(self):self.check(*self.candidate(False,False))
    def test_unreadable_to_readable_expansion(self):self.fail('READABILITY_PARITY',self.check,*self.candidate(False,True))
    def test_missing_mount(self):
        f,b=self.candidate();f.new['Mounts'].pop();self.fail('IDENTITY_PARITY',self.check,f,b)
    def test_source_changed(self):
        f,b=self.candidate();f.new['Mounts'][0]['Source']='/different';self.fail('IDENTITY_PARITY',self.check,f,b)
    def test_volume_source_changed_same_name(self):
        f,b=self.candidate();f.new['Mounts'][1]['Source']='/different';self.fail('IDENTITY_PARITY',self.check,f,b)
    def test_destination_changed(self):
        f,b=self.candidate();f.new['Mounts'][0]['Destination']='/different';self.fail('IDENTITY_PARITY',self.check,f,b)
    def test_rw_changed(self):
        f,b=self.candidate();f.new['Mounts'][0]['RW']=True;self.fail('IDENTITY_PARITY',self.check,f,b)
    def test_group_changed(self):
        f,b=self.candidate();f.new['HostConfig']['GroupAdd']=[];self.fail('CLONE_HOST_CONFIG',r.clone_parity,f.old,f.new,NEW)
    def test_user_changed(self):
        f,b=self.candidate();f.new['Config']['User']='root';self.fail('CLONE_CONFIG',r.clone_parity,f.old,f.new,NEW)
    def test_health_failure_rolls_back(self):
        f=Fake();f.fail='health'
        self.fail('MOCK_HEALTH_FAILURE',r.execute_loaded,f,art(),LEDGER,'fixture','old-id',r.digest(ROUTES.encode()))
        self.assertEqual(f.running,[f.old])
    def test_live_code_hash_mismatch(self):
        f,b=self.candidate();self.fail('LIVE_TRANSFER_CODE_MISMATCH',r.runtime_checks,f,NAME,'0'*64,b)
    def test_critical_startup_log(self):
        f,b=self.candidate();f.fail='critical-log';self.fail('CRITICAL_STARTUP_LOG',self.check,f,b)
    def test_production_like_five_root_0600_unreadable_with_health(self):
        f=Fake()
        # Model the verified test-r outcomes under node + GroupAdd 0. Ownership
        # metadata documents the fixture; no secret content or chmod is involved.
        fixture=[{'uid':0,'gid':0,'mode':0o600,'readable':False} for _ in range(5)]
        for i,permission in enumerate(fixture):
            dest='/fixture/ro-'+str(i)
            f.old['Mounts'].append({'Type':'bind','Source':dest,'Destination':dest,'RW':False})
            for name in (OLD_NAME,NAME):f.readability[(name,dest)]=permission['readable']
        with patch('sys.stdout',new=io.StringIO()):r.execute_loaded(f,art(),LEDGER,'fixture','old-id',r.digest(ROUTES.encode()))
        self.assertEqual(f.pointer,NEW);self.assertEqual(f.maxwriters,1)
        self.assertIn(('health',NAME,NEW,False),f.events)
        baseline=f.manifests[0]['authorityMountReadability']
        self.assertEqual(sum(not x['readable'] for x in baseline),5)
        self.assertNotIn('/fixture/',json.dumps(baseline))
        stop=f.events.index(('docker','stop','--time','30',OLD_NAME))
        probes=[i for i,e in enumerate(f.events) if e[:3]==('docker','exec',OLD_NAME) and 'mount-readability' in e]
        self.assertTrue(probes);self.assertTrue(all(i<stop for i in probes))
    def test_probe_transport_error_not_unreadable(self):
        f=Fake()
        with patch.object(f,'run',side_effect=r.GateError('COMMAND_FAILED')):
            self.fail('RUNTIME_MOUNT_PROBE_FAILED',r.mount_readability,f,OLD_NAME)
    def test_probe_invalid_output_not_unreadable(self):
        f=Fake()
        with patch.object(f,'run',return_value=b''):
            self.fail('RUNTIME_MOUNT_PROBE_FAILED',r.mount_readability,f,OLD_NAME)
    def test_docker_mount_order_variation_preserves_identity(self):
        f=Fake();a=copy.deepcopy(f.old);b=copy.deepcopy(a);b['Mounts'].reverse()
        with patch.object(f,'inspect',side_effect=[a,b]):snapshot=r.mount_readability(f,OLD_NAME)
        self.assertEqual(len(snapshot),2)
    def test_mount_changes_during_probe_fail(self):
        f=Fake();a=copy.deepcopy(f.old);b=copy.deepcopy(a);b['Mounts'][0]['RW']=True
        with patch.object(f,'inspect',side_effect=[a,b]):self.fail('PROBE_FAILED',r.mount_readability,f,OLD_NAME)
    def test_rw_mount_readability_also_enforced(self):
        f,b=self.candidate();f.readability[(NAME,f.new['Mounts'][1]['Destination'])]=False
        self.fail('READABILITY_PARITY',self.check,f,b)
    def test_authority_probe_failure_prevents_stop(self):
        f=Fake()
        with patch.object(r,'mount_readability',side_effect=r.GateError('RUNTIME_MOUNT_PROBE_FAILED')):
            self.fail('RUNTIME_MOUNT_PROBE_FAILED',r.execute_loaded,f,art(),LEDGER,'fixture','old-id',r.digest(ROUTES.encode()))
        self.assertFalse(any(e[:2]==('docker','stop') for e in f.events))
    def test_failure_code_survives_controller_boundary_after_rollback(self):
        f=Fake();f.fail='secret-read';output=io.StringIO()
        v={'art':art(),'ledger':LEDGER,'helper':'fixture','oldId':'old-id','routeHash':r.digest(ROUTES.encode())}
        with patch.object(r,'LocalRemote',return_value=f),patch('sys.stdout',new=output):r.run_loaded_controller(v)
        result=json.loads(output.getvalue())
        self.assertEqual(result,{'result':'DEPLOY_ROLLED_BACK','failureGate':'CANDIDATE_RUNTIME_CHECKS','code':'RUNTIME_MOUNT_READABILITY_PARITY_FAILED'})
        self.assertEqual(f.running,[f.old]);self.assertEqual(f.routes(),(ROUTES,ROUTES))
        with patch('sys.stdout',new=io.StringIO()):self.fail('READABILITY_PARITY',r.check_controller_result,output.getvalue())
    def test_arbitrary_exception_text_suppressed(self):
        out=io.StringIO()
        with patch.object(r,'execute_loaded',side_effect=r.GateError('SENSITIVE_FIXTURE_TEXT')),patch('sys.stdout',new=out):r.run_loaded_controller({k:None for k in ('art','ledger','helper','oldId','routeHash')})
        self.assertNotIn('SENSITIVE_FIXTURE_TEXT',out.getvalue())
        self.assertEqual(json.loads(out.getvalue())['code'],'REMOTE_CONTROLLER_FAILURE_DETAILS_SUPPRESSED')
    def test_received_unknown_code_or_extra_fields_rejected(self):
        for payload in ({'result':'DEPLOY_ROLLED_BACK','failureGate':'CANDIDATE_RUNTIME_CHECKS','code':'SENSITIVE_FIXTURE_TEXT'},
                        {'result':'DEPLOY_ROLLED_BACK','failureGate':'CANDIDATE_RUNTIME_CHECKS','code':'HEALTH_FAILED','stderr':'SENSITIVE_FIXTURE_TEXT'}):
            out=io.StringIO()
            with patch('sys.stdout',new=out):self.fail('RESULT_INVALID',r.check_controller_result,json.dumps(payload))
            self.assertEqual(out.getvalue(),'')


class ShippingFake(Fake):
    def __init__(self):
        super().__init__()
        self.phase='L85';self.migrator=None;self.migration_poll=0;self.migration_failure=None
        self.retained_actual=6;self.lock_removed=False
    def disk(self):return 20*r.GIB,60*r.GIB
    def db(self):
        if self.migration_failure=='fast-exit' and self.migrator and self.migrator['State']['Running']:
            self.phase='L86';self.running=[];self.migrator['State']={'Running':False,'ExitCode':0}
        after=self.phase!='L85'
        return {'database':r.EXPECTED_DB,'applied':86 if self.phase=='L86' else 85,
                'failed':1 if self.phase=='FAILED' else 0,'rolledBack':0,
                'ledger':{**LEDGER,r.SHIPPING_MIGRATION:r.SHIPPING_SQL_HASH} if self.phase=='L86' else LEDGER,
                'check':{'validated':True,'definition':r.SHIPPING_CHECK_NEW if after else r.SHIPPING_CHECK_OLD},
                'invalidFacts':0,'pgVersion':'16.14','dbBytes':16*1024**2,
                'clients':[c['NetworkSettings']['Networks']['net']['IPAddress'] for c in self.running],**self.db_override}
    def inspect(self,name,image=False):
        if self.migrator and name==self.migrator['Name'].lstrip('/'):
            if self.migrator['State']['Running']:
                self.migration_poll+=1
                if self.migration_failure=='signal':
                    self.migration_failure=None
                    raise r.GateError('INTERRUPTED')
                if self.migration_poll>1:
                    self.migrator['State']={'Running':False,'ExitCode':0}
                    self.running=[]
                    self.phase=self.migration_failure or 'L86'
            return copy.deepcopy(self.migrator)
        return super().inspect(name,image)
    def run(self,args,data=None,timeout=60):
        if args[:3]==['docker','run','--rm'] and r.SHIPPING_CLI_PROBE in args:
            self.events.append(('pinned-cli',));return b'PINNED_PRISMA_CLI_OK\n'
        if self.migrator and args[:2]==['docker','start'] and args[-1]==self.migrator['Name'].lstrip('/'):
            self.events.append(('migrator-start',));assert not self.running
            self.migrator['State']['Running']=True;self.running=[self.migrator];return b''
        if self.migrator and args[:2]==['docker','stop'] and args[-1]==self.migrator['Name'].lstrip('/'):
            self.events.append(('migrator-stop',));self.migrator['State']['Running']=False;self.running=[];return b''
        return super().run(args,data,timeout)
    def py(self,code,value=None,timeout=60):
        if code==r.SHIPPING_MIGRATOR_CREATE_CODE:
            assert not self.running
            self.events.append(('migrator-create',))
            self.migrator={'Name':'/'+value['name'],'Image':art()['loadedDockerImageId'],
                'State':{'Running':False,'ExitCode':0},'Config':{
                    'Image':value['image'],'Labels':{'budu.production-role':'migrator',r.REVISION:NEW},
                    'Env':['NODE_ENV=production','PATH=/fixture','DATABASE_URL='+env_url(self.old),
                           'PGOPTIONS=-c application_name=budu_shipping_migrator'],
                    'Entrypoint':['node'],'Cmd':['/app/node_modules/prisma/build/index.js','migrate','deploy','--schema','/app/prisma/schema.prisma']},
                'HostConfig':{'ReadonlyRootfs':True,'RestartPolicy':{'Name':'no','MaximumRetryCount':0},
                              'NetworkMode':'net','PortBindings':{},'Tmpfs':{'/tmp':'rw,nosuid,size=128m'},
                              'LogConfig':{'Type':'json-file','Config':{'max-size':'1m','max-file':'1'}}},
                'Mounts':[],'NetworkSettings':{'Networks':copy.deepcopy(self.old['NetworkSettings']['Networks'])}}
            self.migrator['NetworkSettings']['Networks']['net']['IPAddress']='172.20.0.5'
            return b''
        if 'os.rmdir' in code:self.lock_removed=True
        return super().py(code,value,timeout)


def env_url(container):return r.env(container)['DATABASE_URL']


class ShippingMigrationGates(unittest.TestCase):
    def setUp(self):
        names=('RELEASE_PROFILE','EXPECTED_OLD_SHA','RUNTIME_SHA','OLD_V2_HASH','IMAGE_PREFIX','CONTAINER_SUFFIX','ROLLBACK_PREFIX')
        values=[getattr(r,k) for k in names]
        self.addCleanup(lambda: [setattr(r,k,v) for k,v in zip(names,values)])
        r.configure_profile('post-transfer',r.SHIPPING_OLD_SHA,r.SHIPPING_BUSINESS_SHA,'1'*64)
        self.name_patch=patch.dict(globals(),{'NAME':'budu-prod-'+NEW[:12]+'-post-transfer'})
        self.name_patch.start();self.addCleanup(self.name_patch.stop)
        for obj,key in ((r.subprocess,'run'),(r.signal,'signal'),(r.time,'sleep')):
            mock=patch.object(obj,key,side_effect=AssertionError('REAL_PROCESS_FORBIDDEN') if obj is r.subprocess else None)
            mock.start();self.addCleanup(mock.stop)
        self.ledger={**LEDGER,r.SHIPPING_MIGRATION:r.SHIPPING_SQL_HASH}
        self.art=art();self.art['config']['Env']=['NODE_ENV=production','PATH=/fixture']

    def execute(self,f,backup_error=False):
        def backup(remote,state,root,image):
            self.assertFalse(remote.running);self.assertEqual(state['migration_phase'],'L85')
            remote.events.append(('backup-restore',))
            if backup_error:raise r.GateError('SHIPPING_BACKUP_RESTORE_UNVERIFIED')
            return {'restoreVerified':True}
        with patch.object(r,'shipping_backup_restore',side_effect=backup),patch('sys.stdout',io.StringIO()):
            return r.execute_loaded(f,self.art,self.ledger,'fixture','old-id',r.digest(ROUTES.encode()))

    def test_exact_contract_only(self):
        self.assertTrue(r.shipping_migration());self.assertEqual(r.before_ledger(self.ledger),LEDGER)
        for ledger in (LEDGER,{**self.ledger,r.SHIPPING_MIGRATION:'a'*64},{**self.ledger,'unexpected':'b'*64}):
            with self.subTest(ledgerCount=len(ledger)),self.assertRaisesRegex(r.GateError,'SHIPPING_MIGRATION_CONTRACT_INVALID'):
                r.before_ledger(ledger)
        r.RUNTIME_SHA='f'*40;self.assertFalse(r.shipping_migration())
        with self.assertRaisesRegex(r.GateError,'MIGRATION_LEDGER_INVALID'):
            r.validate_database(ShippingFake().db(),self.ledger)

    def test_both_phases_require_exact_check_ledger_and_validation(self):
        f=ShippingFake();r.validate_database(f.db(),LEDGER);f.phase='L86';r.validate_database(f.db(),self.ledger)
        cases=[{'applied':85},{'failed':1},{'rolledBack':1},{'check':{'validated':False,'definition':r.SHIPPING_CHECK_NEW}},
               {'check':{'validated':True,'definition':r.SHIPPING_CHECK_OLD}},{'invalidFacts':1},
               {'ledger':{**self.ledger,r.SHIPPING_MIGRATION:'f'*64}}]
        for change in cases:
            with self.subTest(change=change),self.assertRaises(r.GateError):r.validate_database({**f.db(),**change},self.ledger)
        f.phase='GAP'
        with self.assertRaisesRegex(r.GateError,'SHIPPING_DATABASE_PHASE_INVALID'):r.validate_database(f.db(),LEDGER)

    def test_backup_and_migrator_are_inside_original_disk_gate(self):
        f=ShippingFake();resources=r.shipping_resources(f.db());r.shipping_disk_gate(f,resources,self.art)
        f.disk=lambda:(60*r.GIB,11*r.GIB)
        with self.assertRaisesRegex(r.GateError,'SHIPPING_MIGRATION_DISK_GATE_FAILED'):r.shipping_disk_gate(f,resources)
        with self.assertRaisesRegex(r.GateError,'SHIPPING_PG16_REQUIRED'):r.shipping_resources({**f.db(),'pgVersion':'18.3'})
        self.assertEqual(r.MAX_PROJECTED_USAGE,90);self.assertEqual(r.MIN_PROJECTED_AVAILABLE,10*r.GIB)

    def test_success_backup_zero_unique_migrator_zero_candidate(self):
        f=ShippingFake();self.execute(f)
        self.assertEqual(f.phase,'L86');self.assertEqual(f.retained_actual,6);self.assertTrue(f.lock_removed)
        events=[e[0] for e in f.events]
        self.assertLess(events.index('backup-restore'),events.index('migrator-create'))
        self.assertLess(events.index('migrator-start'),events.index('create-start'))
        self.assertEqual([c['Name'] for c in f.running],['/'+NAME])
        self.assertFalse(any(e[:2]==('docker','start') and e[-1]==OLD_NAME for e in f.events))

    def test_migrator_requires_exact_source_networks_before_start(self):
        for change in ('missing-secondary','unexpected-network','wrong-network-id'):
            with self.subTest(change=change):
                class ChangedNetwork(ShippingFake):
                    def py(inner,code,value=None,timeout=60):
                        result=super().py(code,value,timeout)
                        if code==r.SHIPPING_MIGRATOR_CREATE_CODE:
                            networks=inner.migrator['NetworkSettings']['Networks']
                            if change=='missing-secondary':networks.pop('web')
                            elif change=='unexpected-network':networks['unapproved']={'NetworkID':'other'}
                            else:networks['web']['NetworkID']='replaced-network'
                        return result
                f=ChangedNetwork()
                with self.assertRaisesRegex(r.GateError,'SHIPPING_MIGRATOR_IDENTITY_INVALID'):self.execute(f)
                self.assertEqual(f.phase,'L85');self.assertTrue(f.lock_removed)
                self.assertEqual([c['Name'] for c in f.running],['/'+OLD_NAME])
                self.assertFalse(any(e[0]=='migrator-start' for e in f.events))

    def test_backup_failure_rolls_back_only_known_l85(self):
        f=ShippingFake()
        with self.assertRaisesRegex(r.GateError,'SHIPPING_BACKUP_RESTORE_UNVERIFIED'):self.execute(f,True)
        self.assertEqual(f.phase,'L85');self.assertTrue(f.lock_removed)
        self.assertEqual([c['Name'] for c in f.running],['/'+OLD_NAME])
        self.assertFalse(any(e[0]=='migrator-start' for e in f.events))

    def test_short_migration_exit_between_snapshots_still_requires_exact_l86_zero(self):
        f=ShippingFake();f.migration_failure='fast-exit';self.execute(f)
        self.assertEqual(f.phase,'L86');self.assertTrue(f.lock_removed)
        self.assertEqual([c['Name'] for c in f.running],['/'+NAME])

    def test_sql_commit_ledger_gap_failed_ledger_and_signal_remain_closed(self):
        for failure in ('GAP','FAILED','signal'):
            with self.subTest(failure=failure):
                f=ShippingFake();f.migration_failure=failure
                with self.assertRaisesRegex(r.GateError,'ROLLBACK_UNVERIFIED_MANUAL_ATTENTION_REQUIRED') as error:self.execute(f)
                self.assertEqual(error.exception.deployment_result,'DEPLOY_BLOCKED')
                self.assertFalse(f.lock_removed);self.assertEqual(f.retained_actual,6);self.assertFalse(f.running)
                self.assertFalse(any(e[:2]==('docker','start') and e[-1]==OLD_NAME for e in f.events))
                self.assertFalse(any(e[0]=='create-start' for e in f.events))

    def test_post_migration_health_cutover_and_probe_failure_keep_l86_and_actual6(self):
        for failure in ('health','public','db-dns','reload','pointer-after'):
            with self.subTest(failure=failure):
                f=ShippingFake();f.fail=failure
                with self.assertRaises(r.GateError):self.execute(f)
                self.assertEqual(f.phase,'L86');self.assertEqual(f.retained_actual,6)
                self.assertEqual([c['Name'] for c in f.running],['/'+OLD_NAME]);self.assertTrue(f.lock_removed)
                r.validate_database(f.db(),self.ledger)
                self.assertEqual(f.routes(),(ROUTES,ROUTES))

    def test_wrong_migrator_identity_never_runs_migration(self):
        f=ShippingFake();original_inspect=f.inspect
        def wrong(name,image=False):
            result=original_inspect(name,image)
            if f.migrator and name==f.migrator['Name'].lstrip('/'):result['Image']='sha256:wrong'
            return result
        f.inspect=wrong
        with self.assertRaisesRegex(r.GateError,'SHIPPING_MIGRATOR_IDENTITY_INVALID'):self.execute(f)
        self.assertEqual(f.phase,'L85');self.assertTrue(f.lock_removed)
        self.assertFalse(any(e[0]=='migrator-start' for e in f.events))

    def test_verified_l86_disk_failure_rolls_back_old_app_preserving_actual6(self):
        f=ShippingFake()
        def gate(*args,**kwargs):
            if f.phase=='L86':raise r.GateError('SHIPPING_MIGRATION_DISK_GATE_FAILED')
            return {}
        with patch.object(r,'shipping_disk_gate',side_effect=gate):
            with self.assertRaisesRegex(r.GateError,'SHIPPING_MIGRATION_DISK_GATE_FAILED') as error:self.execute(f)
        self.assertEqual(error.exception.deployment_result,'DEPLOY_ROLLED_BACK')
        self.assertEqual(f.phase,'L86');self.assertEqual(f.retained_actual,6);self.assertTrue(f.lock_removed)
        self.assertEqual([c['Name'] for c in f.running],['/'+OLD_NAME]);r.validate_database(f.db(),self.ledger)

    def test_backup_timeout_signal_restore_l85_only_after_confirmed_termination(self):
        for code,verified in [('SHIPPING_BACKUP_RESTORE_UNVERIFIED',True),('INTERRUPTED',True),
                              ('SHIPPING_BACKUP_TERMINATION_UNVERIFIED',False)]:
            with self.subTest(code=code,verified=verified):
                f=ShippingFake();original_py=f.py
                def cancelled(helper,value=None,timeout=60):
                    if helper==r.SHIPPING_BACKUP_RESTORE_CODE:
                        error=r.GateError(code);error.backup_termination_verified=verified;raise error
                    return original_py(helper,value,timeout)
                f.py=cancelled
                with patch('sys.stdout',io.StringIO()):
                    with self.assertRaises(r.GateError) as error:r.execute_loaded(f,self.art,self.ledger,'fixture','old-id',r.digest(ROUTES.encode()))
                self.assertEqual(f.phase,'L85')
                if verified:
                    self.assertEqual(error.exception.deployment_result,'DEPLOY_ROLLED_BACK')
                    self.assertTrue(f.lock_removed);self.assertEqual([c['Name'] for c in f.running],['/'+OLD_NAME])
                else:
                    self.assertEqual(error.exception.deployment_result,'DEPLOY_BLOCKED')
                    self.assertFalse(f.lock_removed);self.assertFalse(f.running)
                    self.assertFalse(any(e[:2]==('docker','start') and e[-1]==OLD_NAME for e in f.events))
                self.assertFalse(any(e[0]=='migrator-start' for e in f.events))

    def test_backup_no_output_total_deadline_terminates_and_waits_child(self):
        process=Mock();process.poll.side_effect=[None,0];process.wait.return_value=0
        with tempfile.TemporaryDirectory() as directory,patch.object(r.subprocess,'Popen',return_value=process),\
             patch.object(r.select,'select',return_value=([],[],[])) as readiness,\
             patch.object(r.time,'monotonic',side_effect=[0,2]),\
             patch.object(r.os,'read',side_effect=AssertionError('BLOCKING_READ_FORBIDDEN')),\
             patch.object(r.signal,'pthread_sigmask',return_value=set()):
            with self.assertRaisesRegex(TimeoutError,'BACKUP_TOTAL_DEADLINE'):
                r.bounded_backup_dump(['fixture'],Path(directory)/'backup',100,1)
        readiness.assert_called_once();self.assertEqual(readiness.call_args.args[-1],1)
        process.terminate.assert_called_once();process.wait.assert_called_once_with(timeout=5)
        process.stdout.close.assert_called_once()

    def test_backup_signal_cancels_child_and_only_cleanup_defers_signals(self):
        process=Mock();process.poll.side_effect=[None,0];process.wait.return_value=0
        with tempfile.TemporaryDirectory() as directory,patch.object(r.subprocess,'Popen',return_value=process),\
             patch.object(r.select,'select',side_effect=r.GateError('INTERRUPTED')),\
             patch.object(r.time,'monotonic',return_value=0),\
             patch.object(r.signal,'pthread_sigmask',return_value=set()) as masking:
            with self.assertRaisesRegex(r.GateError,'INTERRUPTED'):
                r.bounded_backup_dump(['fixture'],Path(directory)/'backup',100,1)
        self.assertEqual([call.args[0] for call in masking.call_args_list],[r.signal.SIG_BLOCK,r.signal.SIG_SETMASK])
        process.terminate.assert_called_once();process.wait.assert_called_once_with(timeout=5)

    def test_backup_eof_wait_timeout_escalates_terminate_to_kill_and_wait(self):
        process=Mock();process.poll.side_effect=[None,0]
        process.wait.side_effect=[r.subprocess.TimeoutExpired('fixture',1),r.subprocess.TimeoutExpired('fixture',5),0]
        with tempfile.TemporaryDirectory() as directory,patch.object(r.subprocess,'Popen',return_value=process),\
             patch.object(r.select,'select',return_value=([process.stdout],[],[])),\
             patch.object(r.os,'read',return_value=b''),patch.object(r.time,'monotonic',return_value=0),\
             patch.object(r.signal,'pthread_sigmask',return_value=set()):
            with self.assertRaises(r.subprocess.TimeoutExpired):r.bounded_backup_dump(['fixture'],Path(directory)/'backup',100,1)
        process.terminate.assert_called_once();process.kill.assert_called_once();self.assertEqual(process.wait.call_count,3)

    def test_long_backup_stays_in_controller_with_verified_cleanup_error_only(self):
        for verified in (True,False):
            helper='cleanup_complete='+str(verified)+'\nraise RuntimeError("PRIVATE_DETAILS")'
            with patch.object(r,'SHIPPING_BACKUP_RESTORE_CODE',helper),\
                 patch.object(r.signal,'pthread_sigmask',side_effect=AssertionError('LONG_OPERATION_MUST_NOT_BLOCK_SIGNALS')):
                with self.assertRaises(r.GateError) as error:r.LocalRemote().py(helper,{})
            self.assertEqual(error.exception.backup_termination_verified,verified)
            self.assertNotIn('PRIVATE_DETAILS',str(error.exception))

    def test_unknown_client_cannot_be_admitted_as_migrator(self):
        f=ShippingFake();original_db=f.db
        def unknown():
            result=original_db()
            if f.migrator and f.migrator['State']['Running']:result['clients'].append('192.0.2.1')
            return result
        f.db=unknown
        with self.assertRaisesRegex(r.GateError,'ROLLBACK_UNVERIFIED_MANUAL_ATTENTION_REQUIRED'):self.execute(f)
        self.assertFalse(f.lock_removed);self.assertFalse(any(e[0]=='create-start' for e in f.events))

    def test_backup_helper_is_private_exclusive_isolated_and_compiles(self):
        compile(r.SHIPPING_BACKUP_RESTORE_CODE,'shipping-backup','exec')
        compile(r.SHIPPING_MIGRATOR_CREATE_CODE,'shipping-migrator','exec')
        for token in ("path.open('xb')","os.umask(0o077)","'--network','none'","before!=after","process.terminate()","'pg_restore'","'restoreVerified':True"):
            self.assertIn(token,r.SHIPPING_BACKUP_RESTORE_CODE)
        for forbidden in ('migrate resolve','npx','pg_restore','server/index.js'):
            self.assertNotIn(forbidden,r.SHIPPING_MIGRATOR_CREATE_CODE)


class ShippingDiagnosticIdentity(unittest.TestCase):
    def setUp(self):
        names=('RELEASE_PROFILE','EXPECTED_OLD_SHA','RUNTIME_SHA','OLD_V2_HASH','IMAGE_PREFIX','CONTAINER_SUFFIX','ROLLBACK_PREFIX')
        saved={name:getattr(r,name) for name in names}
        self.addCleanup(lambda: [setattr(r,name,value) for name,value in saved.items()])
        r.configure_profile('post-transfer',r.SHIPPING_OLD_SHA,r.SHIPPING_BUSINESS_SHA,'a'*64)
        self.repo=Path(r.__file__).resolve().parent.parent
        self.path='prisma/migrations/'+r.SHIPPING_MIGRATION+'/migration.sql'
        self.parents={NEW:r.SHIPPING_ENGINEERING_SHA,r.SHIPPING_ENGINEERING_SHA:r.SHIPPING_BUSINESS_SHA,
                      r.SHIPPING_BUSINESS_SHA:r.SHIPPING_OLD_SHA}

    def facts(self,repo,*args):
        if args==('branch','--show-current'):return r.SHIPPING_DIAGNOSTIC_BRANCH
        if args==('rev-parse','HEAD'):return NEW
        if args[:1]==('rev-list',):return args[-1]+' '+self.parents[args[-1]]
        if args==('diff','--name-only',r.SHIPPING_ENGINEERING_SHA,NEW):return '\n'.join(sorted(r.SHIPPING_DIAGNOSTIC_FILES))
        if args==('diff','--name-only',r.SHIPPING_BUSINESS_SHA,NEW):return '\n'.join(sorted(r.SHIPPING_ENGINEERING_FILES))
        if args[:1]==('diff',):return self.path
        if args[:1]==('status',):return ''
        raise AssertionError(args)

    def test_exact_diagnostic_chain_and_ledger_read_only(self):
        with patch.object(r,'git',side_effect=self.facts),patch.object(r,'command',return_value=b''):
            sha,ledger=r.diagnostic_identity(self.repo)
        self.assertEqual(sha,NEW);self.assertEqual(len(ledger),86)
        self.assertEqual(ledger[r.SHIPPING_MIGRATION],r.SHIPPING_SQL_HASH)

    def test_diagnostic_rejects_wrong_branch_parents_scope_dirty_sql_and_profile(self):
        changes=[(('branch','--show-current'),r.SHIPPING_BRANCH,'BRANCH'),
                 (('rev-parse','HEAD'),r.SHIPPING_ENGINEERING_SHA,'SHA'),
                 (('diff','--name-only',r.SHIPPING_ENGINEERING_SHA,NEW),'server/v2.js','SCOPE'),
                 (('diff','--name-only',r.SHIPPING_BUSINESS_SHA,NEW),'','SCOPE'),
                 (('status','--porcelain','--untracked-files=all'),' M server/v2.js','WORKTREE'),
                 (('diff','--name-only',r.SHIPPING_OLD_SHA,NEW,'--','prisma'),self.path+'\nprisma/schema.prisma','MIGRATION_SCOPE')]
        for child in self.parents:
            changes.append((('rev-list','--parents','-n','1',child),child+' '+r.SHIPPING_OLD_SHA+' '+r.SHIPPING_BUSINESS_SHA,'PARENT'))
        for key,value,code in changes:
            with self.subTest(key=key),patch.object(r,'git',side_effect=lambda repo,*args: value if args==key else self.facts(repo,*args)),patch.object(r,'command',return_value=b''):
                with self.assertRaisesRegex(r.GateError,code):r.diagnostic_identity(self.repo)
        with patch.object(r,'git',side_effect=self.facts),patch.object(r,'digest',return_value='f'*64):
            with self.assertRaisesRegex(r.GateError,'SQL_HASH'):r.diagnostic_identity(self.repo)
        with patch.object(r,'shipping_migration',return_value=False):
            with self.assertRaisesRegex(r.GateError,'PROFILE'):r.diagnostic_identity(self.repo)

    def test_production_identity_still_rejects_diagnostic_branch(self):
        with patch.object(r,'git',side_effect=self.facts):
            with self.assertRaisesRegex(r.GateError,'SHIPPING_BRANCH_INVALID'):r.validate_shipping_identity(self.repo,NEW)


class DiskPolicy90Tests(unittest.TestCase):
    setUp = Gates.setUp
    MEASURED_J = (566711296, 566691107, 2095185920, 1155686400)

    def image(self):
        return dict(zip(('archive','blobs','expanded','largest'),self.MEASURED_J))

    def peak(self):return sum(self.MEASURED_J)+r.RESERVE

    def disk(self,used,available):
        return type('Disk',(),{'disk':lambda _:(used,available)})()

    def resources(self):
        return r.shipping_resources({'pgVersion':'16.14','dbBytes':162741271})

    def test_ceil_ninety_accepts_equal_and_rejects_one_byte_over_without_ten_gib_conflict(self):
        peak=self.peak();used=108*r.GIB-peak;available=12*r.GIB+peak
        for delta in (-1,0):
            b=r.disk_budget(used+delta,available-delta,*self.MEASURED_J)
            self.assertEqual(b['projectedUsage'],90);self.assertGreater(b['projectedAvailable'],10*r.GIB)
        with self.assertRaisesRegex(r.GateError,'DYNAMIC_HEADROOM'):
            r.disk_budget(used+1,available-1,*self.MEASURED_J)

    def test_ten_gib_accepts_equal_and_rejects_one_byte_less_below_ninety(self):
        peak=self.peak();used=70*r.GIB-peak;available=10*r.GIB+peak
        b=r.disk_budget(used,available,*self.MEASURED_J)
        self.assertEqual(b['projectedAvailable'],10*r.GIB);self.assertLess(b['projectedUsage'],90)
        with self.assertRaisesRegex(r.GateError,'DYNAMIC_HEADROOM'):
            r.disk_budget(used,available-1,*self.MEASURED_J)

    def test_image_absolute_six_gib_accepts_equal_and_rejects_one_byte_over(self):
        values=list(self.MEASURED_J)
        values[2]=6*r.GIB-values[0]-values[1]-values[3]-r.RESERVE
        self.assertEqual(r.disk_budget(20*r.GIB,100*r.GIB,*values)['peakIncrement'],6*r.GIB)
        values[2]+=1
        with self.assertRaisesRegex(r.GateError,'ABSOLUTE_PEAK'):
            r.disk_budget(20*r.GIB,100*r.GIB,*values)

    def test_combined_migration_six_gib_accepts_equal_and_rejects_one_byte_over(self):
        resources=self.resources();resources['restoreLimit']+=6*r.GIB-self.peak()-sum(resources.values())
        self.assertEqual(self.peak()+sum(resources.values()),6*r.GIB)
        r.shipping_disk_gate(self.disk(20*r.GIB,100*r.GIB),resources,self.image())
        with self.assertRaisesRegex(r.GateError,'SHIPPING_MIGRATION_DISK_GATE_FAILED'):
            r.shipping_disk_gate(self.disk(20*r.GIB,100*r.GIB),
                                 {**resources,'restoreLimit':resources['restoreLimit']+1},self.image())

    def test_migration_percent_and_ten_gib_boundaries_for_both_pre_and_post_import(self):
        resources=self.resources()
        for image,extra in ((self.image(),self.peak()+sum(resources.values())),
                            (None,r.RESERVE+sum(resources.values()))):
            with self.subTest(imported=image is None):
                b=r.shipping_disk_gate(self.disk(108*r.GIB-extra,12*r.GIB+extra),resources,image)
                self.assertEqual(b['projectedUsageWithMigration'],90)
                with self.assertRaisesRegex(r.GateError,'SHIPPING_MIGRATION_DISK_GATE_FAILED'):
                    r.shipping_disk_gate(self.disk(108*r.GIB-extra+1,12*r.GIB+extra-1),resources,image)
                b=r.shipping_disk_gate(self.disk(70*r.GIB-extra,10*r.GIB+extra),resources,image)
                self.assertEqual(b['projectedAvailableWithMigration'],10*r.GIB)
                with self.assertRaisesRegex(r.GateError,'SHIPPING_MIGRATION_DISK_GATE_FAILED'):
                    r.shipping_disk_gate(self.disk(70*r.GIB-extra,10*r.GIB+extra-1),resources,image)

    def test_resident_archive_is_still_counted_in_df_and_in_full_model_a(self):
        used,available=61765632000,19098456064
        image=self.image();resources=self.resources()
        resident=self.disk(used+image['archive'],available-image['archive'])
        b=r.shipping_disk_gate(resident,resources,image)
        self.assertEqual(b['projectedUsageWithMigration'],86)
        self.assertEqual(b['projectedAvailableWithMigration'],12097280595)
        combined=self.peak()+sum(resources.values())
        self.assertEqual(6*r.GIB-combined,7986771)
        self.assertEqual(resident.disk()[1]-b['projectedAvailableWithMigration'],combined)
        with patch.object(r,'MAX_PROJECTED_USAGE',85),self.assertRaisesRegex(r.GateError,'SHIPPING_MIGRATION_DISK_GATE_FAILED'):
            r.shipping_disk_gate(resident,resources,image)

    def test_post_import_preflight_uses_same_ninety_percent_and_ten_gib_policy(self):
        f=Fake();f.disk=lambda:(86*r.GIB,14*r.GIB)
        b=r.preflight(f,art(),LEDGER,imported=True)['budget']
        self.assertEqual(b['projectedUsage'],87)
        with patch.object(r,'MAX_PROJECTED_USAGE',85),self.assertRaisesRegex(r.GateError,'POST_IMPORT_HEADROOM'):
            r.preflight(f,art(),LEDGER,imported=True)

    def test_final_cutover_ninety_boundary_and_one_byte_over_rollback(self):
        for delta in (0,1):
            with self.subTest(delta=delta):
                f=Fake();samples=iter(((40*r.GIB,60*r.GIB),(108*r.GIB+delta,12*r.GIB-delta)))
                f.disk=lambda:next(samples)
                with patch('sys.stdout',io.StringIO()):
                    if delta:
                        with self.assertRaisesRegex(r.GateError,'POST_DEPLOY_HEADROOM'):
                            r.execute_loaded(f,art(),LEDGER,'fixture','old-id',r.digest(ROUTES.encode()))
                        self.assertEqual(f.pointer,r.EXPECTED_OLD_SHA)
                        self.assertEqual([c['Name'] for c in f.running],['/'+OLD_NAME])
                    else:
                        r.execute_loaded(f,art(),LEDGER,'fixture','old-id',r.digest(ROUTES.encode()))
                        self.assertEqual(f.pointer,NEW)

    def test_diagnostic_percent_label_matches_fixed_policy(self):
        image={**self.image(),'layers':[]}
        production={'rootfsDiffIds':[],'metadata':{'metadataAvailable':False,'snapshotProof':{},'contentProof':{}},
                    'diskUsed':20*r.GIB,'diskAvailable':100*r.GIB}
        for value in r.disk_models(image,production)['models'].values():
            self.assertTrue(value['WITHIN_90_PERCENT_AND_10_GIB'])
            self.assertNotIn('WITHIN_85_PERCENT_AND_10_GIB',value)

    def test_percentage_change_has_no_cli_override_and_other_admission_bounds_remain_fixed(self):
        self.assertEqual(r.MAX_PROJECTED_USAGE,90)
        self.assertEqual(r.MIN_PROJECTED_AVAILABLE,10*r.GIB)
        self.assertEqual(r.ABSOLUTE_MAX_PEAK,6*r.GIB)
        self.assertEqual(r.RESERVE,512*1024**2)
        source=Path(r.__file__).read_text()
        self.assertNotIn('--max-projected',source)
        self.assertNotIn("os.environ.get('MAX_PROJECTED_USAGE'",source)


if __name__=='__main__':
    unittest.main(verbosity=2)

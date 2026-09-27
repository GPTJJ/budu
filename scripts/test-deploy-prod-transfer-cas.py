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
from unittest.mock import patch

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
        with patch('sys.stdout',new=io.StringIO()):r.execute_loaded(f,art(),LEDGER,'fixture-helper','old-id',r.digest(ROUTES.encode()))
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
    def test_forbidden_steps_absent(self):
        source=Path(r.__file__).read_text()
        for forbidden in ['pg_dump','prisma migrate','docker prune','rehearsal','076e6e0','fe4a725']:
            self.assertNotIn(forbidden,source)
        self.assertEqual(r.MIGRATION_REQUIRED,'NO')
    def test_remote_payload_compiles(self):
        source=Path(r.__file__).read_text().rsplit("\nif __name__ == '__main__':",1)[0]
        compile(source,'remote-controller','exec')


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


if __name__=='__main__':
    unittest.main(verbosity=2)

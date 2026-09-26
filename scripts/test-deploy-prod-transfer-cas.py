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
            'expanded':1600*1024**2,'largest':700*1024**2,'imageId':'sha256:new-image',
            'config':copy.deepcopy(original()['Config']),'runtimeHash':r.OLD_V2_HASH}


class Fake:
    def __init__(self):
        self.old=original();self.new=None;self.running=[self.old];self.template=ROUTES;self.active=ROUTES
        self.fail=None;self.events=[];self.maxwriters=1;self.db_override={};self.pointer=r.EXPECTED_OLD_SHA
    def inspect(self,name,image=False):
        if image:return {'Id':name}
        return copy.deepcopy(self.old if name in (OLD_NAME,self.old['Id']) else self.new)
    def containers(self):return copy.deepcopy(self.running)
    def routes(self):return self.template,self.active
    def disk(self):return 47584356*1024,11584784*1024
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
        if args==['cat',r.CURRENT_SHA_FILE]:return self.pointer.encode()
        if args[-2:]==['sha256sum','/app/server/v2.js']:return (r.OLD_V2_HASH+'  /app/server/v2.js').encode()
        if args[:2]==['sh','-c'] and 'docker logs --tail' in args[2] and self.fail=='critical-log' and NAME in args[2]:
            self.fail=None;return b'FATAL fixture startup failure'
        if args[:3]==['docker','exec',NAME] and 'test' in args and self.fail=='secret-read':
            self.fail=None;raise r.GateError('SECRET_READ_FAILED')
        if args[:2]==['docker','info']:
            return json.dumps({'ServerVersion':'29.1.3','Driver':'overlayfs','DockerRootDir':'/var/lib/docker',
                               'DriverStatus':[['driver-type','io.containerd.snapshotter.v1']]}).encode()
        if args[:2]==['docker','stop']:
            if self.fail=='candidate-stop' and args[-1]==NAME:raise r.GateError('STOP_FAILED')
            self.running=[c for c in self.running if c['Name'].lstrip('/')!=args[-1]]
        if args[:2]==['docker','start']:
            assert args[-1]==OLD_NAME
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
            self.new['Name']='/'+NAME;self.new['Id']='new-id';self.new['Image']='sha256:new-image'
            self.new['Config']['Env']=[x if not x.startswith('GIT_SHA=') else 'GIT_SHA='+NEW for x in self.new['Config']['Env']]
            self.new['Config']['Labels'][r.REVISION]=NEW
            self.new['HostConfig']['RestartPolicy']={'Name':'no','MaximumRetryCount':0}
            self.new['NetworkSettings']['Networks']['net']['IPAddress']='172.20.0.4'
            self.running.append(self.new);self.maxwriters=max(self.maxwriters,len(self.running))
            if self.fail=='helper-after-start':
                self.fail=None;raise r.GateError('HELPER_FAILED')
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
        # A stray call to actual process/network tooling fails the test immediately.
        self.no_process=patch.object(r.subprocess,'run',side_effect=AssertionError('REAL_PROCESS_FORBIDDEN'))
        self.no_process.start();self.addCleanup(self.no_process.stop)
        self.sleep=patch.object(r.time,'sleep');self.sleep.start();self.addCleanup(self.sleep.stop)
        self.signals=patch.object(r.signal,'signal');self.signals.start();self.addCleanup(self.signals.stop)
    def fail(self,code,fn,*args,**kwargs):
        with self.assertRaisesRegex(r.GateError,code):fn(*args,**kwargs)
    def test_correct_preflight(self):
        f=Fake();v=r.preflight(f,art(),LEDGER);self.assertEqual(v['name'],OLD_NAME);self.assertLess(v['budget']['projectedUsage'],90)
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
        f=Fake();f.disk=lambda:(50*r.GIB,5*r.GIB);self.fail('DISK_UNSAFE',r.preflight,f,art(),LEDGER)
    def test_disk_percent_threshold(self):
        f=Fake();f.disk=lambda:(50*r.GIB,8*r.GIB);self.fail('DISK_UNSAFE',r.preflight,f,art(),LEDGER)
    def test_artifact_peak_cap(self):
        a=art();a['expanded']=4*r.GIB;self.fail('PEAK_EXCEEDS',r.preflight,Fake(),a,LEDGER)
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
        a=art(); image={'Id':a['imageId'],'Os':'linux','Architecture':'amd64','Size':2*r.GIB,'Config':copy.deepcopy(a['config'])}
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
    def test_restart_policy_admission(self):
        f=Fake();f.old['HostConfig']['RestartPolicy']['Name']='always';self.fail('RESTART_POLICY',r.preflight,f,art(),LEDGER)
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
        stop=f.events.index(('docker','stop','--time','30',OLD_NAME));start=f.events.index(('create-start',NAME));self.assertLess(stop,start)
    def test_cutover_failure_matrix_restores_old(self):
        for failure in ['helper-after-start','health','secret-read','critical-log','active-write','reload','public','pointer-after']:
            with self.subTest(failure=failure):
                f=Fake();f.fail=failure
                with self.assertRaises(r.GateError):r.execute_loaded(f,art(),LEDGER,'fixture-helper','old-id',r.digest(ROUTES.encode()))
                self.assertEqual(f.running,[f.old]);self.assertEqual(f.routes(),(ROUTES,ROUTES));self.assertEqual(f.maxwriters,1)
                self.assertIn(('health',OLD_NAME,r.EXPECTED_OLD_SHA,True),f.events)
    def test_rollback_cannot_start_old_until_candidate_stopped(self):
        f=Fake();f.running=[];f.py('',{'helper':'fixture'});f.fail='candidate-stop'
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

if __name__=='__main__':
    unittest.main(verbosity=2)

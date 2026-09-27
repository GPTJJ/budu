#!/usr/bin/env python3
"""Production-side operations for the SKU-only release state machine.

This file is inert in build-only CI. The exact-SHA adapter explicitly loads it
into one remote control process only in a separately authorized production gate.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


core = load_module('transfer_release_core', 'deploy-prod-transfer-cas.py')
contract = load_module('sku_release_contract', 'sku-release-contract.py')
controller = load_module('sku_release_controller', 'sku-release-controller.py')


def configure_core(old_v2_hash=None):
    core.RELEASE_PROFILE = 'sku-authority-schema1'
    core.EXPECTED_OLD_SHA = contract.PRODUCTION_SHA
    core.RUNTIME_SHA = contract.BUSINESS_SHA
    core.EXPECTED_MIGRATIONS = contract.BEFORE
    core.MIGRATION_REQUIRED = 'YES'
    core.IMAGE_PREFIX = 'sku-authority-'
    core.CONTAINER_SUFFIX = '-sku-authority'
    core.ROLLBACK_PREFIX = 'sku-authority-'
    if old_v2_hash is not None:
        core.require(bool(re.fullmatch(r'[0-9a-f]{64}',old_v2_hash)),
                     'SKU_OLD_RUNTIME_HASH_INVALID')
        core.OLD_V2_HASH = old_v2_hash


configure_core()


class SkuProductionOperations:
    def __init__(self, art, migration_art, baseline_ledger, after_ledger,
                 helper, old_id, route_hash, readiness, authority_mounts):
        self.remote = core.LocalRemote()
        self.art = art
        self.migration_art = migration_art
        self.baseline_ledger = baseline_ledger
        self.after_ledger = after_ledger
        self.helper = helper
        self.old_id = old_id
        self.route_hash = route_hash
        self.readiness = readiness
        self.expected_authority_mounts = authority_mounts
        self.release = art['release']
        self.candidate = 'budu-prod-' + self.release[:12] + core.CONTAINER_SUFFIX
        self.worker = 'budu-sku-worker-' + self.release[:12]
        self.root = Path('/opt/budu/.rollback-assets/sku-authority-' + self.release)
        self.manifest = self.root/'phase.json'
        self.backup = self.root/'pre-migration.dump'
        self.backup_hash = self.root/'pre-migration.sha256'
        self.plan_file = self.root/'sku-plan.json'
        self.migration_marker = self.root/'migration-started'
        self.state = None
        self.plan = None
        self.authority_mounts = None

    def preflight(self):
        self.state = core.preflight(self.remote, self.art, self.baseline_ledger, imported=True)
        core.require(self.state['old']['Id'] == self.old_id and
                     core.digest(self.state['template'].encode()) == self.route_hash,
                     'SKU_AUTHORITY_CHANGED_DURING_IMPORT')
        core.resolve_loaded_image(self.remote, self.art)
        core.require(not self.root.exists(), 'SKU_ROLLBACK_ROOT_ALREADY_EXISTS')
        self.authority_mounts = core.mount_readability(self.remote, self.state['name'])
        core.require(self.authority_mounts == self.expected_authority_mounts,
                     'SKU_AUTHORITY_MOUNTS_CHANGED_AFTER_READINESS')
        self.pre_stop_worker_db_probe()
        self.root.mkdir(mode=0o700)
        (self.root/'route-template').write_text(self.state['template'])
        (self.root/'route-active').write_text(self.state['active'])
        for path in (self.root/'route-template',self.root/'route-active'):
            path.chmod(0o600)
        self._fsync_directory()

    def _fsync_directory(self):
        descriptor = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)

    def _pg_user(self):
        pg = self.remote.inspect(core.PG)
        return core.env(pg).get('POSTGRES_USER','postgres')

    def _pg(self, *args, data=None, timeout=120):
        command = ['docker','exec'] + (['-i'] if data is not None else []) + [core.PG,*args]
        return self.remote.run(command, data=data, timeout=timeout)

    def _db(self):
        return self.remote.db()

    def _ledger(self):
        db = self._db()
        if db['applied'] == 85:
            contract.validate_baseline_ledger(db,self.baseline_ledger)
        elif db['applied'] == 86:
            contract.validate_after_ledger(db,self.after_ledger)
        else:
            raise core.GateError('SKU_MIGRATION_LEDGER_INVALID')
        return db

    def _worker_database(self):
        old = self.state['old']
        url = core.env(old).get('DATABASE_URL','')
        try:
            parsed = core.urlsplit(url)
            valid = (parsed.scheme in ('postgresql','postgres') and parsed.hostname and
                     core.unquote(parsed.path).strip('/') == core.EXPECTED_DB and
                     '\n' not in url and '\r' not in url)
        except ValueError:
            valid = False
        core.require(valid, 'SKU_DATABASE_URL_INVALID')
        return url, parsed.hostname

    def resolve_database_network(self, hostname):
        old_networks = self.state['old'].get('NetworkSettings',{}).get('Networks',{})
        pg_networks = self.remote.inspect(core.PG).get('NetworkSettings',{}).get('Networks',{})
        core.require(isinstance(old_networks,dict) and isinstance(pg_networks,dict),
                     'SKU_DB_NETWORK_AUTHORITY_NOT_FOUND')
        matching = [name for name, details in pg_networks.items()
                    if isinstance(details,dict) and isinstance(details.get('Aliases'),list)
                    and hostname in details['Aliases']]
        core.require(bool(matching), 'SKU_DB_NETWORK_AUTHORITY_NOT_FOUND')
        shared = [name for name in matching if name in old_networks]
        core.require(bool(shared), 'SKU_DB_NETWORK_OLD_RUNTIME_NOT_ATTACHED')
        core.require(len(shared) == 1, 'SKU_DB_NETWORK_AUTHORITY_AMBIGUOUS')
        network = shared[0]
        core.require(bool(re.fullmatch(r'[A-Za-z0-9_.-]+',network)),
                     'SKU_DB_NETWORK_AUTHORITY_INVALID')
        return network

    def _worker_command(self, mode, data=None, write=False, timeout=150,
                        post_cutover=False):
        url, hostname = self._worker_database()
        variables = {'DATABASE_URL':url,'SKU_RELEASE_CONTROLLER':'sku-authority-schema1',
                     'GIT_SHA':self.release}
        if write: variables['SKU_RELEASE_WRITE_AUTHORIZED'] = self.release
        else: variables['PGOPTIONS'] = '-c default_transaction_read_only=on -c statement_timeout=120000'
        if post_cutover: variables['SKU_RELEASE_PHASE'] = 'POST_CUTOVER'
        network = self.resolve_database_network(hostname)
        image = self.migration_art['imageReference'] if mode == 'migration' else self.art['imageReference']
        fd, env_path = tempfile.mkstemp(prefix='budu-sku-env-',dir='/dev/shm')
        try:
            os.fchmod(fd,0o600)
            with os.fdopen(fd,'w') as stream:
                for key,value in variables.items(): stream.write(key+'='+value+'\n')
                stream.flush();os.fsync(stream.fileno())
            args = ['docker','run','--rm',*(['-i'] if data is not None else []),
                    '--name',self.worker,'--network',network,'--env-file',env_path,
                    '--entrypoint','node',image]
            if mode == 'migration': args += ['/app/node_modules/prisma/build/index.js','migrate','deploy']
            elif mode == 'db-probe': args += ['--input-type=module','-e',core.APPLICATION_DB_PROBE_SCRIPT]
            else: args += ['/app/scripts/sku-release-apply.mjs',mode]
            return self.remote.run(args,data=data,timeout=timeout)
        except BaseException as error:
            # A timed-out Docker CLI must not leave an untracked database client.
            ids = self.remote.run(['docker','ps','-q','--filter','name=^/'+self.worker+'$']).strip()
            if ids:
                self.remote.run(['docker','stop','--time','30',self.worker])
            if isinstance(error,core.GateError) and str(error) == 'COMMAND_FAILED':
                raise core.GateError('SKU_WORKER_COMMAND_FAILED') from None
            raise
        finally:
            Path(env_path).unlink(missing_ok=True)

    def pre_stop_worker_db_probe(self):
        try:
            result = self._worker_command('db-probe',write=False,
                                          timeout=core.APPLICATION_DB_PROBE_TIMEOUT)
        except Exception as error:
            if isinstance(error,core.GateError) and (str(error).startswith('SKU_DB_NETWORK_') or
                                                      str(error) == 'SKU_DATABASE_URL_INVALID'):
                raise
            raise core.GateError('SKU_WORKER_DB_CONNECTIVITY_PREFLIGHT_FAILED') from None
        core.require(result == core.APPLICATION_DB_PROBE_OK,
                     'SKU_WORKER_DB_CONNECTIVITY_PREFLIGHT_FAILED')

    def _in_candidate(self, mode, data=None, post_cutover=False):
        args = ['docker','exec','-i','-w','/app',
                '-e','SKU_RELEASE_CONTROLLER=sku-authority-schema1',
                '-e','SKU_RELEASE_PHASE='+('POST_CUTOVER' if post_cutover else 'PRE_CUTOVER'),
                '-e','PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=120000',
                self.candidate,'node','scripts/sku-release-apply.mjs',mode]
        return self.remote.run(args,data=data,timeout=150)

    def stop_old_writer(self):
        self.remote.run(['docker','stop','--time','30',self.state['name']])

    def require_writers(self, count):
        db = self._db()
        core.require(db['database'] == core.EXPECTED_DB,'DATABASE_AUTHORITY_MISMATCH')
        running = self.remote.containers()
        if count == 0: core.writer_check(running,db,[])
        elif count == 1:
            name = self.candidate if any(c['Name'].lstrip('/') == self.candidate for c in running) else self.state['name']
            core.writer_check(running,db,[name])
        else: raise core.GateError('SKU_WRITER_COUNT_INVALID')

    def _save_plan(self, value):
        data = json.loads(value)
        counts = data['plan']['counts']
        core.require(counts == {'total':178,'BD':89,'TP':89,'missingOldSku':33,'aliases':145},
                     'SKU_MAPPING_COUNTS_INVALID')
        with self.plan_file.open('xb') as stream:
            os.fchmod(stream.fileno(),0o600)
            stream.write(value)
            stream.flush();os.fsync(stream.fileno())
        self._fsync_directory()
        self.plan = value

    def final_frozen_plan_check(self):
        # Old writer is stopped. The candidate image reads the exact frozen DB
        # before backup or migration; no SKU data may change since readiness.
        self.require_writers(0)
        raw = self._worker_command('plan',write=False)
        value = json.loads(raw)
        core.require(value['plan']['snapshotId'] == self.readiness['snapshotId'] and
                     value['channelDigest'] == self.readiness['channelDigest'] and
                     value['anyChannelEnabled'] == 113,
                     'SKU_FINAL_FROZEN_PLAN_DRIFT')
        self._save_plan(raw)

    def create_backup(self):
        core.require(self.plan is not None and self.plan_file.is_file(),
                     'SKU_FINAL_FROZEN_PLAN_MISSING')
        self.require_writers(0)
        user = self._pg_user()
        command = ['docker','exec',core.PG,'pg_dump','-U',user,'-d',core.EXPECTED_DB,'-Fc']
        digest = hashlib.sha256()
        with self.backup.open('xb') as stream:
            os.fchmod(stream.fileno(),0o600)
            with subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL) as process:
                while True:
                    block = process.stdout.read(1024*1024)
                    if not block: break
                    stream.write(block);digest.update(block)
                core.require(process.wait(timeout=300) == 0,'SKU_BACKUP_FAILED')
            stream.flush();os.fsync(stream.fileno())
        core.require(self.backup.stat().st_size > 0,'SKU_BACKUP_EMPTY')
        self.backup_hash.write_text(digest.hexdigest()+'\n')
        self.backup_hash.chmod(0o600)
        with self.backup_hash.open('rb') as stream: os.fsync(stream.fileno())
        self._fsync_directory()
        with self.backup.open('rb') as stream:
            core.require(hashlib.sha256(stream.read()).hexdigest() == digest.hexdigest(),
                         'SKU_BACKUP_CHECKSUM_MISMATCH')
        self._pg('pg_restore','-l',data=self.backup.read_bytes(),timeout=120)

    def backup_exists(self):
        return self.backup.is_file() and self.backup_hash.is_file()

    def migration_started(self):
        return self.migration_marker.is_file()

    def on_failure_start(self):
        # A second transport signal must not interrupt database restore or
        # safe-degraded writer handoff midway.
        for sig in (signal.SIGHUP,signal.SIGTERM,signal.SIGINT):
            signal.signal(sig,signal.SIG_IGN)

    def rehearse_restore(self):
        core.require(self.backup_exists(),'SKU_BACKUP_UNVERIFIED')
        name = 'sku_restore_' + self.release[:12]
        user = self._pg_user()
        self._pg('createdb','-U',user,name)
        try:
            self._pg('pg_restore','--exit-on-error','--single-transaction','-U',user,
                     '-d',name,data=self.backup.read_bytes(),timeout=300)
            self._pg('psql','-X','-qAt','-U',user,'-d',name,'-c',
                     "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
            count = self._pg('psql','-X','-qAt','-U',user,'-d',name,'-c',
                            'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL').decode().strip()
            core.require(count == '85','SKU_RESTORE_REHEARSAL_LEDGER_INVALID')
        finally:
            self._pg('dropdb','--if-exists','--force','-U',user,name)

    def apply_migration_86(self):
        with self.migration_marker.open('xb') as stream:
            os.fchmod(stream.fileno(),0o600)
            stream.write(b'85_TO_86\n')
            stream.flush();os.fsync(stream.fileno())
        self._fsync_directory()
        self._worker_command('migration',write=True,timeout=300)

    def require_ledger(self,count):
        db = self._db()
        if count == 85: contract.validate_baseline_ledger(db,self.baseline_ledger)
        elif count == 86: contract.validate_after_ledger(db,self.after_ledger)
        else: raise core.GateError('SKU_MIGRATION_COUNT_INVALID')

    def apply_sku_data(self):
        fresh = self._worker_command('plan',write=False)
        core.require(fresh == self.plan,'SKU_MAPPING_DIGEST_CHANGED_BEFORE_APPLY')
        result = json.loads(self._worker_command('apply',data=self.plan,write=True))
        core.require(result.get('counts') == {'total':178,'BD':89,'TP':89,
                     'missingOldSku':33,'aliases':145},'SKU_DATA_MIGRATION_INVALID')

    def reconcile(self,pre_cutover):
        if not any(c['Name'].lstrip('/') == self.candidate for c in self.remote.containers()):
            output = self._worker_command('reconcile',data=self.plan,write=False,
                                          post_cutover=not pre_cutover)
        else:
            output = self._in_candidate('reconcile',data=self.plan,
                                        post_cutover=not pre_cutover)
        result = json.loads(output)
        if result.get('result') != 'PASS':
            raise controller.DataIntegrityError('SKU_RECONCILIATION_FAILED')

    def start_candidate(self):
        payload = {'helper':self.helper,'old':self.state['name'],'candidate':self.candidate,
                   'image':self.art['imageReference'],'sha':self.release,
                   'network':self.state['old']['HostConfig']['NetworkMode']}
        self.remote.py("import json,sys,subprocess,tempfile,pathlib,os; v=json.load(sys.stdin); c=json.loads(subprocess.check_output(['docker','inspect',v['old']]))[0]; e=dict(x.split('=',1) for x in c['Config']['Env']); f,p=tempfile.mkstemp(dir='/dev/shm'); os.fchmod(f,0o600); os.write(f,json.dumps({'username':e['CUSTOMER_REQUEST_WECOM_RECIPIENT_USERNAME'],'userId':e['CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID']}).encode()); os.close(f)\ntry:\n r=subprocess.run(['python3','-',v['old'],v['candidate'],v['image'],v['sha'],p,v['network'],'preserve','writer'],input=v['helper'].encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE); result=r.returncode\nfinally:\n pathlib.Path(p).unlink()\nraise SystemExit(result)", payload)
        self.remote.run(['docker','update','--restart','unless-stopped',self.candidate])
        core.validate_candidate_image(self.remote.inspect(self.candidate),self.art)
        core.clone_parity(self.state['old'],self.remote.inspect(self.candidate),self.release)

    def stop_candidate_if_running(self):
        running = {c['Name'].lstrip('/') for c in self.remote.containers()}
        if self.candidate in running:
            self.remote.run(['docker','stop','--time','30',self.candidate])
        if self.worker in running:
            self.remote.run(['docker','stop','--time','30',self.worker])

    def candidate_health(self): self.remote.health(self.candidate,self.release)
    def candidate_real_db_probe(self):
        core.application_db_probe(self.remote,self.candidate,'CANDIDATE_APPLICATION_DB_PROBE_FAILED')
    def candidate_runtime_parity(self):
        core.runtime_checks(self.remote,self.candidate,self.art['runtimeHash'],self.authority_mounts)

    def switch_public_to_candidate(self):
        contract.require(contract.load_manifest(self.manifest)['phase'] == contract.POST_CUTOVER,
                         'PUBLIC_CUTOVER_BARRIER_MISSING')
        old = self.state['name']
        new = self.state['template'].replace('http://'+old+':3000',
                                              'http://'+self.candidate+':3000')
        core.require(new.count('http://'+self.candidate+':3000') == 3,
                     'SKU_CUTOVER_ROUTE_COUNT_INVALID')
        core.replace_routes(self.remote,new,new)

    def public_health(self): self.remote.health(self.candidate,self.release,public=True)
    def observe_stability(self,seconds):
        deadline = time.monotonic()+seconds
        while time.monotonic() < deadline:
            time.sleep(min(15,max(0,deadline-time.monotonic())))
            self.candidate_health()
            self.public_health()
            self.candidate_real_db_probe()
            self.require_writers(1)
            self.require_ledger(86)
            self.reconcile(pre_cutover=False)
            current = self.remote.inspect(self.candidate)
            core.require(current.get('RestartCount',0) == 0 and
                         current['State']['Running'],'SKU_CANDIDATE_RESTARTED')
            logs = self.remote.run(['docker','logs','--since','20s','--tail','500',
                                    core.NGINX],timeout=20).decode(errors='replace')
            core.require(not re.search(r'\s5\d\d\s',logs),
                         'SKU_PUBLIC_5XX_DETECTED')
            used,available = self.remote.disk()
            core.require(available >= core.MIN_PROJECTED_AVAILABLE and
                         100*used/(used+available) <= core.MAX_PROJECTED_USAGE,
                         'SKU_STABILITY_DISK_GUARD_FAILED')

    def write_current_sha(self):
        core.write_authority(self.remote,core.CURRENT_SHA_FILE,self.release+'\n')
        core.require(self.remote.run(['cat',core.CURRENT_SHA_FILE]).decode().strip() == self.release,
                     'SKU_CURRENT_SHA_POINTER_FAILED')

    def restore_pre_migration_backup(self):
        contract.require(contract.load_manifest(self.manifest)['phase'] == contract.PRE_CUTOVER,
                         'POST_CUTOVER_DB_RESTORE_FORBIDDEN')
        self.require_writers(0)
        core.require(self.backup_exists(),'SKU_RESTORE_BACKUP_MISSING')
        expected = self.backup_hash.read_text().strip()
        core.require(hashlib.sha256(self.backup.read_bytes()).hexdigest() == expected,
                     'SKU_RESTORE_BACKUP_HASH_INVALID')
        user = self._pg_user()
        self._pg('dropdb','--force','-U',user,core.EXPECTED_DB)
        self._pg('createdb','-U',user,core.EXPECTED_DB)
        self._pg('pg_restore','--exit-on-error','--single-transaction','-U',user,
                 '-d',core.EXPECTED_DB,data=self.backup.read_bytes(),timeout=300)
        self.require_ledger(85)

    def start_old_writer(self): self.remote.run(['docker','start',self.state['name']])
    def old_real_db_probe(self):
        core.application_db_probe(self.remote,self.state['name'],
                                  'ROLLBACK_APPLICATION_DB_PROBE_FAILED')
    def verify_safe_degraded_guard(self):
        self.require_ledger(86)
        sql = "SELECT count(*) FROM pg_trigger WHERE tgname IN ('product_sku_insert_authority','product_sku_product_immutable') AND NOT tgisinternal"
        count = self._pg('psql','-X','-qAt','-U',self._pg_user(),'-d',core.EXPECTED_DB,
                         '-c',sql).decode().strip()
        core.require(count == '2','SKU_SAFE_DEGRADED_GUARD_MISSING')
        for name, expected in contract.GUARD_BODY_HASHES.items():
            body = self._pg('psql','-X','-qAt','-U',self._pg_user(),'-d',core.EXPECTED_DB,
                '-c',"SELECT prosrc FROM pg_proc WHERE proname='"+name+
                "' AND pronamespace='public'::regnamespace").decode().strip()
            core.require(hashlib.sha256(body.encode()).hexdigest() == expected,
                         'SKU_SAFE_DEGRADED_GUARD_CHANGED')

    def ensure_old_public_route(self):
        if self.remote.routes() != (self.state['template'],self.state['active']):
            core.replace_routes(self.remote,self.state['template'],self.state['active'])
    def switch_public_to_old(self):
        contract.require(contract.load_manifest(self.manifest)['phase'] == contract.POST_CUTOVER,
                         'SKU_SAFE_DEGRADED_PHASE_INVALID')
        core.replace_routes(self.remote,self.state['template'],self.state['active'])
    def public_old_health(self):
        self.remote.health(self.state['name'],contract.PRODUCTION_SHA,public=True)
    def preserve_incident_evidence(self):
        # No cleanup, DB mutation, or unreviewed recovery is allowed in HOLD.
        core.require(self.manifest.exists() and self.backup_exists(),
                     'SKU_INCIDENT_EVIDENCE_MISSING')

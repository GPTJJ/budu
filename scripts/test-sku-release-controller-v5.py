#!/usr/bin/env python3
"""Offline regression for the incident DB topology and rollback reporting."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS/path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ops = load('sku_ops_v5_test', 'sku-release-operations.py')
deploy = load('sku_deploy_v5_test', 'deploy-prod-sku-authority.py')


def topology(aliases=('bj006-postgres',), old_pg=True, pg_extra=False):
    old_networks = {'budu_default': {'IPAddress': '172.18.0.2'}}
    if old_pg:
        old_networks['pg-network'] = {'IPAddress': '172.20.0.2'}
    pg_networks = {'pg-network': {'IPAddress': '172.20.0.3', 'Aliases': list(aliases)}}
    if pg_extra:
        old_networks['other-pg-network'] = {'IPAddress': '172.21.0.2'}
        pg_networks['other-pg-network'] = {'IPAddress': '172.21.0.3',
                                           'Aliases': ['bj006-postgres']}
    old = {'Id': 'old-id', 'HostConfig': {'NetworkMode': 'budu_default'},
           'Config': {'Env': ['DATABASE_URL=postgresql://user:secret@bj006-postgres:5432/budu_bj006']},
           'NetworkSettings': {'Networks': old_networks}}
    pg = {'NetworkSettings': {'Networks': pg_networks}}
    return old, pg


class FakeRemote:
    def __init__(self, pg, fail=False):
        self.pg = pg
        self.fail = fail
        self.commands = []
        self.worker_env = None

    def inspect(self, name):
        assert name == ops.core.PG
        return self.pg

    def run(self, args, data=None, timeout=60):
        self.commands.append(args)
        if args[:2] == ['docker', 'run']:
            self.worker_env = Path(args[args.index('--env-file')+1]).read_text()
            if self.fail:
                raise ops.core.GateError('COMMAND_FAILED')
            return ops.core.APPLICATION_DB_PROBE_OK
        if args[:3] == ['docker', 'ps', '-q']:
            return b''
        raise AssertionError(args)


class WorkerNetworkTests(unittest.TestCase):
    def setUp(self):
        original = ops.tempfile.mkstemp
        temporary = patch.object(ops.tempfile, 'mkstemp',
                                 side_effect=lambda **kwargs: original(prefix=kwargs['prefix']))
        temporary.start()
        self.addCleanup(temporary.stop)

    def operation(self, old=None, pg=None, fail=False):
        old_default, pg_default = topology()
        op = object.__new__(ops.SkuProductionOperations)
        op.state = {'old': old or old_default}
        op.remote = FakeRemote(pg or pg_default, fail)
        op.release = 'a' * 40
        op.worker = 'budu-sku-worker-test'
        op.art = {'imageReference': 'budu-api:exact-runtime'}
        op.migration_art = {'imageReference': 'budu-api:exact-migration'}
        return op

    def test_incident_dual_network_ignores_wrong_hostconfig_mode(self):
        op = self.operation()
        self.assertEqual(op.resolve_database_network('bj006-postgres'), 'pg-network')
        self.assertEqual(op.state['old']['HostConfig']['NetworkMode'], 'budu_default')
        self.assertEqual(op.pre_stop_worker_db_probe(), None)
        command = next(c for c in op.remote.commands if c[:2] == ['docker', 'run'])
        self.assertEqual(command[command.index('--network')+1], 'pg-network')
        self.assertEqual(command[command.index('--entrypoint')+1], 'node')
        self.assertEqual(command[-2:], ['/app/scripts/sku-release-apply.mjs', 'db-probe'])
        self.assertIn('SKU_RELEASE_READ_ONLY=YES', op.remote.worker_env)
        self.assertNotIn('PGOPTIONS', op.remote.worker_env)
        self.assertIn('DATABASE_URL=postgresql://user:secret@bj006-postgres:5432/budu_bj006',
                      op.remote.worker_env)
        self.assertNotIn('SKU_RELEASE_WRITE_AUTHORIZED', op.remote.worker_env)
        self.assertEqual(op._worker_command('plan'), ops.core.APPLICATION_DB_PROBE_OK)
        plan_command = op.remote.commands[-1]
        self.assertEqual(plan_command[plan_command.index('--network')+1], 'pg-network')

    def test_readonly_marker_and_write_authority_are_separate(self):
        for mode in ('plan', 'reconcile', 'db-probe', 'apply', 'migration'):
            with self.subTest(mode=mode):
                op = self.operation()
                write = mode in ('apply', 'migration')
                op._worker_command(mode, write=write)
                self.assertEqual('SKU_RELEASE_READ_ONLY=YES' in op.remote.worker_env, not write)
                self.assertEqual('SKU_RELEASE_WRITE_AUTHORIZED=' + op.release in op.remote.worker_env, write)
                self.assertNotIn('PGOPTIONS', op.remote.worker_env)
                self.assertIn('DATABASE_URL=postgresql://user:secret@bj006-postgres:5432/budu_bj006',
                              op.remote.worker_env)
                self.assertNotIn('secret', ' '.join(op.remote.commands[-1]))
                if mode != 'migration':
                    self.assertEqual(op.remote.commands[-1][-2:],
                                     ['/app/scripts/sku-release-apply.mjs', mode])

    def test_candidate_reconcile_uses_same_adapter_and_guard(self):
        op = self.operation()
        op.candidate = 'candidate-test'
        op.remote.run = Mock(return_value=b'{}')
        op._in_candidate('reconcile', data=b'{}', post_cutover=True)
        args = op.remote.run.call_args.args[0]
        self.assertIn('SKU_RELEASE_READ_ONLY=YES', args)
        self.assertIn('SKU_RELEASE_PHASE=POST_CUTOVER', args)
        self.assertEqual(args[-3:], ['node', 'scripts/sku-release-apply.mjs', 'reconcile'])
        self.assertNotIn('PGOPTIONS', ' '.join(args))
        self.assertNotIn('SKU_RELEASE_WRITE_AUTHORIZED', ' '.join(args))

    def test_candidate_probe_uses_guarded_adapter(self):
        op = self.operation()
        op.candidate = 'candidate-test'
        op.remote.run = Mock(return_value=ops.core.APPLICATION_DB_PROBE_OK)
        op.candidate_real_db_probe()
        self.assertEqual(op.remote.run.call_args.args[0][-2:],
                         ['scripts/sku-release-apply.mjs', 'db-probe'])
        for value in (b'', b'not-db-ok'):
            op.remote.run.return_value = value
            with self.assertRaisesRegex(ops.core.GateError, 'CANDIDATE_APPLICATION_DB_PROBE_FAILED'):
                op.candidate_real_db_probe()

    def test_wrong_write_mode_stops_before_worker_creation(self):
        for mode, write in (('apply', False), ('migration', False), ('plan', True)):
            op = self.operation()
            with self.assertRaisesRegex(ops.core.GateError, 'SKU_WORKER_WRITE_MODE_MISMATCH'):
                op._worker_command(mode, write=write)
            self.assertEqual(op.remote.commands, [])
        with self.assertRaisesRegex(ops.core.GateError, 'SKU_CANDIDATE_READ_MODE_REQUIRED'):
            self.operation()._in_candidate('apply')

    def test_alias_missing_fails_closed(self):
        old, pg = topology(aliases=('different-host',))
        with self.assertRaisesRegex(ops.core.GateError, 'SKU_DB_NETWORK_AUTHORITY_NOT_FOUND'):
            self.operation(old, pg).pre_stop_worker_db_probe()

    def test_two_shared_aliases_fail_closed(self):
        old, pg = topology(pg_extra=True)
        with self.assertRaisesRegex(ops.core.GateError, 'SKU_DB_NETWORK_AUTHORITY_AMBIGUOUS'):
            self.operation(old, pg).pre_stop_worker_db_probe()

    def test_old_not_attached_fails_closed(self):
        old, pg = topology(old_pg=False)
        with self.assertRaisesRegex(ops.core.GateError, 'SKU_DB_NETWORK_OLD_RUNTIME_NOT_ATTACHED'):
            self.operation(old, pg).pre_stop_worker_db_probe()

    def test_url_malformed_or_hostless_fails_closed(self):
        for url in ('not-a-url', 'postgresql:///budu_bj006', 'postgresql://[bad/budu_bj006'):
            with self.subTest(url=url):
                op = self.operation()
                op.state['old']['Config']['Env'] = ['DATABASE_URL=' + url]
                with self.assertRaisesRegex(ops.core.GateError, 'SKU_DATABASE_URL_INVALID'):
                    op.pre_stop_worker_db_probe()

    def test_probe_failure_does_not_stop_old_or_create_root(self):
        with tempfile.TemporaryDirectory() as directory:
            op = self.operation(fail=True)
            op.root = Path(directory)/'rollback-root'
            op.manifest = op.root/'phase.json'
            op.old_id = 'old-id'
            op.route_hash = ops.core.digest(b'template')
            op.baseline_ledger = {}
            op.state = None
            op.expected_authority_mounts = []
            op.stop_old_writer = Mock()
            old, _ = topology()
            state = {'old': old, 'name': 'old', 'template': 'template', 'active': 'old'}
            with patch.object(ops.core, 'preflight', return_value=state), \
                 patch.object(ops.core, 'resolve_loaded_image'), \
                 patch.object(ops.core, 'mount_readability', return_value=[]):
                controller = ops.controller.ReleaseController(op, op.manifest)
                with self.assertRaisesRegex(ops.core.GateError,
                                            'SKU_WORKER_DB_CONNECTIVITY_PREFLIGHT_FAILED'):
                    controller.run()
            op.stop_old_writer.assert_not_called()
            self.assertFalse(op.root.exists())
            self.assertFalse(op.manifest.exists())
            self.assertEqual(controller.stage, 'CONTROLLER_PREFLIGHT')


FAKE_OPERATIONS = '''import json,pathlib
class GateError(Exception): pass
class ReleaseBlocked(Exception): pass
class DataIntegrityError(Exception): pass
class Core: GateError=GateError
class Contract:
 ReleaseBlocked=ReleaseBlocked
 def load_manifest(self,path): return json.loads(pathlib.Path(path).read_text())
core=Core();contract=Contract()
def configure_core(*_): pass
class Controller:
 def __init__(self,op,path):
  self.op=op;self.stage=op.art['stage'];self.rollback_outcome=None;self.primary_failure=None
 def run(self):
  self.rollback_outcome=self.op.art.get('outcome')
  kind=DataIntegrityError if self.op.art['stage']=='POST_CUTOVER_RECONCILIATION' else GateError
  self.primary_failure=kind(self.op.art['failure'])
  raise self.primary_failure
class Controllers: pass
controller=Controllers();controller.ReleaseController=Controller;controller.DataIntegrityError=DataIntegrityError
class SkuProductionOperations:
 def __init__(self,art,*_): self.art=art;self.manifest=pathlib.Path(art['manifest'])
'''


class WrapperOutcomeTests(unittest.TestCase):
    def wrapper(self, phase, outcome, failure='SKU_WORKER_COMMAND_FAILED',
                stage='FINAL_FROZEN_PLAN_CHECK'):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root/'phase.json'
            if phase:
                manifest.write_text(json.dumps({'phase': phase}))
            lock = root/'lock'
            lock.mkdir()
            art = {'release': 'a' * 40, 'manifest': str(manifest), 'outcome': outcome,
                   'failure': failure, 'stage': stage}
            payload = {'sources': {'sku-release-operations.py': FAKE_OPERATIONS},
                       'oldV2Hash': 'b'*64, 'art': art, 'migrationArt': {},
                       'baseline': {}, 'after': {}, 'helper': '', 'oldId': '',
                       'routeHash': '', 'readiness': {}, 'authorityMounts': [],
                       'lock': str(lock)}
            script = deploy.imported_controller_code().replace("dir='/dev/shm'",
                                                               'dir=' + repr(directory))
            completed = subprocess.run([sys.executable, '-c', script],
                                       input=json.dumps(payload), text=True, capture_output=True,
                                       check=True)
            self.assertEqual(completed.stderr, '')
            return json.loads(completed.stdout)

    def test_pre_cutover_rollback_preserves_primary(self):
        result = self.wrapper('PRE_CUTOVER', 'PRE_CUTOVER_RESTORED')
        self.assertEqual(result['result'], 'SKU_RELEASE_ROLLED_BACK_PRE_CUTOVER')
        self.assertEqual(result['rollbackOutcome'], 'PRE_CUTOVER_RESTORED')
        self.assertEqual(result['failureStage'], 'FINAL_FROZEN_PLAN_CHECK')
        self.assertEqual(result['failureCode'], 'SKU_WORKER_COMMAND_FAILED')

    def test_safe_degraded_rollback(self):
        result = self.wrapper('POST_CUTOVER', 'POST_CUTOVER_SAFE_DEGRADED')
        self.assertEqual(result['result'], 'SKU_RELEASE_ROLLED_BACK_SAFE_DEGRADED')
        self.assertEqual(result['rollbackOutcome'], 'POST_CUTOVER_SAFE_DEGRADED')

    def test_data_integrity_hold(self):
        result = self.wrapper('DATA_INTEGRITY_HOLD', 'POST_CUTOVER_DATA_INTEGRITY_HOLD',
                              'SKU_RECONCILIATION_FAILED', 'POST_CUTOVER_RECONCILIATION')
        self.assertEqual(result['result'], 'POST_CUTOVER_DATA_INTEGRITY_HOLD')
        self.assertEqual(result['rollbackOutcome'], 'POST_CUTOVER_DATA_INTEGRITY_HOLD')
        self.assertEqual(result['failureCode'], 'SKU_RECONCILIATION_FAILED')

    def test_unknown_rollback_only_when_outcome_unproven(self):
        result = self.wrapper('PRE_CUTOVER', None)
        self.assertEqual(result['code'], 'ROLLBACK_UNVERIFIED_MANUAL_ATTENTION_REQUIRED')
        self.assertIsNone(result['rollbackOutcome'])

    def test_pre_mutation_probe_failure_needs_no_rollback(self):
        result = self.wrapper(None, None, 'SKU_WORKER_DB_CONNECTIVITY_PREFLIGHT_FAILED',
                              'CONTROLLER_PREFLIGHT')
        self.assertEqual(result['code'], 'SKU_WORKER_DB_CONNECTIVITY_PREFLIGHT_FAILED')
        self.assertEqual(result['rollbackOutcome'], 'NOT_REQUIRED_PRE_MUTATION')

    def test_failure_code_never_exposes_secret(self):
        secret = 'postgresql://user:secret@db/budu_bj006'
        result = self.wrapper('PRE_CUTOVER', 'PRE_CUTOVER_RESTORED', secret)
        self.assertEqual(result['failureCode'], 'UNEXPECTED_ERROR_DETAILS_SUPPRESSED')
        self.assertNotIn(secret, json.dumps(result))


if __name__ == '__main__':
    unittest.main()

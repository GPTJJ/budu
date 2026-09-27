#!/usr/bin/env python3
"""Deterministic release state-machine failures; no production access."""
import copy
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('sku_controller', Path(__file__).with_name('sku-release-controller.py'))
r = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(r)


class FakeOperations:
    def __init__(self, path, failure=None):
        self.path = path
        self.failure = failure
        self.events = []
        self.database = {'ledger':85, 'products':178, 'assignments':0,
            'aliases':0, 'orders':[], 'paymentFacts':[]}
        self.backup = None
        self.migration_attempted = False
        self.writer = 'old'
        self.route = 'old'
        self.pointer = 'old'
        self.manifest_at_route = None

    def event(self, name):
        self.events.append(name)
        if self.failure == name:
            self.failure = None
            raise r.DataIntegrityError(name) if name.startswith('reconcile') else RuntimeError(name)

    def preflight(self): self.event('preflight')
    def stop_old_writer(self): self.writer = None; self.event('stop_old')
    def require_writers(self, count):
        assert int(self.writer is not None) == count
        self.event('writers_' + str(count))
    def final_frozen_plan_check(self): self.event('final_frozen_plan')
    def create_backup(self):
        self.backup = copy.deepcopy(self.database)
        self.event('backup')
    def rehearse_restore(self): self.event('restore_rehearsal')
    def apply_migration_86(self):
        self.migration_attempted = True
        self.database['ledger'] = 86
        self.event('migration')
    def require_ledger(self, count):
        assert self.database['ledger'] == count
        self.event('ledger_' + str(count))
    def apply_sku_data(self):
        self.database['assignments'] = 178
        self.database['aliases'] = 145
        self.event('sku_migration')
    def reconcile(self, pre_cutover):
        self.event('reconcile_pre' if pre_cutover else 'reconcile_post')
        assert self.database['ledger'] == 86
        assert self.database['assignments'] == 178
        assert self.database['aliases'] == 145
    def start_candidate(self): self.writer = 'candidate'; self.event('start_candidate')
    def candidate_health(self): self.event('candidate_health')
    def candidate_real_db_probe(self): self.event('candidate_db_probe')
    def candidate_runtime_parity(self): self.event('candidate_parity')
    def switch_public_to_candidate(self):
        self.manifest_at_route = r.contract.load_manifest(self.path)
        self.event('candidate_route_before_write')
        self.route = 'candidate'
        self.event('candidate_route_after_write')
        self.database['orders'].append('post-cutover-order')
        self.database['paymentFacts'].append('post-cutover-payment')
    def public_health(self): self.event('public_health')
    def observe_stability(self, seconds):
        assert seconds >= 300
        self.event('stability')
    def write_current_sha(self): self.pointer = 'candidate'; self.event('pointer')
    def stop_candidate_if_running(self):
        if self.writer == 'candidate': self.writer = None
        self.event('stop_candidate')
    def backup_exists(self): return self.backup is not None
    def migration_started(self): return self.migration_attempted
    def on_failure_start(self): pass
    def restore_pre_migration_backup(self):
        assert r.contract.load_manifest(self.path)['phase'] == r.contract.PRE_CUTOVER
        self.database = copy.deepcopy(self.backup)
        self.event('restore_database')
    def start_old_writer(self): self.writer = 'old'; self.event('start_old')
    def old_real_db_probe(self): self.event('old_db_probe')
    def verify_safe_degraded_guard(self):
        assert self.database['ledger'] == 86
        self.event('safe_degraded_guard')
    def ensure_old_public_route(self): self.route = 'old'; self.event('old_route')
    def switch_public_to_old(self): self.route = 'old'; self.event('old_route')
    def public_old_health(self): self.event('old_public_health')
    def preserve_incident_evidence(self): self.event('evidence_preserved')


class ReleaseFailures(unittest.TestCase):
    def simulate(self, failure):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name)/'manifest.json'
        op = FakeOperations(path, failure)
        controller = r.ReleaseController(op, path)
        with self.assertRaises(Exception):
            controller.run()
        return op, controller

    def test_r1_migration_failure_restores_85_and_old_writer(self):
        op, _ = self.simulate('migration')
        self.assertEqual(op.database['ledger'],85)
        self.assertEqual(op.writer,'old')
        self.assertIn('restore_database',op.events)
        self.assertEqual(op.route,'old')

    def test_frozen_plan_drift_restarts_old_before_backup_or_migration(self):
        op, controller = self.simulate('final_frozen_plan')
        self.assertEqual(controller.rollback_outcome,'PRE_CUTOVER_RESTORED')
        self.assertEqual(op.writer,'old')
        self.assertEqual(op.route,'old')
        self.assertEqual(op.database['ledger'],85)
        self.assertNotIn('backup',op.events)
        self.assertNotIn('migration',op.events)
        self.assertEqual(controller.stage,'FINAL_FROZEN_PLAN_CHECK')
        self.assertEqual(str(controller.primary_failure),'final_frozen_plan')

    def test_r2_reconciliation_failure_restores_85(self):
        op, _ = self.simulate('reconcile_pre')
        self.assertEqual(op.database['ledger'],85)
        self.assertEqual(op.database['assignments'],0)
        self.assertIn('restore_database',op.events)

    def test_r3_candidate_db_probe_failure_restores_85(self):
        op, _ = self.simulate('candidate_db_probe')
        self.assertEqual(op.writer,'old')
        self.assertEqual(op.database['ledger'],85)
        self.assertIn('restore_database',op.events)

    def test_r4_r5_post_cutover_runtime_preserves_business_facts(self):
        for failure in ('stability','public_health'):
            with self.subTest(failure=failure):
                op, controller = self.simulate(failure)
                self.assertNotIn('restore_database',op.events)
                self.assertEqual(op.database['ledger'],86)
                self.assertEqual(op.database['assignments'],178)
                self.assertEqual(op.database['aliases'],145)
                self.assertEqual(op.writer,'old')
                self.assertIn('safe_degraded_guard',op.events)
                self.assertEqual(op.database['orders'],['post-cutover-order'])
                self.assertEqual(op.database['paymentFacts'],['post-cutover-payment'])
                self.assertEqual(controller.rollback_outcome,'POST_CUTOVER_SAFE_DEGRADED')

    def test_r6_post_cutover_integrity_hold_preserves_facts(self):
        op, controller = self.simulate('reconcile_post')
        self.assertNotIn('restore_database',op.events)
        self.assertEqual(op.database['orders'],['post-cutover-order'])
        self.assertEqual(op.database['paymentFacts'],['post-cutover-payment'])
        self.assertIsNone(op.writer)
        self.assertEqual(controller.phase(),r.contract.DATA_INTEGRITY_HOLD)
        self.assertIn('evidence_preserved',op.events)
        self.assertEqual(controller.rollback_outcome,'POST_CUTOVER_DATA_INTEGRITY_HOLD')

    def test_r8_r9_partial_route_is_already_post_cutover(self):
        for failure in ('candidate_route_before_write','candidate_route_after_write'):
            with self.subTest(failure=failure):
                op, controller = self.simulate(failure)
                self.assertEqual(op.manifest_at_route['phase'],r.contract.POST_CUTOVER)
                self.assertEqual(controller.phase(),r.contract.POST_CUTOVER)
                self.assertNotIn('restore_database',op.events)
                self.assertEqual(op.database['ledger'],86)
                self.assertEqual(op.writer,'old')

    def test_success_pointer_after_stability_and_reconciliation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'manifest.json'
            op = FakeOperations(path)
            self.assertEqual(r.ReleaseController(op,path).run(),'SKU_RELEASE_DEPLOYED')
            self.assertEqual(op.pointer,'candidate')
            self.assertLess(op.events.index('stability'),op.events.index('pointer'))
            self.assertEqual(op.database['orders'],['post-cutover-order'])
            self.assertEqual(op.database['paymentFacts'],['post-cutover-payment'])


if __name__ == '__main__':
    unittest.main()

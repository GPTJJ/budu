#!/usr/bin/env python3
"""SKU Authority 85->86 release state machine, isolated from the old profile.

The operations object is the production adapter. This module never assumes that
an in-memory phase is sufficient: every exception reloads the durable manifest.
"""
import importlib.util
from pathlib import Path
import sys

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('sku_contract', Path(__file__).with_name('sku-release-contract.py'))
contract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(contract)


class DataIntegrityError(Exception):
    pass


class ReleaseController:
    def __init__(self, operations, manifest_path):
        self.op = operations
        self.manifest_path = Path(manifest_path)
        self.rollback_outcome = None

    def phase(self):
        return contract.load_manifest(self.manifest_path)['phase']

    def transition(self, phase):
        return contract.write_manifest(self.manifest_path, phase,
            productionSha=contract.PRODUCTION_SHA, businessSha=contract.BUSINESS_SHA,
            migration=contract.MIGRATION_NAME,
            migrationSha256=contract.MIGRATION_SHA256)

    def run(self):
        self.op.preflight()
        # The PRE manifest is durable before the first mutable release step.
        self.transition(contract.PRE_CUTOVER)
        try:
            self.op.stop_old_writer()
            self.op.require_writers(0)
            self.op.create_backup()
            self.op.rehearse_restore()
            self.op.require_writers(0)
            self.op.apply_migration_86()
            self.op.require_ledger(86)
            self.op.require_writers(0)
            self.op.apply_sku_data()
            self.op.require_writers(0)
            self.op.reconcile(pre_cutover=True)
            self.op.require_writers(0)
            self.op.start_candidate()
            self.op.require_writers(1)
            self.op.candidate_health()
            self.op.candidate_real_db_probe()
            self.op.candidate_runtime_parity()
            self.op.reconcile(pre_cutover=True)
            # PUBLIC_CUTOVER_BARRIER: fsync file and directory before route touch.
            self.transition(contract.POST_CUTOVER)
            self.op.switch_public_to_candidate()
            self.op.public_health()
            self.op.observe_stability(300)
            self.op.reconcile(pre_cutover=False)
            self.op.require_writers(1)
            self.op.write_current_sha()
            return 'SKU_RELEASE_DEPLOYED'
        except BaseException as error:
            self.op.on_failure_start()
            # A missing/corrupt phase is never interpreted as PRE_CUTOVER.
            phase = self.phase()
            if phase == contract.PRE_CUTOVER:
                self.rollback_pre_cutover()
                raise
            if phase == contract.DATA_INTEGRITY_HOLD or isinstance(error, DataIntegrityError):
                self.hold_data_integrity()
                raise
            # Runtime failure may use old app only after independent DB checks.
            try:
                self.op.stop_candidate_if_running()
                self.op.require_writers(0)
                self.op.reconcile(pre_cutover=False)
                self.op.require_ledger(86)
            except BaseException:
                self.hold_data_integrity()
                raise DataIntegrityError('POST_CUTOVER_DATA_INTEGRITY_HOLD') from None
            self.rollback_safe_degraded()
            raise

    def rollback_pre_cutover(self):
        contract.require(self.phase() == contract.PRE_CUTOVER,
                         'PRE_CUTOVER_RESTORE_FORBIDDEN')
        self.op.stop_candidate_if_running()
        self.op.require_writers(0)
        if self.op.backup_exists() and self.op.migration_started():
            self.op.restore_pre_migration_backup()
            self.op.require_ledger(85)
        else:
            # No backup means migration must not have begun.
            self.op.require_ledger(85)
        self.op.start_old_writer()
        self.op.old_real_db_probe()
        self.op.require_writers(1)
        self.op.ensure_old_public_route()
        self.op.public_old_health()
        self.rollback_outcome = 'PRE_CUTOVER_RESTORED'

    def rollback_safe_degraded(self):
        contract.require(self.phase() == contract.POST_CUTOVER,
                         'SAFE_DEGRADED_PHASE_INVALID')
        self.op.stop_candidate_if_running()
        self.op.require_writers(0)
        self.op.start_old_writer()
        self.op.old_real_db_probe()
        self.op.verify_safe_degraded_guard()
        self.op.require_writers(1)
        self.op.switch_public_to_old()
        self.op.public_old_health()
        # No database restore exists on this path.
        self.rollback_outcome = 'POST_CUTOVER_SAFE_DEGRADED'

    def hold_data_integrity(self):
        self.transition(contract.DATA_INTEGRITY_HOLD)
        self.op.stop_candidate_if_running()
        self.op.require_writers(0)
        self.op.preserve_incident_evidence()
        self.rollback_outcome = 'POST_CUTOVER_DATA_INTEGRITY_HOLD'
        return 'POST_CUTOVER_DATA_INTEGRITY_HOLD'

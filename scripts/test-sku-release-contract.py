#!/usr/bin/env python3
"""Offline SKU release identity and durable rollback phase tests."""
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('sku_contract', ROOT/'scripts/sku-release-contract.py')
c = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(c)


class Identity(unittest.TestCase):
    def test_build_only_workflow_has_no_production_access(self):
        source = (ROOT/'.github/workflows/sku-release-build-only.yml').read_text()
        self.assertIn('branches: [codex/sku-authority-release-controller-v5]',source)
        self.assertIn('image: postgres:16',source)
        self.assertIn('test-sku-release-lossless-native.py',source)
        self.assertNotIn('workflow_dispatch:',source)
        for forbidden in ('secrets.', 'ssh ', 'scp ', '--production-gate-authorized',
                          ' deploy --repo', ' preflight --repo'):
            self.assertNotIn(forbidden,source)

    def test_old_post_transfer_schema_guard_is_unchanged(self):
        source = (ROOT/'scripts/deploy-prod-transfer-cas.py').read_text()
        self.assertIn("require(not git(repo, 'diff', '--name-only', EXPECTED_OLD_SHA, release, '--', 'prisma'),",source)
        self.assertIn("'SCHEMA_CHANGED'",source)

    def test_final_business_migration_exact(self):
        baseline, actual = c.validate_migration_files(ROOT)
        self.assertEqual(len(baseline), 85)
        self.assertEqual(len(actual), 86)
        self.assertEqual(actual[c.MIGRATION_NAME], c.MIGRATION_SHA256)

    def test_one_byte_migration_change_denied(self):
        original = Path.read_bytes
        def corrupted(path):
            value = original(path)
            return value + b' ' if str(path).endswith(c.MIGRATION_NAME+'/migration.sql') else value
        with patch.object(Path, 'read_bytes', corrupted):
            with self.assertRaisesRegex(c.ReleaseBlocked, 'SKU_MIGRATION_CHECKSUM_DRIFT'):
                c.validate_migration_files(ROOT)

    def test_extra_migration_denied(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            shutil.copytree(ROOT/'prisma/migrations',repo/'prisma/migrations')
            extra = repo/'prisma/migrations/20260928000000_unapproved'
            extra.mkdir()
            (extra/'migration.sql').write_text('SELECT 1;')
            baseline = c.approved_ledger(ROOT,c.PRODUCTION_SHA)
            with patch.object(c,'approved_ledger',return_value=baseline):
                with self.assertRaisesRegex(c.ReleaseBlocked,'SKU_MIGRATION_COUNT_INVALID'):
                    c.validate_migration_files(repo)

    def test_ledger_before_and_after_exact(self):
        baseline, actual = c.validate_migration_files(ROOT)
        c.validate_baseline_ledger({'database':'budu_bj006','applied':85,'failed':0,
                                    'ledger':baseline}, baseline)
        c.validate_after_ledger({'database':'budu_bj006','applied':86,'failed':0,
                                 'ledger':actual}, actual)
        for count, ledger, code in ((86,baseline,'MIGRATION_LEDGER_INVALID'),
                                    (85,{**baseline,'wrong':'x'},'MIGRATION_CHECKSUM_MISMATCH')):
            with self.assertRaisesRegex(c.ReleaseBlocked, code):
                c.validate_baseline_ledger({'database':'budu_bj006','applied':count,
                                            'failed':0,'ledger':ledger}, baseline)
        with self.assertRaisesRegex(c.ReleaseBlocked, 'MIGRATION_CHECKSUM_MISMATCH'):
            c.validate_after_ledger({'database':'budu_bj006','applied':86,'failed':0,
                                     'ledger':{**actual,c.MIGRATION_NAME:'0'*64}}, actual)

    def test_unknown_schema_or_runtime_change_denied(self):
        with patch.object(c, 'git', side_effect=lambda _repo,*args:
                          c.BUSINESS_SHA if args[:1] == ('merge-base',) else
                          'server/products.js' if args[:2] == ('diff','--name-only') else
                          'a'*40 if args == ('rev-parse','HEAD') else ''):
            with self.assertRaisesRegex(c.ReleaseBlocked,'SKU_BUSINESS_RUNTIME_CHANGED'):
                c.validate_identity(ROOT, 'a'*40)

    def test_wrong_business_ancestor_denied(self):
        with patch.object(c,'git',side_effect=lambda _repo,*args:
                          '0'*40 if args[:1] == ('merge-base',) else
                          'a'*40 if args == ('rev-parse','HEAD') else ''):
            with self.assertRaisesRegex(c.ReleaseBlocked,'SKU_BUSINESS_ANCESTRY_INVALID'):
                c.validate_identity(ROOT,'a'*40)


class RollbackPhase(unittest.TestCase):
    def test_barrier_is_durable_and_never_rewinds(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'manifest.json'
            c.write_manifest(path, c.PRE_CUTOVER, releaseSha='a'*40)
            self.assertEqual(c.rollback_decision(c.load_manifest(path),'RUNTIME'),
                             'RESTORE_PRE_MIGRATION_DATABASE')
            c.write_manifest(path, c.POST_CUTOVER, releaseSha='a'*40)
            self.assertEqual(json.loads(path.read_text())['allowedRollbackMode'],
                             'APPLICATION_SAFE_DEGRADED_ONLY')
            self.assertEqual(c.rollback_decision(c.load_manifest(path),'RUNTIME'),
                             'APPLICATION_ROLLBACK_SAFE_DEGRADED')
            self.assertEqual(c.rollback_decision(c.load_manifest(path),'DATA_INTEGRITY'),
                             c.DATA_INTEGRITY_HOLD)
            with self.assertRaisesRegex(c.ReleaseBlocked, 'ROLLBACK_PHASE_REWIND_FORBIDDEN'):
                c.write_manifest(path, c.PRE_CUTOVER)
            c.write_manifest(path, c.DATA_INTEGRITY_HOLD)
            self.assertEqual(c.rollback_decision(c.load_manifest(path),'RUNTIME'),
                             c.DATA_INTEGRITY_HOLD)

    def test_missing_or_corrupt_manifest_denies_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'missing'
            with self.assertRaisesRegex(c.ReleaseBlocked, 'ROLLBACK_MANIFEST_UNAVAILABLE'):
                c.load_manifest(path)
            path.write_text('{')
            with self.assertRaisesRegex(c.ReleaseBlocked, 'ROLLBACK_MANIFEST_UNAVAILABLE'):
                c.load_manifest(path)

    def test_all_post_cutover_failures_forbid_restore(self):
        for phase in (c.POST_CUTOVER, c.DATA_INTEGRITY_HOLD):
            for failure in ('RUNTIME','DATA_INTEGRITY'):
                decision = c.rollback_decision(c.manifest_payload(phase),failure)
                self.assertNotEqual(decision, 'RESTORE_PRE_MIGRATION_DATABASE')


if __name__ == '__main__':
    unittest.main()

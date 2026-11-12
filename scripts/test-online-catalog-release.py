#!/usr/bin/env python3
"""Tests for the ONLINE-CATALOG-ADMIN-001 release contract.

Runs read-only against the current checkout. No SSH, no production access.
"""
import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('contract', REPO / 'scripts/deploy-prod-online-catalog.py')
contract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(contract)


def git(*args):
    return subprocess.check_output(['git', '-C', str(REPO), *args], text=True)


class LedgerTests(unittest.TestCase):
    def test_base_ledger_has_91_migrations(self):
        self.assertEqual(len(contract.ledger(REPO, contract.BASE)), 91)

    def test_worktree_adds_exactly_one_migration(self):
        base = contract.ledger(REPO, contract.BASE)
        now = contract.ledger(REPO)
        self.assertEqual(len(now), 92)
        self.assertEqual(set(now) - set(base), {contract.MIGRATION})
        self.assertEqual(now[contract.MIGRATION], contract.SQL_HASH)

    def test_historical_migration_bytes_are_unchanged(self):
        base = contract.ledger(REPO, contract.BASE)
        now = contract.ledger(REPO)
        for name, value in base.items():
            self.assertEqual(now[name], value, name)


class ScopeTests(unittest.TestCase):
    def test_business_scope_is_pinned(self):
        files = set(git('diff', '--name-only', contract.BASE, contract.BUSINESS).splitlines())
        self.assertEqual(files, contract.BUSINESS_FILES)

    def test_engineering_scope_is_pinned(self):
        files = set(git('diff', '--name-only', contract.BUSINESS, 'HEAD').splitlines())
        self.assertEqual(files, contract.ENGINEERING_FILES)

    def test_controller_is_untouched(self):
        self.assertEqual(contract.digest((REPO / 'scripts/deploy-prod-transfer-cas.py').read_bytes()),
                         contract.CONTROLLER_HASH)


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.head = git('rev-parse', 'HEAD').strip()

    def test_identity_passes_on_the_release_commit(self):
        result = contract.identity(REPO, self.head)
        self.assertEqual(result['result'], 'IDENTITY_PASS')
        self.assertFalse(result['deployImplemented'])

    def test_wrong_sql_hash_is_rejected(self):
        original = contract.SQL_HASH
        contract.SQL_HASH = '0' * 64
        try:
            with self.assertRaises(contract.Blocked):
                contract.identity(REPO, self.head)
        finally:
            contract.SQL_HASH = original

    def test_extra_engineering_file_is_rejected(self):
        original = set(contract.ENGINEERING_FILES)
        contract.ENGINEERING_FILES.add('scripts/not-reviewed.py')
        try:
            with self.assertRaises(contract.Blocked):
                contract.identity(REPO, self.head)
        finally:
            contract.ENGINEERING_FILES = original

    def test_deploy_without_archive_is_rejected(self):
        output = subprocess.run(
            [sys.executable, str(REPO / 'scripts/deploy-prod-online-catalog.py'), 'deploy',
             '--repo', str(REPO), '--release-sha', self.head],
            capture_output=True, text=True)
        self.assertEqual(output.returncode, 1)
        self.assertIn('ARCHIVE_REQUIRED', output.stdout)


class MigrationSqlTests(unittest.TestCase):
    def test_sql_locks_ledger_and_inserts_checksum(self):
        sql = contract.migration_sql({
            'release': 'a' * 40,
            'oldLedger': {'m1': 'c' * 64},
            'sql': 'CREATE TABLE demo(id int);',
        })
        self.assertIn('LOCK TABLE "_prisma_migrations" IN SHARE ROW EXCLUSIVE MODE', sql)
        self.assertIn("to_regclass('online_categories') IS NOT NULL", sql)
        self.assertIn('CREATE TABLE demo(id int);', sql)
        self.assertIn(contract.SQL_HASH, sql)
        self.assertIn(contract.MIGRATION, sql)
        self.assertTrue(sql.rstrip().endswith('COMMIT;'))

    def test_sql_pins_the_old_ledger(self):
        sql = contract.migration_sql({'release': 'a' * 40, 'oldLedger': {'m1': 'c' * 64}, 'sql': ''})
        self.assertIn('"m1": "c"', sql.replace("'", '"'))


if __name__ == '__main__':
    unittest.main(verbosity=2)

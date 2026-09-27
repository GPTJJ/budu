#!/usr/bin/env python3
"""Offline tests for Gate 8A-v4 image transport behavior."""
import contextlib
import hashlib
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location(
    'sku_deploy_transport', ROOT/'scripts/deploy-prod-sku-authority.py')
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


class Remote:
    ssh = ['ssh', 'ubuntu@example.invalid']


def artifact(path):
    data = path.read_bytes()
    return {
        'archive': len(data),
        'archiveHash': hashlib.sha256(data).hexdigest(),
        'imageReference': 'budu-api:test',
    }


class TransportTests(unittest.TestCase):
    def test_timeout_budget_is_larger_than_incident_limit_and_bounded(self):
        self.assertEqual(deploy.image_load_timeout_seconds(1), 600)
        self.assertGreater(deploy.image_load_timeout_seconds(256 * 1024 * 1024), 240)
        self.assertLessEqual(
            deploy.image_load_timeout_seconds(deploy.core.MAX_ARCHIVE),
            deploy.IMAGE_LOAD_MAX_TIMEOUT_SECONDS)

    def test_success_emits_stage_markers_and_uses_dynamic_timeout(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'image.tar'
            path.write_bytes(b'x' * 1024)
            art = artifact(path)
            completed = types.SimpleNamespace(returncode=0)
            output = io.StringIO()
            with patch.object(deploy.subprocess, 'run', return_value=completed) as run,                  patch.object(deploy.time, 'monotonic', side_effect=[10.0, 15.0]),                  contextlib.redirect_stdout(output):
                deploy.load_image_archive(Remote(), path, art, 'runtime')
            args, kwargs = run.call_args
            self.assertIn('timeout --signal=TERM --kill-after=30s', args[0][-1])
            self.assertTrue(args[0][-1].endswith(' docker load'))
            self.assertGreaterEqual(kwargs['timeout'], 660)
            self.assertIn('"event": "SKU_IMAGE_LOAD_START"', output.getvalue())
            self.assertIn('"event": "SKU_IMAGE_LOAD_COMPLETE"', output.getvalue())

    def test_timeout_is_explicit_and_requires_audit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'image.tar'
            path.write_bytes(b'abc')
            art = artifact(path)
            with patch.object(deploy.subprocess, 'run',
                              side_effect=subprocess.TimeoutExpired(['ssh'], 600)):
                with self.assertRaisesRegex(
                    deploy.core.GateError,
                    'SKU_RUNTIME_IMAGE_LOAD_TIMEOUT_AUDIT_REQUIRED'):
                    deploy.load_image_archive(Remote(), path, art, 'runtime')

    def test_remote_timeout_exit_is_explicit_and_requires_audit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'image.tar'
            path.write_bytes(b'abc')
            art = artifact(path)
            with patch.object(
                    deploy.subprocess, 'run',
                    return_value=types.SimpleNamespace(returncode=124)):
                with self.assertRaisesRegex(
                    deploy.core.GateError,
                    'SKU_RUNTIME_IMAGE_LOAD_TIMEOUT_AUDIT_REQUIRED'):
                    deploy.load_image_archive(Remote(), path, art, 'runtime')

    def test_migration_transport_failure_is_stage_specific(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'migration.tar'
            path.write_bytes(b'abc')
            art = artifact(path)
            with patch.object(
                    deploy.subprocess, 'run',
                    return_value=types.SimpleNamespace(returncode=1)):
                with self.assertRaisesRegex(
                    deploy.core.GateError, 'SKU_MIGRATION_IMAGE_LOAD_FAILED'):
                    deploy.load_image_archive(Remote(), path, art, 'migration')

    def test_archive_hash_drift_denied_before_transport(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'image.tar'
            path.write_bytes(b'abc')
            art = artifact(path)
            art['archiveHash'] = '0' * 64
            with patch.object(deploy.subprocess, 'run') as run:
                with self.assertRaisesRegex(
                    deploy.core.GateError, 'SKU_ARTIFACT_CHANGED'):
                    deploy.load_image_archive(Remote(), path, art, 'runtime')
                run.assert_not_called()

    def test_old_240_second_transport_limit_is_removed(self):
        source = (ROOT/'scripts/deploy-prod-sku-authority.py').read_text()
        self.assertNotIn('timeout=240', source)
        self.assertIn("load_image_archive(remote,archive,art,'runtime')", source)
        self.assertIn("load_image_archive(remote,migration_archive,migration_art,'migration')",
                      source)
        release = (ROOT/'scripts/release-prod-sku-authority-ci.sh').read_text()
        self.assertIn('timeout 90m python3 scripts/deploy-prod-sku-authority.py deploy',
                      release)


if __name__ == '__main__':
    unittest.main()

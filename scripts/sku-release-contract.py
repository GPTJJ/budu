#!/usr/bin/env python3
"""SKU-only release identity and lossless rollback decisions.

This module never connects to production. The production adapter must call
persist_barrier before its first public route mutation and load the persisted
phase in every failure handler.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

PRODUCTION_SHA = '5ad27a06d731fbc94de5ae3776060b4350b886e8'
BUSINESS_SHA = '10d3c7ea5297fb0531ad59b20703ddba9d031bba'
MIGRATION_NAME = '20260927190000_sku_authority_candidate'
MIGRATION_SHA256 = 'd62859e9d2ba54f6dd847841f33a81c4ffb843ea653a7b15dddc6370c9b6fa2b'
GUARD_BODY_HASHES = {
    'product_sku_insert_guard': '72b0205d3f28128edb4020fb7366ab9a59abdb7da124fa817821b4fcf352dd18',
    'product_sku_product_guard': 'c14176a7265a374395f236476620e076487898b29c5cc33c772eec2564ce014b',
}
BEFORE = 85
AFTER = 86
ENGINEERING_FILES = frozenset({
    'scripts/sku-release-contract.py',
    'scripts/sku-release-controller.py',
    'scripts/sku-release-operations.py',
    'scripts/deploy-prod-sku-authority.py',
    'scripts/sku-release-apply.mjs',
    'scripts/sku-release-readiness-plan.mjs',
    'scripts/sku-release-snapshot-probe.mjs',
    'scripts/release-prod-sku-authority-ci.sh',
    'scripts/test-sku-release-lossless-native.py',
    'scripts/test-sku-release-restore-native.py',
    'scripts/test-sku-release-apply-native.mjs',
    'scripts/test-sku-release-contract.py',
    'scripts/test-sku-release-controller.py',
    'scripts/test-sku-release-readiness.py',
    'scripts/test-sku-release-readiness.mjs',
    'scripts/test-sku-release-transport.py',
    '.github/workflows/deploy-prod.yml',
    '.github/workflows/sku-release-build-only.yml',
    '.github/fixtures/sku-release-gate7-readiness.json',
    'docs/checkpoints/2026-09-27-sku-release-controller-v2.md',
    'docs/checkpoints/2026-09-28-sku-release-controller-v3.md',
    'docs/checkpoints/2026-09-28-sku-release-controller-v4.md',
})
PRE_CUTOVER = 'PRE_CUTOVER'
POST_CUTOVER = 'POST_CUTOVER'
DATA_INTEGRITY_HOLD = 'DATA_INTEGRITY_HOLD'
ROLLBACK_MODES = {
    PRE_CUTOVER: 'FULL_DB_RESTORE',
    POST_CUTOVER: 'APPLICATION_SAFE_DEGRADED_ONLY',
    DATA_INTEGRITY_HOLD: 'NO_AUTOMATIC_DATABASE_RESTORE',
}


class ReleaseBlocked(Exception):
    pass


def require(ok, code):
    if not ok:
        raise ReleaseBlocked(code)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def git(repo, *args):
    result = subprocess.run(['git', '-C', str(repo), *args], stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, check=False)
    require(result.returncode == 0, 'GIT_IDENTITY_UNAVAILABLE')
    return result.stdout.decode().strip()


def approved_ledger(repo, ref):
    tree = git(repo, 'ls-tree', '-r', '--name-only', ref, '--', 'prisma/migrations').splitlines()
    paths = [p for p in tree if p.endswith('/migration.sql')]
    require(len(paths) == BEFORE, 'BASELINE_MIGRATION_COUNT_INVALID')
    return {Path(p).parent.name: sha256(subprocess.check_output(
        ['git', '-C', str(repo), 'show', f'{ref}:{p}'], stderr=subprocess.DEVNULL))
        for p in paths}


def validate_identity(repo, release=None):
    repo = Path(repo)
    release = release or git(repo, 'rev-parse', 'HEAD')
    require(bool(re.fullmatch(r'[0-9a-f]{40}', release)), 'RELEASE_SHA_INVALID')
    require(git(repo, 'rev-parse', 'HEAD') == release, 'RELEASE_SHA_NOT_HEAD')
    require(release != BUSINESS_SHA, 'RELEASE_ENGINEERING_COMMIT_REQUIRED')
    require(git(repo, 'merge-base', BUSINESS_SHA, release) == BUSINESS_SHA,
            'SKU_BUSINESS_ANCESTRY_INVALID')
    require(not git(repo, 'status', '--porcelain', '--untracked-files=all'), 'WORKTREE_NOT_CLEAN')
    changed = set(git(repo, 'diff', '--name-only', BUSINESS_SHA, release).splitlines())
    require(changed <= ENGINEERING_FILES, 'SKU_BUSINESS_RUNTIME_CHANGED')
    require(not git(repo, 'diff', '--name-only', BUSINESS_SHA, release, '--',
                    'server', 'prisma', 'shared', 'src', 'brand', 'Dockerfile',
                    'package.json', 'package-lock.json'), 'SKU_BUSINESS_RUNTIME_CHANGED')
    require((repo / 'prisma/schema.prisma').read_bytes() == subprocess.check_output(
        ['git', '-C', str(repo), 'show', BUSINESS_SHA + ':prisma/schema.prisma']),
        'SKU_SCHEMA_DRIFT')
    baseline, actual = validate_migration_files(repo)
    # The approved business tree, not the mutable release branch, owns every
    # schema and migration byte.
    for name, checksum in actual.items():
        source = subprocess.check_output(['git', '-C', str(repo), 'show',
            f'{BUSINESS_SHA}:prisma/migrations/{name}/migration.sql'],
            stderr=subprocess.DEVNULL)
        require(sha256(source) == checksum, 'SKU_BUSINESS_MIGRATION_DRIFT')
    return release, baseline, actual


def validate_migration_files(repo):
    repo = Path(repo)
    baseline = approved_ledger(repo, PRODUCTION_SHA)
    paths = list((repo / 'prisma/migrations').glob('*/migration.sql'))
    require(len(paths) == AFTER, 'SKU_MIGRATION_COUNT_INVALID')
    actual = {p.parent.name: sha256(p.read_bytes()) for p in paths}
    require(set(actual) == set(baseline) | {MIGRATION_NAME}, 'SKU_MIGRATION_SET_INVALID')
    require(all(actual[name] == value for name, value in baseline.items()),
            'BASELINE_MIGRATION_CHECKSUM_DRIFT')
    require(actual[MIGRATION_NAME] == MIGRATION_SHA256, 'SKU_MIGRATION_CHECKSUM_DRIFT')
    source = (repo/'prisma/migrations'/MIGRATION_NAME/'migration.sql').read_text()
    for name, checksum in GUARD_BODY_HASHES.items():
        tag = '$sku_guard$' if name == 'product_sku_insert_guard' else '$$'
        match = re.search(r'CREATE OR REPLACE FUNCTION '+name+r'\(\) RETURNS trigger AS '+
                          re.escape(tag)+r'(.*?)'+re.escape(tag)+r' LANGUAGE',source,re.S)
        require(match is not None and sha256(match.group(1).strip().encode()) == checksum,
                'SKU_GUARD_SOURCE_DRIFT')
    return baseline, actual


def validate_baseline_ledger(db, baseline):
    require(db.get('database') == 'budu_bj006', 'DATABASE_AUTHORITY_MISMATCH')
    require(db.get('applied') == BEFORE and db.get('failed') == 0,
            'MIGRATION_LEDGER_INVALID')
    require(db.get('ledger') == baseline, 'MIGRATION_CHECKSUM_MISMATCH')


def validate_after_ledger(db, actual):
    require(db.get('database') == 'budu_bj006', 'DATABASE_AUTHORITY_MISMATCH')
    require(db.get('applied') == AFTER and db.get('failed') == 0,
            'MIGRATION_LEDGER_INVALID')
    require(db.get('ledger') == actual, 'MIGRATION_CHECKSUM_MISMATCH')


def manifest_payload(phase, **extra):
    require(phase in ROLLBACK_MODES, 'ROLLBACK_PHASE_INVALID')
    return {'phase': phase, 'allowedRollbackMode': ROLLBACK_MODES[phase], **extra}


def write_manifest(path, phase, **extra):
    """Atomic, fsynced phase record; never move backwards after the barrier."""
    path = Path(path)
    if path.exists():
        previous = json.loads(path.read_text())
        require(previous.get('phase') in ROLLBACK_MODES, 'ROLLBACK_MANIFEST_INVALID')
        require(previous['phase'] == PRE_CUTOVER or phase != PRE_CUTOVER,
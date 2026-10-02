#!/usr/bin/env python3
"""Transfer CAS only: inspect-artifact / preflight / explicitly authorized deploy.

All command output, inspect environments and credentials stay in process memory.
Only fixed error codes and an allowlisted summary are printed. No shell tracing.
The existing cloner is used only AFTER the previous writer has stopped.
"""
import argparse
import gzip
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import signal
from urllib.parse import urlsplit, unquote

EXPECTED_OLD_SHA = 'fc57da5a6e6611c66ed1db286336dc0e1752d69c'
RUNTIME_SHA = '8381959e9c1d527c1f14c234338b14d117ae46f5'
RELEASE_BASE = '90cba06afb176d002b9b924f167cd79c8268460f'
TRANSFER_INSTALLED_SHA = '2fa28a6399c8a9f4fd70188d8df077f0b411589e'
RELEASE_PROFILE = 'transfer-first'
IMAGE_PREFIX = 'transfer-cas-'
CONTAINER_SUFFIX = '-transfer-cas'
ROLLBACK_PREFIX = 'transfer-cas-'
MEASURE_ONLY = False  # Deployment still requires exact-SHA explicit authorization.
EXPECTED_DB = 'budu_bj006'
EXPECTED_MIGRATIONS = 85
MIGRATION_REQUIRED = 'NO'
OLD_V2_HASH = '12d203f0c4cf451d41db314d513c3fe223169f9b51925f1403fa499848f61fc5'
HOST = 'ubuntu@154.8.195.42'
NGINX = 'budu-nginx-1'
PG = 'budu-bj-006-final-restore-20260822-055653z-pg'
TEMPLATE = '/opt/budu/deploy/nginx/conf.d/budu.conf.template'
ACTIVE = '/etc/nginx/conf.d/budu.conf'
LOCK = '/run/lock/budu-transfer-cas-release'
STAGING_ROOT = '/opt/budu/.release-staging'
UPLOAD_TIMEOUT = 4 * 60 * 60
ALLOWLIST = {
    'scripts/deploy-prod-transfer-cas.sh',
    'scripts/deploy-prod-transfer-cas.py',
    'scripts/test-deploy-prod-transfer-cas.py',
    'docs/checkpoints/2026-09-26-transfer-cas-release.md',
    'scripts/deploy-remote.sh',
    'scripts/release-prod-transfer-cas-ci.sh',
    'scripts/test-transfer-cas-existing-workflow.py',
}
POST_TRANSFER_ENGINEERING_FILES = {
    '.github/workflows/deploy-prod.yml',
    '.github/workflows/release-build-only.yml',
    'scripts/deploy-remote.sh',
    'scripts/deploy-prod-transfer-cas.py',
    'scripts/release-prod-post-transfer-ci.sh',
    'scripts/test-deploy-prod-transfer-cas.py',
    'scripts/test-candidate-db-probe-integration.py',
    'scripts/test-release-path-post-transfer.py',
    'scripts/test-transfer-cas-existing-workflow.py',
}
SHIPPING_OLD_SHA = '68cee84efe30409e7e18e4459e08982f6c20e254'
SHIPPING_BUSINESS_SHA = '7a7aed7f9f4bba9514c2fd001358e6b3adf64c0c'
SHIPPING_BRANCH = 'codex/shipping-review-actual-quantity-20261002'
SHIPPING_DIAGNOSTIC_BRANCH = 'codex/shipping-controller-diagnostic-20261002'
SHIPPING_ENGINEERING_SHA = 'dc1fe91f74af41a34bcc30ba65caf8548cb1a3d0'
SHIPPING_BACKUP_DIAGNOSTIC_BRANCH = 'codex/shipping-backup-diagnostic-20261002'
SHIPPING_BACKUP_DIAGNOSTIC_PARENT = '58d952b4e206c9eb4cea8f86fd4d51635b36a8fb'
SHIPPING_BACKUP_READINESS_BASE = '904478e7287d7e2f3a6648ba6cc27712a7ae973e'
SHIPPING_BACKUP_DIAGNOSTIC_FILES = {
    '.github/workflows/release-build-only.yml',
    'scripts/deploy-prod-transfer-cas.py',
    'scripts/test-candidate-db-probe-integration.py',
    'scripts/test-release-path-post-transfer.py',
}
SHIPPING_DIAGNOSTIC_FILES = {
    '.github/workflows/release-build-only.yml',
    'scripts/deploy-prod-transfer-cas.py',
    'scripts/test-candidate-db-probe-integration.py',
    'scripts/test-deploy-prod-transfer-cas.py',
    'scripts/test-release-path-post-transfer.py',
}
SHIPPING_MIGRATION = '20261002000000_transfer_actual_quantity_reference'
SHIPPING_SQL_HASH = '9610399f90cbd364a491908462affca3138594225673edfb650c4b5170da3872'
SHIPPING_ENGINEERING_FILES = {
    'scripts/deploy-prod-transfer-cas.py',
    'scripts/test-deploy-prod-transfer-cas.py',
    'scripts/test-release-path-post-transfer.py',
    'scripts/test-transfer-cas-existing-workflow.py',
    'scripts/test-candidate-db-probe-integration.py',
    '.github/workflows/release-build-only.yml',
}
SHIPPING_CHECK_OLD = 'CHECK ((("shippedQuantity" IS NULL) OR (("shippedQuantity" >= 0) AND ("shippedQuantity" <= quantity))))'
SHIPPING_CHECK_NEW = 'CHECK ((("shippedQuantity" IS NULL) OR (("shippedQuantity" >= 0) AND ("shippedQuantity" <= 999999))))'
CURRENT_SHA_FILE = '/opt/budu/.current-sha'
HOST_DEFAULTS = {'Memory': 0, 'MemoryReservation': 0, 'MemorySwap': 0, 'MemorySwappiness': None, 'NanoCpus': 0, 'CpuShares': 0, 'CpuPeriod': 0, 'CpuQuota': 0, 'CpusetCpus': '', 'CpusetMems': '', 'PidsLimit': None, 'Ulimits': [], 'ShmSize': 67108864, 'IpcMode': 'private', 'PidMode': '', 'UTSMode': '', 'CgroupnsMode': 'private', 'ExtraHosts': None, 'Dns': None, 'DnsOptions': [], 'DnsSearch': [], 'Devices': [], 'DeviceRequests': None, 'Sysctls': None, 'OomKillDisable': None, 'AutoRemove': False}
GIB = 1024 ** 3
# Admission bounds, not an assertion that an unbuilt image has these sizes.
MAX_ARCHIVE = 768 * 1024 ** 2
ABSOLUTE_MAX_PEAK = 6 * GIB
MAX_LAYER_STREAM = 4 * GIB  # Existing independent expansion bound is unchanged.
MAX_IMAGE_SIZE = 4 * GIB
MAX_PROJECTED_USAGE = 85
MIN_PROJECTED_AVAILABLE = 10 * GIB
RESERVE = 512 * 1024 ** 2
MAX_MEMBERS = 150000
REVISION = 'org.opencontainers.image.revision'
IDENTITY_KEYS = ('User', 'WorkingDir', 'Entrypoint', 'Cmd', 'ExposedPorts', 'Healthcheck')

class GateError(Exception):
    pass

def require(ok, code):
    if not ok:
        raise GateError(code)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def command(args, data=None, timeout=60):
    try:
        r = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise GateError('COMMAND_UNAVAILABLE_OR_TIMEOUT') from None
    require(r.returncode == 0, 'COMMAND_FAILED')
    return r.stdout

def file_hash(stream):
    h = hashlib.sha256()
    while True:
        block = stream.read(1024 * 1024)
        if not block:
            return h.hexdigest()
        h.update(block)


def runtime_payload(repo):
    paths = git(repo, 'ls-files', '--', 'server', 'shared', 'src/utils', 'prisma', 'scripts', 'brand/web', 'package.json', 'package-lock.json').splitlines()
    return {'app/' + p:digest((Path(repo)/p).read_bytes()) for p in paths if not p.startswith('server/data/')}


def git(repo, *args):
    return command(['git', '-C', str(repo), *args]).decode().strip()

def configure_profile(profile, old_sha=None, business_sha=None, old_v2_hash=None):
    global RELEASE_PROFILE, EXPECTED_OLD_SHA, RUNTIME_SHA, OLD_V2_HASH
    global IMAGE_PREFIX, CONTAINER_SUFFIX, ROLLBACK_PREFIX
    require(profile in ('transfer-first', 'post-transfer'), 'RELEASE_PROFILE_INVALID')
    if profile == 'transfer-first':
        require(old_sha is None and business_sha is None and old_v2_hash is None,
                'FIRST_ROLLOUT_IDENTITY_OVERRIDE_FORBIDDEN')
        return
    require(all(isinstance(value, str) and re.fullmatch(r'[0-9a-f]{40}', value)
                for value in (old_sha, business_sha))
            and isinstance(old_v2_hash, str) and re.fullmatch(r'[0-9a-f]{64}', old_v2_hash),
            'POST_TRANSFER_IDENTITY_INVALID')
    RELEASE_PROFILE = profile
    EXPECTED_OLD_SHA = old_sha
    RUNTIME_SHA = business_sha
    OLD_V2_HASH = old_v2_hash
    IMAGE_PREFIX = 'post-transfer-'
    CONTAINER_SUFFIX = '-post-transfer'
    ROLLBACK_PREFIX = 'post-transfer-'

def shipping_migration():
    # This is one reviewed business pair, never a count/schema override.
    return (RELEASE_PROFILE == 'post-transfer' and EXPECTED_OLD_SHA == SHIPPING_OLD_SHA
            and RUNTIME_SHA == SHIPPING_BUSINESS_SHA)


def before_ledger(ledger):
    if not shipping_migration():
        return ledger
    require(len(ledger) == 86 and ledger.get(SHIPPING_MIGRATION) == SHIPPING_SQL_HASH,
            'SHIPPING_MIGRATION_CONTRACT_INVALID')
    return {name: checksum for name, checksum in ledger.items() if name != SHIPPING_MIGRATION}


def validate_shipping_identity(repo, release):
    require(git(repo, 'branch', '--show-current') == SHIPPING_BRANCH, 'SHIPPING_BRANCH_INVALID')
    require(release != SHIPPING_BUSINESS_SHA and
            git(repo, 'rev-list', '--parents', '-n', '1', release).split() == [release, SHIPPING_BUSINESS_SHA],
            'SHIPPING_ENGINEERING_PARENT_INVALID')
    require(set(git(repo, 'diff', '--name-only', SHIPPING_BUSINESS_SHA, release).splitlines())
            == SHIPPING_ENGINEERING_FILES, 'SHIPPING_ENGINEERING_SCOPE_INVALID')
    path = 'prisma/migrations/' + SHIPPING_MIGRATION + '/migration.sql'
    require(git(repo, 'diff', '--name-only', SHIPPING_OLD_SHA, release, '--', 'prisma') == path,
            'SHIPPING_MIGRATION_SCOPE_INVALID')
    require(git(repo, 'diff', '--diff-filter=A', '--name-only', SHIPPING_OLD_SHA, release, '--', path) == path,
            'SHIPPING_MIGRATION_SCOPE_INVALID')
    require(digest((Path(repo)/path).read_bytes()) == SHIPPING_SQL_HASH, 'SHIPPING_SQL_HASH_INVALID')


def is_ancestor(repo, ancestor, descendant):
    return subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', ancestor, descendant],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0

def transfer_cas_section(source):
    start = b"v2Router.delete('/transfer-requests/:id'"
    end = '// ---------- 采购 ----------'.encode()
    require(source.count(start) == 1, 'TRANSFER_CAS_RUNTIME_CHANGED')
    left = source.index(start)
    require(end in source[left:], 'TRANSFER_CAS_RUNTIME_CHANGED')
    right = source.index(end, left)
    return source[left:right]

def validate_post_transfer_identity(repo, release):
    require(git(repo, 'branch', '--show-current') not in ('', 'codex/transfer-cas-existing-workflow'),
            'POST_TRANSFER_BRANCH_INVALID')
    require(release != EXPECTED_OLD_SHA
            and is_ancestor(repo, TRANSFER_INSTALLED_SHA, EXPECTED_OLD_SHA)
            and is_ancestor(repo, '8381959e9c1d527c1f14c234338b14d117ae46f5', EXPECTED_OLD_SHA)
            and is_ancestor(repo, EXPECTED_OLD_SHA, RUNTIME_SHA)
            and is_ancestor(repo, RUNTIME_SHA, release), 'POST_TRANSFER_ANCESTRY_INVALID')
    if shipping_migration():
        validate_shipping_identity(repo, release)
    else:
        require(not git(repo, 'diff', '--name-only', EXPECTED_OLD_SHA, release, '--', 'prisma'),
                'SCHEMA_CHANGED')
    deployed_transfer = command(['git','-C',str(repo),'show',TRANSFER_INSTALLED_SHA+':server/v2.js'])
    require(transfer_cas_section((Path(repo)/'server/v2.js').read_bytes())
            == transfer_cas_section(deployed_transfer), 'TRANSFER_CAS_RUNTIME_CHANGED')
    files = set(git(repo, 'diff', '--name-only', RUNTIME_SHA, release).splitlines())
    require(files <= POST_TRANSFER_ENGINEERING_FILES, 'POST_TRANSFER_RUNTIME_CHANGED')
    require(not git(repo, 'status', '--porcelain', '--untracked-files=all'), 'WORKTREE_NOT_CLEAN')
    command(['git', '-C', str(repo), 'diff', '--check', EXPECTED_OLD_SHA, release])

def validate_identity(release, parent, ancestor, files, schema_files, clean):
    require(bool(re.fullmatch('[0-9a-f]{40}', release)) and release != RUNTIME_SHA, 'RELEASE_SHA_INVALID')
    require(parent == RELEASE_BASE and ancestor, 'RELEASE_ANCESTRY_INVALID')
    require(set(files) == ALLOWLIST, 'RELEASE_DIFF_OUTSIDE_ALLOWLIST')
    require(not schema_files, 'SCHEMA_CHANGED')
    require(clean, 'WORKTREE_NOT_CLEAN')

def identity(repo):
    require(Path(__file__).resolve() == (Path(repo)/'scripts/deploy-prod-transfer-cas.py').resolve(), 'RUNNER_REPO_MISMATCH')
    release = git(repo, 'rev-parse', 'HEAD')
    if RELEASE_PROFILE == 'post-transfer':
        validate_post_transfer_identity(repo, release)
        migrations = {p.parent.name: digest(p.read_bytes()) for p in (Path(repo) / 'prisma/migrations').glob('*/migration.sql')}
        require(len(migrations) == (86 if shipping_migration() else EXPECTED_MIGRATIONS), 'LOCAL_MIGRATION_COUNT_INVALID')
        before_ledger(migrations)
        return release, migrations
    require(git(repo, 'branch', '--show-current') == 'codex/transfer-cas-existing-workflow', 'RELEASE_BRANCH_INVALID')
    parents = git(repo, 'rev-list', '--parents', '-n', '1', release).split()
    files = git(repo, 'diff', '--name-only', RUNTIME_SHA, release).splitlines()
    schemas = git(repo, 'diff', '--name-only', EXPECTED_OLD_SHA, release, '--', 'prisma').splitlines()
    validate_identity(release, parents[1] if len(parents) == 2 else '',
                      git(repo, 'merge-base', RUNTIME_SHA, release) == RUNTIME_SHA,
                      files, schemas, not git(repo, 'status', '--porcelain', '--untracked-files=all'))
    command(['git', '-C', str(repo), 'diff', '--check', RUNTIME_SHA, release])
    require(not git(repo, 'log', '--format=', '--name-only', EXPECTED_OLD_SHA+'..'+release, '--', '.github/workflows'), 'WORKFLOW_HISTORY_CHANGED')
    for f in files:
        change = 'M' if f == 'scripts/deploy-remote.sh' else 'A'
        require(git(repo, 'diff', '--diff-filter='+change, '--name-only', RUNTIME_SHA, release, '--', f) == f,
                'RELEASE_FILE_CHANGE_TYPE_INVALID')
    migrations = {p.parent.name: digest(p.read_bytes()) for p in (Path(repo) / 'prisma/migrations').glob('*/migration.sql')}
    require(len(migrations) == EXPECTED_MIGRATIONS, 'LOCAL_MIGRATION_COUNT_INVALID')
    return release, migrations

def diagnostic_identity(repo):
    """Read-only admission for one diagnostic child of the public E commit.

    Production identity/preflight/deploy keep their original branch rules.
    This does not generalize production ancestry or admit another SQL payload.
    """
    require(Path(__file__).resolve() == (Path(repo)/'scripts/deploy-prod-transfer-cas.py').resolve(), 'RUNNER_REPO_MISMATCH')
    require(shipping_migration(), 'SHIPPING_DIAGNOSTIC_PROFILE_INVALID')
    require(git(repo, 'branch', '--show-current') == SHIPPING_DIAGNOSTIC_BRANCH, 'SHIPPING_DIAGNOSTIC_BRANCH_INVALID')
    release = git(repo, 'rev-parse', 'HEAD')
    require(bool(re.fullmatch('[0-9a-f]{40}', release)) and release != SHIPPING_ENGINEERING_SHA,
            'SHIPPING_DIAGNOSTIC_SHA_INVALID')
    for child, parent in ((release, SHIPPING_ENGINEERING_SHA),
                          (SHIPPING_ENGINEERING_SHA, SHIPPING_BUSINESS_SHA),
                          (SHIPPING_BUSINESS_SHA, SHIPPING_OLD_SHA)):
        require(git(repo, 'rev-list', '--parents', '-n', '1', child).split() == [child, parent],
                'SHIPPING_DIAGNOSTIC_PARENT_INVALID')
    for base, files in ((SHIPPING_ENGINEERING_SHA, SHIPPING_DIAGNOSTIC_FILES),
                        (SHIPPING_BUSINESS_SHA, SHIPPING_ENGINEERING_FILES)):
        require(set(git(repo, 'diff', '--name-only', base, release).splitlines()) == files,
                'SHIPPING_DIAGNOSTIC_SCOPE_INVALID')
    path = 'prisma/migrations/' + SHIPPING_MIGRATION + '/migration.sql'
    require(git(repo, 'diff', '--name-only', SHIPPING_OLD_SHA, release, '--', 'prisma') == path
            and git(repo, 'diff', '--diff-filter=A', '--name-only', SHIPPING_OLD_SHA, release, '--', path) == path,
            'SHIPPING_MIGRATION_SCOPE_INVALID')
    require(digest((Path(repo)/path).read_bytes()) == SHIPPING_SQL_HASH, 'SHIPPING_SQL_HASH_INVALID')
    require(not git(repo, 'status', '--porcelain', '--untracked-files=all'), 'WORKTREE_NOT_CLEAN')
    command(['git', '-C', str(repo), 'diff', '--check', SHIPPING_ENGINEERING_SHA, release])
    migrations = {p.parent.name: digest(p.read_bytes()) for p in (Path(repo)/'prisma/migrations').glob('*/migration.sql')}
    before_ledger(migrations)
    return release, migrations


def backup_diagnostic_identity(repo):
    """Read-only diagnostic child of public F or the fixed public G readiness base."""
    require(Path(__file__).resolve() == (Path(repo)/'scripts/deploy-prod-transfer-cas.py').resolve(), 'RUNNER_REPO_MISMATCH')
    require(shipping_migration(), 'SHIPPING_DIAGNOSTIC_PROFILE_INVALID')
    require(git(repo, 'branch', '--show-current') == SHIPPING_BACKUP_DIAGNOSTIC_BRANCH, 'SHIPPING_DIAGNOSTIC_BRANCH_INVALID')
    release = git(repo, 'rev-parse', 'HEAD')
    require(bool(re.fullmatch('[0-9a-f]{40}', release)) and release != SHIPPING_BACKUP_DIAGNOSTIC_PARENT,
            'SHIPPING_DIAGNOSTIC_SHA_INVALID')
    ancestry = git(repo, 'rev-list', '--parents', '-n', '1', release).split()
    require(len(ancestry) == 2 and ancestry[0] == release
            and ancestry[1] in (SHIPPING_BACKUP_DIAGNOSTIC_PARENT, SHIPPING_BACKUP_READINESS_BASE),
            'SHIPPING_DIAGNOSTIC_PARENT_INVALID')
    base = ancestry[1]
    if base == SHIPPING_BACKUP_READINESS_BASE:
        require(git(repo, 'rev-list', '--parents', '-n', '1', base).split()
                == [base, SHIPPING_BACKUP_DIAGNOSTIC_PARENT], 'SHIPPING_DIAGNOSTIC_PARENT_INVALID')
    for child, parent in ((release, base),
                          (SHIPPING_BACKUP_DIAGNOSTIC_PARENT, SHIPPING_ENGINEERING_SHA),
                          (SHIPPING_ENGINEERING_SHA, SHIPPING_BUSINESS_SHA),
                          (SHIPPING_BUSINESS_SHA, SHIPPING_OLD_SHA)):
        require(git(repo, 'rev-list', '--parents', '-n', '1', child).split() == [child, parent],
                'SHIPPING_DIAGNOSTIC_PARENT_INVALID')
    for scope_base, files in ((base, SHIPPING_BACKUP_DIAGNOSTIC_FILES),
                              (SHIPPING_BUSINESS_SHA, SHIPPING_ENGINEERING_FILES)):
        require(set(git(repo, 'diff', '--name-only', scope_base, release).splitlines()) == files,
                'SHIPPING_DIAGNOSTIC_SCOPE_INVALID')
    path = 'prisma/migrations/' + SHIPPING_MIGRATION + '/migration.sql'
    require(git(repo, 'diff', '--name-only', SHIPPING_OLD_SHA, release, '--', 'prisma') == path
            and git(repo, 'diff', '--diff-filter=A', '--name-only', SHIPPING_OLD_SHA, release, '--', path) == path,
            'SHIPPING_MIGRATION_SCOPE_INVALID')
    require(digest((Path(repo)/path).read_bytes()) == SHIPPING_SQL_HASH, 'SHIPPING_SQL_HASH_INVALID')
    require(not git(repo, 'status', '--porcelain', '--untracked-files=all'), 'WORKTREE_NOT_CLEAN')
    command(['git', '-C', str(repo), 'diff', '--check', base, release])
    migrations = {p.parent.name: digest(p.read_bytes()) for p in (Path(repo)/'prisma/migrations').glob('*/migration.sql')}
    before_ledger(migrations)
    return release, migrations


def image_reference(release):
    require(bool(re.fullmatch('[0-9a-f]{40}', release)), 'IMAGE_RELEASE_SHA_INVALID')
    return 'budu-api:' + IMAGE_PREFIX + release[:12]


def validate_loaded_image(image, art):
    require(art['imageReference'] == image_reference(art['release']), 'IMAGE_REFERENCE_INVALID')
    require(image.get('RepoTags') == [art['imageReference']], 'LOADED_IMAGE_TAG_MISMATCH')
    require(bool(re.fullmatch(r'sha256:[0-9a-f]{64}', image.get('Id', ''))), 'LOADED_ARTIFACT_MISMATCH')
    require(image['Os'] == 'linux'
            and image['Architecture'] == 'amd64'
            and image['Config'].get('Labels', {}).get(REVISION) == art['release'], 'LOADED_ARTIFACT_MISMATCH')
    require(all(image['Config'].get(k) == art['config'].get(k) for k in IDENTITY_KEYS), 'LOADED_CONFIG_MISMATCH')
    require(image.get('RootFS', {}).get('Layers') == art['rootfsDiffIds'], 'LOADED_ROOTFS_MISMATCH')
    require(0 < image['Size'] <= MAX_IMAGE_SIZE, 'LOADED_IMAGE_SIZE_INVALID')
    return image['Id']


def resolve_loaded_image(remote, art):
    # Config digest authenticates archive content, not Docker's store-specific
    # lookup identity. Never scan images or guess digest prefixes as fallback.
    require(art['imageReference'] == image_reference(art['release']), 'IMAGE_REFERENCE_INVALID')
    image = remote.inspect(art['imageReference'], image=True)
    loaded = validate_loaded_image(image, art)
    require(art.get('loadedDockerImageId', loaded) == loaded, 'LOADED_IMAGE_CHANGED')
    return image


def validate_candidate_image(candidate, art):
    require(candidate['Image'] == art['loadedDockerImageId']
            and candidate['Config'].get('Image') == art['imageReference'], 'CANDIDATE_IMAGE_IDENTITY_MISMATCH')

def disk_budget(used, available, archive, blobs, expanded, largest_layer):
    # containerd import: incoming archive allowance + content blobs + snapshots +
    # one expanded layer of staging + 512 MiB for metadata/runtime/ordinary growth.
    peak = archive + blobs + expanded + largest_layer + RESERVE
    require(0 < archive <= MAX_ARCHIVE and min(blobs, expanded, largest_layer) > 0,
            'ARTIFACT_SIZE_INVALID')
    require(peak <= ABSOLUTE_MAX_PEAK, 'ARTIFACT_DISK_GATE_FAIL:ABSOLUTE_PEAK')
    projected = math.ceil(100 * (used + peak) / (used + available))
    minimum = available - peak
    require(projected <= MAX_PROJECTED_USAGE and minimum >= MIN_PROJECTED_AVAILABLE,
            'ARTIFACT_DISK_GATE_FAIL:DYNAMIC_HEADROOM')
    return dict(peakIncrement=peak, finalIncrement=blobs + expanded,
                tempIncrement=archive + largest_layer + RESERVE,
                projectedUsage=projected, projectedAvailable=minimum)

def safe_name(name):
    p = name.removeprefix('./')
    require(not p.startswith('/') and '..' not in p.split('/'), 'ARCHIVE_PATH_INVALID')
    return p

class HashReader:
    def __init__(self, source):
        self.source, self.h, self.total = source, hashlib.sha256(), 0
    def read(self, n=-1):
        b = self.source.read(n)
        self.total += len(b)
        require(self.total <= MAX_LAYER_STREAM, 'LAYER_STREAM_TOO_LARGE')
        self.h.update(b)
        return b

def artifact(path, release, repo):
    """Read-only off-host validation of one uncompressed docker-save archive.

Both plain and gzip layer blobs are supported; their expanded bytes/metadata
are measured, not inferred from docker image inspect's compressed Size field.
No archive member is extracted to the host filesystem.
"""
    p = Path(path)
    size = p.stat().st_size
    require(0 < size <= MAX_ARCHIVE, 'ARCHIVE_TOO_LARGE')
    with p.open('rb') as f:
        archive_hash = file_hash(f)
    with tarfile.open(p, mode='r:') as outer:
        members = outer.getmembers()
        require(len(members) <= MAX_MEMBERS, 'ARCHIVE_TOO_MANY_MEMBERS')
        by_name = {}
        for m in members:
            name = safe_name(m.name)
            require(name not in by_name and (m.isfile() or m.isdir()), 'ARCHIVE_MEMBER_INVALID')
            by_name[name] = m
        def read(name, limit):
            require(name in by_name and by_name[name].isfile() and by_name[name].size <= limit,
                    'ARCHIVE_METADATA_INVALID')
            return outer.extractfile(by_name[name]).read()
        manifest = json.loads(read('manifest.json', 65536))
        require(len(manifest) == 1, 'ARTIFACT_MUST_HAVE_ONE_IMAGE')
        item = manifest[0]
        tag = image_reference(release)
        # BuildKit normalizes names, while the Docker compatibility manifest may
        # use the familiar spelling. These name exactly the same repository/tag.
        exact_tags = [tag, 'docker.io/library/' + tag]
        require(item.get('RepoTags') in [[t] for t in exact_tags], 'ARTIFACT_TAG_INVALID')
        config_bytes = read(safe_name(item['Config']), 4 * 1024 ** 2)
        config = json.loads(config_bytes)
        require(config.get('os') == 'linux' and config.get('architecture') == 'amd64', 'ARTIFACT_PLATFORM_INVALID')
        require(config.get('config', {}).get('Labels', {}).get(REVISION) == release, 'ARTIFACT_REVISION_INVALID')
        layers = item['Layers']
        diffs = config.get('rootfs', {}).get('diff_ids', [])
        require(len(layers) == len(diffs) and 0 < len(layers) <= 64 and len(set(layers)) == len(layers), 'LAYER_LIST_INVALID')
        allowed_members = {'manifest.json', item['Config'], *layers}
        if 'repositories' in by_name:
            repositories = json.loads(read('repositories',65536))
            require(set(repositories) == {'budu-api'} and set(repositories['budu-api']) == {IMAGE_PREFIX+release[:12]}, 'LEGACY_TAGS_INVALID')
            allowed_members.add('repositories')
        if 'index.json' in by_name:
            index = json.loads(read('index.json',65536))
            require(len(index.get('manifests',[])) == 1, 'OCI_INDEX_MUST_HAVE_ONE_IMAGE')
            descriptor = index['manifests'][0]
            index_name = 'blobs/sha256/'+descriptor.get('digest','').removeprefix('sha256:')
            encoded_manifest = read(index_name,4*1024**2)
            require(descriptor['digest'] == 'sha256:'+digest(encoded_manifest), 'OCI_MANIFEST_HASH_INVALID')
            image_manifest = json.loads(encoded_manifest)
            require(image_manifest['config']['digest'] == 'sha256:'+digest(config_bytes), 'OCI_CONFIG_MISMATCH')
            require(['blobs/sha256/'+x['digest'].removeprefix('sha256:') for x in image_manifest['layers']] == layers, 'OCI_LAYER_LIST_MISMATCH')
            for key,value in descriptor.get('annotations',{}).items():
                if key in ('io.containerd.image.name','org.opencontainers.image.ref.name'):
                    require(value in exact_tags+[IMAGE_PREFIX+release[:12]], 'OCI_TAG_MISMATCH')
            require(json.loads(read('oci-layout',65536)).get('imageLayoutVersion') == '1.0.0', 'OCI_LAYOUT_INVALID')
            allowed_members.update({'index.json','oci-layout',index_name})
        require({n for n,m in by_name.items() if m.isfile()} <= allowed_members, 'UNREVIEWED_ARCHIVE_CONTENT')
        blobs = sum(m.size for m in members if m.isfile())
        expanded = largest = 0
        file_sizes = {}
        expected_payload = runtime_payload(repo)
        observed_payload = {}
        v2_bytes = None
        prisma_files = {}
        layer_metrics = []
        chain = None
        histories = [h.get('created_by','') for h in config.get('history',[]) if not h.get('empty_layer')]
        for index, (layer_name, expected) in enumerate(zip(layers, diffs)):
            m = by_name.get(safe_name(layer_name))
            require(m is not None and m.isfile(), 'LAYER_MISSING')
            if layer_name.startswith('blobs/sha256/'):
                require(file_hash(outer.extractfile(m)) == layer_name.split('/')[-1], 'COMPRESSED_BLOB_HASH_MISMATCH')
            raw = outer.extractfile(m)
            header = raw.read(2)
            raw.seek(0)
            decoded = gzip.GzipFile(fileobj=raw) if header == b'\x1f\x8b' else raw
            stream = HashReader(decoded)
            physical = count = 0
            categories = {}
            with tarfile.open(fileobj=stream, mode='r|') as layer:
                for member in layer:
                    name = safe_name(member.name)
                    count += 1
                    # A directory/symlink/inode allowance in addition to regular extents.
                    extent = member.size if member.isfile() else 0
                    if member.islnk():
                        target = safe_name(member.linkname)
                        require(target in file_sizes, 'UNRESOLVED_HARDLINK')
                        extent = file_sizes[target]
                    file_sizes[name] = extent
                    physical += 4096 + math.ceil(extent / 4096) * 4096
                    category = next((p for p in ('usr/lib/chromium','usr/share/fonts','app/node_modules',
                                                'usr/local','app/server','app/scripts','app/dist','app/prisma')
                                     if name == p or name.startswith(p+'/')), 'other')
                    categories[category] = categories.get(category, 0) + extent
                    require(count <= MAX_MEMBERS and physical <= 2 * GIB, 'LAYER_EXPANSION_TOO_LARGE')
                    require(not member.issparse(), 'SPARSE_LAYER_UNSUPPORTED')
                    if member.issym() and any(k.startswith(name+'/') for k in expected_payload):
                        raise GateError('RUNTIME_PARENT_SYMLINK_UNSUPPORTED')
                    basename = name.rsplit('/',1)[-1]
                    if basename.startswith('.wh.'):
                        parent = name.rsplit('/',1)[0]+'/' if '/' in name else ''
                        affected = parent if basename == '.wh..wh..opq' else parent+basename[4:]
                        require(not any(k == affected or k.startswith(affected if affected.endswith('/') else affected+'/') for k in expected_payload), 'RUNTIME_WHITEOUT_UNSUPPORTED')
                        if shipping_migration():
                            require(not any(k == affected or k.startswith(affected.rstrip('/')+'/') for k in
                                            ('app/node_modules/prisma/package.json', 'app/node_modules/prisma/build/index.js')),
                                    'SHIPPING_PRISMA_CLI_INVALID')
                    if shipping_migration() and name in ('app/node_modules/prisma/package.json', 'app/node_modules/prisma/build/index.js'):
                        require(member.isfile() and 0 < member.size < 4 * 1024 ** 2, 'SHIPPING_PRISMA_CLI_INVALID')
                        content = layer.extractfile(member).read()
                        prisma_files[name] = json.loads(content)['version'] if name.endswith('package.json') else digest(content)
                    if member.isfile() and name.startswith(('app/server/','app/shared/','app/src/utils/','app/prisma/','app/scripts/','app/brand/web/')):
                        require(name in expected_payload, 'UNEXPECTED_RUNTIME_FILE')
                    if name in expected_payload:
                        require(member.isfile(), 'RUNTIME_SOURCE_MUST_BE_REGULAR_FILE')
                        observed_payload[name] = file_hash(layer.extractfile(member))
                    if name in ('app/server/v2.js', 'app/server/.wh.v2.js', 'app/server/.wh..wh..opq', 'app/.wh.server'):
                        require(name == 'app/server/v2.js' and member.isfile() and member.size < 4 * 1024 ** 2,
                                'RUNTIME_LAYER_INVALID')
                        v2_bytes = observed_payload.get(name)
            # Include trailing tar padding in the canonical diff_id hash.
            while stream.read(1024 * 1024):
                pass
            require('sha256:' + stream.h.hexdigest() == expected, 'LAYER_DIFF_ID_MISMATCH')
            expanded += physical
            largest = max(largest, physical)
            chain = expected if chain is None else 'sha256:'+digest((chain+' '+expected).encode())
            history = histories[index] if len(histories) == len(layers) else ''
            history_kind = ('chromium_and_fonts_install' if 'apt-get install' in history and 'chromium' in history
                            else 'node_modules_install' if 'npm ci' in history
                            else 'prisma_client_generate' if 'prisma generate' in history
                            else 'server_ownership_copyup' if 'chown -R' in history
                            else 'application_copy' if history.startswith('COPY ')
                            else 'base_or_other')
            layer_metrics.append({'index':index,'blobBytes':m.size,'expandedPhysicalBytes':physical,
                                  'diffId':expected,'contentDigest':'sha256:'+file_hash(outer.extractfile(m)),
                                  'chainId':chain,'expandedTarBytes':stream.total,'entryCount':count,
                                  'historyCategory':history_kind,'logicalBytesByDirectory':categories})
        require(v2_bytes is not None and v2_bytes == digest((Path(repo) / 'server/v2.js').read_bytes()),
                'ARTIFACT_BUSINESS_CODE_MISMATCH')
        require(observed_payload == expected_payload, 'ARTIFACT_RUNTIME_PAYLOAD_MISMATCH')
        if shipping_migration():
            pinned = json.loads((Path(repo)/'package-lock.json').read_text())['packages']['node_modules/prisma']['version']
            require(pinned == '6.19.3' and prisma_files.get('app/node_modules/prisma/package.json') == pinned
                    and bool(prisma_files.get('app/node_modules/prisma/build/index.js')), 'SHIPPING_PRISMA_CLI_INVALID')
        return dict(archive=size, blobs=blobs, expanded=expanded, largest=largest,
                    archiveHash=archive_hash, archiveConfigDigest='sha256:' + digest(config_bytes),
                    imageReference=tag, rootfsDiffIds=diffs,
                    config=config['config'], release=release, runtimeHash=v2_bytes, layers=layer_metrics)

class Remote:
    def __init__(self, key):
        self.ssh = ['ssh', '-i', str(key), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                    '-o', 'ConnectTimeout=12']
        if os.environ.get('TRANSFER_CAS_KNOWN_HOSTS'):
            self.ssh += ['-o', 'UserKnownHostsFile='+os.environ['TRANSFER_CAS_KNOWN_HOSTS'], '-o', 'HostKeyAlgorithms=ssh-ed25519']
        self.ssh += [HOST]
    def run(self, args, data=None, timeout=60):
        return command(self.ssh + [shlex.join(args)], data, timeout)
    def py(self, code, value=None, timeout=60):
        return self.run(['sudo', '-n', 'python3', '-c', code],
                        json.dumps(value).encode() if value is not None else None, timeout)
    def inspect(self, name, image=False):
        objects = json.loads(self.run(['docker', 'image' if image else 'container', 'inspect', name]))
        require(isinstance(objects, list) and len(objects) == 1, 'DOCKER_IDENTITY_NOT_UNIQUE')
        return objects[0]
    def containers(self):
        ids = self.run(['docker', 'ps', '-q']).decode().split()
        return json.loads(self.run(['docker', 'container', 'inspect', *ids])) if ids else []
    def routes(self):
        return (self.run(['cat', TEMPLATE]).decode(),
                self.run(['docker', 'exec', NGINX, 'cat', ACTIVE]).decode())
    def disk(self):
        fields = self.run(['df', '-Pk', '/']).decode().splitlines()[1].split()
        return int(fields[2]) * 1024, int(fields[3]) * 1024
    def db(self):
        # Credentials remain in the PG container environment; only its local role
        # name is used. This command creates no files and every SQL txn is readonly.
        code = r'''import subprocess,json
m=json.loads(subprocess.check_output(['docker','inspect',%r]))[0]
e=dict(x.split('=',1) for x in m['Config']['Env'] if '=' in x)
sql="""BEGIN READ ONLY;
SELECT json_build_object('database',current_database(),'applied',(SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),'failed',(SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL),'rolledBack',(SELECT count(*) FROM _prisma_migrations WHERE rolled_back_at IS NOT NULL),'check',(SELECT json_build_object('validated',convalidated,'definition',pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid='\"TransferItem\"'::regclass AND conname='TransferItem_shippedQuantity_valid'),'invalidFacts',(SELECT count(*) FROM \"TransferItem\" WHERE \"shippedQuantity\"<0 OR \"shippedQuantity\">999999),'dbBytes',pg_database_size(current_database()),'pgVersion',current_setting('server_version'),'ledger',(SELECT json_object_agg(migration_name,checksum) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),'clients',(SELECT coalesce(json_agg(distinct coalesce(host(client_addr),'LOCAL_SOCKET')),'[]') FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()));
COMMIT;"""
r=subprocess.run(['docker','exec','-i','-e','PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=8000 -c temp_file_limit=0',%r,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',e.get('POSTGRES_USER','postgres'),'-d',%r],input=sql.encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE)
if r.returncode: raise SystemExit(1)
print(r.stdout.decode().strip())
''' % (PG, PG, EXPECTED_DB)
        return json.loads(self.py(code))
    def health(self, name, sha, public=False):
        args = ['curl', '--fail', '--silent', '--max-time', '10', 'https://buducandy.cn/api/health'] if public else ['docker', 'exec', name, 'wget', '-qO-', 'http://127.0.0.1:3000/api/health']
        for _ in range(20):
            try:
                h = json.loads(self.run(args, timeout=15))
                if h.get('ok') is True and h.get('dbOk') is True and h.get('gitSha') in (sha, sha[:12]):
                    return
            except (GateError, ValueError):
                pass
            time.sleep(2)
        raise GateError('HEALTH_FAILED')


def env(c):
    return dict(x.split('=', 1) for x in c['Config']['Env'])

def writer_names(containers):
    names = []
    for c in containers:
        url = env(c).get('DATABASE_URL', '')
        if url and unquote(urlsplit(url).path).strip('/') == EXPECTED_DB:
            # Conservative: count all same-name DB connections, regardless of URL
            # spelling/query parameters/read-only flags. Unknown aliases fail closed.
            names.append(c['Name'].lstrip('/'))
    return names

def writer_check(containers, database, expected_names):
    names = writer_names(containers)
    require(sorted(names) == sorted(expected_names), 'WRITER_COUNT_INVALID')
    ips = {v['IPAddress'] for c in containers if c['Name'].lstrip('/') in expected_names
           for v in c['NetworkSettings']['Networks'].values() if v.get('IPAddress')}
    require(set(database['clients']) <= ips, 'UNKNOWN_DB_CLIENT_OR_OLD_WRITER')

def validate_database(db, ledger):
    require(db['database'] == EXPECTED_DB, 'DATABASE_AUTHORITY_MISMATCH')
    count = 86 if shipping_migration() and ledger.get(SHIPPING_MIGRATION) == SHIPPING_SQL_HASH else EXPECTED_MIGRATIONS
    require(len(ledger) == count and db['applied'] == count and db['failed'] == 0, 'MIGRATION_LEDGER_INVALID')
    require(db['ledger'] == ledger, 'MIGRATION_CHECKSUM_MISMATCH')
    if shipping_migration():
        expected = SHIPPING_CHECK_NEW if count == 86 else SHIPPING_CHECK_OLD
        require(db.get('check') == {'validated': True, 'definition': expected}
                and db.get('invalidFacts') == 0 and db.get('rolledBack') == 0,
                'SHIPPING_DATABASE_PHASE_INVALID')

def route_target(template, active):
    require(template == active, 'NGINX_AUTHORITY_CONFLICT')
    targets = re.findall(r'proxy_pass http://([A-Za-z0-9_.-]+):3000;', template)
    require(len(targets) == 3 and len(set(targets)) == 1, 'PRODUCTION_ROUTE_COUNT_INVALID')
    return targets[0]

def normalize_dns(value):
    # Docker reports an unset per-container DNS list as either null or [].
    return [] if value is None or value == [] else value


SHIPPING_CLI_PROBE = (
    "const fs=require('fs'); const p='/app/node_modules/prisma/'; "
    "const lock=JSON.parse(fs.readFileSync('/app/package-lock.json')); "
    "const version=JSON.parse(fs.readFileSync(p+'package.json')).version; "
    "if(version!=='6.19.3'||version!==lock.packages['node_modules/prisma'].version||"
    "!fs.lstatSync(p+'build/index.js').isFile()) process.exit(1); "
    "process.stdout.write('PINNED_PRISMA_CLI_OK\\n');"
)


def shipping_resources(db):
    require(db.get('pgVersion', '').split()[0] == '16.14' and
            isinstance(db.get('dbBytes'), int) and db['dbBytes'] > 0, 'SHIPPING_PG16_REQUIRED')
    size = db['dbBytes']
    # Independent limits for the custom dump, isolated restore (including its
    # WAL), live WAL growth and the one migrator. No reuse/disk discount.
    return {'backupLimit': 2*size + 64*1024**2, 'restoreLimit': 3*size + 256*1024**2,
            'walLimit': size + 64*1024**2, 'migratorLimit': 128*1024**2}


def shipping_disk_gate(remote, resources, art=None):
    used, available = remote.disk()
    extra = sum(resources.values())
    if art is not None:
        budget = disk_budget(used, available, art['archive'], art['blobs'], art['expanded'], art['largest'])
        extra += budget['peakIncrement']
        require(extra <= ABSOLUTE_MAX_PEAK, 'SHIPPING_MIGRATION_DISK_GATE_FAILED')
    else:
        extra += RESERVE
    require(math.ceil(100*(used+extra)/(used+available)) <= MAX_PROJECTED_USAGE
            and available-extra >= MIN_PROJECTED_AVAILABLE, 'SHIPPING_MIGRATION_DISK_GATE_FAILED')
    return {'migrationResourceLimits': resources, 'projectedAvailableWithMigration': available-extra,
            'projectedUsageWithMigration': math.ceil(100*(used+extra)/(used+available))}


# The backup is retained. The restore is an exact owned, network-none PG16.14
# container and never a production restore. Neither raw rows nor credentials
# cross the controller boundary. Failure here is still the known L85 phase.
SHIPPING_BOUNDED_DUMP_CODE = r'''
import os,select,signal,subprocess,time,hashlib
def stop_backup_process(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill();process.wait(timeout=5)
    if process.poll() is None:raise RuntimeError('BACKUP_CHILD_TERMINATION_UNVERIFIED')

def bounded_backup_dump(args,path,limit,deadline):
    # A readiness wait precedes os.read, including when the child emits NOTHING.
    # Cleanup is bounded and protects only terminate/wait, never the dump itself.
    total=0;h=hashlib.sha256();process=None
    with path.open('xb') as out:
        try:
            process=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
            while True:
                remaining=deadline-time.monotonic()
                if remaining<=0:raise TimeoutError('BACKUP_TOTAL_DEADLINE')
                ready,_,_=select.select([process.stdout],[],[],min(1,remaining))
                if not ready:continue
                block=os.read(process.stdout.fileno(),65536)
                if not block:break
                total+=len(block)
                if total>limit:raise RuntimeError('BACKUP_LIMIT')
                h.update(block);out.write(block)
            remaining=deadline-time.monotonic()
            if remaining<=0:raise TimeoutError('BACKUP_TOTAL_DEADLINE')
            if process.wait(timeout=min(5,remaining)):raise RuntimeError('BACKUP_FAILED')
            out.flush();os.fsync(out.fileno())
        finally:
            if process is not None:
                previous=signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGHUP,signal.SIGTERM,signal.SIGINT})
                try:
                    stop_backup_process(process)
                    process.stdout.close()
                finally:signal.pthread_sigmask(signal.SIG_SETMASK,previous)
    return total,h.hexdigest()
'''
exec(SHIPPING_BOUNDED_DUMP_CODE, globals())

SHIPPING_BACKUP_RESTORE_CODE = SHIPPING_BOUNDED_DUMP_CODE + r'''
import json,pathlib,sys
v=json.load(sys.stdin);root=pathlib.Path(v['root']);os.umask(0o077)
deadline=time.monotonic()+600
marker='budu_shipping_backup_'+v['release'][:12]
def run(args,data=None,timeout=30,cleanup=False,critical=False):
    remaining=timeout if cleanup else min(timeout,deadline-time.monotonic())
    if remaining<=0:raise TimeoutError('BACKUP_TOTAL_DEADLINE')
    previous=None
    if critical:previous=signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGHUP,signal.SIGTERM,signal.SIGINT})
    try:
        p=subprocess.run(args,input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=remaining)
        if p.returncode:raise RuntimeError('BACKUP_RESTORE_COMMAND_FAILED')
        return p.stdout
    finally:
        if previous is not None:signal.pthread_sigmask(signal.SIG_SETMASK,previous)
pg=json.loads(run(['docker','inspect',v['pg']]))[0]
e=dict(x.split('=',1) for x in pg['Config']['Env'] if '=' in x);user=e.get('POSTGRES_USER','postgres')
options='PGOPTIONS=-c application_name='+marker+' -c statement_timeout=8000 -c lock_timeout=8000 -c idle_in_transaction_session_timeout=8000 -c TimeZone=UTC'
def sql(container,database,text,role=user,cleanup=False):
    return run(['docker','exec','-i','-e',options,container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',role,'-d',database],text.encode(),cleanup=cleanup)
def fingerprints(container,database,role=user):
    tables=sorted(json.loads(sql(container,database,"BEGIN READ ONLY; SELECT coalesce(json_agg(tablename),'[]') FROM pg_tables WHERE schemaname='public'; COMMIT;",role)))
    result=[]
    for table in tables:
        quoted='"'+table.replace('"','""')+'"'
        text="BEGIN READ ONLY; SELECT count(*)::text||':'||md5(coalesce(string_agg(h,'' ORDER BY h COLLATE \"C\"),'')) FROM (SELECT md5(row_to_json(t)::text) h FROM "+quoted+" t) s; COMMIT;"
        result.append([table,sql(container,database,text,role).decode().strip()])
    seq=sql(container,database,"BEGIN READ ONLY; SELECT coalesce(json_agg(row_to_json(s) ORDER BY sequencename COLLATE \"C\"),'[]') FROM (SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public') s; COMMIT;",role).decode().strip()
    return hashlib.sha256(json.dumps([result,seq],sort_keys=True).encode()).hexdigest(),len(tables)
name=v['restore'];data=root/'restore-pg';created=False;restore_process=None;cleanup_complete=False
try:
    before,tables=fingerprints(v['pg'],v['database'])
    dump=root/'database-L85.dump'
    total,backup_hash=bounded_backup_dump(['docker','exec','-e',options,v['pg'],'pg_dump','-U',user,'-d',v['database'],'-Fc','--no-owner','--no-acl','--lock-wait-timeout=8s'],dump,v['limits']['backupLimit'],deadline)
    data.mkdir(mode=0o700)
    def allocated():return sum(p.stat().st_blocks*512 for p in data.rglob('*') if p.is_file())
    # Only Docker create/start transitions defer signals, each with a real 30s bound.
    if run(['docker','ps','-aq','--filter','name=^/'+name+'$']).strip():raise RuntimeError('RESTORE_NAME_EXISTS')
    created=True
    run(['docker','create','--name',name,'--network','none','--restart','no',
         '--label','budu.shipping-restore='+v['release'],
         '-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=restore_fixture',
         '-v',str(data)+':/var/lib/postgresql/data',pg['Image']],critical=True)
    run(['docker','start',name],critical=True)
    for _ in range(60):
        try:
            version=run(['docker','exec','-e',options,name,'psql','-h','127.0.0.1','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','restore_fixture','-c',"SELECT current_setting('server_version');"],timeout=5).decode().split()
        except (RuntimeError,subprocess.TimeoutExpired):
            time.sleep(0.2);continue
        if not version or version[0]!='16.14':raise RuntimeError('RESTORE_VERSION')
        break
    else:raise RuntimeError('RESTORE_NOT_READY')
    with dump.open('rb') as source:
        restore_process=subprocess.Popen(['docker','exec','-i',name,'pg_restore','-U','postgres','-d','restore_fixture','--exit-on-error','--no-owner','--no-acl'],stdin=source,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            while restore_process.poll() is None:
                if allocated()>v['limits']['restoreLimit']:raise RuntimeError('RESTORE_LIMIT')
                if time.monotonic()>deadline:raise TimeoutError('BACKUP_TOTAL_DEADLINE')
                time.sleep(0.2)
            if restore_process.returncode:raise RuntimeError('RESTORE_FAILED')
        finally:
            previous=signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGHUP,signal.SIGTERM,signal.SIGINT})
            try:stop_backup_process(restore_process)
            finally:signal.pthread_sigmask(signal.SIG_SETMASK,previous)
    after,after_tables=fingerprints(name,'restore_fixture','postgres')
    if before!=after or tables!=after_tables:raise RuntimeError('RESTORE_FACTS_MISMATCH')
finally:
    # End only this backup's local PG connections, then prove termination. A
    # failure leaves rollback's zero-client gate closed; no other client is killed.
    previous=signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGHUP,signal.SIGTERM,signal.SIGINT})
    try:
        quoted_user=user.replace("'","''");quoted_db=v['database'].replace("'","''")
        predicate="datname='"+quoted_db+"' AND usename='"+quoted_user+"' AND application_name='"+marker+"' AND pid<>pg_backend_pid()"
        sql(v['pg'],v['database'],'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE '+predicate+';',cleanup=True)
        remaining=sql(v['pg'],v['database'],'SELECT count(*) FROM pg_stat_activity WHERE '+predicate+';',cleanup=True)
        if remaining.strip()!=b'0':raise RuntimeError('BACKUP_CONNECTION_TERMINATION_UNVERIFIED')
        if created:
            restored=json.loads(run(['docker','inspect',name],cleanup=True))[0]
            if (restored['Image']!=pg['Image'] or restored['Config'].get('Labels',{}).get('budu.shipping-restore')!=v['release']
                or not any(m.get('Source')==str(data) and m.get('Destination')=='/var/lib/postgresql/data' for m in restored['Mounts'])):
                raise RuntimeError('RESTORE_IDENTITY_UNVERIFIED')
            run(['docker','stop','--time','10',name],timeout=20,cleanup=True)
            if json.loads(run(['docker','inspect',name],cleanup=True))[0]['State']['Running']:raise RuntimeError('RESTORE_STOP_UNVERIFIED')
        cleanup_complete=True
    finally:signal.pthread_sigmask(signal.SIG_SETMASK,previous)
extent=allocated()
if extent>v['limits']['restoreLimit']:raise RuntimeError('RESTORE_LIMIT')
proof={'backupBytes':total,'backupSha256':backup_hash,'restoreAllocatedBytes':extent,
       'tableCount':tables,'factsFingerprint':before,'restoreVerified':True,'pgVersion':'16.14',
       'restoreContainer':name,'releaseSha':v['release'],'terminationVerified':True}
(root/'backup-restore-proof.json').write_text(json.dumps(proof,sort_keys=True))
print(json.dumps(proof))
'''


def shipping_backup_restore(remote, state, root, art):
    limits = state['migrationResources']
    state['backup_attempted'] = True
    state['backup_termination_verified'] = False
    try:
        result = json.loads(remote.py(SHIPPING_BACKUP_RESTORE_CODE,
            {'root':root, 'pg':PG, 'database':EXPECTED_DB, 'limits':limits,
             'release':art['release'], 'restore':'budu-shipping-restore-'+art['release'][:12]}, timeout=600))
    except BaseException as error:
        state['backup_termination_verified'] = getattr(error, 'backup_termination_verified', False)
        raise
    state['backup_termination_verified'] = result.get('terminationVerified') is True
    require(result.get('restoreVerified') is True and result.get('pgVersion') == '16.14'
            and state['backup_termination_verified']
            and result.get('releaseSha') == art['release'] and result.get('tableCount', 0) > 0
            and 0 < result.get('backupBytes', 0) <= limits['backupLimit']
            and 0 < result.get('restoreAllocatedBytes', 0) <= limits['restoreLimit'],
            'SHIPPING_BACKUP_RESTORE_UNVERIFIED')
    # The dump and stopped restore are now charged to actual used space. Only
    # future live WAL and migrator allocations remain in the projection.
    shipping_disk_gate(remote, {k:limits[k] for k in ('walLimit','migratorLimit')})
    return result


SHIPPING_MIGRATOR_CREATE_CODE = r'''
import json,os,pathlib,subprocess,sys,tempfile
v=json.load(sys.stdin)
old=json.loads(subprocess.check_output(['docker','inspect',v['old']]))[0]
e=dict(x.split('=',1) for x in old['Config']['Env'] if '=' in x)
fd,p=tempfile.mkstemp(dir='/dev/shm');os.fchmod(fd,0o600)
try:
    os.write(fd,('DATABASE_URL='+e['DATABASE_URL']+'\nPGOPTIONS=-c application_name=budu_shipping_migrator\n').encode());os.close(fd)
    r=subprocess.run(['docker','create','--name',v['name'],'--restart','no',
        '--network',old['HostConfig']['NetworkMode'],'--read-only','--tmpfs','/tmp:rw,nosuid,size=128m',
        '--log-opt','max-size=1m','--log-opt','max-file=1',
        '--label','budu.production-role=migrator','--label','org.opencontainers.image.revision='+v['release'],
        '--env-file',p,'--workdir','/app','--entrypoint','node',v['image'],
        '/app/node_modules/prisma/build/index.js','migrate','deploy','--schema','/app/prisma/schema.prisma'],
        stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if r.returncode:raise SystemExit(1)
finally:
    pathlib.Path(p).unlink()
'''


def shipping_migrate(remote, state, art, ledger):
    name = 'budu-shipping-migrator-'+art['release'][:12]
    state['migrator'] = name
    require(not remote.run(['docker','ps','-aq','--filter','name=^/'+name+'$']).strip(), 'SHIPPING_MIGRATOR_IDENTITY_INVALID')
    remote.py(SHIPPING_MIGRATOR_CREATE_CODE, {'old':state['name'],'name':name,
        'release':art['release'],'image':art['imageReference']})
    container = remote.inspect(name)
    require(not container['State']['Running'] and container['Image'] == art['loadedDockerImageId']
            and container['Config'].get('Image') == art['imageReference']
            and container['Config'].get('Labels') == {'budu.production-role':'migrator',REVISION:art['release']}
            and env(container) == {**dict(x.split('=',1) for x in art['config'].get('Env', []) if '=' in x),
                'DATABASE_URL':env(state['old'])['DATABASE_URL'],
                'PGOPTIONS':'-c application_name=budu_shipping_migrator'}
            and container['Config']['Entrypoint'] == ['node']
            and container['Config']['Cmd'] == ['/app/node_modules/prisma/build/index.js','migrate','deploy','--schema','/app/prisma/schema.prisma']
            and container['HostConfig']['ReadonlyRootfs'] is True
            and container['HostConfig']['RestartPolicy'] == {'Name':'no','MaximumRetryCount':0}
            and container['HostConfig']['NetworkMode'] == state['old']['HostConfig']['NetworkMode']
            and container['HostConfig'].get('Tmpfs') == {'/tmp':'rw,nosuid,size=128m'}
            and container['HostConfig'].get('LogConfig') == {'Type':'json-file','Config':{'max-size':'1m','max-file':'1'}}
            and not container['HostConfig'].get('PortBindings')
            and all(m['Type'] == 'tmpfs' and m['Destination'] == '/tmp' for m in container['Mounts']),
            'SHIPPING_MIGRATOR_IDENTITY_INVALID')
    settle_writers(remote, before_ledger(ledger), [])
    # From this point through verified L86+new CHECK+zero writers, the state is
    # deliberately UNKNOWN. A signal, SQL/ledger gap or any failure retains lock
    # and never starts the old application or restores production data.
    state['migration_phase'] = 'UNKNOWN'
    remote.run(['docker','start',name])
    deadline = time.monotonic()+180
    while True:
        current = remote.inspect(name)
        db = remote.db()
        containers = remote.containers()
        if current['State']['Running']:
            ips = {v['IPAddress'] for v in current['NetworkSettings']['Networks'].values() if v.get('IPAddress')}
            require(set(db['clients']) <= ips, 'UNKNOWN_DB_CLIENT_OR_OLD_WRITER')
            names = writer_names(containers)
            require(names in ([name], []), 'WRITER_COUNT_INVALID')
            if names == [name]:
                writer_check(containers, db, [name])
                require(time.monotonic() < deadline, 'SHIPPING_MIGRATOR_UNVERIFIED')
                time.sleep(0.2)
                continue
            # The short DDL may finish between inspect and the DB/container
            # snapshots. Only this same successful, stopped migrator may settle
            # to exact L86 and zero; unknown clients were already rejected.
            current = remote.inspect(name)
        require(not current['State']['Running'], 'SHIPPING_MIGRATOR_UNVERIFIED')
        require(current['State'].get('ExitCode') == 0, 'SHIPPING_MIGRATOR_UNVERIFIED')
        settle_writers(remote, ledger, [])
        break
    state['migration_phase'] = 'L86'
    shipping_disk_gate(remote, {'walLimit':state['migrationResources']['walLimit'],
                                'migratorLimit':state['migrationResources']['migratorLimit']})

def validate_clone_source(old, image):
    c, h = old['Config'], old['HostConfig']
    for k in IDENTITY_KEYS:
        require(c.get(k) == image.get(k), 'IMAGE_RUNTIME_CONFIG_MISMATCH')
    require(set(c.get('Labels') or {}) == {REVISION, 'budu.production-role'}
            and c['Labels']['budu.production-role'] == 'candidate', 'SOURCE_LABELS_UNSUPPORTED')
    require(h.get('RestartPolicy') == {'Name': 'unless-stopped', 'MaximumRetryCount': 0}, 'RESTART_POLICY_UNSUPPORTED')
    require(not h.get('PortBindings') and not h.get('PublishAllPorts'), 'PORT_BINDINGS_UNSUPPORTED')
    require(not any(h.get(k) for k in ['Privileged','ReadonlyRootfs','CapAdd','CapDrop','SecurityOpt','Init']), 'SECURITY_CONFIG_UNSUPPORTED')
    require(h.get('LogConfig') == {'Type':'json-file','Config':{}}, 'LOG_CONFIG_UNSUPPORTED')
    require(not c.get('StopSignal'), 'STOP_SIGNAL_UNSUPPORTED')
    require(h.get('NetworkMode') in old['NetworkSettings']['Networks'], 'NETWORK_MODE_UNSUPPORTED')
    require(all(not v.get('Aliases') for v in old['NetworkSettings']['Networks'].values()), 'NETWORK_ALIASES_UNSUPPORTED')
    require(all(h.get(k) == v for k,v in HOST_DEFAULTS.items() if k != 'Dns')
            and normalize_dns(h.get('Dns')) == normalize_dns(HOST_DEFAULTS['Dns']),
            'SOURCE_RESOURCE_PROFILE_CHANGED')
    e = env(old)
    require(e.get('CUSTOMER_REQUEST_WECOM_RECIPIENT_USERNAME') == 'budu'
            and e.get('CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID') == 'dh', 'EXISTING_BINDING_MISMATCH')

def preflight(remote, art, ledger, imported=False):
    template, active = remote.routes()
    name = route_target(template, active)
    old = remote.inspect(name)
    require(old['Config']['Labels'].get(REVISION) == EXPECTED_OLD_SHA
            and env(old).get('GIT_SHA') == EXPECTED_OLD_SHA, 'PRODUCTION_SHA_MISMATCH')
    require(old['State']['Running'] and old['State'].get('Health', {}).get('Status') == 'healthy', 'PRODUCTION_NOT_HEALTHY')
    require(remote.run(['cat',CURRENT_SHA_FILE]).decode().strip() == EXPECTED_OLD_SHA, 'CURRENT_SHA_POINTER_MISMATCH')
    require(remote.run(['docker','exec',name,'sha256sum','/app/server/v2.js']).decode().split()[0] == OLD_V2_HASH, 'OLD_RUNTIME_SOURCE_MISMATCH')
    remote.health(name, EXPECTED_OLD_SHA)
    remote.health(name, EXPECTED_OLD_SHA, public=True)
    db = remote.db()
    validate_database(db, before_ledger(ledger))
    writer_check(remote.containers(), db, [name])
    validate_clone_source(old, art['config'])
    info = json.loads(remote.run(['docker','info','--format','{{json .}}']))
    require(info['ServerVersion'] == '29.1.3' and info['Driver'] == 'overlayfs'
            and info['DockerRootDir'] == '/var/lib/docker'
            and ['driver-type','io.containerd.snapshotter.v1'] in info['DriverStatus'], 'DOCKER_STORAGE_MODEL_CHANGED')
    same_fs = json.loads(remote.py("import os,json; print(json.dumps(all(os.stat(p).st_dev==os.stat('/').st_dev for p in ['/var/lib/docker','/var/lib/containerd'] if os.path.exists(p))))"))
    require(same_fs is True, 'DOCKER_FILESYSTEM_MODEL_CHANGED')
    used, available = remote.disk()
    df_h = remote.run(['df','-h','/']).decode()
    docker_df = remote.run(['docker','system','df']).decode()
    budget = disk_budget(used, available, art['archive'], art['blobs'], art['expanded'], art['largest']) if not imported else {'projectedUsage':math.ceil(100*(used+RESERVE)/(used+available)), 'projectedAvailable':available-RESERVE}
    require(budget['projectedUsage'] <= MAX_PROJECTED_USAGE and budget['projectedAvailable'] >= MIN_PROJECTED_AVAILABLE,
            'ARTIFACT_DISK_GATE_FAIL:POST_IMPORT_HEADROOM')
    resources = None
    if shipping_migration():
        resources = shipping_resources(db)
        budget.update(shipping_disk_gate(remote, resources, None if imported else art))
        if imported:
            require(remote.run(['docker','run','--rm','--network','none','--entrypoint','node',
                                art['imageReference'],'-e',SHIPPING_CLI_PROBE]) == b'PINNED_PRISMA_CLI_OK\n',
                    'SHIPPING_PRISMA_CLI_INVALID')
    remote.inspect(old['Image'], image=True)  # rollback image exists
    return dict(old=old, name=name, template=template, active=active, budget=budget,
                diskUsed=used, diskAvailable=available, dfHuman=df_h, dockerSystemDf=docker_df,
                migrationResources=resources, migration_phase='L85' if shipping_migration() else None)


def mount_identity(mount):
    # Hash BOTH the volume name and actual source; never persist secret paths.
    return digest(json.dumps([mount['Type'],mount.get('Name'),mount['Source'],
                              mount['Destination'],mount['RW']], separators=(',', ':')).encode())


def mount_readability(remote, name):
    current = remote.inspect(name)
    require(current['State']['Running'], 'RUNTIME_MOUNT_PROBE_FAILED')
    snapshot = []
    for mount in sorted(current['Mounts'], key=lambda m: m['Destination']):
        # test exits 1 for unreadable. The shell returns a fixed token and exits
        # zero, so a failed docker exec/transport cannot masquerade as unreadable.
        try:
            result = remote.run(['docker','exec',name,'sh','-c',
                                 'if test -r "$1"; then printf READABLE; else printf UNREADABLE; fi',
                                 'mount-readability',mount['Destination']], timeout=15)
        except GateError:
            raise GateError('RUNTIME_MOUNT_PROBE_FAILED') from None
        require(result in (b'READABLE', b'UNREADABLE'), 'RUNTIME_MOUNT_PROBE_FAILED')
        snapshot.append({'identityHash':mount_identity(mount),
                         'destinationHash':digest(mount['Destination'].encode()),
                         'RW':mount['RW'],'readable':result == b'READABLE'})
    after = remote.inspect(name)
    require(after['State']['Running'] and after['Id'] == current['Id']
            and after['State'].get('StartedAt') == current['State'].get('StartedAt')
            and sorted(after['Mounts'], key=lambda m: m['Destination'])
            == sorted(current['Mounts'], key=lambda m: m['Destination']), 'RUNTIME_MOUNT_PROBE_FAILED')
    return snapshot


def mount_readability_parity(authority, candidate):
    require([{k:v for k,v in row.items() if k != 'readable'} for row in authority]
            == [{k:v for k,v in row.items() if k != 'readable'} for row in candidate],
            'RUNTIME_MOUNT_IDENTITY_PARITY_FAILED')
    require(all(type(row.get('readable')) is bool for row in authority + candidate)
            and [row['readable'] for row in authority] == [row['readable'] for row in candidate],
            'RUNTIME_MOUNT_READABILITY_PARITY_FAILED')


def runtime_checks(remote, name, runtime_hash, authority_mounts):
    current = remote.inspect(name)
    require(current['State']['Running'] and current.get('RestartCount', 0) == 0, 'RUNTIME_CRASH_DETECTED')
    require(remote.run(['docker','exec',name,'sha256sum','/app/server/v2.js']).decode().split()[0] == runtime_hash,
            'LIVE_TRANSFER_CODE_MISMATCH')
    mount_readability_parity(authority_mounts, mount_readability(remote, name))
    # Never publish raw logs: they can contain sensitive values. Only a fixed
    # failure code leaves this process. The tail is bounded even on failure.
    logs = remote.run(['sh','-c','docker logs --tail 100 '+shlex.quote(name)+' 2>&1']).decode(errors='replace')
    require(not re.search(r'(?i)\b(fatal|panic|uncaughtexception|unhandledrejection|PrismaClientInitializationError|ECONNREFUSED)\b', logs),
            'CRITICAL_STARTUP_LOG')


def clone_parity(old, new, release):
    desired = env(old)
    desired['GIT_SHA'] = release
    require(env(new) == desired, 'CLONE_ENV_MISMATCH')
    for k in IDENTITY_KEYS:
        require(old['Config'].get(k) == new['Config'].get(k), 'CLONE_CONFIG_MISMATCH')
    labels = dict(old['Config']['Labels']); labels[REVISION] = release
    require(new['Config']['Labels'] == labels, 'CLONE_LABELS_MISMATCH')
    for k in ['RestartPolicy','PortBindings','PublishAllPorts','ReadonlyRootfs','CapAdd','CapDrop','Privileged','SecurityOpt','LogConfig','GroupAdd','Init','NetworkMode']:
        require(old['HostConfig'].get(k) == new['HostConfig'].get(k), 'CLONE_HOST_CONFIG_MISMATCH')
    require(all(old['HostConfig'].get(k) == new['HostConfig'].get(k) for k in HOST_DEFAULTS if k != 'Dns')
            and normalize_dns(old['HostConfig'].get('Dns')) == normalize_dns(new['HostConfig'].get('Dns')),
            'CLONE_RESOURCE_PROFILE_MISMATCH')
    def mounts(c):
        return sorted((m['Type'],m.get('Name') or m['Source'],m['Destination'],m['RW']) for m in c['Mounts'])
    require(mounts(old) == mounts(new), 'CLONE_MOUNTS_MISMATCH')
    require(set(old['NetworkSettings']['Networks']) == set(new['NetworkSettings']['Networks']), 'CLONE_NETWORKS_MISMATCH')


def write_authority(remote, path, text):
    require(path in (TEMPLATE,CURRENT_SHA_FILE), 'AUTHORITY_PATH_INVALID')
    remote.py("import os,json,pathlib,stat,sys,tempfile; v=json.load(sys.stdin); p=pathlib.Path(v['path']); s=p.stat(); fd,q=tempfile.mkstemp(prefix=p.name+'.transfer-cas-',dir=p.parent)\ntry:\n os.fchmod(fd,stat.S_IMODE(s.st_mode)); os.fchown(fd,s.st_uid,s.st_gid)\n with os.fdopen(fd,'w') as f: f.write(v['text']); f.flush(); os.fsync(f.fileno())\n os.replace(q,p)\nfinally:\n if os.path.exists(q): os.unlink(q)", {'path':path,'text':text})


def replace_routes(remote, template, active):
    # Same-directory atomic rename for each authority file; rollback restores both
    # on any failure before or after reload. No claim of a two-file atomic commit.
    write_authority(remote,TEMPLATE,template)
    remote.run(['docker','exec','-i',NGINX,'sh','-c',
                'set -eu; umask 077; p=/etc/nginx/conf.d/budu.conf; q=$(mktemp "$p.transfer-cas.XXXXXX"); trap \'rm -f "$q"\' EXIT; cat > "$q"; chmod "$(stat -c %a "$p")" "$q"; chown "$(stat -c %u "$p"):$(stat -c %g "$p")" "$q"; mv -f "$q" "$p"'], active.encode())
    require(remote.routes() == (template, active), 'ROUTE_WRITE_MISMATCH')
    remote.run(['docker','exec',NGINX,'nginx','-t'])
    remote.run(['docker','exec',NGINX,'nginx','-s','reload'])


def settle_writers(remote, ledger, names):
    for _ in range(20):
        db = remote.db()
        validate_database(db, ledger)
        try:
            writer_check(remote.containers(), db, names)
            return
        except GateError:
            time.sleep(1)
    raise GateError('WRITER_TRANSITION_FAILED')


APPLICATION_DB_PROBE_TIMEOUT = 20
APPLICATION_DB_PROBE_OK = b'DB_READ_OK\n'
APPLICATION_DB_PROBE_SCRIPT = (
    "import { prisma } from './server/pg.js'; "
    "try { const rows = await prisma.$queryRawUnsafe('SELECT 1 AS ok'); "
    "if (rows.length !== 1 || rows[0].ok !== 1) throw Error('BAD_RESULT'); "
    "process.stdout.write('DB_READ_OK\\n'); "
    "} catch { process.exitCode = 1; } "
    "finally { try { await prisma.$disconnect(); } catch { process.exitCode = 1; } }"
)


def application_db_probe(remote, name, failure_code):
    # Run inside the application container with its existing Prisma client and
    # DATABASE_URL. Neither credentials nor Prisma diagnostics leave this gate.
    args = ['docker', 'exec', '-w', '/app', '-e',
            'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=8000 -c temp_file_limit=0',
            name, 'node', '--input-type=module', '-e', APPLICATION_DB_PROBE_SCRIPT]
    try:
        output = remote.run(args, timeout=APPLICATION_DB_PROBE_TIMEOUT)
    except GateError:
        raise GateError(failure_code) from None
    require(output == APPLICATION_DB_PROBE_OK, failure_code)


def rollback(remote, state, ledger):
    if shipping_migration():
        require(not state.get('backup_attempted') or state.get('backup_termination_verified') is True,
                'SHIPPING_BACKUP_TERMINATION_UNVERIFIED')
        require(state.get('migration_phase') in ('L85', 'L86'), 'SHIPPING_MIGRATION_STATE_UNKNOWN')
        ledger = before_ledger(ledger) if state['migration_phase'] == 'L85' else ledger
    # Do not start the previous writer if candidate termination is unproven.
    if state.get('candidate_attempted'):
        current = remote.containers()
        if any(c['Name'].lstrip('/') == state['candidate'] for c in current):
            remote.run(['docker','stop','--time','30',state['candidate']])
        settle_writers(remote, ledger, [])
    elif shipping_migration() and state.get('old_stop_attempted'):
        settle_writers(remote, ledger, [])
    if state.get('old_stop_attempted'):
        remote.run(['docker','start',state['name']])
        remote.health(state['name'], EXPECTED_OLD_SHA)
        application_db_probe(remote, state['name'], 'ROLLBACK_APPLICATION_DB_PROBE_FAILED')
        settle_writers(remote, ledger, [state['name']])
    if state.get('routes_touched'):
        replace_routes(remote, state['template'], state['active'])
    if state.get('pointer_touched'):
        write_authority(remote,CURRENT_SHA_FILE,EXPECTED_OLD_SHA+'\n')
    remote.health(state['name'], EXPECTED_OLD_SHA, public=True)
    settle_writers(remote, ledger, [state['name']])


class LocalRemote(Remote):
    """Same adapters, executed in ONE production-side control process.

    SSH disconnects must not cause an off-host controller to race a still-running
    helper. HUP/TERM/INT initiate rollback here, where the mutation occurs.
    """
    def __init__(self):
        pass
    def py(self, code, value=None, timeout=60):
        if shipping_migration() and code == SHIPPING_BACKUP_RESTORE_CODE:
            # Keep this long, cancellable operation in the ONE control process.
            # No sudo child can outlive a killed off-host timeout or swallow HUP.
            previous_in, previous_out = sys.stdin, sys.stdout
            output = io.StringIO()
            namespace = {'__name__':'shipping_backup_restore'}
            try:
                sys.stdin, sys.stdout = io.StringIO(json.dumps(value)), output
                exec(compile(code, 'shipping-backup-restore', 'exec'), namespace)
                return output.getvalue().encode()
            except BaseException as error:
                verified = namespace.get('cleanup_complete') is True
                failure = error if verified and isinstance(error, GateError) else GateError(
                    'SHIPPING_BACKUP_RESTORE_UNVERIFIED' if verified else 'SHIPPING_BACKUP_TERMINATION_UNVERIFIED')
                failure.backup_termination_verified = verified
                raise failure from None
            finally:
                sys.stdin, sys.stdout = previous_in, previous_out
        return super().py(code, value, timeout)
    def run(self, args, data=None, timeout=60):
        mutation = args[0] == 'sudo' or args[:2] in (['docker','stop'],['docker','start'],['docker','update']) or (args[:2] == ['docker','exec'] and ('nginx' in args or 'sh' in args))
        if not mutation:
            return command(args,data,timeout)
        # Do not kill a helper mid-create/start and then race it during rollback.
        # Defer terminal/transport signals until its Docker operation has returned.
        signals = {signal.SIGHUP,signal.SIGTERM,signal.SIGINT}
        previous = signal.pthread_sigmask(signal.SIG_BLOCK,signals)
        try:
            return command(args,data,timeout=None)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK,previous)


def execute_loaded(remote, art, ledger, helper, expected_id, expected_routes):
    require(not MEASURE_ONLY, 'MEASURE_ONLY_DEPLOY_FORBIDDEN')
    state = None
    retain_lock = False
    stage = 'PREFLIGHT'
    def interrupted(*_):
        raise GateError('INTERRUPTED')
    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, interrupted)
    try:
        state = preflight(remote, art, ledger, imported=True)
        require(state['old']['Id'] == expected_id and digest(state['template'].encode()) == expected_routes,
                'AUTHORITY_CHANGED_DURING_IMPORT')
        resolve_loaded_image(remote, art)  # Recheck exact tag before stopping old writer.
        release = art['release']
        name = 'budu-prod-' + release[:12] + CONTAINER_SUFFIX
        state['candidate'] = name
        stage = 'AUTHORITY_MOUNT_SNAPSHOT'
        authority_mounts = mount_readability(remote, state['name'])
        # Fresh route snapshots, not any previous feature's rollback directory.
        root = '/opt/budu/.rollback-assets/' + ROLLBACK_PREFIX + release
        remote.py("import json,pathlib,sys,os; v=json.load(sys.stdin); p=pathlib.Path(v['root']); p.mkdir(mode=0o700); os.umask(0o077); (p/'template').write_text(v['template']); (p/'active').write_text(v['active']); (p/'manifest.json').write_text(json.dumps(v['manifest'],sort_keys=True))",
                  {'root':root,'template':state['template'],'active':state['active'],
                   'manifest':{'oldSha':EXPECTED_OLD_SHA,'runtimeSha':RUNTIME_SHA,'releaseSha':release,
                               'oldContainer':state['name'],'oldImage':state['old']['Image'],
                               'candidate':name,'candidateImageReference':art['imageReference'],
                               'candidateLoadedImageId':art['loadedDockerImageId'],
                               'candidateArchiveConfigDigest':art['archiveConfigDigest'],
                               'templateHash':digest(state['template'].encode()),'migrations':85,
                               'migrationTarget':SHIPPING_MIGRATION if shipping_migration() else None,
                               'migrationSqlHash':SHIPPING_SQL_HASH if shipping_migration() else None,
                               'rollbackContract':'APPLICATION_ONLY_KEEP_L86_AND_ACTUAL_FACTS' if shipping_migration() else 'UNCHANGED_L85',
                               'authorityMountReadability':authority_mounts}})
        require(remote.routes() == (state['template'],state['active']), 'ROUTE_CHANGED_BEFORE_STOP')
        state['old_stop_attempted'] = True
        stage = 'OLD_WRITER_DRAIN'
        remote.run(['docker','stop','--time','30',state['name']])
        settle_writers(remote, before_ledger(ledger), [])
        if shipping_migration():
            stage = 'SHIPPING_BACKUP_RESTORE'
            state['backupProof'] = shipping_backup_restore(remote, state, root, art)
            settle_writers(remote, before_ledger(ledger), [])
            stage = 'SHIPPING_CHECK_MIGRATION'
            shipping_migrate(remote, state, art, ledger)
        state['candidate_attempted'] = True
        stage = 'CANDIDATE_CREATE'
        # Existing cloner is sent via stdin; binding comes only from existing env.
        # It is held in tmpfs and removed even on failure. No env values printed.
        payload = {'helper':helper,'old':state['name'],'candidate':name,'image':art['imageReference'],
                   'sha':release,'network':state['old']['HostConfig']['NetworkMode']}
        remote.py("import json,sys,subprocess,tempfile,pathlib,os; v=json.load(sys.stdin); c=json.loads(subprocess.check_output(['docker','inspect',v['old']]))[0]; e=dict(x.split('=',1) for x in c['Config']['Env']); f,p=tempfile.mkstemp(dir='/dev/shm'); os.fchmod(f,0o600); os.write(f,json.dumps({'username':e['CUSTOMER_REQUEST_WECOM_RECIPIENT_USERNAME'],'userId':e['CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID']}).encode()); os.close(f)\ntry:\n r=subprocess.run(['python3','-',v['old'],v['candidate'],v['image'],v['sha'],p,v['network'],'preserve','writer'],input=v['helper'].encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE); result=r.returncode\nfinally:\n pathlib.Path(p).unlink()\nraise SystemExit(result)", payload)
        remote.run(['docker','update','--restart','unless-stopped',name])
        stage = 'CANDIDATE_CLONE_PARITY'
        validate_candidate_image(remote.inspect(name), art)
        clone_parity(state['old'], remote.inspect(name), release)
        settle_writers(remote, ledger, [name])
        stage = 'CANDIDATE_INTERNAL_HEALTH'
        remote.health(name, release)
        stage = 'CANDIDATE_RUNTIME_CHECKS'
        runtime_checks(remote, name, art['runtimeHash'], authority_mounts)
        validate_candidate_image(remote.inspect(name), art)
        stage = 'CANDIDATE_APPLICATION_DB_PROBE'
        application_db_probe(remote, name, 'CANDIDATE_APPLICATION_DB_PROBE_FAILED')
        require(remote.routes() == (state['template'],state['active']), 'ROUTE_CHANGED_BEFORE_CUTOVER')
        new = state['template'].replace('http://' + state['name'] + ':3000', 'http://' + name + ':3000')
        require(new.count('http://' + name + ':3000') == 3, 'CUTOVER_ROUTE_COUNT_INVALID')
        state['routes_touched'] = True
        stage = 'NGINX_CUTOVER'
        replace_routes(remote, new, new)
        stage = 'PUBLIC_HEALTH'
        remote.health(name, release, public=True)
        settle_writers(remote, ledger, [name])
        stage = 'FINAL_RUNTIME_CHECKS'
        runtime_checks(remote, name, art['runtimeHash'], authority_mounts)
        stage = 'FINAL_DISK'
        used, available = remote.disk()
        require(math.ceil(100*used/(used+available)) <= MAX_PROJECTED_USAGE
                and available >= MIN_PROJECTED_AVAILABLE, 'ARTIFACT_DISK_GATE_FAIL:POST_DEPLOY_HEADROOM')
        state['pointer_touched'] = True
        stage = 'SHA_POINTER'
        write_authority(remote,CURRENT_SHA_FILE,release+'\n')
        require(remote.run(['cat',CURRENT_SHA_FILE]).decode().strip() == release, 'SHA_POINTER_WRITE_FAILED')
        print(json.dumps({'result':'DEPLOY_COMPLETE','runtimeSha':RUNTIME_SHA,'releaseSha':release,'rollbackSha':EXPECTED_OLD_SHA,'writer':1,
                          'imageReference':art['imageReference'],'archiveConfigDigest':art['archiveConfigDigest'],
                          'loadedDockerImageId':art['loadedDockerImageId'],'rootfsIdentityMatch':True,
                          'mountReadabilityParity':'PASS','authorityMountReadability':authority_mounts,
                          'diskAfterUsed':used,'diskAfterAvailable':available,
                          'dfPk':remote.run(['df','-Pk','/']).decode(),'transferCodePresent':True,
                          'migrationPhase':state.get('migration_phase')}))
    except BaseException as error:
        # Finish rollback despite a second transport/terminal signal.
        for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, signal.SIG_IGN)
        if shipping_migration() and state and state.get('migration_phase') == 'UNKNOWN':
            retain_lock = True
            try:
                current = remote.inspect(state['migrator'])
                if current['State']['Running']:
                    remote.run(['docker','stop','--time','30',state['migrator']])
                writer_check(remote.containers(), remote.db(), [])
            except BaseException:
                pass  # Unproven termination stays closed; never start old writer.
        if state and state.get('old_stop_attempted'):
            try:
                rollback(remote, state, ledger)
            except BaseException:
                if shipping_migration():
                    retain_lock = True
                code = ('CANDIDATE_DB_PROBE_FAILED_AND_ROLLBACK_FAILED'
                        if stage == 'CANDIDATE_APPLICATION_DB_PROBE'
                        else 'ROLLBACK_UNVERIFIED_MANUAL_ATTENTION_REQUIRED')
                failure = GateError(code)
                failure.failure_stage = stage
                failure.deployment_result = 'DEPLOY_BLOCKED'
                raise failure from None
        error.failure_stage = stage
        error.deployment_result = 'DEPLOY_ROLLED_BACK' if state and state.get('old_stop_attempted') else 'DEPLOY_BLOCKED'
        raise
    finally:
        if not retain_lock:
            remote.py('import os; os.rmdir(%r)' % LOCK)


SAFE_CONTROLLER_CODES = frozenset({
    'RUNTIME_MOUNT_PROBE_FAILED','RUNTIME_MOUNT_IDENTITY_PARITY_FAILED',
    'RUNTIME_MOUNT_READABILITY_PARITY_FAILED','RUNTIME_CRASH_DETECTED',
    'LIVE_TRANSFER_CODE_MISMATCH','CRITICAL_STARTUP_LOG','HEALTH_FAILED',
    'CLONE_ENV_MISMATCH','CLONE_CONFIG_MISMATCH','CLONE_LABELS_MISMATCH',
    'CLONE_HOST_CONFIG_MISMATCH','CLONE_RESOURCE_PROFILE_MISMATCH',
    'CLONE_MOUNTS_MISMATCH','CLONE_NETWORKS_MISMATCH','WRITER_TRANSITION_FAILED',
    'DATABASE_AUTHORITY_MISMATCH','MIGRATION_LEDGER_INVALID','MIGRATION_CHECKSUM_MISMATCH',
    'COMMAND_FAILED','COMMAND_UNAVAILABLE_OR_TIMEOUT','INTERRUPTED',
    'CANDIDATE_APPLICATION_DB_PROBE_FAILED',
    'CANDIDATE_DB_PROBE_FAILED_AND_ROLLBACK_FAILED',
    'ROLLBACK_UNVERIFIED_MANUAL_ATTENTION_REQUIRED',
    'REMOTE_CONTROLLER_FAILURE_DETAILS_SUPPRESSED',
    'SHIPPING_MIGRATION_STATE_UNKNOWN','SHIPPING_MIGRATOR_UNVERIFIED',
    'SHIPPING_MIGRATOR_IDENTITY_INVALID','SHIPPING_BACKUP_RESTORE_UNVERIFIED',
    'SHIPPING_DATABASE_PHASE_INVALID','SHIPPING_MIGRATION_DISK_GATE_FAILED',
    'SHIPPING_PG16_REQUIRED','SHIPPING_PRISMA_CLI_INVALID',
    'SHIPPING_BACKUP_TERMINATION_UNVERIFIED',
})
SAFE_CONTROLLER_STAGES = frozenset({
    'PREFLIGHT','AUTHORITY_MOUNT_SNAPSHOT','OLD_WRITER_DRAIN','CANDIDATE_CREATE',
    'CANDIDATE_CLONE_PARITY','CANDIDATE_INTERNAL_HEALTH','CANDIDATE_RUNTIME_CHECKS',
    'CANDIDATE_APPLICATION_DB_PROBE',
    'SHIPPING_BACKUP_RESTORE','SHIPPING_CHECK_MIGRATION',
    'NGINX_CUTOVER','PUBLIC_HEALTH','FINAL_RUNTIME_CHECKS','FINAL_DISK','SHA_POINTER','UNKNOWN',
})


def run_loaded_controller(value):
    try:
        execute_loaded(LocalRemote(),value['art'],value['ledger'],value['helper'],value['oldId'],value['routeHash'])
    except BaseException as error:
        code = str(error) if isinstance(error, GateError) else ''
        stage = getattr(error, 'failure_stage', 'UNKNOWN')
        result = getattr(error, 'deployment_result', 'DEPLOY_BLOCKED')
        # No stderr or exception text crosses SSH unless it is an exact fixed code.
        print(json.dumps({'result':result if result in ('DEPLOY_BLOCKED','DEPLOY_ROLLED_BACK') else 'DEPLOY_BLOCKED',
                          'failureGate':stage if stage in SAFE_CONTROLLER_STAGES else 'UNKNOWN',
                          'code':code if code in SAFE_CONTROLLER_CODES else 'REMOTE_CONTROLLER_FAILURE_DETAILS_SUPPRESSED'}))


def check_controller_result(raw):
    try:
        result = json.loads(raw)
    except (ValueError, UnicodeError):
        raise GateError('REMOTE_CONTROLLER_RESULT_INVALID') from None
    require(isinstance(result, dict), 'REMOTE_CONTROLLER_RESULT_INVALID')
    if result.get('result') in ('DEPLOY_BLOCKED','DEPLOY_ROLLED_BACK'):
        require(result.get('code') in SAFE_CONTROLLER_CODES
                and result.get('failureGate') in SAFE_CONTROLLER_STAGES
                and set(result) == {'result','failureGate','code'}, 'REMOTE_CONTROLLER_RESULT_INVALID')
        print(json.dumps(result), flush=True)
        raise GateError(result['code'])
    require(result.get('result') == 'DEPLOY_COMPLETE', 'REMOTE_CONTROLLER_RESULT_INVALID')
    print(json.dumps(result), flush=True)


STAGING_CODE = r'''import hashlib,json,os,pathlib,pwd,re,stat,sys
v=json.load(sys.stdin)
def check(ok,code):
    if not ok:
        print(json.dumps({'error':code})); raise SystemExit(0)
check(bool(re.fullmatch('[0-9a-f]{40}',v['release'])), 'STAGING_RELEASE_INVALID')
check(bool(re.fullmatch('[0-9a-f]{64}',v['sha256'])) and v['bytes']>0, 'STAGING_IDENTITY_INVALID')
root=pathlib.Path('/opt/budu/.release-staging')
account=pwd.getpwnam('ubuntu')
if not root.exists() and not root.is_symlink():
    root.mkdir(mode=0o700); os.chown(root,account.pw_uid,account.pw_gid)
check(root.resolve()==root and root.is_dir(), 'STAGING_PATH_UNSAFE')
s=root.stat()
check(s.st_uid==account.pw_uid and stat.S_IMODE(s.st_mode)==0o700, 'STAGING_DIRECTORY_PERMISSIONS')
part=root/(v['release']+'.tar.part'); final=root/(v['release']+'.tar'); meta=root/(v['release']+'.json')
identity={k:v[k] for k in ('release','sha256','bytes')}
def safe(p):
    if not p.exists() and not p.is_symlink(): return False
    s=p.lstat()
    check(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==account.pw_uid
          and stat.S_IMODE(s.st_mode)==0o600, 'STAGING_FILE_UNSAFE')
    return True
def create(p,data):
    fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as out:
        os.fchown(out.fileno(),account.pw_uid,account.pw_gid); out.write(data)
        out.flush(); os.fsync(out.fileno())
if safe(meta):
    check(json.loads(meta.read_text())==identity, 'STAGING_ARTIFACT_IDENTITY_CONFLICT')
else:
    check(v['action']=='prepare' and not safe(part) and not safe(final), 'STAGING_METADATA_MISSING')
    create(meta,json.dumps(identity,sort_keys=True).encode())
has_part,has_final=safe(part),safe(final)
check(not (has_part and has_final), 'STAGING_AMBIGUOUS_FILES')
if v['action']=='prepare':
    if not has_part and not has_final: create(part,b'')
    current=final if has_final else part
    if current.stat().st_size>v['bytes']:
        current.unlink(); meta.unlink()
        check(False,'STAGING_OVERSIZED_PART')
    print(json.dumps({'path':str(current),'bytes':current.stat().st_size,'complete':has_final}))
else:
    check(v['action'] in ('verify','cleanup'), 'STAGING_ACTION_INVALID')
    current=final if has_final else part
    check(has_part or has_final, 'STAGING_FILE_MISSING')
    h=hashlib.sha256()
    with current.open('rb') as src:
        for block in iter(lambda:src.read(1024*1024),b''): h.update(block)
    valid=current.stat().st_size==v['bytes'] and h.hexdigest()==v['sha256']
    if not valid:
        current.unlink(); meta.unlink()
        check(False,'STAGING_SIZE_OR_SHA256_MISMATCH')
    if v['action']=='cleanup':
        current.unlink(); meta.unlink()
        print(json.dumps({'cleaned':True}))
    else:
        if has_part: os.rename(part,final)
        fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY); os.fsync(fd); os.close(fd)
        print(json.dumps({'path':str(final),'bytes':v['bytes'],'sha256':h.hexdigest(),'verified':True}))
'''


def staging_action(remote, art, action):
    result = json.loads(remote.py(STAGING_CODE, {'action':action,'release':art['release'],
                                                'sha256':art['archiveHash'],'bytes':art['archive']}, timeout=180))
    require('error' not in result, result.get('error','STAGING_FAILED'))
    return result


def stage_artifact(remote, path, art):
    require(shutil.which('rsync') is not None, 'RUNNER_RSYNC_MISSING')
    remote.run(['rsync','--version'])
    with open(path,'rb') as stream:
        require(file_hash(stream)==art['archiveHash'], 'ARTIFACT_CHANGED')
    prepared = staging_action(remote, art, 'prepare')
    started = time.monotonic()
    print(json.dumps({'stage':'ARTIFACT_UPLOAD_STARTED','releaseSha':art['release'],
                      'archiveBytes':art['archive'],'resumeBytes':prepared['bytes']}), flush=True)
    if not prepared['complete']:
        target = STAGING_ROOT+'/'+art['release']+'.tar.part'
        args = ['rsync','--partial','--append-verify','--chmod=F600','--timeout=300',
                '-e',shlex.join(remote.ssh[:-1]),str(path),remote.ssh[-1]+':'+target]
        for attempt in range(1,4):
            remaining = UPLOAD_TIMEOUT-(time.monotonic()-started)
            require(remaining>0, 'ARTIFACT_UPLOAD_TIMEOUT')
            try:
                result = subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=remaining)
            except subprocess.TimeoutExpired:
                raise GateError('ARTIFACT_UPLOAD_TIMEOUT') from None
            if result.returncode==0: break
            print(json.dumps({'stage':'ARTIFACT_UPLOAD_RETRY','attempt':attempt,
                              'partialRetained':True,'rsyncExit':result.returncode}), flush=True)
        require(result.returncode==0, 'ARTIFACT_UPLOAD_FAILED_PARTIAL_RETAINED')
    verified = staging_action(remote, art, 'verify')
    require(verified.get('verified') is True and verified.get('bytes')==art['archive']
            and verified.get('sha256')==art['archiveHash'], 'STAGING_VERIFICATION_INVALID')
    print(json.dumps({'stage':'ARTIFACT_UPLOAD_VERIFIED','elapsedSeconds':time.monotonic()-started,
                      'archiveBytes':verified['bytes'],'archiveSha256':verified['sha256']}), flush=True)
    return verified['path']


LOCAL_IMPORT_CODE = """import json,subprocess,sys,time
started=time.monotonic()
result=subprocess.run(['docker','load','-i',sys.argv[1]],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
print(json.dumps({'returncode':result.returncode,'elapsedSeconds':time.monotonic()-started}))
raise SystemExit(result.returncode)
"""


def deploy(remote, repo, path, art, ledger, authorize):
    require(not MEASURE_ONLY, 'MEASURE_ONLY_DEPLOY_FORBIDDEN')
    require(authorize == art['release'], 'EXPLICIT_RELEASE_AUTHORIZATION_REQUIRED')
    state = preflight(remote, art, ledger)
    print(json.dumps({'stage':'PRE_IMPORT_ADMISSION','releaseSha':art['release'],
                      'diskBefore':{'used':state['diskUsed'],'available':state['diskAvailable']},
                      'budget':state['budget'],'metrics':artifact_metrics(art)}), flush=True)
    release = art['release']
    name = 'budu-prod-' + release[:12] + CONTAINER_SUFFIX
    remote.py('import os; os.mkdir(%r,0o700)' % LOCK)
    handed_off = False
    import_started = import_complete = False
    staging_started = staging_complete = False
    try:
        require(not remote.run(['docker','ps','-aq','--filter','name=^/' + name + '$']).strip(), 'CANDIDATE_NAME_EXISTS')
        require(not remote.run(['docker','images','-q',art['imageReference']]).strip(), 'CANDIDATE_TAG_EXISTS')
        staging_started = True
        staged = stage_artifact(remote, path, art)
        staging_complete = True
        # Refresh authority and the unchanged conservative disk gate after a long upload.
        fresh = preflight(remote, art, ledger)
        require(fresh['old']['Id']==state['old']['Id'] and fresh['template']==state['template'],
                'AUTHORITY_CHANGED_DURING_UPLOAD')
        import_started = True
        try:
            r = subprocess.run(remote.ssh + [shlex.join(['python3','-c',LOCAL_IMPORT_CODE,staged])],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1800)
        except subprocess.TimeoutExpired:
            raise GateError('ARTIFACT_LOAD_TIMEOUT') from None
        require(r.returncode == 0, 'ARTIFACT_LOAD_FAILED')
        imported = json.loads(r.stdout)
        require(imported.get('returncode')==0, 'ARTIFACT_LOAD_FAILED')
        import_complete = True
        print(json.dumps({'stage':'LOCAL_ARTIFACT_IMPORT_COMPLETE',
                          'elapsedSeconds':imported['elapsedSeconds']}), flush=True)
        image = resolve_loaded_image(remote, art)
        art['loadedDockerImageId'] = image['Id']
        # Record post-import storage before any writer is stopped; no raw
        # environment or credential-bearing inspect output is printed.
        used, available = remote.disk()
        print(json.dumps({'stage':'POST_IMPORT_DISK','used':used,'available':available,
                          'IMAGE_SIZE_GIB':image['Size']/GIB,
                          'IMAGE_REFERENCE':art['imageReference'],'ARCHIVE_CONFIG_DIGEST':art['archiveConfigDigest'],
                          'LOADED_DOCKER_IMAGE_ID':art['loadedDockerImageId'],'ROOTFS_IDENTITY_MATCH':True,
                          'dfPk':remote.run(['df','-Pk','/']).decode(),
                          'dfHuman':remote.run(['df','-h','/']).decode(),
                          'dockerSystemDf':remote.run(['docker','system','df']).decode()}), flush=True)
        payload = {'art':art,'ledger':ledger,'profile':RELEASE_PROFILE,
                   'expectedOldSha':EXPECTED_OLD_SHA,'businessSha':RUNTIME_SHA,
                   'oldV2Hash':OLD_V2_HASH,
                   'helper':(Path(repo)/'scripts/clone-production-container.py').read_text(),
                   'oldId':state['old']['Id'],'routeHash':digest(state['template'].encode())}
        # Entire cutover/rollback runs in one remote process, no source/env file is
        # copied to production. Only the allowlisted summary is returned.
        code = Path(__file__).read_text().rsplit("\nif __name__ == '__main__':", 1)[0]
        code += "\nv=json.load(sys.stdin)\nif v['profile'] == 'post-transfer': configure_profile(v['profile'],v['expectedOldSha'],v['businessSha'],v['oldV2Hash'])\nrun_loaded_controller(v)\n"
        handed_off = True
        result = remote.py(code, payload, timeout=480)
        check_controller_result(result)
        require(staging_action(remote,art,'cleanup').get('cleaned') is True, 'STAGING_CLEANUP_FAILED')
        print(json.dumps({'stage':'STAGING_CLEANUP_COMPLETE','releaseSha':release}), flush=True)
    finally:
        # A transport failure after handoff is UNKNOWN, never start the old writer
        # from this process while the remote transaction might still be running.
        # Leave lock on an uncertain upload/import; a second load could double
        # the disk peak while the first daemon import is still completing.
        if not handed_off and (not staging_started or staging_complete) and (not import_started or import_complete):
            remote.py('import os; os.rmdir(%r)' % LOCK)


def artifact_metrics(art):
    values = {'ARCHIVE':art['archive'],'TOTAL_BLOB':art['blobs'],
              'TOTAL_EXPANDED_PHYSICAL':art['expanded'],'LARGEST_LAYER_EXPANDED':art['largest'],
              'RESERVE':RESERVE,'CURRENT_FORMULA_PEAK':art['archive']+art['blobs']+art['expanded']+art['largest']+RESERVE}
    result = {key+suffix:(value if suffix == '_BYTES' else value/GIB)
              for key,value in values.items() for suffix in ('_BYTES','_GIB')}
    result.update(CURRENT_GATE_MAX_GIB=ABSOLUTE_MAX_PEAK/GIB,
                  EXCESS_OVER_4GIB_BYTES=max(0,values['CURRENT_FORMULA_PEAK']-4*GIB),
                  EXCESS_OVER_4GIB=max(0,values['CURRENT_FORMULA_PEAK']-4*GIB)/GIB,
                  IMAGE_PLATFORM='linux',IMAGE_ARCH='amd64',
                  IMAGE_REFERENCE=art['imageReference'],ARCHIVE_CONFIG_DIGEST=art['archiveConfigDigest'],
                  LOADED_DOCKER_IMAGE_ID=art.get('loadedDockerImageId'),LAYERS=art['layers'])
    return result


MEASUREMENT_METADATA_SCRIPT = r'''import json,sys,subprocess,pathlib
v=json.load(sys.stdin)
base=['ctr','--address','/run/containerd/containerd.sock','--namespace','moby']
result={}
try:
 content=set(subprocess.check_output(base+['content','list','--quiet'],stderr=subprocess.DEVNULL).decode().split())
 snapshots=subprocess.check_output(base+['snapshots','--snapshotter','overlayfs','list'],stderr=subprocess.DEVNULL).decode().splitlines()[1:]
 committed={line.split()[0] for line in snapshots if line.split() and line.split()[-1]=='Committed'}
 result['metadataAvailable']=True
 result['existingContentCount']=len(content)
 result['contentProof']={}
 for d in v['digests']:
  p=pathlib.Path('/var/lib/containerd/io.containerd.content.v1.content/blobs/sha256')/d.split(':')[1]
  result['contentProof'][d]={'present':d in content,'fileBytes':p.stat().st_size if d in content and p.is_file() else None}
 result['snapshotProof']={d:d in committed for d in v['chains']}
except (OSError,subprocess.CalledProcessError):
 result={'metadataAvailable':False,'contentProof':{},'snapshotProof':{}}
df=json.loads(subprocess.check_output(['curl','--fail','--silent','--unix-socket','/var/run/docker.sock','http://localhost/system/df']))
matches=[i for i in df.get('Images',[]) if i.get('Id')==v['imageId']]
result['currentImageDf']={k:matches[0].get(k) for k in ('Id','Size','SharedSize','VirtualSize','Containers')} if len(matches)==1 else None
print(json.dumps(result))
'''


class MeasurementRemote(Remote):
    """Only the enumerated production reads are admitted in this audit."""
    def db(self):
        self._db_read = True
        try:
            return super().db()
        finally:
            self._db_read = False

    def run(self, args, data=None, timeout=60):
        allowed = (args in (['cat',TEMPLATE],['cat',CURRENT_SHA_FILE],
                           ['df','-Pk','/'],['df','-h','/'],['docker','ps','-q'],
                           ['docker','info','--format','{{json .}}'],['docker','system','df','-v'],
                           ['docker','version','--format','{{json .Server}}'],
                           ['curl','--fail','--silent','--max-time','10','https://buducandy.cn/api/health'])
                   or args[:3] in (['docker','container','inspect'],['docker','image','inspect']))
        if args[:2] == ['docker','exec']:
            allowed = (args == ['docker','exec',NGINX,'cat',ACTIVE]
                       or args[3:] in (['wget','-qO-','http://127.0.0.1:3000/api/health'],
                                       ['sha256sum','/app/server/v2.js']))
        if args[:4] == ['sudo','-n','python3','-c']:
            allowed = (args[4] == MEASUREMENT_METADATA_SCRIPT
                       or (getattr(self,'_db_read',False) and 'BEGIN READ ONLY;' in args[4]
                           and 'default_transaction_read_only=on' in args[4]))
        require(allowed, 'MEASUREMENT_REMOTE_MUTATION_FORBIDDEN')
        return super().run(args,data,timeout)


def production_measurement(remote, art, ledger):
    template, active = remote.routes()
    name = route_target(template,active)
    old = remote.inspect(name)
    require(old['State']['Running'] and env(old).get('GIT_SHA') == EXPECTED_OLD_SHA
            and old['Config']['Labels'].get(REVISION) == EXPECTED_OLD_SHA, 'PRODUCTION_SHA_MISMATCH')
    require(remote.run(['cat',CURRENT_SHA_FILE]).decode().strip() == EXPECTED_OLD_SHA, 'CURRENT_SHA_POINTER_MISMATCH')
    require(remote.run(['docker','exec',name,'sha256sum','/app/server/v2.js']).decode().split()[0] == OLD_V2_HASH, 'OLD_RUNTIME_SOURCE_MISMATCH')
    remote.health(name,EXPECTED_OLD_SHA);remote.health(name,EXPECTED_OLD_SHA,public=True)
    db=remote.db();validate_database(db,before_ledger(ledger));writer_check(remote.containers(),db,[name])
    image=remote.inspect(old['Image'],image=True)
    info=json.loads(remote.run(['docker','info','--format','{{json .}}']))
    version=json.loads(remote.run(['docker','version','--format','{{json .Server}}']))
    used,available=remote.disk()
    metadata=json.loads(remote.py(MEASUREMENT_METADATA_SCRIPT,{'imageId':old['Image'],
                        'digests':[x['contentDigest'] for x in art['layers']],
                        'chains':[x['chainId'] for x in art['layers']]}))
    # The verbose report is read but never print unrelated image/container names.
    remote.run(['docker','system','df','-v'])
    df=metadata['currentImageDf']
    shared=df.get('SharedSize') if df else None
    unique=(df['Size']-shared) if df and isinstance(shared,int) and 0 <= shared <= df['Size'] else None
    return {'sha':EXPECTED_OLD_SHA,'health':'PASS','database':EXPECTED_DB,'migrationsApplied':85,
            'migrationsFailed':0,'writer':1,'imageId':old['Image'],'imageInspectSize':image['Size'],
            'rootfsDiffIds':image['RootFS']['Layers'],'imageDf':df,'sharedSize':shared,'uniqueSize':unique,
            'storage':{k:info.get(k) for k in ('ServerVersion','Driver','DriverStatus','DockerRootDir')},
            'containerdVersion':next((c['Version'] for c in version.get('Components',[]) if c['Name']=='containerd'),None),
            'diskUsed':used,'diskAvailable':available,'diskPercent':math.ceil(100*used/(used+available)),
            'metadata':metadata}


def disk_models(art, production):
    old_diffs=set(production['rootfsDiffIds'])
    proof=production['metadata']
    inventory=[]
    shared_blobs=shared_expanded=shared_count=reused_count=0
    largest_unique=largest_shared_blob=0
    for source in art['layers']:
        layer=dict(source)
        diff_shared=layer['diffId'] in old_diffs
        snapshot_shared=proof.get('snapshotProof',{}).get(layer['chainId']) is True
        blob_proof=proof.get('contentProof',{}).get(layer['contentDigest'])
        blob_shared=bool(blob_proof and blob_proof.get('present') is True and blob_proof.get('fileBytes') == layer['blobBytes'])
        layer.update(SHARED_WITH_CURRENT_PRODUCTION='YES' if diff_shared else 'NO',
                     SNAPSHOT_REUSE_CONFIRMED='YES' if snapshot_shared else ('NO' if proof['metadataAvailable'] else 'UNKNOWN'),
                     CONTENT_REUSE_CONFIRMED='YES' if blob_shared else ('NO' if proof['metadataAvailable'] else 'UNKNOWN'))
        shared_count+=int(diff_shared);reused_count+=int(snapshot_shared)
        if snapshot_shared:shared_expanded+=layer['expandedPhysicalBytes']
        else:largest_unique=max(largest_unique,layer['expandedPhysicalBytes'])
        if blob_shared:
            shared_blobs+=layer['blobBytes'];largest_shared_blob=max(largest_shared_blob,layer['blobBytes'])
        inventory.append(layer)
    unique_blobs=art['blobs']-shared_blobs # Includes all metadata; no metadata reuse credit.
    unique_expanded=art['expanded']-shared_expanded
    increments={'MODEL_A_CURRENT':art['archive']+art['blobs']+art['expanded']+art['largest']+RESERVE,
                'MODEL_B_STREAMING_NO_ARCHIVE_FILE':art['blobs']+art['expanded']+art['largest']+RESERVE,
                'MODEL_C_LAYER_REUSE_CONSERVATIVE':unique_blobs+unique_expanded+largest_unique+RESERVE}
    # containerd ingests blobs before their digest is known; even a shared blob
    # may transiently occupy an ingest file. Do not silently discount this peak.
    increments['MODEL_C_INGEST_STAGING_CHECK']=unique_blobs+unique_expanded+max(largest_unique,largest_shared_blob)+RESERVE
    models={}
    for name,peak in increments.items():
        used=production['diskUsed']+peak;available=production['diskAvailable']-peak
        pct=math.ceil(100*used/(production['diskUsed']+production['diskAvailable']))
        models[name]={'PEAK_INCREMENT_BYTES':peak,'PEAK_INCREMENT_GIB':peak/GIB,
                      'PROJECTED_USED_GIB':used/GIB,'PROJECTED_AVAILABLE_GIB':available/GIB,
                      'PROJECTED_USAGE_PERCENT':pct,
                      'PROJECTED_USAGE_CONTINUOUS_PERCENT':100*used/(production['diskUsed']+production['diskAvailable']),
                      'WITHIN_85_PERCENT_AND_10_GIB':pct<=MAX_PROJECTED_USAGE and available>=MIN_PROJECTED_AVAILABLE}
    return {'layers':inventory,'CANDIDATE_LAYER_COUNT':len(inventory),'SHARED_LAYER_COUNT':shared_count,
            'UNIQUE_CANDIDATE_LAYER_COUNT':len(inventory)-shared_count,'REUSABLE_SNAPSHOT_LAYER_COUNT':reused_count,
            'SHARED_EXPANDED_BYTES':shared_expanded,'UNIQUE_CANDIDATE_EXPANDED_BYTES':unique_expanded,
            'SHARED_COMPRESSED_BLOB_BYTES':shared_blobs if proof['metadataAvailable'] else 'UNKNOWN',
            'UNIQUE_COMPRESSED_BLOB_BYTES':unique_blobs if proof['metadataAvailable'] else 'UNKNOWN',
            'MODELED_UNIQUE_BLOB_BYTES':unique_blobs,'LARGEST_UNIQUE_LAYER_STAGING_BYTES':largest_unique,
            'SHARED_BLOB_MAX_INGEST_BYTES':largest_shared_blob,'models':models}


def ci_import_measurement(path, art):
    """Load ONLY into a fresh, isolated hosted-runner daemon; never SSH."""
    require(MEASURE_ONLY and os.environ.get('GITHUB_ACTIONS') == 'true'
            and os.environ.get('RUNNER_OS') == 'Linux' and os.environ.get('RUNNER_ARCH') == 'X64', 'CI_MEASUREMENT_HOST_REQUIRED')
    base=Path(os.environ['TRANSFER_CAS_RUN_DIR'])/'isolated-import'
    require(Path(os.environ['RUNNER_TEMP']).resolve() in base.resolve().parents, 'CI_TEMP_PATH_REQUIRED')
    base.mkdir()
    (base/'daemon.json').write_text('{"features":{"containerd-snapshotter":false}}')
    (base/'client').mkdir()
    data_root=base/'data';socket=base/'docker.sock'
    cli=['sudo','-n','docker','--config',str(base/'client'),'--host','unix://'+str(socket)]
    daemon_args=['sudo','-n','dockerd','--config-file',str(base/'daemon.json'),
                 '--data-root',str(data_root),'--exec-root',str(base/'exec'),'--pidfile',str(base/'daemon.pid'),
                 '--host','unix://'+str(socket),'--storage-driver','overlay2',
                 '--containerd-namespace=transfer-cas-measure-'+os.environ['GITHUB_RUN_ID'],
                 '--containerd-plugins-namespace=transfer-cas-measure-plugins-'+os.environ['GITHUB_RUN_ID'],
                 '--iptables=false','--ip6tables=false','--ip-forward=false','--ip-masq=false','--bridge=none']
    with (base/'daemon.log').open('wb') as log:
        daemon=subprocess.Popen(daemon_args,stdout=log,stderr=log)
        try:
            info=None
            for _ in range(45):
                try:
                    info=json.loads(command(cli+['info','--format','{{json .}}'],timeout=5));break
                except (GateError,ValueError):
                    require(daemon.poll() is None,'CI_DAEMON_START_FAILED');time.sleep(1)
            require(info and Path(info['DockerRootDir']).resolve() == data_root.resolve(),'CI_DAEMON_ISOLATION_FAILED')
            require(not command(cli+['image','ls','-q']).strip(),'CI_DAEMON_NOT_EMPTY')
            def allocated():
                return int(command(['sudo','-n','du','-s','-B1',str(data_root)],timeout=30).split()[0])
            before=allocated();peak=before
            with path.open('rb') as source:
                process=subprocess.Popen(cli+['load'],stdin=source,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                started=time.monotonic()
                while process.poll() is None:
                    peak=max(peak,allocated())
                    if time.monotonic()-started>300:
                        process.terminate();process.wait(timeout=20)
                        raise GateError('CI_IMPORT_TIMEOUT')
                    time.sleep(.5)
                stdout,stderr=process.communicate(timeout=10)
                require(process.returncode == 0,'CI_IMPORT_FAILED')
            after=allocated();peak=max(peak,after)
            images=json.loads(command(cli+['image','inspect',art['imageReference']]))
            require(isinstance(images,list) and len(images)==1,'DOCKER_IDENTITY_NOT_UNIQUE')
            image=images[0]
            # Measure first even when the deployment size cap would reject it.
            validate_loaded_image(image,art)
            return {'status':'PASS','CI_IMPORT_BEFORE_BYTES':before,'CI_IMPORT_AFTER_BYTES':after,
                    'CI_IMPORT_DISK_DELTA':after-before,'CI_IMPORT_SAMPLED_PEAK_DELTA':peak-before,
                    'CI_IMAGE_SIZE':image['Size'],
                    'storage':{k:info.get(k) for k in ('ServerVersion','Driver','DriverStatus')},
                    'SAMPLE_IS_UPPER_BOUND':False,'ISOLATED_DAEMON':True,'IMAGES_OR_CACHE_DELETED':False}
        finally:
            # Stop this dedicated CI daemon, keeping all image/data-root files.
            # No production process or shared runner Docker daemon is targeted.
            pidfile=base/'daemon.pid'
            if pidfile.exists():
                pid=command(['sudo','-n','cat',str(pidfile)]).decode().strip()
                require(pid.isdigit(),'CI_DAEMON_PID_INVALID')
                command(['sudo','-n','kill','-TERM',pid])
            if daemon.poll() is None:
                try:daemon.wait(timeout=30)
                except subprocess.TimeoutExpired:raise GateError('CI_DAEMON_STOP_UNCONFIRMED') from None


def measure_release(repo,path,art,ledger,key):
    require(MEASURE_ONLY,'MEASUREMENT_RELEASE_REQUIRED')
    production=production_measurement(MeasurementRemote(key),art,ledger)
    reuse=disk_models(art,production)
    print(json.dumps({'stage':'PRODUCTION_READ_ONLY_MODELS','production':production,'reuse':reuse},sort_keys=True),flush=True)
    ci=ci_import_measurement(path,art)
    metrics=artifact_metrics(art)
    metrics.update(DOCKER_IMAGE_INSPECT_SIZE_BYTES=ci['CI_IMAGE_SIZE'],DOCKER_IMAGE_INSPECT_SIZE_GIB=ci['CI_IMAGE_SIZE']/GIB)
    match=all(ci['storage'].get(k)==production['storage'].get(k) for k in ('ServerVersion','Driver','DriverStatus'))
    ci['CI_STORAGE_MODEL_MATCHES_PRODUCTION']=match
    ci['REPRESENTATIVENESS']='MATCHED_STORAGE_METADATA_ONLY' if match else 'NOT_DIRECTLY_REPRESENTATIVE'
    streaming_evidence=(production['storage'].get('ServerVersion') == '29.1.3'
                        and production['storage'].get('Driver') == 'overlayfs'
                        and ['driver-type','io.containerd.snapshotter.v1'] in production['storage'].get('DriverStatus',[])
                        and production.get('containerdVersion') == '2.2.1')
    model_b_safe=reuse['models']['MODEL_B_STREAMING_NO_ARCHIVE_FILE']['WITHIN_85_PERCENT_AND_10_GIB']
    model_c_safe=reuse['models']['MODEL_C_INGEST_STAGING_CHECK']['WITHIN_85_PERCENT_AND_10_GIB']
    feasibility=('SAFE' if streaming_evidence and (model_b_safe or model_c_safe)
                 else 'UNSAFE' if streaming_evidence and production['metadata']['metadataAvailable'] and not model_c_safe
                 else 'INCONCLUSIVE')
    return {'RESULT':'DISK_AUDIT_COMPLETE','MEASURE_ONLY':True,'BUSINESS_RUNTIME_SHA':RUNTIME_SHA,
            'MEASUREMENT_RELEASE_SHA':art['release'],'GITHUB_RUN_ID':os.environ.get('GITHUB_RUN_ID'),
            'artifactMetrics':metrics,'production':production,'reuse':reuse,'ciImport':ci,
            'PRODUCTION_ARCHIVE_RESIDENT_BYTES':0 if streaming_evidence else 'UNKNOWN',
            'archiveEvidence':'SSH stdin / containerd streaming ImportIndex; no complete archive file in the audited path',
            'PRODUCTION_OPERATIONAL_CHANGES':0,'BUSINESS_DATA_WRITE_OPERATIONS':0,'PRODUCTION_DEPLOYED':False,
            'DISK_FEASIBILITY':feasibility,'ABSOLUTE_MAX_PEAK':ABSOLUTE_MAX_PEAK,
            'RECOMMENDED_PEAK_FORMULA':'unique blobs + unique chain snapshots + max(largest unique expanded layer, largest shared blob ingest) + 512MiB; unknown counted unique',
            'RECOMMENDED_MAX_ARTIFACT_POLICY':'Model A <=6GiB AND projected usage <=85% AND available >=10GiB; 512MiB reserve retained; B/C metrics cannot authorize deployment',
            'RECOMMENDED_NEXT_ACTION':('Review a future disk-admission policy separately; deployment still forbidden'
                                       if feasibility=='SAFE' else 'EXPAND_PRODUCTION_SYSTEM_DISK'),
            'SOURCE_MODEL_MATCHES_PRODUCTION':streaming_evidence}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode', choices=['identity','inspect-artifact','preflight','deploy','measure-artifact','measure',
                                   'identity-diagnostic','inspect-artifact-diagnostic',
                                   'identity-backup-diagnostic','inspect-artifact-backup-diagnostic'])
    p.add_argument('--repo', type=Path, required=True)
    p.add_argument('--archive', type=Path)
    p.add_argument('--ssh-key', type=Path)
    p.add_argument('--authorize-release-sha')
    p.add_argument('--release-profile', choices=['transfer-first','post-transfer'], default='transfer-first')
    p.add_argument('--expected-production-sha')
    p.add_argument('--business-base-sha')
    args = p.parse_args()
    if args.release_profile == 'post-transfer':
        require(args.expected_production_sha is not None and args.business_base_sha is not None,
                'POST_TRANSFER_IDENTITY_REQUIRED')
        require(bool(re.fullmatch(r'[0-9a-f]{40}', args.expected_production_sha)), 'POST_TRANSFER_IDENTITY_INVALID')
        old_v2_hash = digest(command(['git','-C',str(args.repo),'show',
                                      args.expected_production_sha+':server/v2.js']))
        configure_profile(args.release_profile, args.expected_production_sha,
                          args.business_base_sha, old_v2_hash)
    else:
        require(args.expected_production_sha is None and args.business_base_sha is None,
                'FIRST_ROLLOUT_IDENTITY_OVERRIDE_FORBIDDEN')
    require(not (MEASURE_ONLY and args.mode == 'deploy'), 'MEASURE_ONLY_DEPLOY_FORBIDDEN')
    backup_diagnostic = args.mode in ('identity-backup-diagnostic','inspect-artifact-backup-diagnostic')
    diagnostic = backup_diagnostic or args.mode in ('identity-diagnostic','inspect-artifact-diagnostic')
    release, ledger = (backup_diagnostic_identity(args.repo) if backup_diagnostic else
                       diagnostic_identity(args.repo) if diagnostic else identity(args.repo))
    if args.mode in ('identity','identity-diagnostic','identity-backup-diagnostic'):
        result = {'result':'IDENTITY_PASS','releaseSha':release,'runtimeSha':RUNTIME_SHA}
        if diagnostic:result.update(diagnosticOnly=True, productionEligible=False)
        print(json.dumps(result))
        return
    require(args.archive is not None, 'ARCHIVE_REQUIRED')
    if args.mode == 'deploy':
        require(args.authorize_release_sha == release, 'EXPLICIT_RELEASE_AUTHORIZATION_REQUIRED')
        require(args.ssh_key is not None, 'SSH_KEY_REQUIRED')
        # Freeze the input in a private OFF-HOST directory before validating it.
        # A producer rewriting its original tar cannot change the import stream.
        with tempfile.TemporaryDirectory(prefix='transfer-cas-artifact-') as directory:
            frozen = Path(directory)/'image.tar'
            total = 0
            with args.archive.open('rb') as src, frozen.open('xb') as dst:
                while True:
                    block = src.read(1024*1024)
                    if not block: break
                    total += len(block)
                    require(total <= MAX_ARCHIVE, 'ARCHIVE_TOO_LARGE')
                    dst.write(block)
            frozen.chmod(0o400)
            art = artifact(frozen,release,args.repo)
            deploy(Remote(args.ssh_key),args.repo,frozen,art,ledger,args.authorize_release_sha)
        return
    art = artifact(args.archive, release, args.repo)
    print(json.dumps({'stage':'ARTIFACT_METRICS','metrics':artifact_metrics(art)},sort_keys=True),flush=True)
    if args.mode in ('measure-artifact','measure'):
        require(MEASURE_ONLY, 'MEASUREMENT_RELEASE_REQUIRED')
        metrics = artifact_metrics(art)
        print(json.dumps({'stage':'ARTIFACT_METRICS','metrics':metrics},sort_keys=True),flush=True)
        if args.mode == 'measure-artifact':
            return
        require(args.ssh_key is not None, 'SSH_KEY_REQUIRED')
        result = measure_release(args.repo, args.archive, art, ledger, args.ssh_key)
        print('TRANSFER_CAS_MEASUREMENT_JSON='+json.dumps(result,sort_keys=True),flush=True)
        return
    summary = {'releaseSha':release,'businessRuntimeSha':RUNTIME_SHA,'rollbackSha':EXPECTED_OLD_SHA,
               'artifact':{k:art[k] for k in ['archive','blobs','expanded','largest','imageReference','archiveConfigDigest','rootfsDiffIds','archiveHash']},
               'migrationRequired':'YES' if shipping_migration() else MIGRATION_REQUIRED}
    if args.mode in ('inspect-artifact','inspect-artifact-diagnostic','inspect-artifact-backup-diagnostic'):
        # Offline validation still rejects artifacts over the absolute peak cap.
        summary['budget'] = disk_budget(0,100*GIB,art['archive'],art['blobs'],art['expanded'],art['largest'])
    else:
        require(args.ssh_key is not None, 'SSH_KEY_REQUIRED')
        remote = Remote(args.ssh_key)
        state = preflight(remote,art,ledger)
        # Preserve measured layers and fresh reuse evidence as diagnostics only.
        # Admission always uses full Model A, without reuse discounts.
        measured = production_measurement(MeasurementRemote(args.ssh_key),art,ledger)
        summary['models'] = disk_models(art,measured)
        summary['budget'] = state['budget']
        summary['diskBefore'] = {'used':state['diskUsed'],'available':state['diskAvailable']}
        summary['dfHuman'] = state['dfHuman']
        summary['dockerSystemDf'] = state['dockerSystemDf']
    summary['result'] = 'DIAGNOSTIC_ARTIFACT_PASS' if diagnostic else 'PREFLIGHT_PASS'
    if diagnostic:summary.update(diagnosticOnly=True, productionEligible=False)
    print(json.dumps(summary,sort_keys=True))

if __name__ == '__main__':
    try:
        main()
    except GateError as error:
        print(json.dumps({'result':'RELEASE_ABORTED','code':str(error)}))
        sys.exit(1)
    except Exception:
        print(json.dumps({'result':'RELEASE_ABORTED','code':'UNEXPECTED_ERROR_DETAILS_SUPPRESSED'}))
        sys.exit(1)

#!/usr/bin/env python3
"""ONLINE-CATALOG-ADMIN-001 production contract: L91 -> L92.

Identity and ledger gates only. The deploy orchestration is intentionally not
implemented yet: it must reuse the blue-green primitives in
deploy-prod-transfer-cas.py and be rehearsed against a production clone before
it can be authorized. Running any mode other than `identity` fails closed.
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

BASE = 'e91561238b866284bb6621a57fc02926fba01ec8'
BUSINESS = '62a2ac65e346a35f58e803ae07751b882254e48b'
BRANCH = 'codex/online-catalog-admin-002'
MIGRATION = '20261112120000_online_catalog_admin'
SQL_HASH = 'cb87993f9e3b1fd74478657ee8f7cd3e4efdf570e27f66d0827cb9a871368437'
CONTROLLER_HASH = 'e4206fa68019770ef82a8a37c3359c75164d18a749f555f0e844c6eeada02e03'
OLD_COUNT = 91
NEW_COUNT = 92

BUSINESS_FILES = {
    '.github/workflows/deploy-test.yml',
    'docs/ONLINE_CATALOG_ADMIN_IMPLEMENTATION.md',
    'docs/ONLINE_CATALOG_RELEASE_CHECKLIST.md',
    'docs/STAGING_BEIJING.md',
    'package-lock.json',
    'package.json',
    f'prisma/migrations/{MIGRATION}/migration.sql',
    'prisma/schema.prisma',
    'scripts/e2e-online-catalog-browser.mjs',
    'scripts/test-online-catalog-admin.mjs',
    'scripts/test-online-catalog-api-native.mjs',
    'server/app.js',
    'server/online-catalog-publisher.js',
    'server/online-catalog.js',
    'src/App.jsx',
    'src/components/OnlineCatalogPage.jsx',
}
ENGINEERING_FILES = {
    'scripts/deploy-prod-online-catalog.py',
    'scripts/test-online-catalog-release.py',
    'docs/ONLINE_CATALOG_CONTRACT.md',
}


class Blocked(Exception):
    pass


def require(ok, code):
    if not ok:
        raise Blocked(code)


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], text=True)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def ledger(repo, rev=None):
    """migration name -> sha256 of migration.sql, from a revision or worktree."""
    if rev:
        names = [p for p in git(repo, 'ls-tree', '-r', '--name-only', rev, 'prisma/migrations').splitlines()
                 if p.endswith('/migration.sql')]
        return {Path(p).parent.name: digest(subprocess.check_output(['git', '-C', str(repo), 'show', f'{rev}:{p}']))
                for p in names}
    return {p.parent.name: digest(p.read_bytes()) for p in (Path(repo) / 'prisma/migrations').glob('*/migration.sql')}


def identity(repo, release):
    require(bool(re.fullmatch('[0-9a-f]{40}', release)), 'RELEASE_SHA_INVALID')
    require(git(repo, 'rev-parse', 'HEAD').strip() == release, 'RELEASE_SHA_MISMATCH')
    require(git(repo, 'branch', '--show-current').strip() == BRANCH, 'ONLINE_CATALOG_BRANCH_INVALID')
    require(not git(repo, 'status', '--porcelain', '--untracked-files=all').strip(), 'WORKTREE_NOT_CLEAN')
    require(release != BUSINESS and release != BASE, 'ONLINE_CATALOG_RELEASE_NOT_ENGINEERING')

    # Lineage: BASE -> BUSINESS -> release, linear, no merges.
    require(git(repo, 'merge-base', '--is-ancestor', BASE, BUSINESS) == '', 'ONLINE_CATALOG_BASE_NOT_ANCESTOR')
    require(git(repo, 'merge-base', '--is-ancestor', BUSINESS, release) == '', 'ONLINE_CATALOG_BUSINESS_NOT_ANCESTOR')
    require(not git(repo, 'rev-list', '--merges', f'{BUSINESS}..{release}').strip(), 'ONLINE_CATALOG_MERGE_UNREVIEWED')

    base_files = set(git(repo, 'diff', '--name-only', BASE, BUSINESS).splitlines())
    eng_files = set(git(repo, 'diff', '--name-only', BUSINESS, release).splitlines())
    require(base_files == BUSINESS_FILES, f'ONLINE_CATALOG_BUSINESS_SCOPE_INVALID:{sorted(base_files ^ BUSINESS_FILES)}')
    require(eng_files == ENGINEERING_FILES, f'ONLINE_CATALOG_ENGINEERING_SCOPE_INVALID:{sorted(eng_files ^ ENGINEERING_FILES)}')

    # The controller itself must be byte-identical to the reviewed base.
    require(digest((Path(repo) / 'scripts/deploy-prod-transfer-cas.py').read_bytes()) == CONTROLLER_HASH,
            'ONLINE_CATALOG_CONTROLLER_CHANGED')

    old = ledger(repo, BASE)
    now = ledger(repo)
    require(len(old) == OLD_COUNT and len(now) == NEW_COUNT, 'ONLINE_CATALOG_LEDGER_COUNT_INVALID')
    require(set(now) - set(old) == {MIGRATION}, 'ONLINE_CATALOG_LEDGER_SCOPE_INVALID')
    require(all(now[name] == value for name, value in old.items()), 'ONLINE_CATALOG_LEDGER_HISTORY_CHANGED')
    require(now[MIGRATION] == SQL_HASH, 'ONLINE_CATALOG_SQL_CHANGED')
    require(git(repo, 'diff', '--check', BASE, release) == '', 'ONLINE_CATALOG_WHITESPACE')

    return {
        'result': 'IDENTITY_PASS',
        'release': release,
        'base': BASE,
        'business': BUSINESS,
        'migration': MIGRATION,
        'sqlHash': SQL_HASH,
        'oldLedgerCount': OLD_COUNT,
        'newLedgerCount': NEW_COUNT,
        'deployImplemented': False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['identity', 'inspect-artifact', 'preflight', 'deploy'])
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--release-sha', required=True)
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--ssh-key')
    parser.add_argument('--authorize-release-sha')
    args = parser.parse_args()

    result = identity(args.repo, args.release_sha)
    if args.mode == 'identity':
        print(json.dumps(result))
        return
    # Deliberate stop: the blue-green deploy and the atomic migration step must be
    # written and rehearsed against a production clone before production use.
    print(json.dumps({'result': 'BLOCKED', 'code': 'ONLINE_CATALOG_DEPLOY_NOT_IMPLEMENTED'}))
    raise SystemExit(2)


if __name__ == '__main__':
    try:
        main()
    except Blocked as error:
        print(json.dumps({'result': 'BLOCKED', 'code': str(error)}))
        raise SystemExit(1)

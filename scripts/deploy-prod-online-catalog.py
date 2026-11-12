#!/usr/bin/env python3
"""ONLINE-CATALOG-ADMIN-001 production release contract: L91 -> L92.

Deployment follows the golive model that production actually runs
(`golive-blue-green.py`, BUDU-OFFLINE-TO-MINI-001): clone the live container
with a new image, start it in standby, promote with SIGUSR2, swap nginx, then
retire the old container. The generic bg_clone path is not used because the live
container is a thin/golive container that `validate_clone_source` rejects.

Modes: identity | inspect-artifact | preflight | deploy
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
MIN_FREE_BYTES = 12 * 1024 ** 3

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
    '.github/workflows/release-online-catalog.yml',
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
    require(git(repo, 'merge-base', '--is-ancestor', BASE, BUSINESS) == '', 'ONLINE_CATALOG_BASE_NOT_ANCESTOR')
    require(git(repo, 'merge-base', '--is-ancestor', BUSINESS, release) == '', 'ONLINE_CATALOG_BUSINESS_NOT_ANCESTOR')
    require(not git(repo, 'rev-list', '--merges', f'{BUSINESS}..{release}').strip(), 'ONLINE_CATALOG_MERGE_UNREVIEWED')
    base_files = set(git(repo, 'diff', '--name-only', BASE, BUSINESS).splitlines())
    eng_files = set(git(repo, 'diff', '--name-only', BUSINESS, release).splitlines())
    require(base_files == BUSINESS_FILES, f'ONLINE_CATALOG_BUSINESS_SCOPE_INVALID:{sorted(base_files ^ BUSINESS_FILES)}')
    require(eng_files == ENGINEERING_FILES, f'ONLINE_CATALOG_ENGINEERING_SCOPE_INVALID:{sorted(eng_files ^ ENGINEERING_FILES)}')
    require(digest((Path(repo) / 'scripts/deploy-prod-transfer-cas.py').read_bytes()) == CONTROLLER_HASH,
            'ONLINE_CATALOG_CONTROLLER_CHANGED')
    old = ledger(repo, BASE)
    now = ledger(repo)
    require(len(old) == OLD_COUNT and len(now) == NEW_COUNT, 'ONLINE_CATALOG_LEDGER_COUNT_INVALID')
    require(set(now) - set(old) == {MIGRATION}, 'ONLINE_CATALOG_LEDGER_SCOPE_INVALID')
    require(all(now[name] == value for name, value in old.items()), 'ONLINE_CATALOG_LEDGER_HISTORY_CHANGED')
    require(now[MIGRATION] == SQL_HASH, 'ONLINE_CATALOG_SQL_CHANGED')
    require(git(repo, 'diff', '--check', BASE, release) == '', 'ONLINE_CATALOG_WHITESPACE')
    return {'result': 'IDENTITY_PASS', 'release': release, 'base': BASE, 'business': BUSINESS,
            'migration': MIGRATION, 'sqlHash': SQL_HASH, 'oldLedgerCount': OLD_COUNT, 'newLedgerCount': NEW_COUNT}


def load_contract():
    import importlib.util
    spec = importlib.util.spec_from_file_location('guarded', Path(__file__).with_name('deploy-prod-transfer-cas.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def candidate_name(sha):
    return 'budu-prod-' + sha[:12] + '-golive'


def current_container(remote, module):
    template, active = remote.routes()
    name = module.route_target(template, active)
    require(bool(name), 'ONLINE_CATALOG_ROUTE_TARGET_UNDEFINED')
    return name, template, active


def table_state(remote, module):
    return module.procurement_query(remote, (
        "SELECT coalesce(json_build_object("
        "'categories',to_regclass('online_categories')::text,"
        "'profiles',to_regclass('online_product_profiles')::text),'{}');"))


COUNT_SQL = ("SELECT json_build_object("
             "'users',(SELECT count(*) FROM \"User\"),"
             "'items',(SELECT count(*) FROM \"InventoryItem\"),"
             "'stock',(SELECT count(*) FROM \"StockBalance\"),"
             "'procurementReturns',(SELECT count(*) FROM \"ProcurementReturn\"),"
             "'replenishments',(SELECT count(*) FROM \"ReplenishmentOrder\"));")


def data_counts(remote, module):
    return module.procurement_query(remote, COUNT_SQL)


def schema_columns(remote, module):
    return module.procurement_query(remote, (
        "SELECT coalesce(json_object_agg(table_name||'.'||column_name,data_type),'{}') "
        "FROM information_schema.columns WHERE table_schema='public' "
        "AND table_name IN ('online_categories','online_product_profiles');"))


REQUIRED_COLUMNS = {
    'online_categories.id', 'online_categories.name', 'online_categories.sort_order', 'online_categories.is_active',
    'online_product_profiles.id', 'online_product_profiles.inventory_item_id', 'online_product_profiles.mp_id',
    'online_product_profiles.online_category_id', 'online_product_profiles.price_cents',
    'online_product_profiles.status', 'online_product_profiles.publish_state',
}


def backup(remote, module, root):
    user = module.env(remote.inspect(module.PG)).get('POSTGRES_USER', 'postgres')
    path = root + '/pre-migration.dump'
    remote.run(['sh', '-c',
                "mkdir -p %s && docker exec -u postgres %s pg_dump -U %s -d %s -Fc > %s"
                % (root, module.PG, user, module.EXPECTED_DB, path)], timeout=600)
    size = int(remote.run(['stat', '-c', '%s', path]).decode().strip())
    require(size > 0, 'ONLINE_CATALOG_BACKUP_EMPTY')
    sections = int(remote.run(['sh', '-c',
                               "docker exec -i -u postgres %s pg_restore -l < %s | grep -c 'TABLE DATA' || true"
                               % (module.PG, path)]).decode().strip() or '0')
    require(sections > 500, 'ONLINE_CATALOG_BACKUP_UNREADABLE')
    return {'bytes': size, 'tableDataSections': sections, 'path': path}


def migration_sql(value):
    old = json.dumps(value['oldLedger'], sort_keys=True).replace("'", "''")
    return (
        "BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='90s';\n"
        'LOCK TABLE "_prisma_migrations" IN SHARE ROW EXCLUSIVE MODE;\n'
        "DO $oc$ BEGIN\n"
        "IF (SELECT count(*) FROM \"_prisma_migrations\") <> 91\n"
        " OR EXISTS(SELECT 1 FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)\n"
        " OR (SELECT jsonb_object_agg(migration_name,checksum) FROM \"_prisma_migrations\") IS DISTINCT FROM '" + old + "'::jsonb\n"
        " OR to_regclass('online_categories') IS NOT NULL\n"
        " OR to_regclass('online_product_profiles') IS NOT NULL\n"
        "THEN RAISE EXCEPTION 'ONLINE_CATALOG_LEDGER_OR_SCHEMA_CHANGED'; END IF; END $oc$;\n"
        + value['sql'] + "\n"
        "INSERT INTO \"_prisma_migrations\"(id,checksum,migration_name,finished_at,applied_steps_count)\n"
        "VALUES ('" + value['release'][:32] + "','" + SQL_HASH + "','" + MIGRATION + "',clock_timestamp(),1);\n"
        "COMMIT;\n")


def apply_migration(remote, module, value):
    code = r'''import json,subprocess,sys
v=json.load(sys.stdin)
m=json.loads(subprocess.check_output(['docker','inspect',v['pg']]))[0]
e=dict(x.split('=',1) for x in m['Config']['Env'] if '=' in x)
r=subprocess.run(['docker','exec','-i','-e','PGOPTIONS=-c statement_timeout=90000',v['pg'],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',e.get('POSTGRES_USER','postgres'),'-d',v['database']],input=v['sql'].encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE)
print(json.dumps({'returncode':r.returncode,'stderr':r.stderr.decode()[-300:]}))
'''
    out = json.loads(remote.py(code, {'pg': module.PG, 'database': module.EXPECTED_DB,
                                      'sql': migration_sql(value)}, timeout=180))
    require(out['returncode'] == 0, 'ONLINE_CATALOG_MIGRATION_FAILED:' + out.get('stderr', '')[-150:])
    state = module.procurement_query(remote, (
        "SELECT json_build_object("
        "'applied',(SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),"
        "'failed',(SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL),"
        "'rolledBack',(SELECT count(*) FROM _prisma_migrations WHERE rolled_back_at IS NOT NULL),"
        "'ledger',(SELECT json_object_agg(migration_name,checksum) FROM _prisma_migrations "
        "WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL));"))
    require(state['applied'] == NEW_COUNT and state['failed'] == 0 and state['rolledBack'] == 0,
            'ONLINE_CATALOG_LEDGER_INVALID')
    require(state['ledger'] == value['ledger'], 'ONLINE_CATALOG_LEDGER_MISMATCH')
    return state


def create_candidate(remote, module, source, name, release, image):
    env = dict(module.env(source))
    env['GIT_SHA'] = release
    env['BUDU_RUNTIME_MODE'] = 'standby'
    env_path = '/dev/shm/online-catalog-%s.env' % release[:12]
    lines = ''.join('%s=%s\n' % (key, value) for key, value in sorted(env.items()))
    remote.py("import json,os,pathlib,sys;v=json.load(sys.stdin);p=pathlib.Path(v['path']);"
              "fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600);os.write(fd,v['text'].encode());os.close(fd)",
              {'path': env_path, 'text': lines})
    try:
        networks = sorted((source.get('NetworkSettings') or {}).get('Networks') or {})
        require(networks, 'ONLINE_CATALOG_SOURCE_NETWORKS_MISSING')
        primary = next((n for n in ('budu-bj-006-final-restore-20260822-055653z-net', 'budu_default') if n in networks),
                       networks[0])
        args = ['docker', 'create', '--name', name, '--network', primary, '--restart', 'no',
                '--label', 'budu.production-role=golive-candidate',
                '--label', 'org.opencontainers.image.revision=' + release]
        for group in (source.get('HostConfig') or {}).get('GroupAdd') or []:
            args.extend(['--group-add', str(group)])
        for mount in source.get('Mounts') or []:
            require(mount.get('Type') in ('bind', 'volume') and mount.get('Destination'), 'ONLINE_CATALOG_MOUNT_UNSUPPORTED')
            origin = mount.get('Name') if mount['Type'] == 'volume' else mount.get('Source')
            spec = 'type=%s,source=%s,target=%s' % (mount['Type'], origin, mount['Destination'])
            if not mount.get('RW', True):
                spec += ',readonly'
            args.extend(['--mount', spec])
        args.extend(['--env-file', env_path, image])
        created = remote.run(args, timeout=120).decode().strip()
        for extra in networks:
            if extra != primary:
                remote.run(['docker', 'network', 'connect', extra, name], timeout=60)
        remote.run(['docker', 'start', name], timeout=60)
        return created[:12]
    finally:
        remote.run(['rm', '-f', env_path])


def wait_standby(remote, name, release, timeout=120):
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = remote.inspect(name)['State']
        require(state.get('Running'), 'ONLINE_CATALOG_CANDIDATE_EXITED')
        logs = remote.run(['docker', 'logs', '--tail', '120', name]).decode(errors='replace')
        if 'BUDU_RUNTIME_STANDBY_READY' in logs:
            remote.health(name, release)
            return
        time.sleep(2)
    raise Blocked('ONLINE_CATALOG_CANDIDATE_NOT_READY')


def promote(remote, name, release, timeout=90):
    import time
    pid = remote.run(['docker', 'exec', name, 'sh', '-c',
                      "ps -eo pid,args | awk '/node server\\/index.js/ && $2==\"node\" {print $1; exit}'"]).decode().strip()
    require(pid.isdigit(), 'ONLINE_CATALOG_NODE_PID_NOT_FOUND')
    remote.run(['docker', 'exec', name, 'kill', '-USR2', pid])
    deadline = time.time() + timeout
    while time.time() < deadline:
        logs = remote.run(['docker', 'logs', '--tail', '200', name]).decode(errors='replace')
        if 'BUDU_RUNTIME_PROMOTION_COMPLETE' in logs:
            remote.health(name, release)
            return pid
        require('BUDU_RUNTIME_PROMOTION_FAILED' not in logs, 'ONLINE_CATALOG_PROMOTION_FAILED')
        require(remote.inspect(name)['State'].get('Running'), 'ONLINE_CATALOG_CANDIDATE_EXITED')
        time.sleep(1)
    raise Blocked('ONLINE_CATALOG_PROMOTION_TIMEOUT')


def execute(remote, value, archive_stream, module=None):
    m = module or load_contract()
    release = value['release']
    name = candidate_name(release)
    root = '/opt/budu/.rollback-assets/online-catalog-' + release
    result = {}
    stage = 'PREFLIGHT'
    current = template = active = None
    candidate_started = False
    old_stopped = False
    routes_switched = False
    before = None
    try:
        require(remote.run(['test', '!', '-e', root]) == b'', 'ONLINE_CATALOG_ROLLBACK_ROOT_EXISTS')
        current, template, active = current_container(remote, m)
        source = remote.inspect(current)
        require(m.env(source).get('GIT_SHA') == BASE, 'ONLINE_CATALOG_SOURCE_SHA_CHANGED')
        require(source['Config']['Labels'].get(m.REVISION) == BASE, 'ONLINE_CATALOG_SOURCE_LABEL_CHANGED')
        require(source['State']['Running'] and source['State'].get('Health', {}).get('Status') == 'healthy',
                'ONLINE_CATALOG_SOURCE_NOT_HEALTHY')
        db = remote.db()
        require(db['database'] == m.EXPECTED_DB and db['applied'] == OLD_COUNT
                and db['failed'] == 0 and db['rolledBack'] == 0, 'ONLINE_CATALOG_DATABASE_NOT_AT_L91')
        require(table_state(remote, m).get('categories') is None, 'ONLINE_CATALOG_TABLES_ALREADY_EXIST')
        used, available = remote.disk()
        require(available >= MIN_FREE_BYTES, 'ONLINE_CATALOG_DISK_INSUFFICIENT')
        before = data_counts(remote, m)

        stage = 'IMPORT'
        remote.run(['mkdir', '-p', '-m', '700', root])
        import_receipt = m.bg_import(archive_stream, value['art'], root)
        value['art']['loadedDockerImageId'] = m.resolve_loaded_image(remote, value['art'])['Id']

        stage = 'BACKUP'
        backup_receipt = backup(remote, m, root)

        stage = 'MIGRATION'
        migration_state = apply_migration(remote, m, value)
        columns = schema_columns(remote, m)
        require(REQUIRED_COLUMNS <= set(columns), 'ONLINE_CATALOG_SCHEMA_INCOMPLETE')
        require(data_counts(remote, m) == before, 'ONLINE_CATALOG_DATA_CHANGED_DURING_MIGRATION')

        stage = 'CANDIDATE'
        create_candidate(remote, m, source, name, release, value['art']['imageReference'])
        candidate_started = True
        wait_standby(remote, name, release)
        require(remote.inspect(name)['Config']['Labels'].get(m.REVISION) == release,
                'ONLINE_CATALOG_CANDIDATE_LABEL_CHANGED')

        stage = 'PROMOTION'
        pid = promote(remote, name, release)

        stage = 'CUTOVER'
        require(template.count(current) >= 3 and active.count(current) >= 1, 'ONLINE_CATALOG_ROUTE_SHAPE_INVALID')
        m.replace_routes(remote, template.replace(current, name), active.replace(current, name))
        routes_switched = True
        remote.health(name, release, True)

        stage = 'RETIRE_OLD'
        remote.run(['docker', 'stop', '--time', '30', current], timeout=120)
        old_stopped = True
        require(not remote.inspect(current)['State']['Running'], 'ONLINE_CATALOG_OLD_STOP_UNVERIFIED')
        m.write_authority(remote, m.CURRENT_SHA_FILE, release + '\n')
        require(remote.run(['cat', m.CURRENT_SHA_FILE]).decode().strip() == release, 'ONLINE_CATALOG_POINTER_FAILED')
        require(data_counts(remote, m) == before, 'ONLINE_CATALOG_DATA_CHANGED_DURING_CUTOVER')

        result = {'result': 'DEPLOY_COMPLETE', 'releaseSha': release, 'dbApplied': NEW_COUNT, 'dbFailed': 0,
                  'runtimeMode': 'active', 'route': name, 'oldStopped': True, 'nodePid': pid,
                  'backup': backup_receipt, 'importReceipt': import_receipt, 'migration': migration_state,
                  'dataCounts': before, 'schemaColumns': len(columns)}
    except BaseException as error:
        code = str(error) if isinstance(error, (Blocked, m.GateError)) else 'ONLINE_CATALOG_UNKNOWN'
        result = {'result': 'DEPLOY_BLOCKED', 'stage': stage, 'code': code, 'errorType': type(error).__name__}
        try:
            if candidate_started:
                ids = remote.run(['docker', 'ps', '-aq', '--filter', 'name=^/' + name + '$']).decode().strip()
                if ids:
                    remote.run(['docker', 'stop', '--time', '20', name], timeout=60)
            if old_stopped and current:
                remote.run(['docker', 'start', current], timeout=60)
                remote.health(current, BASE)
            if routes_switched and template is not None:
                m.replace_routes(remote, template, active)
            m.write_authority(remote, m.CURRENT_SHA_FILE, BASE + '\n')
            if current:
                remote.health(current, BASE, True)
            result['recovery'] = 'OLD_ACTIVE_RESTORED'
        except BaseException as secondary:
            result['recovery'] = 'UNKNOWN'
            result['secondaryType'] = type(secondary).__name__
    return result


def preflight(remote, module, value):
    name, template, active = current_container(remote, module)
    source = remote.inspect(name)
    require(module.env(source).get('GIT_SHA') == BASE, 'ONLINE_CATALOG_SOURCE_SHA_CHANGED')
    require(source['Config']['Labels'].get(module.REVISION) == BASE, 'ONLINE_CATALOG_SOURCE_LABEL_CHANGED')
    require(source['State']['Running'] and source['State'].get('Health', {}).get('Status') == 'healthy',
            'ONLINE_CATALOG_SOURCE_NOT_HEALTHY')
    db = remote.db()
    require(db['database'] == module.EXPECTED_DB and db['applied'] == OLD_COUNT
            and db['failed'] == 0 and db['rolledBack'] == 0, 'ONLINE_CATALOG_DATABASE_NOT_AT_L91')
    require(table_state(remote, module).get('categories') is None, 'ONLINE_CATALOG_TABLES_ALREADY_EXIST')
    used, available = remote.disk()
    require(available >= MIN_FREE_BYTES, 'ONLINE_CATALOG_DISK_INSUFFICIENT')
    lock = json.loads(remote.py("import json,pathlib; p=pathlib.Path('/run/lock/budu-transfer-cas-release'); print(json.dumps({'present':p.exists(),'symlink':p.is_symlink()}))"))
    require(lock == {'present': False, 'symlink': False}, 'ONLINE_CATALOG_LOCK_PRESENT')
    return {'result': 'PREFLIGHT_PASS', 'sha': value['release'], 'old': BASE, 'sourceContainer': name,
            'dbApplied': OLD_COUNT, 'diskAvailable': available,
            'networks': sorted((source.get('NetworkSettings') or {}).get('Networks') or {}),
            'templateHash': digest(template.encode()), 'activeHash': digest(active.encode())}


def deploy(remote, module, value, archive, authorized):
    require(authorized == value['release'], 'EXACT_RELEASE_AUTHORIZATION_REQUIRED')
    remote_path = '/tmp/online-catalog-%s.tar' % value['release'][:12]
    subprocess.run(['scp', '-q', '-i', str(value['sshKeyPath']), '-o', 'BatchMode=yes',
                    str(archive), '%s:%s' % (module.HOST, remote_path)], check=True)
    value = dict(value, archivePath=remote_path)
    code = bootstrap_source()
    loader = "import json,sys;exec(compile(json.loads(sys.stdin.buffer.readline()),'<budu-online-catalog>','exec'))"
    payload = json.dumps(code).encode() + b'\n' + json.dumps(value).encode() + b'\n'
    out = remote.run(['sudo', '-n', 'python3', '-u', '-c', loader], payload, timeout=1800)
    sys.stdout.buffer.write(out)
    sys.stdout.buffer.flush()
    receipt = json.loads(out.decode().strip().splitlines()[-1])
    require(receipt.get('result') == 'DEPLOY_COMPLETE', 'ONLINE_CATALOG_DEPLOY_NOT_COMPLETE')
    return receipt


def bootstrap_source():
    controller = Path(__file__).with_name('deploy-prod-transfer-cas.py').read_text()
    base = controller.rsplit("\nif __name__ == '__main__':", 1)[0]
    own = Path(__file__).read_text()
    body = own[own.index('BASE ='):own.index('\ndef main():')]
    prefix = ("import argparse,copy,hashlib,json,os,pathlib,re,signal,stat,subprocess,sys,types,tarfile,time\n"
              "from pathlib import Path\n")
    return prefix + "m=types.ModuleType('guarded');exec(compile(" + repr(base) + ",'<guarded>','exec'),m.__dict__)\n" + body + \
        ("\nv=json.loads(sys.stdin.buffer.readline())\n"
         "m.configure_profile('post-transfer',BASE,BUSINESS,v['oldV2Hash'])\n"
         "def interrupted(*_):raise Blocked('ONLINE_CATALOG_INTERRUPTED')\n"
         "for sig in (signal.SIGHUP,signal.SIGTERM,signal.SIGINT):signal.signal(sig,interrupted)\n"
         "with open(v['archivePath'],'rb') as archive:\n"
         "    print(json.dumps(execute(m.LocalRemote(),v,archive,m)),flush=True)\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['identity', 'inspect-artifact', 'preflight', 'deploy'])
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--release-sha', required=True)
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--ssh-key')
    parser.add_argument('--authorize-release-sha')
    args = parser.parse_args()

    value = identity(args.repo, args.release_sha)
    if args.mode == 'identity':
        print(json.dumps(value))
        return
    require(args.archive is not None, 'ARCHIVE_REQUIRED')
    m = load_contract()
    old_v2 = digest(subprocess.check_output(['git', '-C', str(args.repo), 'show', f'{BASE}:server/v2.js']))
    m.configure_profile('post-transfer', BASE, BUSINESS, old_v2)
    art = m.artifact(args.archive, args.release_sha, args.repo)
    value.update({'art': art, 'sql': (args.repo / 'prisma/migrations' / MIGRATION / 'migration.sql').read_text(),
                  'oldLedger': ledger(args.repo, BASE), 'ledger': ledger(args.repo),
                  'oldV2Hash': old_v2,
                  'helper': (args.repo / 'scripts/clone-production-container.py').read_text()})
    if args.mode == 'inspect-artifact':
        print(json.dumps({'result': 'ARTIFACT_IDENTITY_PASS', 'archiveSha256': art['archiveHash'],
                          'archiveBytes': art['archive'], 'release': args.release_sha}))
        return
    require(args.ssh_key is not None, 'SSH_REQUIRED')
    remote = m.Remote(args.ssh_key)
    value['sshKeyPath'] = str(args.ssh_key)
    if args.mode == 'preflight':
        print(json.dumps(preflight(remote, m, value)))
        return
    print(json.dumps(deploy(remote, m, value, args.archive, args.authorize_release_sha)))


if __name__ == '__main__':
    try:
        main()
    except Blocked as error:
        print(json.dumps({'result': 'BLOCKED', 'code': str(error)}))
        raise SystemExit(1)

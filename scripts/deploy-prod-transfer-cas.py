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
import subprocess
import sys
import tarfile
import tempfile
import time
import signal
from urllib.parse import urlsplit, unquote

EXPECTED_OLD_SHA = 'fc57da5a6e6611c66ed1db286336dc0e1752d69c'
RUNTIME_SHA = '8381959e9c1d527c1f14c234338b14d117ae46f5'
RELEASE_BASE = '7ebfcd74ca97aec92a38b8eaa29f11343ca0864a'
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
ALLOWLIST = {
    'scripts/deploy-prod-transfer-cas.sh',
    'scripts/deploy-prod-transfer-cas.py',
    'scripts/test-deploy-prod-transfer-cas.py',
    'docs/checkpoints/2026-09-26-transfer-cas-release.md',
    'scripts/deploy-remote.sh',
    'scripts/release-prod-transfer-cas-ci.sh',
    'scripts/test-transfer-cas-existing-workflow.py',
}
CURRENT_SHA_FILE = '/opt/budu/.current-sha'
HOST_DEFAULTS = {'Memory': 0, 'MemoryReservation': 0, 'MemorySwap': 0, 'MemorySwappiness': None, 'NanoCpus': 0, 'CpuShares': 0, 'CpuPeriod': 0, 'CpuQuota': 0, 'CpusetCpus': '', 'CpusetMems': '', 'PidsLimit': None, 'Ulimits': [], 'ShmSize': 67108864, 'IpcMode': 'private', 'PidMode': '', 'UTSMode': '', 'CgroupnsMode': 'private', 'ExtraHosts': None, 'Dns': None, 'DnsOptions': [], 'DnsSearch': [], 'Devices': [], 'DeviceRequests': None, 'Sysctls': None, 'OomKillDisable': None, 'AutoRemove': False}
GIB = 1024 ** 3
# Admission bounds, not an assertion that an unbuilt image has these sizes.
MAX_ARCHIVE = 768 * 1024 ** 2
MAX_PEAK = 4 * GIB
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

def validate_identity(release, parent, ancestor, files, schema_files, clean):
    require(bool(re.fullmatch('[0-9a-f]{40}', release)) and release != RUNTIME_SHA, 'RELEASE_SHA_INVALID')
    require(parent == RELEASE_BASE and ancestor, 'RELEASE_ANCESTRY_INVALID')
    require(set(files) == ALLOWLIST, 'RELEASE_DIFF_OUTSIDE_ALLOWLIST')
    require(not schema_files, 'SCHEMA_CHANGED')
    require(clean, 'WORKTREE_NOT_CLEAN')

def identity(repo):
    require(Path(__file__).resolve() == (Path(repo)/'scripts/deploy-prod-transfer-cas.py').resolve(), 'RUNNER_REPO_MISMATCH')
    release = git(repo, 'rev-parse', 'HEAD')
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

def validate_loaded_image(image, art):
    require(image['Id'] == art['imageId'] and image['Os'] == 'linux'
            and image['Architecture'] == 'amd64'
            and image['Config'].get('Labels', {}).get(REVISION) == art['release'], 'LOADED_ARTIFACT_MISMATCH')
    require(all(image['Config'].get(k) == art['config'].get(k) for k in IDENTITY_KEYS), 'LOADED_CONFIG_MISMATCH')
    require(0 < image['Size'] <= MAX_PEAK, 'LOADED_IMAGE_SIZE_INVALID')

def disk_budget(used, available, archive, blobs, expanded, largest_layer):
    # containerd import: incoming archive allowance + content blobs + snapshots +
    # one expanded layer of staging + 512 MiB for metadata/runtime/ordinary growth.
    peak = archive + blobs + expanded + largest_layer + RESERVE
    require(0 < archive <= MAX_ARCHIVE and min(blobs, expanded, largest_layer) > 0,
            'ARTIFACT_SIZE_INVALID')
    require(peak <= MAX_PEAK, 'ARTIFACT_PEAK_EXCEEDS_CONTRACT')
    projected = math.ceil(100 * (used + peak) / (used + available))
    minimum = available - peak
    require(projected < 90 and minimum >= 5 * GIB, 'DEPLOYMENT_DISK_UNSAFE')
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
        require(self.total <= MAX_PEAK, 'LAYER_STREAM_TOO_LARGE')
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
        tag = 'budu-api:transfer-cas-' + release[:12]
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
            require(set(repositories) == {'budu-api'} and set(repositories['budu-api']) == {'transfer-cas-'+release[:12]}, 'LEGACY_TAGS_INVALID')
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
                    require(value in exact_tags+['transfer-cas-'+release[:12]], 'OCI_TAG_MISMATCH')
            require(json.loads(read('oci-layout',65536)).get('imageLayoutVersion') == '1.0.0', 'OCI_LAYOUT_INVALID')
            allowed_members.update({'index.json','oci-layout',index_name})
        require({n for n,m in by_name.items() if m.isfile()} <= allowed_members, 'UNREVIEWED_ARCHIVE_CONTENT')
        blobs = sum(m.size for m in members if m.isfile())
        expanded = largest = 0
        file_sizes = {}
        expected_payload = runtime_payload(repo)
        observed_payload = {}
        v2_bytes = None
        for layer_name, expected in zip(layers, diffs):
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
                    require(count <= MAX_MEMBERS and physical <= 2 * GIB, 'LAYER_EXPANSION_TOO_LARGE')
                    require(not member.issparse(), 'SPARSE_LAYER_UNSUPPORTED')
                    if member.issym() and any(k.startswith(name+'/') for k in expected_payload):
                        raise GateError('RUNTIME_PARENT_SYMLINK_UNSUPPORTED')
                    basename = name.rsplit('/',1)[-1]
                    if basename.startswith('.wh.'):
                        parent = name.rsplit('/',1)[0]+'/' if '/' in name else ''
                        affected = parent if basename == '.wh..wh..opq' else parent+basename[4:]
                        require(not any(k == affected or k.startswith(affected if affected.endswith('/') else affected+'/') for k in expected_payload), 'RUNTIME_WHITEOUT_UNSUPPORTED')
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
        require(v2_bytes is not None and v2_bytes == digest((Path(repo) / 'server/v2.js').read_bytes()),
                'ARTIFACT_BUSINESS_CODE_MISMATCH')
        require(observed_payload == expected_payload, 'ARTIFACT_RUNTIME_PAYLOAD_MISMATCH')
        return dict(archive=size, blobs=blobs, expanded=expanded, largest=largest,
                    archiveHash=archive_hash, imageId='sha256:' + digest(config_bytes),
                    config=config['config'], release=release, runtimeHash=v2_bytes)

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
        return json.loads(self.run(['docker', 'image' if image else 'container', 'inspect', name]))[0]
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
SELECT json_build_object('database',current_database(),'applied',(SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),'failed',(SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL),'ledger',(SELECT json_object_agg(migration_name,checksum) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),'clients',(SELECT coalesce(json_agg(distinct coalesce(host(client_addr),'LOCAL_SOCKET')),'[]') FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()));
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

def writer_check(containers, database, expected_names):
    names = []
    for c in containers:
        url = env(c).get('DATABASE_URL', '')
        if url and unquote(urlsplit(url).path).strip('/') == EXPECTED_DB:
            # Conservative: count all same-name DB connections, regardless of URL
            # spelling/query parameters/read-only flags. Unknown aliases fail closed.
            names.append(c['Name'].lstrip('/'))
    require(sorted(names) == sorted(expected_names), 'WRITER_COUNT_INVALID')
    ips = {v['IPAddress'] for c in containers if c['Name'].lstrip('/') in expected_names
           for v in c['NetworkSettings']['Networks'].values() if v.get('IPAddress')}
    require(set(database['clients']) <= ips, 'UNKNOWN_DB_CLIENT_OR_OLD_WRITER')

def validate_database(db, ledger):
    require(db['database'] == EXPECTED_DB, 'DATABASE_AUTHORITY_MISMATCH')
    require(db['applied'] == EXPECTED_MIGRATIONS and db['failed'] == 0, 'MIGRATION_LEDGER_INVALID')
    require(db['ledger'] == ledger, 'MIGRATION_CHECKSUM_MISMATCH')

def route_target(template, active):
    require(template == active, 'NGINX_AUTHORITY_CONFLICT')
    targets = re.findall(r'proxy_pass http://([A-Za-z0-9_.-]+):3000;', template)
    require(len(targets) == 3 and len(set(targets)) == 1, 'PRODUCTION_ROUTE_COUNT_INVALID')
    return targets[0]

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
    require(all(h.get(k) == v for k,v in HOST_DEFAULTS.items()), 'SOURCE_RESOURCE_PROFILE_CHANGED')
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
    validate_database(db, ledger)
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
    require(budget['projectedUsage'] < 90 and budget['projectedAvailable'] >= 5*GIB, 'DEPLOYMENT_DISK_UNSAFE')
    remote.inspect(old['Image'], image=True)  # rollback image exists
    return dict(old=old, name=name, template=template, active=active, budget=budget,
                diskUsed=used, diskAvailable=available, dfHuman=df_h, dockerSystemDf=docker_df)


def runtime_checks(remote, name, runtime_hash):
    current = remote.inspect(name)
    require(current['State']['Running'] and current.get('RestartCount', 0) == 0, 'RUNTIME_CRASH_DETECTED')
    require(remote.run(['docker','exec',name,'sha256sum','/app/server/v2.js']).decode().split()[0] == runtime_hash,
            'LIVE_TRANSFER_CODE_MISMATCH')
    for mount in current['Mounts']:
        if not mount['RW']:
            remote.run(['docker','exec',name,'test','-r',mount['Destination']])
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
    require(all(old['HostConfig'].get(k) == new['HostConfig'].get(k) for k in HOST_DEFAULTS), 'CLONE_RESOURCE_PROFILE_MISMATCH')
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


def rollback(remote, state, ledger):
    # Do not start the previous writer if candidate termination is unproven.
    if state.get('candidate_attempted'):
        current = remote.containers()
        if any(c['Name'].lstrip('/') == state['candidate'] for c in current):
            remote.run(['docker','stop','--time','30',state['candidate']])
        settle_writers(remote, ledger, [])
    if state.get('old_stop_attempted'):
        remote.run(['docker','start',state['name']])
        remote.health(state['name'], EXPECTED_OLD_SHA)
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
    state = None
    def interrupted(*_):
        raise GateError('INTERRUPTED')
    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, interrupted)
    try:
        state = preflight(remote, art, ledger, imported=True)
        require(state['old']['Id'] == expected_id and digest(state['template'].encode()) == expected_routes,
                'AUTHORITY_CHANGED_DURING_IMPORT')
        release = art['release']
        name = 'budu-prod-' + release[:12] + '-transfer-cas'
        state['candidate'] = name
        # Fresh route snapshots, not any previous feature's rollback directory.
        root = '/opt/budu/.rollback-assets/transfer-cas-' + release
        remote.py("import json,pathlib,sys,os; v=json.load(sys.stdin); p=pathlib.Path(v['root']); p.mkdir(mode=0o700); os.umask(0o077); (p/'template').write_text(v['template']); (p/'active').write_text(v['active']); (p/'manifest.json').write_text(json.dumps(v['manifest'],sort_keys=True))",
                  {'root':root,'template':state['template'],'active':state['active'],
                   'manifest':{'oldSha':EXPECTED_OLD_SHA,'runtimeSha':RUNTIME_SHA,'releaseSha':release,
                               'oldContainer':state['name'],'oldImage':state['old']['Image'],
                               'candidate':name,'candidateImage':art['imageId'],'templateHash':digest(state['template'].encode()),'migrations':85}})
        require(remote.routes() == (state['template'],state['active']), 'ROUTE_CHANGED_BEFORE_STOP')
        state['old_stop_attempted'] = True
        remote.run(['docker','stop','--time','30',state['name']])
        settle_writers(remote, ledger, [])
        state['candidate_attempted'] = True
        # Existing cloner is sent via stdin; binding comes only from existing env.
        # It is held in tmpfs and removed even on failure. No env values printed.
        payload = {'helper':helper,'old':state['name'],'candidate':name,'image':art['imageId'],
                   'sha':release,'network':state['old']['HostConfig']['NetworkMode']}
        remote.py("import json,sys,subprocess,tempfile,pathlib,os; v=json.load(sys.stdin); c=json.loads(subprocess.check_output(['docker','inspect',v['old']]))[0]; e=dict(x.split('=',1) for x in c['Config']['Env']); f,p=tempfile.mkstemp(dir='/dev/shm'); os.fchmod(f,0o600); os.write(f,json.dumps({'username':e['CUSTOMER_REQUEST_WECOM_RECIPIENT_USERNAME'],'userId':e['CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID']}).encode()); os.close(f)\ntry:\n r=subprocess.run(['python3','-',v['old'],v['candidate'],v['image'],v['sha'],p,v['network'],'preserve','writer'],input=v['helper'].encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE); result=r.returncode\nfinally:\n pathlib.Path(p).unlink()\nraise SystemExit(result)", payload)
        remote.run(['docker','update','--restart','unless-stopped',name])
        clone_parity(state['old'], remote.inspect(name), release)
        settle_writers(remote, ledger, [name])
        remote.health(name, release)
        runtime_checks(remote, name, art['runtimeHash'])
        require(remote.routes() == (state['template'],state['active']), 'ROUTE_CHANGED_BEFORE_CUTOVER')
        new = state['template'].replace('http://' + state['name'] + ':3000', 'http://' + name + ':3000')
        require(new.count('http://' + name + ':3000') == 3, 'CUTOVER_ROUTE_COUNT_INVALID')
        state['routes_touched'] = True
        replace_routes(remote, new, new)
        remote.health(name, release, public=True)
        settle_writers(remote, ledger, [name])
        runtime_checks(remote, name, art['runtimeHash'])
        used, available = remote.disk()
        require(math.ceil(100*used/(used+available)) < 90 and available >= 5*GIB, 'POST_DEPLOY_DISK_UNSAFE')
        state['pointer_touched'] = True
        write_authority(remote,CURRENT_SHA_FILE,release+'\n')
        require(remote.run(['cat',CURRENT_SHA_FILE]).decode().strip() == release, 'SHA_POINTER_WRITE_FAILED')
        print(json.dumps({'result':'DEPLOY_COMPLETE','runtimeSha':RUNTIME_SHA,'releaseSha':release,'rollbackSha':EXPECTED_OLD_SHA,'writer':1,
                          'diskAfterUsed':used,'diskAfterAvailable':available,'transferCodePresent':True}))
    except BaseException:
        # Finish rollback despite a second transport/terminal signal.
        for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, signal.SIG_IGN)
        if state and state.get('old_stop_attempted'):
            try:
                rollback(remote, state, ledger)
            except BaseException:
                raise GateError('ROLLBACK_UNVERIFIED_MANUAL_ATTENTION_REQUIRED') from None
        raise
    finally:
        remote.py('import os; os.rmdir(%r)' % LOCK)


def deploy(remote, repo, path, art, ledger, authorize):
    require(authorize == art['release'], 'EXPLICIT_RELEASE_AUTHORIZATION_REQUIRED')
    state = preflight(remote, art, ledger)
    release = art['release']
    name = 'budu-prod-' + release[:12] + '-transfer-cas'
    remote.py('import os; os.mkdir(%r,0o700)' % LOCK)
    handed_off = False
    import_started = import_complete = False
    try:
        require(not remote.run(['docker','ps','-aq','--filter','name=^/' + name + '$']).strip(), 'CANDIDATE_NAME_EXISTS')
        require(not remote.run(['docker','images','-q','budu-api:transfer-cas-' + release[:12]]).strip(), 'CANDIDATE_TAG_EXISTS')
        with open(path, 'rb') as stream:
            require(file_hash(stream) == art['archiveHash'], 'ARTIFACT_CHANGED')
            stream.seek(0)
            import_started = True
            r = subprocess.run(remote.ssh + [shlex.join(['docker','load'])], stdin=stream,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=240)
            require(r.returncode == 0, 'ARTIFACT_LOAD_FAILED')
            import_complete = True
        image = remote.inspect(art['imageId'], image=True)
        validate_loaded_image(image, art)
        # Record post-import storage before any writer is stopped; no raw
        # environment or credential-bearing inspect output is printed.
        used, available = remote.disk()
        print(json.dumps({'stage':'POST_IMPORT_DISK','used':used,'available':available,
                          'dfHuman':remote.run(['df','-h','/']).decode(),
                          'dockerSystemDf':remote.run(['docker','system','df']).decode()}), flush=True)
        payload = {'art':art,'ledger':ledger,
                   'helper':(Path(repo)/'scripts/clone-production-container.py').read_text(),
                   'oldId':state['old']['Id'],'routeHash':digest(state['template'].encode())}
        # Entire cutover/rollback runs in one remote process, no source/env file is
        # copied to production. Only the allowlisted summary is returned.
        code = Path(__file__).read_text().rsplit("\nif __name__ == '__main__':", 1)[0]
        code += "\nv=json.load(sys.stdin)\nexecute_loaded(LocalRemote(),v['art'],v['ledger'],v['helper'],v['oldId'],v['routeHash'])\n"
        handed_off = True
        result = remote.py(code, payload, timeout=480)
        print(result.decode().strip())
    finally:
        # A transport failure after handoff is UNKNOWN, never start the old writer
        # from this process while the remote transaction might still be running.
        # Leave lock on an uncertain stream/import; a second load could double
        # the disk peak while the first daemon import is still completing.
        if not handed_off and (not import_started or import_complete):
            remote.py('import os; os.rmdir(%r)' % LOCK)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode', choices=['identity','inspect-artifact','preflight','deploy'])
    p.add_argument('--repo', type=Path, required=True)
    p.add_argument('--archive', type=Path)
    p.add_argument('--ssh-key', type=Path)
    p.add_argument('--authorize-release-sha')
    args = p.parse_args()
    release, ledger = identity(args.repo)
    if args.mode == 'identity':
        print(json.dumps({'result':'IDENTITY_PASS','releaseSha':release,'runtimeSha':RUNTIME_SHA}))
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
    summary = {'releaseSha':release,'businessRuntimeSha':RUNTIME_SHA,'rollbackSha':EXPECTED_OLD_SHA,
               'artifact':{k:art[k] for k in ['archive','blobs','expanded','largest','imageId','archiveHash']},
               'migrationRequired':MIGRATION_REQUIRED}
    if args.mode == 'inspect-artifact':
        # Offline validation still rejects artifacts over the absolute peak cap.
        summary['budget'] = disk_budget(0,100*GIB,art['archive'],art['blobs'],art['expanded'],art['largest'])
    else:
        require(args.ssh_key is not None, 'SSH_KEY_REQUIRED')
        remote = Remote(args.ssh_key)
        state = preflight(remote,art,ledger)
        summary['budget'] = state['budget']
        summary['diskBefore'] = {'used':state['diskUsed'],'available':state['diskAvailable']}
        summary['dfHuman'] = state['dfHuman']
        summary['dockerSystemDf'] = state['dockerSystemDf']
    summary['result'] = 'PREFLIGHT_PASS'
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

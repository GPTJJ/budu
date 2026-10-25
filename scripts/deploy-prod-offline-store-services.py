#!/usr/bin/env python3
"""Exact frozen OCI / additive L90->L91 profile over the existing BG primitives.

identity/plan/preflight are non-mutating. Production execution requires the
exact plan and engineering bundle authorization arguments, never inferred from
a successful TEST or push. Secret values stay in process memory.
"""
import argparse
import copy
import datetime
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shlex
import signal
import stat
import subprocess
import sys
import tarfile

CONTRACT_HASH = 'df03b47067df795324c832f52f44d85c6669dd3771a06bba418326db2bfdd4b0'
CORE_EXPECTED_SHA256 = 'e4206fa68019770ef82a8a37c3359c75164d18a749f555f0e844c6eeada02e03'
ENGINEERING_FILES = {
    'scripts/deploy-prod-offline-store-services.py',
    'scripts/offline-store-service-release-contract.json',
    'scripts/test-offline-store-service-release.py',
}
SCHEMA91_NEW_SHAPE_SHA256 = '352280e6aa74049e45a13e6b9ccceec5baf2e5d29d647de23749bb05725d9bc3'  # Exact PG16.14 L90->L91 catalog rehearsal.


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def core():
    if 'BUNDLED_CORE' in globals():
        return BUNDLED_CORE
    path = Path(__file__).with_name('deploy-prod-transfer-cas.py')
    if sha(path.read_bytes()) != CORE_EXPECTED_SHA256:
        raise RuntimeError('OFFLINE_EXISTING_CORE_CHANGED_BEFORE_IMPORT')
    spec = importlib.util.spec_from_file_location('offline_frozen_bg_core', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


m = core()
require = m.require


def contract():
    data = (BUNDLED_CONTRACT_BYTES if 'BUNDLED_CONTRACT_BYTES' in globals()
            else Path(__file__).with_name('offline-store-service-release-contract.json').read_bytes())
    require(sha(data) == CONTRACT_HASH, 'OFFLINE_CONTRACT_CHANGED')
    c = json.loads(data)
    require(c['sourceSha'] == 'e91561238b866284bb6621a57fc02926fba01ec8'
            and c['productionBaselineSha'] == 'a86e1507a91b0c79140d962aad3b5c5ea4782497'
            and c['ociManifest'] == 'sha256:6704d3a8f8657c4aac6cf711651f8c430403179b72537fd425b108b56023cb05',
            'OFFLINE_FROZEN_IDENTITY_CHANGED')
    require(c['guardrails'] == {
        'minAvailableBytes': m.MIN_PROJECTED_AVAILABLE,
        'maxUsagePercent': m.MAX_PROJECTED_USAGE,
        'absoluteMaxAdditionalPeakBytes': m.ABSOLUTE_MAX_PEAK,
        'ordinaryReserveBytes': m.RESERVE, 'maxArchiveBytes': m.MAX_ARCHIVE,
    } and m.CAPACITY_WAIVER is None, 'OFFLINE_GUARDRAILS_CHANGED')
    return c


def identity(repo):
    c = contract()
    require(sha((repo / 'scripts/deploy-prod-transfer-cas.py').read_bytes()) == c['baseControllerSha256']
            and sha((repo / 'scripts/clone-production-container.py').read_bytes()) == c['cloneHelperSha256'],
            'OFFLINE_EXISTING_PRIMITIVE_CHANGED')
    require(m.git(repo, 'branch', '--show-current') == 'codex/offline-to-mini-001', 'OFFLINE_BRANCH_CHANGED')
    require(m.is_ancestor(repo, c['sourceSha'], m.git(repo, 'rev-parse', 'HEAD')), 'OFFLINE_SOURCE_LINEAGE_CHANGED')
    changes = m.git(repo, 'diff', '--name-only', c['sourceSha'], '--').splitlines()
    require(all(p.startswith('docs/') or p in ENGINEERING_FILES for p in changes), 'OFFLINE_RUNTIME_SOURCE_CHANGED')
    old = {}
    for path in m.git(repo, 'ls-tree', '-r', '--name-only', c['productionBaselineSha'], 'prisma/migrations').splitlines():
        if path.endswith('/migration.sql'):
            old[Path(path).parent.name] = sha(m.command(['git', '-C', str(repo), 'show', c['productionBaselineSha'] + ':' + path]))
    current = {p.parent.name: sha(p.read_bytes()) for p in (repo / 'prisma/migrations').glob('*/migration.sql')}
    require(old == c['beforeLedger'] and len(old) == 90 and current == c['afterLedger']
            and current == {**old, c['migration']: c['migrationSqlSha256']}, 'OFFLINE_LEDGER_SOURCE_CHANGED')
    require(sha(canonical(c['sourcePayloadFiles'])) == c['sourcePayloadTreeSha256'], 'OFFLINE_PAYLOAD_CONTRACT_CHANGED')
    return {'release': c['sourceSha'], 'engineeringHead': m.git(repo, 'rev-parse', 'HEAD'),
            'oldLedger': old, 'ledger': current,
            'sql': (repo / 'prisma/migrations' / c['migration'] / 'migration.sql').read_text(),
            'helper': (repo / 'scripts/clone-production-container.py').read_text()}


def artifact(path):
    """Bind the previously independently inspected immutable archive, not a tag.

    Full archive SHA fixes every payload byte. OCI/config/descriptors and the
    reviewed physical extent metrics are bound again to the frozen contract.
    No layer is extracted and no source/image is rebuilt.
    """
    c = contract()
    require(path.is_file() and not path.is_symlink() and path.stat().st_size == c['archiveBytes']
            and 0 < c['archiveBytes'] <= m.MAX_ARCHIVE, 'OFFLINE_ARCHIVE_SIZE_CHANGED')
    with path.open('rb') as src:
        require(m.file_hash(src) == c['archiveSha256'], 'OFFLINE_ARCHIVE_HASH_CHANGED')
    with tarfile.open(path, 'r:') as archive:
        members = archive.getmembers()
        require(len(members) <= m.MAX_MEMBERS, 'OFFLINE_ARCHIVE_MEMBERS')
        names = {}
        for member in members:
            name = m.safe_name(member.name)
            require(name not in names and (member.isfile() or member.isdir()), 'OFFLINE_ARCHIVE_MEMBER_INVALID')
            names[name] = member
        def read(name):
            require(name in names and names[name].isfile() and names[name].size <= 4 * 1024**2,
                    'OFFLINE_ARCHIVE_METADATA_INVALID')
            return archive.extractfile(names[name]).read()
        index = json.loads(read('index.json'))
        require(len(index['manifests']) == 1 and index['manifests'][0]['digest'] == c['ociManifest'], 'OFFLINE_OCI_CHANGED')
        manifest_path = 'blobs/sha256/' + c['ociManifest'].split(':')[1]
        encoded = read(manifest_path)
        require('sha256:' + sha(encoded) == c['ociManifest'], 'OFFLINE_OCI_HASH_CHANGED')
        manifest = json.loads(encoded)
        config_path = 'blobs/sha256/' + c['ociConfig'].split(':')[1]
        config_bytes = read(config_path)
        require('sha256:' + sha(config_bytes) == c['ociConfig'] and manifest['config']['digest'] == c['ociConfig'],
                'OFFLINE_CONFIG_CHANGED')
        config = json.loads(config_bytes)
        require(config['architecture'] == 'amd64' and config['os'] == 'linux'
                and config['config']['Labels'][m.REVISION] == c['sourceSha'], 'OFFLINE_PLATFORM_OR_REVISION')
        layers = c['layers']
        require([x['digest'] for x in manifest['layers']] == [x['contentDigest'] for x in layers]
                and config['rootfs']['diff_ids'] == [x['diffId'] for x in layers], 'OFFLINE_LAYER_IDENTITY_CHANGED')
        docker_manifest = json.loads(read('manifest.json'))
        require(len(docker_manifest) == 1 and docker_manifest[0]['Config'] == config_path
                and docker_manifest[0]['RepoTags'] in [[c['imageReference']], ['docker.io/library/' + c['imageReference']]]
                and docker_manifest[0]['Layers'] == ['blobs/sha256/' + x['contentDigest'].split(':')[1] for x in layers],
                'OFFLINE_DOCKER_MANIFEST_CHANGED')
        allowed = {'index.json', 'oci-layout', 'manifest.json', config_path, manifest_path, *docker_manifest[0]['Layers']}
        require({k for k, v in names.items() if v.isfile()} <= allowed, 'OFFLINE_EXTRA_ARCHIVE_CONTENT')
        for layer in layers:
            require(names['blobs/sha256/' + layer['contentDigest'].split(':')[1]].size == layer['blobBytes'],
                    'OFFLINE_LAYER_SIZE_CHANGED')
    return {'release': c['sourceSha'], 'imageReference': c['imageReference'],
            'archive': c['archiveBytes'], 'archiveHash': c['archiveSha256'],
            'archiveConfigDigest': c['ociConfig'], 'rootfsDiffIds': [x['diffId'] for x in c['layers']],
            'config': config['config'], 'blobs': c['blobBytes'], 'expanded': c['expandedPhysicalBytes'],
            'layers': c['layers'], 'runtimeHash': c['sourcePayloadFiles']['server/v2.js'],
            'capacityProfile': 'OFFLINE_STORE_SERVICE_90_TO_91_V1'}


def validate_sharing(s, proof):
    c = contract()
    version_lines=s.get('containerdVersionLines',[])
    require('Server:' in version_lines,'OFFLINE_CONTAINERD_SERVER_VERSION_UNKNOWN')
    server_tail=version_lines[version_lines.index('Server:')+1:]
    versions=[x.split(':',1)[1].strip().lstrip('v') for x in server_tail if x.strip().startswith('Version:')]
    require(versions==['2.2.1'] and s.get('dockerServerVersion')=='29.1.3' and s.get('driver')=='overlayfs'
            and s.get('containerdServerBinarySha256')=='69c4c734aba514436e60deae20f043dbbe7e215b0f4882b8fc3ead9529704990'
            and s.get('backendBinaryIdentitySource')=='UNIX_SOCKET_PEERCRED_PROC_EXE', 'OFFLINE_VALIDATED_STORAGE_BACKEND_CHANGED')
    require(s.get('status') == 'PASS_READONLY_LIVE_ROOTFS_COMMITTED_AND_HASHED_CONTENT'
            and s.get('imageId') == proof['imageId'] and s.get('liveContainerId') == proof['containerId']
            and s.get('activeIngest') == s.get('unknownSnapshots') == 0
            and s.get('newProofContainerCreated') is False and s.get('nonImageInitSnapshotsCredited') is False,
            'OFFLINE_SHARED_INPUT_UNVERIFIED')
    closure = s['actualLiveParentClosure']
    require(closure and closure[0]['Name'] == proof['containerId'] and closure[0]['Kind'] == 'Active'
            and all(x['Kind'] == 'Committed' for x in closure[1:])
            and all(x.get('Parent', '') == closure[i+1]['Name'] for i, x in enumerate(closure[:-1]))
            and not closure[-1].get('Parent'), 'OFFLINE_LIVE_PARENT_CLOSURE_INVALID')
    chain_nodes = {x['Name']: x for x in closure}
    seen = set(); blobs = snapshots = 0
    rows = s['layers']
    require(len(rows) == s['sharedPrefixLayers'] and 0 < len(rows) < len(c['layers']), 'OFFLINE_SHARED_PREFIX_INVALID')
    for i, row in enumerate(rows):
        expected = c['layers'][i]
        require(row['index'] == i and all(row[k] == expected[k] for k in ['chainId', 'diffId', 'contentDigest'])
                and row['chainId'] in chain_nodes and row['chainId'] not in seen
                and row['snapshotKind'] == 'Committed' and row['parent'] == chain_nodes[row['chainId']].get('Parent', '')
                and row['blobStatus'] == 'HASH_STAT_AND_CONTENT_REF_VERIFIED', 'OFFLINE_SHARED_LAYER_INVALID')
        seen.add(row['chainId'])
        require(row['snapshotCreditBytes'] == min(row['snapshotAllocatedBytes'], expected['expandedPhysicalBytes'])
                and row['blobCreditBytes'] == min(row['blobAllocatedBytes'], expected['blobBytes'])
                and min(row['snapshotCreditBytes'], row['blobCreditBytes']) > 0, 'OFFLINE_SHARED_CREDIT_INVALID')
        blobs += row['blobCreditBytes']; snapshots += row['snapshotCreditBytes']
    require((blobs, snapshots, blobs + snapshots) ==
            (s['blobCreditBytes'], s['snapshotCreditBytes'], s['totalCreditBytes']), 'OFFLINE_SHARED_TOTAL_INVALID')
    return blobs + snapshots


def capacity_plan(sharing, proof, db):
    c = contract(); credit = validate_sharing(sharing, proof)
    limits = m.shipping_resources(db)
    unique = c['layers'][sharing['sharedPrefixLayers']:]
    # Even a matching content blob may use an ingest temporary during load.
    # Charge the larger of unique-layer expansion and largest shared blob;
    # never remove this allowance merely because labels/parents match.
    transient = max(max(x['expandedPhysicalBytes'] for x in unique),
                    max(x['blobBytes'] for x in c['layers'][:sharing['sharedPrefixLayers']]))
    retained = c['blobBytes'] + c['expandedPhysicalBytes'] - credit
    return {'version': c['version'], 'release': c['sourceSha'], 'archiveHash': c['archiveSha256'],
            'dbBytes': db['dbBytes'], 'pgVersion': db['pgVersion'], 'limits': limits,
            'sharedCreditBytes': credit, 'transientImportBytes': transient,
            'import': c['archiveBytes'] + retained + transient + m.RESERVE + limits['walLimit'],
            'database': retained + m.RESERVE + sum(limits.values()),
            'retainedArchiveDatabase': c['archiveBytes'] + retained + m.RESERVE + sum(limits.values()),
            'archiveReleaseRequiredBeforeDatabase': True, 'existingAssetDeletionCredit': 0}


def migration_script(v):
    c = contract()
    require(sha(v['sql'].encode()) == c['migrationSqlSha256'] and v['oldLedger'] == c['beforeLedger']
            and v['ledger'] == c['afterLedger'], 'OFFLINE_SQL_CONTRACT_CHANGED')
    old = json.dumps(v['oldLedger'], sort_keys=True).replace("'", "''")
    guard = '''BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s';
LOCK TABLE "_prisma_migrations" IN SHARE ROW EXCLUSIVE MODE;
DO $offline_store$ BEGIN
 IF current_database()<>'budu_bj006' OR
  (SELECT count(*) FROM "_prisma_migrations")<>90 OR
  EXISTS(SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) OR
  (SELECT jsonb_object_agg(migration_name,checksum) FROM "_prisma_migrations") IS DISTINCT FROM 'LEDGER'::jsonb OR
  to_regclass('public.store_service_audits') IS NOT NULL OR
  to_regclass('public.store_service_deliveries') IS NOT NULL OR
  to_regclass('public.store_service_visits') IS NOT NULL OR
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND ((table_name='customer_service_requests' AND column_name='customer_user_id') OR
         (table_name='customer_service_request_tokens' AND column_name='mini_scene_hash')))
  OR (SELECT count(*) FROM customer_service_requests)>100000
  OR (SELECT count(*) FROM customer_service_request_tokens)>100000
  OR EXISTS(SELECT 1 FROM customer_service_requests WHERE octet_length(id)>512)
  OR pg_total_relation_size('customer_service_requests')+pg_total_relation_size('customer_service_request_tokens')>67108864
 THEN RAISE EXCEPTION 'OFFLINE_LEDGER_OR_SCHEMA_CHANGED'; END IF;
END $offline_store$;
'''.replace('LEDGER', old)
    return guard + v['sql'] + f'''\nINSERT INTO "_prisma_migrations"
(id,checksum,migration_name,finished_at,applied_steps_count)
VALUES ('{c['sourceSha'][:32]}','{c['migrationSqlSha256']}','{c['migration']}',clock_timestamp(),1);
COMMIT;\n'''


def database(remote, v, phase):
    c = contract(); db = remote.db()
    expected = c['beforeLedger'] if phase == 90 else c['afterLedger']
    require(phase in (90, 91) and db['database'] == c['database'] and db['pgVersion'] == c['postgresVersion']
            and db['applied'] == phase and db['failed'] == db.get('rolledBack') == 0
            and db['ledger'] == expected, 'OFFLINE_DATABASE_OR_LEDGER_CHANGED')
    require(db.get('check')=={'validated':True,'definition':m.SHIPPING_CHECK_NEW}
            and db.get('invalidFacts')==0,'OFFLINE_EXISTING_TRANSFER_PROTECTION_CHANGED')
    code = """import json,subprocess
v=json.load(__import__('sys').stdin);x=json.loads(subprocess.check_output(['docker','inspect',v['pg']]))[0]
e=dict(y.split('=',1) for y in x['Config']['Env'] if '=' in y)
s=\"BEGIN READ ONLY; SELECT json_build_object('tables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('store_service_audits','store_service_deliveries','store_service_visits')),'columns',(SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='customer_service_requests' AND column_name IN ('customer_user_id','customer_app_id','customer_env_id','customer_open_id','subscription_choice','subscription_template_id','receipt_confirmed_at','receipt_confirmed_by','shipment_confirmed_at','shipment_confirmed_by','carrier','tracking_no','delivery_proof','shipment_version')),'tokenColumn',(SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='customer_service_request_tokens' AND column_name='mini_scene_hash')); COMMIT;\"
p=subprocess.run(['docker','exec','-i','-e','PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=8000',v['pg'],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',e.get('POSTGRES_USER','postgres'),'-d',v['database']],input=s.encode(),capture_output=True,timeout=15)
assert p.returncode==0;print(p.stdout.decode().strip())
"""
    shape = json.loads(remote.py(code, {'pg': m.PG, 'database': c['database']}))
    require(shape == ({'tables': 0, 'columns': 0, 'tokenColumn': 0} if phase == 90 else
                      {'tables': 3, 'columns': 14, 'tokenColumn': 1}), 'OFFLINE_SCHEMA_PHASE_CHANGED')
    catalog=m.bg_script(remote,CATALOG_CODE,{'pg':m.PG,'database':c['database']})
    require(catalog['pgAuthority']==v['proof']['pgAuthority'],'OFFLINE_POSTGRES_AUTHORITY_CHANGED')
    require(catalog['legacyProjectionSha256']==v['proof']['schemaCatalog90Sha256'],
            'OFFLINE_EXISTING_FULL_SCHEMA_CHANGED')
    expected_new=sha(canonical({k:[] for k in ['tables','columns','constraints','indexes','triggers']})) if phase==90 else SCHEMA91_NEW_SHAPE_SHA256
    require(bool(expected_new) and catalog['newShapeSha256']==expected_new,'OFFLINE_NEW_SCHEMA_CATALOG_CHANGED')
    if phase==90:
        inputs=catalog['migrationInputBounds']
        require(inputs['requestRows']<=100000 and inputs['tokenRows']<=100000
                and inputs['maxRequestIdBytes']<=512 and inputs['relationsBytes']<=64*1024**2,
                'OFFLINE_MIGRATION_INPUT_BUDGET_EXCEEDED')
    return db


def source_guard(remote, v, running=True):
    p = v['proof']; c = remote.inspect(p['containerId'])
    require(c['Id'] == p['containerId'] and c['Image'] == p['imageId']
            and sha(canonical(c['HostConfig'])) == p['hostConfigHash']
            and sha(canonical(sorted(c['Mounts'], key=lambda x:x['Destination']))) == p['mountsHash']
            and sha(canonical(c['Config']['Labels'])) == p['labelsHash']
            and sha(canonical(m.env(c))) == p['environmentHash'], 'OFFLINE_LIVE_IDENTITY_CHANGED')
    require(m.env(c).get('GIT_SHA')==contract()['productionBaselineSha']
            and c['Config']['Labels'].get(m.REVISION)==contract()['productionBaselineSha'], 'OFFLINE_LIVE_REVISION_CHANGED')
    require(remote.run(['docker','exec',c['Id'],'sha256sum','/app/server/v2.js']).decode().split()[0]==p['runtimeHash'],
            'OFFLINE_LIVE_WRITABLE_SOURCE_CHANGED')
    if running:
        require(c['State']['Running'] and c['State'].get('Health', {}).get('Status') == 'healthy', 'OFFLINE_LIVE_NOT_HEALTHY')
        remote.health(c['Id'], contract()['productionBaselineSha'])
        remote.health(c['Id'], contract()['productionBaselineSha'], True)
        m.application_db_probe(remote, c['Id'], 'OFFLINE_LIVE_APP_DB_UNVERIFIED')
    t, a = remote.routes()
    require(t == a and sha(t.encode()) == p['routeHash']
            and m.route_target(t, a) == p['containerName'], 'OFFLINE_ROUTE_CHANGED')
    require(remote.run(['cat', m.CURRENT_SHA_FILE]).decode().strip() == contract()['productionBaselineSha'], 'OFFLINE_POINTER_CHANGED')
    return c


def writer(remote, v, state, expected, standby=None):
    rows = remote.containers(); db = database(remote, v, state['phase'])
    if standby:
        readonly = m.bg_lifecycle(remote, v, standby, 'standby')
        require(readonly['Name'].lstrip('/') not in expected
                and sum(x['Id']==readonly['Id'] for x in rows)==1, 'OFFLINE_STANDBY_ALREADY_WRITER')
        rows=[x for x in rows if x['Id']!=readonly['Id']]
    # Preserve the original guard: exclude the proven standby only from the
    # container classification, never grant its IP persistent DB-client access.
    # All application probes are short-lived Prisma processes that disconnect.
    require(len(expected) <= 1, 'OFFLINE_WRITER_COUNT_CHANGED')
    m.writer_check(rows, db, expected)
    return db


def capacity(remote, v, state, future):
    used, available = remote.disk()
    cap = state['capacityLedger']; cap['phase'] = state['stage']
    require(cap['plan'] == v['capacityPlan'], 'OFFLINE_PHASE_PLAN_CHANGED')
    return m.b1_capacity_gate(cap, used, available, future, planned=max(v['capacityPlan']['import'], v['capacityPlan']['database']))


def runtime_probe(remote, v, state):
    c = contract()
    pg=remote.inspect(m.PG)
    ips=sorted({x['IPAddress'] for x in pg['NetworkSettings']['Networks'].values() if x.get('IPAddress')})
    require(ips,'OFFLINE_APP_DATABASE_IP_UNVERIFIED')
    code = """const fs=require('fs'),crypto=require('crypto');const v=JSON.parse(fs.readFileSync(0,'utf8'));
for(const [path,hash] of Object.entries(v.files)){const p='/app/'+path;const st=fs.lstatSync(p);if(!st.isFile()||crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==hash)process.exit(1)}
const {Prisma,PrismaClient}=require('/app/node_modules/@prisma/client');for(const n of ['StoreServiceAudit','StoreServiceDelivery','StoreServiceVisit'])if(!Prisma.dmmf.datamodel.models.some(x=>x.name===n))process.exit(1);
if(require('/app/node_modules/prisma/package.json').version!=='6.19.3')process.exit(1);
const p=new PrismaClient();(async()=>{try{await p.$transaction(async tx=>{
 await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
 const [id]=await tx.$queryRawUnsafe(\"SELECT current_database() AS db,current_setting('transaction_read_only') AS ro,host(inet_server_addr()) AS ip,inet_server_port() AS port\");
 if(id.db!=='budu_bj006'||id.ro!=='on'||!v.ips.includes(id.ip)||id.port!==5432)throw Error();
 const rows=await tx.$queryRawUnsafe('SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations ORDER BY migration_name');
 if(rows.length!==Object.keys(v.ledger).length||rows.some(x=>!x.finished_at||x.rolled_back_at||v.ledger[x.migration_name]!==x.checksum))throw Error();
 if(v.phase===91){for(const model of ['storeServiceAudit','storeServiceDelivery','storeServiceVisit'])await tx[model].findFirst({select:{id:true}})}
 },{timeout:20000});process.stdout.write('OFFLINE_FROZEN_RUNTIME_OK\\n')}catch{process.exitCode=1}finally{await p.$disconnect()}})();"""
    payload={'files':c['sourcePayloadFiles'],'ledger':c['beforeLedger'] if state['phase']==90 else c['afterLedger'],
             'phase':state['phase'],'ips':ips}
    require(remote.run(['docker','exec','-i',state['candidate'],'node','-e',code],data=json.dumps(payload).encode(),timeout=45) == b'OFFLINE_FROZEN_RUNTIME_OK\n',
            'OFFLINE_FROZEN_RUNTIME_UNVERIFIED')
    m.application_db_probe(remote, state['candidate'], 'OFFLINE_CANDIDATE_APP_DB_UNVERIFIED')


def clone_standby(remote, v, state, source, name, flags):
    require(not remote.run(['docker','ps','-aq','--filter','name=^/'+name+'$']).strip(), 'OFFLINE_CANDIDATE_EXISTS')
    helper = v['helper']; needle = 'env["GIT_SHA"] = release_sha'
    require(helper.count(needle) == 1 and sha(helper.encode()) == contract()['cloneHelperSha256'], 'OFFLINE_CLONE_HELPER_CHANGED')
    changes = {'BUDU_RUNTIME_MODE': 'standby', **flags}
    helper = helper.replace(needle, needle + '\nenv.update(' + repr(changes) + ')', 1)
    state['candidate'] = name; state['candidateAttempted'] = True
    code = """import json,sys,subprocess,tempfile,pathlib,os
v=json.load(sys.stdin);x=json.loads(subprocess.check_output(['docker','inspect',v['source']]))[0];e=dict(y.split('=',1) for y in x['Config']['Env'] if '=' in y)
fd,p=tempfile.mkstemp(dir='/dev/shm');os.fchmod(fd,0o600);os.write(fd,json.dumps({'username':e['CUSTOMER_REQUEST_WECOM_RECIPIENT_USERNAME'],'userId':e['CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID']}).encode());os.close(fd)
try:
 q=subprocess.run(['python3','-',v['source'],v['name'],v['image'],v['sha'],p,v['network'],'preserve','writer'],input=v['helper'].encode(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);assert q.returncode==0
finally:pathlib.Path(p).unlink()
"""
    remote.py(code, {'source':source['Id'],'name':name,'image':v['art']['imageReference'],
                     'sha':v['release'],'network':source['HostConfig']['NetworkMode'],'helper':helper}, timeout=120)
    remote.run(['docker','update','--restart','unless-stopped',name])
    candidate = remote.inspect(name); m.validate_candidate_image(candidate, v['art'])
    expected = copy.deepcopy(source); e = m.env(expected); e.update(changes)
    expected['Config']['Env'] = [k+'='+x for k,x in e.items()]
    m.clone_parity(expected, candidate, v['release'])
    state['candidateId'] = candidate['Id']; state['lifecycleSince'] = candidate['State']['StartedAt']
    remote.health(name, v['release']); m.bg_lifecycle(remote, v, state, 'standby')
    runtime_probe(remote, v, state)


ARCHIVE_RELEASE_CODE = r'''import hashlib,json,os,pathlib,stat,sys
v=json.load(sys.stdin);root=pathlib.Path(v['root']);p=root/'exact-e.tar'
assert root.resolve()==root and root.name=='offline-to-mini-001-'+v['release'][:12] and root.parent==pathlib.Path('/opt/budu/.rollback-assets')
s=p.lstat();assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o400 and s.st_size==v['archiveBytes']
h=hashlib.sha256()
with p.open('rb') as f:
 for block in iter(lambda:f.read(1024**2),b''):h.update(block)
assert h.hexdigest()==v['archiveHash']
for proc in pathlib.Path('/proc').iterdir():
 if not proc.name.isdigit():continue
 try:
  for fd in (proc/'fd').iterdir():
   try:x=fd.stat()
   except FileNotFoundError:continue
   assert (x.st_dev,x.st_ino)!=(s.st_dev,s.st_ino)
  for line in (proc/'maps').read_text().splitlines():
   cells=line.split();major,minor=[int(x,16) for x in cells[3].split(':')]
   assert (os.makedev(major,minor),int(cells[4]))!=(s.st_dev,s.st_ino)
 except (FileNotFoundError,ProcessLookupError):pass
now=p.lstat();assert (now.st_dev,now.st_ino,now.st_size,now.st_mtime_ns,now.st_ctime_ns)==(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
p.unlink();fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
assert not p.exists() and not p.is_symlink()
print(json.dumps({'result':'PASS','archiveReleased':True,'path':str(p),'inode':s.st_ino,'device':s.st_dev,'allocatedBytes':s.st_blocks*512,'archiveHash':v['archiveHash'],'onlyNewReleaseOwnedArchive':True}))
'''


BACKUP_WATCH_CODE = r'''
def _offline_disk_guard():
 s=os.statvfs(root);used=(s.f_blocks-s.f_bfree)*s.f_frsize;free=s.f_bavail*s.f_frsize
 budget=v['safety'];margin=64*1024**2
 if used+free!=budget['totalBytes']:raise RuntimeError('BG_OFFLINE_FILESYSTEM_CHANGED')
 if free<10*1024**3+margin or 100*(used+margin)>90*(used+free):raise RuntimeError('BG_OFFLINE_DISK_FLOOR')
 if max(0,used-budget['baselineUsed'])+margin>budget['plannedPeak']:raise RuntimeError('BG_OFFLINE_PEAK_LIMIT')
def _offline_wal_guard():
 if pg is None:return
 options='PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=8000 -c application_name='+marker+'_reader'
 q=subprocess.run(['docker','exec','-i','-e',options,v['pg'],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',user,'-d',v['database']],input=b'BEGIN READ ONLY; SELECT coalesce(sum(size),0) FROM pg_ls_waldir(); COMMIT;',stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10)
 if q.returncode:raise RuntimeError('BG_OFFLINE_WAL_UNVERIFIED')
 value=int(q.stdout.decode().strip())
 if value-v['safety']['walBytesBefore']>v['limits']['walLimit']:raise RuntimeError('BG_OFFLINE_WAL_LIMIT')
'''

WAL_READ_CODE = r'''import json,subprocess,sys
v=json.load(sys.stdin);x=json.loads(subprocess.check_output(['docker','inspect',v['pg']]))[0]
e=dict(y.split('=',1) for y in x['Config']['Env'] if '=' in y)
q="BEGIN READ ONLY; SELECT json_build_object('readOnly',current_setting('transaction_read_only')='on','walBytes',(SELECT coalesce(sum(size),0) FROM pg_ls_waldir())); COMMIT;"
p=subprocess.run(['docker','exec','-i','-e','PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=8000',v['pg'],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',e.get('POSTGRES_USER','postgres'),'-d',v['database']],input=q.encode(),capture_output=True,timeout=15)
assert p.returncode==0;print(p.stdout.decode().strip())
'''


CATALOG_CODE = r'''import hashlib,json,subprocess,sys
v=json.load(sys.stdin);p=json.loads(subprocess.check_output(['docker','inspect',v['pg']]))[0]
e=dict(x.split('=',1) for x in p['Config']['Env'] if '=' in x)
q="""BEGIN READ ONLY; SELECT json_build_object(
 'tables',(SELECT coalesce(json_agg(row_to_json(x) ORDER BY x.table_name),'[]') FROM
 (SELECT c.relname AS table_name,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relpersistence,c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')) x),
 'columns',(SELECT coalesce(json_agg(row_to_json(x) ORDER BY x.table_name,x.ordinal_position),'[]') FROM
 (SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default,character_maximum_length,numeric_precision,numeric_scale,datetime_precision FROM information_schema.columns WHERE table_schema='public') x),
 'constraints',(SELECT coalesce(json_agg(row_to_json(x) ORDER BY x.table_name,x.constraint_name),'[]') FROM
 (SELECT t.relname AS table_name,c.conname AS constraint_name,c.contype,c.convalidated,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public') x),
 'indexes',(SELECT coalesce(json_agg(row_to_json(x) ORDER BY x.table_name,x.indexname),'[]') FROM
 (SELECT tablename AS table_name,indexname,indexdef FROM pg_indexes WHERE schemaname='public') x),
 'triggers',(SELECT coalesce(json_agg(row_to_json(x) ORDER BY x.table_name,x.trigger_name),'[]') FROM
 (SELECT c.relname AS table_name,t.tgname AS trigger_name,pg_get_triggerdef(t.oid) AS definition,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal) x),
 'functions',(SELECT coalesce(json_agg(row_to_json(x) ORDER BY x.name,x.arguments),'[]') FROM
 (SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p')) x)); COMMIT;"""
r=subprocess.run(['docker','exec','-i','-e','PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=8000',v['pg'],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',e.get('POSTGRES_USER','postgres'),'-d',v['database']],input=q.encode(),capture_output=True,timeout=15)
assert r.returncode==0;data=json.loads(r.stdout)
newtables={'store_service_audits','store_service_deliveries','store_service_visits'}
newcolumns={'customer_user_id','customer_app_id','customer_env_id','customer_open_id','subscription_choice','subscription_template_id','receipt_confirmed_at','receipt_confirmed_by','shipment_confirmed_at','shipment_confirmed_by','carrier','tracking_no','delivery_proof','shipment_version'}
newindexes={'customer_service_requests_customer_scope_idx','customer_service_request_tokens_mini_scene_hash_key'}
new={k:[] for k in ['tables','columns','constraints','indexes','triggers']};old={k:[] for k in data}
for kind,rows in data.items():
 for row in rows:
  table=row.get('table_name');added=table in newtables
  if kind=='columns':added|=(table=='customer_service_requests' and row['column_name'] in newcolumns) or (table=='customer_service_request_tokens' and row['column_name']=='mini_scene_hash')
  if kind=='indexes':added|=row['indexname'] in newindexes
  if added:
   # Existing old columns retain their ordinal in the old hash. The new
   # addition's logical type/default/constraints are independent of old order.
   entry=dict(row);entry.pop('ordinal_position',None);new[kind].append(entry)
  else:old[kind].append(row)
canonical=lambda x:json.dumps(x,sort_keys=True,separators=(',',':')).encode()
identity_query="BEGIN READ ONLY; SELECT json_build_object('database',current_database(),'databaseOid',(SELECT oid FROM pg_database WHERE datname=current_database()),'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),'serverVersion',current_setting('server_version'),'readOnly',current_setting('transaction_read_only')='on'); COMMIT;"
identity=subprocess.run(['docker','exec','-i','-e','PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=8000',v['pg'],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',e.get('POSTGRES_USER','postgres'),'-d',v['database']],input=identity_query.encode(),capture_output=True,timeout=15)
assert identity.returncode==0;authority=json.loads(identity.stdout);assert authority['readOnly'] and authority['database']==v['database']
authority.update(containerId=p['Id'],imageId=p['Image'],mountsSha256=hashlib.sha256(canonical(sorted(p['Mounts'],key=lambda x:x['Destination']))).hexdigest())
bounds_query="BEGIN READ ONLY; SELECT json_build_object('requestRows',(SELECT count(*) FROM customer_service_requests),'tokenRows',(SELECT count(*) FROM customer_service_request_tokens),'maxRequestIdBytes',(SELECT coalesce(max(octet_length(id)),0) FROM customer_service_requests),'relationsBytes',pg_total_relation_size('customer_service_requests')+pg_total_relation_size('customer_service_request_tokens')); COMMIT;"
bounds=subprocess.run(['docker','exec','-i','-e','PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=8000',v['pg'],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',e.get('POSTGRES_USER','postgres'),'-d',v['database']],input=bounds_query.encode(),capture_output=True,timeout=15)
assert bounds.returncode==0
print(json.dumps({'readOnly':True,'pgAuthority':authority,'migrationInputBounds':json.loads(bounds.stdout),'legacyProjectionSha256':hashlib.sha256(canonical(old)).hexdigest(),'newShapeSha256':hashlib.sha256(canonical(new)).hexdigest(),'newShape':new,'rawLegacyCatalogPrinted':False}))
'''


def bounded_backup_code():
    # Retain the existing snapshot exporter, exact fingerprint, dump/restore
    # bounds, deadlines and verified termination; add active disk/WAL aborts.
    code=m.BG_SNAPSHOT_CODE
    needle='def call(args,input=None,timeout=30,cleanup=False):\n'
    require(code.count(needle)==1,'OFFLINE_BACKUP_PRIMITIVE_CHANGED')
    code=code.replace(needle,needle+'    if not cleanup:_offline_disk_guard();_offline_wal_guard()\n',1)
    needle="def extent():return sum(p.stat().st_blocks*512 for p in data.rglob('*') if p.is_file())"
    require(code.count(needle)==1,'OFFLINE_BACKUP_EXTENT_PRIMITIVE_CHANGED')
    code=code.replace(needle,"def extent():\n    _offline_disk_guard();_offline_wal_guard()\n    return sum(p.stat().st_blocks*512 for p in data.rglob('*') if p.is_file())",1)
    needle='dump_process=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)\n            while True:\n'
    require(code.count(needle)==1,'OFFLINE_BACKUP_STREAM_PRIMITIVE_CHANGED')
    code=code.replace(needle,needle+'                _offline_disk_guard();_offline_wal_guard()\n',1)
    # Function definitions may refer to root/v/pg initialized later. They execute
    # only inside the unchanged backup body, never during import of this module.
    return BACKUP_WATCH_CODE+code


def preflight(remote, v, sharing_reader):
    c = contract(); m.configure_profile('post-transfer', c['productionBaselineSha'], c['sourceSha'], v['proof']['runtimeHash'])
    m.BG_ACTIVE=True
    require(not m.THIN_MODE and m.CAPACITY_WAIVER is None, 'OFFLINE_PROFILE_SCOPE_INVALID')
    g = source_guard(remote, v); db = database(remote, v, 90)
    m.writer_check(remote.containers(), db, [v['proof']['containerName']])
    m.b1_storage(remote); m.mount_readability(remote, g['Id'])
    require(remote.run(['test', '!', '-e', m.LOCK]) == b'', 'OFFLINE_RELEASE_LOCK_PRESENT')
    root = '/opt/budu/.rollback-assets/offline-to-mini-001-' + c['sourceSha'][:12]
    require(remote.run(['test','!','-e',root]) == b'', 'OFFLINE_RELEASE_ROOT_EXISTS')
    sharing = sharing_reader(remote, v)
    plan = capacity_plan(sharing, v['proof'], db)
    require(plan == v['capacityPlan'], 'OFFLINE_APPROVED_CAPACITY_INPUT_CHANGED')
    used, available = remote.disk(); ledger = {'baselineUsed':used,'baselineAvailable':available,'phase':'PREFLIGHT','peak':0,
                                             'plan':copy.deepcopy(plan),'baselineCommitted':sorted(m.b2_committed(remote))}
    m.b1_capacity_gate(ledger, used, available, plan['import'], planned=max(plan['import'],plan['database']))
    return g, ledger, root


def termination_admitted(state):
    if state.get('backupAttempted'):
        b=state.get('backup',{})
        require(all(b.get(k) is True for k in ['backupTerminationVerified','exporterTerminated','dumpTerminated',
                'restoreStopped','restoreProcessTerminated']), 'OFFLINE_BACKUP_TERMINATION_UNKNOWN_NO_WRITER_RECOVERY')
    if state.get('migrationAttempted'):
        require(state.get('migration',{}).get('terminated') is True,
                'OFFLINE_MIGRATOR_TERMINATION_UNKNOWN_NO_WRITER_RECOVERY')


def admit_known_route_pair(template,active,original,next_routes):
    # The existing two-file route replacement is not a DB transaction. Repair
    # only its exact known original/next combinations, never an unknown route.
    require(template in (original,next_routes) and active in (original,next_routes),
            'OFFLINE_RECOVERY_ROUTE_HAS_UNKNOWN_EXTERNAL_CHANGE')
    return next_routes


def recover_technical91(remote,v,state):
    """Before service enablement: restore ordinary flows on the exact L91 image.

    This mode does not advertise store-service recall: runtime is still OFF and
    no new store entrance has been enabled. After service enablement use the
    separate ACTIVE compatible-recall operation with existing valid config.
    """
    termination_admitted(state);database(remote,v,91)
    require(state.get('candidateId'),'OFFLINE_L91_VALIDATED_CANDIDATE_MISSING')
    candidate=remote.inspect(state['candidate']);m.validate_candidate_image(candidate,v['art'])
    require(candidate['Id']==state['candidateId'] and all(m.env(candidate).get(k)==value
            for k,value in contract()['flagsAtTechnicalCutover'].items()),'OFFLINE_L91_TECHNICAL_FLAGS_CHANGED')
    m.bg_owned_stop(remote,v,state);writer(remote,v,{'phase':91},[])
    state['stage']='L91_TECHNICAL_RECOVERY';capacity(remote,v,state,m.RESERVE)
    remote.run(['docker','start',candidate['Id']])
    state['lifecycleSince']=remote.inspect(candidate['Id'])['State']['StartedAt']
    remote.health(state['candidate'],v['release']);m.bg_lifecycle(remote,v,state,'standby')
    runtime_probe(remote,v,state);writer(remote,v,{'phase':91},[],state)
    m.bg_promote(remote,v,state);m.bg_lifecycle(remote,v,state,'active');writer(remote,v,{'phase':91},[state['candidate']])
    t,a=remote.routes();original=v['originalRoutes']
    next_routes=original.replace('http://'+v['proof']['containerName']+':3000','http://'+state['candidate']+':3000')
    admit_known_route_pair(t,a,original,next_routes)
    require(next_routes.count('http://'+state['candidate']+':3000')==3,'OFFLINE_L91_RECOVERY_ROUTE_COUNT_CHANGED')
    pointer=remote.run(['cat',m.CURRENT_SHA_FILE]).decode().strip()
    require(pointer in (contract()['productionBaselineSha'],v['release']),'OFFLINE_L91_RECOVERY_POINTER_CHANGED')
    m.replace_routes(remote,next_routes,next_routes);remote.health(state['candidate'],v['release'],True)
    runtime_probe(remote,v,state);m.write_authority(remote,m.CURRENT_SHA_FILE,v['release']+'\n')
    return 'L91_TECHNICAL_RUNTIME_ACTIVE_NEW_SERVICES_OFF_LOCK_RETAINED'


def execute(remote, v, stream, sharing_reader):
    """One on-host controller; this function is never reached by read-only CLI."""
    state = {'phase':90,'stage':'PREFLIGHT','candidate':'budu-prod-'+v['release'][:12]+'-post-transfer'}
    owned = False; unlock = False; result = {}
    try:
        g, cap, root = preflight(remote, v, sharing_reader)
        state.update(g=g, root=root, capacityLedger=cap)
        v['originalRoutes']=remote.routes()[0]
        receipt = m.bg_script(remote, m.BG_LOCK_CODE, {'path':m.LOCK,'action':'claim','fresh':True,
            'stale':{'present':False,'openReferences':[]},'release':v['release'],'receipt':None}); owned = True
        remote.py("import os,json,pathlib,sys;v=json.load(sys.stdin);os.umask(0o077);p=pathlib.Path(v['root']);p.mkdir(mode=0o700);(p/'manifest.json').write_text(json.dumps(v['manifest'],sort_keys=True))",
                  {'root':root,'manifest':{'release':v['release'],'contractHash':CONTRACT_HASH,'planHash':v['approvedPlanHash']}})
        state['stage']='IMPORT'; imp=m.bg_import(stream,v['art'],root)
        v['art']['loadedDockerImageId']=m.resolve_loaded_image(remote,v['art'])['Id']
        require(v['art']['loadedDockerImageId']==contract()['ociManifest'],'OFFLINE_LOADED_EXACT_OCI_CHANGED')
        require(imp['returncode']==0 and imp['serverSha256BeforeImport'] and imp['serverWaitComplete'], 'OFFLINE_IMPORT_UNKNOWN')
        storage=m.b1_storage(remote);now_committed=m.b2_committed(remote)
        previous=set(cap['baselineCommitted']);expected_new={x['chainId'] for x in contract()['layers']} - previous
        require(previous<=now_committed and now_committed-previous==expected_new
                and storage['activeIngest']==storage['unknownSnapshots']==0,'OFFLINE_POST_IMPORT_STORAGE_UNVERIFIED')
        capacity(remote,v,state,m.RESERVE)
        # The exact fully imported image is retained; only this new staging tar
        # is removable. No rollback image/container/volume/old archive is removed.
        state['stage']='RELEASE_NEW_ARCHIVE'
        released=m.bg_script(remote,ARCHIVE_RELEASE_CODE,{'root':root,'release':v['release'],
            'archiveBytes':v['art']['archive'],'archiveHash':v['art']['archiveHash']},90)
        require(released.get('result')=='PASS' and released.get('archiveReleased') is True, 'OFFLINE_ARCHIVE_RELEASE_UNVERIFIED')
        state['archiveReleased']=released
        # Existing allocations are counted by current used-baseline. Charge only
        # still-future DB resources here; never duplicate retained image bytes.
        capacity(remote,v,state,m.RESERVE+sum(v['capacityPlan']['limits'].values()))
        state['stage']='STANDBY_SOURCE_AND_DB_PROBE'
        clone_standby(remote,v,state,g,state['candidate'],contract()['flagsAtTechnicalCutover'])
        writer(remote,v,state,[v['proof']['containerName']],state)
        # A bounded maintenance window eliminates application writers during
        # snapshot/restore/migration. PG background WAL still has a live budget;
        # max_wal_size is never treated as a physical limit.
        state['stage']='STOP_OLD_WRITER';state['oldStopAttempted']=True
        source_guard(remote,v)
        remote.run(['docker','stop','--time','30',g['Id']]);require(not remote.inspect(g['Id'])['State']['Running'],'OFFLINE_OLD_STOP_UNVERIFIED')
        writer(remote,v,state,[],state)
        state['stage']='SNAPSHOT_BACKUP_AND_ISOLATED_RESTORE'
        wal=m.bg_script(remote,WAL_READ_CODE,{'pg':m.PG,'database':contract()['database']})
        require(wal.get('readOnly') is True and type(wal.get('walBytes')) is int,'OFFLINE_WAL_OBSERVATION_UNVERIFIED')
        state['backupAttempted']=True
        b=m.bg_script(remote,bounded_backup_code(),{'root':root,'pg':m.PG,'database':contract()['database'],
            'limits':v['capacityPlan']['limits'],'release':v['release'],'restore':'budu-bg-restore-'+v['release'][:12],
            'safety':{'baselineUsed':cap['baselineUsed'],'totalBytes':cap['baselineUsed']+cap['baselineAvailable'],
                      'plannedPeak':max(v['capacityPlan']['import'],v['capacityPlan']['database']),'walBytesBefore':wal['walBytes']}})
        state['backup']=b
        require(b.get('result')=='PASS' and all(b.get(k) is True for k in ['backupTerminationVerified','exporterTerminated',
            'dumpTerminated','restoreStopped','restoreProcessTerminated','restoreVerified'])
            and b['sourceSnapshotFingerprint']==b['restoredFingerprint'],'OFFLINE_BACKUP_RESTORE_UNVERIFIED')
        state['backup']=b;writer(remote,v,state,[],state);capacity(remote,v,state,m.RESERVE+v['capacityPlan']['limits']['walLimit']+v['capacityPlan']['limits']['migratorLimit'])
        state['stage']='ATOMIC_L90_TO_L91';state['migrationAttempted']=True
        mig=m.bg_script(remote,MIGRATION_CODE,{'pg':m.PG,'database':contract()['database'],'release':v['release'],
            'transaction':migration_script(v),'root':root,'limits':v['capacityPlan']['limits'],
            'safety':{'baselineUsed':cap['baselineUsed'],'totalBytes':cap['baselineUsed']+cap['baselineAvailable'],
                      'plannedPeak':max(v['capacityPlan']['import'],v['capacityPlan']['database']),'walBytesBefore':wal['walBytes']}},65)
        state['migration']=mig
        require(mig.get('result')=='PASS' and mig.get('terminated') is True,'OFFLINE_MIGRATION_UNKNOWN_STOP_RETAIN_LOCK')
        state['phase']=91;database(remote,v,91);writer(remote,v,state,[],state)
        after_wal=m.bg_script(remote,WAL_READ_CODE,{'pg':m.PG,'database':contract()['database']})
        require(after_wal.get('readOnly') is True and after_wal['walBytes']-wal['walBytes']<=v['capacityPlan']['limits']['walLimit'],
                'OFFLINE_WAL_BUDGET_EXCEEDED_STOP_BEFORE_EXPOSURE')
        capacity(remote,v,state,m.RESERVE)
        state['stage']='PROMOTION';m.bg_promote(remote,v,state);m.bg_lifecycle(remote,v,state,'active')
        writer(remote,v,state,[state['candidate']]);runtime_probe(remote,v,state)
        state['stage']='CUTOVER';t,a=remote.routes();require(sha(t.encode())==v['proof']['routeHash'] and t==a,'OFFLINE_ROUTE_CHANGED')
        routes=t.replace('http://'+v['proof']['containerName']+':3000','http://'+state['candidate']+':3000')
        require(routes.count('http://'+state['candidate']+':3000')==3,'OFFLINE_ROUTE_COUNT_CHANGED')
        m.replace_routes(remote,routes,routes);remote.health(state['candidate'],v['release'],True)
        m.application_db_probe(remote,state['candidate'],'OFFLINE_PUBLIC_APP_DB_UNVERIFIED');writer(remote,v,state,[state['candidate']])
        m.write_authority(remote,m.CURRENT_SHA_FILE,v['release']+'\n');capacity(remote,v,state,m.RESERVE)
        require(not remote.inspect(g['Id'])['State']['Running'] and remote.inspect(g['Image'],image=True)['Id']==g['Image'], 'OFFLINE_OLD_ASSET_CHANGED')
        result={'result':'DEPLOY_COMPLETE','releaseSha':v['release'],'dbApplied':91,'writer':1,
            'globalSendEnabled':False,'newSubmissionsEnabled':False,'serviceRuntimeEnabled':False,
            'backup':b,'migration':mig,'archiveRelease':released,'oldStoppedRetained':True,'capacityLedger':cap}
        saved=m.bg_script(remote,m.BG_EVIDENCE_CODE,{'root':root,'result':result});require(saved.get('result')=='PASS','OFFLINE_EVIDENCE_UNVERIFIED');unlock=True
    except BaseException as error:
        result={'result':'DEPLOY_BLOCKED','stage':state['stage'],'code':str(error) if isinstance(error,m.GateError) else 'OFFLINE_UNKNOWN',
                'errorType':type(error).__name__,'releaseLockRetained':owned,'noDownMigrationOrQueueReset':True}
        # Never downgrade L91 or guess whether an interrupted transaction committed.
        # Only exact L90 permits the legacy runtime recovery below. L91/UNKNOWN
        # keeps the lock and requires the explicit compatible-recall operation.
        if state.get('oldStopAttempted'):
            try:
                termination_admitted(state)
                m.bg_owned_stop(remote,v,state)
                db=remote.db()
                if db.get('ledger')==contract()['beforeLedger'] and db.get('failed')==0 and db.get('rolledBack')==0:
                    writer(remote,v,{'phase':90},[])
                    old=remote.inspect(v['proof']['containerId'])
                    if not old['State']['Running']:remote.run(['docker','start',old['Id']])
                    source_guard(remote,v,running=False)
                    ov=dict(v,art={'release':contract()['productionBaselineSha'],'loadedDockerImageId':old['Image'],'imageReference':old['Config']['Image']})
                    os_= {'candidate':v['proof']['containerName'],'candidateId':old['Id'],'lifecycleSince':remote.inspect(old['Id'])['State']['StartedAt']}
                    m.bg_lifecycle(remote,ov,os_,'standby');m.bg_promote(remote,ov,os_);m.bg_lifecycle(remote,ov,os_,'active')
                    remote.health(old['Id'],contract()['productionBaselineSha'],True)
                    writer(remote,v,{'phase':90},[v['proof']['containerName']])
                    result['recovery']='EXACT_L90_OLD_RUNTIME_RESTORED_LOCK_RETAINED'
                elif db.get('ledger')==contract()['afterLedger'] and db.get('failed')==0 and db.get('rolledBack')==0:
                    state['phase']=91;writer(remote,v,{'phase':91},[])
                    result['recovery']=recover_technical91(remote,v,state)
                else:result['recovery']='UNKNOWN_RETAIN_FACTS_AND_LOCK_NO_WRITER_RECOVERY'
            except BaseException:result['recovery']='RECOVERY_UNVERIFIED_RETAIN_LOCK'
    finally:
        if owned and unlock:
            try:
                m.bg_script(remote,m.BG_LOCK_CODE,{'path':m.LOCK,'action':'release','fresh':True,
                    'stale':{'present':False,'openReferences':[]},'release':v['release'],'receipt':receipt})
                result['releaseLockReleased']=True
            except BaseException:result.update(result='DEPLOY_BLOCKED',code='OFFLINE_LOCK_RELEASE_UNVERIFIED')
    return result


def compatible_recall(remote,v,current,sharing_reader):
    """Separately authorized L91 application recovery, never a DB rollback.

    This is ACTIVE with existing valid gateway config. POST-based own list/detail
    must work; standby would reject them. SUB/QR/SEND off is not all-module RO.
    No stored request/subscription/audit/delivery status is rewritten.
    """
    database(remote,v,91)
    cap=copy.deepcopy(v['recoveryCapacityLedger']);cap['phase']='COMPATIBLE_RECALL_ADMIT'
    require(cap['plan']==v['capacityPlan'],'OFFLINE_RECOVERY_ORIGINAL_PLAN_CHANGED')
    used,available=remote.disk()
    m.b1_capacity_gate(cap,used,available,m.RESERVE+128*1024**2,
                      planned=max(v['capacityPlan']['import'],v['capacityPlan']['database']))
    source=remote.inspect(current['containerId'])
    require(source['Id']==current['containerId'] and source['Image']==v['art']['loadedDockerImageId']
            and source['Config']['Labels'][m.REVISION]==v['release'] and m.env(source)['GIT_SHA']==v['release']
            and sha(canonical(m.env(source)))==current['environmentHash'], 'OFFLINE_COMPAT_SOURCE_CHANGED')
    require(sha(canonical(source['HostConfig']))==current['hostConfigHash']
            and sha(canonical(sorted(source['Mounts'],key=lambda x:x['Destination'])))==current['mountsHash']
            and sha(canonical(source['Config']['Labels']))==current['labelsHash'], 'OFFLINE_COMPAT_RESOURCE_CHANGED')
    require(m.env(source).get('STORE_SERVICE_RUNTIME_ENABLED')=='1', 'OFFLINE_COMPAT_EXISTING_VALID_CONFIG_REQUIRED')
    t,a=remote.routes();require(t==a and m.route_target(t,a)==source['Name'].lstrip('/'),'OFFLINE_COMPAT_ROUTE_CHANGED')
    state={'phase':91,'stage':'COMPATIBLE_RECALL_STANDBY'}
    v['_compatibleState']=state;v['_compatibleOriginalRoutes']=t
    clone_standby(remote,v,state,source,'budu-prod-'+v['release'][:12]+'-service-recall',contract()['compatibleRecallFlags'])
    writer(remote,v,state,[source['Name'].lstrip('/')] if source['State']['Running'] else [],state)
    if source['State']['Running']:remote.run(['docker','stop','--time','30',source['Id']])
    require(not remote.inspect(source['Id'])['State']['Running'],'OFFLINE_COMPAT_OLD_STOP_UNVERIFIED')
    writer(remote,v,state,[],state);m.bg_promote(remote,v,state);m.bg_lifecycle(remote,v,state,'active');writer(remote,v,state,[state['candidate']])
    routes=t.replace('http://'+source['Name'].lstrip('/')+':3000','http://'+state['candidate']+':3000')
    require(routes.count('http://'+state['candidate']+':3000')==3,'OFFLINE_COMPAT_ROUTE_COUNT_CHANGED')
    m.replace_routes(remote,routes,routes);remote.health(state['candidate'],v['release'],True)
    return {'result':'COMPATIBLE_RECALL_ACTIVE','schema':91,'writer':1,'newSubmissionsQrSendEnabled':False,
            'runtimeEnabled':True,'moduleReadOnlyClaimed':False,'factsOrNotificationStatusesRewritten':False,
            'capacityLedger':cap}


def execute_compatible_recall(remote,v):
    # A new, separately bound current-runtime proof is mandatory after service
    # enablement. An uncertain retained release lock is never silently adopted.
    m.configure_profile('post-transfer',v['release'],v['release'],contract()['sourcePayloadFiles']['server/v2.js'])
    m.BG_ACTIVE=True
    require(remote.run(['test','!','-e',m.LOCK])==b'','OFFLINE_RECOVERY_EXISTING_LOCK_REQUIRES_TERMINATION_AUDIT')
    receipt=m.bg_script(remote,m.BG_LOCK_CODE,{'path':m.LOCK,'action':'claim','fresh':True,
        'stale':{'present':False,'openReferences':[]},'release':v['release'],'receipt':None})
    try:
        v['art']['loadedDockerImageId']=m.resolve_loaded_image(remote,v['art'])['Id']
        require(v['art']['loadedDockerImageId']==contract()['ociManifest'],'OFFLINE_RECOVERY_EXACT_OCI_CHANGED')
        result=compatible_recall(remote,v,v['proof'],sharing_reader)
        used,available=remote.disk();cap=result['capacityLedger'];cap['phase']='COMPATIBLE_RECALL_FINAL'
        m.b1_capacity_gate(cap,used,available,m.RESERVE,
                          planned=max(v['capacityPlan']['import'],v['capacityPlan']['database']))
        m.bg_script(remote,m.BG_LOCK_CODE,{'path':m.LOCK,'action':'release','fresh':True,
            'stale':{'present':False,'openReferences':[]},'release':v['release'],'receipt':receipt})
        result['releaseLockReleased']=True
        return result
    except BaseException as error:
        result={'result':'COMPATIBLE_RECALL_BLOCKED','code':str(error) if isinstance(error,m.GateError) else 'OFFLINE_RECOVERY_UNKNOWN',
                'lockRetained':True,'noLegacyDowngradeOrQueueReset':True}
        state=v.get('_compatibleState',{})
        try:
            require(state.get('candidateId') and not remote.inspect(v['proof']['containerId'])['State']['Running'],
                    'OFFLINE_COMPAT_RECOVERY_SOURCE_NOT_QUIESCED')
            m.bg_lifecycle(remote,v,state,'active');runtime_probe(remote,v,state)
            writer(remote,v,{'phase':91},[state['candidate']])
            original=v['_compatibleOriginalRoutes']
            next_routes=original.replace('http://'+v['proof']['containerName']+':3000','http://'+state['candidate']+':3000')
            t,a=remote.routes();admit_known_route_pair(t,a,original,next_routes)
            require(next_routes.count('http://'+state['candidate']+':3000')==3,'OFFLINE_COMPAT_RECOVERY_ROUTE_COUNT_CHANGED')
            m.replace_routes(remote,next_routes,next_routes);remote.health(state['candidate'],v['release'],True)
            result.update(recovery='KNOWN_PARTIAL_ROUTES_CONVERGED_VERIFIED_L91_RECALL',serviceAvailableVerified=True)
        except BaseException:result['recovery']='UNVERIFIED_RETAIN_LOCK_NO_BLIND_RESTART'
        return result


# The exact existing bounded process/termination primitive is reused. Only the
# owned application_name and fixed error namespace change for this profile.
def migration_code():
    if 'BUNDLED_MIGRATION_CODE' in globals():return BUNDLED_MIGRATION_CODE
    helper=Path(__file__).with_name('deploy-prod-purchase-return.py')
    require(sha(helper.read_bytes())==contract()['sourcePayloadFiles']['scripts/deploy-prod-purchase-return.py'],
            'OFFLINE_MIGRATION_PRIMITIVE_CHANGED_BEFORE_IMPORT')
    spec=importlib.util.spec_from_file_location('offline_migration_process_primitive',helper)
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
    code=mod.PURCHASE_RETURN_MIGRATION_CODE.replace('budu_purchase_return_migrate_','budu_offline_store_migrate_').replace('PURCHASE_RETURN_','OFFLINE_')
    code=code.replace("v=json.load(sys.stdin);pg=", "v=json.load(sys.stdin);root=__import__('pathlib').Path(v['root']);pg=",1)
    needle="out,err=p.communicate(v['transaction'].encode(),timeout=45)"
    require(code.count(needle)==1,'OFFLINE_MIGRATION_PROCESS_PRIMITIVE_CHANGED')
    replacement="""p.stdin.write(v['transaction'].encode());p.stdin.close();p.stdin=None
 until=time.monotonic()+45
 while p.poll() is None:
  _offline_disk_guard();_offline_wal_guard()
  if time.monotonic()>until:raise RuntimeError('OFFLINE_MIGRATION_DEADLINE')
  time.sleep(.2)
 out,err=p.communicate(timeout=5)"""
    code=code.replace(needle,replacement,1)
    needle="application_name='\"+marker+\"' AND pid<>pg_backend_pid()"
    require(code.count(needle)==1,'OFFLINE_MIGRATION_SESSION_PRIMITIVE_CHANGED')
    code=code.replace(needle,"application_name IN ('\"+marker+\"','\"+marker+\"_reader') AND pid<>pg_backend_pid()",1)
    return BACKUP_WATCH_CODE+code


MIGRATION_CODE=migration_code()


def bootstrap_source():
    base=Path(m.__file__).read_text().rsplit("\nif __name__ == '__main__':",1)[0]
    own=Path(__file__).read_text().rsplit("\nif __name__ == '__main__':",1)[0]
    require(sha(Path(m.__file__).read_bytes())==contract()['baseControllerSha256'],'OFFLINE_BASE_CONTROLLER_CHANGED')
    encoded=Path(__file__).with_name('offline-store-service-release-contract.json').read_bytes()
    return ('import types\nBUNDLED_CORE=types.ModuleType("offline_bg_core")\nexec(compile('+repr(base)+',"<existing-bg-core>","exec"),BUNDLED_CORE.__dict__)\n'
            +'BUNDLED_CONTRACT_BYTES='+repr(encoded)+'\nBUNDLED_MIGRATION_CODE='+repr(MIGRATION_CODE)+'\n'+own
            +'\ninstall_signal_handlers()\n')


def install_signal_handlers():
    def interrupted(*_):
        raise m.GateError('OFFLINE_CONTROLLER_INTERRUPTED_RETAIN_LOCK_UNTIL_TERMINATION_PROVEN')
    for sig in (signal.SIGHUP,signal.SIGTERM,signal.SIGINT):
        signal.signal(sig,interrupted)


def engineering_bundle_hash():
    c=contract()
    return sha(canonical({'profile':sha(Path(__file__).read_bytes()),'contract':CONTRACT_HASH,
                         'core':c['baseControllerSha256'],'clone':c['cloneHelperSha256'],
                         'migrationProcess':sha(MIGRATION_CODE.encode())}))


def main():
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['identity','plan','preflight','deploy','compatible-recall'])
    p.add_argument('--repo',type=Path,required=True);p.add_argument('--archive',type=Path)
    p.add_argument('--proof',type=Path);p.add_argument('--sharing',type=Path);p.add_argument('--capacity-observation',type=Path)
    p.add_argument('--plan',type=Path);p.add_argument('--ssh-key');p.add_argument('--authorize-release-sha')
    p.add_argument('--authorize-plan-sha256');p.add_argument('--authorize-engineering-sha256')
    a=p.parse_args();v=identity(a.repo);c=contract()
    if a.mode=='identity':
        print(json.dumps({'result':'IDENTITY_PASS','sourceSha':v['release'],'engineeringHead':v['engineeringHead'],
            'ociManifest':c['ociManifest'],'migration':c['migration'],'sqlSha256':c['migrationSqlSha256'],
            'engineeringBundleSha256':engineering_bundle_hash(),'productionMutation':False}));return
    require(a.archive is not None and a.proof is not None,'OFFLINE_ARTIFACT_AND_PROOF_REQUIRED')
    v['art']=artifact(a.archive);v['proof']=json.loads(a.proof.read_text())
    if a.mode=='compatible-recall':
        require(a.plan is not None and a.ssh_key is not None,'OFFLINE_RECOVERY_PLAN_AND_SSH_REQUIRED')
        plan_bytes=a.plan.read_bytes();approval=json.loads(plan_bytes)
        require(approval.get('operation')=='COMPATIBLE_RECALL'
                and approval.get('contractHash')==CONTRACT_HASH
                and approval.get('productionProofSha256')==sha(a.proof.read_bytes())
                and approval.get('engineeringBundleSha256')==engineering_bundle_hash(), 'OFFLINE_RECOVERY_APPROVAL_CHANGED')
        require(a.authorize_release_sha==v['release'] and a.authorize_plan_sha256==sha(plan_bytes)
                and a.authorize_engineering_sha256==engineering_bundle_hash()
                and approval.get('isolatedValidation')==approval.get('independentReview')=='PASS', 'OFFLINE_EXACT_RECOVERY_AUTHORIZATION_REQUIRED')
        v['capacityPlan']=approval['capacityPlan'];v['recoveryCapacityLedger']=approval['historicalCapacityLedger']
        require(v['recoveryCapacityLedger']['plan']==v['capacityPlan'] and v['capacityPlan']['release']==v['release']
                and v['capacityPlan']['version']==contract()['version'], 'OFFLINE_RECOVERY_CAPACITY_LEDGER_CHANGED')
        remote=m.Remote(a.ssh_key)
        code=bootstrap_source()+'\nv=json.load(sys.stdin)\nprint(json.dumps(execute_compatible_recall(m.LocalRemote(),v)),flush=True)\n'
        print(remote.py(code,v,timeout=600));return
    require(a.sharing is not None and a.capacity_observation is not None,'OFFLINE_CAPACITY_INPUTS_REQUIRED')
    sharing=json.loads(a.sharing.read_text());observed=json.loads(a.capacity_observation.read_text())
    v['capacityPlan']=capacity_plan(sharing,v['proof'],observed['database'])
    if a.mode=='plan':
        used=observed['disk']['usedBytes'];available=observed['disk']['availableBytes']
        ledger={'baselineUsed':used,'baselineAvailable':available,'phase':'OFFLINE_PLAN','peak':0}
        gate=m.b1_capacity_gate(ledger,used,available,max(v['capacityPlan']['import'],v['capacityPlan']['database']),
                                planned=max(v['capacityPlan']['import'],v['capacityPlan']['database']))
        print(json.dumps({'result':'ISOLATED_ENGINEERING_VALIDATION_REQUIRED','operation':'DEPLOY_L90_TO_L91','contractHash':CONTRACT_HASH,
            'sourceSha':v['release'],'engineeringBundleSha256':engineering_bundle_hash(),
            'productionProofSha256':sha(a.proof.read_bytes()),'sharingProducerSha256':sha(SHARING_CODE.encode()),
            'capacityPlan':v['capacityPlan'],'capacityGate':gate,'productionMutation':False}));return
    require(a.ssh_key is not None and a.plan is not None,'OFFLINE_SSH_AND_APPROVAL_PLAN_REQUIRED')
    plan_bytes=a.plan.read_bytes();approval=json.loads(plan_bytes)
    require(approval['capacityPlan']==v['capacityPlan'] and approval['contractHash']==CONTRACT_HASH,
            'OFFLINE_APPROVAL_PLAN_CHANGED')
    require(approval.get('operation')=='DEPLOY_L90_TO_L91' and approval.get('newOwnedArchiveReleasePlanned') is True,
            'OFFLINE_OPERATION_OR_NEW_ARCHIVE_RELEASE_NOT_APPROVED')
    require(approval.get('productionProofSha256')==sha(a.proof.read_bytes())
            and approval.get('sharingProducerSha256')==sha(SHARING_CODE.encode())
            and approval.get('engineeringBundleSha256')==engineering_bundle_hash(), 'OFFLINE_APPROVED_IDENTITY_OR_ENGINEERING_CHANGED')
    v['approvedPlanHash']=sha(plan_bytes)
    code=bootstrap_source()
    # SHARING_READER is the reviewed read-only graph/content probe appended below.
    code+='\nv=json.load(sys.stdin)\n'
    if a.mode=='preflight':
        code+='g,cap,root=preflight(m.LocalRemote(),v,sharing_reader)\nprint(json.dumps({"result":"READONLY_PREFLIGHT_PASS","capacityLedger":cap,"root":root,"productionMutation":False}))\n'
        remote=m.Remote(a.ssh_key);print(remote.py(code,v));return
    require(a.authorize_release_sha==v['release'] and a.authorize_plan_sha256==sha(plan_bytes)
            and a.authorize_engineering_sha256==engineering_bundle_hash(),'OFFLINE_EXACT_PRODUCTION_AUTHORIZATION_REQUIRED')
    require(approval.get('isolatedValidation')=='PASS' and approval.get('independentReview')=='PASS',
            'OFFLINE_ENGINEERING_REVIEW_NOT_PASSED')
    require(a.mode=='deploy','OFFLINE_COMPATIBLE_RECALL_NEEDS_CURRENT_L91_PROOF_AND_SEPARATE_PLAN')
    # Same single on-host stdin controller and reviewed bounded transport as the
    # existing purchase-return release; no shell interpolation of a JSON body.
    code=bootstrap_source()+'\nv=json.loads(sys.stdin.buffer.readline())\nprint(json.dumps(execute(m.LocalRemote(),v,sys.stdin.buffer,sharing_reader)),flush=True)\n'
    spec=importlib.util.spec_from_file_location('offline_transport',Path(__file__).with_name('deploy-prod-purchase-return.py'))
    transport=importlib.util.module_from_spec(spec);spec.loader.exec_module(transport)
    loader='import json,sys;exec(compile(json.loads(sys.stdin.buffer.readline()),"<offline-release>","exec"))'
    def chunks():
        yield json.dumps(code).encode()+b'\n';yield json.dumps(v).encode()+b'\n'
        with a.archive.open('rb') as stream:yield from iter(lambda:stream.read(65536),b'')
    remote=m.Remote(a.ssh_key)
    out,err,rc,error=transport.transport(remote.ssh+[shlex.join(['sudo','-n','python3','-u','-c',loader])],chunks())
    require(error is None and rc==0,'OFFLINE_RELEASE_TRANSPORT_UNKNOWN_RETAIN_LOCK')
    rows=[json.loads(x) for x in out.splitlines() if x.startswith(b'{')]
    require(rows and rows[-1].get('result')=='DEPLOY_COMPLETE','OFFLINE_DEPLOYMENT_BLOCKED')
    print(json.dumps(rows[-1]))



SHARING_CODE='import hashlib,json,os,pathlib,re,stat,subprocess,sys,datetime,socket\ndef run(args, data=None, timeout=20):\n    proc = subprocess.run(args, input=data, capture_output=True, timeout=timeout)\n    if proc.returncode:\n        raise RuntimeError(\'COMMAND_FAILED\')\n    return proc.stdout\ndef sha(value):\n    return value if isinstance(value, str) and re.fullmatch(r\'[0-9a-f]{40}\', value) else \'UNVERIFIED\'\ndef allocated(path):\n value=run([\'du\',\'-sx\',\'-B1\',\'--\',path],timeout=20).decode().split()[0]\n return int(value)\ndef committed_and_sharing():\n live=json.loads(run([\'docker\',\'inspect\',result[\'runtime\'][\'target\']]))[0]\n image=json.loads(run([\'docker\',\'image\',\'inspect\',live[\'Image\']]))[0]\n pid=live[\'State\'][\'Pid\'];assert live[\'State\'][\'Running\'] and pid>0\n base=[\'ctr\',\'--address\',\'/run/containerd/containerd.sock\',\'--namespace\',\'moby\']\n version=run([\'docker\',\'version\',\'--format\',\'{{json .Server}}\']).decode();version=json.loads(version)\n drv=run([\'docker\',\'info\',\'--format\',\'{{json .Driver}}\']).decode().strip()\n rootdev=os.stat(\'/var/lib/containerd\').st_dev\n ingest=run(base+[\'content\',\'active\']).decode().splitlines();assert len(ingest)==1 and ingest[0].split()==[\'REF\',\'SIZE\',\'AGE\']\n snapshot_rows=run(base+[\'snapshots\',\'--snapshotter\',\'overlayfs\',\'list\']).decode().splitlines()\n known=set(run([\'docker\',\'ps\',\'-aq\',\'--no-trunc\']).decode().split());active=[];committed=[]\n for row in snapshot_rows[1:]:\n  cells=row.split();assert len(cells) in (2,3)\n  key,kind=cells[0],cells[-1]\n  if kind==\'Committed\':committed.append(key)\n  else:\n   assert kind==\'Active\' and (key in known or key.removesuffix(\'-init\') in known)\n   active.append(key)\n mountrows=pathlib.Path(\'/proc\',str(pid),\'mountinfo\').read_text().splitlines()\n entries=[x for x in mountrows if x.split()[4]==\'/\' and \' - overlay \' in x];assert len(entries)==1\n options=entries[0].split(\' - \',1)[1].split()[2].split(\',\')\n paths=[x[len(\'lowerdir=\'):] for x in options if x.startswith(\'lowerdir=\')];assert len(paths)==1\n paths=paths[0].split(\':\');diffs=image[\'RootFS\'][\'Layers\'];n=len(diffs)\n # Docker commit history can retain existing init snapshots inside the graph.\n # Walk the actual live parent closure; do not zip theoretical image depth.\n closure=[];key=live[\'Id\'];visited=set()\n while key:\n  assert key not in visited and len(closure)<100;visited.add(key)\n  node=json.loads(run(base+[\'snapshots\',\'--snapshotter\',\'overlayfs\',\'info\',key]))\n  assert node[\'Name\']==key and node[\'Kind\']==(\'Active\' if not closure else \'Committed\')\n  if key.endswith(\'-init\'):assert re.fullmatch(\'[0-9a-f]{64}-init\',key) and node[\'Kind\']==\'Committed\'\n  closure.append(node);key=node.get(\'Parent\',\'\')\n parents=closure[1:];assert len(paths)==len(parents) and len(set(paths))==len(paths)\n physical={node[\'Name\']:path for node,path in zip(parents,paths)}\n expected_chains={x[\'chainId\'] for x in CANDIDATE_LAYERS[:n]}\n assert set(physical)==expected_chains|{x[\'Name\'] for x in parents if x[\'Name\'].endswith(\'-init\')}\n refs=set(run(base+[\'content\',\'list\',\'--quiet\']).decode().split());blobroot=pathlib.Path(\'/var/lib/containerd/io.containerd.content.v1.content/blobs/sha256\')\n layers=CANDIDATE_LAYERS\n rows=[];seen=set();prefix=0;blobcredit=0;snapshotcredit=0\n for i,diff in enumerate(diffs):\n  layer=layers[i]\n  if layer[\'diffId\']!=diff:break\n  prefix+=1;chain=layer[\'chainId\'];info=json.loads(run(base+[\'snapshots\',\'--snapshotter\',\'overlayfs\',\'info\',chain]))\n  assert info[\'Kind\']==\'Committed\' and chain in physical and any(x==info for x in parents)\n  p=pathlib.Path(physical[chain]);assert re.fullmatch(\'/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/[0-9]+/fs\',str(p))\n  assert p.resolve()==p and p.stat().st_dev==rootdev\n  identity=(p.stat().st_dev,p.stat().st_ino);assert identity not in seen;seen.add(identity)\n  extent=allocated(str(p))+p.parent.stat().st_blocks*512\n  bd=layer[\'contentDigest\'];bp=blobroot/bd.split(\':\')[1];bstatus=\'MISSING\';balloc=0\n  if bd in refs and bp.exists():\n   st=bp.lstat();assert stat.S_ISREG(st.st_mode) and st.st_nlink==1 and st.st_dev==rootdev\n   h=hashlib.sha256()\n   with bp.open(\'rb\') as stream:\n    for chunk in iter(lambda:stream.read(1024**2),b\'\'):h.update(chunk)\n   assert \'sha256:\'+h.hexdigest()==bd\n   after=bp.lstat();assert (st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns)==(after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns)\n   balloc=st.st_blocks*512;bstatus=\'HASH_STAT_AND_CONTENT_REF_VERIFIED\'\n  bc=min(balloc,layer[\'blobBytes\']);sc=min(extent,layer[\'expandedPhysicalBytes\'])\n  blobcredit+=bc;snapshotcredit+=sc\n  rows.append({\'index\':i,\'chainId\':chain,\'contentDigest\':bd,\'diffId\':diff,\'snapshotPath\':str(p),\'snapshotAllocatedBytes\':extent,\'snapshotCreditBytes\':sc,\'blobAllocatedBytes\':balloc,\'blobStatus\':bstatus,\'blobCreditBytes\':bc,\'snapshotKind\':info[\'Kind\'],\'parent\':info.get(\'Parent\',\'\')})\n assert json.loads(run([\'docker\',\'inspect\',live[\'Id\']]))[0][\'Image\']==image[\'Id\']\n ctrversion=run([\'ctr\',\'version\']).decode().splitlines()\n import struct\n peer=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);peer.connect(\'/run/containerd/containerd.sock\')\n pid,uid,gid=struct.unpack(\'3i\',peer.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));peer.close();assert uid==0 and pid>0\n backend=hashlib.sha256(pathlib.Path(\'/proc\',str(pid),\'exe\').read_bytes()).hexdigest()\n return {\'status\':\'PASS_READONLY_LIVE_ROOTFS_COMMITTED_AND_HASHED_CONTENT\',\'imageId\':image[\'Id\'],\'liveContainerId\':live[\'Id\'],\'existingRunningPidUsed\':True,\'newProofContainerCreated\':False,\'driver\':json.loads(drv),\'dockerServerVersion\':version[\'Version\'],\'containerdVersionLines\':ctrversion,\'containerdServerBinarySha256\':backend,\'backendBinaryIdentitySource\':\'UNIX_SOCKET_PEERCRED_PROC_EXE\',\n  \'activeIngest\':0,\'unknownSnapshots\':0,\'committedCount\':len(committed),\'knownActiveCount\':len(active),\'sharedPrefixLayers\':prefix,\'candidateLayers\':len(layers),\'layers\':rows,\n  \'blobCreditBytes\':blobcredit,\'snapshotCreditBytes\':snapshotcredit,\'totalCreditBytes\':blobcredit+snapshotcredit,\n  \'creditStatus\':\'VERIFIED_READONLY_INPUTS_NOT_A_B2_GUARD_EXECUTION_OR_IMPORT_SUCCESS\',\'filesystemDevice\':rootdev,\'actualLiveParentClosure\':closure,\'nonImageInitSnapshotsCredited\':False}\nv=json.load(sys.stdin)\nREVISION="org.opencontainers.image.revision"\nresult={"runtime":{"target":v["containerName"]}}\nCANDIDATE_LAYERS=v["layers"]\nvalue=committed_and_sharing()\nvalue["productionMutation"]=False\nprint(json.dumps(value))\n'

def sharing_reader(remote,v):
    value=json.loads(remote.py(SHARING_CODE,{"containerName":v["proof"]["containerName"],"layers":contract()["layers"]},timeout=150))
    validate_sharing(value,v["proof"])
    return value

if __name__ == '__main__':
    try:main()
    except m.GateError as error:
        print(json.dumps({'result':'BLOCKED','code':str(error),'productionAuthorizationNotInferred':True}));raise SystemExit(1)

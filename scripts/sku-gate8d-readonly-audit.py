#!/usr/bin/env python3
"""Gate 8D diagnosis. SSH commands only inspect the old runtime and read DB data."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

sys.dont_write_bytecode = True
RELEASE = '456a07ecd0c9c1ad485d27b67ccf95f3d8bd4fec'
OLD = '5ad27a06d731fbc94de5ae3776060b4350b886e8'
HOST = '154.8.195.42'
USER = 'ubuntu'
QUERIES = {
    'H1_ORDER_ITEMS': 'SELECT id, product_id, sku_snapshot, product_name_snapshot FROM order_items ORDER BY id',
    'H2_TRANSFER_ITEM': 'SELECT id, "itemId", "itemCodeSnapshot", "itemNameSnapshot" FROM "TransferItem" ORDER BY id',
    'H3_PARTNER_SUPPLY': 'SELECT id, "productId", "productCodeSnapshot", "productNameSnapshot" FROM "PartnerSupplyItem" ORDER BY id',
    'H4_REPLENISHMENT': 'SELECT id, "inventoryItemId", "skuSnapshot", "productCodeSnapshot", "productNameSnapshot" FROM "ReplenishmentOrderItem" ORDER BY id',
}
REQUIRED = {
    'order_items': ('id', 'product_id', 'sku_snapshot', 'product_name_snapshot'),
    'TransferItem': ('id', 'itemId', 'itemCodeSnapshot', 'itemNameSnapshot'),
    'PartnerSupplyItem': ('id', 'productId', 'productCodeSnapshot', 'productNameSnapshot'),
    'ReplenishmentOrderItem': ('id', 'inventoryItemId', 'skuSnapshot', 'productCodeSnapshot', 'productNameSnapshot'),
    'InventoryItem': ('id', 'name', 'sku', 'category', 'createdAt', 'isActive',
                      'transferCode', 'productCategoryId', 'transferEnabled',
                      'partnerSupplyEnabled', 'partnerReplenishmentEnabled'),
    'ProductCategory': ('id', 'name'),
    'online_product_policies': ('id', 'namespace', 'external_product_id',
                                'external_sku_id', 'product_id', 'enabled'),
}
BOOLEAN_FIELDS = {('InventoryItem', field) for field in
    ('isActive','transferEnabled','partnerSupplyEnabled','partnerReplenishmentEnabled')}
BOOLEAN_FIELDS.add(('online_product_policies','enabled'))
DATE_FIELDS = {('InventoryItem','createdAt')}
TEXT_TYPES = {'text','character varying','character'}
DATE_TYPES = {'timestamp without time zone','timestamp with time zone'}


def emit(value):
    print(json.dumps(value, sort_keys=True, ensure_ascii=False), flush=True)


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


def candidate_module(candidate):
    require(candidate.is_dir(), 'V5_CANDIDATE_MISSING')
    spec = importlib.util.spec_from_file_location(
        'sku_gate8d_v5', candidate/'scripts/deploy-prod-sku-authority.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    release, baseline, _ = module.identity(candidate)
    require(release == RELEASE, 'V5_CANDIDATE_IDENTITY_DRIFT')
    return module, baseline


def runner_node(audit_root, candidate, mode, payload):
    env = {**os.environ, 'CANDIDATE_DIR': str(candidate)}
    result = subprocess.run(['node', str(audit_root/'scripts/sku-gate8d-analyze.mjs'), mode],
                            input=json.dumps(payload, ensure_ascii=False).encode(),
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            cwd=candidate, env=env, timeout=90, check=False)
    require(result.returncode == 0, 'RUNNER_'+mode.upper()+'_ANALYSIS_FAILED')
    return json.loads(result.stdout)


def readonly_node(remote, old_name, sql):
    # Every connection defaults to read-only; the explicit transaction verifies it.
    code = r'''
import crypto from 'node:crypto'
import { prisma } from './server/pg.js'
const sql = __SQL__
const stable = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)
const hash = value => crypto.createHash('sha256').update(stable(value)).digest('hex')
const typeOf = value => value === null ? 'null' : value instanceof Date ? 'date' :
  Buffer.isBuffer(value) ? 'buffer' : typeof value
try {
  const started = Date.now()
  const rows = await prisma.$transaction(async tx => {
    const [guard] = await tx.$queryRawUnsafe("SELECT current_setting('transaction_read_only') AS value")
    if (guard.value !== 'on') throw Error('READ_ONLY_GUARD_FAILED')
    return tx.$queryRawUnsafe(sql)
  }, { isolationLevel: 'RepeatableRead', maxWait: 10000, timeout: 120000 })
  const types = {}
  for (const row of rows) for (const [key, value] of Object.entries(row)) {
    const t = typeOf(value)
    types[key] ??= []
    if (!types[key].includes(t)) types[key].push(t)
  }
  const originalDigest = hash(rows.map(row => ({ id: row.id, digest: hash(row) })))
  process.stdout.write(stable({ ok: true, rows, types, originalDigest,
    elapsedMs: Date.now() - started }) + '\n')
} catch (error) {
  const code = String(error?.code || 'QUERY_FAILED')
  const dbCode = String(error?.meta?.code || 'UNAVAILABLE')
  process.stdout.write(JSON.stringify({ ok: false,
    code: /^[A-Z][A-Z0-9_]{0,30}$/.test(code) ? code : 'QUERY_FAILED',
    dbCode: /^[A-Z0-9]{5}$/.test(dbCode) ? dbCode : 'UNAVAILABLE' }) + '\n')
} finally {
  try { await prisma.$disconnect() } catch {}
}
'''.replace('__SQL__', json.dumps(sql))
    output = remote.run(['docker', 'exec', '-w', '/app', '-e',
                         'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=120000 -c temp_file_limit=0',
                         old_name, 'node', '--input-type=module', '-e', code], timeout=170)
    return json.loads(output)


ROOT_PROBE = r'''
import hashlib,json,os,pathlib,sys
value=json.load(sys.stdin)
root=pathlib.Path('/opt/budu/.rollback-assets/sku-authority-'+value['release'])
def digest(path):
 try: return hashlib.sha256(path.read_bytes()).hexdigest()
 except (OSError,ValueError): return None
manifest=root/'phase.json'
try: phase=json.loads(manifest.read_text()).get('phase')
except (OSError,ValueError): phase=None
print(json.dumps({'rootExists':root.is_dir(),'phase':phase,
 'plan':(root/'sku-plan.json').exists(),'backup':(root/'pre-migration.dump').exists(),
 'backupHash':(root/'pre-migration.sha256').exists(),
 'migrationMarker':(root/'migration-started').exists(),
 'routeTemplateSnapshotMatches':digest(root/'route-template')==value['templateHash'],
 'routeActiveSnapshotMatches':digest(root/'route-active')==value['activeHash'],
 'releaseLock':os.path.lexists('/run/lock/budu-transfer-cas-release')}))
'''


def baseline(remote, deploy, approved_ledger):
    core = deploy.core
    template, active = remote.routes()
    name = core.route_target(template, active)
    old = remote.inspect(name)
    require(old['Config']['Labels'].get(core.REVISION) == OLD and
            core.env(old).get('GIT_SHA') == OLD, 'OLD_RUNTIME_SHA_DRIFT')
    require(old['State']['Running'] and
            old['State'].get('Health', {}).get('Status') == 'healthy',
            'OLD_RUNTIME_NOT_HEALTHY')
    require(remote.run(['cat', core.CURRENT_SHA_FILE]).decode().strip() == OLD,
            'CURRENT_SHA_POINTER_DRIFT')
    core.require(remote.run(['docker', 'exec', name, 'sha256sum', '/app/server/v2.js'])
                 .decode().split()[0] == deploy.old_v2_hash(Path(os.environ['CANDIDATE_DIR'])),
                 'OLD_RUNTIME_SOURCE_DRIFT')
    remote.health(name, OLD)
    remote.health(name, OLD, public=True)
    database = remote.db()
    core.validate_database(database, approved_ledger)
    core.writer_check(remote.containers(), database, [name])
    root = json.loads(remote.py(ROOT_PROBE, {
        'release': RELEASE,
        'templateHash': hashlib.sha256(template.encode()).hexdigest(),
        'activeHash': hashlib.sha256(active.encode()).hexdigest(),
    }))
    require(root['rootExists'] and root['phase'] == 'PRE_CUTOVER' and
            not any(root[key] for key in ('plan', 'backup', 'backupHash',
                                           'migrationMarker', 'releaseLock')) and
            root['routeTemplateSnapshotMatches'] and
            root['routeActiveSnapshotMatches'], 'V5_ROLLBACK_STATE_DRIFT')
    tables = readonly_node(remote, name,
        "SELECT to_regclass('public.product_sku_assignments')::text AS assignments, "
        "to_regclass('public.product_sku_aliases')::text AS aliases, "
        "to_regclass('public.product_sku_sequences')::text AS sequences")
    require(tables.get('ok') and len(tables['rows']) == 1 and
            all(tables['rows'][0][key] is None for key in ('assignments','aliases','sequences')),
            'SKU_TABLES_PRESENT_OR_UNVERIFIED')
    summary = {
        'event':'GATE_8D_BASELINE', 'productionSha':OLD, 'baselineExact':True,
        'routeState':'OLD_PRODUCTION_TEMPLATE_EQUALS_ACTIVE',
        'applicationHealth':'PASS', 'publicHealth':'PASS',
        'database':database['database'],
        'migrationLedger':f"{database['applied']}/{database['failed']}",
        'skuTables':'ABSENT', 'writerState':'1_OLD_PRODUCTION_WRITER',
        'v5RollbackPhase':root['phase'],
        'v5PlanFile':'PRESENT' if root['plan'] else 'ABSENT',
        'v5Backup':'PRESENT' if root['backup'] else 'ABSENT',
        'v5MigrationMarker':'PRESENT' if root['migrationMarker'] else 'ABSENT',
        'v5RouteSnapshotsMatch':True, 'releaseLock':root['releaseLock'],
    }
    emit(summary)
    return name


def historical(remote, old_name, audit_root, candidate):
    output = {}
    for query_id, sql in QUERIES.items():
        try:
            response = readonly_node(remote, old_name, sql)
            if not response.get('ok'):
                row = {'queryId': query_id, 'sqlExecution':'FAIL',
                       'rowCount':None,'digest':None,
                       'safeErrorCode':response.get('code','QUERY_FAILED'),
                       'postgresCode':response.get('dbCode','UNAVAILABLE')}
            else:
                result = runner_node(audit_root, candidate, 'history', response)
                row = {'queryId':query_id,'sqlExecution':'PASS',
                       'rowCount':result['rowCount'],'digest':result['digest'],
                       'serialization':result['serialization'],
                       'types':response['types'], 'elapsedMs':response['elapsedMs']}
        except (RuntimeError, ValueError, subprocess.TimeoutExpired):
            row = {'queryId':query_id,'sqlExecution':'FAIL','rowCount':None,
                   'digest':None,'safeErrorCode':'READ_ONLY_QUERY_UNAVAILABLE'}
        emit({'event':'GATE_8D_HISTORICAL_QUERY',**row})
        output[query_id] = row
    return output


def schema_metadata(remote, old_name):
    names = ','.join("'"+name+"'" for name in REQUIRED)
    sql = ("SELECT table_name, column_name, data_type, is_nullable "
           "FROM information_schema.columns WHERE table_schema='public' "
           f"AND table_name IN ({names}) ORDER BY table_name, ordinal_position")
    result = readonly_node(remote, old_name, sql)
    require(result.get('ok'), 'SCHEMA_METADATA_UNAVAILABLE')
    actual = {(row['table_name'], row['column_name']):row for row in result['rows']}
    details = []
    for table, columns in REQUIRED.items():
        for column in columns:
            row = actual.get((table,column))
            allowed = ({'boolean'} if (table,column) in BOOLEAN_FIELDS else
                       DATE_TYPES if (table,column) in DATE_FIELDS else TEXT_TYPES)
            type_compatible = row is not None and row['data_type'] in allowed
            details.append({'table':table,'column':column,'exists':row is not None,
                            'type':row['data_type'] if row else None,
                            'nullable':row['is_nullable'] if row else None,
                            'typeCompatible':type_compatible})
    historical_tables = list(REQUIRED)[:4]
    historical_compatible = all(row['typeCompatible'] for row in details if row['table'] in historical_tables)
    prisma_compatible = all(row['typeCompatible'] for row in details)
    mismatches = [{'table':row['table'],'expectedColumn':row['column'],
                   'actualColumn':row['column'] if row['exists'] else None,
                   'actualType':row['type']} for row in details if not row['typeCompatible']]
    actual_columns = {table:sorted(column for table_name,column in actual if table_name == table)
                      for table in REQUIRED if any(row['table'] == table for row in mismatches)}
    emit({'event':'GATE_8D_SCHEMA_METADATA','requiredColumns':details,
          'mismatches':mismatches,'actualColumnsForMismatchedTables':actual_columns,
          'historicalSqlSchemaCompatibility':'PASS' if historical_compatible else 'FAIL',
          'planPrisma85Compatibility':'PASS' if prisma_compatible else 'FAIL'})
    return historical_compatible, prisma_compatible, details


def snapshot(remote, old_name, audit_root, candidate):
    code = (candidate/'scripts/sku-release-snapshot-probe.mjs').read_text()
    raw = remote.run(['docker','exec','-w','/app','-e',
        'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=120000 -c temp_file_limit=0',
        old_name,'node','--input-type=module','-e',code],timeout=150)
    state = json.loads(raw)
    readiness = subprocess.run(['node',str(candidate/'scripts/sku-release-readiness-plan.mjs')],
        input=raw,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,cwd=candidate,
        timeout=60,check=False)
    matrix = runner_node(audit_root,candidate,'snapshot',state)
    matrix['readinessPlan'] = 'PASS' if readiness.returncode == 0 else 'FAIL'
    if readiness.returncode == 0:
        authority = json.loads(readiness.stdout)
        require(all(matrix[key] == authority[key] for key in
            ('mappingDigest','onlineDigest','idsDigest','snapshotId','channelDigest')),
            'RUNNER_READINESS_RECOMPUTATION_MISMATCH')
    emit({'event':'GATE_8D_SNAPSHOT_ASSERTIONS',**matrix})
    return matrix


def classify(history, historical_compatible, prisma_compatible, matrix):
    failed = [key for key,row in history.items() if row['sqlExecution'] != 'PASS']
    if failed and not historical_compatible:
        return 'HISTORICAL_SQL_SCHEMA_MISMATCH', ','.join(failed)
    if failed:
        return 'HISTORICAL_QUERY_EXECUTION_FAILURE', ','.join(failed)
    if any(row.get('serialization') != 'PASS' for row in history.values()):
        return 'HISTORICAL_SERIALIZATION_FAILURE', 'HISTORICAL_DIGEST_MISMATCH'
    if matrix['productCount'] != 178 or matrix['checks']['ASSERT_POS_ACTIVE'] == 'FAIL':
        return 'PRODUCT_SNAPSHOT_DRIFT', 'PRODUCT_COUNT_OR_ACTIVE'
    if matrix['checks']['ASSERT_ONLINE_COUNT'] == 'FAIL' or matrix['checks']['ASSERT_ONLINE_DIGEST'] == 'FAIL':
        return 'ONLINE_SNAPSHOT_DRIFT', 'ONLINE_COUNT_OR_DIGEST'
    if matrix['checks']['ASSERT_CHANNEL_IDS'] == 'FAIL' or matrix['checks']['ASSERT_ANY_CHANNEL'] == 'FAIL':
        return 'CHANNEL_SNAPSHOT_DRIFT', 'CHANNEL_IDS_OR_ENABLED'
    if matrix['checks']['ASSERT_PLAN_BUILD'] == 'FAIL':
        return 'PLAN_BUILD_FAILURE', 'FROZEN_PLANNER_REJECTED_SNAPSHOT'
    if any(matrix['checks'][key] == 'FAIL' for key in
           ('ASSERT_PLAN_COUNTS','ASSERT_MAPPING_DIGEST','ASSERT_MAPPING_IDS')):
        return 'MAPPING_ASSERTION_FAILURE', 'COUNTS_DIGEST_OR_IDS'
    if not prisma_compatible:
        return 'PRISMA_85_COMPATIBILITY_FAILURE', 'REQUIRED_COLUMN_MISSING'
    return 'NOT_YET_ISOLATED', 'READ_ONLY_COMPONENT_CHECKS_PASSED'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate',type=Path,required=True)
    args = parser.parse_args()
    candidate = args.candidate.resolve()
    audit_root = Path(__file__).resolve().parent.parent
    require(os.environ.get('BJ_HOST') == HOST and os.environ.get('BJ_USER') == USER,
            'PRODUCTION_TARGET_IDENTITY_INVALID')
    require(os.environ.get('GITHUB_REPOSITORY') == 'GPTJJ/budu',
            'GITHUB_REPOSITORY_INVALID')
    require(os.environ.get('GITHUB_REF') == 'refs/heads/codex/sku-gate8d-frozen-plan-audit',
            'AUDIT_BRANCH_INVALID')
    deploy, approved_ledger = candidate_module(candidate)
    os.environ['CANDIDATE_DIR'] = str(candidate)
    remote = deploy.core.Remote(Path.home()/'.ssh/id_ed25519')
    try:
        old_name = baseline(remote, deploy, approved_ledger)
    except BaseException as error:
        code = str(error)
        if not re.fullmatch(r'[A-Z0-9_:]{1,100}',code): code = 'BASELINE_UNVERIFIED'
        emit({'result':'GATE_8D_BLOCKED_PRODUCTION_STATE','code':code,
              'productionMutation':'NONE'})
        return 2
    history = historical(remote,old_name,audit_root,candidate)
    try:
        historical_compatible, prisma_compatible, metadata = schema_metadata(remote,old_name)
        matrix = snapshot(remote,old_name,audit_root,candidate)
    except BaseException as error:
        code = str(error)
        if not re.fullmatch(r'[A-Z0-9_:]{1,100}',code): code = 'DIAGNOSTIC_EVIDENCE_UNAVAILABLE'
        emit({'result':'GATE_8D_DIAGNOSIS_INCOMPLETE','code':code,
              'productionMutation':'NONE'})
        return 1
    cause, detail = classify(history,historical_compatible,prisma_compatible,matrix)
    emit({'result':'GATE_8D_PASS' if cause != 'NOT_YET_ISOLATED' else
          'GATE_8D_DIAGNOSIS_INCOMPLETE',
          'rootCauseClass':cause,'rootCauseDetail':detail,
          'historicalSqlSchemaCompatibility':'PASS' if historical_compatible else 'FAIL',
          'historicalSerialization':'PASS' if all(row.get('serialization') == 'PASS'
              for row in history.values()) else 'FAIL',
          'planPrisma85Compatibility':'PASS' if prisma_compatible else 'FAIL',
          'productionMutation':'NONE','safeToRetryGate8':'NO'})
    return 0 if cause != 'NOT_YET_ISOLATED' else 1


if __name__ == '__main__':
    try: sys.exit(main())
    except BaseException as error:
        code = str(error)
        if not re.fullmatch(r'[A-Z0-9_:]{1,100}',code): code = 'AUDIT_UNVERIFIED'
        emit({'result':'GATE_8D_DIAGNOSIS_INCOMPLETE','code':code,
              'productionMutation':'NONE'})
        sys.exit(1)

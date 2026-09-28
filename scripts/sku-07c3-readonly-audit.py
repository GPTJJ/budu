#!/usr/bin/env python3
"""One-time, bounded, read-only audit of the 07c3 image-load timeout."""

import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
from urllib.request import urlopen


RELEASE = '07c3e6a6f782865d551f9190612b0de6c35e5afb'
BASELINE = '5ad27a06d731fbc94de5ae3776060b4350b886e8'
MIGRATION = '20260927190000_sku_authority_candidate'
HOST = '154.8.195.42'
USER = 'ubuntu'
KNOWN_HOSTS = str(Path.home()/'.ssh/known_hosts')
SSH_KEY = str(Path.home()/'.ssh/id_ed25519')
ROOT = Path(__file__).resolve().parents[1]


def require(condition, code):
    if not condition:
        raise AuditError(code)


class AuditError(Exception):
    pass


def emit(value):
    print(json.dumps(value, sort_keys=True, separators=(',', ':')), flush=True)


SSH = ['ssh', '-F', '/dev/null', '-i', SSH_KEY, '-o', 'BatchMode=yes',
       '-o', 'IdentitiesOnly=yes', '-o', 'PasswordAuthentication=no',
       '-o', 'KbdInteractiveAuthentication=no', '-o', 'StrictHostKeyChecking=yes',
       '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'UserKnownHostsFile='+KNOWN_HOSTS,
       '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=12',
       '-o', 'ConnectionAttempts=1', USER+'@'+HOST]


def remote(args, data=None, timeout=120):
    try:
        p = subprocess.run(SSH+[shlex.join(args)], input=data, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise AuditError('REMOTE_READ_TIMEOUT') from None
    require(p.returncode == 0, 'REMOTE_READ_FAILED')
    require(len(p.stdout) <= 150000, 'REMOTE_OUTPUT_OVERSIZE')
    return p.stdout.decode('utf-8')


HOST_PROBE = r'''
import json,os,pathlib,re,subprocess,time
RELEASE='07c3e6a6f782865d551f9190612b0de6c35e5afb'
BASELINE='5ad27a06d731fbc94de5ae3776060b4350b886e8'
ROOT='/opt/budu/.rollback-assets/sku-authority-'+RELEASE
def run(args,limit=40,allow_failure=False):
    p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                     timeout=limit,check=False,text=True)
    if p.returncode and not allow_failure: raise RuntimeError('HOST_READ_FAILED:'+args[0])
    return p.stdout[:100000] if p.returncode==0 else None
def inspect(kind,name):
    s=run(['docker',kind,'inspect',name],allow_failure=True)
    if s is None:return None
    rows=json.loads(s)
    if len(rows)!=1:raise RuntimeError('INSPECT_NOT_UNIQUE')
    return rows[0]
template=pathlib.Path('/opt/budu/deploy/nginx/conf.d/budu.conf.template').read_text()
active=run(['docker','exec','budu-nginx-1','cat','/etc/nginx/conf.d/budu.conf'])
targets=re.findall(r'proxy_pass http://([A-Za-z0-9_.-]+):3000;',template)
route=targets[0] if len(targets)==3 and len(set(targets))==1 else None
old=inspect('container',route) if route else None
oldenv=dict(x.split('=',1) for x in (old or {}).get('Config',{}).get('Env',[]) if '=' in x)
oldimage=inspect('image',old['Image']) if old else None
state=(old or {}).get('State',{})
internal=None
if old:
    raw=run(['docker','exec',route,'wget','-qO-','http://127.0.0.1:3000/api/health'],allow_failure=True)
    if raw:
        try:
            h=json.loads(raw)
            internal={'ok':h.get('ok'),'dbOk':h.get('dbOk'),'gitSha':h.get('gitSha')}
        except ValueError:pass
containers=[]
ids=(run(['docker','ps','-aq']) or '').split()
for cid in ids:
    c=inspect('container',cid)
    if not c:continue
    name=c['Name'].lstrip('/')
    env=dict(x.split('=',1) for x in c.get('Config',{}).get('Env',[]) if '=' in x)
    url=env.get('DATABASE_URL','')
    try:
        from urllib.parse import urlsplit,unquote
        db=unquote(urlsplit(url).path).strip('/')
    except ValueError:db=''
    ips=[v.get('IPAddress') for v in c.get('NetworkSettings',{}).get('Networks',{}).values() if v.get('IPAddress')]
    if db=='budu_bj006' and c.get('State',{}).get('Running'):
        containers.append({'name':name,'ips':ips})
interesting=[{'name':name,'running':bool(c.get('State',{}).get('Running'))}
             for cid in ids for c in [inspect('container',cid)] if c
             for name in [c['Name'].lstrip('/')]
             if RELEASE[:12] in name or name.startswith('budu-sku-worker-')]
images={}
for kind,tag in [('runtime','budu-api:sku-authority-'+RELEASE[:12]),
                 ('migration','budu-api:sku-migration-'+RELEASE[:12])]:
    im=inspect('image',tag)
    images[kind]=None if im is None else {'id':im.get('Id'),'revision':im.get('Config',{}).get('Labels',{}).get('org.opencontainers.image.revision'),
                                          'os':im.get('Os'),'architecture':im.get('Architecture'),'size':im.get('Size')}
root=pathlib.Path(ROOT)
files={n:os.path.lexists(root/n) for n in ('phase.json','pre-migration.dump','pre-migration.sha256',
                                      'sku-plan.json','migration-started')}
phase=None
if files['phase.json']:
    try:phase=json.loads((root/'phase.json').read_text()).get('phase')
    except (ValueError,OSError):phase='UNREADABLE'
ps=run(['ps','-eo','pid=,etimes=,comm=,args=']) or ''
importers=[]
for line in ps.splitlines():
    if re.search(r'\b(docker\s+load|ctr\s+.*\b(import|unpack)|containerd\s+.*\bimport)\b',line):
        fields=line.split(None,3)
        if len(fields)>=3 and fields[2] not in ('python3','sh','sudo'):
            importers.append({'pid':fields[0],'elapsedSeconds':fields[1],'command':fields[2]})
def journal(args):
    lines=run(['journalctl','--no-pager','-o','cat','-n','400']+args,limit=30,allow_failure=True)
    if lines is None:return {'available':False}
    lines=lines.lower().splitlines()
    return {'available':True,'lines':len(lines),
            'windowTruncated':len(lines)>=400,
            'importMentions':sum(bool(re.search(r'docker load|image import|importing image|load image',x)) for x in lines),
            'enospc':sum('no space left on device' in x or 'enospc' in x for x in lines),
            'oom':sum(bool(re.search(r'out of memory|oom.kill|oom-kill',x)) for x in lines),
            'ioError':sum(bool(re.search(r'i/o error|input/output error|corrupt',x)) for x in lines)}
incident=journal(['-u','docker.service','-u','containerd.service',
                  '--since','2026-09-28 03:50:00 UTC','--until','2026-09-28 04:30:00 UTC'])
recent=journal(['-u','docker.service','-u','containerd.service','--since','10 minutes ago'])
kernel=journal(['-k','--since','2026-09-28 03:50:00 UTC',
                '--until','2026-09-28 04:30:00 UTC'])
df=(run(['df','-B1','-P','/']) or '').splitlines()[-1].split()
inode=(run(['df','-i','-P','/']) or '').splitlines()[-1].split()
docker_df=run(['docker','system','df','--format','{{json .}}'],limit=60,allow_failure=True)
du=run(['du','-s','-B1','/var/lib/docker','/var/lib/containerd'],limit=75,allow_failure=True)
storage={}
if du:
    for line in du.splitlines():
        bits=line.split()
        if len(bits)==2 and bits[0].isdigit() and bits[1] in ('/var/lib/docker','/var/lib/containerd'):
            storage[bits[1]]=int(bits[0])
print(json.dumps({'route':{'target':route,'templateEqualsActive':template==active},
  'old':{'id':(old or {}).get('Id'),'running':state.get('Running'),
         'health':state.get('Health',{}).get('Status'),
         'labelSha':(old or {}).get('Config',{}).get('Labels',{}).get('org.opencontainers.image.revision'),
         'gitSha':oldenv.get('GIT_SHA'),'imageId':(old or {}).get('Image'),
         'imageRevision':(oldimage or {}).get('Config',{}).get('Labels',{}).get('org.opencontainers.image.revision'),
         'internalHealth':internal},
  'currentSha':pathlib.Path('/opt/budu/.current-sha').read_text().strip(),
  'dbContainers':containers,'releaseContainers':interesting,'images':images,
  'lock':os.path.lexists('/run/lock/budu-transfer-cas-release'),
  'rollback':{'exists':os.path.lexists(root),'files':files,'phase':phase},
  'importers':importers,'incidentLogs':incident,'recentLogs':recent,'kernelLogs':kernel,
  'disk':{'total':int(df[1]),'used':int(df[2]),'available':int(df[3]),
          'inodeUsedPercent':inode[4]},'storageBytes':storage,
  'dockerDfAvailable':docker_df is not None,'sampleTime':int(time.time())},sort_keys=True))
'''


DB_PROBE = r'''
import { PrismaClient } from '@prisma/client'
let prisma
try {
  const original = new URL(process.env.DATABASE_URL || '')
  if (original.protocol !== 'postgresql:' && original.protocol !== 'postgres:') throw Error('DATABASE_URL_INVALID')
  if (decodeURIComponent(original.pathname.slice(1)) !== 'budu_bj006') throw Error('DATABASE_TARGET_INVALID')
  original.searchParams.set('options','-c default_transaction_read_only=on -c statement_timeout=120000 -c temp_file_limit=0')
  prisma = new PrismaClient({ datasources: { db: { url: original.toString() } } })
  const result = await prisma.$transaction(async (tx) => {
    const def = (await tx.$queryRawUnsafe('SHOW default_transaction_read_only'))[0].default_transaction_read_only
    const ro = (await tx.$queryRawUnsafe('SHOW transaction_read_only'))[0].transaction_read_only
    if (def !== 'on' || ro !== 'on') throw Error('READ_ONLY_GUARD_FAILED')
    const database = (await tx.$queryRawUnsafe('SELECT current_database() AS db'))[0].db
    const ledger = await tx.$queryRawUnsafe('SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM _prisma_migrations')
    const tables = (await tx.$queryRawUnsafe(`SELECT
      to_regclass('public.product_sku_sequences') IS NOT NULL AS sequences,
      to_regclass('public.product_sku_assignments') IS NOT NULL AS assignments,
      to_regclass('public.product_sku_aliases') IS NOT NULL AS aliases`))[0]
    const assignments = tables.assignments ? (await tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM product_sku_assignments'))[0].n : null
    const aliases = tables.aliases ? (await tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM product_sku_aliases'))[0].n : null
    const sequences = tables.sequences ? (await tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM product_sku_sequences'))[0].n : null
    const products = (await tx.$queryRawUnsafe("SELECT count(*)::int AS n FROM \"InventoryItem\" WHERE category='product'"))[0].n
    const skuState = (await tx.$queryRawUnsafe(`SELECT
      count(*) FILTER (WHERE sku IS NULL OR btrim(sku)='')::int AS missing,
      count(*) FILTER (WHERE sku ~ '^(BD|TP)-[0-9]{6}$')::int AS canonical
      FROM "InventoryItem" WHERE category='product'`))[0]
    const online = (await tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM online_product_policies'))[0].n
    const clients = (await tx.$queryRawUnsafe(`SELECT DISTINCT coalesce(host(client_addr),'LOCAL_SOCKET') AS ip
      FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()`)).map(x => x.ip)
    return { database, readOnlyDefault:def, readOnlyTransaction:ro,
      ledger:ledger.map(x => ({name:x.migration_name,checksum:x.checksum,finished:x.finished,rolledBack:x.rolled_back})),
      tables,assignments,aliases,sequences,products,skuState,online,clients }
  },{timeout:120000})
  process.stdout.write(JSON.stringify(result)+'\n')
} catch (e) {
  process.stdout.write(JSON.stringify({errorCode: /^(DATABASE_URL_INVALID|DATABASE_TARGET_INVALID|READ_ONLY_GUARD_FAILED)$/.test(e?.message || '') ? e.message : 'DATABASE_READ_FAILED'})+'\n')
  process.exitCode=1
} finally { if (prisma) await prisma.$disconnect().catch(()=>{}) }
'''


def host_probe():
    raw = remote(['sudo','-n','python3','-'], HOST_PROBE.encode(), timeout=175)
    return json.loads(raw)


def db_probe(container):
    require(re.fullmatch(r'[A-Za-z0-9_.-]+', container or '') is not None,
            'OLD_CONTAINER_INVALID')
    raw = remote(['sudo','-n','docker','exec','-i','-w','/app',container,
                  'node','--input-type=module'], DB_PROBE.encode(), timeout=150)
    result = json.loads(raw)
    require('errorCode' not in result, result.get('errorCode','DATABASE_READ_FAILED'))
    return result


def expected_ledger():
    paths = sorted((ROOT/'prisma/migrations').glob('*/migration.sql'))
    entries = {p.parent.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    require(len(entries)==86 and MIGRATION in entries,'LOCAL_LEDGER_INVALID')
    del entries[MIGRATION]
    return entries


def public_health():
    try:
        with urlopen('https://buducandy.cn/api/health', timeout=12) as response:
            require(response.status == 200,'PUBLIC_HEALTH_HTTP_INVALID')
            value = json.loads(response.read(3000))
        return {k:value.get(k) for k in ('ok','dbOk','gitSha')}
    except (OSError,ValueError):
        raise AuditError('PUBLIC_HEALTH_UNAVAILABLE') from None


def run_audit():
    require(os.getenv('BJ_HOST')==HOST and os.getenv('BJ_USER')==USER,
            'AUDIT_TARGET_INVALID')
    require(Path(SSH_KEY).is_file() and Path(KNOWN_HOSTS).is_file(),
            'AUDIT_ENTRY_UNAVAILABLE')
    first = host_probe()
    emit({'event':'AUDIT_HOST_SAMPLE_1','state':first})
    require(first['route']['target'] is not None,'OLD_ROUTE_UNRESOLVED')
    db = db_probe(first['route']['target'])
    actual = {x['name']:x['checksum'] for x in db['ledger'] if x['finished'] and not x['rolledBack']}
    failed = [x for x in db['ledger'] if not x['finished'] and not x['rolledBack']]
    ledger_ok = len(actual)==85 and not failed and actual==expected_ledger()
    db_summary = {k:db[k] for k in ('database','readOnlyDefault','readOnlyTransaction',
                                      'tables','assignments','aliases','sequences','products',
                                      'skuState','online')}
    db_summary.update({'applied':len(actual),'failed':len(failed),'checksumsMatch':ledger_ok,
                       'skuMigrationApplied':MIGRATION in actual,'clientCount':len(db['clients'])})
    emit({'event':'AUDIT_DATABASE','state':db_summary})
    public = public_health()
    emit({'event':'AUDIT_PUBLIC_HEALTH','state':public})
    time.sleep(15)
    second = host_probe()
    emit({'event':'AUDIT_HOST_SAMPLE_2','state':second})
    old = second['old']
    old_ips = {ip for c in second['dbContainers'] if c['name']==second['route']['target']
               for ip in c['ips']}
    clients_known = set(db['clients']) <= old_ips
    disk = second['disk']
    # Prior exact 07c3 preflight's peak increment, not a fresh artifact manifest.
    prior_peak_increment = 6162871753
    disk_estimate_pass = (disk['available']-prior_peak_increment >= 10*1024**3 and
                          (disk['used']+prior_peak_increment)*100 <= 85*disk['total'])
    import_active = bool(first['importers'] or second['importers'])
    activity_verifiable = all(x['incidentLogs'].get('available') and
                              x['recentLogs'].get('available') and
                              x['kernelLogs'].get('available') and
                              not x['incidentLogs'].get('windowTruncated') and
                              not x['recentLogs'].get('windowTruncated') and
                              x['dockerDfAvailable'] and
                              set(x['storageBytes'])=={'/var/lib/docker','/var/lib/containerd'}
                              for x in (first,second))
    stable = (first['images']==second['images'] and
              first['storageBytes']==second['storageBytes'] and
              first['releaseContainers']==second['releaseContainers'])
    import_state = ('ACTIVE' if import_active else
                    'ENDED' if activity_verifiable and stable and
                    first['recentLogs']['importMentions']==0 and
                    second['recentLogs']['importMentions']==0 else 'UNVERIFIED')
    errors = {kind:sum(x[kind] for x in (second['incidentLogs'],second['recentLogs'],
                                        second['kernelLogs']) if x.get('available'))
              for kind in ('enospc','oom','ioError')}
    blockers=[]
    if (second['route']['target']!=first['route']['target'] or
        not second['route']['templateEqualsActive']):blockers.append('ROUTE_DRIFT')
    if (old['labelSha']!=BASELINE or old['gitSha']!=BASELINE or
        old['imageRevision']!=BASELINE or second['currentSha']!=BASELINE or
        old['id']!=first['old']['id'] or not old['running'] or old['health']!='healthy'):
        blockers.append('OLD_RUNTIME_IDENTITY_DRIFT')
    if (public.get('ok') is not True or public.get('dbOk') is not True or
        public.get('gitSha') not in (BASELINE,BASELINE[:12]) or
        old['internalHealth'] is None or old['internalHealth'].get('ok') is not True or
        old['internalHealth'].get('dbOk') is not True or
        old['internalHealth'].get('gitSha') not in (BASELINE,BASELINE[:12])):
        blockers.append('HEALTH_DRIFT')
    if (db['database']!='budu_bj006' or not ledger_ok or
        db['tables']!={'sequences':False,'assignments':False,'aliases':False} or
        db['products']!=178 or db['online']!=153 or db['skuState']['missing']!=33):
        blockers.append('DATABASE_DRIFT')
    if (len(second['dbContainers'])!=1 or second['dbContainers'][0]['name']!=second['route']['target'] or
        not clients_known):blockers.append('WRITER_OR_CLIENT_DRIFT')
    if second['lock'] or second['rollback']['exists'] or second['releaseContainers']:
        blockers.append('RELEASE_RESIDUE_CONFLICT')
    if import_active:blockers.append('IMPORT_STILL_ACTIVE')
    if any(errors.values()):blockers.append('STORAGE_ERROR_EVIDENCE')
    inode_percent = disk['inodeUsedPercent'].rstrip('%')
    if (not disk_estimate_pass or not inode_percent.isdigit() or
            int(inode_percent)>=85):
        blockers.append('DISK_BUDGET_RISK')
    if second['images']['runtime'] or second['images']['migration']:
        blockers.append('EXACT_TAG_CONFLICT')
    result = 'BLOCKED' if blockers else 'UNVERIFIED' if import_state=='UNVERIFIED' else 'SAFE_STATE_CONFIRMED'
    summary={'RESULT':result,'PRODUCTION_SHA':old['labelSha'],
             'CURRENT_SHA':second['currentSha'],'PUBLIC_ROUTE':second['route']['target'],
             'OLD_APP_HEALTH':old['health'],'DATABASE':db['database'],
             'LEDGER':str(len(actual))+'/'+str(len(failed)),
             'LEDGER_CHECKSUMS_MATCH':ledger_ok,'SKU_MIGRATION_APPLIED':MIGRATION in actual,
             'SKU_ASSIGNMENTS':db['assignments'],'SKU_ALIASES':db['aliases'],
             'WRITER_COUNT':len(second['dbContainers']),
             'OLD_RUNTIME_IMPORT_STATE':import_state,
             'RUNTIME_IMAGE_RESIDUE':second['images']['runtime'],
             'MIGRATION_IMAGE_RESIDUE':second['images']['migration'],
             'RELEASE_LOCK':second['lock'],'ROLLBACK_ROOT':second['rollback']['exists'],
             'PERSISTED_PHASE':second['rollback']['phase'],
             'MIGRATION_STARTED_MARKER':second['rollback']['files']['migration-started'],
             'DISK_AVAILABLE':disk['available'],'DISK_USAGE':disk['used'],
             'DISK_PRIOR_ARTIFACT_ESTIMATE_PASS':disk_estimate_pass,
             'STORAGE_ERROR_EVIDENCE':errors,'BLOCKERS':blockers,
             'PRODUCTION_MUTATION':'NONE','DATABASE_MUTATION':'NONE',
             'DOCKER_MUTATION':'NONE','RELEASE_DISPATCH':'NONE'}
    emit({'event':'AUDIT_RESULT','state':summary})
    return result


if __name__=='__main__':
    try:
        state=run_audit()
    except (AuditError,RuntimeError,ValueError,KeyError,TypeError,subprocess.TimeoutExpired) as error:
        code=str(error)
        if not re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}',code):code='AUDIT_READ_FAILED'
        emit({'event':'AUDIT_RESULT','state':{'RESULT':'UNVERIFIED','ERROR_CODE':code,
             'PRODUCTION_MUTATION':'NONE','DATABASE_MUTATION':'NONE',
             'DOCKER_MUTATION':'NONE','RELEASE_DISPATCH':'NONE'}})
        sys.exit(1)
    sys.exit(0 if state=='SAFE_STATE_CONFIRMED' else 1)

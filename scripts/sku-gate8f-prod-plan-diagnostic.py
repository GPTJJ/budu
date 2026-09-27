#!/usr/bin/env python3
"""One dispatch, read-only exact-image diagnosis; never invokes release control."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import importlib.machinery

AUDIT = Path(__file__).with_name('sku-gate8d-readonly-audit.py')
spec = importlib.util.spec_from_file_location('gate8d_baseline', AUDIT)
prior = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prior)

RELEASE = prior.RELEASE
OLD = prior.OLD
IMAGE = 'budu-api:sku-authority-' + RELEASE[:12]
BRANCH = 'refs/heads/codex/sku-gate8f-prod-plan-diagnostic'
PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=120000 -c temp_file_limit=0'
SAFE = re.compile(r'^SKU_RELEASE_[A-Z_]+\n?$')
DB_PROBE = r'''
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
try {
 const [row] = await db.$queryRaw`SELECT current_database() AS name`
 const [guard] = await db.$queryRawUnsafe('SHOW transaction_read_only')
 process.stdout.write(JSON.stringify({database:row?.name || null,readonly:guard?.transaction_read_only || null})+'\n')
} catch { process.stderr.write('SKU_RELEASE_DB_PROBE_FAILED\n'); process.exitCode=1 }
finally { try { await db.$disconnect() } catch { process.exitCode=1 } }
'''

# This code is sent only in memory to sudo python on the production host. It
# obtains DATABASE_URL from Docker inspect locally and passes it to docker -e
# through process environment. No URL enters SSH argv, logs, files or output.
REMOTE_RUN = r'''
import hashlib,json,os,re,subprocess,sys,time
p=json.load(sys.stdin)
name=p['name']; mode=p['mode']; image=p['image']
out={'mode':mode,'name':name}
started=time.time()
env=dict(os.environ)
if mode != 'source':
 old=json.loads(subprocess.check_output(['docker','container','inspect',p['old']],stderr=subprocess.DEVNULL))[0]
 oldenv=dict(x.split('=',1) for x in old['Config']['Env'] if '=' in x)
 url=oldenv.get('DATABASE_URL','')
 from urllib.parse import urlsplit,unquote
 target=urlsplit(url)
 if target.hostname!=p['hostname'] or unquote(target.path).strip('/')!='budu_bj006' or '\n' in url or '\r' in url:
  print(json.dumps({'code':'SKU_DATABASE_URL_INVALID'}));sys.exit(2)
 env.update(DATABASE_URL=url,PGOPTIONS=p['pgoptions'],SKU_RELEASE_CONTROLLER='sku-authority-schema1',GIT_SHA=p['release'])
 for forbidden in ('SKU_RELEASE_WRITE_AUTHORIZED','SKU_RELEASE_TEST_ONLY','SKU_RELEASE_PHASE'):
  env.pop(forbidden,None)
args=['docker','run','--rm','--name',name,'--network',p['network'] if mode!='source' else 'none']
if mode=='stage': args+=['-i']
if mode!='source':
 for key in ('DATABASE_URL','PGOPTIONS','SKU_RELEASE_CONTROLLER','GIT_SHA'): args+=['-e',key]
if mode=='source': args+=['--entrypoint','sha256sum',image,'/app/scripts/sku-release-apply.mjs','/app/server/product-sku-plan.js']
elif mode=='plan': args+=['--entrypoint','node',image,'/app/scripts/sku-release-apply.mjs','plan']
else: args+=['--workdir','/app','--entrypoint','node',image,'--input-type=module',*(['-e',p['probe']] if mode=='dbprobe' else [])]
try:
 r=subprocess.run(args,input=p.get('stageScript','').encode() if mode=='stage' else None,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=180,check=False)
 out.update(exitCode=r.returncode,stdoutBytes=len(r.stdout),stdoutSha256=hashlib.sha256(r.stdout).hexdigest(),stderrBytes=len(r.stderr),stderrSha256=hashlib.sha256(r.stderr).hexdigest(),durationMs=int((time.time()-started)*1000))
 code=r.stderr.decode('utf8','replace')
 out['stderrSafeCode']=code.strip() if re.fullmatch(r'SKU_RELEASE_[A-Z_]+\n?',code) else ('NONE' if not code else 'UNSAFE_STDERR_SUPPRESSED')
 if mode=='source':
  lines=r.stdout.decode('ascii','replace').splitlines()
  out['sourceHashes']=[line.split()[0] for line in lines] if len(lines)==2 and all(re.fullmatch(r'[0-9a-f]{64}  /app/(scripts/sku-release-apply.mjs|server/product-sku-plan.js)',line) for line in lines) else []
 if mode=='dbprobe':
  try:
   value=json.loads(r.stdout)
   out['database']=value.get('database');out['transactionReadOnly']=value.get('readonly')
  except (ValueError,UnicodeError): out['database']=None;out['transactionReadOnly']=None
 if mode=='stage':
  try:
   lines=[json.loads(line) for line in r.stdout.splitlines()]
   allowed={f'STAGE_{i:02d}_'+suffix for i,suffix in enumerate(('URL_PARSE','PRISMA_CLIENT','CURRENT_DATABASE','PRODUCTS_QUERY','ONLINE_QUERY','HISTORY_ORDER_ITEMS','HISTORY_TRANSFER','HISTORY_PARTNER','HISTORY_REPLENISHMENT','CHANNEL_FLAGS','PLAN_BUILD','PLAN_COUNTS','ONLINE_DIGEST','MAPPING_DIGEST','OUTPUT_SERIALIZATION'),1)}
   if all(line.get('stage') in allowed and line.get('status') in ('PASS','FAIL') and re.fullmatch(r'[A-Z][A-Z0-9_]{0,60}',line.get('safeCode','NONE')) and re.fullmatch(r'[A-Za-z]{1,40}',line.get('errorClass','UNKNOWN')) for line in lines):
    out['stages']=lines
   else: out['stages']=[]
  except (ValueError,UnicodeError,TypeError): out['stages']=[]
except subprocess.TimeoutExpired:
 out.update(code='DOCKER_RUN_TIMEOUT',durationMs=int((time.time()-started)*1000))
try:
 events=subprocess.run(['docker','events','--since',str(int(started)-1),'--until',str(int(time.time())+1),'--filter','container='+name,'--format','{{.Action}}'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=8,check=False)
 actions=events.stdout.decode('ascii','replace').splitlines()
 out['lifecycleActions']=[a for a in actions if a in ('create','start','die','destroy')]
except subprocess.TimeoutExpired: out['lifecycleActions']=[]
remaining=subprocess.run(['docker','ps','-aq','--filter','name=^/'+name+'$'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=8,check=False)
out['remainingContainers']=len(remaining.stdout.splitlines()) if remaining.returncode==0 else -1
print(json.dumps(out,sort_keys=True))
'''

ROOT_ASSETS = r'''
import json,pathlib,sys
root=pathlib.Path('/opt/budu/.rollback-assets')
names=sorted(p.name for p in root.glob('sku-authority-*') if p.is_dir())
print(json.dumps({'names':names,'v5':('sku-authority-'+json.load(sys.stdin)['release']) in names}))
'''


def require(value, code):
    if not value: raise RuntimeError(code)


def emit(**value):
    print(json.dumps(value, sort_keys=True), flush=True)


def safe_code(error):
    value = str(error)
    return value if re.fullmatch(r'[A-Z][A-Z0-9_:]{1,99}', value) else 'DETAILS_SUPPRESSED'


def call(remote, payload):
    result = json.loads(remote.py(REMOTE_RUN, payload, timeout=215))
    emit(event='GATE_8F_CONTAINER', **{key: value for key, value in result.items()
        if key not in ('name', 'stages')})
    if result.get('stages') is not None:
        for stage in result['stages']: emit(event='GATE_8F_STAGE', **stage)
    return result


def image(remote):
    try: value = remote.inspect(IMAGE, image=True)
    except Exception: raise RuntimeError('EXACT_IMAGE_ABSENT') from None
    require(value.get('Os') == 'linux' and value.get('Architecture') == 'amd64' and
            value.get('Config',{}).get('Labels',{}).get('org.opencontainers.image.revision') == RELEASE,
            'EXACT_IMAGE_IDENTITY_DRIFT')
    require(bool(re.fullmatch(r'sha256:[0-9a-f]{64}', value.get('Id',''))),
            'EXACT_IMAGE_ID_INVALID')
    emit(event='GATE_8F_IMAGE', reference=IMAGE, imageId=value['Id'],
         architecture=value['Architecture'], os=value['Os'], revision=RELEASE)
    return value['Id']


def baseline(remote, deploy, ledger, candidate, audit_root, label):
    name = prior.baseline(remote, deploy, ledger)
    matrix = prior.snapshot(remote, name, audit_root, candidate)
    require(matrix.get('mappingDigest') ==
            'a939e90b70af125919abbc71ea461b2ec0c37773b0fda8e2da326d02451fab92' and
            matrix.get('onlineDigest') ==
            '8042665cff559a5110a933e499137399d35cbce88dcb3f356f09825ca5924a86' and
            matrix.get('readinessPlan') == 'PASS', 'PINNED_SNAPSHOT_DRIFT')
    emit(event='GATE_8F_BASELINE', phase=label, result='PASS')
    return name


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--candidate', type=Path, required=True)
    args = parser.parse_args()
    candidate = args.candidate.resolve()
    root = Path(__file__).resolve().parent.parent
    require(os.environ.get('BJ_HOST') == '154.8.195.42' and os.environ.get('BJ_USER') == 'ubuntu',
            'PRODUCTION_TARGET_INVALID')
    require(os.environ.get('GITHUB_REPOSITORY') == 'GPTJJ/budu' and
            os.environ.get('GITHUB_REF') == BRANCH and
            os.environ.get('GITHUB_RUN_ATTEMPT') == '1' and
            os.environ.get('AUDIT_AUTHORIZATION') == 'SKU_GATE_8F_READONLY' and
            os.environ.get('CANDIDATE_SHA') == RELEASE, 'DISPATCH_AUTHORIZATION_INVALID')
    require(subprocess.check_output(['git','-C',str(candidate),'rev-parse','HEAD']).decode().strip() == RELEASE,
            'FROZEN_CANDIDATE_INVALID')
    deploy, ledger = prior.candidate_module(candidate)
    os.environ['CANDIDATE_DIR'] = str(candidate)
    remote = deploy.core.Remote(Path.home()/'.ssh/id_ed25519')
    state = {'baselineBefore':'UNVERIFIED','baselineAfter':'UNVERIFIED','ephemeralDiagnosticContainerMutation':'NO',
             'f1':'NOT_RUN','f2':'NOT_RUN','f3':'NO','rootCauseClass':'NOT_YET_ISOLATED',
             'safeToRetryGate8':'NO'}
    names=[]
    try:
        old = baseline(remote,deploy,ledger,candidate,root,'BEFORE')
        state['baselineBefore']='PASS'
        assets = json.loads(remote.py(ROOT_ASSETS,{'release':RELEASE}))
        require(assets['v5'] and
                'sku-authority-4dee331f45e8cd4dca7f092a60213dbb99c4921c' in assets['names'],
                'V4_V5_EVIDENCE_UNVERIFIED')
        state['incidentAssetsBefore']=assets['names']
        state['exactImageId']=image(remote)
        # Invoke the exact v5 resolver; no network name is embedded here.
        op=deploy.operations.SkuProductionOperations.__new__(deploy.operations.SkuProductionOperations)
        op.remote=remote
        op.state={'old':remote.inspect(old)}
        _,hostname=op._worker_database()
        network=op.resolve_database_network(hostname)
        state['dbNetwork']=network
        emit(event='GATE_8F_NETWORK',result='PASS',network=network)
        base={'image':IMAGE,'old':old,'hostname':hostname,'network':network,
              'release':RELEASE,'pgoptions':PGOPTIONS}
        runid=os.environ['GITHUB_RUN_ID']
        source=call(remote,{**base,'mode':'source','name':'budu-sku-gate8f-source-'+runid})
        names.append(source['name'])
        state['ephemeralDiagnosticContainerMutation']='YES'
        require(source.get('exitCode')==0 and source.get('remainingContainers')==0,
                'IMAGE_SOURCE_PROBE_FAILED')
        expected=[hashlib.sha256((candidate/path).read_bytes()).hexdigest() for path in
                  ('scripts/sku-release-apply.mjs','server/product-sku-plan.js')]
        require(source.get('sourceHashes')==expected,'IMAGE_SOURCE_IDENTITY_DRIFT')
        state['imageSourceIdentity']='PASS'
        probe=call(remote,{**base,'mode':'dbprobe','name':'budu-sku-gate8f-dbprobe-'+runid,
                           'probe':DB_PROBE})
        names.append(probe['name'])
        state['f1']='PASS' if probe.get('exitCode')==0 and probe.get('database')=='budu_bj006' and probe.get('transactionReadOnly')=='on' and probe.get('remainingContainers')==0 else 'FAIL'
        state['f1ReadOnly']='ON' if probe.get('transactionReadOnly')=='on' else 'OFF'
        require(state['f1']=='PASS','F1_READ_ONLY_DB_PROBE_FAILED')
        result=call(remote,{**base,'mode':'plan','name':'budu-sku-gate8f-plan-'+runid})
        names.append(result['name'])
        state.update(f2='PASS' if result.get('exitCode')==0 else 'FAIL',
                     f2ExitCode=result.get('exitCode'),f2StderrSafeCode=result.get('stderrSafeCode'),
                     f2StderrBytes=result.get('stderrBytes'),f2StderrSha256=result.get('stderrSha256'),
                     f2StdoutBytes=result.get('stdoutBytes'),f2StdoutSha256=result.get('stdoutSha256'),
                     f2DurationMs=result.get('durationMs'),f2Lifecycle=result.get('lifecycleActions'))
        require(result.get('remainingContainers')==0,'EPHEMERAL_CONTAINER_REMAINS')
        if state['f2']=='PASS':
            state['liveWriterPlanPass']='YES'
            state['rootCauseClass']='LIVE_WRITER_PLAN_PASS_PRODUCTION_FAILURE_DEPENDS_ON_FROZEN_STATE'
            state['result']='GATE_8F_DIAGNOSIS_INCOMPLETE'
        elif result.get('stderrSafeCode') == 'SKU_RELEASE_FAILED_DETAILS_SUPPRESSED':
            stage=call(remote,{**base,'mode':'stage','name':'budu-sku-gate8f-stage-'+runid,
                               'stageScript':(root/'scripts/sku-gate8f-stage.mjs').read_text()})
            names.append(stage['name'])
            state['f3']='YES'
            require(stage.get('remainingContainers')==0,'EPHEMERAL_CONTAINER_REMAINS')
            failure=next((x for x in stage.get('stages',[]) if x.get('status')=='FAIL'),None)
            if failure:
                state['f3FailureStage']=failure['stage'];state['f3FailureCode']=failure.get('safeCode')
                state['rootCauseClass']='EXACT_IMAGE_REAL_DB_STAGE_FAILURE'
                state['result']='GATE_8F_PASS'
            else:
                state['rootCauseClass']='NOT_YET_ISOLATED'
                state['result']='GATE_8F_DIAGNOSIS_INCOMPLETE'
        elif state['f2']=='FAIL' and SAFE.fullmatch((result.get('stderrSafeCode') or '')+'\n'):
            state['rootCauseClass']='EXACT_PRODUCTION_PLAN_SAFE_CODE'
            state['result']='GATE_8F_PASS'
        else:
            state['rootCauseClass']='EXACT_IMAGE_REAL_DB_RUNTIME_FAILURE'
            state['result']='GATE_8F_DIAGNOSIS_INCOMPLETE'
    except Exception as error:
        state['result']='GATE_8F_BLOCKED'
        state['blockCode']=safe_code(error)
    finally:
        if state['baselineBefore']=='PASS':
            try:
                baseline(remote,deploy,ledger,candidate,root,'AFTER')
                assets_after=json.loads(remote.py(ROOT_ASSETS,{'release':RELEASE}))
                require(assets_after['names']==state.get('incidentAssetsBefore'),
                        'INCIDENT_ASSETS_CHANGED')
                state['baselineAfter']='PASS'
            except Exception as error:
                state['baselineAfter']='FAIL'
                state['result']='GATE_8F_BLOCKED'
                state['postflightCode']=safe_code(error)
        try:
            remaining=json.loads(remote.py('''import json,subprocess
r=subprocess.run(['docker','ps','-aq','--filter','name=budu-sku-gate8f-'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
print(json.dumps({'count':len(r.stdout.splitlines()) if r.returncode==0 else -1}))'''))
            state['remainingContainers']=remaining['count']
            if remaining['count']!=0:
                state['result']='GATE_8F_BLOCKED'
                state['blockCode']='EPHEMERAL_CONTAINER_REMAINS'
        except Exception:
            state['remainingContainers']='UNVERIFIED'
            state['result']='GATE_8F_BLOCKED'
    emit(event='GATE_8F_FINAL',**state)
    return 0 if state['result']=='GATE_8F_PASS' else 1


if __name__=='__main__':
    try: sys.exit(main())
    except Exception as error:
        emit(event='GATE_8F_FATAL',result='GATE_8F_BLOCKED',code=safe_code(error),
             productionDataMutation='NONE',safeToRetryGate8='NO')
        sys.exit(2)

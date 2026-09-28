#!/usr/bin/env python3
"""One-time exact-image read-only connection diagnosis. No SKU plan or release."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('gate8d_baseline',
    Path(__file__).with_name('sku-gate8d-readonly-audit.py'))
prior = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prior)

RELEASE = prior.RELEASE
IMAGE = 'budu-api:sku-authority-' + RELEASE[:12]
IMAGE_ID = 'sha256:e253083eee7b791a2101767e9e3296b396d29534f51f157611bf3e469539d18a'
BRANCH = 'refs/heads/codex/sku-gate8g-prisma-readonly-guard'
OPTIONS = '-c default_transaction_read_only=on -c statement_timeout=120000 -c temp_file_limit=0'
ROOT_ASSETS = '''import json,pathlib
root=pathlib.Path('/opt/budu/.rollback-assets')
print(json.dumps(sorted(p.name for p in root.glob('sku-authority-*') if p.is_dir())))'''

# The only DB credential exists in this remote Python process and child Docker
# process environment. It is never included in SSH command text or output.
REMOTE_PROBE = r'''
import json,os,re,subprocess,sys,time
from urllib.parse import parse_qsl,urlencode,urlsplit,urlunsplit,unquote
p=json.load(sys.stdin)
old=json.loads(subprocess.check_output(['docker','container','inspect',p['old']],stderr=subprocess.DEVNULL))[0]
oldenv=dict(x.split('=',1) for x in old['Config']['Env'] if '=' in x)
original=oldenv.get('DATABASE_URL','')
parsed=urlsplit(original)
if parsed.scheme not in ('postgres','postgresql') or parsed.hostname!=p['hostname'] or unquote(parsed.path).strip('/')!='budu_bj006' or '\n' in original or '\r' in original:
 print(json.dumps({'code':'DATABASE_URL_IDENTITY_INVALID'}));sys.exit(2)
mode=p['mode']
if mode=='options':
 pairs=parse_qsl(parsed.query,keep_blank_values=True)
 replaced=False;updated=[]
 for key,value in pairs:
  if key=='options':
   if not replaced: updated.append(('options',p['options']));replaced=True
  else: updated.append((key,value))
 if not replaced: updated.append(('options',p['options']))
 url=urlunsplit((parsed.scheme,parsed.netloc,parsed.path,urlencode(updated),parsed.fragment))
 options_present=True
else:
 url=original;options_present=any(key=='options' for key,_ in parse_qsl(parsed.query,keep_blank_values=True))
env=dict(os.environ)
for key in ('PGOPTIONS','SKU_RELEASE_WRITE_AUTHORIZED','SKU_RELEASE_TEST_ONLY','SKU_RELEASE_PHASE'):
 env.pop(key,None)
env.update(DATABASE_URL=url,GATE8G_MODE=mode)
if mode=='control': env['PGOPTIONS']=p['options']
name=p['name']
args=['docker','run','--rm','-i','--name',name,'--network',p['network'],'--workdir','/app','-e','DATABASE_URL','-e','GATE8G_MODE']
if mode=='control': args+=['-e','PGOPTIONS']
args+=['--entrypoint','node',p['image'],'--input-type=module']
result={'mode':mode,'optionsParameterPresent':options_present}
started=time.monotonic()
try:
 r=subprocess.run(args,input=p['script'].encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=180,check=False)
 result['exitCode']=r.returncode
 result['durationMs']=round((time.monotonic()-started)*1000)
 try:
  value=json.loads(r.stdout)
  def dbname(x): return 'budu_bj006' if x=='budu_bj006' else 'OTHER'
  def flag(x): return x if x in ('on','off') else 'OTHER'
  result['database']=dbname(value.get('database')) if 'database' in value else 'NOT_RUN'
  result['defaultTransactionReadOnly']=flag(value.get('defaultTransactionReadOnly')) if 'defaultTransactionReadOnly' in value else 'NOT_RUN'
  result['transactionReadOnly']=flag(value.get('transactionReadOnly')) if 'transactionReadOnly' in value else 'NOT_RUN'
  for stage in ('g3','g5'):
   item=value.get(stage)
   if isinstance(item,dict): result[stage]={'database':dbname(item.get('database')),'transactionReadOnly':flag(item.get('transactionReadOnly'))}
  g4=value.get('g4')
  if isinstance(g4,dict) and all(isinstance(g4.get(key),int) and 0<=g4[key]<=4 for key in ('sessionCount','distinctBackendCount','readonlyOnCount')):
   result['g4']=g4
  code=value.get('safeCode','NONE')
  result['safeCode']=code if isinstance(code,str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,60}',code) else 'DETAILS_SUPPRESSED'
 except (ValueError,UnicodeError,TypeError,KeyError): result['safeCode']='PROBE_OUTPUT_INVALID'
except subprocess.TimeoutExpired:
 result['exitCode']=-1;result['safeCode']='PROBE_TIMEOUT'
result['stderrBytes']=len(r.stderr) if 'r' in locals() else 0
remaining=subprocess.run(['docker','ps','-aq','--filter','name=^/'+name+'$'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=8,check=False)
result['remainingContainers']=len(remaining.stdout.splitlines()) if remaining.returncode==0 else -1
print(json.dumps(result,sort_keys=True))
'''


def require(condition, code):
    if not condition: raise RuntimeError(code)


def emit(**value):
    print(json.dumps(value, sort_keys=True), flush=True)


def safe_code(error):
    value=str(error)
    return value if re.fullmatch(r'[A-Z][A-Z0-9_:]{1,99}',value) else 'DETAILS_SUPPRESSED'


def baseline(remote, deploy, ledger, candidate, audit_root, phase):
    name=prior.baseline(remote,deploy,ledger)
    matrix=prior.snapshot(remote,name,audit_root,candidate)
    require(matrix.get('mappingDigest') ==
        'a939e90b70af125919abbc71ea461b2ec0c37773b0fda8e2da326d02451fab92' and
        matrix.get('onlineDigest') ==
        '8042665cff559a5110a933e499137399d35cbce88dcb3f356f09825ca5924a86' and
        matrix.get('readinessPlan')=='PASS','PINNED_SNAPSHOT_DRIFT')
    emit(event='GATE_8G_BASELINE',phase=phase,result='PASS')
    return name


def probe(remote, payload):
    value=json.loads(remote.py(REMOTE_PROBE,payload,timeout=210))
    emit(event='GATE_8G_PROBE',**value)
    require(value.get('remainingContainers')==0,'EPHEMERAL_CONTAINER_REMAINS')
    return value


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--candidate',type=Path,required=True)
    args=parser.parse_args()
    candidate=args.candidate.resolve()
    audit_root=Path(__file__).resolve().parent.parent
    require(os.environ.get('BJ_HOST')=='154.8.195.42' and
            os.environ.get('BJ_USER')=='ubuntu' and
            os.environ.get('GITHUB_REPOSITORY')=='GPTJJ/budu' and
            os.environ.get('GITHUB_REF')==BRANCH and
            os.environ.get('GITHUB_RUN_ATTEMPT')=='1' and
            os.environ.get('AUDIT_AUTHORIZATION')=='SKU_GATE_8G_READONLY',
            'DIAGNOSTIC_AUTHORIZATION_INVALID')
    require(subprocess.check_output(['git','-C',str(candidate),'rev-parse','HEAD']).decode().strip()==RELEASE,
            'FROZEN_CANDIDATE_INVALID')
    deploy,ledger=prior.candidate_module(candidate)
    os.environ['CANDIDATE_DIR']=str(candidate)
    remote=deploy.core.Remote(Path.home()/'.ssh/id_ed25519')
    state={'result':'GATE_8G_BLOCKED','baselineBefore':'UNVERIFIED','baselineAfter':'UNVERIFIED',
           'exactImage':'UNVERIFIED','dbNetworkResolution':'UNVERIFIED',
           'g1':'NOT_RUN','g2':'NOT_RUN','g3':'NOT_RUN','g4':'NOT_RUN','g5':'NOT_RUN',
           'readOnlyGuardRootCause':'NOT_YET_ISOLATED','provenReplacement':'NONE',
           'ephemeralDiagnosticContainerMutation':'NO','safeToRetryGate8':'NO'}
    try:
        old=baseline(remote,deploy,ledger,candidate,audit_root,'BEFORE')
        state['baselineBefore']='PASS'
        assets=json.loads(remote.py(ROOT_ASSETS))
        require('sku-authority-'+RELEASE in assets and
                'sku-authority-4dee331f45e8cd4dca7f092a60213dbb99c4921c' in assets,
                'V4_V5_INCIDENT_ASSETS_UNVERIFIED')
        state['incidentAssetsBefore']=assets
        image=remote.inspect(IMAGE,image=True)
        require(image.get('Id')==IMAGE_ID and image.get('Architecture')=='amd64' and
                image.get('Os')=='linux' and
                image.get('Config',{}).get('Labels',{}).get(deploy.core.REVISION)==RELEASE,
                'EXACT_IMAGE_IDENTITY_DRIFT')
        state['exactImage']='PASS';state['exactImageId']=image['Id']
        op=deploy.operations.SkuProductionOperations.__new__(deploy.operations.SkuProductionOperations)
        op.remote=remote;op.state={'old':remote.inspect(old)}
        _,hostname=op._worker_database()
        network=op.resolve_database_network(hostname)
        state['dbNetworkResolution']='PASS';state['dbNetwork']=network
        emit(event='GATE_8G_AUTHORITY',imageId=image['Id'],network=network,
             host=hostname,database='budu_bj006')
        base={'old':old,'hostname':hostname,'network':network,'image':IMAGE,
              'options':OPTIONS,'script':(audit_root/'scripts/sku-gate8g-prisma-guard-probe.mjs').read_text()}
        runid=os.environ['GITHUB_RUN_ID']
        require(bool(re.fullmatch(r'[0-9]{1,20}',runid)),'RUN_ID_INVALID')
        state['ephemeralDiagnosticContainerMutation']='YES'
        g1=probe(remote,{**base,'mode':'control','name':'budu-sku-gate8g-control-'+runid})
        state.update(g1='PASS' if g1.get('exitCode')==0 and g1.get('database')=='budu_bj006' and
                     g1.get('defaultTransactionReadOnly') in ('on','off') and
                     g1.get('transactionReadOnly') in ('on','off') else 'FAIL',
                     g1Database=g1.get('database'),
                     g1DefaultTransactionReadOnly=g1.get('defaultTransactionReadOnly'),
                     g1TransactionReadOnly=g1.get('transactionReadOnly'))
        require(state['g1']=='PASS','G1_CONTROL_FAILED')
        g2=probe(remote,{**base,'mode':'options','name':'budu-sku-gate8g-options-'+runid})
        state.update(g2='PASS' if g2.get('exitCode')==0 and g2.get('database')=='budu_bj006' and
                     g2.get('defaultTransactionReadOnly')=='on' and
                     g2.get('transactionReadOnly')=='on' and
                     g2.get('optionsParameterPresent') is True else 'FAIL',
                     g2Database=g2.get('database'),
                     g2DefaultTransactionReadOnly=g2.get('defaultTransactionReadOnly'),
                     g2TransactionReadOnly=g2.get('transactionReadOnly'),
                     g2SafeCode=g2.get('safeCode'))
        g3=g2.get('g3') or {}
        state.update(g3='PASS' if state['g2']=='PASS' and
                     g3.get('database')=='budu_bj006' and g3.get('transactionReadOnly')=='on' else
                     ('FAIL' if state['g2']=='PASS' else 'NOT_RUN'),
                     g3Database=g3.get('database','NOT_RUN'),
                     g3TransactionReadOnly=g3.get('transactionReadOnly','NOT_RUN'))
        g4=g2.get('g4') or {}
        state.update(g4='PASS' if state['g3']=='PASS' and g4.get('sessionCount')==4 and
                     g4.get('readonlyOnCount')==4 else
                     ('FAIL' if state['g3']=='PASS' else 'NOT_RUN'),
                     g4SessionCount=g4.get('sessionCount',0),
                     g4DistinctBackendCount=g4.get('distinctBackendCount',0),
                     g4ReadonlyOnCount=g4.get('readonlyOnCount',0))
        g5=probe(remote,{**base,'mode':'explicit','name':'budu-sku-gate8g-explicit-'+runid})
        explicit=g5.get('g5') or {}
        state.update(g5='PASS' if g5.get('exitCode')==0 and explicit.get('database')=='budu_bj006' and
                     explicit.get('transactionReadOnly')=='on' else 'FAIL',
                     g5Database=explicit.get('database','NOT_RUN'),
                     g5TransactionReadOnly=explicit.get('transactionReadOnly','NOT_RUN'),
                     g5SafeCode=g5.get('safeCode'))
        if state['g2']==state['g3']==state['g4']=='PASS':
            state['result']='GATE_8G_PASS'
            state['readOnlyGuardRootCause']='PRISMA_PGOPTIONS_NOT_APPLIED' if state['g1TransactionReadOnly']=='off' else 'PGOPTIONS_CONTROL_CHANGED'
            state['provenReplacement']='DATABASE_URL_OPTIONS'
            state['nextAction']='Gate 8F2 exact-image production plan with diagnostic URL options guard'
        elif state['g5']=='PASS':
            state['result']='GATE_8G_PASS'
            state['readOnlyGuardRootCause']='PRISMA_SESSION_START_OPTIONS_UNAVAILABLE_OR_INEFFECTIVE'
            state['provenReplacement']='EXPLICIT_SET_TRANSACTION_READ_ONLY'
            state['nextAction']='Gate 8A-v6 design'
        else:
            state['nextAction']='HOLD; investigate Prisma read-only connection authority'
    except Exception as error:
        state['result']='GATE_8G_BLOCKED';state['blockCode']=safe_code(error)
    finally:
        if state['baselineBefore']=='PASS':
            try:
                baseline(remote,deploy,ledger,candidate,audit_root,'AFTER')
                require(json.loads(remote.py(ROOT_ASSETS))==state.get('incidentAssetsBefore'),
                        'INCIDENT_ASSETS_CHANGED')
                state['baselineAfter']='PASS'
            except Exception as error:
                state['baselineAfter']='FAIL';state['result']='GATE_8G_BLOCKED'
                state['postflightCode']=safe_code(error)
        try:
            remaining=json.loads(remote.py('''import json,subprocess
r=subprocess.run(['docker','ps','-aq','--filter','name=budu-sku-gate8g-'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
print(json.dumps({'count':len(r.stdout.splitlines()) if r.returncode==0 else -1}))'''))
            state['remainingContainers']=remaining['count']
            if remaining['count']!=0:
                state['result']='GATE_8G_BLOCKED';state['blockCode']='EPHEMERAL_CONTAINER_REMAINS'
        except Exception:
            state['remainingContainers']='UNVERIFIED';state['result']='GATE_8G_BLOCKED'
    emit(event='GATE_8G_FINAL',**state)
    return 0 if state['result']=='GATE_8G_PASS' else 1


if __name__=='__main__':
    try: sys.exit(main())
    except Exception as error:
        emit(event='GATE_8G_FATAL',result='GATE_8G_BLOCKED',code=safe_code(error),
             safeToRetryGate8='NO')
        sys.exit(2)

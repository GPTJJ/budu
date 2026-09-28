#!/usr/bin/env python3
"""One production read-only parity proof using the frozen image planner."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('gate8d_baseline',
    Path(__file__).with_name('sku-gate8d-readonly-audit.py'))
prior = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prior)
RELEASE = prior.RELEASE
IMAGE = 'budu-api:sku-authority-' + RELEASE[:12]
IMAGE_ID = 'sha256:e253083eee7b791a2101767e9e3296b396d29534f51f157611bf3e469539d18a'
BRANCH = 'refs/heads/codex/sku-gate8h-mapping-parity'
OPTIONS = '-c default_transaction_read_only=on -c statement_timeout=120000 -c temp_file_limit=0'
ASSETS = '''import json,pathlib
print(json.dumps(sorted(p.name for p in pathlib.Path('/opt/budu/.rollback-assets').glob('sku-authority-*') if p.is_dir())))'''

REMOTE_PROBE = r'''
import json,os,re,subprocess,sys,time
from urllib.parse import urlsplit,urlunsplit,parse_qsl,urlencode,unquote
p=json.load(sys.stdin)
old=json.loads(subprocess.check_output(['docker','container','inspect',p['old']],stderr=subprocess.DEVNULL))[0]
oldenv=dict(x.split('=',1) for x in old['Config']['Env'] if '=' in x)
original=oldenv.get('DATABASE_URL','')
target=urlsplit(original)
if target.scheme not in ('postgres','postgresql') or target.hostname!=p['hostname'] or unquote(target.path).strip('/')!='budu_bj006' or '\n' in original or '\r' in original:
 print(json.dumps({'code':'DATABASE_URL_IDENTITY_INVALID'}));sys.exit(2)
pairs=[(k,v) for k,v in parse_qsl(target.query,keep_blank_values=True) if k!='options']
pairs.append(('options',p['options']))
url=urlunsplit((target.scheme,target.netloc,target.path,urlencode(pairs),target.fragment))
env=dict(os.environ)
for key in ('PGOPTIONS','SKU_RELEASE_WRITE_AUTHORIZED','SKU_RELEASE_TEST_ONLY','SKU_RELEASE_PHASE'):
 env.pop(key,None)
env['DATABASE_URL']=url
args=['docker','run','--rm','--pull','never','-i','--name',p['name'],'--network',p['network'],
      '--workdir','/app','-e','DATABASE_URL','--entrypoint','node',p['image'],'--input-type=module']
out={};started=time.monotonic()
try:
 r=subprocess.run(args,input=p['script'].encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=180,check=False)
 out.update(exitCode=r.returncode,durationMs=round((time.monotonic()-started)*1000),stderrBytes=len(r.stderr))
 try:
  value=json.loads(r.stdout)
  safe={}
  enums={'result':('GATE_8H_PASS','GATE_8H_DIAGNOSIS_INCOMPLETE','GATE_8H_BLOCKED'),
         'readonlyGuard':('PASS','FAIL'),
         'rootCause':('CREATED_AT_DATE_STRING_COERCION_PRECISION_LOSS','NOT_YET_ISOLATED')}
  for key,allowed in enums.items():
   if value.get(key) not in allowed: raise ValueError()
   safe[key]=value[key]
  for key in ('snapshotId','directMappingDigest','directPlanSha256','roundtripMappingDigest',
              'roundtripPlanSha256','normalizedDateMappingDigest'):
   if key in value:
    if not isinstance(value[key],str) or not re.fullmatch('[0-9a-f]{64}',value[key]): raise ValueError()
    safe[key]=value[key]
  for key in ('productCount','onlineCount','fractionalMillisecondProductCount',
              'createdAtNormalizationDiffCount','totalRowsWithAnyDiff','orderDifferenceCount'):
   if key in value:
    if type(value[key]) is not int or not 0<=value[key]<=1000000: raise ValueError()
    safe[key]=value[key]
  if 'fieldDifferences' in value:
   fields=value['fieldDifferences']
   if not isinstance(fields,dict) or not all(re.fullmatch('[A-Za-z][A-Za-z0-9_]{0,40}',k) and type(v) is int and 0<=v<=178 for k,v in fields.items()): raise ValueError()
   safe['fieldDifferences']=fields
  if 'dateOnlyExplanation' in value:
   if type(value['dateOnlyExplanation']) is not bool: raise ValueError()
   safe['dateOnlyExplanation']=value['dateOnlyExplanation']
  for key,pattern in (('safeCode','[A-Z][A-Z0-9_]{0,80}'),('errorClass','[A-Za-z]{1,40}')):
   if key in value:
    if not isinstance(value[key],str) or not re.fullmatch(pattern,value[key]): raise ValueError()
    safe[key]=value[key]
  out['probe']=safe
 except (ValueError,TypeError,UnicodeError,KeyError): out['code']='PROBE_OUTPUT_INVALID_DETAILS_SUPPRESSED'
except subprocess.TimeoutExpired: out['code']='PROBE_TIMEOUT'
remaining=subprocess.run(['docker','ps','-aq','--filter','name=^/'+p['name']+'$'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=8,check=False)
out['remainingContainers']=len(remaining.stdout.splitlines()) if remaining.returncode==0 else -1
print(json.dumps(out,sort_keys=True))
'''


def require(ok, code):
    if not ok: raise RuntimeError(code)


def emit(**value):
    print(json.dumps(value,sort_keys=True),flush=True)


def safe_code(error):
    value=str(error)
    return value if re.fullmatch('[A-Z][A-Z0-9_:]{1,99}',value) else 'DETAILS_SUPPRESSED'


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--candidate',type=Path,required=True)
    args=parser.parse_args()
    candidate=args.candidate.resolve()
    require(os.environ.get('BJ_HOST')=='154.8.195.42' and
            os.environ.get('BJ_USER')=='ubuntu' and
            os.environ.get('GITHUB_REPOSITORY')=='GPTJJ/budu' and
            os.environ.get('GITHUB_REF')==BRANCH and
            os.environ.get('GITHUB_RUN_ATTEMPT')=='1' and
            os.environ.get('AUDIT_AUTHORIZATION')=='SKU_GATE_8H_READONLY',
            'DIAGNOSTIC_AUTHORIZATION_INVALID')
    deploy,ledger=prior.candidate_module(candidate)
    os.environ['CANDIDATE_DIR']=str(candidate)
    remote=deploy.core.Remote(Path.home()/'.ssh/id_ed25519')
    state={'result':'GATE_8H_BLOCKED','baselineBefore':'UNVERIFIED','baselineAfter':'UNVERIFIED',
           'ephemeralDiagnosticContainerMutation':'NO','safeToRetryGate8':'NO'}
    try:
        old=prior.baseline(remote,deploy,ledger)
        state['baselineBefore']='PASS'
        assets=json.loads(remote.py(ASSETS))
        require('sku-authority-'+RELEASE in assets and
                'sku-authority-4dee331f45e8cd4dca7f092a60213dbb99c4921c' in assets,
                'V4_V5_EVIDENCE_UNVERIFIED')
        state['incidentAssetsBefore']=assets
        image=remote.inspect(IMAGE,image=True)
        require(image.get('Id')==IMAGE_ID and image.get('Architecture')=='amd64' and
                image.get('Os')=='linux' and
                image.get('Config',{}).get('Labels',{}).get(deploy.core.REVISION)==RELEASE,
                'EXACT_IMAGE_IDENTITY_DRIFT')
        op=deploy.operations.SkuProductionOperations.__new__(deploy.operations.SkuProductionOperations)
        op.remote=remote;op.state={'old':remote.inspect(old)}
        _,hostname=op._worker_database()
        network=op.resolve_database_network(hostname)
        state['imageId']=image['Id'];state['dbNetwork']=network
        emit(event='GATE_8H_PREFLIGHT',result='PASS',imageId=image['Id'],network=network)
        runid=os.environ['GITHUB_RUN_ID']
        require(bool(re.fullmatch('[0-9]{1,20}',runid)),'RUN_ID_INVALID')
        state['ephemeralDiagnosticContainerMutation']='YES'
        value=json.loads(remote.py(REMOTE_PROBE,{'old':old,'hostname':hostname,
            'network':network,'image':IMAGE_ID,'options':OPTIONS,
            'name':'budu-sku-gate8h-parity-'+runid,
            'script':Path(__file__).with_name('sku-gate8h-mapping-probe.mjs').read_text()},timeout=210))
        emit(event='GATE_8H_PARITY',**value)
        require(value.get('remainingContainers')==0,'EPHEMERAL_CONTAINER_REMAINS')
        require(isinstance(value.get('probe'),dict),'PARITY_PROBE_UNVERIFIED')
        proof=value['probe']
        state.update(proof)
        require(state['result']!='GATE_8H_PASS' or
                (value.get('exitCode')==0 and proof.get('readonlyGuard')=='PASS' and
                 proof.get('dateOnlyExplanation') is True), 'PARITY_PROOF_INVALID')
    except Exception as error:
        state['result']='GATE_8H_BLOCKED';state['blockCode']=safe_code(error)
    finally:
        if state['baselineBefore']=='PASS':
            try:
                prior.baseline(remote,deploy,ledger)
                require(json.loads(remote.py(ASSETS))==state.get('incidentAssetsBefore'),
                        'INCIDENT_ASSETS_CHANGED')
                state['baselineAfter']='PASS'
            except Exception as error:
                state['baselineAfter']='FAIL';state['result']='GATE_8H_BLOCKED'
                state['postflightCode']=safe_code(error)
        try:
            remaining=json.loads(remote.py('''import json,subprocess
r=subprocess.run(['docker','ps','-aq','--filter','name=budu-sku-gate8h-'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
print(json.dumps({'count':len(r.stdout.splitlines()) if r.returncode==0 else -1}))'''))
            state['remainingContainers']=remaining['count']
            if remaining['count']!=0:
                state['result']='GATE_8H_BLOCKED';state['blockCode']='EPHEMERAL_CONTAINER_REMAINS'
        except Exception:
            state['result']='GATE_8H_BLOCKED';state['remainingContainers']='UNVERIFIED'
    emit(event='GATE_8H_FINAL',**state)
    return 0 if state['result']=='GATE_8H_PASS' else 1


if __name__=='__main__':
    try: sys.exit(main())
    except Exception as error:
        emit(event='GATE_8H_FATAL',result='GATE_8H_BLOCKED',code=safe_code(error),safeToRetryGate8='NO')
        sys.exit(2)

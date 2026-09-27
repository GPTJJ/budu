#!/usr/bin/env python3
"""Exact-v5 image plan reproduction on a disposable GitHub runner only."""
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
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
RELEASE = '456a07ecd0c9c1ad485d27b67ccf95f3d8bd4fec'
TAG = 'budu-api:sku-authority-' + RELEASE[:12]
WORKER = 'budu-sku-worker-' + RELEASE[:12]
READ_ONLY_OPTIONS = '-c default_transaction_read_only=on -c statement_timeout=120000'


def emit(value):
    print(json.dumps(value, sort_keys=True), flush=True)


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


def command(args, *, env=None, cwd=None, timeout=180):
    started = time.time_ns()
    try:
        result = subprocess.run(args, env=env, cwd=cwd, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout, check=False)
        return {'exitCode':result.returncode,
                'stdout':result.stdout.decode(errors='replace'),
                'stderr':result.stderr.decode(errors='replace'),
                'durationMs':round((time.time_ns()-started)/1_000_000),
                'startNs':started,'endNs':time.time_ns()}
    except subprocess.TimeoutExpired as error:
        return {'exitCode':124,'stdout':(error.stdout or b'').decode(errors='replace'),
                'stderr':'TIMEOUT','durationMs':round((time.time_ns()-started)/1_000_000),
                'startNs':started,'endNs':time.time_ns()}


def safe_class(call):
    stderr = call['stderr']
    if call['exitCode'] == 0:
        return 'NONE','NONE'
    if call['exitCode'] == 124 or 'TIMEOUT' in stderr:
        return 'TIMEOUT','TIMEOUT'
    if re.search(r'(?i)container name.*already in use|Conflict\. The container name',stderr):
        return 'CONTAINER_NAME_CONFLICT','CONTAINER_NAME_CONFLICT'
    if call['exitCode'] == 125:
        return 'DOCKER_CLI_FAILURE','DOCKER_CLI_FAILURE'
    match = re.search(r'\bSKU_RELEASE_[A-Z_]+\b',stderr)
    if match:
        return 'SKU_RELEASE_SAFE_CODE',match.group(0)
    if re.search(r'PrismaClient|\bP[0-9]{4}\b|prisma\.',stderr,re.I):
        return 'PRISMA_ERROR','PRISMA_ERROR'
    if re.search(r'ERR_MODULE|Cannot find module|MODULE_NOT_FOUND',stderr):
        return 'MODULE_OR_IMPORT_FAILURE','MODULE_OR_IMPORT_FAILURE'
    return 'NODE_PROCESS_FAILURE' if call['exitCode'] != 125 else 'UNKNOWN','UNCLASSIFIED'


def failure_phase(call, stderr_class, code):
    if call['exitCode'] == 0:
        return 'NONE'
    text = call['stderr']
    if 'Invalid URL' in text or 'ERR_INVALID_URL' in text:
        return 'DATABASE_URL_PARSE'
    if stderr_class == 'MODULE_OR_IMPORT_FAILURE':
        return 'BEFORE_MAIN'
    if re.search(r'PrismaClientConstructor|PrismaClientInitializationError',text):
        return 'PRISMA_CLIENT_INIT'
    if code == 'SKU_RELEASE_DATABASE_MISMATCH':
        return 'MAIN_DATABASE_PROBE'
    if code in ('SKU_RELEASE_ONLINE_DRIFT','SKU_RELEASE_POS_ACTIVE_DRIFT',
                'SKU_RELEASE_CHANNEL_ID_DRIFT','SKU_RELEASE_ANY_CHANNEL_DRIFT',
                'SKU_RELEASE_MAPPING_BASELINE_DRIFT','SKU_RELEASE_COUNTS_DRIFT',
                'SKU_RELEASE_IDENTITY_DRIFT'):
        return 'PLAN_ASSERTION'
    if stderr_class == 'PRISMA_ERROR':
        return 'PLAN_TRANSACTION'
    return 'UNKNOWN'


def load_candidate(candidate):
    require(candidate.is_dir(), 'CANDIDATE_CHECKOUT_MISSING')
    spec = importlib.util.spec_from_file_location(
        'sku_gate8e_v5',candidate/'scripts/deploy-prod-sku-authority.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    require(module.identity(candidate)[0] == RELEASE,'FROZEN_V5_IDENTITY_DRIFT')
    return module


def disposable_state(audit_root, candidate):
    result = command(['node',str(audit_root/'scripts/sku-gate8e-disposable-db.mjs'),'check'],
                     env={**os.environ,'CANDIDATE_DIR':str(candidate)},cwd=audit_root)
    require(result['exitCode'] == 0,'DISPOSABLE_DB_CHECK_FAILED')
    state = json.loads(result['stdout'])
    require(state['pgMajor'] == 16 and state['ledger'] == '85/0' and
            state['skuTables'] == 'ABSENT' and state['readOnlyRole'] is True and
            (state['products'],state['online'],state['history']) == (178,153,1),
            'DISPOSABLE_LEDGER_OR_FIXTURE_INVALID')
    return state


def docker_events(name, since_ns, until_ns):
    event_run = command(['docker','events','--since',str(since_ns//1_000_000_000-1),
                         '--until',str(until_ns//1_000_000_000+1),
                         '--filter','container='+name,'--format','{{json .}}'], timeout=20)
    require(event_run['exitCode'] == 0,'DOCKER_EVENTS_UNAVAILABLE')
    events = []
    for line in event_run['stdout'].splitlines():
        event = json.loads(line)
        nano = event.get('timeNano',0)
        if since_ns <= nano <= until_ns:
            events.append(event.get('Action') or event.get('status'))
    return events


def container_call(plan_url, mode, name, db_probe_script):
    args = ['docker','run','--rm','--name',name,'--network','host',
            '-e','DATABASE_URL='+plan_url,
            '-e','SKU_RELEASE_CONTROLLER=sku-authority-schema1',
            '-e','SKU_RELEASE_TEST_ONLY=YES',
            '-e','GIT_SHA='+RELEASE,
            '-e','PGOPTIONS='+READ_ONLY_OPTIONS,
            '--entrypoint','node',TAG]
    if mode == 'db-probe':
        args += ['--input-type=module','-e',db_probe_script]
    else:
        args += ['/app/scripts/sku-release-apply.mjs','plan']
    return command(args,timeout=180)


def run(audit_root, candidate, archive):
    require(os.environ.get('GITHUB_REPOSITORY') == 'GPTJJ/budu' and
            os.environ.get('GITHUB_REF') ==
            'refs/heads/codex/sku-gate8e-runtime-reproduction',
            'AUDIT_RUNNER_IDENTITY_INVALID')
    require(os.environ.get('BJ_HOST') is None and
            os.environ.get('BJ_USER') is None and
            not (Path.home()/'.ssh/id_ed25519').exists(),
            'PRODUCTION_CREDENTIAL_PRESENT')
    plan_url = os.environ.get('PLAN_DATABASE_URL','')
    parsed = urlsplit(plan_url)
    require(parsed.username == 'sku_plan_ro' and parsed.hostname in ('localhost','127.0.0.1')
            and re.fullmatch(r'sku_authority_test_[a-z0-9_]+',parsed.path.strip('/')),
            'PLAN_DATABASE_TARGET_INVALID')
    deploy = load_candidate(candidate)
    before = disposable_state(audit_root,candidate)
    require(archive.is_file(),'EXACT_IMAGE_ARCHIVE_MISSING')
    artifact = deploy.core.artifact(archive,RELEASE,candidate)
    require(artifact['imageReference'] == TAG,'IMAGE_TAG_MISMATCH')
    loaded = command(['docker','load','-i',str(archive)],timeout=300)
    require(loaded['exitCode'] == 0,'RUNNER_IMAGE_LOAD_FAILED')
    image_result = command(['docker','image','inspect',TAG],timeout=30)
    require(image_result['exitCode'] == 0,'RUNNER_IMAGE_INSPECT_FAILED')
    image = json.loads(image_result['stdout'])[0]
    revision = image['Config']['Labels'].get('org.opencontainers.image.revision')
    require(image['Architecture'] == 'amd64' and image['Os'] == 'linux' and
            revision == RELEASE and image['RootFS']['Layers'] == artifact['rootfsDiffIds'],
            'EXACT_IMAGE_IDENTITY_INVALID')
    emit({'event':'GATE_8E_EXACT_IMAGE','imageId':image['Id'],
          'revision':revision,'arch':image['Architecture'],'os':image['Os'],
          'archiveHash':artifact['archiveHash'],'archiveBytes':artifact['archive']})
    emit({'event':'GATE_8E_DB_BEFORE',**before})
    plan_env = {**os.environ,'DATABASE_URL':plan_url,
                'SKU_RELEASE_CONTROLLER':'sku-authority-schema1',
                'SKU_RELEASE_TEST_ONLY':'YES','GIT_SHA':RELEASE,
                'PGOPTIONS':READ_ONLY_OPTIONS}
    host = command(['node','scripts/sku-release-apply.mjs','plan'],
                   cwd=candidate,env=plan_env,timeout=180)
    host_class,host_code = safe_class(host)
    emit({'event':'GATE_8E_E1_HOST_NATIVE','result':'PASS' if host['exitCode']==0 else 'FAIL',
          'exitCode':host['exitCode'],'stderrClass':host_class,'stderrCode':host_code,
          'stderr':host['stderr'] if host['exitCode'] else '',
          'durationMs':host['durationMs'],
          'stdoutHash':hashlib.sha256(host['stdout'].encode()).hexdigest()
              if host['exitCode']==0 else None})
    probe_script = deploy.core.APPLICATION_DB_PROBE_SCRIPT
    probe = container_call(plan_url,'db-probe','gate8e-db-probe-'+str(os.getpid()),probe_script)
    probe_class,probe_code = safe_class(probe)
    emit({'event':'GATE_8E_E2_CONTAINER_DB_PROBE',
          'result':'PASS' if probe['exitCode']==0 and probe['stdout']=='DB_READ_OK\n' else 'FAIL',
          'exitCode':probe['exitCode'],'stderrClass':probe_class,'stderrCode':probe_code,
          'stderr':probe['stderr'] if probe['exitCode'] else ''})
    alone_name = 'gate8e-plan-alone-'+str(os.getpid())
    alone = container_call(plan_url,'plan',alone_name,probe_script)
    alone_class,alone_code = safe_class(alone)
    alone_events = docker_events(alone_name,alone['startNs'],alone['endNs'])
    emit({'event':'GATE_8E_E3_PLAN_ALONE',
          'result':'PASS' if alone['exitCode']==0 else 'FAIL',
          'exitCode':alone['exitCode'],'stderrClass':alone_class,
          'stderrCode':alone_code,'stderr':alone['stderr'] if alone['exitCode'] else '',
          'durationMs':alone['durationMs'],'dockerEvents':alone_events,
          'stdoutHash':hashlib.sha256(alone['stdout'].encode()).hexdigest()
              if alone['exitCode']==0 else None})
    first = container_call(plan_url,'db-probe',WORKER,probe_script)
    second = container_call(plan_url,'plan',WORKER,probe_script)
    second_class,second_code = safe_class(second)
    second_events = docker_events(WORKER,second['startNs'],second['endNs'])
    emit({'event':'GATE_8E_E4_NAME_REUSE',
          'firstDbProbe':'PASS' if first['exitCode']==0 and first['stdout']=='DB_READ_OK\n' else 'FAIL',
          'secondPlan':'PASS' if second['exitCode']==0 else 'FAIL',
          'nameReuseConflict':second_class=='CONTAINER_NAME_CONFLICT',
          'secondContainerCreated':'create' in second_events,
          'secondContainerStarted':'start' in second_events,
          'firstExitCode':first['exitCode'],'secondExitCode':second['exitCode'],
          'secondStderrClass':second_class,'secondStderrCode':second_code,
          'secondStderr':second['stderr'] if second['exitCode'] else '',
          'secondDockerEvents':second_events})
    pass_count=fail_count=name_conflict=plan_process_fail=0
    failures=[]
    all_events = [*alone_events,*second_events]
    for index in range(10):
        iteration_probe = container_call(plan_url,'db-probe',WORKER,probe_script)
        iteration_plan = container_call(plan_url,'plan',WORKER,probe_script)
        category,code = safe_class(iteration_plan)
        events = docker_events(WORKER,iteration_plan['startNs'],iteration_plan['endNs'])
        all_events.extend(events)
        ok = (iteration_probe['exitCode']==0 and
              iteration_probe['stdout']=='DB_READ_OK\n' and iteration_plan['exitCode']==0)
        pass_count += ok
        fail_count += not ok
        name_conflict += category=='CONTAINER_NAME_CONFLICT'
        plan_process_fail += iteration_plan['exitCode'] not in (0,125)
        if not ok:
            failures.append({'iteration':index+1,
              'probeExitCode':iteration_probe['exitCode'],
              'planExitCode':iteration_plan['exitCode'],
              'stderrClass':category,'stderrCode':code,
              'stderr':iteration_plan['stderr'],
              'planContainerCreated':'create' in events,
              'planContainerStarted':'start' in events})
    emit({'event':'GATE_8E_E5_REPEATED_SEQUENCE','iterations':10,
          'pass':pass_count,'fail':fail_count,'nameConflict':name_conflict,
          'planProcessFail':plan_process_fail,'failures':failures,
          'dockerLifecycleCounts':{key:all_events.count(key) for key in
            ('create','start','die','destroy')}})
    after = disposable_state(audit_root,candidate)
    require(after['fixtureDigest']==before['fixtureDigest'] and
            after['ledger']=='85/0' and after['skuTables']=='ABSENT',
            'PLAN_MUTATED_DISPOSABLE_DB')
    emit({'event':'GATE_8E_DB_AFTER','unchanged':True,**after})
    e2_ok = probe['exitCode']==0 and probe['stdout']=='DB_READ_OK\n'
    e3_ok = alone['exitCode']==0
    e4_ok = first['exitCode']==0 and second['exitCode']==0
    if host['exitCode']==0 and not e3_ok:
        root_class = ('PRISMA_85_RUNTIME_INCOMPATIBILITY' if
                      alone_class=='PRISMA_ERROR' else 'EXACT_IMAGE_RUNTIME_FAILURE')
        root_detail = 'HOST_PASS_EXACT_IMAGE_PLAN_FAIL'
    elif e3_ok and not e4_ok and second_class=='CONTAINER_NAME_CONFLICT':
        root_class='WORKER_CONTAINER_LIFECYCLE_RACE'
        root_detail='PLAN_ALONE_PASS_SAME_NAME_SECOND_CREATE_CONFLICT'
    elif e3_ok and name_conflict:
        root_class='WORKER_CONTAINER_LIFECYCLE_RACE'
        root_detail='REPEATED_SAME_NAME_CONFLICT'
    elif host['exitCode']!=0 and not e3_ok:
        root_class='SKU_PLAN_PROCESS_FAILURE'
        root_detail='HOST_AND_IMAGE_PLAN_FAIL'
    elif e3_ok and (not e2_ok or plan_process_fail or fail_count):
        root_class='SKU_PLAN_PROCESS_FAILURE'
        root_detail='ISOLATED_LIFECYCLE_OR_PLAN_PROCESS_FAILURE'
    else:
        root_class='PRODUCTION_SPECIFIC_RUNTIME_DIFFERENCE_NOT_YET_ISOLATED'
        root_detail='HOST_IMAGE_AND_10_LIFECYCLE_REPETITIONS_PASS'
    emit({'result':'GATE_8E_DIAGNOSIS_INCOMPLETE' if root_class.endswith('NOT_YET_ISOLATED')
          else 'GATE_8E_PASS',
          'rootCauseClass':root_class,'rootCauseDetail':root_detail,
          'exactV5PrismaOnLedger85':'PASS' if e3_ok else 'FAIL',
          'processFailurePhase':failure_phase(alone,alone_class,alone_code),
          'safeToRetryGate8':'NO','productionAccess':'NONE','productionMutation':'NONE'})
    return 0


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate',type=Path,required=True)
    parser.add_argument('--archive',type=Path,required=True)
    args=parser.parse_args()
    return run(Path(__file__).resolve().parent.parent,args.candidate.resolve(),
               args.archive.resolve())


if __name__=='__main__':
    try: sys.exit(main())
    except (RuntimeError,ValueError,subprocess.TimeoutExpired) as error:
        code=str(error) if isinstance(error,RuntimeError) else 'AUDIT_EVIDENCE_INVALID'
        if not re.fullmatch(r'[A-Z0-9_]{1,100}',code): code='AUDIT_EVIDENCE_UNAVAILABLE'
        emit({'result':'GATE_8E_BLOCKED','code':code,
              'productionAccess':'NONE','productionMutation':'NONE'})
        sys.exit(1)

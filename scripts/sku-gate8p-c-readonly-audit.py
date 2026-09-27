#!/usr/bin/env python3
"""Gate 8P-C evidence only; never uploads or runs an image on production."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

sys.dont_write_bytecode = True
RELEASE = '456a07ecd0c9c1ad485d27b67ccf95f3d8bd4fec'
OLD = '5ad27a06d731fbc94de5ae3776060b4350b886e8'
V4 = '4dee331f45e8cd4dca7f092a60213dbb99c4921c'
HOST = '154.8.195.42'
USER = 'ubuntu'
SSH_KEY = Path.home()/'.ssh/id_ed25519'


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


def load_candidate(candidate):
    require(candidate.is_dir(), 'V5_CANDIDATE_CHECKOUT_MISSING')
    spec = importlib.util.spec_from_file_location(
        'sku_gate8pc_v5', candidate/'scripts/deploy-prod-sku-authority.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    require(module.identity(candidate)[0] == RELEASE, 'V5_CANDIDATE_IDENTITY_DRIFT')
    return module


def ssh_read(args):
    ssh = ['ssh', '-i', str(SSH_KEY), '-o', 'BatchMode=yes',
           '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
           '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=12',
           f'{USER}@{HOST}']
    result = subprocess.run(ssh + [shlex.join(args)],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=90, check=False)
    require(result.returncode == 0, 'PRODUCTION_READ_ONLY_EVIDENCE_UNAVAILABLE')
    return result.stdout


REMOTE_READ_ONLY = r'''
import json,os,pathlib,subprocess
RELEASE='456a07ecd0c9c1ad485d27b67ccf95f3d8bd4fec'
V4='4dee331f45e8cd4dca7f092a60213dbb99c4921c'
def read(args):
    result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,check=False,text=True)
    if result.returncode: raise SystemExit('PRODUCTION_READ_ONLY_COMMAND_FAILED')
    return result.stdout.strip()
short=RELEASE[:12]
v4short=V4[:12]
names=set(read(['docker','ps','-a','--format','{{.Names}}']).splitlines())
tags=set(read(['docker','image','ls','--format','{{.Repository}}:{{.Tag}}']).splitlines())
candidate='budu-prod-'+short+'-sku-authority'
worker='budu-sku-worker-'+short
runtime='budu-api:sku-authority-'+short
migration='budu-api:sku-migration-'+short
v4runtime='budu-api:sku-authority-'+v4short
v4migration='budu-api:sku-migration-'+v4short
root='/opt/budu/.rollback-assets/sku-authority-'+RELEASE
v4root='/opt/budu/.rollback-assets/sku-authority-'+V4
df=read(['df','-Pk','/']).splitlines()
if len(df)!=2: raise SystemExit('DF_FORMAT_INVALID')
fields=df[1].split()
if len(fields)<6 or not fields[4].endswith('%'): raise SystemExit('DF_FORMAT_INVALID')
total,used,available=(int(fields[i])*1024 for i in (1,2,3))
pointer=pathlib.Path('/opt/budu/.current-sha').read_text().strip()
print(json.dumps({
  'productionShaPointer':pointer,
  'v5CandidateContainer':candidate in names,
  'v5WorkerContainer':worker in names,
  'v5RuntimeImage':runtime in tags,
  'v5MigrationImage':migration in tags,
  'v5RollbackRoot':os.path.lexists(root),
  'v4IncidentRoot':os.path.isdir(v4root),
  'v4RuntimeImage':v4runtime in tags,
  'v4MigrationImage':v4migration in tags,
  'releaseLock':os.path.lexists('/run/lock/budu-transfer-cas-release'),
  'disk':{'totalBytes':total,'usedBytes':used,'availableBytes':available,
          'currentUsagePercent':int(fields[4][:-1])}
},sort_keys=True))
'''


def production_state():
    require(os.environ.get('BJ_HOST') == HOST and os.environ.get('BJ_USER') == USER,
            'PRODUCTION_TARGET_IDENTITY_INVALID')
    require(SSH_KEY.is_file(), 'PINNED_SSH_IDENTITY_UNAVAILABLE')
    tooling = {}
    for name in ('timeout','docker','python3','sh','cat','df','curl','sudo'):
        output = ssh_read(['sh','-lc',
                           f'if command -v {name} >/dev/null 2>&1; '
                           'then printf PRESENT; else printf ABSENT; fi'])
        require(output in (b'PRESENT',b'ABSENT'), 'HOST_TOOLING_EVIDENCE_INVALID')
        tooling[name] = output == b'PRESENT'
    state = json.loads(ssh_read(['sudo', '-n', 'python3', '-c', REMOTE_READ_ONLY]))
    state['tooling'] = tooling
    return state


def audit(candidate, runtime_archive, migration_archive):
    deploy = load_candidate(candidate)
    require(runtime_archive.is_file() and migration_archive.is_file(),
            'EXACT_ARCHIVES_MISSING')
    runtime = deploy.core.artifact(runtime_archive, RELEASE, candidate)
    migration = deploy.migration_artifact(migration_archive, RELEASE, candidate)
    state = production_state()
    print(json.dumps({'event':'GATE_8P_C_PRODUCTION_READ_ONLY_STATE', **state},
                     sort_keys=True), flush=True)
    require(state['productionShaPointer'] == OLD, 'PRODUCTION_BASELINE_DRIFT')
    art = {
        'candidateSha': RELEASE,
        'runtimeArchiveBytes': runtime['archive'],
        'migrationArchiveBytes': migration['archive'],
        'runtimeArchiveHash': runtime['archiveHash'],
        'migrationArchiveHash': migration['archiveHash'],
        'runtime': {key:runtime[key] for key in ('blobs','expanded','largest')},
        'migration': {key:migration[key] for key in ('blobs','expanded','largest')},
    }
    print(json.dumps({'event':'GATE_8P_C_EXACT_V5_ARTIFACT', **art},
                     sort_keys=True), flush=True)
    no_collision = not any(state[key] for key in (
        'v5CandidateContainer','v5WorkerContainer','v5RuntimeImage',
        'v5MigrationImage','v5RollbackRoot','releaseLock'))
    tools_ok = all(value is True for value in state['tooling'].values())
    v4_preserved = all(state[key] for key in (
        'v4IncidentRoot','v4RuntimeImage','v4MigrationImage'))
    if not (no_collision and tools_ok and v4_preserved):
        print(json.dumps({'result':'GATE_8P_C_BLOCKED','reason':'COLLISION_TOOL_OR_V4_EVIDENCE',
                          'productionMutation':'NONE'},sort_keys=True))
        return 1
    disk = state['disk']
    try:
        budget = deploy.combined_budget(disk['usedBytes'],disk['availableBytes'],
                                        runtime,migration)
    except deploy.core.GateError as error:
        code = str(error)
        require(bool(re.fullmatch(r'[A-Z0-9_:]+',code)),
                'DISK_BUDGET_FAILURE_CODE_INVALID')
        print(json.dumps({'result':'GATE_8P_C_BLOCKED','diskBudget':'FAIL',
                          'code':code,'productionMutation':'NONE'},sort_keys=True))
        return 1
    print(json.dumps({'result':'GATE_8P_C_PASS','candidateSha':RELEASE,
                      'diskBudget':'PASS','budgetAuthority':'v5 combined_budget -> core.disk_budget',
                      **budget,'productionMutation':'NONE'},sort_keys=True))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate',type=Path,required=True)
    parser.add_argument('--runtime-archive',type=Path,required=True)
    parser.add_argument('--migration-archive',type=Path,required=True)
    args = parser.parse_args()
    return audit(args.candidate.resolve(),args.runtime_archive.resolve(),
                 args.migration_archive.resolve())


if __name__ == '__main__':
    try: sys.exit(main())
    except (RuntimeError,ValueError,subprocess.TimeoutExpired) as error:
        code = str(error) if isinstance(error,RuntimeError) else 'READ_ONLY_EVIDENCE_INVALID'
        if not re.fullmatch(r'[A-Z0-9_]+',code): code = 'READ_ONLY_EVIDENCE_UNAVAILABLE'
        print(json.dumps({'result':'GATE_8P_C_BLOCKED','code':code,
                          'productionMutation':'NONE'},sort_keys=True))
        sys.exit(1)

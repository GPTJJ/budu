#!/usr/bin/env python3
"""SKU-only schema-aware release adapter; build-only modes never reach SSH."""
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import time

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name,SCRIPTS/file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


contract = load('sku_contract','sku-release-contract.py')
operations = load('sku_operations','sku-release-operations.py')
core = operations.core

IMAGE_LOAD_MIN_TIMEOUT_SECONDS = 600
IMAGE_LOAD_MAX_TIMEOUT_SECONDS = 1200
IMAGE_LOAD_BASE_SECONDS = 180
IMAGE_LOAD_ASSUMED_BYTES_PER_SECOND = 1024 * 1024
IMAGE_LOAD_REMOTE_GRACE_SECONDS = 60



def old_v2_hash(repo):
    return hashlib.sha256(subprocess.check_output(['git','-C',str(repo),'show',
        contract.PRODUCTION_SHA+':server/v2.js'],stderr=subprocess.DEVNULL)).hexdigest()


def identity(repo):
    release, baseline, after = contract.validate_identity(repo)
    operations.configure_core(old_v2_hash(repo))
    # Preserve the installed Transfer CAS section exactly; schema change is
    # admitted only through this SKU profile, never post-transfer.
    transfer_source = subprocess.check_output(['git','-C',str(repo),'show',
        core.TRANSFER_INSTALLED_SHA+':server/v2.js'],stderr=subprocess.DEVNULL)
    core.require(core.transfer_cas_section((Path(repo)/'server/v2.js').read_bytes()) ==
                 core.transfer_cas_section(transfer_source),
                 'TRANSFER_CAS_RUNTIME_CHANGED')
    return release, baseline, after


def imported_controller_code():
    """One remote process owns all mutations, cutover and rollback.

    Only reviewed source bytes are transferred in memory. No release checkout,
    database credential, or secret file is copied to the production host.
    """
    return r'''import importlib.util,json,os,pathlib,re,signal,sys,tempfile
payload=json.load(sys.stdin)
result={'result':'SKU_RELEASE_ABORTED','code':'REMOTE_CONTROLLER_FAILURE_DETAILS_SUPPRESSED'}
try:
 with tempfile.TemporaryDirectory(prefix='sku-release-',dir='/dev/shm') as temp:
  directory=pathlib.Path(temp)
  for name,source in payload['sources'].items():
   path=directory/name
   path.write_text(source)
   path.chmod(0o600)
  spec=importlib.util.spec_from_file_location('sku_ops',directory/'sku-release-operations.py')
  ops=importlib.util.module_from_spec(spec);spec.loader.exec_module(ops)
  ops.configure_core(payload['oldV2Hash'])
  op=ops.SkuProductionOperations(payload['art'],payload['migrationArt'],payload['baseline'],payload['after'],
     payload['helper'],payload['oldId'],payload['routeHash'],payload['readiness'],payload['authorityMounts'])
  def interrupted(*_): raise ops.core.GateError('INTERRUPTED')
  for sig in (signal.SIGHUP,signal.SIGTERM,signal.SIGINT): signal.signal(sig,interrupted)
  release_controller=ops.controller.ReleaseController(op,op.manifest)
  try:
   status=release_controller.run()
   result={'result':status,'releaseSha':payload['art']['release'],
           'businessRuntimeSha':ops.contract.BUSINESS_SHA,'writer':1,
           'migrationApplied':86,'rollbackPhase':'POST_CUTOVER'}
  except BaseException as error:
   primary=release_controller.primary_failure if release_controller.primary_failure is not None else error
   code=str(primary) if isinstance(primary,(ops.core.GateError,ops.contract.ReleaseBlocked,
                                             ops.controller.DataIntegrityError)) else ''
   failure_code=code if re.fullmatch(r'[A-Z][A-Z0-9_]{0,100}',code) else 'UNEXPECTED_ERROR_DETAILS_SUPPRESSED'
   details={'failureStage':release_controller.stage,
            'failureCode':failure_code,'failureClass':type(primary).__name__,
            'rollbackOutcome':release_controller.rollback_outcome}
   try:
    phase=ops.contract.load_manifest(op.manifest)['phase']
    if release_controller.rollback_outcome=='POST_CUTOVER_DATA_INTEGRITY_HOLD' and phase=='DATA_INTEGRITY_HOLD':
     result={'result':'POST_CUTOVER_DATA_INTEGRITY_HOLD','code':'SKU_DATA_INTEGRITY_HOLD'}
    elif release_controller.rollback_outcome=='POST_CUTOVER_SAFE_DEGRADED' and phase=='POST_CUTOVER':
     result={'result':'SKU_RELEASE_ROLLED_BACK_SAFE_DEGRADED','code':'SKU_RUNTIME_ROLLBACK'}
    elif release_controller.rollback_outcome=='PRE_CUTOVER_RESTORED' and phase=='PRE_CUTOVER':
     result={'result':'SKU_RELEASE_ROLLED_BACK_PRE_CUTOVER','code':'SKU_PRE_CUTOVER_ROLLBACK'}
    else:
     result={'result':'SKU_RELEASE_ABORTED','code':'ROLLBACK_UNVERIFIED_MANUAL_ATTENTION_REQUIRED'}
   except BaseException:
    if release_controller.stage in ('CONTROLLER_PREFLIGHT','PRE_CUTOVER_MANIFEST') and not op.manifest.exists():
     details['rollbackOutcome']='NOT_REQUIRED_PRE_MUTATION'
     result={'result':'SKU_RELEASE_ABORTED','code':failure_code}
    else:
     result={'result':'SKU_RELEASE_ABORTED','code':'ROLLBACK_UNVERIFIED_MANUAL_ATTENTION_REQUIRED'}
   result.update(details)
except BaseException:
 result={'result':'SKU_RELEASE_ABORTED','code':'REMOTE_CONTROLLER_FAILURE_DETAILS_SUPPRESSED'}
finally:
 try: os.rmdir(payload['lock'])
 except BaseException: result={'result':'SKU_RELEASE_ABORTED','code':'RELEASE_LOCK_UNVERIFIED'}
print(json.dumps(result,sort_keys=True))
'''


def migration_artifact(archive, release, repo):
    original = core.IMAGE_PREFIX
    try:
        core.IMAGE_PREFIX = 'sku-migration-'
        return core.artifact(archive,release,repo)
    finally:
        core.IMAGE_PREFIX = original


def resolve_migration_image(remote, art):
    original = core.IMAGE_PREFIX
    try:
        core.IMAGE_PREFIX = 'sku-migration-'
        return core.resolve_loaded_image(remote,art)
    finally:
        core.IMAGE_PREFIX = original


def combined_budget(used, available, art, migration_art):
    return core.disk_budget(used,available,
        max(art['archive'],migration_art['archive']),
        art['blobs']+migration_art['blobs'],
        art['expanded']+migration_art['expanded'],
        max(art['largest'],migration_art['largest']))


def image_load_timeout_seconds(archive_bytes):
    core.require(isinstance(archive_bytes,int) and 0 < archive_bytes <= core.MAX_ARCHIVE,
                 'SKU_IMAGE_ARCHIVE_SIZE_INVALID')
    estimated = IMAGE_LOAD_BASE_SECONDS + math.ceil(
        archive_bytes / IMAGE_LOAD_ASSUMED_BYTES_PER_SECOND)
    return min(IMAGE_LOAD_MAX_TIMEOUT_SECONDS,
               max(IMAGE_LOAD_MIN_TIMEOUT_SECONDS,estimated))


def load_image_archive(remote, source, source_art, kind):
    core.require(kind in ('runtime','migration'),'SKU_IMAGE_KIND_INVALID')
    code = 'RUNTIME' if kind == 'runtime' else 'MIGRATION'
    core.require(source.stat().st_size == source_art['archive'],
                 'SKU_'+code+'_IMAGE_ARCHIVE_SIZE_DRIFT')
    with source.open('rb') as stream:
        core.require(core.file_hash(stream) == source_art['archiveHash'],
                     'SKU_ARTIFACT_CHANGED')
        stream.seek(0)
        timeout_seconds = image_load_timeout_seconds(source_art['archive'])
        print(json.dumps({'event':'SKU_IMAGE_LOAD_START','kind':kind,
                          'archiveBytes':source_art['archive'],
                          'timeoutSeconds':timeout_seconds},sort_keys=True),flush=True)
        started = time.monotonic()
        remote_command = ('timeout --signal=TERM --kill-after=30s '+
                          str(timeout_seconds)+'s docker load')
        try:
            loaded = subprocess.run(remote.ssh + [remote_command],stdin=stream,
                                    stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                                    timeout=timeout_seconds + IMAGE_LOAD_REMOTE_GRACE_SECONDS,
                                    check=False)
        except subprocess.TimeoutExpired:
            print(json.dumps({'event':'SKU_IMAGE_LOAD_TIMEOUT','kind':kind,
                              'timeoutSeconds':timeout_seconds,
                              'boundary':'LOCAL_AFTER_REMOTE_GRACE'},sort_keys=True),flush=True)
            raise core.GateError('SKU_'+code+'_IMAGE_LOAD_TIMEOUT_AUDIT_REQUIRED') from None
        except OSError:
            raise core.GateError('SKU_'+code+'_IMAGE_LOAD_TRANSPORT_UNAVAILABLE') from None
        elapsed = max(0,int(time.monotonic()-started))
        if loaded.returncode in (124,137):
            print(json.dumps({'event':'SKU_IMAGE_LOAD_TIMEOUT','kind':kind,
                              'elapsedSeconds':elapsed,
                              'timeoutSeconds':timeout_seconds,
                              'boundary':'REMOTE'},sort_keys=True),flush=True)
            raise core.GateError('SKU_'+code+'_IMAGE_LOAD_TIMEOUT_AUDIT_REQUIRED')
        if loaded.returncode != 0:
            print(json.dumps({'event':'SKU_IMAGE_LOAD_FAILED','kind':kind,
                              'elapsedSeconds':elapsed,
                              'returnCode':loaded.returncode},sort_keys=True),flush=True)
            raise core.GateError('SKU_'+code+'_IMAGE_LOAD_FAILED')
        print(json.dumps({'event':'SKU_IMAGE_LOAD_COMPLETE','kind':kind,
                          'elapsedSeconds':elapsed},sort_keys=True),flush=True)


def pre_mutation_readiness(remote, repo, art, migration_art, baseline):
    """Only read the running old application and host; never create release state."""
    state = core.preflight(remote,art,baseline)
    timeout_tool = remote.run(['sh','-lc',
        'command -v timeout >/dev/null 2>&1 && printf TIMEOUT_OK'])
    core.require(timeout_tool == b'TIMEOUT_OK','SKU_TRANSPORT_TIMEOUT_TOOL_UNAVAILABLE')
    budget = combined_budget(state['diskUsed'],state['diskAvailable'],art,migration_art)
    core.application_db_probe(remote,state['name'],'OLD_APPLICATION_REAL_DB_PROBE_FAILED')
    mounts = core.mount_readability(remote,state['name'])
    probe = (Path(repo)/'scripts/sku-release-snapshot-probe.mjs').read_text()
    args = ['docker','exec','-w','/app','-e',
            'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=120000 -c temp_file_limit=0',
            state['name'],'node','--input-type=module','-e',probe]
    snapshot = remote.run(args,timeout=150)
    checked = subprocess.run(['node',str(Path(repo)/'scripts/sku-release-readiness-plan.mjs')],
                             input=snapshot,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                             timeout=30,check=False)
    core.require(checked.returncode == 0,'SKU_PRE_MUTATION_MAPPING_DRIFT')
    try: identity = json.loads(checked.stdout)
    except (ValueError,UnicodeDecodeError): raise core.GateError('SKU_READINESS_RESULT_INVALID') from None
    core.require(identity.get('counts') == {'total':178,'BD':89,'TP':89,
                 'missingOldSku':33,'aliases':145} and
                 identity.get('posActive') == 87 and
                 identity.get('anyChannelEnabled') == 113 and
                 identity.get('online') == 153 and
                 all(re.fullmatch(r'[0-9a-f]{64}',identity.get(key,'')) for key in
                     ('mappingDigest','onlineDigest','idsDigest','snapshotId','channelDigest')),
                 'SKU_READINESS_RESULT_INVALID')
    # Prove that the old writer and route stayed on the same authority through
    # the snapshot, while the subsequent post-stop frozen plan closes the race.
    db = remote.db()
    core.validate_database(db,baseline)
    core.writer_check(remote.containers(),db,[state['name']])
    core.require(remote.inspect(state['name'])['Id'] == state['old']['Id'] and
                 remote.routes() == (state['template'],state['active']),
                 'SKU_AUTHORITY_CHANGED_DURING_READINESS')
    return {'state':state,'identity':identity,'mounts':mounts,'budget':budget}


def deploy(remote, repo, archive, migration_archive, art, migration_art, baseline, after, release):
    readiness = pre_mutation_readiness(remote,repo,art,migration_art,baseline)
    state = readiness['state']
    core.require(art['release'] == release,'SKU_RELEASE_SHA_MISMATCH')
    core.require(not remote.run(['docker','ps','-aq','--filter',
        'name=^/budu-prod-'+release[:12]+core.CONTAINER_SUFFIX+'$']).strip(),
        'SKU_CANDIDATE_NAME_EXISTS')
    core.require(not remote.run(['docker','images','-q',art['imageReference']]).strip(),
        'SKU_CANDIDATE_TAG_EXISTS')
    core.require(not remote.run(['docker','images','-q',migration_art['imageReference']]).strip(),
        'SKU_MIGRATION_TAG_EXISTS')
    remote.py('import os; os.mkdir(%r,0o700)' % core.LOCK)
    handoff = False
    try:
        load_image_archive(remote,archive,art,'runtime')
        load_image_archive(remote,migration_archive,migration_art,'migration')
        image = core.resolve_loaded_image(remote,art)
        art['loadedDockerImageId'] = image['Id']
        migration_image = resolve_migration_image(remote,migration_art)
        migration_art['loadedDockerImageId'] = migration_image['Id']
        sql_hash = remote.run(['docker','run','--rm','--network','none','--entrypoint','sha256sum',
            migration_art['imageReference'],
            '/app/prisma/migrations/'+contract.MIGRATION_NAME+'/migration.sql']).decode().split()[0]
        core.require(sql_hash == contract.MIGRATION_SHA256,'SKU_MIGRATION_IMAGE_SQL_MISMATCH')
        # Re-run the full baseline after import, before the writer is stopped.
        state = core.preflight(remote,art,baseline,imported=True)
        core.require(state['old']['Id'] == readiness['state']['old']['Id'] and
                     state['template'] == readiness['state']['template'] and
                     state['active'] == readiness['state']['active'],
                     'SKU_AUTHORITY_CHANGED_AFTER_READINESS')
        source_names = ('deploy-prod-transfer-cas.py','sku-release-contract.py',
                        'sku-release-controller.py','sku-release-operations.py')
        payload = {'sources':{name:(SCRIPTS/name).read_text() for name in source_names},
                   'art':art,'migrationArt':migration_art,'baseline':baseline,'after':after,
                   'helper':(SCRIPTS/'clone-production-container.py').read_text(),
                   'oldId':state['old']['Id'],
                   'routeHash':core.digest(state['template'].encode()),
                   'readiness':readiness['identity'],'authorityMounts':readiness['mounts'],
                   'oldV2Hash':old_v2_hash(repo),'lock':core.LOCK}
        handoff = True
        raw = remote.py(imported_controller_code(),payload,timeout=1500)
        output = json.loads(raw)
        print(json.dumps(output,sort_keys=True),flush=True)
        core.require(output.get('result') == 'SKU_RELEASE_DEPLOYED',
                     output.get('code','SKU_REMOTE_RESULT_INVALID'))
    finally:
        if not handoff:
            # Do not try this after handoff: the remote process may still own it.
            remote.py('import os; os.rmdir(%r)' % core.LOCK)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=('identity','inspect-artifact','preflight','deploy'))
    parser.add_argument('--repo',type=Path,required=True)
    parser.add_argument('--archive',type=Path)
    parser.add_argument('--migration-archive',type=Path)
    parser.add_argument('--ssh-key',type=Path)
    parser.add_argument('--authorize-release-sha')
    parser.add_argument('--production-gate-authorized',choices=('SKU_GATE_8',))
    args = parser.parse_args()
    release, baseline, after = identity(args.repo)
    if args.mode == 'identity':
        print(json.dumps({'result':'SKU_IDENTITY_PASS','releaseSha':release,
            'businessSha':contract.BUSINESS_SHA,'migration':contract.MIGRATION_NAME,
            'migrationSha256':contract.MIGRATION_SHA256}))
        return
    core.require(args.archive is not None and args.migration_archive is not None,
                 'SKU_ARCHIVES_REQUIRED')
    art = core.artifact(args.archive,release,args.repo)
    migration_art = migration_artifact(args.migration_archive,release,args.repo)
    if args.mode == 'inspect-artifact':
        combined_budget(0,100*core.GIB,art,migration_art)
        print(json.dumps({'result':'SKU_ARTIFACT_PASS','releaseSha':release,
                          'imageReference':art['imageReference'],
                          'migrationImageReference':migration_art['imageReference']}))
        return
    core.require(args.ssh_key is not None,'SKU_SSH_KEY_REQUIRED')
    remote = core.Remote(args.ssh_key)
    if args.mode == 'preflight':
        readiness = pre_mutation_readiness(remote,args.repo,art,migration_art,baseline)
        print(json.dumps({'result':'SKU_PREFLIGHT_PASS','releaseSha':release,
            'productionSha':contract.PRODUCTION_SHA,'database':core.EXPECTED_DB,
            'migrations':85,'writer':1,'posActive':87,'anyChannelEnabled':113,
            'mappingDigest':readiness['identity']['mappingDigest'],
            'onlineDigest':readiness['identity']['onlineDigest'],
            'diskBudget':readiness['budget']}))
        return
    core.require(args.production_gate_authorized == 'SKU_GATE_8' and
                 args.authorize_release_sha == release,
                 'EXPLICIT_SKU_PRODUCTION_GATE_REQUIRED')
    deploy(remote,args.repo,args.archive,args.migration_archive,
           art,migration_art,baseline,after,release)


if __name__ == '__main__':
    try: main()
    except (contract.ReleaseBlocked,core.GateError) as error:
        print(json.dumps({'result':'SKU_RELEASE_ABORTED','code':str(error)}))
        sys.exit(1)
    except BaseException:
        print(json.dumps({'result':'SKU_RELEASE_ABORTED',
                          'code':'UNEXPECTED_ERROR_DETAILS_SUPPRESSED'}))
        sys.exit(1)

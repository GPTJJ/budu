"""Authorized release recovery: verify baseline, clear only stale lock, fresh DB backup."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

RELEASE='682234baf03f2b4934a5a913843e4b55542184b4'
PRODUCTION='5ad27a06d731fbc94de5ae3776060b4350b886e8'
BUSINESS='355128f179dba209ee86a2cd616a1c663a268d2a'
PIN='154.8.195.42 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHJJGZ1Kape1om+8xOhoI7IsgvKN1tw6sh8l7PGisgtb'
assert os.environ.get('GITHUB_ACTIONS')=='true'
assert os.environ.get('GITHUB_REF')=='refs/heads/codex/partner-import-diagnosis'
assert os.environ.get('GITHUB_RUN_ATTEMPT')=='1'
assert shutil.which('rsync'), 'RUNNER_RSYNC_MISSING'
root=Path(os.environ['RUNNER_TEMP'])/'partner-ssh-diagnosis'; root.mkdir(mode=0o700)
(root/'controller.py').write_bytes(subprocess.check_output(['git','show',RELEASE+':scripts/deploy-prod-transfer-cas.py']))
known=root/'known_hosts'; known.write_text(PIN+'\n'); known.chmod(0o600)
os.environ['TRANSFER_CAS_KNOWN_HOSTS']=str(known)
spec=importlib.util.spec_from_file_location('release_controller',root/'controller.py')
r=importlib.util.module_from_spec(spec); spec.loader.exec_module(r)
r.configure_profile('post-transfer',PRODUCTION,BUSINESS,r.digest(subprocess.check_output(['git','show',PRODUCTION+':server/v2.js'])))
remote=r.Remote(Path.home()/'.ssh/id_ed25519')
ledger={p.parent.name:r.digest(p.read_bytes()) for p in Path('prisma/migrations').glob('*/migration.sql')}
assert len(ledger)==85
name=r.route_target(*remote.routes()); old=remote.inspect(name)
assert old['State']['Running'] and old['State']['Health']['Status']=='healthy'
assert old['Config']['Labels'][r.REVISION]==PRODUCTION and r.env(old)['GIT_SHA']==PRODUCTION
assert remote.run(['cat',r.CURRENT_SHA_FILE]).decode().strip()==PRODUCTION
remote.health(name,PRODUCTION); remote.health(name,PRODUCTION,public=True)
db=remote.db(); r.validate_database(db,ledger); r.writer_check(remote.containers(),db,[name])
r.application_db_probe(remote,name,'OLD_APPLICATION_DB_PROBE_FAILED')
remote.inspect(old['Image'],image=True)
runner_rsync=subprocess.check_output(['rsync','--version'],text=True).splitlines()[0]
production_rsync=remote.run(['rsync','--version']).decode().splitlines()[0]
for sha in ['355128f179dba209ee86a2cd616a1c663a268d2a','cf50bc333e5cbf10d01964f3678f7bceba64bfcf',RELEASE]:
 assert not remote.run(['docker','ps','-aq','--filter','name=^/budu-prod-'+sha[:12]+'-post-transfer$']).strip(), 'CANDIDATE_CONTAINER_EXISTS'
 assert not remote.run(['docker','images','-q','budu-api:post-transfer-'+sha[:12]]).strip(), 'CANDIDATE_IMAGE_EXISTS'
check=r'''import json,os,pathlib,stat,time
p=pathlib.Path('/run/lock/budu-transfer-cas-release')
for proc in pathlib.Path('/proc').glob('[0-9]*'):
 try: argv=(proc/'cmdline').read_bytes().split(b'\0'); exe=pathlib.Path(os.fsdecode(argv[0])).name
 except (OSError,IndexError): continue
 assert not (exe=='docker' and b'load' in argv[1:3]), 'ACTIVE_DOCKER_LOAD'
 assert not (exe=='ctr' and b'import' in argv), 'ACTIVE_CONTAINERD_IMPORT'
ingest=pathlib.Path('/var/lib/containerd/io.containerd.content.v1.content/ingest')
for data in ingest.glob('*/data'):
 assert time.time()-data.stat().st_mtime>600, 'RECENT_CONTAINERD_INGEST'
s=p.lstat(); assert stat.S_ISDIR(s.st_mode) and s.st_uid==0 and not list(p.iterdir())
assert time.time()-s.st_mtime>600, 'LOCK_NOT_STALE'
print(json.dumps({'stale_lock':True,'lock_inode':s.st_ino,'lock_mtime_ns':s.st_mtime_ns,'active_import':False}))
'''
lock=json.loads(remote.py(check))
used,available=remote.disk(); assert available>10*r.GIB
print(json.dumps({'stage':'RECOVERY_PRECHECK_PASS','production_sha':PRODUCTION,'health':'PASS','db':'85/0','writer':1,'rollback_image':'PRESENT','rsync_runner':runner_rsync,'rsync_production':production_rsync,'disk_available':available,'lock':lock}),flush=True)
# Repeat import/lock guards in the same process immediately before this one rmdir.
remove=check.replace("print(json.dumps({'stale_lock':True,'lock_inode':s.st_ino,'lock_mtime_ns':s.st_mtime_ns,'active_import':False}))", "assert s.st_ino=="+str(lock['lock_inode'])+" and s.st_mtime_ns=="+str(lock['lock_mtime_ns'])+"\nos.rmdir(p)\nprint('STALE_RELEASE_LOCK_REMOVED')")
assert remote.py(remove).strip()==b'STALE_RELEASE_LOCK_REMOVED'
backup=r'''import datetime,hashlib,json,os,pathlib,subprocess
pg='budu-bj-006-final-restore-20260822-055653z-pg'
m=json.loads(subprocess.check_output(['docker','inspect',pg]))[0]
e=dict(x.split('=',1) for x in m['Config']['Env'] if '=' in x)
p=pathlib.Path('/opt/budu/backups/pg')/('budu_bj006-pre-partner-staged-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'.dump')
with p.open('xb') as out:
 os.fchmod(out.fileno(),0o600)
 result=subprocess.run(['docker','exec',pg,'pg_dump','-U',e.get('POSTGRES_USER','postgres'),'-d','budu_bj006','--format=custom','--no-owner'],stdout=out,stderr=subprocess.PIPE)
 assert result.returncode==0, 'DB_BACKUP_FAILED'
assert p.stat().st_size>0
with p.open('rb') as src:
 result=subprocess.run(['docker','exec','-i',pg,'pg_restore','--list'],stdin=src,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
 assert result.returncode==0, 'BACKUP_INTEGRITY_FAILED'
print(json.dumps({'path':str(p),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'integrity':'PASS'}))
'''
backup_result=json.loads(remote.py(backup,timeout=240))
result={'result':'RECOVERY_PASS','production_sha':PRODUCTION,'health':'PASS','database':'budu_bj006','migrations':'85/0','writer':1,'rsync_runner':runner_rsync,'rsync_production':production_rsync,'stale_lock_removed':True,'backup':backup_result}
(root/'result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result),flush=True)
with open(os.environ['GITHUB_STEP_SUMMARY'],'a') as out: out.write('```json\n'+json.dumps(result,indent=2)+'\n```\n')

"""Read-only progress and postflight audit for the authorized staged release."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess

SOURCE='682234baf03f2b4934a5a913843e4b55542184b4'
RELEASE='5cd9ee5156343417cb64f849a322baea57c08c9c'
BASELINE='5ad27a06d731fbc94de5ae3776060b4350b886e8'
PIN='154.8.195.42 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHJJGZ1Kape1om+8xOhoI7IsgvKN1tw6sh8l7PGisgtb'
assert os.environ.get('GITHUB_ACTIONS')=='true'
assert os.environ.get('GITHUB_REF')=='refs/heads/codex/partner-import-diagnosis'
root=Path(os.environ['RUNNER_TEMP'])/'partner-ssh-diagnosis'; root.mkdir(mode=0o700)
(root/'controller.py').write_bytes(subprocess.check_output(['git','show',SOURCE+':scripts/deploy-prod-transfer-cas.py']))
known=root/'known_hosts'; known.write_text(PIN+'\n'); known.chmod(0o600)
os.environ['TRANSFER_CAS_KNOWN_HOSTS']=str(known)
spec=importlib.util.spec_from_file_location('release_controller',root/'controller.py')
r=importlib.util.module_from_spec(spec); spec.loader.exec_module(r)
remote=r.Remote(Path.home()/'.ssh/id_ed25519')
pointer=remote.run(['cat',r.CURRENT_SHA_FILE]).decode().strip()
assert pointer in (BASELINE,RELEASE)
name=r.route_target(*remote.routes()); current=remote.inspect(name)
assert current['Config']['Labels'][r.REVISION]==pointer and r.env(current)['GIT_SHA']==pointer
remote.health(name,pointer); remote.health(name,pointer,public=True)
ledger={p.parent.name:r.digest(p.read_bytes()) for p in Path('prisma/migrations').glob('*/migration.sql')}
db=remote.db(); r.validate_database(db,ledger); r.writer_check(remote.containers(),db,[name])
r.application_db_probe(remote,name,'APPLICATION_DB_PROBE_FAILED')
query=r'''import json,pathlib,stat,sys
v=json.load(sys.stdin); root=pathlib.Path('/opt/budu/.release-staging')
files={}
for suffix in ('.tar.part','.tar','.json'):
 p=root/(v['release']+suffix)
 if p.exists():
  s=p.stat(); files[suffix]={'bytes':s.st_size,'mode':oct(stat.S_IMODE(s.st_mode))}
  if suffix=='.json': files[suffix]['identity']=json.loads(p.read_text())
procs=[]
for p in pathlib.Path('/proc').glob('[0-9]*'):
 try: argv=(p/'cmdline').read_bytes().split(b'\0'); exe=pathlib.Path(argv[0].decode()).name
 except (OSError,ValueError,IndexError): continue
 if exe=='rsync' or (exe=='docker' and b'load' in argv[1:3]): procs.append({'pid':int(p.name),'process':exe})
print(json.dumps({'files':files,'transfer_import_processes':procs,'release_lock_present':pathlib.Path('/run/lock/budu-transfer-cas-release').is_dir()}))
'''
staging=json.loads(remote.py(query,{'release':RELEASE}))
used,available=remote.disk()
result={'result':'READ_ONLY_AUDIT_PASS','production_sha':pointer,'target_release_sha':RELEASE,
        'health':'PASS','db':'85/0','writer':1,'application_select_1':'PASS',
        'disk_available':available,'staging':staging}
(root/'result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result),flush=True)
with open(os.environ['GITHUB_STEP_SUMMARY'],'a') as out: out.write('```json\n'+json.dumps(result,indent=2)+'\n```\n')

# A bounded 32 MiB HTTPS pull test; the signed URL stays in memory and SSH stdin.
import urllib.request
import urllib.error
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
request=urllib.request.Request('https://api.github.com/repos/GPTJJ/budu/actions/artifacts/10969858716/zip',
    headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json'})
try:
    urllib.request.build_opener(NoRedirect).open(request,timeout=20)
    raise SystemExit('SIGNED_DOWNLOAD_REDIRECT_MISSING')
except urllib.error.HTTPError as e:
    if e.code != 302: raise SystemExit('SIGNED_DOWNLOAD_UNAVAILABLE_'+str(e.code))
    url=e.headers.get('Location','')
assert url.startswith('https://')
benchmark=r'''import json,sys,time,urllib.request
v=json.load(sys.stdin); start=time.monotonic(); n=0; maximum=32*1024*1024
try:
 req=urllib.request.Request(v['url'],headers={'Range':'bytes=0-'+str(maximum-1)})
 with urllib.request.urlopen(req,timeout=20) as response:
  status=response.status
  while n<maximum and time.monotonic()-start<100:
   chunk=response.read(min(256*1024,maximum-n))
   if not chunk: break
   n+=len(chunk)
 elapsed=time.monotonic()-start
 print(json.dumps({'path':'BEIJING_HTTPS_PULL','bytes':n,'seconds':round(elapsed,3),
 'MiB_per_second':round(n/1048576/elapsed,4),'http_status':status,'complete_sample':n==maximum}))
except Exception as e:
 print(json.dumps({'path':'BEIJING_HTTPS_PULL','bytes':n,'seconds':round(time.monotonic()-start,3),'error_type':type(e).__name__}))
'''
measurement=json.loads(remote.py(benchmark,{'url':url},timeout=150))
print(json.dumps(measurement),flush=True)
result['https_benchmark']=measurement
(root/'result.json').write_text(json.dumps(result,indent=2)+'\n')

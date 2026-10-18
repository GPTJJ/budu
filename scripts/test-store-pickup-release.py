#!/usr/bin/env python3
"""Focused contract checks; disposable PGlite, no network or production writes."""
import copy,importlib.util,json,os,subprocess,unittest
from pathlib import Path
from unittest.mock import patch,Mock
spec=importlib.util.spec_from_file_location('pickup',Path(__file__).with_name('deploy-prod-store-pickup.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
ROOT=Path(__file__).resolve().parents[1]
proof=json.loads((ROOT/p.PROOF).read_text())
V={'release':'f'*40,'oldLedger':proof['ledger'],'ledger':dict(proof['ledger'],**{p.MIGRATION:p.SQL_HASH}),'sql':(ROOT/'prisma/migrations'/p.MIGRATION/'migration.sql').read_text(),'proof':proof}

class Contract(unittest.TestCase):
 def test_01_sql_binding(self):
  self.assertIn('LOCK TABLE',p.migration_script(V))
  for key,value in [('sql',V['sql']+' '),('oldLedger',{}),('ledger',V['oldLedger'])]:
   v=dict(V,**{key:value})
   with self.assertRaises(p.m.GateError):p.migration_script(v)
 def test_02_bootstrap_separate_namespace(self):
  code=p.bootstrap_source();compile(code,'bootstrap','exec')
  prefix=code.rsplit('\nv=json.loads(sys.stdin.buffer.readline())',1)[0]
  space={};exec(compile(prefix,'bootstrap','exec'),space)
  space['m'].configure_profile('post-transfer',p.BASE,p.BUSINESS,proof['runtimeHash'])
  self.assertEqual(space['m'].image_reference(V['release']),'budu-api:post-transfer-'+V['release'][:12])
  self.assertEqual(space['m'].bg_capacity.__globals__,space['m'].__dict__)
 def test_03_original_controller_unchanged(self):
  self.assertEqual(p.m.digest((ROOT/'scripts/deploy-prod-transfer-cas.py').read_bytes()),p.BASE_CONTROLLER_HASH)
 def test_04_database_full_ledger(self):
  db={'database':p.m.EXPECTED_DB,'ledger':V['oldLedger'],'applied':88,'failed':0,'rolledBack':0,'pgVersion':'16.14','check':{'validated':True,'definition':p.m.SHIPPING_CHECK_NEW},'invalidFacts':0}
  r=Mock();r.db.return_value=db
  with patch.object(p,'schema',return_value=[]),patch.object(p.m,'procurement_query',return_value={'schemaMd5':p.m.procurement_contract()['schemaMd5']}):
   p.database(r,V,88)
   for key,value in [('ledger',dict(db['ledger'],extra='bad')),('failed',1),('rolledBack',1),('invalidFacts',1),('pgVersion','16.13')]:
    r.db.return_value=dict(db,**{key:value})
    with self.assertRaises(p.m.GateError):p.database(r,V,88)
 def test_05_rollback_false_blocks(self):
  r=Mock();r.db.return_value={'applied':89}
  with patch.object(p,'database'),patch.object(p.m,'procurement_query',return_value=1) as query:
   self.assertFalse(p.rollback_eligible(r,V)['eligible']);self.assertIn('active=true AND pickup_enabled=false',query.call_args.args[1])
  with patch.object(p,'database'),patch.object(p.m,'procurement_query',return_value=0):self.assertTrue(p.rollback_eligible(r,V)['eligible'])
 def test_06_peak_retained(self):
  g=p.m.GIB;c={'baselineUsed':20*g,'baselineAvailable':40*g,'peak':4*g,'phase':'test'}
  p.m.b1_capacity_gate(c,19*g,41*g,g);self.assertEqual(c['peak'],4*g)
  with self.assertRaises(p.m.GateError):p.m.b1_capacity_gate(c,20*g,40*g,7*g)
  self.assertEqual(c['peak'],7*g);self.assertEqual(len(c['observations']),2)
 def test_07_receipt_incomplete_rejected(self):
  good={'result':'DEPLOY_COMPLETE','releaseSha':V['release'],'dbApplied':89,'dbFailed':0,'writer':1,'runtimeMode':'active','internalHealth':'PASS','publicHealth':'PASS','applicationDbProbe':'PASS','oldStopped':True,'releaseLockReleased':True}
  p.completed(good,V['release'])
  for k in good:
   bad=good.copy();del bad[k]
   with self.assertRaises(p.m.GateError):p.completed(bad,V['release'])
 def test_08_old_recovery_promotes(self):
  r=Mock();c={'Id':proof['id'],'Image':proof['image'],'State':{'Running':False,'StartedAt':'now'},'Config':{'Image':'tag'}};r.inspect.return_value=c
  order=[]
  with patch.object(p.m,'bg_lifecycle',side_effect=lambda *x:order.append(x[-1])),patch.object(p.m,'bg_promote',side_effect=lambda *x:order.append('promote')):
   p.recover_old(r,V)
  self.assertEqual(order,['standby','promote','active']);r.run.assert_called_once_with(['docker','start',proof['id']])
 def test_09_identity_wrong_sha_branch_scope(self):
  sha='f'*40
  def git(repo,*args):
   if args==('rev-parse','HEAD'):return sha
   if args==('branch','--show-current'):return 'codex/store-pickup-001-release'
   if args==('status','--porcelain','--untracked-files=all'):return ''
   if args==('rev-parse',p.BUSINESS+'^'):return p.BASE
   if args[0]=='rev-list':return ''
   if args[0] in ('diff','log'):return '\n'.join(p.ENGINEERING|{'server/unreviewed.js'})
   raise AssertionError(args)
  with patch.object(p.m,'git',side_effect=git),patch.object(p.m,'is_ancestor',return_value=True):
   for value in ['0'*40,sha]:
    with self.assertRaises(p.m.GateError):p.identity(ROOT,value)
  with patch.object(p.m,'git',side_effect=lambda repo,*a:'wrong' if a==('rev-parse',p.BUSINESS+'^') else git(repo,*a)),patch.object(p.m,'is_ancestor',return_value=True):
   with self.assertRaises(p.m.GateError):p.identity(ROOT,sha)
 def test_11_unique_writer_rejects_unknown(self):
  c={'Name':'/known','Config':{'Env':['DATABASE_URL=postgresql://synthetic'],'Labels':{}},'NetworkSettings':{'Networks':{'n':{'IPAddress':'192.0.2.1'}}}}
  with patch.object(p.m,'writer_names',return_value=['known']):
   with self.assertRaises(p.m.GateError):p.m.writer_check([c],{'clients':['192.0.2.9']},['known'])
   with self.assertRaises(p.m.GateError):p.m.writer_check([c],{'clients':[]},[])
 def test_12_local_and_remote_contract_equal(self):
  code=p.bootstrap_source().rsplit('\nv=json.loads(sys.stdin.buffer.readline())',1)[0];space={};exec(compile(code,'bootstrap','exec'),space)
  self.assertEqual(space['migration_script'](V),p.migration_script(V));self.assertEqual(space['ENGINEERING'],p.ENGINEERING)
  with self.assertRaises(space['m'].GateError):space['completed']({'result':'DEPLOY_COMPLETE'},V['release'])
 def test_13_no_deploy_without_exact_authorization(self):
  with patch.object(p.subprocess,'Popen') as popen:
   with self.assertRaises(p.m.GateError):p.deploy(Mock(),V,'missing',p.BASE)
   popen.assert_not_called()
 def test_14_invalid_business_lineage(self):
  sha=V['release']
  answers={('rev-parse','HEAD'):sha,('branch','--show-current'):'codex/store-pickup-001-release',('status','--porcelain','--untracked-files=all'):'',('rev-parse',p.BUSINESS+'^'):p.BASE}
  with patch.object(p.m,'git',side_effect=lambda repo,*a:answers[a]),patch.object(p.m,'is_ancestor',return_value=False):
   with self.assertRaises(p.m.GateError):p.identity(ROOT,sha)
 def test_15_mount_order_and_identity(self):
  host={'Binds':None,'Mounts':[{'Type':'bind','Source':'/synthetic/secret','Target':'/run/secret','ReadOnly':True},{'Type':'volume','Source':'synthetic_data','Target':'/app/data'}]}
  mounts=[{'Type':'bind','Source':'/synthetic/secret','Destination':'/run/secret','Mode':'','RW':False,'Propagation':'rprivate'},{'Type':'volume','Name':'synthetic_data','Source':'/var/lib/docker/volumes/synthetic_data/_data','Destination':'/app/data','Driver':'local','Mode':'z','RW':True,'Propagation':''}]
  c={'HostConfig':host,'Mounts':mounts};proof={'resourcesHash':p.m.digest(json.dumps(host,sort_keys=True).encode())}
  first=p.mount_contract(c,proof);c['Mounts']=list(reversed(mounts));self.assertEqual(p.mount_contract(c,proof),first)
  for key,value in [('Source','/other'),('RW',True),('Propagation','shared'),('Destination','/other')]:
   bad=copy.deepcopy(c);bad['Mounts'][1][key]=value
   with self.assertRaises(p.m.GateError):p.mount_contract(bad,proof)
  bad=copy.deepcopy(c);bad['HostConfig']['Memory']=1
  with self.assertRaises(p.m.GateError):p.mount_contract(bad,proof)
 def test_16_streamed_failure_and_transport_receipts(self):
  for rc,out in [(0,b''),(0,b'not-json'),(255,b'{"result":"DEPLOY_COMPLETE"}'),(0,b'{"stage":"CAPACITY_BLOCKED"}\n{"result":"DEPLOY_BLOCKED"}')]:
   with self.assertRaises(p.m.GateError):p.parse_execution(out,rc,V['release'])
  good={'result':'DEPLOY_COMPLETE','releaseSha':V['release'],'dbApplied':89,'dbFailed':0,'writer':1,'runtimeMode':'active','internalHealth':'PASS','publicHealth':'PASS','applicationDbProbe':'PASS','oldStopped':True,'releaseLockReleased':True}
  out=(json.dumps({'stage':'observation'})+'\n'+json.dumps(good)).encode();self.assertEqual(p.parse_execution(out,0,V['release']),good)
  with self.assertRaises(p.m.GateError):p.parse_execution(out+b'\n'+json.dumps(good).encode(),0,V['release'])
 def test_17_upload_drains_both_pipes(self):
  import sys
  code="import sys;sys.stdout.buffer.write(b'o'*200000);sys.stdout.flush();sys.stderr.buffer.write(b'e'*200000);sys.stderr.flush();x=sys.stdin.buffer.read();print(len(x))"
  out,err,rc,error=p.transport([sys.executable,'-c',code],[b'x'*1000000],timeout=5)
  self.assertIsNone(error);self.assertEqual(rc,0);self.assertEqual(err,b'e'*200000);self.assertEqual(out,b'o'*200000+b'1000000\n')
 def test_18_deadline_includes_blocked_upload(self):
  import sys,time
  start=time.monotonic()
  out,err,rc,error=p.transport([sys.executable,'-c',"import sys,time;print('before',flush=True);print('detail',file=sys.stderr,flush=True);time.sleep(10)"],[b'x'*1000000],timeout=.25)
  self.assertEqual(error,'PICKUP_TRANSPORT_TIMEOUT_UNKNOWN');self.assertLess(time.monotonic()-start,2)
  self.assertIn(b'before',out);self.assertIn(b'detail',err);self.assertNotEqual(rc,0)
 def test_19_deadline_not_reset_after_upload(self):
  import sys,time
  start=time.monotonic()
  code="import sys,time;time.sleep(.25);sys.stdin.buffer.read();print('received',flush=True);time.sleep(10)"
  out,err,rc,error=p.transport([sys.executable,'-c',code],[b'x'*1000000],timeout=.5)
  self.assertEqual(error,'PICKUP_TRANSPORT_TIMEOUT_UNKNOWN');self.assertIn(b'received',out);self.assertLess(time.monotonic()-start,.9)
 def test_20_local_child_only_and_no_retry(self):
  import sys
  unrelated=subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)'])
  try:
   p.transport([sys.executable,'-c','import time;time.sleep(10)'],[b'x'*1000000],timeout=.15)
   self.assertIsNone(unrelated.poll())
  finally:unrelated.terminate();unrelated.wait()
 def test_21_early_close_preserves_failure(self):
  import sys
  out,err,rc,error=p.transport([sys.executable,'-c',"import sys;print('DEPLOY_BLOCKED',flush=True);sys.exit(2)"],[b'x'*1000000],timeout=2)
  self.assertEqual(rc,2);self.assertIn(b'DEPLOY_BLOCKED',out);self.assertEqual(error,'PICKUP_TRANSPORT_WRITE_UNKNOWN')
 def test_10_atomic_sql_disposable_postgres(self):
  script=r'''
import {PGlite} from '@electric-sql/pglite';import assert from 'node:assert/strict';
let raw='';for await(const x of process.stdin)raw+=x;const v=JSON.parse(raw);
for(const scenario of ['ok','checksum','failed','column','duplicate']){
 const db=new PGlite();try{
 await db.exec('CREATE TABLE "Store"(active boolean NOT NULL DEFAULT true); CREATE TABLE "_prisma_migrations"(id text,checksum text,migration_name text,finished_at timestamptz,rolled_back_at timestamptz,applied_steps_count int);');
 for(const [n,h] of Object.entries(v.old))await db.query('INSERT INTO "_prisma_migrations" VALUES($1,$2,$1,now(),NULL,1)',[n,h]);
 if(scenario==='checksum')await db.exec('UPDATE "_prisma_migrations" SET checksum=\'wrong\' WHERE migration_name=(SELECT min(migration_name) FROM "_prisma_migrations")');
 if(scenario==='failed')await db.exec('UPDATE "_prisma_migrations" SET finished_at=NULL WHERE migration_name=(SELECT min(migration_name) FROM "_prisma_migrations")');
 if(scenario==='column')await db.exec('ALTER TABLE "Store" ADD COLUMN pickup_enabled boolean');
 if(['ok','duplicate'].includes(scenario)){
  await db.exec(v.sql);assert.equal((await db.query('SELECT count(*)::int AS n FROM "_prisma_migrations"')).rows[0].n,89);
  if(scenario==='duplicate'){await assert.rejects(db.exec(v.sql));await db.exec('ROLLBACK');}
  await db.exec('INSERT INTO "Store"(active,pickup_enabled) VALUES(true,false)');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM "Store" WHERE active=true AND pickup_enabled=false')).rows[0].n,1);
 }else{await assert.rejects(db.exec(v.sql));await db.exec('ROLLBACK');assert.equal((await db.query('SELECT count(*)::int AS n FROM "_prisma_migrations"')).rows[0].n,88);}
 }finally{await db.close()}
}console.log('PGLITE_ATOMIC_GUARD_5_SCENARIOS_PASS');
'''
  result=subprocess.run(['node','--input-type=module','-e',script],input=json.dumps({'sql':p.migration_script(V),'old':V['oldLedger']}),text=True,capture_output=True,cwd=ROOT,timeout=120)
  self.assertEqual(result.returncode,0,result.stderr);print(result.stdout.strip())

class PhaseCapacity(unittest.TestCase):
 def setUp(self):
  self.v=copy.deepcopy(V);self.v['art']={'release':V['release'],'archive':568905216,'blobs':568884891,'expanded':2101489664,'largest':1159405568,'archiveHash':'a'*64,'layers':[{'chainId':'chain'}]}
  self.v['capacityPlan']=p.capacity_plan(self.v,{'dbBytes':180616215,'pgVersion':'16.14'});self.v['limits']=self.v['capacityPlan']['limits']
  self.r=Mock();self.r.disk.return_value=(20*p.m.GIB,40*p.m.GIB);self.r.run.return_value=b'df'
  self.patch=patch.object(p.m,'b2_committed',return_value={'baseline'});self.patch.start();self.addCleanup(self.patch.stop)
  self.archive={'device':1,'inode':2,'bytes':568905216,'sha256':'a'*64}
  self.apatch=patch.object(p,'retained_archive',return_value=self.archive);self.apatch.start();self.addCleanup(self.apatch.stop)
 def start(self):return p.capacity(self.r,self.v,'PICKUP_PRE_IMPORT')
 def imp(self):return {'serverWaitComplete':True,'serverSha256BeforeImport':True,'returncode':0,'archiveHash':'a'*64,'archiveBytes':568905216}
 def imported(self):
  self.start()
  with patch.object(p.m,'resolve_loaded_image'),patch.object(p.m,'b1_storage',return_value={'terminated':True}),patch.object(p.m,'b2_committed',return_value={'baseline','chain'}):
   return p.capacity(self.r,self.v,'PICKUP_IMPORTED',self.imp())
 def backup(self):
  return dict(result='PASS',releaseSha=self.v['release'],restoreContainer='budu-bg-restore-'+self.v['release'][:12],pgVersion='16.14',sourceSnapshotFingerprint={'hash':'fingerprint'},restoredFingerprint={'hash':'fingerprint'},backupBytes=200,restoreAllocatedBytes=300,backupSha256='b'*64,**{k:True for k in ['backupTerminationVerified','exporterTerminated','dumpTerminated','restoreStopped','restoreProcessTerminated','restoreVerified']})
 def test_plan_retains_full_archive_both_stages(self):
  q=self.v['capacityPlan'];self.assertEqual(q['import'],5183281330);self.assertEqual(q['database'],5396718885)
  changed=copy.deepcopy(self.v);changed['art']['archive']+=100
  z=p.capacity_plan(changed,{'dbBytes':180616215,'pgVersion':'16.14'});self.assertEqual(z['import']-q['import'],100);self.assertEqual(z['database']-q['database'],100)
 def test_admission_uses_max_preserves_all_original_thresholds(self):
  r=self.start();self.assertEqual(r['future'],5183281330);self.assertEqual(r['planned'],5396718885);self.assertEqual(r['peak'],5396718885)
  self.assertEqual(p.m.ABSOLUTE_MAX_PEAK,6*p.m.GIB);self.assertEqual(p.m.MIN_PROJECTED_AVAILABLE,10*p.m.GIB);self.assertEqual(p.m.MAX_PROJECTED_USAGE,90);self.assertEqual(p.m.RESERVE,512*1024**2)
 def test_stage_names_and_missing_receipts_never_discount(self):
  self.start();cap=self.v['art']['capacityLedger'];before=copy.deepcopy(cap)
  for stage,proof in [('PICKUP_IMPORTED',None),('PICKUP_IMPORTED',{}),('PICKUP_BACKUP_RETAINED',self.backup()),('PICKUP_DB89',{}),('PICKUP_FINAL',{})]:
   with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,stage,proof)
   self.assertEqual(cap,before)
 def test_import_receipt_identity_failures(self):
  self.start()
  for key,value in [('serverWaitComplete',False),('returncode',1),('archiveHash','c'*64),('archiveBytes',1),('serverSha256BeforeImport',False)]:
   bad=dict(self.imp(),**{key:value})
   with patch.object(p.m,'resolve_loaded_image'),patch.object(p.m,'b1_storage',return_value={'terminated':True}),patch.object(p.m,'b2_committed',return_value={'baseline','chain'}):
    with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,'PICKUP_IMPORTED',bad)
   self.assertEqual(self.v['art']['capacityLedger']['phase'],'PICKUP_PRE_IMPORT')
 def test_storage_failure_and_unknown_committed_refuse_transition(self):
  self.start()
  with patch.object(p.m,'resolve_loaded_image'),patch.object(p.m,'b1_storage',side_effect=p.m.GateError('B1_STORAGE_UNKNOWN')):
   with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,'PICKUP_IMPORTED',self.imp())
  with patch.object(p.m,'resolve_loaded_image'),patch.object(p.m,'b1_storage',return_value={'terminated':True}),patch.object(p.m,'b2_committed',return_value={'baseline','foreign'}):
   with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,'PICKUP_IMPORTED',self.imp())
  self.assertEqual(self.v['art']['capacityLedger']['phase'],'PICKUP_PRE_IMPORT')
 def test_verified_import_removes_only_future_import_temporary(self):
  r=self.imported();cap=self.v['art']['capacityLedger'];self.assertEqual(r['future'],p.m.RESERVE+sum(self.v['limits'].values()));self.assertEqual(len(cap['phaseReceipts']),1)
  self.assertEqual(cap['archiveIdentity'],self.archive);self.assertEqual(len(cap['observations']),2);self.assertEqual(cap['peak'],5396718885)
 def test_backup_requires_success_identity_fingerprint_and_all_terminations(self):
  self.imported()
  for key,value in [('result','FAIL'),('releaseSha','wrong'),('restoreContainer','wrong'),('pgVersion','other'),('restoredFingerprint',{}),('backupBytes',0),('backupBytes',self.v['limits']['backupLimit']+1),('restoreAllocatedBytes',0),('restoreAllocatedBytes',self.v['limits']['restoreLimit']+1),('backupSha256','bad')]+[(k,False) for k in ['backupTerminationVerified','exporterTerminated','dumpTerminated','restoreStopped','restoreProcessTerminated','restoreVerified']]:
   with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,'PICKUP_BACKUP_RETAINED',dict(self.backup(),**{key:value}))
   self.assertEqual(self.v['art']['capacityLedger']['phase'],'PICKUP_IMPORTED')
  result=p.capacity(self.r,self.v,'PICKUP_BACKUP_RETAINED',self.backup());self.assertEqual(result['future'],p.m.RESERVE+self.v['limits']['walLimit']+self.v['limits']['migratorLimit'])
 def test_migration_atomic_and_terminated_then_actual_ledger_required(self):
  self.imported();p.capacity(self.r,self.v,'PICKUP_BACKUP_RETAINED',self.backup());ok={'result':'PASS','terminated':True,'transactionAtomic':True,'returncode':0}
  for k,x in [('result','FAIL'),('terminated',False),('transactionAtomic',False),('returncode',1)]:
   with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,'PICKUP_DB89',dict(ok,**{k:x}))
  with patch.object(p,'database',side_effect=p.m.GateError('PICKUP_DATABASE_CONTRACT')):
   with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,'PICKUP_DB89',ok)
  with patch.object(p,'database') as d:
   r=p.capacity(self.r,self.v,'PICKUP_DB89',ok);d.assert_called_once_with(self.r,self.v,89);self.assertEqual(r['future'],p.m.RESERVE)
 def test_historical_peak_observations_and_baseline_never_reset(self):
  self.start();cap=self.v['art']['capacityLedger'];baseline=(cap['baselineUsed'],cap['baselineAvailable']);cap['peak']=int(5.9*p.m.GIB)
  self.r.disk.return_value=(19*p.m.GIB,41*p.m.GIB)
  with patch.object(p.m,'resolve_loaded_image'),patch.object(p.m,'b1_storage',return_value={'terminated':True}),patch.object(p.m,'b2_committed',return_value={'baseline','chain'}):p.capacity(self.r,self.v,'PICKUP_IMPORTED',self.imp())
  self.assertEqual(cap['peak'],int(5.9*p.m.GIB));self.assertEqual(len(cap['observations']),2);self.assertEqual((cap['baselineUsed'],cap['baselineAvailable']),baseline)
 def test_real_retained_growth_can_still_fail_original_peak(self):
  self.start();self.r.disk.return_value=(25*p.m.GIB,35*p.m.GIB)
  with patch.object(p.m,'resolve_loaded_image'),patch.object(p.m,'b1_storage',return_value={'terminated':True}),patch.object(p.m,'b2_committed',return_value={'baseline','chain'}):
   with self.assertRaisesRegex(p.m.GateError,'B1_CAPACITY_6GIB'):p.capacity(self.r,self.v,'PICKUP_IMPORTED',self.imp())
  self.assertGreater(self.v['art']['capacityLedger']['peak'],6*p.m.GIB)
 def test_ten_gib_still_blocks_and_one_gib_not_new_hard_gate(self):
  self.r.disk.return_value=(20*p.m.GIB,14*p.m.GIB)
  with self.assertRaisesRegex(p.m.GateError,'B1_CAPACITY_10GIB'):self.start()
  self.v['art'].pop('capacityLedger');self.r.disk.return_value=(20*p.m.GIB,16*p.m.GIB);self.start()
 def test_plan_drift_and_foreign_ledger_rejected(self):
  self.start();self.v['capacityPlan']['database']-=1
  with self.assertRaisesRegex(p.m.GateError,'PICKUP_CAPACITY_PLAN_CHANGED'):p.capacity(self.r,self.v,'PICKUP_IMPORTED',self.imp())
 def test_archive_change_blocks_later_phase(self):
  self.imported()
  with patch.object(p,'retained_archive',side_effect=p.m.GateError('PICKUP_RETAINED_ARCHIVE_CHANGED')):
   with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,'PICKUP_BACKUP_RETAINED',self.backup())
 def test_repeat_transition_rejected_without_replaying_import(self):
  self.imported()
  with patch.object(p.m,'b2_barrier') as b:
   with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,'PICKUP_IMPORTED',self.imp())
   b.assert_not_called()
 def test_final_requires_active_unique_writer_route_and_old_stopped(self):
  self.imported();p.capacity(self.r,self.v,'PICKUP_BACKUP_RETAINED',self.backup())
  with patch.object(p,'database'):p.capacity(self.r,self.v,'PICKUP_DB89',{'result':'PASS','terminated':True,'transactionAtomic':True,'returncode':0})
  state={'phase':89,'candidate':'candidate','candidateId':'full-id'};self.r.routes.return_value=('route','route');self.r.inspect.return_value={'State':{'Running':False}}
  for guard in ['lifecycle','writer','route','oldRunning']:
   with patch.object(p.m,'bg_lifecycle',side_effect=p.m.GateError('LIFECYCLE') if guard=='lifecycle' else None),patch.object(p,'writer',side_effect=p.m.GateError('WRITER') if guard=='writer' else None),patch.object(p.m,'route_target',return_value='foreign' if guard=='route' else 'candidate'):
    self.r.inspect.return_value={'State':{'Running':guard=='oldRunning'}}
    with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,'PICKUP_FINAL',state)
  self.r.inspect.return_value={'State':{'Running':False}}
  with patch.object(p.m,'bg_lifecycle'),patch.object(p,'writer'),patch.object(p.m,'route_target',return_value='candidate'):
   result=p.capacity(self.r,self.v,'PICKUP_FINAL',state);self.assertEqual(result['future'],p.m.RESERVE)
  cap=self.v['art']['capacityLedger'];self.assertEqual(len(cap['observations']),5);self.assertEqual(len(cap['phaseReceipts']),4);self.assertEqual(cap['peak'],5396718885)
 def test_ninety_percent_is_unchanged(self):
  self.r.disk.return_value=(150*p.m.GIB,16*p.m.GIB)
  with self.assertRaisesRegex(p.m.GateError,'B1_CAPACITY_90PCT'):self.start()
 def test_foreign_plan_in_existing_ledger_never_overwrites_history(self):
  self.start();cap=self.v['art']['capacityLedger'];cap['plan']['release']='foreign';before=copy.deepcopy(cap)
  with self.assertRaisesRegex(p.m.GateError,'PICKUP_CAPACITY_PLAN_CHANGED'):p.capacity(self.r,self.v,'PICKUP_IMPORTED',self.imp())
  self.assertEqual(cap,before)
 def test_remote_uses_same_new_budget_functions(self):
  code=p.bootstrap_source().rsplit('\nv=json.loads(sys.stdin.buffer.readline())',1)[0];scope={};exec(compile(code,'bootstrap','exec'),scope)
  self.assertEqual(scope['capacity_plan'](self.v,{'dbBytes':180616215,'pgVersion':'16.14'}),self.v['capacityPlan']);self.assertIn('retained_archive',scope)

if __name__=='__main__':unittest.main(verbosity=2)

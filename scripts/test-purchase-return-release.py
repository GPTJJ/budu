#!/usr/bin/env python3
"""Scoped release guards; mocks assert refusal paths, no production writes."""
import copy,importlib.util,json,unittest
from pathlib import Path
from unittest.mock import patch,Mock
spec=importlib.util.spec_from_file_location('release',Path(__file__).with_name('deploy-prod-purchase-return.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
ROOT=Path(__file__).resolve().parents[1]
proof=json.loads((ROOT/p.PROOF).read_text())
V={'release':'f'*40,'oldLedger':proof['ledger'],'ledger':dict(proof['ledger'],**{p.MIGRATION:p.SQL_HASH}),'sql':(ROOT/'prisma/migrations'/p.MIGRATION/'migration.sql').read_text(),'proof':proof}

class Contract(unittest.TestCase):
 def test_sql_exact_and_only_authorized_migration(self):
  sql=p.migration_script(V)
  self.assertIn('LOCK TABLE "_prisma_migrations"',sql);self.assertIn('<>89',sql)
  self.assertIn(p.SQL_HASH,sql);self.assertEqual(sql.count(V['sql']),1)
  for key,value in [('sql',V['sql']+' '),('oldLedger',{}),('ledger',V['oldLedger'])]:
   with self.assertRaises(p.m.GateError):p.migration_script(dict(V,**{key:value}))
 def test_original_release_primitives_unchanged(self):
  self.assertEqual(p.m.digest((ROOT/'scripts/deploy-prod-transfer-cas.py').read_bytes()),p.BASE_CONTROLLER_HASH)
 def test_db_full_ledger_and_shapes(self):
  for phase in [89,90]:
   db={'database':p.m.EXPECTED_DB,'ledger':V['oldLedger'] if phase==89 else V['ledger'],'applied':phase,'failed':0,'rolledBack':0,'pgVersion':'16.14','check':{'validated':True,'definition':p.m.SHIPPING_CHECK_NEW},'invalidFacts':0}
   shape={'returnTable':phase==90,'productTable':phase==90,'auditIndex':phase==90,'foreignKeys':2 if phase==90 else 0,'checks':2 if phase==90 else 0}
   r=Mock();r.db.return_value=db
   with patch.object(p,'schema',return_value=shape),patch.object(p.m,'procurement_query',return_value={'schemaMd5':p.m.procurement_contract()['schemaMd5']}) as q:
    p.database(r,V,phase);self.assertIn("indexname<>'ProcurementAudit_entityId_createdAt_idx'",q.call_args.args[1])
    for k,v in [('ledger',dict(db['ledger'],unapproved='bad')),('applied',phase+1),('failed',1),('rolledBack',1)]:
     r.db.return_value=dict(db,**{k:v})
     with self.assertRaises(p.m.GateError):p.database(r,V,phase)
    r.db.return_value=db
    with patch.object(p,'schema',return_value={}):
     with self.assertRaises(p.m.GateError):p.database(r,V,phase)
 def test_additive_app_rollback_preserves_data(self):
  r=Mock();r.db.return_value={'applied':90}
  with patch.object(p,'database'):
   value=p.rollback_eligible(r,V);self.assertTrue(value['eligible']);self.assertTrue(value['returnSchemaRetained']);self.assertFalse(value['businessDataDeleted'])
 def test_complete_receipt_all_fields_required(self):
  good={'result':'DEPLOY_COMPLETE','releaseSha':V['release'],'dbApplied':90,'dbFailed':0,'writer':1,'runtimeMode':'active','internalHealth':'PASS','publicHealth':'PASS','applicationDbProbe':'PASS','oldStopped':True,'releaseLockReleased':True}
  p.completed(good,V['release'])
  for k in good:
   bad=good.copy();del bad[k]
   with self.assertRaises(p.m.GateError):p.completed(bad,V['release'])
 def test_wrong_release_cannot_start_remote(self):
  with patch.object(p.m,'git',return_value='wrong'),patch.object(p.m,'Remote') as r:
   with self.assertRaises(p.m.GateError):p.identity(ROOT,'f'*40)
   r.assert_not_called()
 def test_recover_old_activates_only_after_standby(self):
  r=Mock();r.inspect.return_value={'Id':proof['id'],'Image':proof['image'],'State':{'Running':False,'StartedAt':'now'},'Config':{'Image':'tag'}}
  order=[]
  with patch.object(p.m,'bg_lifecycle',side_effect=lambda *x:order.append(x[-1])),patch.object(p.m,'bg_promote',side_effect=lambda *x:order.append('promote')):p.recover_old(r,V)
  self.assertEqual(order,['standby','promote','active'])

class PhaseCapacity(unittest.TestCase):
 def setUp(self):
  self.v=copy.deepcopy(V);self.v['art']={'release':V['release'],'archive':568905216,'blobs':568884891,'expanded':2101489664,'largest':1159405568,'archiveHash':'a'*64,'layers':[{'chainId':'chain'}]}
  self.v['capacityPlan']=p.capacity_plan(self.v,{'dbBytes':180616215,'pgVersion':'16.14'});self.v['limits']=self.v['capacityPlan']['limits']
  self.r=Mock();self.r.disk.return_value=(20*p.m.GIB,40*p.m.GIB);self.r.run.return_value=b'df'
  self.patch=patch.object(p.m,'b2_committed',return_value={'baseline'});self.patch.start();self.addCleanup(self.patch.stop)
  self.archive={'device':1,'inode':2,'bytes':568905216,'sha256':'a'*64}
  self.apatch=patch.object(p,'retained_archive',return_value=self.archive);self.apatch.start();self.addCleanup(self.apatch.stop)
 def start(self):return p.capacity(self.r,self.v,'PURCHASE_RETURN_PRE_IMPORT')
 def imp(self):return {'serverWaitComplete':True,'serverSha256BeforeImport':True,'returncode':0,'archiveHash':'a'*64,'archiveBytes':568905216}
 def imported(self):
  self.start()
  with patch.object(p.m,'resolve_loaded_image'),patch.object(p.m,'b1_storage',return_value={'terminated':True}),patch.object(p.m,'b2_committed',return_value={'baseline','chain'}):
   return p.capacity(self.r,self.v,'PURCHASE_RETURN_IMPORTED',self.imp())
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
  for stage,proof in [('PURCHASE_RETURN_IMPORTED',None),('PURCHASE_RETURN_IMPORTED',{}),('PURCHASE_RETURN_BACKUP_RETAINED',self.backup()),('PURCHASE_RETURN_DB90',{}),('PURCHASE_RETURN_FINAL',{})]:
   with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,stage,proof)
   self.assertEqual(cap,before)
 def test_import_receipt_identity_failures(self):
  self.start()
  for key,value in [('serverWaitComplete',False),('returncode',1),('archiveHash','c'*64),('archiveBytes',1),('serverSha256BeforeImport',False)]:
   bad=dict(self.imp(),**{key:value})
   with patch.object(p.m,'resolve_loaded_image'),patch.object(p.m,'b1_storage',return_value={'terminated':True}),patch.object(p.m,'b2_committed',return_value={'baseline','chain'}):
    with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,'PURCHASE_RETURN_IMPORTED',bad)
   self.assertEqual(self.v['art']['capacityLedger']['phase'],'PURCHASE_RETURN_PRE_IMPORT')
 def test_storage_failure_and_unknown_committed_refuse_transition(self):
  self.start()
  with patch.object(p.m,'resolve_loaded_image'),patch.object(p.m,'b1_storage',side_effect=p.m.GateError('B1_STORAGE_UNKNOWN')):
   with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,'PURCHASE_RETURN_IMPORTED',self.imp())
  with patch.object(p.m,'resolve_loaded_image'),patch.object(p.m,'b1_storage',return_value={'terminated':True}),patch.object(p.m,'b2_committed',return_value={'baseline','foreign'}):
   with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,'PURCHASE_RETURN_IMPORTED',self.imp())
  self.assertEqual(self.v['art']['capacityLedger']['phase'],'PURCHASE_RETURN_PRE_IMPORT')
 def test_verified_import_removes_only_future_import_temporary(self):
  r=self.imported();cap=self.v['art']['capacityLedger'];self.assertEqual(r['future'],p.m.RESERVE+sum(self.v['limits'].values()));self.assertEqual(len(cap['phaseReceipts']),1)
  self.assertEqual(cap['archiveIdentity'],self.archive);self.assertEqual(len(cap['observations']),2);self.assertEqual(cap['peak'],5396718885)
 def test_backup_requires_success_identity_fingerprint_and_all_terminations(self):
  self.imported()
  for key,value in [('result','FAIL'),('releaseSha','wrong'),('restoreContainer','wrong'),('pgVersion','other'),('restoredFingerprint',{}),('backupBytes',0),('backupBytes',self.v['limits']['backupLimit']+1),('restoreAllocatedBytes',0),('restoreAllocatedBytes',self.v['limits']['restoreLimit']+1),('backupSha256','bad')]+[(k,False) for k in ['backupTerminationVerified','exporterTerminated','dumpTerminated','restoreStopped','restoreProcessTerminated','restoreVerified']]:
   with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,'PURCHASE_RETURN_BACKUP_RETAINED',dict(self.backup(),**{key:value}))
   self.assertEqual(self.v['art']['capacityLedger']['phase'],'PURCHASE_RETURN_IMPORTED')
  result=p.capacity(self.r,self.v,'PURCHASE_RETURN_BACKUP_RETAINED',self.backup());self.assertEqual(result['future'],p.m.RESERVE+self.v['limits']['walLimit']+self.v['limits']['migratorLimit'])
 def test_migration_atomic_and_terminated_then_actual_ledger_required(self):
  self.imported();p.capacity(self.r,self.v,'PURCHASE_RETURN_BACKUP_RETAINED',self.backup());ok={'result':'PASS','terminated':True,'transactionAtomic':True,'returncode':0}
  for k,x in [('result','FAIL'),('terminated',False),('transactionAtomic',False),('returncode',1)]:
   with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,'PURCHASE_RETURN_DB90',dict(ok,**{k:x}))
  with patch.object(p,'database',side_effect=p.m.GateError('PURCHASE_RETURN_DATABASE_CONTRACT')):
   with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,'PURCHASE_RETURN_DB90',ok)
  with patch.object(p,'database') as d:
   r=p.capacity(self.r,self.v,'PURCHASE_RETURN_DB90',ok);d.assert_called_once_with(self.r,self.v,90);self.assertEqual(r['future'],p.m.RESERVE)
 def test_historical_peak_observations_and_baseline_never_reset(self):
  self.start();cap=self.v['art']['capacityLedger'];baseline=(cap['baselineUsed'],cap['baselineAvailable']);cap['peak']=int(5.9*p.m.GIB)
  self.r.disk.return_value=(19*p.m.GIB,41*p.m.GIB)
  with patch.object(p.m,'resolve_loaded_image'),patch.object(p.m,'b1_storage',return_value={'terminated':True}),patch.object(p.m,'b2_committed',return_value={'baseline','chain'}):p.capacity(self.r,self.v,'PURCHASE_RETURN_IMPORTED',self.imp())
  self.assertEqual(cap['peak'],int(5.9*p.m.GIB));self.assertEqual(len(cap['observations']),2);self.assertEqual((cap['baselineUsed'],cap['baselineAvailable']),baseline)
 def test_real_retained_growth_can_still_fail_original_peak(self):
  self.start();self.r.disk.return_value=(25*p.m.GIB,35*p.m.GIB)
  with patch.object(p.m,'resolve_loaded_image'),patch.object(p.m,'b1_storage',return_value={'terminated':True}),patch.object(p.m,'b2_committed',return_value={'baseline','chain'}):
   with self.assertRaisesRegex(p.m.GateError,'B1_CAPACITY_6GIB'):p.capacity(self.r,self.v,'PURCHASE_RETURN_IMPORTED',self.imp())
  self.assertGreater(self.v['art']['capacityLedger']['peak'],6*p.m.GIB)
 def test_ten_gib_still_blocks_and_one_gib_not_new_hard_gate(self):
  self.r.disk.return_value=(20*p.m.GIB,14*p.m.GIB)
  with self.assertRaisesRegex(p.m.GateError,'B1_CAPACITY_10GIB'):self.start()
  self.v['art'].pop('capacityLedger');self.r.disk.return_value=(20*p.m.GIB,16*p.m.GIB);self.start()
 def test_plan_drift_and_foreign_ledger_rejected(self):
  self.start();self.v['capacityPlan']['database']-=1
  with self.assertRaisesRegex(p.m.GateError,'PURCHASE_RETURN_CAPACITY_PLAN_CHANGED'):p.capacity(self.r,self.v,'PURCHASE_RETURN_IMPORTED',self.imp())
 def test_archive_change_blocks_later_phase(self):
  self.imported()
  with patch.object(p,'retained_archive',side_effect=p.m.GateError('PURCHASE_RETURN_RETAINED_ARCHIVE_CHANGED')):
   with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,'PURCHASE_RETURN_BACKUP_RETAINED',self.backup())
 def test_repeat_transition_rejected_without_replaying_import(self):
  self.imported()
  with patch.object(p.m,'b2_barrier') as b:
   with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,'PURCHASE_RETURN_IMPORTED',self.imp())
   b.assert_not_called()
 def test_final_requires_active_unique_writer_route_and_old_stopped(self):
  self.imported();p.capacity(self.r,self.v,'PURCHASE_RETURN_BACKUP_RETAINED',self.backup())
  with patch.object(p,'database'):p.capacity(self.r,self.v,'PURCHASE_RETURN_DB90',{'result':'PASS','terminated':True,'transactionAtomic':True,'returncode':0})
  state={'phase':90,'candidate':'candidate','candidateId':'full-id'};self.r.routes.return_value=('route','route');self.r.inspect.return_value={'State':{'Running':False}}
  for guard in ['lifecycle','writer','route','oldRunning']:
   with patch.object(p.m,'bg_lifecycle',side_effect=p.m.GateError('LIFECYCLE') if guard=='lifecycle' else None),patch.object(p,'writer',side_effect=p.m.GateError('WRITER') if guard=='writer' else None),patch.object(p.m,'route_target',return_value='foreign' if guard=='route' else 'candidate'):
    self.r.inspect.return_value={'State':{'Running':guard=='oldRunning'}}
    with self.assertRaises(p.m.GateError):p.capacity(self.r,self.v,'PURCHASE_RETURN_FINAL',state)
  self.r.inspect.return_value={'State':{'Running':False}}
  with patch.object(p.m,'bg_lifecycle'),patch.object(p,'writer'),patch.object(p.m,'route_target',return_value='candidate'):
   result=p.capacity(self.r,self.v,'PURCHASE_RETURN_FINAL',state);self.assertEqual(result['future'],p.m.RESERVE)
  cap=self.v['art']['capacityLedger'];self.assertEqual(len(cap['observations']),5);self.assertEqual(len(cap['phaseReceipts']),4);self.assertEqual(cap['peak'],5396718885)
 def test_ninety_percent_is_unchanged(self):
  self.r.disk.return_value=(150*p.m.GIB,16*p.m.GIB)
  with self.assertRaisesRegex(p.m.GateError,'B1_CAPACITY_90PCT'):self.start()
 def test_foreign_plan_in_existing_ledger_never_overwrites_history(self):
  self.start();cap=self.v['art']['capacityLedger'];cap['plan']['release']='foreign';before=copy.deepcopy(cap)
  with self.assertRaisesRegex(p.m.GateError,'PURCHASE_RETURN_CAPACITY_PLAN_CHANGED'):p.capacity(self.r,self.v,'PURCHASE_RETURN_IMPORTED',self.imp())
  self.assertEqual(cap,before)
 def test_remote_uses_same_new_budget_functions(self):
  code=p.bootstrap_source().rsplit('\nv=json.loads(sys.stdin.buffer.readline())',1)[0];scope={};exec(compile(code,'bootstrap','exec'),scope)
  self.assertEqual(scope['capacity_plan'](self.v,{'dbBytes':180616215,'pgVersion':'16.14'}),self.v['capacityPlan']);self.assertIn('retained_archive',scope)

if __name__=='__main__':unittest.main(verbosity=2)

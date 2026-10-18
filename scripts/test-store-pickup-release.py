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

if __name__=='__main__':unittest.main(verbosity=2)

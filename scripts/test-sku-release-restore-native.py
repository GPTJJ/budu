#!/usr/bin/env python3
"""Real 85->86 backup/restore failure rehearsal on disposable PostgreSQL 16."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit,urlunsplit

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('sku_controller',ROOT/'scripts/sku-release-controller.py')
r = importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(r)
BASELINE = r.contract.PRODUCTION_SHA
SOURCE = urlsplit(os.environ.get('DATABASE_URL',''))
if SOURCE.hostname not in ('localhost','127.0.0.1') or not SOURCE.path.startswith('/sku_authority_test_'):
    raise SystemExit('ISOLATED_POSTGRES_REQUIRED')


def db_url(name): return urlunsplit((SOURCE.scheme,SOURCE.netloc,'/'+name,SOURCE.query,SOURCE.fragment))
def run(args,env=None,input=None,timeout=180):
    process = subprocess.run(args,input=input,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                             env=env,timeout=timeout,check=False)
    if process.returncode: raise RuntimeError('ISOLATED_COMMAND_FAILED:'+args[0])
    return process.stdout
def psql(url,sql): return run(['psql','-X','-qAt','-v','ON_ERROR_STOP=1',url,'-c',sql]).decode().strip()
def create(name): run(['createdb','--maintenance-db',db_url('postgres'),name])
def drop(name): run(['dropdb','--if-exists','--force','--maintenance-db',db_url('postgres'),name])


class NativePreOperations:
    def __init__(self,name,baseline_schema,root,failure):
        self.name,self.url,self.root,self.failure=name,db_url(name),root,failure
        self.baseline_schema=baseline_schema
        self.writer='old';self.route='old';self.plan=None;self.backup=None
        self.migration_attempted=False;self.restore_called=False

    def env(self,**extra):
        return {**os.environ,'DATABASE_URL':self.url,'SKU_RELEASE_CONTROLLER':'sku-authority-schema1',
                'SKU_RELEASE_TEST_ONLY':'YES','GIT_SHA':'a'*40,**extra}
    def adapter(self,mode,input=None,**extra):
        return run(['node','scripts/sku-release-apply.mjs',mode],env=self.env(**extra),
                   input=input,timeout=180)
    def ledger(self):
        return int(psql(self.url,"SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"))
    def failed_migrations(self):
        return int(psql(self.url,"SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL"))
    def preflight(self):
        assert int(psql(self.url,'SHOW server_version_num'))//10000 == 16
        assert (self.ledger(),self.failed_migrations()) == (85,0)
        assert psql(self.url,'SELECT count(*) FROM "InventoryItem" WHERE category=\'product\'') == '178'
    def stop_old_writer(self): self.writer=None
    def require_writers(self,count): assert int(self.writer is not None)==count
    def create_backup(self):
        self.backup=self.root/'pre-migration.dump'
        self.backup.write_bytes(run(['pg_dump','-Fc',self.url],timeout=180))
        assert self.backup.stat().st_size>0
    def final_frozen_plan_check(self): self.plan=self.adapter('plan')
    def backup_exists(self): return bool(self.backup and self.backup.is_file())
    def migration_started(self): return self.migration_attempted
    def on_failure_start(self): pass
    def rehearse_restore(self):
        name=self.name+'_rehearsal'
        create(name)
        try:
            run(['pg_restore','--exit-on-error','--single-transaction','-d',db_url(name)],
                input=self.backup.read_bytes(),timeout=180)
            assert psql(db_url(name),"SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")=='85'
        finally: drop(name)
    def apply_migration_86(self):
        self.migration_attempted=True
        run(['node_modules/.bin/prisma','migrate','deploy','--schema','prisma/schema.prisma'],
            env=self.env(),timeout=180)
        if self.failure=='migration': raise RuntimeError('SIMULATED_MIGRATION_FAILURE')
    def require_ledger(self,count): assert self.ledger()==count
    def apply_sku_data(self):
        self.adapter('apply',self.plan,SKU_RELEASE_WRITE_AUTHORIZED='a'*40)
    def reconcile(self,pre_cutover):
        result=json.loads(self.adapter('reconcile',self.plan,
            **({} if pre_cutover else {'SKU_RELEASE_PHASE':'POST_CUTOVER'})))
        assert result['result']=='PASS'
        if pre_cutover and self.failure=='reconcile':
            raise r.DataIntegrityError('SIMULATED_SKU_RECONCILIATION_FAILURE')
    def start_candidate(self): self.writer='candidate'
    def candidate_health(self): pass
    def candidate_real_db_probe(self):
        assert psql(self.url,'SELECT 1')=='1'
        if self.failure=='db_probe': raise RuntimeError('SIMULATED_DB_PROBE_FAILURE')
    def candidate_runtime_parity(self): pass
    def stop_candidate_if_running(self):
        if self.writer=='candidate': self.writer=None
    def restore_pre_migration_backup(self):
        self.restore_called=True
        drop(self.name);create(self.name)
        run(['pg_restore','--exit-on-error','--single-transaction','-d',self.url],
            input=self.backup.read_bytes(),timeout=180)
    def start_old_writer(self): self.writer='old'
    def old_real_db_probe(self): assert psql(self.url,'SELECT 1')=='1'
    def ensure_old_public_route(self): self.route='old'
    def public_old_health(self): assert self.route=='old'


def seed(url):
    psql(url,"INSERT INTO \"ProductCategory\" (id,name) VALUES ('pre-bd','糖果'),('pre-tp','pos-森醒')")
    psql(url,"""INSERT INTO "InventoryItem" (id,name,sku,category,"productCategoryId","createdAt","isActive","transferEnabled")
      SELECT 'pre-item-'||lpad(i::text,3,'0'),'Pre商品'||i,
             CASE WHEN i<=33 THEN NULL ELSE 'LEGACY-'||lpad(i::text,3,'0') END,
             'product',CASE WHEN i<=89 THEN 'pre-tp' ELSE 'pre-bd' END,
             timestamp '2026-01-01'+i*interval '1 hour',i<=87,i BETWEEN 88 AND 113
      FROM generate_series(1,178) AS i""")
    psql(url,"""INSERT INTO online_product_policies
      (id,namespace,external_product_id,external_sku_id,product_id,enabled,updated_by_id)
      SELECT 'pre-online-'||lpad(i::text,3,'0'),'cloudbase-miniprogram',
             'external-'||i,'sku-external-'||i,'pre-item-'||lpad(i::text,3,'0'),true,'gate8a'
      FROM generate_series(1,153) AS i""")


def main():
    expected_failures = {
        'migration': 'SIMULATED_MIGRATION_FAILURE',
        'reconcile': 'SIMULATED_SKU_RECONCILIATION_FAILURE',
        'db_probe': 'SIMULATED_DB_PROBE_FAILURE',
    }
    with tempfile.TemporaryDirectory(prefix='sku-restore-ci-') as directory:
        temp=Path(directory)
        old=temp/'old-source'
        run(['git','worktree','add','--detach',str(old),BASELINE],timeout=60)
        try:
            for suffix,failure in (('r1','migration'),('r2','reconcile'),('r3','db_probe')):
                name='sku_authority_test_pre_'+suffix
                create(name)
                try:
                    url=db_url(name)
                    run(['node_modules/.bin/prisma','migrate','deploy','--schema',str(old/'prisma/schema.prisma')],
                        env={**os.environ,'DATABASE_URL':url},timeout=180)
                    seed(url)
                    with tempfile.TemporaryDirectory(prefix='sku-case-') as case:
                        op=NativePreOperations(name,old/'prisma/schema.prisma',Path(case),failure)
                        controller=r.ReleaseController(op,Path(case)/'phase.json')
                        try: controller.run()
                        except Exception as error:
                            assert str(error) == expected_failures[failure], (
                                'WRONG_FAILURE_POINT',failure,type(error).__name__,str(error))
                        else: raise RuntimeError('EXPECTED_FAILURE_NOT_TRIGGERED')
                        assert op.restore_called and op.writer=='old'
                        assert (op.ledger(),op.failed_migrations())==(85,0)
                        assert psql(url,'SELECT count(*) FROM "InventoryItem" WHERE category=\'product\'')=='178'
                        assert psql(url,"SELECT count(*) FROM information_schema.tables WHERE table_name='product_sku_assignments'")=='0'
                finally: drop(name)
        finally:
            run(['git','worktree','remove','--force',str(old)],timeout=60)
    print('PG16_R1_MIGRATION_RESTORE=PASS R2_SKU_RECONCILIATION_RESTORE=PASS R3_DB_PROBE_RESTORE=PASS')


if __name__=='__main__': main()

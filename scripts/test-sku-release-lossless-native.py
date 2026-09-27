#!/usr/bin/env python3
"""Post-cutover rollback preservation against isolated PostgreSQL 16 only."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('test_state',Path(__file__).with_name('test-sku-release-controller.py'))
t = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(t)
r = t.r

url = os.environ.get('DATABASE_URL','')
if urlsplit(url).hostname not in ('localhost','127.0.0.1') or not urlsplit(url).path.startswith('/sku_authority_test_'):
    raise SystemExit('ISOLATED_POSTGRES_REQUIRED')


def sql(command):
    process = subprocess.run(['psql','-X','-qAt','-v','ON_ERROR_STOP=1',url,'-c',command],
                             stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=False)
    if process.returncode:
        raise RuntimeError('ISOLATED_PG_QUERY_FAILED')
    return process.stdout.decode().strip()


class NativeOperations(t.FakeOperations):
    def __init__(self,path,failure,suffix):
        super().__init__(path,failure)
        self.suffix = suffix
        self.order_id = 'gate8a-order-'+suffix
        self.audit_id = 'gate8a-audit-'+suffix

    def switch_public_to_candidate(self):
        super().switch_public_to_candidate()
        sql("INSERT INTO orders (id,order_no,store_id,cashier_id,checkout_key,cart_hash) "
            f"VALUES ('{self.order_id}','{self.order_id}','gate8a-lossless-store','gate8a-cashier','{self.order_id}','fixture')")
        sql("INSERT INTO sensitive_record_audits "
            "(id,action,record_type,record_id,actor_user_id,actor_username,reason) "
            f"VALUES ('{self.audit_id}','gate8a.payment-like','Order','{self.order_id}',"
            "'gate8a','gate8a','post-cutover authority fact')")


def main():
    major = sql('SHOW server_version_num')
    if int(major)//10000 != 16: raise RuntimeError('POSTGRES_16_REQUIRED')
    sql("INSERT INTO \"Store\" (key,name) VALUES ('gate8a-lossless-store','Gate8A lossless store')")
    for suffix,failure,expected in (('runtime','stability',r.contract.POST_CUTOVER),
                                    ('public','public_health',r.contract.POST_CUTOVER),
                                    ('integrity','reconcile_post',r.contract.DATA_INTEGRITY_HOLD)):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'phase.json'
            op = NativeOperations(path,failure,suffix)
            try: r.ReleaseController(op,path).run()
            except Exception: pass
            else: raise RuntimeError('EXPECTED_FAILURE_NOT_TRIGGERED')
            if 'restore_database' in op.events: raise RuntimeError('POST_CUTOVER_DB_RESTORE_CALLED')
            if r.contract.load_manifest(path)['phase'] != expected:
                raise RuntimeError('WRONG_ROLLBACK_PHASE')
            if sql(f"SELECT count(*) FROM orders WHERE id='{op.order_id}'") != '1':
                raise RuntimeError('POST_CUTOVER_ORDER_LOST')
            if sql(f"SELECT count(*) FROM sensitive_record_audits WHERE id='{op.audit_id}'") != '1':
                raise RuntimeError('POST_CUTOVER_GENERIC_FACT_LOST')
    print('POST_CUTOVER_PG16_ORDER_PRESERVED=PASS GENERIC_FACT_PRESERVED=PASS NO_DB_RESTORE=PASS')


if __name__ == '__main__': main()

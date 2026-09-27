#!/usr/bin/env python3
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parent.parent
SPEC=importlib.util.spec_from_file_location("sku_release",ROOT/"scripts/deploy-prod-sku-authority.py")
r=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(r)

class IdentityTests(unittest.TestCase):
    def test_current_release_identity_passes(self):
        release,before,full=r.identity(ROOT)
        self.assertEqual(release,subprocess.check_output(["git","-C",str(ROOT),"rev-parse","HEAD"],text=True).strip())
        self.assertEqual(len(before),85);self.assertEqual(len(full),86)
        self.assertEqual(full[r.MIGRATION_NAME],r.MIGRATION_SHA256)

    def test_existing_post_transfer_guard_still_denies_schema(self):
        r.configure_base(ROOT)
        release=subprocess.check_output(["git","-C",str(ROOT),"rev-parse","HEAD"],text=True).strip()
        with self.assertRaisesRegex(r.GateError,"SCHEMA_CHANGED"):
            r.base.validate_post_transfer_identity(ROOT,release)

    def clone(self):
        td=tempfile.TemporaryDirectory()
        repo=Path(td.name)/"repo"
        subprocess.run(["git","clone","-q","--no-hardlinks",str(ROOT),str(repo)],check=True)
        subprocess.run(["git","-C",str(repo),"checkout","-q",subprocess.check_output(["git","-C",str(ROOT),"rev-parse","HEAD"],text=True).strip()],check=True)
        return td,repo

    def test_migration_one_byte_change_denied(self):
        td,repo=self.clone()
        try:
            p=repo/r.MIGRATION_PATH;p.write_text(p.read_text()+"\n-- drift\n")
            with self.assertRaisesRegex(r.GateError,"SKU_BUSINESS_RUNTIME_CHANGED|APPROVED_MIGRATION_CHECKSUM_MISMATCH"):
                r.validate_repo_identity(repo,subprocess.check_output(["git","-C",str(repo),"rev-parse","HEAD"],text=True).strip())
        finally:td.cleanup()

    def test_second_migration_denied(self):
        td,repo=self.clone()
        try:
            p=repo/"prisma/migrations/20990101000000_forbidden";p.mkdir(parents=True);(p/"migration.sql").write_text("SELECT 1;\n")
            subprocess.run(["git","-C",str(repo),"add","."],check=True)
            subprocess.run(["git","-C",str(repo),"config","user.email","fixture@example.invalid"],check=True)
            subprocess.run(["git","-C",str(repo),"config","user.name","Fixture"],check=True)
            subprocess.run(["git","-C",str(repo),"commit","-qm","fixture"],check=True)
            sha=subprocess.check_output(["git","-C",str(repo),"rev-parse","HEAD"],text=True).strip()
            with self.assertRaisesRegex(r.GateError,"SKU_RELEASE_ENGINEERING_SCOPE_INVALID|SKU_BUSINESS_RUNTIME_CHANGED"):
                r.validate_repo_identity(repo,sha)
        finally:td.cleanup()

    def test_unknown_schema_drift_denied(self):
        td,repo=self.clone()
        try:
            p=repo/"prisma/schema.prisma";p.write_text(p.read_text()+"\n// forbidden\n")
            subprocess.run(["git","-C",str(repo),"add","."],check=True)
            subprocess.run(["git","-C",str(repo),"config","user.email","fixture@example.invalid"],check=True)
            subprocess.run(["git","-C",str(repo),"config","user.name","Fixture"],check=True)
            subprocess.run(["git","-C",str(repo),"commit","-qm","fixture"],check=True)
            sha=subprocess.check_output(["git","-C",str(repo),"rev-parse","HEAD"],text=True).strip()
            with self.assertRaisesRegex(r.GateError,"SKU_BUSINESS_RUNTIME_CHANGED"):
                r.validate_repo_identity(repo,sha)
        finally:td.cleanup()

    def test_business_runtime_change_denied(self):
        td,repo=self.clone()
        try:
            p=repo/"server/products.js";p.write_text(p.read_text()+"\n// forbidden\n")
            subprocess.run(["git","-C",str(repo),"add","."],check=True)
            subprocess.run(["git","-C",str(repo),"config","user.email","fixture@example.invalid"],check=True)
            subprocess.run(["git","-C",str(repo),"config","user.name","Fixture"],check=True)
            subprocess.run(["git","-C",str(repo),"commit","-qm","fixture"],check=True)
            sha=subprocess.check_output(["git","-C",str(repo),"rev-parse","HEAD"],text=True).strip()
            with self.assertRaisesRegex(r.GateError,"SKU_RELEASE_ENGINEERING_SCOPE_INVALID|SKU_BUSINESS_RUNTIME_CHANGED"):
                r.validate_repo_identity(repo,sha)
        finally:td.cleanup()

class MappingTests(unittest.TestCase):
    def fixture(self):
        rows=[]
        for i in range(178):
            tp=i<89
            rows.append({"id":f"it-{i:03d}","name":f"p{i:03d}","sku":None if i<33 else f"OLD{i:03d}",
                         "createdAt":f"2026-01-{(i%28)+1:02d}T00:00:00.000Z","isActive":i<113,
                         "transferCode":None,"productCategory":{"name":"森醒" if tp else "糖果"}})
        return rows
    def test_mapping_counts_and_format(self):
        mapping,h=r.build_mapping(self.fixture())
        self.assertEqual(len(mapping),178);self.assertRegex(h,r"^[0-9a-f]{64}$")
        self.assertEqual(sum(x["prefix"]=="BD" for x in mapping),89)
        self.assertEqual(sum(x["prefix"]=="TP" for x in mapping),89)
        self.assertEqual(sum(x["alias"] is not None for x in mapping),145)
        self.assertTrue(all(__import__("re").fullmatch(r"^(BD|TP)-\d{6}$",x["newSku"]) for x in mapping))
    def test_ambiguous_third_party_denied(self):
        rows=self.fixture();rows[0]["productCategory"]["name"]="森醒 临时"
        with self.assertRaisesRegex(r.GateError,"PRODUCT_SOURCE_AMBIGUOUS"):r.build_mapping(rows)

class LedgerTests(unittest.TestCase):
    def test_before_ledger_contract(self):
        before,full=r.migration_ledger(ROOT)
        db={"database":"budu_bj006","applied":85,"failed":0,"ledger":before}
        r.validate_db_before(db,before)
        bad=dict(db);bad["applied"]=86
        with self.assertRaisesRegex(r.GateError,"MIGRATION_LEDGER_INVALID"):r.validate_db_before(bad,before)
    def test_after_ledger_contract(self):
        before,full=r.migration_ledger(ROOT)
        db={"database":"budu_bj006","applied":86,"failed":0,"ledger":full}
        r.validate_db_after(db,full)
        bad=dict(db);bad["failed"]=1
        with self.assertRaisesRegex(r.GateError,"MIGRATION_LEDGER_INVALID"):r.validate_db_after(bad,full)

class SafetyShapeTests(unittest.TestCase):
    def source(self):return (ROOT/"scripts/deploy-prod-sku-authority.py").read_text()
    def test_backup_before_migration_and_restore_on_failure(self):
        s=self.source()
        self.assertLess(s.index("BACKUP_SCRIPT"),s.index("run_ephemeral(remote,state[\"name\"],art[\"imageReference\"],\n            args=[\"npx\",\"prisma\",\"migrate\""))
        self.assertIn("restore_database(remote,backup[\"path\"],before_ledger)",s)
    def test_route_switch_occurs_after_data_reconciliation(self):
        s=self.source()
        self.assertLess(s.index("SKU_DATA_RECONCILIATION_FAILED"),s.index("base.replace_routes(remote,new,new)"))
    def test_candidate_db_probe_before_cutover(self):
        s=self.source()
        self.assertLess(s.index('base.application_db_probe(remote,candidate,"CANDIDATE_APPLICATION_DB_PROBE_FAILED")'),s.index("base.replace_routes(remote,new,new)"))
    def test_single_writer_checks_preserved(self):
        s=self.source()
        self.assertGreaterEqual(s.count("base.settle_writers"),5)
        self.assertIn("writer\":1",s)
    def test_five_minute_stability_present(self):
        s=self.source();self.assertIn("for _ in range(10):",s);self.assertIn("time.sleep(30)",s)
    def test_adapter_cannot_deploy_from_other_branch(self):
        s=(ROOT/"scripts/release-prod-sku-authority-ci.sh").read_text()
        self.assertIn("refs/heads/codex/sku-authority-release-controller",s)
        self.assertIn("AUTHORIZE_RELEASE_SHA",s)
        self.assertIn("EXPECTED_PRODUCTION_SHA",s)
        self.assertIn("APPROVED_BUSINESS_SHA",s)
    def test_no_broad_safety_weakening(self):
        s=self.source()
        for forbidden in ("docker system prune","docker volume prune","--force-recreate nginx","set -x"):
            self.assertNotIn(forbidden,s)

if __name__=="__main__":unittest.main(verbosity=2)

#!/usr/bin/env python3
"""Offline compatibility, dispatch, identity and fail-closed tests."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parent.parent
SPEC=importlib.util.spec_from_file_location('release',ROOT/'scripts/deploy-prod-transfer-cas.py')
r=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(r)
NEW='a'*40
BRANCH='codex/transfer-cas-existing-workflow'


class ExistingWorkflow(unittest.TestCase):
    def test_workflow_is_unchanged_and_compatible(self):
        path=ROOT/'.github/workflows/deploy-prod.yml'
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),'3679213363b298664d93f484b66ea474aace978d08422ec0f944fdeb5852a68e')
        w=json.loads(subprocess.check_output(['ruby','-rjson','-ryaml','-e','puts JSON.generate(YAML.load_file(ARGV[0]))',str(path)]))
        self.assertEqual(w.get('on',w.get('true')),{'workflow_dispatch':None})
        self.assertEqual(w['concurrency'],{'group':'deploy-bj-prod','cancel-in-progress':False})
        job=w['jobs']['deploy'];self.assertEqual(job['runs-on'],'ubuntu-latest')
        steps=job['steps'];self.assertEqual(steps[0]['uses'],'actions/checkout@v4')
        self.assertEqual(steps[0]['with'],{'fetch-depth':0})
        self.assertEqual(steps[2]['run'].strip(),'bash scripts/deploy-remote.sh "$SSH_HOST" "$SSH_USER" "$APP_DIR" "$GITHUB_SHA" prod')
        self.assertEqual(set(steps[1]['env'].values())|set(steps[2]['env'].values()),
                         {'${{ secrets.BJ_SSH_KEY }}','${{ secrets.BJ_HOST }}','${{ secrets.BJ_USER }}','${{ secrets.BJ_APP_DIR }}'})

    def test_shell_and_embedded_python_compile(self):
        for name in ('deploy-remote.sh','deploy-prod-transfer-cas.sh','release-prod-transfer-cas-ci.sh'):
            path=ROOT/'scripts'/name
            subprocess.run(['bash','-n',str(path)],check=True)
            for code in re.findall(r"python3 - <<'PY'[^\n]*\n(.*?)\nPY",path.read_text(),re.S):
                compile(code,name,'exec')

    def test_adapter_security_and_build_contract(self):
        s=(ROOT/'scripts/release-prod-transfer-cas-ci.sh').read_text()
        for required in ("= GPTJJ/budu",'= workflow_dispatch',"= 'Deploy to Beijing Prod'",'= refs/heads/'+BRANCH,
                         '"${GITHUB_RUN_ATTEMPT:-}" = 1','"$RELEASE_SHA" = "$GITHUB_SHA"',
                         '"${RUNNER_ARCH:-}" = X64','"$(uname -m)" = x86_64',
                         'unset SSH_HOST SSH_USER APP_DIR SSH_KEY DATABASE_URL','git archive "$RELEASE_SHA"',
                         '--platform linux/amd64','compression=gzip,compression-level=9,force-compression=true',
                         '--authorize-release-sha "$RELEASE_SHA"','trap finish EXIT'):
            self.assertIn(required,s)
        for forbidden in ('set -x','--build-arg','--secret','docker prune','system prune','docker compose','pg_dump','prisma migrate','apt install','curl '):
            self.assertNotIn(forbidden,s)
        self.assertLess(s.index('inspect-artifact --repo'),s.index('docker load --input'))
        self.assertLess(s.index('preflight --repo'),s.index(' deploy --repo'))

    def test_exact_business_and_rollback_constants(self):
        self.assertEqual(r.RUNTIME_SHA,'8381959e9c1d527c1f14c234338b14d117ae46f5')
        self.assertEqual(r.EXPECTED_OLD_SHA,'fc57da5a6e6611c66ed1db286336dc0e1752d69c')
        self.assertEqual(r.RELEASE_BASE,'7ebfcd74ca97aec92a38b8eaa29f11343ca0864a')
        self.assertEqual(r.MIGRATION_REQUIRED,'NO')

    def mock_git(self,ancestor=True,workflow_history=False,branch=BRANCH):
        def call(repo,*args):
            if args==('rev-parse','HEAD'):return NEW
            if args==('branch','--show-current'):return branch
            if args[:1]==('rev-list',):return NEW+' '+r.RELEASE_BASE
            if args==('diff','--name-only',r.RUNTIME_SHA,NEW):return '\n'.join(sorted(r.ALLOWLIST))
            if args[:2]==('diff','--name-only'):return ''
            if args[:1]==('merge-base',):return r.RUNTIME_SHA if ancestor else r.EXPECTED_OLD_SHA
            if args[:1]==('status',):return ''
            if args[:1]==('log',):return '.github/workflows/deploy-prod.yml' if workflow_history else ''
            if args[:1]==('diff',) and args[1].startswith('--diff-filter='):return args[-1]
            raise AssertionError(args)
        return call

    def test_valid_release_identity(self):
        with patch.object(r,'git',side_effect=self.mock_git()),patch.object(r,'command',return_value=b''):
            sha,ledger=r.identity(ROOT)
        self.assertEqual(sha,NEW);self.assertEqual(len(ledger),85)

    def test_wrong_business_ancestor_fails(self):
        with patch.object(r,'git',side_effect=self.mock_git(ancestor=False)),patch.object(r,'command',side_effect=AssertionError('UNEXPECTED_IO')):
            with self.assertRaisesRegex(r.GateError,'ANCESTRY'):r.identity(ROOT)

    def test_workflow_history_even_if_final_diff_clean_fails(self):
        with patch.object(r,'git',side_effect=self.mock_git(workflow_history=True)),patch.object(r,'command',return_value=b''):
            with self.assertRaisesRegex(r.GateError,'WORKFLOW_HISTORY'):r.identity(ROOT)

    def test_wrong_branch_fails(self):
        with patch.object(r,'git',side_effect=self.mock_git(branch='main')):
            with self.assertRaisesRegex(r.GateError,'BRANCH'):r.identity(ROOT)

    def test_workflow_diff_or_business_diff_rejected(self):
        for path in ('.github/workflows/deploy-prod.yml','server/v2.js','prisma/schema.prisma'):
            with self.assertRaisesRegex(r.GateError,'ALLOWLIST'):
                r.validate_identity(NEW,r.RELEASE_BASE,True,r.ALLOWLIST|{path},[],True)

    def test_dispatch_failure_never_falls_through(self):
        prefix=(ROOT/'scripts/deploy-remote.sh').read_text().split('# Sweet Card data organization',1)[0]
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'scripts').mkdir();(root/'bin').mkdir()
            fakegit=root/'bin/git'
            fakegit.write_text('#!/bin/sh\nexit "${FIXTURE_ANCESTOR_EXIT:-0}"\n');fakegit.chmod(0o755)
            (root/'entry.sh').write_text(prefix+'echo LEGACY_REACHED\n')
            (root/'scripts/release-prod-transfer-cas-ci.sh').write_text('echo DEDICATED_REACHED\nexit 73\n')
            cases=[('refs/heads/'+BRANCH,'1',73,'DEDICATED_REACHED'),
                   ('refs/heads/other','0',73,'DEDICATED_REACHED'),
                   ('refs/heads/other','1',0,'LEGACY_REACHED')]
            for ref,ancestor,code,message in cases:
                with self.subTest(ref=ref,ancestor=ancestor):
                    env={**os.environ,'PATH':str(root/'bin')+':'+os.environ['PATH'],'GITHUB_REF':ref,'FIXTURE_ANCESTOR_EXIT':ancestor}
                    p=subprocess.run(['bash','entry.sh','fixture-host','fixture-user','/fixture',NEW,'prod'],cwd=root,env=env,capture_output=True,text=True)
                    self.assertEqual(p.returncode,code);self.assertEqual(p.stdout.strip(),message)


if __name__=='__main__':
    unittest.main(verbosity=2)

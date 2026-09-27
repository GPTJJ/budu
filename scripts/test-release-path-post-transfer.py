#!/usr/bin/env python3
"""Offline post-Transfer release identity and real shell routing regressions."""
import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('release', ROOT/'scripts/deploy-prod-transfer-cas.py')
r = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(r)
OLD = '2fa28a6399c8a9f4fd70188d8df077f0b411589e'
BUSINESS = '2188dd17f6b80e9be27e50a9773e7269c6eabb65'
TRANSFER = '8381959e9c1d527c1f14c234338b14d117ae46f5'
OLD_V2 = hashlib.sha256(subprocess.check_output(['git','-C',str(ROOT),'show',OLD+':server/v2.js'])).hexdigest()


def route(repo, ref, sha):
    with tempfile.TemporaryDirectory() as directory:
        bindir = Path(directory)
        stub = bindir/'bash'
        stub.write_text('#!/bin/sh\nprintf "ROUTE=%s\\n" "$1"\n')
        stub.chmod(0o755)
        env = {**os.environ, 'PATH':str(bindir)+':'+os.environ['PATH'], 'GITHUB_REF':ref}
        return subprocess.run(['/bin/bash','scripts/deploy-remote.sh','154.8.195.42','ubuntu','/opt/budu',sha,'prod'],
                              cwd=repo, env=env, capture_output=True, text=True)


class RealShellRoute(unittest.TestCase):
    def test_build_only_workflow_uses_exact_branch_without_production_access(self):
        workflow=ROOT/'.github/workflows/release-build-only.yml'
        source=workflow.read_text()
        import json
        parsed=json.loads(subprocess.check_output(
            ['ruby','-rjson','-ryaml','-e','puts JSON.generate(YAML.load_file(ARGV[0]))',str(workflow)]))
        self.assertEqual(parsed.get('on',parsed.get('true')),
                         {'push':{'branches':['codex/release-path-post-transfer-generalization',
                                              'codex/release-controller-dns-empty-normalization',
                                              'codex/release-single-writer-db-probe']}})
        self.assertEqual(parsed['permissions'],{'contents':'read'})
        job=parsed['jobs']['artifact']
        self.assertEqual(job['runs-on'],'ubuntu-latest')
        self.assertEqual(job['steps'][0]['with']['ref'],'${{ github.sha }}')
        self.assertEqual(job['steps'][-1]['uses'],'actions/upload-artifact@v4')
        self.assertEqual(job['steps'][-1]['with']['retention-days'],1)
        verify=next(step for step in job['steps'] if step.get('name')=='Verify source and release guard')
        self.assertEqual(verify['env']['PYTHONPYCACHEPREFIX'],'${{ runner.temp }}/python-pycache')
        syntax='python3 -m py_compile scripts/test-candidate-db-probe-integration.py'
        after_syntax=verify['run'].split(syntax,1)[1]
        self.assertIn('test -z "$(git status --porcelain --untracked-files=all)"',after_syntax)
        self.assertIn('WORKTREE_CLEAN_AFTER_SYNTAX_CHECK=YES',after_syntax)
        for forbidden in ('secrets.','ssh ','scp ','deploy --repo','preflight --repo',
                          'DATABASE_URL','/opt/budu','docker push','docker system prune'):
            self.assertNotIn(forbidden,source)
        for required in ('git archive "$GITHUB_SHA"','--platform linux/amd64',
                         'compression=gzip,compression-level=9,force-compression=true',
                         'inspect-artifact --repo','docker image inspect',
                         'docker run --rm --network none','APPROVAL_WITHDRAW_CAS_PRESENT=YES',
                         'codex/release-controller-dns-empty-normalization',
                         'codex/release-single-writer-db-probe',
                         'scripts/test-candidate-db-probe-integration.py'):
            self.assertIn(required,source)

    def test_t1_candidate_without_transfer_commit_denied(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.run(['git','init','-q',str(repo)],check=True)
            subprocess.run(['git','-C',str(repo),'config','user.name','Fixture'],check=True)
            subprocess.run(['git','-C',str(repo),'config','user.email','fixture@example.invalid'],check=True)
            (repo/'scripts').mkdir()
            shutil.copy2(ROOT/'scripts/deploy-remote.sh',repo/'scripts/deploy-remote.sh')
            subprocess.run(['git','-C',str(repo),'add','.'],check=True)
            subprocess.run(['git','-C',str(repo),'commit','-qm','fixture'],check=True)
            sha=subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip()
            result=route(repo,'refs/heads/fixture',sha)
            self.assertEqual(result.returncode,1)
            self.assertEqual(result.stdout.strip(),'POST_TRANSFER_BASE_REQUIRED')

    def test_t4_current_successor_uses_post_transfer_adapter(self):
        sha=subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True).strip()
        ref='refs/heads/'+subprocess.check_output(['git','-C',str(ROOT),'branch','--show-current'],text=True).strip()
        result=route(ROOT,ref,sha)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.strip(),'ROUTE=scripts/release-prod-post-transfer-ci.sh')

    def test_t5_exact_approval_review_sha_uses_post_transfer_adapter(self):
        with tempfile.TemporaryDirectory() as directory:
            repo=Path(directory)/'approval'
            subprocess.run(['git','clone','-qs','--no-checkout',str(ROOT),str(repo)],check=True)
            subprocess.run(['git','-C',str(repo),'checkout','-q','-B','codex/approval-withdraw-cas-guard',BUSINESS],check=True)
            shutil.copy2(ROOT/'scripts/deploy-remote.sh',repo/'scripts/deploy-remote.sh')
            result=route(repo,'refs/heads/codex/approval-withdraw-cas-guard',BUSINESS)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout.strip(),'ROUTE=scripts/release-prod-post-transfer-ci.sh')


class PostTransferIdentity(unittest.TestCase):
    def setUp(self):
        self.old = tuple(getattr(r,name) for name in ('RELEASE_PROFILE','EXPECTED_OLD_SHA','RUNTIME_SHA','OLD_V2_HASH',
                                                      'IMAGE_PREFIX','CONTAINER_SUFFIX','ROLLBACK_PREFIX'))
        r.configure_profile('post-transfer',OLD,BUSINESS,OLD_V2)

    def tearDown(self):
        for name,value in zip(('RELEASE_PROFILE','EXPECTED_OLD_SHA','RUNTIME_SHA','OLD_V2_HASH',
                               'IMAGE_PREFIX','CONTAINER_SUFFIX','ROLLBACK_PREFIX'),self.old):
            setattr(r,name,value)

    def test_t3_unchanged_transfer_runtime_and_schema_required(self):
        self.assertEqual(r.transfer_cas_section((ROOT/'server/v2.js').read_bytes()),
                         r.transfer_cas_section(subprocess.check_output(['git','-C',str(ROOT),'show',OLD+':server/v2.js'])))
        real_git=r.git
        def clean_git(repo,*args):
            if args[:1]==('status',): return ''
            return real_git(repo,*args)
        with patch.object(r,'git',side_effect=clean_git):
            r.validate_post_transfer_identity(ROOT,BUSINESS)

        def schema_git(repo,*args):
            if args==('diff','--name-only',OLD,BUSINESS,'--','prisma'): return 'prisma/schema.prisma'
            return clean_git(repo,*args)
        with patch.object(r,'git',side_effect=schema_git):
            with self.assertRaisesRegex(r.GateError,'SCHEMA_CHANGED'):
                r.validate_post_transfer_identity(ROOT,BUSINESS)

    def test_m1_missing_permanent_transfer_cas_runtime_denied(self):
        with tempfile.TemporaryDirectory() as directory:
            repo=Path(directory)
            (repo/'server').mkdir()
            source=(ROOT/'server/v2.js').read_bytes()
            old=b"where: { id: t.id, status: 'pending', deletedAt: null }"
            self.assertIn(old,r.transfer_cas_section(source))
            (repo/'server/v2.js').write_bytes(source.replace(old,b"where: { id: t.id }",1))
            def fake_git(_repo,*args):
                if args==('branch','--show-current'): return 'codex/release-path-post-transfer-generalization'
                if args[:2]==('diff','--name-only') or args[:1]==('status',): return ''
                raise AssertionError(args)
            baseline=subprocess.check_output(['git','-C',str(ROOT),'show',OLD+':server/v2.js'])
            with patch.object(r,'git',side_effect=fake_git),patch.object(r,'is_ancestor',return_value=True),\
                 patch.object(r,'command',return_value=baseline):
                with self.assertRaisesRegex(r.GateError,'TRANSFER_CAS_RUNTIME_CHANGED'):
                    r.validate_post_transfer_identity(repo,BUSINESS)

    def test_unreviewed_business_change_after_approved_sha_denied(self):
        real_git=r.git
        def changed_git(repo,*args):
            if args==('diff','--name-only',BUSINESS,BUSINESS): return 'server/approvals.js'
            if args[:1]==('status',): return ''
            return real_git(repo,*args)
        with patch.object(r,'git',side_effect=changed_git):
            with self.assertRaisesRegex(r.GateError,'POST_TRANSFER_RUNTIME_CHANGED'):
                r.validate_post_transfer_identity(ROOT,BUSINESS)

    def test_m2_image_revision_and_source_identity_denied(self):
        release='a'*40
        reference=r.image_reference(release)
        config={key:None for key in r.IDENTITY_KEYS}
        config['Labels']={r.REVISION:'b'*40}
        art={'imageReference':reference,'release':release,'config':config,
             'rootfsDiffIds':['sha256:'+'c'*64]}
        image={'Id':'sha256:'+'d'*64,'Os':'linux','Architecture':'amd64','Size':100,
               'RepoTags':[reference],'Config':config,'RootFS':{'Layers':art['rootfsDiffIds']}}
        with self.assertRaisesRegex(r.GateError,'LOADED_ARTIFACT_MISMATCH'):
            r.validate_loaded_image(image,art)
        adapter=ROOT/'scripts/release-prod-post-transfer-ci.sh'
        env={**os.environ,'GITHUB_ACTIONS':'true','GITHUB_REPOSITORY':'GPTJJ/budu',
             'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_WORKFLOW':'Deploy to Beijing Prod',
             'GITHUB_RUN_ATTEMPT':'1','GITHUB_REF':'refs/heads/codex/release-path-post-transfer-generalization',
             'GITHUB_SHA':'b'*40,'AUTHORIZE_RELEASE_SHA':release}
        result=subprocess.run(['/bin/bash',str(adapter),'154.8.195.42','ubuntu','/opt/budu',release],
                              cwd=ROOT,env=env,capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0)

    def test_post_adapter_keeps_exact_build_preflight_and_authorization(self):
        source=(ROOT/'scripts/release-prod-post-transfer-ci.sh').read_text()
        required=('"$RELEASE_SHA" = "${GITHUB_SHA:-}"','"$RELEASE_SHA" = "${AUTHORIZE_RELEASE_SHA:-}"',
                  'git archive "$RELEASE_SHA"','--platform linux/amd64',
                  'compression=gzip,compression-level=9,force-compression=true',
                  '--release-profile post-transfer',' inspect-artifact --repo',' preflight --repo',
                  ' deploy --repo','--authorize-release-sha "$RELEASE_SHA"')
        for value in required:self.assertIn(value,source)
        for value in ('set -x','--build-arg','--secret','docker prune','system prune','prisma migrate','pg_dump'):
            self.assertNotIn(value,source)


if __name__=='__main__':
    unittest.main(verbosity=2)

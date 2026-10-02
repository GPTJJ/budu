#!/usr/bin/env python3
"""Offline post-Transfer release identity and real shell routing regressions."""
import hashlib
import ast
import importlib.util
import json
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
SHIPPING_BRANCH = 'codex/mailing-free-tier-shipped-sort-20261001'
SHIPPING_OLD = '08895d4978594ea4298c43bf72f8961cf082fca6'
SHIPPING_BUSINESS = '48358bd774cf7d2f5da1eccb54aa4e9ccf2862fe'
PAYROLL_BRANCH = 'codex/pos-payroll-input-shipping-baseline-20261001'
PAYROLL_OLD = 'ba7b2bb8f83adc7fcd3d52535c15b0ecec17e531'
PAYROLL_BUSINESS = '27f6280f731d258ddd078504ac4a27f33430728c'
REVISION_BRANCH = 'codex/natural-month-report-revision'
REVISION_OLD = 'ede3ee43526a39131618287d9b5447977e5c91d3'
REVISION_BUSINESS = '870d1d01cc2b4fca9f216f9b3decb5e565173700'
LEGACY_BUILD_BRANCHES = ['codex/release-path-post-transfer-generalization',
                         'codex/release-controller-dns-empty-normalization',
                         'codex/release-single-writer-db-probe',
                         'codex/data-authority-finalization']
BACKUP_BRANCH = r.SHIPPING_BACKUP_DIAGNOSTIC_BRANCH
BACKUP_PARENT = r.SHIPPING_BACKUP_DIAGNOSTIC_PARENT
BACKUP_READINESS_BASE = r.SHIPPING_BACKUP_READINESS_BASE
FORMAL_BASE = r.SHIPPING_FORMAL_BASE
FORMAL_FILES = '\n'.join(sorted(r.SHIPPING_FORMAL_FILES))
BACKUP_FILES = '\n'.join(sorted(r.SHIPPING_BACKUP_DIAGNOSTIC_FILES))
DIAGNOSTIC_BRANCH = r.SHIPPING_DIAGNOSTIC_BRANCH
DIAGNOSTIC_E = r.SHIPPING_ENGINEERING_SHA
DIAGNOSTIC_FILES = '\n'.join(sorted(r.SHIPPING_DIAGNOSTIC_FILES))
SHIPPING_CI_REFS = "(github.ref == 'refs/heads/"+r.SHIPPING_BRANCH+"' || github.ref == 'refs/heads/"+DIAGNOSTIC_BRANCH+"' || github.ref == 'refs/heads/"+BACKUP_BRANCH+"')"
QUANTITY_BRANCH = r.SHIPPING_BRANCH
QUANTITY_OLD = r.SHIPPING_OLD_SHA
QUANTITY_BUSINESS = r.SHIPPING_BUSINESS_SHA
QUANTITY_ENGINEERING_FILES = '\n'.join(sorted(r.SHIPPING_ENGINEERING_FILES))
SHIPPING_ENGINEERING_FILES = '.github/workflows/release-build-only.yml\nscripts/test-release-path-post-transfer.py'


def build_only_workflow():
    return json.loads(subprocess.check_output(
        ['ruby','-rjson','-ryaml','-e','puts JSON.generate(YAML.load_file(ARGV[0]))',
         str(ROOT/'.github/workflows/release-build-only.yml')]))


def without_quantity_binding(value, key):
    sha = QUANTITY_OLD if key == 'EXPECTED_PRODUCTION_SHA' else QUANTITY_BUSINESS
    backup_prefix = "github.ref == 'refs/heads/"+BACKUP_BRANCH+"' && '"+sha+"' || "
    if value.count(backup_prefix) != 1:raise AssertionError('Exact backup diagnostic binding required once')
    value=value.replace(backup_prefix,'',1)
    diagnostic_prefix = "github.ref == 'refs/heads/"+DIAGNOSTIC_BRANCH+"' && '"+sha+"' || "
    if value.count(diagnostic_prefix) != 1:raise AssertionError('Exact diagnostic binding required once')
    value=value.replace(diagnostic_prefix,'',1)
    prefix = "github.ref == 'refs/heads/"+QUANTITY_BRANCH+"' && '"+sha+"' || "
    if value.count(prefix) != 1:
        raise AssertionError('Exact quantity binding required once')
    return value.replace(prefix,'',1)


def build_only_guard(**facts):
    """Execute the real workflow admission shell with offline Git fact fixtures."""
    job = build_only_workflow()['jobs']['artifact']
    verify = next(step for step in job['steps'] if step.get('name') == 'Verify source and release guard')
    admission = verify['run'].split('if [ -z', 1)[0]
    release = 'a'*40
    with tempfile.TemporaryDirectory() as directory:
        bindir = Path(directory)
        (bindir/'uname').write_text('#!/bin/sh\nprintf "x86_64\\n"\n')
        (bindir/'git').write_text(
            '#!/bin/sh\ncase "$1" in\n'
            'rev-list) case "$5" in\n'
            '  '+FORMAL_BASE+') printf "%s %s\\n" "$5" "$GUARD_H_PARENT" ;;\n'
            '  '+BACKUP_READINESS_BASE+') printf "%s %s\\n" "$5" "$GUARD_G_PARENT" ;;\n'
            '  '+BACKUP_PARENT+') printf "%s %s\\n" "$5" "$GUARD_F_PARENT" ;;\n'
            '  '+DIAGNOSTIC_E+') printf "%s %s\\n" "$5" "$GUARD_E_PARENT" ;;\n'
            '  '+QUANTITY_BUSINESS+') printf "%s %s\\n" "$5" "$GUARD_B_PARENT" ;;\n'
            '  *) printf "%s %s\\n" "$GITHUB_SHA" "$GUARD_PARENTS" ;; esac ;;\n'
            'diff) if [ "$3" = "'+FORMAL_BASE+'" ]; then printf "%s\\n" "$GUARD_FORMAL_FILES"; elif [ "$3" = "'+BACKUP_PARENT+'" ] || [ "$3" = "'+BACKUP_READINESS_BASE+'" ]; then printf "%s\\n" "$GUARD_BACKUP_FILES"; elif [ "$3" = "'+DIAGNOSTIC_E+'" ]; then printf "%s\\n" "$GUARD_DIAGNOSTIC_FILES"; else printf "%s\\n" "$GUARD_FILES"; fi ;;\n'
            'rev-parse) printf "%s\\n" "$GUARD_HEAD" ;;\n'
            '*) exit 99 ;;\nesac\n')
        for stub in bindir.iterdir(): stub.chmod(0o755)
        env = {**os.environ, 'PATH':str(bindir)+':'+os.environ['PATH'],
               'RUNNER_OS':'Linux', 'RUNNER_ARCH':'X64',
               'GITHUB_REF':'refs/heads/'+SHIPPING_BRANCH, 'GITHUB_EVENT_NAME':'workflow_dispatch',
               'GITHUB_SHA':release, 'REQUESTED_RELEASE_SHA':release,
               'EXPECTED_PRODUCTION_SHA':SHIPPING_OLD, 'APPROVED_BUSINESS_SHA':SHIPPING_BUSINESS,
               'GUARD_PARENTS':SHIPPING_BUSINESS, 'GUARD_FILES':SHIPPING_ENGINEERING_FILES,
               'GUARD_HEAD':release,'GUARD_E_PARENT':QUANTITY_BUSINESS,'GUARD_B_PARENT':QUANTITY_OLD,
               'GUARD_DIAGNOSTIC_FILES':DIAGNOSTIC_FILES,'GUARD_F_PARENT':DIAGNOSTIC_E,'GUARD_G_PARENT':BACKUP_PARENT,'GUARD_BACKUP_FILES':BACKUP_FILES,'GUARD_H_PARENT':BACKUP_READINESS_BASE,'GUARD_FORMAL_FILES':FORMAL_FILES, **facts}
        return subprocess.run(['/bin/bash','-c',admission],env=env,capture_output=True,text=True)


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
        parsed=build_only_workflow()
        triggers=parsed.get('on',parsed.get('true'))
        self.assertEqual(set(triggers),{'push','workflow_dispatch'})
        self.assertEqual(triggers['push'],{'branches':LEGACY_BUILD_BRANCHES})
        self.assertEqual(triggers['workflow_dispatch']['inputs'],{'release_sha':{
            'description':'Shipping build-only: exact reviewed engineering release SHA',
            'required':True,'type':'string'}})
        self.assertEqual(parsed['permissions'],{'contents':'read'})
        self.assertIn('16faedb3afcb853a9a72434603debd4169b7ac02',parsed['env']['EXPECTED_PRODUCTION_SHA'])
        native=next(step for step in parsed['jobs']['artifact']['steps'] if step.get('name','').startswith('Prove lifecycle'))
        self.assertEqual(native['env'],{'NODE_ENV':'test','APP_ENV':'test','TEST_APPROVAL_NATIVE_CI':'1'})
        self.assertIn('test-approval-withdraw-native-ci.mjs',native['run'])
        job=parsed['jobs']['artifact']
        self.assertEqual(job['if'],"${{ github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && (github.ref == 'refs/heads/"+BACKUP_BRANCH+"' || github.ref == 'refs/heads/"+DIAGNOSTIC_BRANCH+"' || github.ref == 'refs/heads/"+QUANTITY_BRANCH+"' || github.ref == 'refs/heads/"+SHIPPING_BRANCH+"' || github.ref == 'refs/heads/"+PAYROLL_BRANCH+"' || github.ref == 'refs/heads/"+REVISION_BRANCH+"')) }}")
        self.assertEqual(job['runs-on'],'ubuntu-latest')
        self.assertEqual(job['steps'][0]['with']['ref'],'${{ github.sha }}')
        self.assertEqual(job['steps'][-1]['uses'],'actions/upload-artifact@v4')
        self.assertEqual(job['steps'][-1]['with']['retention-days'],1)
        verify=next(step for step in job['steps'] if step.get('name')=='Verify source and release guard')
        self.assertEqual(verify['env']['PYTHONPYCACHEPREFIX'],'${{ runner.temp }}/python-pycache')
        self.assertEqual(verify['env']['REQUESTED_RELEASE_SHA'],'${{ inputs.release_sha }}')
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

    def test_shipping_build_requires_exact_dispatch_sha_parent_and_two_files(self):
        accepted=build_only_guard()
        self.assertEqual(accepted.returncode,0,accepted.stderr)
        denied=[
            {'GITHUB_EVENT_NAME':'push'},
            {'GITHUB_REF':'refs/heads/codex/unreviewed'},
            {'GITHUB_REF':'refs/tags/'+SHIPPING_BRANCH},
            {'REQUESTED_RELEASE_SHA':''},
            {'REQUESTED_RELEASE_SHA':'b'*40},
            {'GITHUB_SHA':'a'*12,'REQUESTED_RELEASE_SHA':'a'*12},
            {'GITHUB_SHA':'A'*40,'REQUESTED_RELEASE_SHA':'A'*40},
            {'EXPECTED_PRODUCTION_SHA':OLD},
            {'APPROVED_BUSINESS_SHA':BUSINESS},
            {'GUARD_PARENTS':SHIPPING_OLD},
            {'GUARD_PARENTS':SHIPPING_BUSINESS+' '+'b'*40},
            {'GUARD_FILES':'.github/workflows/release-build-only.yml'},
            {'GUARD_FILES':SHIPPING_ENGINEERING_FILES+'\nserver/customer-requests.js'},
            {'GUARD_FILES':SHIPPING_ENGINEERING_FILES+'\n.github/workflows/deploy-prod.yml'},
            {'GUARD_HEAD':'b'*40},
        ]
        for facts in denied:
            with self.subTest(facts=facts):
                self.assertNotEqual(build_only_guard(**facts).returncode,0)

    def test_payroll_build_requires_exact_dispatch_sha_parent_and_two_files(self):
        base = {'GITHUB_REF':'refs/heads/'+PAYROLL_BRANCH,
                'EXPECTED_PRODUCTION_SHA':PAYROLL_OLD,
                'APPROVED_BUSINESS_SHA':PAYROLL_BUSINESS,
                'GUARD_PARENTS':PAYROLL_BUSINESS}
        accepted=build_only_guard(**base)
        self.assertEqual(accepted.returncode,0,accepted.stderr)
        denied=[
            {'GITHUB_EVENT_NAME':'push'},
            {'GITHUB_REF':'refs/heads/codex/unreviewed'},
            {'GITHUB_REF':'refs/tags/'+PAYROLL_BRANCH},
            {'REQUESTED_RELEASE_SHA':''},
            {'REQUESTED_RELEASE_SHA':'b'*40},
            {'GITHUB_SHA':'a'*12,'REQUESTED_RELEASE_SHA':'a'*12},
            {'GITHUB_SHA':'A'*40,'REQUESTED_RELEASE_SHA':'A'*40},
            {'EXPECTED_PRODUCTION_SHA':SHIPPING_OLD},
            {'APPROVED_BUSINESS_SHA':SHIPPING_BUSINESS},
            {'GUARD_PARENTS':PAYROLL_OLD},
            {'GUARD_PARENTS':PAYROLL_BUSINESS+' '+'b'*40},
            {'GUARD_FILES':'.github/workflows/release-build-only.yml'},
            {'GUARD_FILES':SHIPPING_ENGINEERING_FILES+'\nserver/payroll-authority.js'},
            {'GUARD_FILES':SHIPPING_ENGINEERING_FILES+'\n.github/workflows/deploy-prod.yml'},
            {'GUARD_HEAD':'b'*40},
        ]
        for facts in denied:
            with self.subTest(facts=facts):
                self.assertNotEqual(build_only_guard(**{**base,**facts}).returncode,0)

    def test_revision_build_requires_exact_dispatch_sha_parent_and_two_files(self):
        base = {'GITHUB_REF':'refs/heads/'+REVISION_BRANCH,
                'EXPECTED_PRODUCTION_SHA':REVISION_OLD,
                'APPROVED_BUSINESS_SHA':REVISION_BUSINESS,
                'GUARD_PARENTS':REVISION_BUSINESS}
        accepted=build_only_guard(**base)
        self.assertEqual(accepted.returncode,0,accepted.stderr)
        denied=[
            {'GITHUB_EVENT_NAME':'push'},
            {'GITHUB_REF':'refs/heads/codex/unreviewed'},
            {'GITHUB_REF':'refs/tags/'+REVISION_BRANCH},
            {'REQUESTED_RELEASE_SHA':''},
            {'REQUESTED_RELEASE_SHA':'b'*40},
            {'GITHUB_SHA':'a'*12,'REQUESTED_RELEASE_SHA':'a'*12},
            {'GITHUB_SHA':'A'*40,'REQUESTED_RELEASE_SHA':'A'*40},
            {'EXPECTED_PRODUCTION_SHA':PAYROLL_OLD},
            {'APPROVED_BUSINESS_SHA':PAYROLL_BUSINESS},
            {'GUARD_PARENTS':REVISION_OLD},
            {'GUARD_PARENTS':REVISION_BUSINESS+' '+'b'*40},
            {'GUARD_PARENTS':''},
            {'GUARD_FILES':'.github/workflows/release-build-only.yml'},
            {'GUARD_FILES':SHIPPING_ENGINEERING_FILES+'\nserver/payroll-audit-scheduler-core.js'},
            {'GUARD_FILES':SHIPPING_ENGINEERING_FILES+'\nscripts/payroll-audit-scheduler.mjs'},
            {'GUARD_FILES':SHIPPING_ENGINEERING_FILES+'\nscripts/deploy-prod-transfer-cas.py'},
            {'GUARD_FILES':SHIPPING_ENGINEERING_FILES+'\n.github/workflows/deploy-prod.yml'},
            {'GUARD_FILES':''},
            {'GUARD_HEAD':'b'*40},
            {'RUNNER_OS':'macOS'},
            {'RUNNER_ARCH':'ARM64'},
        ]
        for facts in denied:
            with self.subTest(facts=facts):
                self.assertNotEqual(build_only_guard(**{**base,**facts}).returncode,0)

    def test_revision_build_preserves_legacy_bindings_and_exact_business_payload(self):
        workflow=build_only_workflow()
        self.assertTrue(without_quantity_binding(workflow['env']['EXPECTED_PRODUCTION_SHA'],'EXPECTED_PRODUCTION_SHA').startswith(
            "${{ github.ref == 'refs/heads/"+REVISION_BRANCH+"' && '"+REVISION_OLD+"' || "))
        self.assertTrue(without_quantity_binding(workflow['env']['APPROVED_BUSINESS_SHA'],'APPROVED_BUSINESS_SHA').startswith(
            "${{ github.ref == 'refs/heads/"+REVISION_BRANCH+"' && '"+REVISION_BUSINESS+"' || "))
        steps=workflow['jobs']['artifact']['steps']
        build=next(step for step in steps if step.get('name','').startswith('Build exact'))['run']
        revision=build.split('elif [ "$GITHUB_REF" = refs/heads/'+REVISION_BRANCH+' ]; then',1)[1].split('else',1)[0]
        self.assertIn('git diff --exit-code "$APPROVED_BUSINESS_SHA" "$GITHUB_SHA"',revision)
        self.assertIn('server prisma cloudfunctions src shared Dockerfile package.json package-lock.json',revision)
        self.assertIn("'scripts/payroll-audit-*.mjs' scripts/render-payroll-audit-pdf.mjs",revision)
        self.assertIn('REPORT_REVISION_BUSINESS_PAYLOAD_UNCHANGED=YES',revision)
        self.assertIn(REVISION_BRANCH,steps[-1]['with']['name'])
        self.assertIn("format('release-staging-{0}', github.sha)",steps[-1]['with']['name'])
        self.assertIn("format('release-preflight-{0}', github.sha)",steps[-1]['with']['name'])
        source=(ROOT/'.github/workflows/release-build-only.yml').read_text()
        prior=subprocess.check_output(['git','-C',str(ROOT),'show',
                                       REVISION_BUSINESS+':.github/workflows/release-build-only.yml'],text=True)
        # Exact pre-existing shell branch admission rules are retained byte for byte.
        for branch in [SHIPPING_BRANCH,PAYROLL_BRANCH]:
            with self.subTest(branch=branch):
                token='            '+branch+')'
                self.assertEqual(source.split(token,1)[1].split(';;',1)[0],
                                 prior.split(token,1)[1].split(';;',1)[0])
        for key in ['EXPECTED_PRODUCTION_SHA','APPROVED_BUSINESS_SHA']:
            old_line=next(line for line in prior.splitlines() if line.startswith('  '+key+':'))
            new_line=next(line for line in source.splitlines() if line.startswith('  '+key+':'))
            new_prefix="github.ref == 'refs/heads/"+REVISION_BRANCH+"' && '"+(REVISION_OLD if key=='EXPECTED_PRODUCTION_SHA' else REVISION_BUSINESS)+"' || "
            self.assertEqual(without_quantity_binding(new_line,key).replace(new_prefix,'',1),old_line)

    def test_payroll_build_retains_exact_artifact_and_business_payload(self):
        workflow=build_only_workflow()
        self.assertIn(PAYROLL_OLD,workflow['env']['EXPECTED_PRODUCTION_SHA'])
        self.assertIn(PAYROLL_BUSINESS,workflow['env']['APPROVED_BUSINESS_SHA'])
        steps=workflow['jobs']['artifact']['steps']
        build=next(step for step in steps if step.get('name','').startswith('Build exact'))['run']
        payroll=build.split('elif [ "$GITHUB_REF" = refs/heads/'+PAYROLL_BRANCH+' ]; then',1)[1].split('else',1)[0]
        self.assertIn('git diff --exit-code "$APPROVED_BUSINESS_SHA" "$GITHUB_SHA"',payroll)
        self.assertIn('server prisma cloudfunctions src shared Dockerfile package.json package-lock.json',payroll)
        self.assertIn('PAYROLL_BUSINESS_PAYLOAD_UNCHANGED=YES',payroll)
        self.assertIn(PAYROLL_BRANCH,steps[-1]['with']['name'])
        self.assertIn("format('release-staging-{0}', github.sha)",steps[-1]['with']['name'])
        self.assertIn("format('release-preflight-{0}', github.sha)",steps[-1]['with']['name'])

    def test_legacy_build_branches_keep_push_and_deny_manual_dispatch(self):
        for branch in LEGACY_BUILD_BRANCHES:
            with self.subTest(branch=branch):
                facts={'GITHUB_REF':'refs/heads/'+branch,'GITHUB_EVENT_NAME':'push',
                       'EXPECTED_PRODUCTION_SHA':OLD,'APPROVED_BUSINESS_SHA':BUSINESS,
                       'REQUESTED_RELEASE_SHA':''}
                accepted=build_only_guard(**facts)
                self.assertEqual(accepted.returncode,0,accepted.stderr)
                facts['GITHUB_EVENT_NAME']='workflow_dispatch'
                self.assertNotEqual(build_only_guard(**facts).returncode,0)

    def test_shipping_build_retains_exact_artifact_and_business_payload(self):
        workflow=build_only_workflow()
        self.assertIn(SHIPPING_OLD,workflow['env']['EXPECTED_PRODUCTION_SHA'])
        self.assertIn(SHIPPING_BUSINESS,workflow['env']['APPROVED_BUSINESS_SHA'])
        steps=workflow['jobs']['artifact']['steps']
        build=next(step for step in steps if step.get('name','').startswith('Build exact'))['run']
        shipping=build.split('if [ "$GITHUB_REF" = refs/heads/'+SHIPPING_BRANCH+' ]; then',1)[1].split('else',1)[0]
        self.assertIn('git diff --exit-code "$APPROVED_BUSINESS_SHA" "$GITHUB_SHA"',shipping)
        self.assertIn('server prisma cloudfunctions src shared Dockerfile package.json package-lock.json',shipping)
        self.assertIn('SHIPPING_BUSINESS_PAYLOAD_UNCHANGED=YES',shipping)
        self.assertIn("format('release-staging-{0}', github.sha)",steps[-1]['with']['name'])
        self.assertIn("format('release-preflight-{0}', github.sha)",steps[-1]['with']['name'])
        for step in steps:
            if step.get('name','').startswith(('Setup Node','Prove lifecycle')):
                self.assertEqual(step['if'],"github.ref == 'refs/heads/codex/data-authority-finalization'")
        probe=next(step for step in steps if step.get('name','').startswith('Probe application'))
        self.assertIn('test-candidate-db-probe-integration.py "budu-api:post-transfer-${GITHUB_SHA:0:12}"',probe['run'])

    def test_quantity_ci_calls_exact_controller_and_retains_scoped_proof(self):
        steps=build_only_workflow()['jobs']['artifact']['steps']
        probe=next(step for step in steps if step.get('name','').startswith('Probe application'))
        self.assertIn('test-candidate-db-probe-integration.py --shipping-controller-ci',probe['run'])
        self.assertIn('"$RELEASE_ARTIFACT_PATH"',probe['run'])
        self.assertIn('sudo -n --preserve-env=',probe['run'])
        proof=next(step for step in steps if step.get('name')=='Retain isolated real shipping controller proof')
        self.assertEqual(proof['if'],'success() && '+SHIPPING_CI_REFS)
        self.assertEqual(proof['with']['if-no-files-found'],'error')
        self.assertEqual(proof['with']['path'],'${{ runner.temp }}/shipping-controller-proof.json')

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
                  'timeout 290m bash scripts/deploy-prod-transfer-cas.sh deploy --repo',
                  ' deploy --repo','--authorize-release-sha "$RELEASE_SHA"')
        for value in required:self.assertIn(value,source)
        for value in ('set -x','--build-arg','--secret','docker prune','system prune','prisma migrate','pg_dump'):
            self.assertNotIn(value,source)


class QuantityReleaseContract(unittest.TestCase):
    def test_real_build_guard_accepts_only_exact_six_file_single_parent(self):
        facts={'GITHUB_REF':'refs/heads/'+QUANTITY_BRANCH,
               'EXPECTED_PRODUCTION_SHA':QUANTITY_OLD,'APPROVED_BUSINESS_SHA':QUANTITY_BUSINESS,
               'GUARD_PARENTS':FORMAL_BASE,'GUARD_FILES':QUANTITY_ENGINEERING_FILES}
        self.assertEqual(build_only_guard(**facts).returncode,0)
        denied=[{'GITHUB_EVENT_NAME':'push'}, {'REQUESTED_RELEASE_SHA':''},
                {'REQUESTED_RELEASE_SHA':'b'*40}, {'GITHUB_SHA':'short'},
                {'EXPECTED_PRODUCTION_SHA':PAYROLL_OLD}, {'APPROVED_BUSINESS_SHA':SHIPPING_BUSINESS},
                {'GUARD_PARENTS':QUANTITY_BUSINESS}, {'GUARD_PARENTS':FORMAL_BASE+' '+'b'*40},
                {'GUARD_H_PARENT':BACKUP_PARENT},{'GUARD_G_PARENT':DIAGNOSTIC_E},
                {'GUARD_F_PARENT':QUANTITY_BUSINESS},{'GUARD_E_PARENT':QUANTITY_OLD},{'GUARD_B_PARENT':DIAGNOSTIC_E},
                {'GUARD_FORMAL_FILES':FORMAL_FILES+'\nserver/v2.js'},
                {'GUARD_FORMAL_FILES':FORMAL_FILES+'\nprisma/schema.prisma'},
                {'GUARD_FORMAL_FILES':FORMAL_FILES+'\n.github/workflows/deploy-prod.yml'},
                {'GUARD_FILES':QUANTITY_ENGINEERING_FILES+'\nserver/v2.js'},
                {'GUARD_FILES':QUANTITY_ENGINEERING_FILES+'\nprisma/schema.prisma'},
                {'GUARD_FILES':QUANTITY_ENGINEERING_FILES+'\n.github/workflows/deploy-prod.yml'},
                {'GUARD_FILES':SHIPPING_ENGINEERING_FILES}, {'GUARD_HEAD':'b'*40},
                {'RUNNER_ARCH':'ARM64'}, {'RUNNER_OS':'macOS'},
                {'GITHUB_REF':'refs/heads/codex/unreviewed-shipping'}]
        for changed in denied:
            with self.subTest(changed=changed):self.assertNotEqual(build_only_guard(**{**facts,**changed}).returncode,0)

    def test_quantity_ci_retains_old_source_and_exact_cli_real_pg16_proof(self):
        workflow=build_only_workflow();steps=workflow['jobs']['artifact']['steps']
        for key in ('EXPECTED_PRODUCTION_SHA','APPROVED_BUSINESS_SHA'):
            without_quantity_binding(workflow['env'][key],key)
        old=next(step for step in steps if step['name']=='Build exact old application for isolated shipping compatibility')
        self.assertEqual(old['if'],'success() && '+SHIPPING_CI_REFS)
        self.assertIn('git archive '+QUANTITY_OLD,old['run']);self.assertIn('--platform linux/amd64',old['run'])
        self.assertIn('--load "$old_dir"',old['run'])
        build=next(step for step in steps if step['name'].startswith('Build exact production'))['run']
        quantity=build.split('elif [ "$GITHUB_REF" = refs/heads/'+QUANTITY_BRANCH+' ] || [ "$GITHUB_REF" = refs/heads/'+DIAGNOSTIC_BRANCH+' ] || [ "$GITHUB_REF" = refs/heads/'+BACKUP_BRANCH+' ]; then',1)[1].split('else',1)[0]
        self.assertIn('server prisma cloudfunctions src shared Dockerfile package.json package-lock.json',quantity)
        self.assertIn('PINNED_PRISMA_CLI_OK',quantity);self.assertIn('6.19.3',quantity)
        probe=next(step for step in steps if step['name'].startswith('Probe application'))['run']
        self.assertIn('"budu-api:shipping-old-'+QUANTITY_OLD[:12]+'"',probe)
        module=(ROOT/'scripts/test-candidate-db-probe-integration.py').read_text()
        for token in ("'postgres:16.14'",'validate_snapshots(before,after)','OLD_COMPAT_JS',
                      "'migrate','deploy'",'createTransferExportWorkbook','XLSX.read',
                      'SHIPPING_CI_COMMIT_LEDGER_GAP_FAILED'):
            self.assertIn(token,module)

    def test_controller_finite_identity_rejects_wrong_parent_scope_and_sql(self):
        names=('RELEASE_PROFILE','EXPECTED_OLD_SHA','RUNTIME_SHA','OLD_V2_HASH','IMAGE_PREFIX','CONTAINER_SUFFIX','ROLLBACK_PREFIX')
        saved=[getattr(r,k) for k in names]
        try:
            r.configure_profile('post-transfer',QUANTITY_OLD,QUANTITY_BUSINESS,'a'*64)
            candidate='e'*40;path='prisma/migrations/'+r.SHIPPING_MIGRATION+'/migration.sql'
            def facts(repo,*args):
                if args==('branch','--show-current'):return QUANTITY_BRANCH
                if args[:1]==('rev-list',):
                    parents={candidate:FORMAL_BASE,FORMAL_BASE:BACKUP_READINESS_BASE,BACKUP_READINESS_BASE:BACKUP_PARENT,BACKUP_PARENT:DIAGNOSTIC_E,DIAGNOSTIC_E:QUANTITY_BUSINESS,QUANTITY_BUSINESS:QUANTITY_OLD}
                    return args[-1]+' '+parents[args[-1]]
                if args==('diff','--name-only',FORMAL_BASE,candidate):return FORMAL_FILES
                if args==('diff','--name-only',QUANTITY_BUSINESS,candidate):return QUANTITY_ENGINEERING_FILES
                if args[:2]==('diff','--name-only') or args[:2]==('diff','--diff-filter=A'):return path
                raise AssertionError(args)
            with patch.object(r,'git',side_effect=facts):r.validate_shipping_identity(ROOT,candidate)
            changes=[(('branch','--show-current'),'main','SHIPPING_BRANCH_INVALID'),
                     (('branch','--show-current'),BACKUP_BRANCH,'SHIPPING_BRANCH_INVALID'),
                     (('branch','--show-current'),DIAGNOSTIC_BRANCH,'SHIPPING_BRANCH_INVALID'),
                     (('rev-list','--parents','-n','1',candidate),candidate+' '+QUANTITY_BUSINESS,'SHIPPING_ENGINEERING_PARENT_INVALID'),
                     (('rev-list','--parents','-n','1',candidate),candidate+' '+FORMAL_BASE+' '+QUANTITY_BUSINESS,'SHIPPING_ENGINEERING_PARENT_INVALID'),
                     *[(('rev-list','--parents','-n','1',child),child+' '+FORMAL_BASE,'SHIPPING_ENGINEERING_PARENT_INVALID') for child in (FORMAL_BASE,BACKUP_READINESS_BASE,BACKUP_PARENT,DIAGNOSTIC_E,QUANTITY_BUSINESS)],
                     (('diff','--name-only',FORMAL_BASE,candidate),FORMAL_FILES+'\nserver/v2.js','SHIPPING_ENGINEERING_SCOPE_INVALID'),
                     (('rev-list','--parents','-n','1',candidate),candidate+' '+QUANTITY_OLD,'SHIPPING_ENGINEERING_PARENT_INVALID'),
                     (('diff','--name-only',QUANTITY_BUSINESS,candidate),QUANTITY_ENGINEERING_FILES+'\nserver/v2.js','SHIPPING_ENGINEERING_SCOPE_INVALID'),
                     (('diff','--name-only',QUANTITY_OLD,candidate,'--','prisma'),path+'\nprisma/schema.prisma','SHIPPING_MIGRATION_SCOPE_INVALID'),
                     (('diff','--diff-filter=A','--name-only',QUANTITY_OLD,candidate,'--',path),'','SHIPPING_MIGRATION_SCOPE_INVALID')]
            for key,value,code in changes:
                with self.subTest(code=code),patch.object(r,'git',side_effect=lambda repo,*args: value if args==key else facts(repo,*args)):
                    with self.assertRaisesRegex(r.GateError,code):r.validate_shipping_identity(ROOT,candidate)
            with patch.object(r,'git',side_effect=facts),patch.object(r,'digest',return_value='f'*64):
                with self.assertRaisesRegex(r.GateError,'SHIPPING_SQL_HASH_INVALID'):r.validate_shipping_identity(ROOT,candidate)
        finally:
            for key,value in zip(names,saved):setattr(r,key,value)


class ShippingControllerCiIsolation(unittest.TestCase):
    def setUp(self):
        spec=importlib.util.spec_from_file_location('isolated_ci',ROOT/'scripts/test-candidate-db-probe-integration.py')
        self.ci=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.ci)
        self.ci.release.configure_profile('post-transfer',QUANTITY_OLD,QUANTITY_BUSINESS,'a'*64)
        self.sha='e'*40
        self.environment={'GITHUB_ACTIONS':'true','RUNNER_OS':'Linux','GITHUB_REPOSITORY':'GPTJJ/budu',
                          'GITHUB_REF':'refs/heads/'+QUANTITY_BRANCH,'TEST_SHIPPING_CONTROLLER_CI':'1',
                          'RUNNER_TEMP':'/tmp/owned-fixture','GITHUB_SHA':self.sha}

    def remote(self,mode='success'):
        return self.ci.ControllerCiRemote('/tmp/owned-fixture','own-network','own-old','own-candidate',mode)

    def test_ci_entrypoint_denies_local_production_remote_and_wrong_scope(self):
        with patch.dict(os.environ,self.environment,clear=True),patch.object(sys,'platform','linux'),patch.object(os,'geteuid',return_value=0):
            self.ci.controller_ci_guard()
            for key,value in [('GITHUB_ACTIONS','false'),('RUNNER_OS','macOS'),('GITHUB_REPOSITORY','other/repo'),
                              ('GITHUB_REF','refs/heads/main'),('TEST_SHIPPING_CONTROLLER_CI','0'),
                              ('RUNNER_TEMP',''),('DOCKER_HOST','tcp://remote:2375'),('DOCKER_CONTEXT','production')]:
                with self.subTest(key=key),patch.dict(os.environ,{key:value}):
                    with self.assertRaisesRegex(RuntimeError,'ISOLATED_LINUX_CI_REQUIRED'):self.ci.controller_ci_guard()
            with patch.object(sys,'platform','darwin'):
                with self.assertRaises(RuntimeError):self.ci.controller_ci_guard()
            with patch.object(os,'geteuid',return_value=1000):
                with self.assertRaises(RuntimeError):self.ci.controller_ci_guard()

    def test_adapter_rejects_external_commands_before_execution(self):
        with patch.object(self.ci.release.LocalRemote,'run',side_effect=AssertionError('PROCESS_FORBIDDEN')):
            for command in (['ssh','production'],['scp','file','production'],['curl','https://buducandy.cn']):
                with self.assertRaisesRegex(RuntimeError,'CI_EXTERNAL_TARGET_FORBIDDEN'):self.remote().run(command)

    def test_backup_root_escape_denied_and_only_dump_limit_is_injected(self):
        remote=self.remote('backup_limit');r=self.ci.release
        limits={'backupLimit':100,'restoreLimit':200,'walLimit':300,'migratorLimit':400}
        with patch.dict(os.environ,self.environment,clear=True),patch.object(r.LocalRemote,'py',return_value=b'{}') as execute:
            with self.assertRaisesRegex(RuntimeError,'CI_ROLLBACK_PATH_ESCAPE'):
                remote.py(r.SHIPPING_BACKUP_RESTORE_CODE,{'root':'/opt/other','limits':limits})
            self.assertFalse(execute.called)
            root='/opt/budu/.rollback-assets/'+r.ROLLBACK_PREFIX+self.sha
            remote.py(r.SHIPPING_BACKUP_RESTORE_CODE,{'root':root,'limits':limits})
            code,value,_=execute.call_args.args
            self.assertEqual(code,r.SHIPPING_BACKUP_RESTORE_CODE)
            self.assertTrue(value['root'].startswith('/tmp/owned-fixture/rollback/'))
            self.assertEqual(value['limits'],{**limits,'backupLimit':16})
            self.assertEqual(limits['backupLimit'],100)

    def test_resource_failure_is_only_injected_after_real_l86_observation(self):
        remote=self.remote('post_l86_disk');r=self.ci.release
        with patch.object(r.LocalRemote,'disk',return_value=(20*r.GIB,40*r.GIB)),\
             patch.object(r.LocalRemote,'db',return_value={'applied':85,'failed':0}) as database,\
             patch.object(self.ci,'docker',return_value='') as docker_call:
            self.assertEqual(remote.disk(),(20*r.GIB,40*r.GIB))
            remote.migrator_started=True
            self.assertEqual(remote.disk(),(20*r.GIB,40*r.GIB))
            self.assertFalse(docker_call.called)
            database.return_value={'applied':86,'failed':0}
            with self.assertRaisesRegex(r.GateError,'SHIPPING_MIGRATION_DISK_GATE_FAILED'):
                r.shipping_disk_gate(remote,{'walLimit':1,'migratorLimit':1})
            self.assertTrue(remote.disk_samples[-1]['injected'])
            self.assertEqual(remote.disk_samples[-1]['available'],40*r.GIB)
            self.assertEqual(docker_call.call_args.args[-2],'-c')

    def test_alias_adapter_denies_extra_aliases_and_networks(self):
        fixture={'Id':'f'*64,'NetworkSettings':{'Networks':{'own-network':{'Aliases':['own-old','f'*12],'IPAddress':'172.20.0.2'}}}}
        with patch.object(self.ci.release.LocalRemote,'inspect',return_value=fixture):
            result=self.remote().inspect('own-old')
            self.assertIsNone(result['NetworkSettings']['Networks']['own-network']['Aliases'])
            self.assertEqual(result['NetworkSettings']['Networks']['own-network']['IPAddress'],'172.20.0.2')
            self.assertIsNotNone(fixture['NetworkSettings']['Networks']['own-network']['Aliases'])
            fixture['NetworkSettings']['Networks']['own-network']['Aliases'].append('production')
            with self.assertRaisesRegex(RuntimeError,'CI_UNEXPECTED_NETWORK_ALIAS'):self.remote().inspect('own-old')


class ShippingDiagnosticWorkflow(unittest.TestCase):
    def test_finite_diagnostic_guard_does_not_generalize_release_ancestry(self):
        base={'GITHUB_REF':'refs/heads/'+DIAGNOSTIC_BRANCH,'EXPECTED_PRODUCTION_SHA':QUANTITY_OLD,
              'APPROVED_BUSINESS_SHA':QUANTITY_BUSINESS,'GUARD_PARENTS':DIAGNOSTIC_E,
              'GUARD_FILES':QUANTITY_ENGINEERING_FILES}
        accepted=build_only_guard(**base);self.assertEqual(accepted.returncode,0,accepted.stderr)
        for change in ({'GITHUB_EVENT_NAME':'push'},{'REQUESTED_RELEASE_SHA':'b'*40},
                       {'GITHUB_SHA':DIAGNOSTIC_E,'REQUESTED_RELEASE_SHA':DIAGNOSTIC_E},
                       {'GUARD_PARENTS':QUANTITY_BUSINESS},{'GUARD_PARENTS':DIAGNOSTIC_E+' '+QUANTITY_BUSINESS},
                       {'GUARD_E_PARENT':QUANTITY_OLD},{'GUARD_B_PARENT':DIAGNOSTIC_E},
                       {'GUARD_DIAGNOSTIC_FILES':DIAGNOSTIC_FILES+'\nserver/v2.js'},
                       {'GUARD_DIAGNOSTIC_FILES':''},{'GUARD_FILES':DIAGNOSTIC_FILES},
                       {'EXPECTED_PRODUCTION_SHA':'f'*40},{'APPROVED_BUSINESS_SHA':'f'*40}):
            with self.subTest(change=change):self.assertNotEqual(build_only_guard(**{**base,**change}).returncode,0)

    def test_always_failure_upload_cannot_publish_success_proof_or_production_candidate(self):
        steps=build_only_workflow()['jobs']['artifact']['steps']
        validate=next(x for x in steps if x['name']=='Validate isolated shipping failure diagnostics')
        upload=next(x for x in steps if x['name']=='Retain isolated shipping failure diagnostics')
        self.assertEqual(validate['if'],'always() && '+SHIPPING_CI_REFS)
        self.assertEqual(upload['if'],"always() && "+SHIPPING_CI_REFS+" && steps.shipping_diagnostic.outputs.failed == 'true'")
        self.assertEqual(upload['with']['path'],'${{ runner.temp }}/shipping-controller-diagnostic.json')
        proof=next(x for x in steps if x['name']=='Retain isolated real shipping controller proof')
        self.assertTrue(proof['if'].startswith('success() && '))
        self.assertNotIn('always()',steps[-1].get('if',''))
        self.assertIn("format('shipping-diagnostic-image-{0}', github.sha)",steps[-1]['with']['name'])
        for status,allowed in [('FAILED',True),('UNVERIFIED',True),('PASS',False),('DEPLOY_COMPLETE',False)]:
            with tempfile.TemporaryDirectory() as directory:
                root=Path(directory);out=root/'github-output'
                row={'exactSHA':'a'*40,'case':'success','completedCases':[],
                     'stage':'PREFLIGHT','code':'COMMAND_FAILED','result':status,'injection':['PRIMARY']}
                (root/'shipping-controller-diagnostic.json').write_text(json.dumps([row]))
                result=subprocess.run(['/bin/bash','-c',validate['run']],capture_output=True,
                    env={**os.environ,'RUNNER_TEMP':directory,'GITHUB_OUTPUT':str(out),'GITHUB_SHA':'a'*40})
                self.assertEqual(result.returncode==0,allowed)
                self.assertEqual(out.exists(),allowed)

    def test_all_production_safety_functions_constants_and_native_fixtures_unchanged_from_e(self):
        def nodes(source):
            return {node.name:ast.dump(node,include_attributes=False) for node in ast.parse(source).body
                    if isinstance(node,(ast.FunctionDef,ast.ClassDef))}
        path='scripts/deploy-prod-transfer-cas.py'
        old=subprocess.check_output(['git','-C',str(ROOT),'show',DIAGNOSTIC_E+':'+path],text=True)
        before=nodes(old);after=nodes((ROOT/path).read_text())
        for name,body in before.items():
            if name not in ('main','validate_shipping_identity'):self.assertEqual(after[name],body,name)
        def assignments(source):
            return {ast.dump(node.targets[0]):ast.dump(node.value) for node in ast.parse(source).body
                    if isinstance(node,ast.Assign)}
        for key,value in assignments(old).items():
            if key != ast.dump(ast.Name(id='SHIPPING_BACKUP_RESTORE_CODE',ctx=ast.Store())):
                self.assertEqual(assignments((ROOT/path).read_text())[key],value,key)
        path='scripts/test-candidate-db-probe-integration.py'
        old=subprocess.check_output(['git','-C',str(ROOT),'show',DIAGNOSTIC_E+':'+path],text=True)
        before=nodes(old);after=nodes((ROOT/path).read_text())
        for name in ('native_pg16','validate_snapshots','shipping_pg16_ci','main','LocalDocker'):
            self.assertEqual(before[name],after[name],name)
        for key,value in assignments(old).items():
            self.assertEqual(assignments((ROOT/path).read_text())[key],value,key)
        changed=subprocess.check_output(['git','-C',str(ROOT),'diff','--name-only',DIAGNOSTIC_E,'--',
            'server','src','shared','prisma','scripts/deploy-remote.sh','scripts/deploy-prod-transfer-cas.sh'],text=True)
        self.assertEqual(changed,'')


class ShippingDiagnosticFailures(unittest.TestCase):
    setUp = ShippingControllerCiIsolation.setUp
    remote = ShippingControllerCiIsolation.remote
    def invoke(self,action,directory):
        environment={**self.environment,'RUNNER_TEMP':directory,'GITHUB_REF':'refs/heads/'+DIAGNOSTIC_BRANCH}
        with patch.dict(os.environ,environment,clear=True),patch.object(sys,'platform','linux'),patch.object(os,'geteuid',return_value=0),\
             patch.object(self.ci,'_shipping_controller_ci',side_effect=action):
            return self.ci.shipping_controller_ci('image','old','archive')

    def test_unexpected_controller_failure_keeps_original_gate_object_stage_and_result(self):
        error=self.ci.release.GateError('COMMAND_FAILED');error.failure_stage='CANDIDATE_CREATE';error.deployment_result='DEPLOY_BLOCKED'
        with self.assertRaises(self.ci.release.GateError) as caught:
            self.ci.verify_controller_failure(error,('PUBLIC_HEALTH','HEALTH_FAILED'))
        self.assertIs(caught.exception,error)
        self.assertEqual(error.failure_stage,'CANDIDATE_CREATE');self.assertEqual(str(error),'COMMAND_FAILED')
        with tempfile.TemporaryDirectory() as directory:
            diag=self.ci.CiFailureDiagnostics(Path(directory)/'diag.json',self.sha);diag.primary(error)
            self.assertIn('CONTROLLER_DEPLOY_BLOCKED',diag.records[0]['injection'])
            self.ci.validate_ci_diagnostic_records(diag.records,self.sha)

    def test_diagnostic_validation_rejects_unknown_labels_codes_fields_and_claimed_success(self):
        with tempfile.TemporaryDirectory() as directory:
            diag=self.ci.CiFailureDiagnostics(Path(directory)/'diag.json',self.sha)
            diag.primary(self.ci.release.GateError('COMMAND_FAILED'))
            for changes in ({'injection':['SECRET_VALUE']},{'code':'SECRET_VALUE'},{'result':'PASS'},
                            {'exactSHA':'f'*40},{'completedCases':['backup_limit']},{'rawstderr':'private'}):
                with self.subTest(changes=changes),self.assertRaises(AssertionError):
                    self.ci.validate_ci_diagnostic_records([{**diag.records[0],**changes}],self.sha)

    def test_primary_is_saved_before_cleanup_and_secondary_failure_never_masks_it(self):
        error=self.ci.release.GateError('SHIPPING_MIGRATOR_UNVERIFIED')
        error.failure_stage='SHIPPING_CHECK_MIGRATION';error.deployment_result='DEPLOY_ROLLED_BACK'
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'shipping-controller-diagnostic.json'
            def inner(image,old,archive,diagnostics):
                diagnostics.case='post_l86_disk';diagnostics.completed=['success']
                try:raise error
                except BaseException as original:
                    diagnostics.primary(original)
                    self.assertEqual(json.loads(target.read_text())[0]['code'],str(error))
                    diagnostics.cleanup(lambda: (_ for _ in ()).throw(RuntimeError('SECRET_DATABASE_URL')),'CONTAINER_CLEANUP')
                    raise
            with self.assertRaises(self.ci.release.GateError) as caught:self.invoke(inner,directory)
            self.assertIs(caught.exception,error)
            records=json.loads(target.read_text());self.assertEqual(len(records),2)
            self.assertEqual(records[0]['completedCases'],['success']);self.assertEqual(records[0]['result'],'FAILED')
            self.assertEqual(records[1]['result'],'UNVERIFIED');self.assertEqual(records[1]['code'],'DETAILS_SUPPRESSED')
            self.assertNotIn('SECRET_DATABASE_URL',target.read_text())
            self.assertFalse((Path(directory)/'shipping-controller-proof.json').exists())
            for record in records:self.assertEqual(set(record),{'exactSHA','case','completedCases','stage','code','result','injection'})

    def test_temporary_directory_cleanup_error_cannot_replace_saved_primary(self):
        error=self.ci.release.GateError('HEALTH_FAILED');error.failure_stage='PUBLIC_HEALTH'
        def inner(image,old,archive,diagnostics):
            diagnostics.primary(error)
            raise PermissionError('private cleanup path')
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(self.ci.release.GateError) as caught:self.invoke(inner,directory)
            self.assertIs(caught.exception,error)
            rows=json.loads((Path(directory)/'shipping-controller-diagnostic.json').read_text())
            self.assertEqual(rows[0]['code'],'HEALTH_FAILED');self.assertIn('TEMP_DIRECTORY_CLEANUP',rows[1]['injection'])

    def test_cleanup_only_failure_is_unverified_nonzero_and_never_success(self):
        error=RuntimeError('CI_CLEANUP_OWNERSHIP_CHANGED')
        def inner(image,old,archive,diagnostics):
            diagnostics.cleanup(lambda: (_ for _ in ()).throw(error),'CONTAINER_CLEANUP')
            diagnostics.raise_cleanup()
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError) as caught:self.invoke(inner,directory)
            self.assertIs(caught.exception,error)
            rows=json.loads((Path(directory)/'shipping-controller-diagnostic.json').read_text())
            self.assertEqual(len(rows),1);self.assertEqual(rows[0]['result'],'UNVERIFIED')
            self.assertFalse((Path(directory)/'shipping-controller-proof.json').exists())

    def test_success_does_not_emit_failure_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            self.invoke(lambda *args:None,directory)
            self.assertFalse((Path(directory)/'shipping-controller-diagnostic.json').exists())

    def test_diagnostic_writer_failure_and_unknown_exception_do_not_replace_primary(self):
        error=RuntimeError('SECRET_PRIVATE_KEY')
        with tempfile.TemporaryDirectory() as directory,patch.object(self.ci.tempfile,'mkstemp',side_effect=OSError('secret path')),\
             patch.object(sys,'stderr',new_callable=__import__('io').StringIO) as stderr:
            def inner(image,old,archive,diagnostics):diagnostics.primary(error);raise error
            with self.assertRaises(RuntimeError) as caught:self.invoke(inner,directory)
            self.assertIs(caught.exception,error)
            self.assertNotIn('SECRET_PRIVATE_KEY',stderr.getvalue());self.assertNotIn('secret path',stderr.getvalue())
            self.assertIn('CI_DIAGNOSTIC_WRITE_FAILED',stderr.getvalue())

    def test_command_failure_emits_only_bounded_operation_not_argv_or_stderr(self):
        error=self.ci.release.GateError('COMMAND_FAILED')
        with patch.object(self.ci.release.LocalRemote,'run',side_effect=error):
            with self.assertRaises(self.ci.release.GateError):self.remote().run(['docker','exec','own-pg','psql','postgresql://secret'])
        with tempfile.TemporaryDirectory() as directory:
            diag=self.ci.CiFailureDiagnostics(Path(directory)/'diag.json',self.sha);diag.primary(error)
            text=diag.target.read_text();self.assertIn('DATABASE_SQL',text);self.assertNotIn('postgresql://secret',text)
            self.assertEqual(diag.records[0]['code'],'COMMAND_FAILED')


class BackupHelperDiagnostics(unittest.TestCase):
    setUp = ShippingControllerCiIsolation.setUp

    def execute_fixture(self,fault):
        ci=self.ci;code=ci.release.SHIPPING_BACKUP_RESTORE_CODE
        phase={'restoreRunning':True,'readyAttempts':0,'readyCalls':[],'restoreStarted':False,'events':[]};sha=self.sha
        self.fixture_state=phase
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);value={'root':directory,'pg':'source','database':'fixture_only','release':sha,'restore':'restore',
                'limits':{'backupLimit':16 if fault in ('dump_cap','cap_cleanup') else 1000,'restoreLimit':1 if fault=='restore_limit' else 100000}}
            image={'Image':'own-image','Config':{'Env':['POSTGRES_USER=postgres']}}
            def response(args,data=None,**kwargs):
                data=kwargs.get('input',data)
                failed=False;stdout=b'';stderr=b''
                verb=args[1]
                if verb=='inspect':
                    if args[2]=='source':failed=fault=='inspect';stdout=json.dumps([image]).encode()
                    else:
                        obj={'Image':'own-image','Config':{'Labels':{'budu.shipping-restore':sha}},
                            'Mounts':[{'Source':str(root/'restore-pg'),'Destination':'/var/lib/postgresql/data'}],
                            'State':{'Running':phase['restoreRunning']}}
                        if fault=='identity':obj['Image']='wrong'
                        stdout=json.dumps([obj]).encode()
                elif verb=='ps':stdout=b''
                elif verb=='create':
                    failed=fault=='create';(root/'restore-pg'/'allocated-fixture').write_bytes(b'x'*1024)
                elif verb=='start':failed=fault=='start'
                elif verb=='stop':
                    failed=fault=='stop';phase['restoreRunning']=fault=='stop_verify';phase['events'].append('restore-stop')
                elif verb=='exec':
                    if 'pg_isready' in args:failed=fault=='ready'
                    else:
                        query=args[args.index('-c')+1] if '-c' in args else (data or b'').decode();restored=args[5]=='restore'
                        if 'server_version' in query:
                            phase['readyAttempts']+=1;phase['readyCalls'].append(args);phase['events'].append('ready-query')
                            failed=fault in ('ready','version_connection','ready_total_deadline') or (fault in ('socket_ready_database_missing','tcp_delayed') and phase['readyAttempts']<3)
                            if fault=='ready_query_timeout':raise subprocess.TimeoutExpired(args,kwargs['timeout'])
                            stdout=b'' if fault=='version_empty' else b'16.13' if fault=='version' else b'16.14'
                            if failed:stderr=(b'FATAL: database "PRIVATE_FIXTURE_NAME" does not exist' if fault in ('version_connection','socket_ready_database_missing') else b'connection refused PRIVATE_FIXTURE_NAME')
                        elif 'pg_terminate_backend' in query:
                            failed=fault=='connection_terminate';stdout=b'';phase['events'].append('source-terminate')
                        elif 'pg_stat_activity' in query:
                            failed=fault=='connection_count';stdout=b'1' if fault=='cap_cleanup' else b'0'
                        elif 'pg_tables' in query:
                            failed=fault==('restored_list' if restored else 'source_list')
                            stdout=json.dumps(['Sample','Second'] if restored and fault=='table_count' else ['Sample']).encode()
                        elif 'pg_sequences' in query:
                            failed=fault==('restored_sequence' if restored else 'source_sequence');stdout=b'[]'
                        else:
                            failed=fault==('restored_table' if restored else 'source_table')
                            stdout=b'1:different' if restored and fault=='facts' else b'1:stable'
                if failed and not stderr:stderr=b'PRIVATE_CREDENTIAL_PRIVATE_PATH permission denied'
                return subprocess.CompletedProcess(args,1 if failed else 0,stdout,stderr)
            class Process:
                def __init__(self,args,**kwargs):
                    self.restore='pg_restore' in args;self.returncode=(1 if fault==('restore_exit' if self.restore else 'dump_exit') else 0)
                    if self.restore:phase['restoreStarted']=True;phase['events'].append('restore-load')
                    self.running=self.restore and fault in ('restore_limit','restore_timeout')
                    if self.running:self.returncode=None
                    def pipe(body):
                        reader,writer=os.pipe();os.write(writer,body);os.close(writer);return os.fdopen(reader,'rb')
                    self.stdout=pipe(b'archive'*8) if not self.restore else None
                    self.stderr=pipe(b'PRIVATE_CREDENTIAL permission denied') if kwargs.get('stderr')==subprocess.PIPE else None
                def poll(self):return None if self.running else self.returncode
                def wait(self,timeout=None):return self.returncode
                def terminate(self):self.running=False;self.returncode=-15
                def kill(self):self.running=False;self.returncode=-9
            def clock():
                frame=sys._getframe(1)
                for _ in range(8):
                    if frame.f_code.co_filename=='shipping-backup-restore':
                        if fault=='dump_timeout' and frame.f_code.co_name=='bounded_backup_dump':return 1000
                        if fault=='restore_timeout' and frame.f_code.co_name=='<module>' and ci.HELPER_MODULE_PHASES.get(frame.f_lineno)=='RESTORE_DEADLINE':return 1000
                        if fault=='ready_total_deadline' and frame.f_code.co_name=='run' and phase['readyAttempts']>=1:return 1000
                        break
                    if not frame.f_back:break
                    frame=frame.f_back
                return 0
            original_mkdir=Path.mkdir;original_write=Path.write_text
            def mkdir(path,*args,**kwargs):
                if fault=='directory' and path.name=='restore-pg':raise PermissionError(13,'PRIVATE_CREDENTIAL_PATH')
                return original_mkdir(path,*args,**kwargs)
            def write(path,*args,**kwargs):
                if fault=='proof_write' and path.name=='backup-restore-proof.json':raise PermissionError(13,'PRIVATE_CREDENTIAL_PATH')
                return original_write(path,*args,**kwargs)
            original_popen=ci.subprocess.Popen
            with patch.object(ci.subprocess,'run',side_effect=response),patch.object(ci.subprocess,'Popen',side_effect=Process) as factory,\
                 patch.object(ci.time,'monotonic',side_effect=clock),patch.object(ci.time,'sleep',return_value=None),\
                 patch.object(Path,'mkdir',new=mkdir),patch.object(Path,'write_text',new=write):
                capture=ci.HelperStderrCapture();caught=None
                try:
                    with capture:result=ci.release.LocalRemote().py(code,value)
                except ci.release.GateError as error:caught=error
                self.assertIs(ci.subprocess.Popen,factory)
            self.assertIs(ci.subprocess.Popen,original_popen)
            if caught is None:return json.loads(result),capture.final
            caught.failure_stage='SHIPPING_BACKUP_RESTORE';caught.ci_helper_stderr=capture.final
            diagnostics=ci.CiFailureDiagnostics(root/'diagnostic.json',sha);diagnostics.case='success';diagnostics.primary(caught)
            ci.validate_ci_diagnostic_records(diagnostics.records,sha)
            serialized=json.dumps(diagnostics.records)
            self.assertNotIn('PRIVATE_CREDENTIAL',serialized);self.assertNotIn(directory,serialized)
            self.assertNotIn('PRIVATE_FIXTURE_NAME',serialized)
            return caught,diagnostics.records

    def test_original_helper_success_and_all_fault_branches_have_precise_safe_evidence(self):
        result,stderr=self.execute_fixture('success');self.assertTrue(result['restoreVerified']);self.assertTrue(result['terminationVerified'])
        fixtures={'inspect':('BACKUP_RESTORE_COMMAND_FAILED','SOURCE_INSPECT'),
            'source_list':('BACKUP_RESTORE_COMMAND_FAILED','SOURCE_TABLE_LIST'),
            'source_table':('BACKUP_RESTORE_COMMAND_FAILED','SOURCE_TABLE_FINGERPRINT'),
            'source_sequence':('BACKUP_RESTORE_COMMAND_FAILED','SOURCE_SEQUENCE_FINGERPRINT'),
            'dump_cap':('BACKUP_LIMIT','DUMP_LIMIT'),'dump_timeout':('BACKUP_TOTAL_DEADLINE','DUMP_DEADLINE'),
            'dump_exit':('BACKUP_FAILED','DUMP_EXIT'),'directory':('HELPER_PERMISSION_DENIED','RESTORE_DIRECTORY'),
            'create':('BACKUP_RESTORE_COMMAND_FAILED','RESTORE_CREATE'),'start':('BACKUP_RESTORE_COMMAND_FAILED','RESTORE_START'),
            'ready':('RESTORE_NOT_READY','RESTORE_READY'),'version':('RESTORE_VERSION','RESTORE_VERSION'),
            'version_connection':('RESTORE_NOT_READY','RESTORE_READY'),
            'restore_exit':('RESTORE_FAILED','RESTORE_EXIT'),'restore_limit':('RESTORE_LIMIT','RESTORE_ALLOCATION'),
            'restore_timeout':('BACKUP_TOTAL_DEADLINE','RESTORE_DEADLINE'),
            'restored_list':('BACKUP_RESTORE_COMMAND_FAILED','RESTORED_TABLE_LIST'),
            'restored_table':('BACKUP_RESTORE_COMMAND_FAILED','RESTORED_TABLE_FINGERPRINT'),
            'restored_sequence':('BACKUP_RESTORE_COMMAND_FAILED','RESTORED_SEQUENCE_FINGERPRINT'),
            'facts':('RESTORE_FACTS_MISMATCH','FACTS_COMPARE'),'table_count':('RESTORE_FACTS_MISMATCH','FACTS_COMPARE'),
            'connection_terminate':('BACKUP_RESTORE_COMMAND_FAILED','SOURCE_CONNECTION_TERMINATE'),
            'connection_count':('BACKUP_RESTORE_COMMAND_FAILED','SOURCE_CONNECTION_COUNT'),
            'identity':('RESTORE_IDENTITY_UNVERIFIED','RESTORE_IDENTITY'),
            'stop':('BACKUP_RESTORE_COMMAND_FAILED','RESTORE_STOP'),'stop_verify':('RESTORE_STOP_UNVERIFIED','RESTORE_STOP_VERIFY'),
            'proof_write':('HELPER_PERMISSION_DENIED','PROOF_WRITE')}
        for fault,(code,phase) in fixtures.items():
            with self.subTest(fault=fault):
                caught,rows=self.execute_fixture(fault)
                details=[row for row in rows if row['code']==code]
                self.assertTrue(details,(fault,rows))
                frames=[label for row in details for label in row['injection'] if isinstance(label,dict) and label['kind']=='HELPER_FRAME']
                self.assertIn(phase,[frame['phase'] for frame in frames],(fault,rows))
                self.assertTrue(all(type(frame['line']) is int for frame in frames))
                if fault=='facts':self.assertIn('"fingerprintsMatch": false',json.dumps(rows))
                if fault=='table_count':self.assertIn('"tableCountsMatch": false',json.dumps(rows))

    def test_socket_ready_cannot_replace_tcp_target_database_query(self):
        for fault,attempts in (('success',1),('socket_ready_database_missing',3),('tcp_delayed',3)):
            with self.subTest(fault=fault):
                result,_=self.execute_fixture(fault)
                self.assertTrue(result['restoreVerified']);self.assertTrue(result['terminationVerified'])
                state=self.fixture_state;self.assertEqual(state['readyAttempts'],attempts)
                self.assertTrue(state['restoreStarted']);self.assertFalse(state['restoreRunning'])
                self.assertLess(max(i for i,event in enumerate(state['events']) if event=='ready-query'),state['events'].index('restore-load'))
                for args in state['readyCalls']:
                    self.assertIn('psql',args);self.assertNotIn('pg_isready',args)
                    self.assertEqual(args[args.index('-h')+1],'127.0.0.1')
                    self.assertEqual(args[args.index('-d')+1],'restore_fixture')
                    self.assertEqual(args[args.index('-c')+1],"SELECT current_setting('server_version');")

    def test_tcp_database_timeout_and_version_fail_closed_with_confirmed_cleanup(self):
        for fault,code,attempts in (('ready','RESTORE_NOT_READY',60),('version_connection','RESTORE_NOT_READY',60),
                ('ready_query_timeout','RESTORE_NOT_READY',60),('ready_total_deadline','BACKUP_TOTAL_DEADLINE',1),
                ('version','RESTORE_VERSION',1),('version_empty','RESTORE_VERSION',1)):
            with self.subTest(fault=fault):
                error,rows=self.execute_fixture(fault);self.assertTrue(error.backup_termination_verified)
                self.assertIn(code,[row['code'] for row in rows]);state=self.fixture_state
                self.assertEqual(state['readyAttempts'],attempts);self.assertFalse(state['restoreStarted'])
                self.assertFalse(state['restoreRunning']);self.assertIn('source-terminate',state['events'])
                self.assertIn('restore-stop',state['events']);self.assertIn('"cleanupComplete": true',json.dumps(rows))

    def test_readiness_timeout_rolls_controller_back_only_to_verified_l85(self):
        error,_=self.execute_fixture('ready_query_timeout');self.assertTrue(error.backup_termination_verified)
        spec=importlib.util.spec_from_file_location('readiness_rollback_fixture',ROOT/'scripts/test-deploy-prod-transfer-cas.py')
        fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
        case=fixture.ShippingMigrationGates();case.setUp()
        try:
            remote=fixture.ShippingFake()
            def fail_backup(*args):
                self.assertFalse(remote.running);self.assertEqual(remote.phase,'L85')
                normalized=fixture.r.GateError(str(error));normalized.backup_termination_verified=error.backup_termination_verified
                raise normalized
            with patch.object(fixture.r,'shipping_backup_restore',side_effect=fail_backup),patch('sys.stdout',__import__('io').StringIO()):
                with self.assertRaises(fixture.r.GateError) as caught:
                    fixture.r.execute_loaded(remote,case.art,case.ledger,'fixture','old-id',fixture.r.digest(fixture.ROUTES.encode()))
            self.assertEqual(caught.exception.deployment_result,'DEPLOY_ROLLED_BACK');self.assertEqual(remote.phase,'L85')
            self.assertTrue(remote.lock_removed);self.assertEqual([c['Name'] for c in remote.running],['/'+fixture.OLD_NAME])
            self.assertFalse(any(e[0] in ('migrator-create','migrator-start','create-start') for e in remote.events))
        finally:case.doCleanups()

    def test_cleanup_masking_preserves_both_original_helper_codes_and_stage_frames(self):
        error,rows=self.execute_fixture('cap_cleanup')
        self.assertEqual(str(error),'SHIPPING_BACKUP_TERMINATION_UNVERIFIED')
        codes=[row['code'] for row in rows]
        self.assertIn('BACKUP_LIMIT',codes);self.assertIn('BACKUP_CONNECTION_TERMINATION_UNVERIFIED',codes)
        self.assertLess(codes.index('BACKUP_LIMIT'),codes.index('BACKUP_CONNECTION_TERMINATION_UNVERIFIED'))

    def test_bounded_stderr_drains_real_child_without_deadlock_and_discards_raw_bytes(self):
        ci=self.ci;original=ci.subprocess.Popen
        nodes=[node for node in ast.parse(ci.release.SHIPPING_BACKUP_RESTORE_CODE).body if isinstance(node,ast.FunctionDef) and node.name in ('bounded_backup_dump','stop_backup_process')]
        namespace={name:getattr(ci,name) for name in ('os','subprocess','time','hashlib','signal')};namespace['select']=__import__('select')
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'shipping-backup-restore','exec'),namespace)
        with tempfile.TemporaryDirectory() as directory:
            capture=ci.HelperStderrCapture()
            with capture:
                total,_=namespace['bounded_backup_dump']([sys.executable,'-c',
                    "import sys;sys.stderr.write('permission denied PRIVATE_SECRET\\n'+('x'*1048576));sys.stderr.flush();sys.stdout.write('dump')"],
                    Path(directory)/'dump',1000,ci.time.monotonic()+15)
            self.assertEqual(total,4);self.assertIs(ci.subprocess.Popen,original)
            self.assertLessEqual(capture.retained,57344);self.assertTrue(capture.final[0]['truncated'])
            self.assertTrue(capture.final[0]['drainComplete']);self.assertIn('PERMISSION_DENIED',capture.final[0]['classes'])
            self.assertTrue(all(not entry['data'] for entry in capture.streams))
            self.assertNotIn('PRIVATE_SECRET',json.dumps(capture.final))

    def test_helper_hash_binding_and_label_validator_reject_unreviewed_or_private_values(self):
        ci=self.ci
        with patch.object(ci.release,'SHIPPING_BACKUP_RESTORE_CODE','changed'):
            with self.assertRaisesRegex(RuntimeError,'CI_BACKUP_HELPER_HASH_CHANGED'):
                with ci.HelperStderrCapture():pass
        for label in ({'kind':'HELPER_FRAME','function':'MODULE','line':1,'phase':'PRIVATE'},
                      {'kind':'HELPER_META','credential':'PRIVATE'},{'kind':'HELPER_META','returnCode':True},
                      {'kind':'HELPER_FRAME','function':'PRIVATE','line':1,'phase':'DUMP'}):
            with self.subTest(label=label),self.assertRaises(AssertionError):ci.validate_helper_label(label)

    def test_proof_and_space_failures_have_boolean_validation_details(self):
        ci=self.ci;r=ci.release;art={'release':self.sha};limits={'backupLimit':1000,'restoreLimit':10000,'walLimit':1,'migratorLimit':1}
        proof={'restoreVerified':True,'terminationVerified':True,'pgVersion':'16.14','releaseSha':self.sha,
               'tableCount':1,'backupBytes':1,'restoreAllocatedBytes':1}
        remote=__import__('unittest.mock',fromlist=['Mock']).Mock()
        for changes in ({'restoreVerified':False},{'terminationVerified':False},{'pgVersion':'16.13'},
                        {'releaseSha':'f'*40},{'tableCount':0},{'backupBytes':0},{'restoreAllocatedBytes':20000}):
            with self.subTest(changes=changes):
                remote.py.return_value=json.dumps({**proof,**changes}).encode()
                try:r.shipping_backup_restore(remote,{'migrationResources':limits},'unused',art)
                except r.GateError as error:
                    details=ci.helper_failures(error)
                    self.assertTrue(details);self.assertIn('PROOF_VALIDATION',json.dumps(details))
                else:self.fail('INVALID_PROOF_ACCEPTED')
        remote.py.return_value=json.dumps(proof).encode()
        remote.disk.return_value=(20*r.GIB,1)
        try:r.shipping_backup_restore(remote,{'migrationResources':limits},'unused',art)
        except r.GateError as error:self.assertIn('SPACE_GATE',json.dumps(ci.helper_failures(error)))
        else:self.fail('SPACE_GATE_NOT_EXERCISED')


class BackupDiagnosticIdentity(unittest.TestCase):
    def test_readiness_shell_admits_only_child_of_fixed_public_g_with_same_four_files(self):
        base={'GITHUB_REF':'refs/heads/'+BACKUP_BRANCH,'EXPECTED_PRODUCTION_SHA':QUANTITY_OLD,
              'APPROVED_BUSINESS_SHA':QUANTITY_BUSINESS,'GUARD_PARENTS':BACKUP_READINESS_BASE,'GUARD_FILES':QUANTITY_ENGINEERING_FILES}
        accepted=build_only_guard(**base);self.assertEqual(accepted.returncode,0,accepted.stderr)
        for change in ({'GUARD_G_PARENT':DIAGNOSTIC_E},{'GUARD_G_PARENT':BACKUP_PARENT+' '+DIAGNOSTIC_E},
                       {'GUARD_PARENTS':BACKUP_READINESS_BASE+' '+BACKUP_PARENT},{'GUARD_PARENTS':'b'*40},
                       {'GUARD_BACKUP_FILES':BACKUP_FILES+'\nprisma/schema.prisma'},
                       {'GUARD_BACKUP_FILES':BACKUP_FILES+'\n.github/workflows/deploy-prod.yml'},
                       {'GUARD_FILES':BACKUP_FILES},{'GITHUB_EVENT_NAME':'push'},
                       {'REQUESTED_RELEASE_SHA':'f'*40}):
            with self.subTest(change=change):self.assertNotEqual(build_only_guard(**{**base,**change}).returncode,0)

    def test_readonly_identity_requires_fixed_parent_chain_clean_scope_and_original_sql(self):
        release='a'*40;path='prisma/migrations/'+r.SHIPPING_MIGRATION+'/migration.sql'
        parents={release:BACKUP_READINESS_BASE,BACKUP_READINESS_BASE:BACKUP_PARENT,BACKUP_PARENT:DIAGNOSTIC_E,
                 DIAGNOSTIC_E:QUANTITY_BUSINESS,QUANTITY_BUSINESS:QUANTITY_OLD}
        changes={}
        def facts(repo,*args):
            if args in changes:return changes[args]
            if args==('branch','--show-current'):return BACKUP_BRANCH
            if args==('rev-parse','HEAD'):return release
            if args[:1]==('rev-list',):return args[-1]+' '+parents[args[-1]]
            if args==('diff','--name-only',BACKUP_READINESS_BASE,release):return BACKUP_FILES
            if args==('diff','--name-only',QUANTITY_BUSINESS,release):return QUANTITY_ENGINEERING_FILES
            if args[:1]==('diff',):return path
            if args[:1]==('status',):return ''
            raise AssertionError(args)
        with patch.object(r,'git',side_effect=facts),patch.object(r,'command'),\
             patch.object(r,'shipping_migration',return_value=True),patch.object(r,'before_ledger'):
            self.assertEqual(r.backup_diagnostic_identity(ROOT)[0],release)
            for args,value in ((('rev-list','--parents','-n','1',release),release+' '+BACKUP_READINESS_BASE+' '+BACKUP_PARENT),
                    (('rev-list','--parents','-n','1',BACKUP_READINESS_BASE),BACKUP_READINESS_BASE+' '+DIAGNOSTIC_E),
                    (('diff','--name-only',BACKUP_READINESS_BASE,release),BACKUP_FILES+'\nserver/v2.js'),
                    (('status','--porcelain','--untracked-files=all'),' M server/v2.js'),
                    (('branch','--show-current'),QUANTITY_BRANCH)):
                with self.subTest(args=args):
                    changes[args]=value
                    with self.assertRaises(r.GateError):r.backup_diagnostic_identity(ROOT)
                    changes.clear()
            with patch.object(r,'digest',return_value='f'*64),self.assertRaisesRegex(r.GateError,'SQL_HASH'):
                r.backup_diagnostic_identity(ROOT)

    def test_new_diagnostic_shell_admission_requires_exact_f_parent_chain_and_four_files(self):
        base={'GITHUB_REF':'refs/heads/'+BACKUP_BRANCH,'EXPECTED_PRODUCTION_SHA':QUANTITY_OLD,
              'APPROVED_BUSINESS_SHA':QUANTITY_BUSINESS,'GUARD_PARENTS':BACKUP_PARENT,'GUARD_FILES':QUANTITY_ENGINEERING_FILES}
        accepted=build_only_guard(**base);self.assertEqual(accepted.returncode,0,accepted.stderr)
        for change in ({'GITHUB_EVENT_NAME':'push'},{'REQUESTED_RELEASE_SHA':'f'*40},{'GUARD_PARENTS':DIAGNOSTIC_E},
                       {'GUARD_F_PARENT':QUANTITY_BUSINESS},{'GUARD_E_PARENT':QUANTITY_OLD},
                       {'GUARD_BACKUP_FILES':BACKUP_FILES+'\nserver/v2.js'},{'GUARD_FILES':BACKUP_FILES}):
            with self.subTest(change=change):self.assertNotEqual(build_only_guard(**{**base,**change}).returncode,0)

    def test_public_f_production_functions_constants_preserved_except_readiness_helper(self):
        path='scripts/deploy-prod-transfer-cas.py';old=subprocess.check_output(['git','-C',str(ROOT),'show',BACKUP_PARENT+':'+path],text=True)
        def functions(source):return {n.name:ast.dump(n) for n in ast.parse(source).body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
        before=functions(old);after=functions((ROOT/path).read_text())
        for name,body in before.items():
            if name not in ('main','validate_shipping_identity'):self.assertEqual(body,after[name],name)
        def constants(source):return {ast.dump(n.targets[0]):ast.dump(n.value) for n in ast.parse(source).body if isinstance(n,ast.Assign)}
        for key,value in constants(old).items():
            if key != ast.dump(ast.Name(id='SHIPPING_BACKUP_RESTORE_CODE',ctx=ast.Store())):
                self.assertEqual(value,constants((ROOT/path).read_text())[key],key)
        self.assertEqual(hashlib.sha256(r.SHIPPING_BACKUP_RESTORE_CODE.encode()).hexdigest(),'08f5738100617198bcb6fd37aeb072a9d95bcbd18ba9251c69dd6184382393e4')
        workflow=(ROOT/'.github/workflows/release-build-only.yml').read_text()
        previous=subprocess.check_output(['git','-C',str(ROOT),'show',BACKUP_PARENT+':.github/workflows/release-build-only.yml'],text=True)
        for branch in (DIAGNOSTIC_BRANCH,):
            token='            '+branch+')'
            self.assertEqual(workflow.split(token,1)[1].split(';;',1)[0],previous.split(token,1)[1].split(';;',1)[0])

    def test_public_g_helper_ast_changes_only_restore_readiness_and_other_gates_unchanged(self):
        path='scripts/deploy-prod-transfer-cas.py'
        old=subprocess.check_output(['git','-C',str(ROOT),'show',BACKUP_READINESS_BASE+':'+path],text=True)
        current=(ROOT/path).read_text();namespace={}
        for node in ast.parse(old).body:
            if isinstance(node,ast.Assign) and isinstance(node.targets[0],ast.Name) and node.targets[0].id in ('SHIPPING_BOUNDED_DUMP_CODE','SHIPPING_BACKUP_RESTORE_CODE'):
                exec(compile(ast.Module(body=[node],type_ignores=[]),'historical-helper','exec'),namespace)
        self.assertEqual(namespace['SHIPPING_BOUNDED_DUMP_CODE'],r.SHIPPING_BOUNDED_DUMP_CODE)
        def without_readiness(code,removed_count):
            tree=ast.parse(code);outer=next(n for n in tree.body if isinstance(n,ast.Try))
            removed=[n for n in outer.body if (isinstance(n,ast.For) and ast.dump(n.iter)==ast.dump(ast.parse('range(60)',mode='eval').body))
                or (isinstance(n,ast.If) and 'RESTORE_VERSION' in ast.dump(n))]
            self.assertEqual(len(removed),removed_count)
            outer.body=[n for n in outer.body if n not in removed]
            return ast.dump(tree,include_attributes=False)
        self.assertEqual(without_readiness(namespace['SHIPPING_BACKUP_RESTORE_CODE'],2),without_readiness(r.SHIPPING_BACKUP_RESTORE_CODE,1))
        def definitions(source):return {n.name:ast.dump(n) for n in ast.parse(source).body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
        for name,body in definitions(old).items():
            if name not in ('backup_diagnostic_identity','validate_shipping_identity'):self.assertEqual(body,definitions(current)[name],name)
        def constants(source):return {ast.dump(n.targets[0]):ast.dump(n.value) for n in ast.parse(source).body if isinstance(n,ast.Assign)}
        for key,value in constants(old).items():
            if key!=ast.dump(ast.Name(id='SHIPPING_BACKUP_RESTORE_CODE',ctx=ast.Store())):self.assertEqual(value,constants(current)[key],key)
        previous=subprocess.check_output(['git','-C',str(ROOT),'show',BACKUP_READINESS_BASE+':.github/workflows/release-build-only.yml'],text=True)
        workflow=(ROOT/'.github/workflows/release-build-only.yml').read_text();tokens=['            '+BACKUP_BRANCH+')','            '+QUANTITY_BRANCH+')']
        def remove_admission(value):
            for token in tokens:
                before,after=value.split(token,1);value=before+after.split(';;',1)[1]
            return value
        self.assertEqual(remove_admission(previous),remove_admission(workflow))

class FormalShippingIdentity(unittest.TestCase):
    def test_public_h_operational_functions_constants_helper_and_workflow_remain_byte_exact(self):
        path='scripts/deploy-prod-transfer-cas.py'
        old=subprocess.check_output(['git','-C',str(ROOT),'show',FORMAL_BASE+':'+path],text=True)
        current=(ROOT/path).read_text()
        def functions(source):return {n.name:ast.get_source_segment(source,n) for n in ast.parse(source).body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
        for name,body in functions(old).items():
            if name!='validate_shipping_identity':self.assertEqual(body,functions(current)[name],name)
        def constants(source):return {ast.dump(n.targets[0]):ast.get_source_segment(source,n) for n in ast.parse(source).body if isinstance(n,ast.Assign)}
        for key,value in constants(old).items():self.assertEqual(value,constants(current)[key],key)
        self.assertEqual(hashlib.sha256(r.SHIPPING_BACKUP_RESTORE_CODE.encode()).hexdigest(),'08f5738100617198bcb6fd37aeb072a9d95bcbd18ba9251c69dd6184382393e4')
        previous=subprocess.check_output(['git','-C',str(ROOT),'show',FORMAL_BASE+':.github/workflows/release-build-only.yml'],text=True)
        workflow=(ROOT/'.github/workflows/release-build-only.yml').read_text();token='            '+QUANTITY_BRANCH+')'
        def remove_formal(value):
            before,after=value.split(token,1);return before+after.split(';;',1)[1]
        self.assertEqual(remove_formal(previous),remove_formal(workflow))
        self.assertEqual(subprocess.check_output(['git','-C',str(ROOT),'diff','--name-only',FORMAL_BASE,'--',
            'server','src','shared','prisma','Dockerfile','package.json','package-lock.json',
            '.github/workflows/deploy-prod.yml','scripts/deploy-remote.sh','scripts/release-prod-post-transfer-ci.sh',
            'scripts/test-candidate-db-probe-integration.py','scripts/test-deploy-prod-transfer-cas.py'],text=True),'')

    def test_h_image_cannot_be_retagged_into_new_formal_candidate(self):
        candidate='f'*40
        with patch.object(r,'IMAGE_PREFIX','post-transfer-'):
            tag=r.image_reference(candidate);config={'Labels':{r.REVISION:FORMAL_BASE}}
            image={'RepoTags':[tag],'Id':'sha256:'+'1'*64,'Os':'linux','Architecture':'amd64','Config':config}
            art={'release':candidate,'imageReference':tag,'config':config}
            with self.assertRaisesRegex(r.GateError,'LOADED_ARTIFACT_MISMATCH'):r.validate_loaded_image(image,art)

    def test_h_itself_and_short_sha_remain_outside_formal_identity(self):
        with patch.object(r,'git',return_value=QUANTITY_BRANCH):
            for release in (FORMAL_BASE,'short'):
                with self.subTest(release=release),self.assertRaisesRegex(r.GateError,'SHIPPING_ENGINEERING_PARENT_INVALID'):
                    r.validate_shipping_identity(ROOT,release)

if __name__=='__main__':
    unittest.main(verbosity=2)

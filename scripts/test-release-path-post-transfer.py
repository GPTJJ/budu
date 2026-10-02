#!/usr/bin/env python3
"""Offline post-Transfer release identity and real shell routing regressions."""
import hashlib
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
            'rev-list) printf "%s %s\\n" "$GITHUB_SHA" "$GUARD_PARENTS" ;;\n'
            'diff) printf "%s\\n" "$GUARD_FILES" ;;\n'
            'rev-parse) printf "%s\\n" "$GUARD_HEAD" ;;\n'
            '*) exit 99 ;;\nesac\n')
        for stub in bindir.iterdir(): stub.chmod(0o755)
        env = {**os.environ, 'PATH':str(bindir)+':'+os.environ['PATH'],
               'RUNNER_OS':'Linux', 'RUNNER_ARCH':'X64',
               'GITHUB_REF':'refs/heads/'+SHIPPING_BRANCH, 'GITHUB_EVENT_NAME':'workflow_dispatch',
               'GITHUB_SHA':release, 'REQUESTED_RELEASE_SHA':release,
               'EXPECTED_PRODUCTION_SHA':SHIPPING_OLD, 'APPROVED_BUSINESS_SHA':SHIPPING_BUSINESS,
               'GUARD_PARENTS':SHIPPING_BUSINESS, 'GUARD_FILES':SHIPPING_ENGINEERING_FILES,
               'GUARD_HEAD':release, **facts}
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
        self.assertEqual(job['if'],"${{ github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && (github.ref == 'refs/heads/"+QUANTITY_BRANCH+"' || github.ref == 'refs/heads/"+SHIPPING_BRANCH+"' || github.ref == 'refs/heads/"+PAYROLL_BRANCH+"' || github.ref == 'refs/heads/"+REVISION_BRANCH+"')) }}")
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
        self.assertEqual(proof['if'],"github.ref == 'refs/heads/"+QUANTITY_BRANCH+"'")
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
               'GUARD_PARENTS':QUANTITY_BUSINESS,'GUARD_FILES':QUANTITY_ENGINEERING_FILES}
        self.assertEqual(build_only_guard(**facts).returncode,0)
        denied=[{'GITHUB_EVENT_NAME':'push'}, {'REQUESTED_RELEASE_SHA':''},
                {'REQUESTED_RELEASE_SHA':'b'*40}, {'GITHUB_SHA':'short'},
                {'EXPECTED_PRODUCTION_SHA':PAYROLL_OLD}, {'APPROVED_BUSINESS_SHA':SHIPPING_BUSINESS},
                {'GUARD_PARENTS':QUANTITY_OLD}, {'GUARD_PARENTS':QUANTITY_BUSINESS+' '+'b'*40},
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
        self.assertEqual(old['if'],"github.ref == 'refs/heads/"+QUANTITY_BRANCH+"'")
        self.assertIn('git archive '+QUANTITY_OLD,old['run']);self.assertIn('--platform linux/amd64',old['run'])
        self.assertIn('--load "$old_dir"',old['run'])
        build=next(step for step in steps if step['name'].startswith('Build exact production'))['run']
        quantity=build.split('elif [ "$GITHUB_REF" = refs/heads/'+QUANTITY_BRANCH+' ]; then',1)[1].split('else',1)[0]
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
                if args[:1]==('rev-list',):return candidate+' '+QUANTITY_BUSINESS
                if args==('diff','--name-only',QUANTITY_BUSINESS,candidate):return QUANTITY_ENGINEERING_FILES
                if args[:2]==('diff','--name-only') or args[:2]==('diff','--diff-filter=A'):return path
                raise AssertionError(args)
            with patch.object(r,'git',side_effect=facts):r.validate_shipping_identity(ROOT,candidate)
            changes=[(('branch','--show-current'),'main','SHIPPING_BRANCH_INVALID'),
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


if __name__=='__main__':
    unittest.main(verbosity=2)

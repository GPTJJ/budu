#!/usr/bin/env python3
"""Finite Q86->87 material release contract; offline tests and owned native PG proof."""
import ast
import copy
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

def module(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value


def previous_controller_source(source):
    """Project only the reviewed material branches to their unchanged Q fallback.

    This keeps the older shipping AST preservation tests meaningful. No threshold,
    backup helper, transport, unrelated branch or SQL is replaced from Git.
    """
    class Prior(ast.NodeTransformer):
        def visit_If(self,node):
            if isinstance(node.test,ast.Call) and isinstance(node.test.func,ast.Name) and node.test.func.id=='material_migration':
                return [self.visit(n) for n in node.orelse]
            return self.generic_visit(node)
        def visit_IfExp(self,node):
            if isinstance(node.test,ast.Call) and isinstance(node.test.func,ast.Name) and node.test.func.id=='material_migration':
                return self.visit(node.orelse)
            return self.generic_visit(node)
        def visit_BoolOp(self,node):
            node.values=[self.visit(v) for v in node.values if not (isinstance(v,ast.Call) and isinstance(v.func,ast.Name) and v.func.id=='material_migration')]
            return node.values[0] if len(node.values)==1 else node
        def visit_Call(self,node):
            names={'migration_before_phase':"'L85'",'migration_after_phase':"'L86'",
                   'migration_target':'SHIPPING_MIGRATION','migration_sql_hash':'SHIPPING_SQL_HASH',
                   'migration_before_count':'85','migration_rollback_contract':"'APPLICATION_ONLY_KEEP_L86_AND_ACTUAL_FACTS'"}
            if isinstance(node.func,ast.Name):
                if node.func.id in names:return ast.parse(names[node.func.id],mode='eval').body
                if node.func.id=='material_database_details':return self.visit(node.args[1])
            return self.generic_visit(node)
    # Keep untouched methods byte-for-byte, including the reviewed SSH transport
    # whose exact source hash is checked by the older regression suite.
    q_source=subprocess.check_output(['git','-C',str(ROOT),'show','72c780c1dbb5ff8b4502b97984d44660532f181a:scripts/deploy-prod-transfer-cas.py'],text=True)
    q_functions={}
    for top in ast.parse(q_source).body:
        if isinstance(top,ast.FunctionDef):q_functions[(None,top.name)]=top
        elif isinstance(top,ast.ClassDef):
            for n in top.body:
                if isinstance(n,ast.FunctionDef):q_functions[(top.name,n.name)]=n
    tree=ast.parse(source); nodes=[]
    for top in tree.body:
        if isinstance(top,ast.FunctionDef):nodes.append((None,top))
        elif isinstance(top,ast.ClassDef):nodes.extend((top.name,n) for n in top.body if isinstance(n,ast.FunctionDef))
    edits=[]
    for owner,node in nodes:
        changed=Prior().visit(copy.deepcopy(node));ast.fix_missing_locations(changed)
        if ast.dump(node)==ast.dump(changed):continue
        original=ast.get_source_segment(source,node)
        key=(owner,node.name)
        if key not in q_functions:continue
        q_node=q_functions[key]
        if ast.dump(changed)!=ast.dump(q_node):raise AssertionError('Unreviewed Q fallback change: '+node.name)
        # The byte restoration is permitted only after exact AST equality to Q.
        replacement=ast.get_source_segment(q_source,q_node)
        if source.count(original)!=1:raise AssertionError('Projection source segment must be unique')
        edits.append((original,replacement))
    for original,replacement in edits:source=source.replace(original,replacement,1)
    added={n.name for n in ast.parse(source).body if isinstance(n,ast.FunctionDef)}-{name for owner,name in q_functions if owner is None}
    expected={'material_contract','material_migration','migration_before_phase','migration_after_phase',
              'migration_target','migration_sql_hash','migration_before_count','migration_rollback_contract',
              'validate_material_identity','material_database_details'}
    if added!=expected:raise AssertionError('Unreviewed added controller helper')
    start=source.index('def material_contract():')
    end=source.index('def before_ledger(ledger):',start)
    source=source[:start]+source[end:]
    if source!=q_source:raise AssertionError('Projected controller must equal exact Q bytes')
    return source


def previous_workflow_source(source):
    branch='codex/material-center-integration-20261002'
    if '            '+branch+')' not in source:return source
    for sha in ('72c780c1dbb5ff8b4502b97984d44660532f181a','a9e9c58510af4ef38b4bcaf378ec0a77895f61bc'):
        source=source.replace("github.ref == 'refs/heads/"+branch+"' && '"+sha+"' || ",'')
    source=source.replace("github.ref == 'refs/heads/"+branch+"' || ",'')
    source=re.sub(r'^            '+re.escape(branch)+r'\)\n.*?^              ;;\n','',source,flags=re.M|re.S)
    source=source.replace('''          if [ "$GITHUB_REF" = refs/heads/codex/material-center-integration-20261002 ]; then
            python3 scripts/test-material-release-contract.py --legacy-q-regressions
            python3 scripts/test-material-release-contract.py
          else
            python3 scripts/test-deploy-prod-transfer-cas.py
            python3 scripts/test-transfer-cas-existing-workflow.py
            python3 scripts/test-release-path-post-transfer.py
          fi
''','''          python3 scripts/test-deploy-prod-transfer-cas.py
          python3 scripts/test-transfer-cas-existing-workflow.py
          python3 scripts/test-release-path-post-transfer.py
''')
    source=re.sub(r'^          if \[ "\$GITHUB_REF" = refs/heads/'+re.escape(branch)+r' \]; then\n.*?^          elif \[ "\$GITHUB_REF" = refs/heads/codex/mailing-free-tier-shipped-sort-20261001 \]; then\n',
                  '          if [ "$GITHUB_REF" = refs/heads/codex/mailing-free-tier-shipped-sort-20261001 ]; then\n',source,flags=re.M|re.S)
    source=re.sub(r'^          if \[ "\$GITHUB_REF" = refs/heads/'+re.escape(branch)+r' \]; then\n.*?^          elif \[ "\$GITHUB_REF" = refs/heads/codex/shipping-review-actual-quantity-20261002 \] \|\|',
                  '          if [ "$GITHUB_REF" = refs/heads/codex/shipping-review-actual-quantity-20261002 ] ||',source,flags=re.M|re.S)
    source=source.replace("          TEST_MATERIAL_CONTROLLER_CI: '1'\n",'')
    for name in ('Build exact Q application for isolated material compatibility','Retain isolated material migration controller proof','Retain isolated material migration failure diagnostics'):
        source=re.sub(r'^      - name: '+re.escape(name)+r'\n.*?(?=^      - name:|\Z)','',source,flags=re.M|re.S)
    source=source.replace("github.ref == 'refs/heads/"+branch+"' && format('release-staging-{0}', github.sha) || ",'')
    return source


def previous_ci_source(source):
    """Remove only the additive material CI entrypoint; require exact Q bytes."""
    start=source.index('def material_controller_ci_guard():')
    end=source.index('def main(image, old_image=None):',start)
    source=source[:start]+source[end:]
    source=source.replace("""        elif sys.argv[1] == '--material-controller-ci':
            if len(sys.argv)!=5:raise RuntimeError('CI_CONTROLLER_ARGUMENTS_INVALID')
            material_controller_ci(*sys.argv[2:])
""",'',1)
    q=subprocess.check_output(['git','-C',str(ROOT),'show','72c780c1dbb5ff8b4502b97984d44660532f181a:scripts/test-candidate-db-probe-integration.py'],text=True)
    if source!=q:raise AssertionError('Existing CI source must equal exact Q bytes')
    return source


def workflow():
    return json.loads(subprocess.check_output(['ruby','-rjson','-ryaml','-e','puts JSON.generate(YAML.load_file(ARGV[0]))',str(ROOT/'.github/workflows/release-build-only.yml')]))


def historical_diff(*args):
    """Old byte/scope assertions compare the reviewed Q tree, excluding later business work.

    This is a test-only Git endpoint, not a runtime or deployment input. Current
    material business and engineering identity are separately checked below.
    """
    q='72c780c1dbb5ff8b4502b97984d44660532f181a'
    # Callers are only the existing historical comparisons with one old revision.
    return subprocess.check_output(['git','-C',str(ROOT),'diff','--name-only',args[0],q,*args[1:]],text=True)


class MaterialContract(unittest.TestCase):
    def setUp(self):
        self.r=module(ROOT/'scripts/deploy-prod-transfer-cas.py','material_release_test')
        self.c=self.r.material_contract();self.r.configure_profile('post-transfer',self.c['oldSha'],self.c['businessSha'],'0'*64)
        self.ledger={p.parent.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'prisma/migrations').glob('*/migration.sql')}
    def db(self,target):
        ledger=self.ledger if target else self.r.before_ledger(self.ledger)
        return {'database':self.r.EXPECTED_DB,'ledger':ledger,'applied':len(ledger),'failed':0,'rolledBack':0,'invalidFacts':0,
                'check':{'validated':True,'definition':self.r.SHIPPING_CHECK_NEW},
                'materialSchema':{'column':{'type':'bigint','nullable':'YES','default':None} if target else None,
                    'check':{'validated':True,'definition':'CHECK ((("partnerMaterialPriceCents" IS NULL) OR ("partnerMaterialPriceCents" >= 0)))'} if target else None,
                    'nonNullQuotes':0,'materialCount':26,'protectedProductCount':4,'categoryCount':1,'categoryId':self.c['categoryId'],'factHash':'fixture'}}
    def test_fixed_pair_rejects_other_authority(self):
        self.assertTrue(self.r.material_migration())
        for key in ('EXPECTED_OLD_SHA','RUNTIME_SHA'):
            with patch.object(self.r,key,'f'*40):self.assertFalse(self.r.material_migration())
    def test_identity_requires_single_exact_parent_branch_files_schema_and_sql(self):
        release='f'*40;c=self.c;path='prisma/migrations/'+c['migration']+'/migration.sql'
        facts={('branch','--show-current'):c['branch'],('rev-list','--parents','-n','1',release):release+' '+c['timestampBaseSha'],
               ('rev-list','--parents','-n','1',c['timestampBaseSha']):c['timestampBaseSha']+' '+c['engineeringBaseSha'],
               ('rev-list','--parents','-n','1',c['engineeringBaseSha']):c['engineeringBaseSha']+' '+c['businessSha'],
               ('rev-list','--parents','-n','1',c['businessSha']):c['businessSha']+' '+c['oldSha'],
               ('diff','--name-only',c['businessSha'],release):'\n'.join(sorted(c['engineeringFiles'])),
               ('diff','--name-only',c['engineeringBaseSha'],c['timestampBaseSha']):'\n'.join(sorted(c['correctionFiles'])),
               ('diff','--name-only',c['timestampBaseSha'],release):'\n'.join(sorted(c['timestampCorrectionFiles'])),
               ('diff','--name-only',c['oldSha'],release,'--','prisma'):'prisma/schema.prisma\n'+path,
               ('diff','--diff-filter=A','--name-only',c['oldSha'],release,'--',path):path}
        def git(repo,*args):return facts[args]
        with patch.object(self.r,'git',side_effect=git):
            self.r.validate_material_identity(ROOT,release)
            for key in facts:
                original=facts[key];facts[key]=original+'\nserver/v2.js'
                with self.subTest(key=key),self.assertRaises(self.r.GateError):self.r.validate_material_identity(ROOT,release)
                facts[key]=original
            with patch.object(self.r,'digest',return_value='0'*64),self.assertRaisesRegex(self.r.GateError,'SQL_HASH'):
                self.r.validate_material_identity(ROOT,release)
    def test_exact_ledger_before_and_after(self):
        baseline=self.r.before_ledger(self.ledger);self.assertEqual(len(baseline),86)
        self.r.validate_database(self.db(False),baseline);self.r.validate_database(self.db(True),self.ledger)
        bad=dict(self.ledger);bad[self.c['migration']]='0'*64
        with self.assertRaises(self.r.GateError):self.r.before_ledger(bad)
        for changed in ({'applied':86},{'failed':1},{'rolledBack':1},{'invalidFacts':1}):
            db={**self.db(True),**changed}
            with self.subTest(changed=changed),self.assertRaises(self.r.GateError):self.r.validate_database(db,self.ledger)
    def test_column_ledger_gap_and_changed_data_identity_fail_closed(self):
        for target,changes in [(False,{'column':{'type':'bigint','nullable':'YES','default':None}}),
                               (True,{'column':{'type':'bigint','nullable':'NO','default':None}}),
                               (True,{'check':{'validated':False,'definition':'CHECK (TRUE)'}}),
                               (True,{'materialCount':27}),(True,{'protectedProductCount':3}),
                               (True,{'categoryCount':2}),(True,{'categoryId':'foreign'})]:
            db=self.db(target);db['materialSchema'].update(changes)
            with self.subTest(changes=changes),self.assertRaises(self.r.GateError):self.r.validate_database(db,db['ledger'])
    def test_rollback_retains_target_column_and_refuses_unknown_phase(self):
        class Remote:
            def __init__(self):self.events=[]
            def run(self,args):self.events.append(args)
            def health(self,*args,**kw):pass
        state={'name':'old','old_stop_attempted':True,'migration_phase':'L87'};remote=Remote()
        with patch.object(self.r,'settle_writers') as settle,patch.object(self.r,'application_db_probe'):
            self.r.rollback(remote,state,self.ledger)
            self.assertIn(['docker','start','old'],remote.events)
            for call in settle.call_args_list:self.assertEqual(call.args[1],self.ledger)
        for phase in ('UNKNOWN','L85'):
            remote=Remote()
            with self.subTest(phase=phase),self.assertRaises(self.r.GateError):self.r.rollback(remote,{**state,'migration_phase':phase},self.ledger)
            self.assertEqual(remote.events,[])
    def test_q_guards_helpers_and_unrelated_profiles_preserved(self):
        old=subprocess.check_output(['git','-C',str(ROOT),'show',self.c['oldSha']+':scripts/deploy-prod-transfer-cas.py'],text=True)
        current=(ROOT/'scripts/deploy-prod-transfer-cas.py').read_text()
        def definitions(source):return {n.name:ast.dump(n) for n in ast.parse(source).body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
        a=definitions(old);b=definitions(previous_controller_source(current))
        for name,value in a.items():self.assertEqual(value,b[name],name)
        def constants(source):return {ast.dump(n.targets[0]):ast.dump(n.value) for n in ast.parse(source).body if isinstance(n,ast.Assign)}
        for key,value in constants(old).items():self.assertEqual(value,constants(current)[key],key)
    def test_q_workflow_preserved_except_this_branch(self):
        old=subprocess.check_output(['git','-C',str(ROOT),'show',self.c['oldSha']+':.github/workflows/release-build-only.yml'],text=True)
        self.assertEqual(previous_workflow_source((ROOT/'.github/workflows/release-build-only.yml').read_text()),old)
    def test_actual_business_payload_and_engineering_scope_preserved(self):
        changed=set(subprocess.check_output(['git','-C',str(ROOT),'diff','--name-only',self.c['businessSha']],text=True).splitlines())
        self.assertLessEqual(changed,self.c['engineeringFiles'])
        parent=subprocess.check_output(['git','-C',str(ROOT),'rev-list','--parents','-n','1',self.c['businessSha']],text=True).strip()
        self.assertEqual(parent,self.c['businessSha']+' '+self.c['oldSha'])
    def test_real_material_workflow_shell_accepts_only_exact_requested_correction_child(self):
        job=workflow()['jobs']['artifact'];verify=next(x for x in job['steps'] if x.get('name')=='Verify source and release guard')
        admission=verify['run'].split('if [ -z',1)[0];c=self.c;release='f'*40
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory);git=p/'git';uname=p/'uname'
            git.write_text('''#!/usr/bin/env python3
import os,sys
args=sys.argv[1:]
if args[0]=='rev-list':
 sha=args[-1]
 parent=os.environ['BUSINESS_PARENT'] if sha==os.environ['APPROVED_BUSINESS_SHA'] else os.environ['ENGINEERING_PARENT'] if sha==os.environ['ENGINEERING_BASE_SHA'] else os.environ['TIMESTAMP_PARENT'] if sha==os.environ['TIMESTAMP_BASE_SHA'] else os.environ['RELEASE_PARENT'];print(sha+' '+parent)
elif args[0]=='diff':print(os.environ['CORRECTION_FILES'] if args[2]==os.environ['ENGINEERING_BASE_SHA'] else os.environ['TIMESTAMP_FILES'] if args[2]==os.environ['TIMESTAMP_BASE_SHA'] else os.environ['ENGINEERING_FILES'])
elif args[0]=='rev-parse':print(os.environ['GITHUB_SHA'])
else:raise SystemExit(2)
''');git.chmod(0o755);uname.write_text('#!/bin/sh\nprintf "x86_64\\n"\n');uname.chmod(0o755)
            base={**os.environ,'PATH':directory+os.pathsep+os.environ['PATH'],'RUNNER_OS':'Linux','RUNNER_ARCH':'X64','GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':'refs/heads/'+c['branch'],'GITHUB_SHA':release,'REQUESTED_RELEASE_SHA':release,'EXPECTED_PRODUCTION_SHA':c['oldSha'],'APPROVED_BUSINESS_SHA':c['businessSha'],'BUSINESS_PARENT':c['oldSha'],'ENGINEERING_BASE_SHA':c['engineeringBaseSha'],'ENGINEERING_PARENT':c['businessSha'],'TIMESTAMP_BASE_SHA':c['timestampBaseSha'],'TIMESTAMP_PARENT':c['engineeringBaseSha'],'RELEASE_PARENT':c['timestampBaseSha'],'ENGINEERING_FILES':'\n'.join(sorted(c['engineeringFiles'])),'CORRECTION_FILES':'\n'.join(sorted(c['correctionFiles'])),'TIMESTAMP_FILES':'\n'.join(sorted(c['timestampCorrectionFiles']))}
            def run(extra):return subprocess.run(['bash','-c',admission],env={**base,**extra},capture_output=True).returncode
            self.assertEqual(run({}),0)
            for extra in ({'GITHUB_EVENT_NAME':'push'},{'REQUESTED_RELEASE_SHA':'e'*40},{'EXPECTED_PRODUCTION_SHA':'e'*40},{'APPROVED_BUSINESS_SHA':'e'*40},{'BUSINESS_PARENT':'e'*40},{'ENGINEERING_PARENT':'e'*40},{'TIMESTAMP_PARENT':c['businessSha']},{'RELEASE_PARENT':c['engineeringBaseSha']},{'RELEASE_PARENT':c['businessSha']},{'GITHUB_SHA':c['timestampBaseSha'],'REQUESTED_RELEASE_SHA':c['timestampBaseSha']},{'GITHUB_SHA':c['engineeringBaseSha'],'REQUESTED_RELEASE_SHA':c['engineeringBaseSha']},{'ENGINEERING_FILES':base['ENGINEERING_FILES']+'\nserver/v2.js'},{'CORRECTION_FILES':base['CORRECTION_FILES']+'\nserver/v2.js'},{'TIMESTAMP_FILES':base['TIMESTAMP_FILES']+'\nserver/v2.js'}):
                with self.subTest(extra=extra):self.assertNotEqual(run(extra),0)
    def test_formal_runner_only_material_test_entrypoint_changed(self):
        path='scripts/release-prod-post-transfer-ci.sh';source=(ROOT/path).read_text()
        start=source.index('if [ "$GITHUB_REF" = refs/heads/'+self.c['branch']+' ]; then')
        end=source.index('\nfor script ',start)
        block=source[start:end]
        original='python3 scripts/test-deploy-prod-transfer-cas.py\npython3 scripts/test-transfer-cas-existing-workflow.py\npython3 scripts/test-release-path-post-transfer.py'
        q=subprocess.check_output(['git','-C',str(ROOT),'show',self.c['oldSha']+':'+path],text=True)
        self.assertEqual(source[:start]+original+source[end:],q)
        subprocess.run(['bash','-n',str(ROOT/path)],check=True)
        with tempfile.TemporaryDirectory() as directory:
            fake=Path(directory)/'python3';fake.write_text('#!/bin/sh\nprintf "%s\\n" "$*"\n');fake.chmod(0o755)
            def run(branch):return subprocess.check_output(['bash','-c',block],env={**os.environ,'PATH':directory+os.pathsep+os.environ['PATH'],'GITHUB_REF':'refs/heads/'+branch},text=True).splitlines()
            self.assertEqual(run(self.c['branch']),['scripts/test-material-release-contract.py --legacy-q-regressions','scripts/test-material-release-contract.py'])
            self.assertEqual(run('codex/other-existing-branch'),original.replace('python3 ','').splitlines())
    def test_material_difference_diagnostic_retains_fields_without_values(self):
        ci=module(ROOT/'scripts/test-candidate-db-probe-integration.py','material_difference_test')
        before={'facts':[['InventoryItem',2,'a'*64],['notification_templates',1,'b'*64]],'rowDetails':{'InventoryItem':{'primaryKey':True,'rows':{'1'*64:{'sku':'4'*64,'password_hash':'5'*64}}},'notification_templates':{'primaryKey':True,'rows':{'2'*64:{'updated_at':'6'*64}}}}}
        after=copy.deepcopy(before);after['facts'][0][2]='c'*64;after['facts'][1][2]='d'*64
        after['rowDetails']['InventoryItem']['rows']['1'*64]['sku']='7'*64
        after['rowDetails']['notification_templates']['rows']['2'*64]['updated_at']='8'*64
        difference=ci.material_fact_difference(before,after)
        self.assertEqual(difference['totalChangedTables'],2)
        self.assertEqual(difference['tables'][0]['changedFields'],[{'field':'sku','rowCount':1}])
        self.assertEqual(difference['tables'][1]['changedFields'],[{'field':'updated_at','rowCount':1}])
        serialized=json.dumps(difference)
        for hidden in ('1'*64,'2'*64,'4'*64,'5'*64,'6'*64,'7'*64,'8'*64,'password_hash'):
            self.assertNotIn(hidden,serialized)
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'diagnostic.json';diagnostic=ci.MaterialCiFailureDiagnostics(target,'f'*40);diagnostic.case='success'
            error=RuntimeError('CI_MATERIAL_BUSINESS_FACTS_CHANGED');error.material_fact_difference=difference;diagnostic.primary(error)
            persisted=json.loads(target.read_text())
            self.assertEqual(persisted[0]['materialFactDifference'],difference)
            self.assertEqual(persisted[0]['code'],'CI_MATERIAL_BUSINESS_FACTS_CHANGED')
    def test_material_diagnostic_added_removed_rows_without_primary_key(self):
        ci=module(ROOT/'scripts/test-candidate-db-probe-integration.py','material_rows_test')
        before={'facts':[['_join',1,'a'*64]],'rowDetails':{'_join':{'primaryKey':False,'rows':{'1'*64:{'left':'3'*64}}}}}
        after={'facts':[['_join',1,'b'*64]],'rowDetails':{'_join':{'primaryKey':False,'rows':{'2'*64:{'left':'4'*64}}}}}
        row=ci.material_fact_difference(before,after)['tables'][0]
        self.assertEqual((row['addedRows'],row['removedRows']),(None,None))
        self.assertEqual((row['unmatchedRowFingerprintsAdded'],row['unmatchedRowFingerprintsRemoved']),(1,1))
        self.assertFalse(row['primaryKeyAvailable']);self.assertIsNone(row['matchedRowsChanged']);self.assertEqual(row['changedFields'],[])
    def test_material_ci_isolation_and_fixture_contract(self):
        ci=module(ROOT/'scripts/test-candidate-db-probe-integration.py','material_ci_test')
        env={'GITHUB_ACTIONS':'true','RUNNER_OS':'Linux','GITHUB_REPOSITORY':'GPTJJ/budu','GITHUB_REF':'refs/heads/'+self.c['branch'],'TEST_MATERIAL_CONTROLLER_CI':'1','GITHUB_SHA':'f'*40,'RUNNER_TEMP':'/tmp/material-fixture'}
        with patch.dict(os.environ,env,clear=True),patch.object(ci.sys,'platform','linux'),patch.object(ci.os,'geteuid',return_value=0):
            ci.material_controller_ci_guard()
            for key,value in [('GITHUB_REF','refs/heads/main'),('TEST_MATERIAL_CONTROLLER_CI','0'),('DOCKER_HOST','tcp://production:2375')]:
                with patch.dict(os.environ,{key:value}),self.assertRaises(RuntimeError):ci.material_controller_ci_guard()
        self.assertIn('length:25',ci.MATERIAL_FIXTURE_JS);self.assertIn('ci-protected-',ci.MATERIAL_FIXTURE_JS)
        self.assertNotIn('await assert.rejects(prisma.transferItem.update',ci.MATERIAL_FIXTURE_JS)
        self.assertIn("for(const id of ['ci-legacy','ci-box-row','ci-piece-row'])",ci.MATERIAL_FIXTURE_JS)
        for code in (ci.MATERIAL_FIXTURE_JS,ci.MATERIAL_SNAPSHOT_JS):
            subprocess.run(['node','--check','--input-type=module','-'],input=code.encode(),check=True,capture_output=True)
        previous_ci_source((ROOT/'scripts/test-candidate-db-probe-integration.py').read_text())


def template_timestamp_proof():
    """Run the actual snapshot SQL on SELECT-only PostgreSQL fixtures after npm ci.

    Offline identity tests run before npm ci in the existing workflow. This proof
    uses the already declared PGlite dependency, without writing any fixture rows.
    """
    ci=module(ROOT/'scripts/test-candidate-db-probe-integration.py','material_timestamp_sql_proof')
    baseline={name:[{'id':name+str(i),'content':{'name':'template '+str(i),'steps':['review']},
                    'updated_at':'2026-10-02T00:00:00Z','updatedAt':'preserved'} for i in range(count)]
              for name,count in [('approval_templates',2),('notification_templates',14),('InventoryItem',1),
                                 ('approval_templates_archive',1),('ApprovalTemplates',1)]}
    cases=[baseline];labels=['baseline'];expected=[]
    timestamps=copy.deepcopy(baseline)
    for name in ('approval_templates','notification_templates'):
        for row in timestamps[name]:row['updated_at']='2026-10-03T00:00:00Z'
    cases.append(timestamps);labels.append('exact two timestamps allowed')
    for name in ('approval_templates','notification_templates'):
        for mode in ('content','add','remove','replace-member','updatedAt'):
            changed=copy.deepcopy(baseline)
            if mode=='content':changed[name][0]['content']['steps'].append('changed')
            elif mode=='add':changed[name].append({**changed[name][0],'id':'new-member'})
            elif mode=='remove':changed[name].pop()
            elif mode=='replace-member':changed[name][0]['id']='replacement-member'
            else:changed[name][0]['updatedAt']='changed'
            cases.append(changed);labels.append(name+' '+mode);expected.append((name,mode))
    for name,field in [('InventoryItem','updated_at'),('InventoryItem','updatedAt'),
                       ('approval_templates_archive','updated_at'),('ApprovalTemplates','updated_at')]:
        changed=copy.deepcopy(baseline);changed[name][0][field]='changed'
        cases.append(changed);labels.append(name+' '+field);expected.append((name,field))
    prefix=r'''
import {PGlite} from '@electric-sql/pglite';import {createHash} from 'node:crypto';import {readFileSync} from 'node:fs';
const db=new PGlite();const snapshots=[];
for(const fixture of JSON.parse(readFileSync(0,'utf8'))){
 const prisma={
  async $queryRawUnsafe(sql,...parameters){
   if(sql.includes('FROM pg_tables'))return Object.keys(fixture).sort().map(tablename=>({tablename}));
   if(sql.startsWith('SELECT k.column_name'))return [{column_name:'id'}];
   if(sql.startsWith('SELECT migration_name'))return [];
   if(sql.startsWith('SELECT convalidated'))return [{convalidated:true,definition:'unchanged'}];
   if(sql.startsWith('SELECT current_setting'))return [{version:'PostgreSQL SELECT-only proof'}];
   const match=sql.match(/ FROM "((?:""|[^"])*)" t /);if(!match)throw Error('Unexpected snapshot query');
   const table=match[1].replaceAll('""','"');const rows=fixture[table];
   const columns=[...new Set(rows.flatMap(row=>Object.keys(row)))].sort();
   const declarations=columns.map(name=>'"'+name.replaceAll('"','""')+'" jsonb').join(',');
   // The unchanged generated SELECT executes in PostgreSQL over a CTE; no DDL/DML.
   return (await db.query('WITH "'+match[1]+'" AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS fixture('+declarations+')) '+sql,[JSON.stringify(rows)])).rows;
  },async $disconnect(){}
 };
 const process={stdout:{write:value=>snapshots.push(JSON.parse(value))}};
'''
    snapshot=ci.MATERIAL_SNAPSHOT_JS.replace("import {prisma} from './server/pg.js';import {createHash} from 'node:crypto';",'',1)
    script=prefix+snapshot+"\n}\nawait db.close();process.stdout.write(JSON.stringify(snapshots));\n"
    result=subprocess.run(['node','--input-type=module','-e',script],cwd=ROOT,input=json.dumps(cases),text=True,capture_output=True,check=True)
    snapshots=json.loads(result.stdout);assert len(snapshots)==len(cases)
    assert snapshots[0]==snapshots[1],labels[1]
    print('ALLOW exact two template updated_at fields: 2+14 rows; all projected facts and metadata identical')
    for index,(name,mode) in enumerate(expected,2):
        before=snapshots[0];after=snapshots[index]
        assert before['facts']!=after['facts'],labels[index]
        difference=ci.material_fact_difference(before,after)
        assert difference['totalChangedTables']==1,labels[index]
        table=difference['tables'][0];assert table['table']==name,labels[index]
        if mode in ('content','updated_at','updatedAt'):
            assert table['changedFields']==[{'field':mode,'rowCount':1}],labels[index]
        elif mode=='add':assert table['addedRows']==1 and table['afterCount']==table['beforeCount']+1,labels[index]
        elif mode=='remove':assert table['removedRows']==1 and table['afterCount']==table['beforeCount']-1,labels[index]
        else:assert table['addedRows']==table['removedRows']==1 and table['afterCount']==table['beforeCount'],labels[index]
        print('REJECT '+labels[index])
    source=(ROOT/'scripts/test-candidate-db-probe-integration.py').read_text()
    original=subprocess.check_output(['git','-C',str(ROOT),'show','f2a76c01eb62f50a344e0e0c34be37a581a0796c:scripts/test-candidate-db-probe-integration.py'],text=True)
    def gate(text):return text[text.index('                if before_facts!=after_facts:'):text.index('                final=remote.db();expected_ledger=')]
    assert gate(source)==gate(original),'Existing complete facts rejection changed'
    print('TEMPLATE_TIMESTAMP_SQL_PROOF=PASS allowed=1 rejected=14 original_fact_rejection=unchanged fixture_writes=0')


def legacy_q_regressions():
    """Historical unit fixtures keep their exact 85/86 SQL trees; runtime gates stay fixed.

    Only Path.glob on the unit fixture's migrations directory is isolated. The
    material contract/native/real controller proof continue to use all 87 files.
    No deployment count, schema or authority override exists.
    """
    results=[]
    for name in ('test-deploy-prod-transfer-cas','test-transfer-cas-existing-workflow','test-release-path-post-transfer'):
        test=module(ROOT/('scripts/'+name+'.py'),'material_legacy_'+name.replace('-','_'))
        native_path=type(Path())
        class FixturePath(native_path):
            def glob(self,pattern):
                values=list(super().glob(pattern))
                if self==ROOT/'prisma/migrations' and pattern=='*/migration.sql':
                    omitted={test.r.material_contract()['migration']}
                    values=[p for p in values if p.parent.name not in omitted]
                return iter(values)
        with patch.object(test.r,'Path',FixturePath):
            result=unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromModule(test))
        results.append({'suite':name,'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skipped':len(result.skipped),'fixture':'EXACT_HISTORICAL_85_OR_86_SQL_TREE','success':result.wasSuccessful()})
    (ROOT.parent/'material-legacy-regression-results.json').write_text(json.dumps(results,indent=2)+'\n')
    if not all(x['success'] for x in results):raise SystemExit(1)


def native_pg16():
    """Real Q86 backup/restore, L87 additive SQL, old-client read and ledger-gap proof.

    Only the registered task-owned loopback PG16 cluster is accepted. This test
    module's database-name substitution is never a deployment input override.
    """
    from urllib.parse import urlsplit
    import time
    admin=os.environ.get('TEST_DATABASE_URL','');parsed=urlsplit(admin)
    runtime=ROOT.parent/'native-pg-runtime.json'
    record=json.loads(runtime.read_text())
    if (parsed.hostname!='127.0.0.1' or parsed.port!=record['port'] or parsed.path!='/postgres'
            or record.get('ownsCluster') is not True or record.get('status')!='STARTED'):
        raise RuntimeError('TASK_OWNED_NATIVE_PG_REQUIRED')
    bindir=Path(record['bin']);old=ROOT.parent/'budu-material-Q-baseline'
    r=module(ROOT/'scripts/deploy-prod-transfer-cas.py','material_native_contract');c=r.material_contract()
    ci=module(ROOT/'scripts/test-candidate-db-probe-integration.py','material_native_fixture')
    def checked(args,data=None,cwd=None,env=None):
        result=subprocess.run([str(v) for v in args],input=data,cwd=cwd,env=env,capture_output=True,timeout=300)
        if result.returncode:
            (ROOT.parent/'material-native-command-failure.log').write_bytes(result.stderr[-8000:])
            raise RuntimeError('MATERIAL_NATIVE_COMMAND_FAILED:'+str(args[0]))
        return result.stdout
    if checked([bindir/'postgres','--version']).decode().strip()!='postgres (PostgreSQL) 16.14':
        raise RuntimeError('MATERIAL_NATIVE_PG16_REQUIRED')
    if subprocess.check_output(['git','-C',str(old),'rev-parse','HEAD']).decode().strip()!=c['oldSha']:
        raise RuntimeError('EXACT_OLD_CLIENT_REQUIRED')
    ledger={p.parent.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'prisma/migrations').glob('*/migration.sql')}
    r.configure_profile('post-transfer',c['oldSha'],c['businessSha'],'0'*64)
    baseline=r.before_ledger(ledger)
    prefix='material_rel_'+str(os.getpid())+'_'+hex(time.time_ns())[2:]
    names=(prefix,prefix+'_restore',prefix+'_gap');created=[]
    def url(name):return admin.rsplit('/',1)[0]+'/'+name
    def sql(name,text,readonly=False):
        env={**os.environ,'PGOPTIONS':'-c default_transaction_read_only=on -c statement_timeout=8000 -c temp_file_limit=0'} if readonly else None
        return checked([bindir/'psql',url(name),'-X','-qAt','-v','ON_ERROR_STOP=1'],text.encode(),env=env)
    def node(name,code):
        return checked(['node','--input-type=module','-'],code.encode(),old,{**os.environ,'APP_ENV':'test','NODE_ENV':'test','DATABASE_URL':url(name)})
    function=next(n for n in ast.parse((ROOT/'scripts/deploy-prod-transfer-cas.py').read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='material_database_details')
    code=next(n.value.left.value for n in function.body if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name) and n.targets[0].id=='code') % ('fixture','fixture','fixture')
    material_sql=next(n.value.value for n in ast.parse(code).body if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name) and n.targets[0].id=='sql')
    def phase(name,expected,rejection=None):
        db=json.loads(node(name,ci.PHASE_JS));db['materialSchema']=json.loads(sql(name,material_sql,True))
        original=r.EXPECTED_DB;r.EXPECTED_DB=name
        try:
            try:r.validate_database(db,expected)
            except r.GateError as error:
                if str(error)!=rejection:raise
            else:
                if rejection:raise RuntimeError('MATERIAL_NATIVE_GAP_NOT_REJECTED')
        finally:r.EXPECTED_DB=original
        return db
    with tempfile.TemporaryDirectory(prefix='material-release-native-',dir=ROOT.parent) as directory:
        work=Path(directory);before_source=work/'q';before_source.mkdir()
        checked(['tar','-x','-C',before_source],checked(['git','-C',ROOT,'archive',c['oldSha'],'prisma']))
        cli=ROOT/'node_modules/prisma/build/index.js'
        def migrate(name,schema):checked(['node',cli,'migrate','deploy','--schema',schema],cwd=work,env={**os.environ,'DATABASE_URL':url(name)})
        try:
            for name in names:
                sql('postgres','CREATE DATABASE '+name+';');created.append(name)
            migrate(names[0],before_source/'prisma/schema.prisma');node(names[0],ci.MATERIAL_FIXTURE_JS)
            before=json.loads(node(names[0],ci.MATERIAL_SNAPSHOT_JS));phase(names[0],baseline)
            assert set(before['rowDetails'])=={row[0] for row in before['facts']}
            items=before['rowDetails']['InventoryItem']
            assert items['primaryKey'] is True and len(items['rows'])==31
            assert all('category' in fields and 'partnerMaterialPriceCents' not in fields
                       and all(re.fullmatch('[0-9a-f]{64}',value) for value in fields.values())
                       for fields in items['rows'].values())
            # Verify field localization with real SQL-derived metadata, without
            # changing a database row or publishing any captured row value.
            changed=copy.deepcopy(before)
            next(row for row in changed['facts'] if row[0]=='InventoryItem')[2]='0'*64
            key=next(iter(items['rows']));changed['rowDetails']['InventoryItem']['rows'][key]['category']='0'*64
            difference=ci.material_fact_difference(before,changed)
            assert difference['totalChangedTables']==1
            assert difference['tables'][0]['changedFields']==[{'field':'category','rowCount':1}]
            backup=checked([bindir/'pg_dump',url(names[0]),'-Fc','--no-owner','--no-acl'])
            for name in names[1:]:
                checked([bindir/'pg_restore','--dbname',url(name),'--exit-on-error','--no-owner','--no-acl'],backup)
                assert json.loads(node(name,ci.MATERIAL_SNAPSHOT_JS))==before
            migrate(names[0],ROOT/'prisma/schema.prisma');after=json.loads(node(names[0],ci.MATERIAL_SNAPSHOT_JS))
            assert before['facts']==after['facts']
            target=phase(names[0],ledger);assert target['materialSchema']['nonNullQuotes']==0
            assert target['materialSchema']['materialCount']==26 and target['materialSchema']['protectedProductCount']==4
            compatibility=node(names[0],"import {prisma} from './server/pg.js';try {const rows=await prisma.inventoryItem.findMany({where:{category:'material'}});if(rows.length!==26)throw Error('COUNT');process.stdout.write('OLD_Q_CLIENT_READ_OK');}finally{await prisma.$disconnect()}").decode()
            assert compatibility=='OLD_Q_CLIENT_READ_OK'
            assert 'OLD_APP_HTTP_SUMMARY_XLSX_ACTUAL6_OK' in node(names[0],ci.OLD_COMPAT_JS).decode()
            assert json.loads(node(names[0],ci.MATERIAL_SNAPSHOT_JS))['facts']==before['facts']
            # A committed SQL change without its ledger completion cannot be accepted.
            sql(names[2],(ROOT/'prisma/migrations'/c['migration']/'migration.sql').read_text())
            phase(names[2],baseline,'MIGRATION_LEDGER_INVALID')
            proof={'scope':'TASK_OWNED_NATIVE_PG16_ONLY','oldSha':c['oldSha'],'businessSha':c['businessSha'],'oldMigrations':86,'targetMigrations':87,'sqlSha256':c['sqlHash'],'backupRestore':'PASS','allBusinessTableFactsUnchanged':True,'businessTables':len(before['facts']),'materialCount':26,'protectedProductCount':4,'newColumnInitiallyAllNull':True,'oldQPrismaRead':'PASS','oldQHttpSummaryXlsx':'PASS','committedSQLLedgerGap':'REJECTED','productionActions':False}
            proof.update(materialRowMetadata='118 tables; InventoryItem stable primary keys; no quote field or raw row values',fieldDiagnosticAgainstRealSnapshot='PASS metadata-only in-memory mutation')
        finally:
            for name in reversed(created):sql('postgres','DROP DATABASE '+name+' WITH (FORCE);')
    proof['ownedDatabasesRemoved']=True
    (ROOT.parent/'material-adapter-native-proof.json').write_text(json.dumps(proof,indent=2)+'\n')
    print(json.dumps(proof))


if __name__=='__main__':
    if len(sys.argv)==2 and sys.argv[1]=='--legacy-q-regressions':legacy_q_regressions()
    elif len(sys.argv)==2 and sys.argv[1]=='--template-timestamp-proof':template_timestamp_proof()
    elif len(sys.argv)==2 and sys.argv[1]=='--native-pg16':native_pg16()
    else:unittest.main()

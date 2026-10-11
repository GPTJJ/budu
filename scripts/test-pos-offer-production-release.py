#!/usr/bin/env python3
"""Finite POS admission: real Git positive, isolated rejecting inputs, no DB."""
import ast
import copy
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('pos_release', ROOT/'scripts/deploy-prod-transfer-cas.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


def pos_call(node):
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'pos_offer_hotfix'


class LegacyProjection(ast.NodeTransformer):
    """Remove only the independently guarded POS alternatives, not old checks."""
    def visit_If(self, node):
        node = self.generic_visit(node)
        return node.orelse if pos_call(node.test) else node

    def visit_IfExp(self, node):
        node = self.generic_visit(node)
        return node.orelse if pos_call(node.test) else node

    def visit_BoolOp(self, node):
        node = self.generic_visit(node)
        node.values = [value for value in node.values if not pos_call(value)]
        return node.values[0] if len(node.values) == 1 else node


def assert_legacy_equivalence(before, after):
    def functions(source, project=False):
        tree = ast.parse(source)
        if project:
            tree = LegacyProjection().visit(tree)
        return {node.name: ast.dump(node, include_attributes=False) for node in tree.body
                if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and not node.name.startswith('pos_offer_')}
    old, new = functions(before), functions(after, True)
    if old != new:
        changed = sorted(name for name in set(old) | set(new) if old.get(name) != new.get(name))
        raise AssertionError('Legacy controller semantics changed: '+repr(changed))
    added = {node.name for node in ast.parse(after).body if isinstance(node, ast.FunctionDef)
             and node.name.startswith('pos_offer_')}
    if added != {'pos_offer_hotfix', 'pos_offer_identity', 'pos_offer_frontend_proof', 'pos_offer_live_binding'}:
        raise AssertionError('Unexpected POS controller extension')


def overlay_files():
    files = {p.relative_to(ROOT).as_posix():p.read_bytes() for p in (ROOT/'dist').rglob('*') if p.is_file()}
    for name in subprocess.check_output(['git','ls-files','--','scripts'],cwd=ROOT,text=True).splitlines():
        files[name] = (ROOT/name).read_bytes()
    return files


class PosOfferAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.release = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        self.old_v2 = hashlib.sha256(subprocess.check_output(
            ['git', 'show', r.POS_OFFER_LIVE_SHA+':server/v2.js'], cwd=ROOT)).hexdigest()
        r.configure_profile('post-transfer', r.POS_OFFER_LIVE_SHA, r.POS_OFFER_BUSINESS_SHA, self.old_v2)
        r.THIN_MODE = r.BG_ACTIVE = True
        r.THIN_IDENTITY = r.MOBILE_HOTFIX_IDENTITY = False
        r.CAPACITY_WAIVER = None

    def admit(self):
        # No invented SHA, branch, filesystem or positive Git mock.
        release, ledger = r.identity(ROOT)
        self.assertEqual(release, self.release)
        self.assertEqual(len(ledger), 88)
        return release, ledger

    def test_real_production_business_engineering_chain(self):
        self.admit()
        self.assertEqual(r.git(ROOT, 'rev-list', '--parents', '-n', '1', self.release),
                         self.release+' '+r.POS_OFFER_BUSINESS_SHA)
        self.assertEqual(r.thin_live_sha(), r.POS_OFFER_LIVE_SHA)
        self.assertEqual(r.thin_business_sha(), r.POS_OFFER_BUSINESS_SHA)
        self.assertEqual(r.bg_release_base(), r.POS_OFFER_BUSINESS_SHA)
        self.assertEqual(r.bg_hotfix_base(), r.POS_OFFER_LIVE_SHA)
        self.assertEqual(r.bg_hotfix_files(), r.POS_OFFER_RELEASE_FILES)
        self.assertFalse(r.migration_enabled())

    def test_all_frozen_business_blobs_match_git(self):
        self.assertEqual(set(r.POS_OFFER_SOURCE_HASHES), {
            'src/components/PosPage.jsx', 'src/components/PosOfferPanel.jsx',
            'src/components/PosOfferPanel.module.css', 'src/hooks/usePosOffer.js',
            'src/utils/posOffer.js', 'scripts/check-pos-offer.mjs'})
        for name, expected in r.POS_OFFER_SOURCE_HASHES.items():
            blob = subprocess.check_output(['git', 'show', r.POS_OFFER_BUSINESS_SHA+':'+name], cwd=ROOT)
            self.assertEqual(hashlib.sha256(blob).hexdigest(), expected)
            self.assertEqual(blob, (ROOT/name).read_bytes())

    def test_wrong_production_branch_parent_and_extra_files_rejected(self):
        original = r.git
        cases = [
            lambda args, value: 'wrong-branch' if args == ('branch', '--show-current') else value,
            lambda args, value: self.release+' '+'0'*40 if args == ('rev-list', '--parents', '-n', '1', self.release) else value,
        ]
        for corruption in cases:
            def rejected_git(repo, *args): return corruption(args, original(repo, *args))
            with patch.object(r, 'git', side_effect=rejected_git), self.assertRaises(r.GateError):
                r.thin_identity(ROOT, self.release)
            self.assertFalse(r.THIN_IDENTITY or r.MOBILE_HOTFIX_IDENTITY)
        for name in ('src/components/Sidebar.jsx', 'src/utils/pos.js', 'src/utils/userData.js',
                     'server/app.js', 'prisma/schema.prisma', 'package.json', 'package-lock.json'):
            def extra(repo, *args):
                value = original(repo, *args)
                return value+'\n'+name if args[:2] == ('diff', '--name-only') else value
            with self.subTest(name=name), patch.object(r, 'git', side_effect=extra), self.assertRaises(r.GateError):
                r.thin_identity(ROOT, self.release)
        with patch.object(r, 'EXPECTED_OLD_SHA', '0'*40), self.assertRaises(r.GateError):
            r.thin_identity(ROOT, self.release)
        with patch.object(r, 'CAPACITY_WAIVER', {}), self.assertRaises(r.GateError):
            r.thin_identity(ROOT, self.release)

    def test_frozen_hash_drift_rejected_without_editing_business_files(self):
        for name in r.POS_OFFER_FILES:
            wrong = dict(r.POS_OFFER_SOURCE_HASHES, **{name:'0'*64})
            with self.subTest(name=name), patch.object(r, 'POS_OFFER_SOURCE_HASHES', wrong), self.assertRaisesRegex(r.GateError, 'POS_OFFER_SOURCE_DRIFT'):
                r.thin_identity(ROOT, self.release)

    def test_exact_frontend_only_exclusion_and_complete_base_runtime(self):
        self.admit()
        proof = r.pos_offer_frontend_proof(ROOT)
        self.assertEqual(proof['distTreeSha256'], r.POS_OFFER_DIST_TREE_SHA256)
        payload = r.runtime_payload(ROOT)
        self.assertNotIn('app/src/utils/posOffer.js', payload)
        paths = subprocess.check_output(['git','ls-tree','-r','--name-only',r.POS_OFFER_LIVE_SHA,
            '--','server','shared','src/utils','prisma','brand/web','package.json','package-lock.json'],
            cwd=ROOT,text=True).splitlines()
        expected = {p for p in paths if not p.startswith('server/data/')}
        actual = {p[4:] for p in payload if not p.startswith(('app/dist/','app/scripts/'))}
        self.assertEqual(actual, expected)
        for name in paths:
            if name.startswith('server/data/'): continue
            expected_hash = hashlib.sha256(subprocess.check_output(['git','show',r.POS_OFFER_LIVE_SHA+':'+name],cwd=ROOT)).hexdigest()
            self.assertEqual(payload['app/'+name], expected_hash)

    def test_backend_reference_and_build_drift_rejected(self):
        self.admit()
        original = Path.read_bytes
        def referenced(path):
            data = original(path)
            return data+b"\nimport '../src/utils/posOffer.js'\n" if path == ROOT/'server/app.js' else data
        with patch.object(Path, 'read_bytes', referenced), self.assertRaisesRegex(r.GateError, 'POS_OFFER_BACKEND_REFERENCE'):
            r.pos_offer_frontend_proof(ROOT)
        with patch.object(r, 'POS_OFFER_DIST_TREE_SHA256', '0'*64), self.assertRaisesRegex(r.GateError, 'POS_OFFER_FRONTEND_BUILD_MISMATCH'):
            r.pos_offer_frontend_proof(ROOT)

    def test_exact_live_image_container_labels_routes_and_rejections(self):
        self.admit()
        b = r.POS_OFFER_LIVE_BINDING
        g = {'Id': b['containerId'], 'Name':'/'+b['containerName'], 'Image':b['imageId'],
             'Config': {'Labels':copy.deepcopy(b['containerLabels']), 'Env':['GIT_SHA='+b['liveSha']]}}
        image = {'Id':b['imageId'], 'Config':{'Labels':copy.deepcopy(b['imageLabels'])}}
        # Offline boundary cases; actual production preflight uses Docker inspection.
        for target, key, value in [('g','Id','0'*64), ('g','Image','sha256:'+'0'*64),
                                  ('image','Id','sha256:'+'0'*64)]:
            bad_g, bad_image = copy.deepcopy(g), copy.deepcopy(image)
            (bad_g if target == 'g' else bad_image)[key] = value
            with self.subTest(target=target,key=key), self.assertRaises(r.GateError):
                r.pos_offer_live_binding(bad_g, bad_image)
        for target in ('g', 'image'):
            bad_g, bad_image = copy.deepcopy(g), copy.deepcopy(image)
            (bad_g if target == 'g' else bad_image)['Config']['Labels']['unknown'] = 'x'
            with self.assertRaises(r.GateError): r.pos_offer_live_binding(bad_g, bad_image)
        with self.assertRaisesRegex(r.GateError, 'POS_OFFER_LIVE_ROUTE_DRIFT'):
            r.pos_offer_live_binding(g, image, 'wrong', 'wrong')

    def test_manifest_hash_binds_source_and_build(self):
        self.admit()
        files = overlay_files()
        m = r.thin_manifest(files, self.release)
        self.assertEqual(m['project'], 'BUDU-POS-OFFER-001')
        self.assertEqual(m['sourceHashes'], r.POS_OFFER_SOURCE_HASHES)
        self.assertEqual(m['frontendOnlySources'], {r.POS_OFFER_FRONTEND_ONLY:r.POS_OFFER_SOURCE_HASHES[r.POS_OFFER_FRONTEND_ONLY]})
        bad = dict(files); bad['dist/index.html'] += b'\nchanged'
        with self.assertRaises(r.GateError): r.thin_manifest(bad, self.release)
        bad = dict(files); bad[r.POS_OFFER_FRONTEND_ONLY] = b'wrong'
        with self.assertRaises(r.GateError): r.thin_manifest(bad, self.release)

    def test_bg_bind_rejects_inexact_production_proof(self):
        self.admit()
        b = r.POS_OFFER_LIVE_BINDING
        files = overlay_files()
        art = {'release':self.release, 'thin':True, 'capacityProfile':r.THIN_PROFILE,
               'manifest':r.thin_manifest(files,self.release)}
        live = {'result':'LIVE_G_PROVEN', 'LIVE_G_SHA':r.POS_OFFER_LIVE_SHA,
                'DB_APPLIED':88,'DB_FAILED':0,'POINTER_SHA':r.POS_OFFER_LIVE_SHA,
                'LIVE_G_CONTAINER_ID':b['containerId'],'LIVE_G_IMAGE_ID':b['imageId']}
        r.bg_bind(ROOT,self.release,art,live)
        for key,value in [('LIVE_G_CONTAINER_ID','0'*64),('LIVE_G_IMAGE_ID','sha256:'+'0'*64),
                          ('DB_APPLIED',87),('DB_FAILED',1),('POINTER_SHA','0'*40)]:
            with self.subTest(key=key), self.assertRaises(r.GateError):
                r.bg_bind(ROOT,self.release,art,dict(live,**{key:value}))

    def test_legacy_semantics_constants_and_safety_guards_unchanged(self):
        before = subprocess.check_output(['git','show',r.POS_OFFER_BUSINESS_SHA+':scripts/deploy-prod-transfer-cas.py'],cwd=ROOT,text=True)
        after = (ROOT/'scripts/deploy-prod-transfer-cas.py').read_text()
        assert_legacy_equivalence(before, after)
        def assignments(source):
            return [ast.dump(node,include_attributes=False) for node in ast.parse(source).body
                    if isinstance(node,(ast.Assign,ast.AnnAssign))
                    and not (isinstance(node,ast.Assign) and isinstance(node.targets[0],ast.Name)
                             and node.targets[0].id.startswith('POS_OFFER_'))]
        self.assertEqual(assignments(before), assignments(after))
        self.assertEqual(r.MIN_PROJECTED_AVAILABLE,10*1024**3)
        self.assertEqual(r.MAX_PROJECTED_USAGE,90)
        self.assertIsNone(r.CAPACITY_WAIVER)


if __name__ == '__main__':
    unittest.main()

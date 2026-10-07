#!/usr/bin/env python3
"""Offline exact binding and unchanged production-controller safety checks."""
import ast
import copy
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('scroll_release', ROOT/'scripts/deploy-prod-transfer-cas.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class ScrollReleaseTests(unittest.TestCase):
    def setUp(self):
        r.configure_profile('post-transfer', r.SCROLL_UI_LIVE_SHA, r.SCROLL_UI_BUSINESS_SHA, '0'*64)
        r.THIN_MODE = r.BG_ACTIVE = True
        r.THIN_IDENTITY = r.MOBILE_HOTFIX_IDENTITY = False
        r.CAPACITY_WAIVER = None
        self.release = 'a'*40

    def fake_git(self, repo, *args):
        if args == ('branch', '--show-current'): return r.SCROLL_UI_BRANCH
        if args[:3] == ('rev-list', '--parents', '-n'):
            sha = args[-1]
            return sha+' '+(r.SCROLL_UI_BUSINESS_SHA if sha == self.release else r.SCROLL_UI_LIVE_SHA)
        if args[:2] == ('status', '--porcelain'): return ''
        if args[:2] == ('diff', '--name-only'):
            if '--' in args: return ''
            before, after = args[2:]
            paths = r.SCROLL_UI_FILES if after == r.SCROLL_UI_BUSINESS_SHA else r.SCROLL_UI_RELEASE_FILES if before == r.SCROLL_UI_BUSINESS_SHA else r.SCROLL_UI_FILES | r.SCROLL_UI_RELEASE_FILES
            return '\n'.join(sorted(paths))
        raise AssertionError(args)

    def test_exact_profile_and_scope_pass(self):
        with patch.object(r, 'git', side_effect=self.fake_git): r.thin_identity(ROOT, self.release)
        self.assertTrue(r.THIN_IDENTITY and r.MOBILE_HOTFIX_IDENTITY)
        self.assertEqual(r.thin_live_sha(), r.SCROLL_UI_LIVE_SHA)
        self.assertEqual(r.thin_business_sha(), r.SCROLL_UI_BUSINESS_SHA)
        self.assertEqual(r.bg_release_base(), r.SCROLL_UI_BUSINESS_SHA)
        self.assertEqual(r.bg_hotfix_base(), r.SCROLL_UI_LIVE_SHA)
        self.assertFalse(r.migration_enabled())

    def test_reject_wrong_branch_parent_dirty_or_scope(self):
        corruptions = [
            lambda a,v: 'wrong' if a == ('branch','--show-current') else v,
            lambda a,v: v+' unexpected' if a[:1] == ('rev-list',) else v,
            lambda a,v: ' M src/components/Sidebar.jsx' if a[:1] == ('status',) else v,
            lambda a,v: v+'\nserver/v2.js' if a[:2] == ('diff','--name-only') and '--' not in a else v,
            lambda a,v: 'server/v2.js' if a[:2] == ('diff','--name-only') and '--' in a else v,
        ]
        for corruption in corruptions:
            def bad_git(repo, *args): return corruption(args, self.fake_git(repo, *args))
            with self.subTest(corruption=corruption), patch.object(r,'git',side_effect=bad_git), self.assertRaises(r.GateError):
                r.thin_identity(ROOT,self.release)
            self.assertFalse(r.THIN_IDENTITY or r.MOBILE_HOTFIX_IDENTITY)

    def test_reject_waiver_and_wrong_live_base(self):
        for key,value in [('CAPACITY_WAIVER',{}),('EXPECTED_OLD_SHA','0'*40)]:
            with patch.object(r,key,value),patch.object(r,'git',side_effect=self.fake_git),self.assertRaises(r.GateError):
                r.thin_identity(ROOT,self.release)

    def test_frontend_hash_drift_rejected(self):
        with patch.object(r,'SCROLL_UI_SOURCE_HASHES',{'src/components/PullToRefresh.jsx':'0'*64}),patch.object(r,'git',side_effect=self.fake_git),self.assertRaisesRegex(r.GateError,'BUSINESS_FIX_REQUIRED'):
            r.thin_identity(ROOT,self.release)

    def test_exact_inherited_labels_and_unknown_labels_rejected(self):
        r.THIN_IDENTITY = r.MOBILE_HOTFIX_IDENTITY = True
        binding=r.SCROLL_UI_LIVE_BINDING
        g={'Image':binding['imageId'],'Config':{'Labels':copy.deepcopy(binding['containerLabels'])}}
        art={'thin':True,'capacityProfile':r.THIN_PROFILE,'baseImageId':binding['imageId'],'manifest':{'overlayIdentity':'b'*64}}
        out=r.thin_clone_source(g,art)
        self.assertEqual(out['Config']['Labels']['budu.thin-base'],r.SCROLL_UI_LIVE_SHA)
        self.assertEqual(g['Config']['Labels'],binding['containerLabels'])
        for key,value in [('unknown','value'),('budu.thin-overlay-sha256','0'*64)]:
            bad=copy.deepcopy(g);bad['Config']['Labels'][key]=value
            with self.assertRaises(r.GateError):r.thin_clone_source(bad,art)

    def test_core_switch_rollback_db_capacity_and_writer_code_unchanged(self):
        before=subprocess.check_output(['git','-C',str(ROOT),'show',r.SCROLL_UI_LIVE_SHA+':scripts/deploy-prod-transfer-cas.py'],text=True)
        after=(ROOT/'scripts/deploy-prod-transfer-cas.py').read_text()
        def nodes(source):
            return {n.name:ast.dump(n,include_attributes=False) for n in ast.parse(source).body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
        old,new=nodes(before),nodes(after)
        permitted={'thin_live_sha','thin_business_sha','mobile_hotfix','bg_hotfix_base','bg_hotfix_files','bg_release_base','thin_identity','thin_clone_source','thin_preflight','thin_build'}
        self.assertEqual({k for k in old if old[k]!=new[k]},permitted)
        self.assertEqual(set(new)-set(old),{'scroll_ui_hotfix','scroll_ui_identity'})
        self.assertEqual(r.MIN_PROJECTED_AVAILABLE,10*1024**3)
        self.assertIsNone(r.CAPACITY_WAIVER)


if __name__ == '__main__': unittest.main()

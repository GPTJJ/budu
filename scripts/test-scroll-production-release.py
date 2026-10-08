#!/usr/bin/env python3
"""Offline exact binding and unchanged production-controller safety checks."""
import ast
import copy
import importlib.util
import os
from pathlib import Path
import subprocess
import types
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
            return sha+' '+({self.release:r.SCROLL_UI_RELEASE_PARENT,r.SCROLL_UI_BUSINESS_SHA:r.SCROLL_UI_LIVE_SHA}[sha])
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
        self.assertEqual(r.bg_release_base(), r.SCROLL_UI_RELEASE_PARENT)
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
        for path in ('src/components/PullToRefresh.jsx', *sorted(r.SCROLL_UI_FILES)):
            with self.subTest(path=path),patch.object(r,'SCROLL_UI_SOURCE_HASHES',{path:'0'*64}),patch.object(r,'git',side_effect=self.fake_git),self.assertRaisesRegex(r.GateError,'BUSINESS_FIX_REQUIRED'):
                r.thin_identity(ROOT,self.release)

    def test_scroll_agent_requires_exact_identity_and_owner(self):
        r.THIN_IDENTITY = r.MOBILE_HOTFIX_IDENTITY = True
        socket=r.SCROLL_UI_AGENT_SOCKET
        good=types.SimpleNamespace(st_mode=r.stat.S_IFSOCK|0o600,st_uid=os.getuid())
        listing=b'256 SHA256:ObUo5aPhSWBAS2c8UXYpe8oF/RByquRERPF5oEaEhVQ synthetic (ED25519)\n'
        with patch.dict(os.environ,{'SSH_AUTH_SOCK':socket}),patch.object(Path,'stat',return_value=good),patch.object(r,'command',return_value=listing):
            remote=r.Remote(Path(r.SCROLL_UI_AGENT_KEY))
            for flag in ('BatchMode=yes','StrictHostKeyChecking=yes','IdentitiesOnly=yes','IdentityAgent='+socket):self.assertIn(flag,remote.ssh)
        for owner,mode,agent,keys,key in [
                (os.getuid()+1,good.st_mode,socket,listing,r.SCROLL_UI_AGENT_KEY),
                (os.getuid(),r.stat.S_IFREG,socket,listing,r.SCROLL_UI_AGENT_KEY),
                (os.getuid(),good.st_mode,'/tmp/other',listing,r.SCROLL_UI_AGENT_KEY),
                (os.getuid(),good.st_mode,socket,listing+listing,r.SCROLL_UI_AGENT_KEY),
                (os.getuid(),good.st_mode,socket,listing.replace(b'ObUo5aPh',b'wrongAAA'),r.SCROLL_UI_AGENT_KEY),
                (os.getuid(),good.st_mode,socket,listing,'/tmp/other-key')]:
            with self.subTest(owner=owner,mode=mode,agent=agent,key=key),patch.dict(os.environ,{'SSH_AUTH_SOCK':agent}),patch.object(Path,'stat',return_value=types.SimpleNamespace(st_mode=mode,st_uid=owner)),patch.object(r,'command',return_value=keys),self.assertRaises(r.GateError):
                r.Remote(Path(key))

    def test_scope_and_business_ancestry_are_exact(self):
        self.assertEqual(r.SCROLL_UI_FILES,{'src/components/Sidebar.jsx'})
        self.assertEqual(subprocess.check_output(['git','-C',str(ROOT),'diff','--name-only',r.SCROLL_UI_LIVE_SHA,r.SCROLL_UI_BUSINESS_SHA],text=True).strip(),'src/components/Sidebar.jsx')
        self.assertEqual(subprocess.check_output(['git','-C',str(ROOT),'rev-list','--parents','-n','1',r.SCROLL_UI_BUSINESS_SHA],text=True).strip(),r.SCROLL_UI_BUSINESS_SHA+' '+r.SCROLL_UI_LIVE_SHA)
        self.assertEqual(subprocess.check_output(['git','-C',str(ROOT),'diff','--name-only',r.SCROLL_UI_LIVE_SHA,r.SCROLL_UI_BUSINESS_SHA,'--','prisma','server','shared','package.json','package-lock.json'],text=True).strip(),'')

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

    def test_clone_source_accepts_only_verified_thin_provenance(self):
        spec=importlib.util.spec_from_file_location('fixtures',ROOT/'scripts/test-deploy-prod-transfer-cas.py')
        fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
        old=fixture.original()
        old['Image']=r.SCROLL_UI_LIVE_BINDING['imageId']
        old['Config']['Labels']=copy.deepcopy(r.SCROLL_UI_LIVE_BINDING['containerLabels'])
        image=copy.deepcopy(old['Config'])
        r.THIN_IDENTITY=r.MOBILE_HOTFIX_IDENTITY=True
        r.validate_clone_source(old,image)
        for key,value in [('unknown','x'),('budu.thin-overlay-sha256','0'*64),('org.opencontainers.image.revision','0'*40)]:
            bad=copy.deepcopy(old);bad['Config']['Labels'][key]=value
            with self.subTest(key=key),self.assertRaisesRegex(r.GateError,'SOURCE_LABELS_UNSUPPORTED'):r.validate_clone_source(bad,image)
        for key,value in [('THIN_IDENTITY',False),('MOBILE_HOTFIX_IDENTITY',False),('CAPACITY_WAIVER',{})]:
            with patch.object(r,key,value),self.assertRaisesRegex(r.GateError,'SOURCE_LABELS_UNSUPPORTED'):r.validate_clone_source(old,image)

    def test_core_switch_rollback_db_capacity_and_writer_code_unchanged(self):
        before=subprocess.check_output(['git','-C',str(ROOT),'show',r.SCROLL_UI_LIVE_SHA+':scripts/deploy-prod-transfer-cas.py'],text=True)
        after=(ROOT/'scripts/deploy-prod-transfer-cas.py').read_text()
        def nodes(source):
            return {n.name:ast.dump(n,include_attributes=False) for n in ast.parse(source).body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
        old,new=nodes(before),nodes(after)
        permitted={'scroll_ui_identity'}
        self.assertEqual({k for k in old if old[k]!=new[k]},permitted)
        self.assertEqual(set(new)-set(old),set())
        before_clone=next(n for n in ast.parse(before).body if isinstance(n,ast.FunctionDef) and n.name=='validate_clone_source')
        after_clone=next(n for n in ast.parse(after).body if isinstance(n,ast.FunctionDef) and n.name=='validate_clone_source')
        self.assertEqual([ast.dump(n) for n in before_clone.body[:2]+before_clone.body[3:]],
                         [ast.dump(n) for n in after_clone.body[:2]+after_clone.body[3:]])
        def remote_methods(source):
            cls=next(n for n in ast.parse(source).body if isinstance(n,ast.ClassDef) and n.name=='Remote')
            return {n.name:ast.dump(n,include_attributes=False) for n in cls.body if isinstance(n,ast.FunctionDef) and n.name!='__init__'}
        self.assertEqual(remote_methods(before),remote_methods(after))
        self.assertEqual(r.MIN_PROJECTED_AVAILABLE,10*1024**3)
        self.assertEqual(r.MAX_PROJECTED_USAGE,90)
        self.assertIsNone(r.CAPACITY_WAIVER)


if __name__ == '__main__': unittest.main()

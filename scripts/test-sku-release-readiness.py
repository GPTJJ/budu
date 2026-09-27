#!/usr/bin/env python3
"""Pre-mutation readiness must fail closed before release state is created."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('sku_deploy', ROOT/'scripts/deploy-prod-sku-authority.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
FIXTURE = json.loads((ROOT/'.github/fixtures/sku-release-gate7-readiness.json').read_text())
ART = {'release':'a'*40, 'archive':1, 'blobs':1, 'expanded':1,
       'largest':1, 'imageReference':'test-candidate', 'config':{}}
MIGRATION_ART = dict(ART, imageReference='test-migration')
STATE = {'name':'old-prod', 'old':{'Id':'old-id'}, 'template':'old-route',
         'active':'old-route', 'diskUsed':1, 'diskAvailable':1000000000}


class FakeRemote:
    def __init__(self, fixture=None, db_probe=True):
        self.fixture = copy.deepcopy(fixture if fixture is not None else FIXTURE)
        self.db_probe = db_probe
        self.events = []
        self.mutations = []

    def run(self, args, **_):
        self.events.append(tuple(args[:4]))
        if args[:2] == ['sh','-lc'] and 'command -v timeout' in args[-1]:
            return b'TIMEOUT_OK'
        if args[:2] == ['docker','exec'] and 'PGOPTIONS=' in ' '.join(args):
            if 'SELECT 1 AS ok' in args[-1]:
                if not self.db_probe:
                    raise deploy.core.GateError('PROBE_FAILED')
                return deploy.core.APPLICATION_DB_PROBE_OK
            if 'channelFlags' in args[-1]:
                return json.dumps(self.fixture, separators=(',',':')).encode()
        if args[:3] == ['docker','ps','-aq'] or args[:3] == ['docker','images','-q']:
            return b''
        raise AssertionError('Unexpected read: '+str(args[:4]))

    def py(self, *_args, **_kwargs):
        self.mutations.append('py')
        raise AssertionError('Mutation reached')

    def db(self):
        self.events.append(('db',))
        return {'database':deploy.core.EXPECTED_DB, 'applied':85,
                'failed':0, 'ledger':{}, 'clients':[]}

    def containers(self):
        self.events.append(('containers',))
        return []

    def inspect(self, name):
        self.events.append(('inspect',name))
        return {'Id':'old-id'}

    def routes(self):
        self.events.append(('routes',))
        return ('old-route','old-route')


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.patches = [patch.object(deploy.core,'preflight',return_value=copy.deepcopy(STATE)),
                        patch.object(deploy,'combined_budget',return_value={'safe':True}),
                        patch.object(deploy.core,'mount_readability',return_value=[]),
                        patch.object(deploy.core,'validate_database'),
                        patch.object(deploy.core,'writer_check')]
        for item in self.patches: item.start()
        self.addCleanup(lambda: [item.stop() for item in reversed(self.patches)])

    def readiness(self, remote):
        return deploy.pre_mutation_readiness(remote,ROOT,ART,MIGRATION_ART,{})

    def blocked_before_mutation(self, remote, code=None):
        with self.assertRaises(deploy.core.GateError) as caught:
            deploy.deploy(remote,ROOT,Path('/does-not-exist'),Path('/does-not-exist'),
                          ART,MIGRATION_ART,{}, {},ART['release'])
        if code: self.assertEqual(str(caught.exception),code)
        self.assertEqual(remote.mutations,[])
        self.assertFalse(any(event[:2] == ('docker','load') for event in remote.events))

    def test_exact_gate7_and_real_old_app_probe(self):
        remote = FakeRemote()
        result = self.readiness(remote)
        identity = result['identity']
        self.assertEqual(identity['counts'],{'total':178,'BD':89,'TP':89,
                         'missingOldSku':33,'aliases':145})
        self.assertEqual((identity['posActive'],identity['anyChannelEnabled'],identity['online']),
                         (87,113,153))
        self.assertEqual(identity['mappingDigest'],
                         'a939e90b70af125919abbc71ea461b2ec0c37773b0fda8e2da326d02451fab92')
        self.assertEqual(identity['onlineDigest'],
                         '8042665cff559a5110a933e499137399d35cbce88dcb3f356f09825ca5924a86')
        self.assertEqual(len([e for e in remote.events if e[:2] == ('docker','exec')]),2)
        self.assertEqual(remote.mutations,[])

    def test_old_application_db_probe_failure(self):
        self.blocked_before_mutation(FakeRemote(db_probe=False),
                                     'OLD_APPLICATION_REAL_DB_PROBE_FAILED')

    def test_catalog_count_drift(self):
        fixture = copy.deepcopy(FIXTURE)
        fixture['products'].pop()
        self.blocked_before_mutation(FakeRemote(fixture),'SKU_PRE_MUTATION_MAPPING_DRIFT')

    def test_pos_active_drift(self):
        fixture = copy.deepcopy(FIXTURE)
        item = next(item for item in fixture['products'] if not item['isActive'])
        item['isActive'] = True
        next(flag for flag in fixture['channelFlags'] if flag['id'] == item['id'])['isActive'] = True
        self.blocked_before_mutation(FakeRemote(fixture),'SKU_PRE_MUTATION_MAPPING_DRIFT')

    def test_any_channel_drift(self):
        fixture = copy.deepcopy(FIXTURE)
        item = next(item for item in fixture['channelFlags'] if not any(
            item[key] for key in ('isActive','transferEnabled','partnerSupplyEnabled',
                                  'partnerReplenishmentEnabled')))
        item['transferEnabled'] = True
        self.blocked_before_mutation(FakeRemote(fixture),'SKU_PRE_MUTATION_MAPPING_DRIFT')

    def test_mapping_drift(self):
        fixture = copy.deepcopy(FIXTURE)
        fixture['products'][0]['name'] += ' changed'
        self.blocked_before_mutation(FakeRemote(fixture),'SKU_PRE_MUTATION_MAPPING_DRIFT')

    def test_online_mapping_drift(self):
        fixture = copy.deepcopy(FIXTURE)
        fixture['online'][0]['externalSkuId'] += '-changed'
        self.blocked_before_mutation(FakeRemote(fixture),'SKU_PRE_MUTATION_MAPPING_DRIFT')

    def test_ledger_or_writer_failure(self):
        for function in ('validate_database','writer_check'):
            with self.subTest(function=function):
                with patch.object(deploy.core,function,side_effect=deploy.core.GateError('AUTHORITY_DRIFT')):
                    self.blocked_before_mutation(FakeRemote(),'AUTHORITY_DRIFT')

    def test_post_snapshot_route_drift(self):
        remote = FakeRemote()
        remote.routes = lambda: ('other-route','other-route')
        self.blocked_before_mutation(remote,'SKU_AUTHORITY_CHANGED_DURING_READINESS')

    def test_frozen_plan_requires_exact_readiness_snapshot_and_channel_digest(self):
        operation = object.__new__(deploy.operations.SkuProductionOperations)
        operation.readiness = {'snapshotId':'expected-snapshot',
                               'channelDigest':'expected-channels'}
        calls = []
        operation.require_writers = lambda count: calls.append(('writers',count))
        operation._save_plan = lambda raw: calls.append(('save',raw))
        value = {'plan':{'snapshotId':'expected-snapshot'},
                 'channelDigest':'expected-channels','anyChannelEnabled':113}
        operation._worker_command = lambda mode,write: json.dumps(value)
        operation.final_frozen_plan_check()
        self.assertEqual(calls[0],('writers',0))
        self.assertEqual(calls[1][0],'save')
        for changed in ({'plan':{'snapshotId':'drift'}},
                        {'channelDigest':'drift'}, {'anyChannelEnabled':112}):
            with self.subTest(changed=changed):
                calls.clear()
                current = dict(value,**changed)
                operation._worker_command = lambda mode,write: json.dumps(current)
                with self.assertRaises(deploy.core.GateError):
                    operation.final_frozen_plan_check()
                self.assertEqual(calls,[('writers',0)])


if __name__ == '__main__':
    unittest.main()

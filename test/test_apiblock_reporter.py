import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parents[1] / 'scripts/apiblock-health-reporter.py'
spec = importlib.util.spec_from_file_location('apiblock_reporter', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Response:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, *args): return b'{"ok": true}'


class ReporterTests(unittest.TestCase):
    def test_real_stages_are_ordered_and_separate_from_egin(self):
        sent = []
        def send(request, timeout):
            sent.append(json.loads(request.data))
            return Response()
        with patch.object(module.urllib.request, 'urlopen', side_effect=send):
            reporter = module.Reporter('https://health.example/ingest', 'x' * 64, 'deploy')
            reporter.start('a' * 40)
            reporter.stage('validate')
            reporter.stage('switch')
            reporter.stage('verify')
            reporter.finish('success')
        self.assertEqual([e['seq'] for e in sent], list(range(1, 11)))
        self.assertTrue(all(e['project'] == 'apiblock' and e['environment'] == 'production' for e in sent))
        self.assertEqual(sent[0]['stages'], ['prepare', 'validate', 'switch', 'verify'])
        self.assertEqual(sent[-1]['status'], 'success')

    def test_noop_does_not_create_a_fake_run(self):
        with patch.object(module.urllib.request, 'urlopen') as send:
            reporter = module.Reporter('https://health.example/ingest', 'x' * 64, 'deploy')
            reporter.finish('success')
        send.assert_not_called()

    def test_failed_deploy_does_not_complete_active_stage(self):
        sent = []
        def send(request, timeout):
            sent.append(json.loads(request.data))
            return Response()
        with patch.object(module.urllib.request, 'urlopen', side_effect=send):
            reporter = module.Reporter('https://health.example/ingest', 'x' * 64, 'deploy')
            reporter.start('b' * 40)
            reporter.stage('validate')
            reporter.finish('failure')
        self.assertEqual(sent[-1]['status'], 'failure')
        self.assertEqual(sent[-2]['state'], 'running')


if __name__ == '__main__':
    unittest.main()

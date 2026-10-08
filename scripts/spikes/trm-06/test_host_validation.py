"""Receipt parsing and real checkout refusal, not native acceptance evidence."""
import copy
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

spec = importlib.util.spec_from_file_location('host_validation', Path(__file__).with_name('host_validation.py'))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class HostValidation(unittest.TestCase):
    def test_every_embedded_execution_wrapper_compiles(self):
        compile(host.WRAPPER, '<native-wrapper>', 'exec')
        tree = ast.parse(Path(host.__file__).read_text())
        shell = next(node.value for node in ast.walk(tree) if isinstance(node, ast.Constant)
                     and isinstance(node.value, str) and node.value.startswith('\nheld = time.monotonic_ns()'))
        compile(host.WRAPPER[:host.WRAPPER.index("sys.argv = ['bootstrap'")] + shell,
                '<native-shell-wrapper>', 'exec')
        selectors = host.schedules()
        self.assertEqual(len(selectors), 235)
        self.assertEqual(len(set(selectors)), 235)

    def receipt(self):
        identity = {'revision': 'a' * 40, 'artifacts': {}}
        outside = {'sha256': hashlib.sha256(b'outside-fixture\0').hexdigest(), 'uid': 0, 'mode': 0o644}
        samples = []
        for phase, target, mutation in host.schedules():
            sample = dict(phase=phase, target=target, mutation=mutation, status='pass',
                          before=outside, after=outside, worker_pid=42, worker_uid=0,
                          held_ns=1, start_ns=2, end_ns=3, resume_ns=4,
                          exit=78, stdout='', stderr='SCHEDULE {}\n' + host.REFUSAL.decode(), process='')
            if host.positive_control(phase, mutation):
                sample.update(exit=0, stdout=json.dumps({'pid': 43, 'revision': 'a' * 40,
                              'environment': ['PATH=/usr/bin:/bin:/usr/sbin:/sbin']}),
                              process='43 501 /dev/fd/8 check-startup')
            samples.append(sample)
        return {'identity': identity, 'platform': 'darwin-arm64', 'samples': samples,
                'status': 'pass', 'accepted': False}, identity

    def test_receipt_requires_complete_ordered_same_revision_samples(self):
        receipt, identity = self.receipt()
        host.verify_receipt(receipt, identity)
        mutations = [lambda r: r.update(accepted=True), lambda r: r.update(status='partial-pass'),
                     lambda r: r.update(platform='linux-arm64'), lambda r: r['samples'].pop(),
                     lambda r: r['samples'].reverse(), lambda r: r['identity'].update(revision='b' * 40)]
        for mutate in mutations:
            changed = copy.deepcopy(receipt)
            mutate(changed)
            with self.subTest(mutation=mutate), self.assertRaises(ValueError):
                host.verify_receipt(changed, identity)

    def test_sample_requires_real_refusal_ordering_identity_and_sentinel(self):
        receipt, identity = self.receipt()
        for field, value in [('worker_uid', 501), ('worker_pid', 0), ('held_ns', 0),
                             ('start_ns', 0), ('end_ns', 5), ('exit', 0),
                             ('stdout', 'canary'), ('stderr', 'timeout'),
                             ('before', {}), ('after', {})]:
            changed = copy.deepcopy(receipt)
            changed['samples'][1][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                host.verify_receipt(changed, identity)
        for field, value in [('process', '43 0 gateway check-startup'), ('stdout', '{}'), ('exit', 78)]:
            changed = copy.deepcopy(receipt)
            changed['samples'][0][field] = value
            with self.subTest(positive=field), self.assertRaises((ValueError, KeyError)):
                host.verify_receipt(changed, identity)

    def test_checkout_boundary_refuses_without_native_fixture_or_bundle(self):
        result = subprocess.run([sys.executable, '-I', '-S', str(Path(host.__file__)), '--read'],
                                capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 78)
        self.assertEqual(result.stdout, b'')
        self.assertEqual(json.loads(result.stderr)['status'], 'NO')
        self.assertFalse(json.loads(result.stderr)['accepted'])


if __name__ == '__main__':
    unittest.main()

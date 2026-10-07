"""Boundary checks run no jj commands and make no host observations."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent))
import growth


class FollowupTests(unittest.TestCase):
    def test_cli_refuses_host_without_creating_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for script, args in [('snapshot.py', [str(root), str(root / 'snapshot'), '--busy-workers', '2']),
                                 ('prepare.py', ['http://127.0.0.1:1', '--store-only']),
                                 ('growth.py', [str(root), str(root / 'growth'), '--jj', '/missing']),
                                 ('kernel.py', [str(root), str(root / 'kernel.json')])]:
                result = subprocess.run([sys.executable, str(Path(__file__).with_name(script)), *args],
                                        capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('guest agent uid 19999', result.stderr)
            self.assertEqual(list(root.iterdir()), [])

    def test_privileged_probe_refuses_host_and_arguments_without_evidence(self):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('cgroup_probe.py')), 'override'],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('takes no arguments', result.stderr)
        self.assertEqual(result.stdout, '')

    def test_retention_budget_requires_complete_cycles_and_strict_limit(self):
        cycles = [{'captures': 5760, 'before_cleanup': {'.jj': n},
                   'after_cleanup': {'.jj': m}}
                  for n, m in [(1000, 500), (1200, 600), (1400, 650)]]
        self.assertEqual(growth.retention_budget(cycles)['projected_14_day_bytes'], 2800)
        cycles[2]['before_cleanup']['.jj'] = 2 * 1024 ** 3 - 1400
        self.assertFalse(growth.retention_budget(cycles)['growth_budget_passed'])
        for invalid in [cycles[:2], [dict(c, captures=1000) for c in cycles]]:
            with self.assertRaisesRegex(ValueError, 'complete daily cycles'):
                growth.retention_budget(invalid)

    def test_cleanup_retains_young_operations_and_at_least_one_hundred(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            ids = [f'{i + 1:0128x}' for i in range(105)]
            log = ''.join(f'{oid} {99999 if i < 102 else 1}\n'
                          for i, oid in enumerate(ids)).encode()
            calls = []
            def command(*args, **kwargs):
                calls.append((args, kwargs))
                return SimpleNamespace(stdout=log if args[:2] == ('op', 'log') else b'ok', stderr=b'')
            fixture = SimpleNamespace(command=command, verify=lambda: None)
            with patch.object(growth.time, 'time', return_value=100000):
                growth.cleanup(fixture, output, 1)
            self.assertEqual(calls[1][0], ('op', 'abandon', '..' + ids[101]))
            self.assertTrue(all(kwargs['ignore_working_copy'] for _, kwargs in calls))
            self.assertEqual((output / 'operations-1.log').read_bytes(), log)
            # Even when all operations are old, the newest 100 remain protected.
            log = ''.join(f'{oid} 1\n' for oid in ids).encode()
            calls.clear()
            with patch.object(growth.time, 'time', return_value=100000):
                growth.cleanup(fixture, output, 2)
            self.assertEqual(calls[1][0], ('op', 'abandon', '..' + ids[99]))

    def test_wait_never_sleeps_negative_and_chunks_long_waits(self):
        with patch.object(growth.time, 'monotonic', side_effect=[0, 45, 60]), \
             patch.object(growth.time, 'sleep') as sleep:
            growth.wait_until(60)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [30, 15])

    def test_storage_counts_non_colocated_git_once_and_does_not_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = root / '.jj/repo/store/git'
            store.mkdir(parents=True)
            (store / 'object').write_bytes(b'x' * 8192)
            (store / 'escape').symlink_to('/tmp')
            expected = (root / '.jj').stat().st_blocks * 512 + sum(
                p.lstat().st_blocks * 512 for p in (root / '.jj').rglob('*'))
            self.assertEqual(growth.sizes(root), {'.jj': expected, '.git': 0})

    def test_versions_writes_twelve_verified_blobs_and_parentless_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = root / '.jj/repo/store/git'
            subprocess.run(['git', 'init', '--bare', str(store)], check=True, capture_output=True)
            files = []
            for index in range(12):
                path = root / f'file-{index:03}.txt'
                path.write_bytes(f'first-{index}'.encode())
                files.append(path)
            elapsed, first = growth.versions(root, files)
            self.assertGreater(elapsed, 0)
            self.assertEqual(len(growth.git(root, 'ls-tree', first).splitlines()), 12)
            for path in files:
                self.assertEqual(growth.git(root, 'show', first + ':' + path.name), path.read_bytes())
                path.write_bytes(path.read_bytes() + b' changed')
            _, second = growth.versions(root, files)
            self.assertNotEqual(first, second)
            self.assertNotIn(b'parent ', growth.git(root, 'cat-file', '-p', second))
            self.assertEqual(growth.git(root, 'rev-parse', 'refs/smithers/versions/col11-spike').strip().decode(), second)
            self.assertEqual(growth.git(root, 'show', first + ':file-000.txt'), b'first-0')

    def test_versions_refuses_non_git_store(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'non-colocated'):
                growth.git(Path(directory), 'status')


if __name__ == '__main__':
    unittest.main()

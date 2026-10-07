"""Boundary checks run no jj commands and make no host observations."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import copy

sys.path.insert(0, str(Path(__file__).parent))
import growth


class FollowupTests(unittest.TestCase):
    def test_cli_refuses_host_without_creating_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for script, args in [('snapshot.py', [str(root), str(root / 'snapshot'), '--busy-workers', '2']),
                                 ('growth.py', [str(root), str(root / 'growth'), '--jj', '/missing']),
                                 ('growth.py', [str(root), str(root / 'retention'), '--jj', '/missing', '--daily-cycles']),
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

    def test_projection_uses_pinned_workload_and_strict_budget(self):
        self.assertEqual(growth.PROJECTED_CAPTURES, 80640)
        self.assertEqual(growth.projection({'.jj': 0, '.git': 0}, {'.jj': 1000, '.git': 0}), 80640)
        self.assertEqual(growth.projection({'.jj': 1000}, {'.jj': 0}), 0)
        self.assertEqual(growth.projection({'.jj': 0}, {'.jj': 1}), 81)

    def test_retention_bound_uses_post_cleanup_residue_not_reclaimed_garbage(self):
        cycles = [{'captures': 5760, 'start_epoch': i * 86400,
                   'end_epoch': i * 86400 + 28800,
                   'before': {'.jj': 900000, '.git': 0},
                   'after': {'.jj': 1000000, '.git': 0},
                   'after_gc': {'.jj': 1000 + i * 20, '.git': 0}} for i in range(3)]
        result = growth.retention_bound(cycles)
        self.assertEqual(result['projected_14_day_bytes'], 1000280)
        self.assertEqual(result['residue_bytes'], [20, 20])
        self.assertTrue(result['growth_budget_passed'])
        for cycle in cycles:
            cycle['after']['.jj'] = growth.LIMIT - 280
        self.assertFalse(growth.retention_bound(cycles)['growth_budget_passed'])
        for mutation in ['short', 'burst', 'early-day', 'negative', 'missing']:
            bad = copy.deepcopy(cycles)
            if mutation == 'short': bad[0]['captures'] = 5759
            if mutation == 'burst': bad[0]['end_epoch'] = 28799
            if mutation == 'early-day': bad[1]['start_epoch'] -= 1
            if mutation == 'negative': bad[0]['after']['.jj'] = -1
            if mutation == 'missing': bad.pop()
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                growth.retention_bound(bad)

    def test_daily_cleanup_preserves_young_operations_and_newest_hundred(self):
        # A command double is required: lane rules forbid invoking jj on this VM.
        # This tests argv and timestamp boundaries, not actual jj acceptance.
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            for young_count, expected in [(0, 99), (110, 109)]:
                commands = []
                operations = [(f'{i + 1:0128x}', 200000 if i < young_count else 100000)
                              for i in range(120)]
                inventory = ''.join(f'{oid}\t{epoch}\n' for oid, epoch in operations).encode()
                def command(*args, **kwargs):
                    commands.append(args)
                    return SimpleNamespace(stdout=inventory if args[:2] == ('op', 'log') else b'', stderr=b'')
                fixture = SimpleNamespace(command=command, verify=lambda: None)
                with patch.object(growth.time, 'time', return_value=200000):
                    growth.cleanup_daily(fixture, output, young_count)
                self.assertEqual(commands[1], ('op', 'abandon', '..' + operations[expected][0]))
                self.assertEqual(commands[2], ('util', 'gc', '--expire', 'now'))

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

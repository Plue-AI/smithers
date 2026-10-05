"""Boundary checks run no jj commands and make no host observations."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
import growth


class FollowupTests(unittest.TestCase):
    def test_cli_refuses_host_without_creating_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for script, args in [('growth.py', [str(root), str(root / 'growth'), '--jj', '/missing']),
                                 ('kernel.py', [str(root), str(root / 'kernel.json')])]:
                result = subprocess.run([sys.executable, str(Path(__file__).with_name(script)), *args],
                                        capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('guest agent uid 19999', result.stderr)
            self.assertEqual(list(root.iterdir()), [])

    def test_projection_uses_pinned_workload_and_strict_budget(self):
        self.assertEqual(growth.PROJECTED_CAPTURES, 80640)
        self.assertEqual(growth.projection({'.jj': 0, '.git': 0}, {'.jj': 1000, '.git': 0}), 80640)
        self.assertEqual(growth.projection({'.jj': 1000}, {'.jj': 0}), 0)
        self.assertEqual(growth.projection({'.jj': 0}, {'.jj': 1}), 81)

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

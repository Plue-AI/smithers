# Oracles: T-COL-01 Scope In / Tests: changed-file cells 0, 1, 12, 200; ignored dependencies; no untimed snapshot of pending edits.
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


source = Path(__file__).with_name("snapshot.py")
spec = importlib.util.spec_from_file_location("col01_snapshot", source)
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class SummaryTests(unittest.TestCase):
    def test_nearest_rank_and_no_input_mutation(self):
        values = list(range(100, 0, -1))
        before = values.copy()
        self.assertEqual(driver.summary(values), {
            "n": 100, "min_ns": 1, "max_ns": 100,
            "p50_ns": 50, "p95_ns": 95, "p99_ns": 99,
        })
        self.assertEqual(values, before)
        self.assertEqual(driver.summary([7])["p99_ns"], 7)
        self.assertEqual(driver.summary([9, 1])["p50_ns"], 1)
        self.assertEqual(driver.summary(list(range(1, 102)))["p95_ns"], 96)

    def test_invalid_samples_fail(self):
        for values in [[], [0], [-1], [True], [1.5], [1, 0, 2]]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                driver.summary(values)


class RealRepositoryTests(unittest.TestCase):
    def setUp(self):
        self.jj = shutil.which("jj")
        self.assertIsNotNone(self.jj, "real jj executable is required")
        self.temp = tempfile.TemporaryDirectory(prefix="col01-jj-tests-")
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / "repo"
        subprocess.run([self.jj, "git", "init", "--no-colocate", str(self.repo)], check=True, capture_output=True)
        (self.repo / ".gitignore").write_text("node_modules/\n")
        (self.repo / "node_modules").mkdir()
        (self.repo / "node_modules" / "dependency.js").write_text("ignored dependency\n")
        self.fixture = driver.Repository(self.repo, self.jj)
        self.fixture.initialize()

    def test_zero_one_twelve_and_two_hundred_file_snapshots_are_verified(self):
        for count in [0, 1, 12, 200]:
            with self.subTest(changed_files=count):
                before = [path.read_bytes() for path in self.fixture.files]
                self.fixture.prepare(count)
                after = [path.read_bytes() for path in self.fixture.files]
                self.assertEqual(sum(a != b for a, b in zip(before, after)), count)
                elapsed = self.fixture.snapshot()
                self.assertGreater(elapsed, 0)
                self.fixture.verify()
                shown = self.fixture.command("file", "list", ignore_working_copy=True).stdout.decode()
                self.assertNotIn("node_modules", shown)

    def test_verification_does_not_implicitly_snapshot_unprepared_changes(self):
        original = self.fixture.files[0].read_bytes()
        self.fixture.files[0].write_bytes(b"unsnapshotted change\n")
        self.fixture.verify()
        self.fixture.files[0].write_bytes(original)

    def test_preparation_rejects_outside_changes_and_invalid_counts(self):
        for count in [-1, 201, True, 1.5]:
            with self.subTest(count=count), self.assertRaises(ValueError):
                self.fixture.prepare(count)
        self.fixture.files[5].write_text("unexpected external edit")
        with self.assertRaises(ValueError):
            self.fixture.prepare(1)

    def test_fails_if_dependencies_are_tracked(self):
        (self.repo / ".gitignore").write_text("")
        self.fixture.snapshot()
        with self.assertRaises(ValueError):
            self.fixture.verify()

    def test_fixture_collision_fails_without_overwrite(self):
        sentinel = self.fixture.files[0].read_bytes()
        with self.assertRaises(FileExistsError):
            driver.Repository(self.repo, self.jj).initialize()
        self.assertEqual(self.fixture.files[0].read_bytes(), sentinel)

    def test_real_busy_workers_run_and_are_reaped_even_on_error(self):
        workers = driver.Busy(2)
        with self.assertRaisesRegex(RuntimeError, "test failure"):
            with workers:
                self.assertEqual(len(workers.processes), 2)
                self.assertTrue(all(p.poll() is None for p in workers.processes))
                self.fixture.prepare(12)
                self.assertGreater(self.fixture.snapshot(), 0)
                self.fixture.verify()
                raise RuntimeError("test failure")
        self.assertTrue(all(p.poll() is not None for p in workers.processes))


if __name__ == "__main__":
    unittest.main()

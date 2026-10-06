import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("probe", HERE / "probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.entries = json.loads((HERE / "manifest.example.json").read_text())

    def samples(self, ambiguous=0):
        return [{"at": index * 1.5,
                 "cpu": {"vscode": index * 30, "formatter": index * 100,
                         "idle-node": min(index, ambiguous)}} for index in range(41)]

    def test_same_person_two_sessions_is_one_candidate(self):
        result = probe.summarize(self.entries, self.samples())
        self.assertEqual(result["ambiguous_windows"], 0)
        self.assertEqual(result["windows"][0]["participants"], ["maya"])
        self.assertEqual(result["windows"][0]["cpu_delta_usec"],
                         {"vscode": 30, "formatter": 100, "idle-node": 0})

    def test_strict_ten_percent_boundary(self):
        for count, decision in [(4, "participant-aggregation-sufficient-for-this-workload"),
                                (5, "kernel-attribution-required-at-launch"),
                                (40, "kernel-attribution-required-at-launch")]:
            result = probe.summarize(self.entries, self.samples(count))
            self.assertEqual(result["ambiguous_windows"], count)
            self.assertEqual(result["decision"], decision)
            self.assertEqual(result["window_count"], 40)

    def test_incomplete_reset_inactive_and_delayed_samples_refuse(self):
        cases = [self.samples()[:40]]
        for field, value in [("formatter", 0), ("vscode", -1)]:
            samples = self.samples()
            samples[1]["cpu"][field] = value
            cases.append(samples)
        for at in [1.4, 1.7]:
            samples = self.samples()
            samples[1]["at"] = at
            cases.append(samples)
        for samples in cases:
            with self.assertRaises(ValueError):
                probe.summarize(self.entries, samples)

    def test_roster_and_cgroup_contract(self):
        cases = [self.entries[:2]]
        for index, key, value in [(1, "cgroup", self.entries[0]["cgroup"]),
                                  (1, "cgroup", self.entries[0]["cgroup"] + "/child"),
                                  (1, "uid", 20001), (1, "participant", "ben"),
                                  (2, "uid", 20000), (2, "participant", "maya"),
                                  (0, "uid", 0)]:
            entries = copy.deepcopy(self.entries)
            entries[index][key] = value
            cases.append(entries)
        for entries in cases:
            with self.assertRaises(ValueError):
                probe.validate(entries)

    def test_usage_parser(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "cpu.stat")
            path.write_text("user_usec 12\nusage_usec 42\nsystem_usec 30\n")
            self.assertEqual(probe.usage(path), 42)
            for text in ["", "usage_usec -1\n", "usage_usec x\n",
                         "usage_usec 1\nusage_usec 2\n"]:
                path.write_text(text)
                with self.assertRaises(ValueError):
                    probe.usage(path)

    def test_real_cli_refuses_fake_cgroups_and_preserves_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory, "manifest.json")
            entries = copy.deepcopy(self.entries)
            for entry in entries:
                entry["cgroup"] = str(Path(directory, entry["role"]))
            manifest.write_text(json.dumps(entries))
            output = Path(directory, "receipt.json")
            run = subprocess.run([sys.executable, "-B", str(HERE / "probe.py"), str(manifest), str(output)], capture_output=True)
            self.assertEqual(run.returncode, 78, run.stderr)
            receipt = json.loads(output.read_text())
            self.assertEqual(receipt["status"], "pending")
            self.assertIsNone(receipt["decision"])
            self.assertEqual(receipt["manifest"], entries)
            original = output.read_bytes()
            rerun = subprocess.run([sys.executable, "-B", str(HERE / "probe.py"), str(manifest), str(output)], capture_output=True)
            self.assertNotEqual(rerun.returncode, 0)
            self.assertEqual(output.read_bytes(), original)

    def test_collect_reads_process_identity_each_window(self):
        with patch.object(probe.platform, "system", return_value="Linux"), \
             patch.object(probe.os, "geteuid", return_value=1001), \
             patch.object(probe, "inspect", return_value=[{"pid": 1}]) as inspect, \
             patch.object(probe, "usage", side_effect=range(123)), \
             patch.object(probe.time, "sleep") as sleep, \
             patch.object(probe.time, "monotonic", side_effect=[i * 1.5 for i in range(41)]):
            samples = probe.collect(self.entries, 40)
        self.assertEqual(inspect.call_count, 123)
        self.assertEqual(sleep.call_count, 40)
        self.assertEqual(samples[-1]["cpu"]["formatter"], 121)
        self.assertEqual(probe.summarize(self.entries, samples)["ambiguous_windows"], 40)

    def test_partial_samples_survive_read_failure(self):
        samples = []
        with patch.object(probe.platform, "system", return_value="Linux"), \
             patch.object(probe.os, "geteuid", return_value=1001), \
             patch.object(probe, "inspect", side_effect=[[{"pid": 1}]] * 3 + [PermissionError("denied")]), \
             patch.object(probe, "usage", return_value=10), \
             patch.object(probe.time, "sleep"):
            with self.assertRaises(PermissionError):
                probe.collect(self.entries, 40, samples)
        self.assertEqual(len(samples), 1)
        self.assertEqual(samples[0]["cpu"]["formatter"], 10)

    def test_real_proc_and_cgroup_identity(self):
        if probe.platform.system() != "Linux":
            self.skipTest("Linux cgroup v2 only")
        own = Path("/proc/self/cgroup").read_text().strip().split("::", 1)[1]
        cgroup = Path("/sys/fs/cgroup") / own.lstrip("/")
        entry = {"cgroup": str(cgroup), "uid": probe.os.getuid(), "role": "observer"}
        processes = probe.inspect(entry)
        self.assertIn(probe.os.getpid(), [p["pid"] for p in processes])
        self.assertTrue(all(p["argv"] and p["exe"] for p in processes))
        self.assertGreaterEqual(probe.usage(cgroup / "cpu.stat"), 0)
        entry["uid"] += 1
        with self.assertRaisesRegex(ValueError, "unexpected uid"):
            probe.inspect(entry)

    def test_no_root_execution_or_short_run(self):
        for uid, count in [(0, 40), (1001, 39)]:
            with patch.object(probe.platform, "system", return_value="Linux"), \
                 patch.object(probe.os, "geteuid", return_value=uid):
                with self.assertRaises(ValueError):
                    probe.collect(self.entries, count)


if __name__ == "__main__":
    unittest.main()

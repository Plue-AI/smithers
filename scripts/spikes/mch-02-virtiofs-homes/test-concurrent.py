#!/usr/bin/env python3
"""Synthetic filesystem evidence tests; these do not measure microVM behavior."""
import copy
import importlib.util
import json
import pathlib
import shutil
import tempfile
import unittest


PATHS = (".claude", ".config/gh", ".npm/_cacache")


def record(vm, seq):
    return dict(vm=vm, seq=seq, payload=f"{vm}:{seq:06d}:" + "x" * 128)


def workers():
    return [dict(vm=vm, completed=True, iterations=1000, errors=[], sqlite={},
                 observations=[dict(path=path, peer_seq=seq, elapsed_ms=1)
                               for seq in (None, 1, 1, 10, 1000) for path in PATHS])
            for vm in ("1", "2")]


class ConcurrentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location(
            "mch02_concurrent", pathlib.Path(__file__).with_name("concurrent.py"))
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = pathlib.Path(self.tmp.name)
        self.workers = workers()
        self.rows = [record(vm, seq) for seq in range(1, 1001) for vm in ("1", "2")]
        for path in PATHS:
            directory = self.home / path
            (directory / "records").mkdir(parents=True)
            for row in self.rows:
                self.file(path, row["vm"], row["seq"]).write_text(json.dumps(row))
            self.append(path, self.rows)
            (directory / "shared.json").write_text(json.dumps(record("2", 1000)))

    def file(self, path, vm, seq):
        return self.home / path / "records" / f"{vm}-{seq}.json"

    def append(self, path, rows):
        (self.home / path / "append.jsonl").write_text(
            "".join(json.dumps(row) + "\n" for row in rows))

    def summarize(self):
        return self.module.summarize(self.home, self.workers)

    def test_complete_interleaved_evidence(self):
        original = copy.deepcopy(self.workers)
        result = self.summarize()
        self.assertEqual(result["workers"], original)
        self.assertEqual(self.workers, original)
        self.assertIs(result["workers_completed"], True)
        self.assertEqual(result["worker_errors"], 0)
        self.assertEqual(set(result["directories"]), set(PATHS))
        expected = dict(expected=2000, present=2000, missing=0, corrupted=0,
                        append_present=2000, append_missing=0, append_corrupted=0,
                        append_per_vm_ordered=True, observations_per_vm_ordered=True,
                        shared_valid=True)
        for path in PATHS:
            for key, value in expected.items():
                self.assertEqual(result["directories"][path][key], value, f"{path}: {key}")

    def test_missing_record_and_directory(self):
        self.file(PATHS[0], "1", 1).unlink()
        shutil.rmtree(self.home / PATHS[1])
        result = self.summarize()["directories"]
        self.assertEqual((result[PATHS[0]]["present"], result[PATHS[0]]["missing"],
                          result[PATHS[0]]["corrupted"]), (1999, 1, 0))
        empty = result[PATHS[1]]
        for field in ("present", "corrupted", "append_present", "append_corrupted"):
            self.assertEqual(empty[field], 0)
        self.assertEqual(empty["missing"], 2000)
        self.assertEqual(empty["append_missing"], 2000)
        self.assertIs(empty["shared_valid"], False)
        self.assertEqual(result[PATHS[2]]["present"], 2000)

    def test_record_validation_and_filename_identity(self):
        path = PATHS[0]
        invalid = ["{", "null", "[]", json.dumps(record("3", 1)),
                   json.dumps(record("1", 0)), json.dumps(record("1", 1001)),
                   json.dumps(dict(vm="1", seq=True, payload=record("1", 1)["payload"])),
                   json.dumps(dict(vm="1", seq=8, payload="short")),
                   json.dumps(record("2", 9))]
        for seq, value in enumerate(invalid, 1):
            self.file(path, "1", seq).write_text(value)
        self.file(path, "1", 1001).write_text(json.dumps(record("1", 1001)))
        (self.home / path / "records" / "duplicate.json").write_text(json.dumps(record("2", 1)))
        result = self.summarize()["directories"][path]
        self.assertEqual(result["present"], 1991)
        self.assertEqual(result["missing"], 9)
        self.assertEqual(result["corrupted"], 11)
        self.assertEqual(result["append_present"], 2000)

    def test_append_missing_duplicate_invalid_and_truncated_rows(self):
        path = PATHS[0]
        rows = self.rows[1:] + [self.rows[-1], record("1", 0), record("2", 1001),
                               record("3", 1), dict(vm="1", seq=1, payload="wrong"), None]
        self.append(path, rows)
        with (self.home / path / "append.jsonl").open("a") as stream:
            stream.write('{"vm":"1","seq":')
        result = self.summarize()["directories"][path]
        self.assertEqual(result["append_present"], 1999)
        self.assertEqual(result["append_missing"], 1)
        self.assertEqual(result["append_corrupted"], 7)
        self.assertEqual(result["present"], 2000)

    def test_append_order_regression_for_either_vm(self):
        for vm in ("1", "2"):
            with self.subTest(vm=vm):
                rows = copy.deepcopy(self.rows)
                indices = [i for i, row in enumerate(rows) if row["vm"] == vm][:2]
                rows[indices[0]], rows[indices[1]] = rows[indices[1]], rows[indices[0]]
                self.append(PATHS[0], rows)
                result = self.summarize()["directories"][PATHS[0]]
                self.assertIs(result["append_per_vm_ordered"], False)
                self.assertEqual(result["append_present"], 2000)
                self.assertEqual(result["append_corrupted"], 0)

    def test_invalid_utf8_append_is_reported_as_corrupt_evidence(self):
        with (self.home / PATHS[0] / "append.jsonl").open("ab") as stream:
            stream.write(b"\xff\n")
        result = self.summarize()["directories"][PATHS[0]]
        self.assertEqual(result["append_present"], 2000)
        self.assertEqual(result["append_missing"], 0)
        self.assertEqual(result["append_corrupted"], 1)

    def test_missing_append_and_shared_snapshot(self):
        path = PATHS[0]
        (self.home / path / "append.jsonl").unlink()
        (self.home / path / "shared.json").unlink()
        result = self.summarize()["directories"][path]
        self.assertEqual(result["append_present"], 0)
        self.assertEqual(result["append_missing"], 2000)
        self.assertEqual(result["append_corrupted"], 0)
        self.assertIs(result["shared_valid"], False)

    def test_shared_snapshot_requires_valid_complete_record(self):
        shared = self.home / PATHS[0] / "shared.json"
        values = ["{", "null", json.dumps(record("3", 1)), json.dumps(record("1", 0)),
                  json.dumps(dict(vm="1", seq=1000, payload="torn"))]
        for value in values:
            with self.subTest(value=value):
                shared.write_text(value)
                self.assertIs(self.summarize()["directories"][PATHS[0]]["shared_valid"], False)
        shared.write_text(json.dumps(record("1", 999)))
        self.assertIs(self.summarize()["directories"][PATHS[0]]["shared_valid"], True)

    def test_peer_observation_regression_and_invalid_sequence(self):
        for vm in ("1", "2"):
            for bad in (0, 1001, True, "2", -1):
                with self.subTest(vm=vm, bad=bad):
                    self.workers = workers()
                    worker = next(row for row in self.workers if row["vm"] == vm)
                    worker["observations"].append(dict(path=PATHS[0], peer_seq=bad, elapsed_ms=1))
                    result = self.summarize()["directories"]
                    self.assertIs(result[PATHS[0]]["observations_per_vm_ordered"], False)
                    self.assertIs(result[PATHS[1]]["observations_per_vm_ordered"], True)
        self.workers = workers()
        self.workers[0]["observations"].append(dict(path=PATHS[0], peer_seq=999, elapsed_ms=1))
        self.assertIs(self.summarize()["directories"][PATHS[0]]["observations_per_vm_ordered"], False)

    def test_partial_failed_missing_and_duplicate_workers(self):
        cases = [[], workers()[:1], [workers()[0], copy.deepcopy(workers()[0])]]
        for key, value in (("completed", False), ("iterations", 999), ("iterations", 1001),
                           ("vm", "3"), ("errors", ["write failed", "read failed"])):
            rows = workers()
            rows[0][key] = value
            cases.append(rows)
        for rows in cases:
            with self.subTest(rows=rows):
                self.workers = rows
                result = self.summarize()
                self.assertIs(result["workers_completed"], False)
                self.assertEqual(result["worker_errors"], sum(len(row["errors"]) for row in rows))
                self.assertEqual(result["workers"], rows)

    def test_peer_identity_payload_and_read_failures(self):
        faults = [dict(peer_seq=None, read_error="EIO"),
                  dict(peer_seq=None, read_error="Unexpected end of JSON input"),
                  dict(peer_seq=None, peer_vm="2", peer_valid=False, read_error=None),
                  dict(peer_seq=1, peer_vm="1", peer_valid=True),
                  dict(peer_seq=1, peer_vm="3", peer_valid=True),
                  dict(peer_seq=1, peer_vm="2", peer_valid=False),
                  dict(peer_seq=1, peer_vm="2", peer_valid="true")]
        for fault in faults:
            with self.subTest(fault=fault):
                self.workers = workers()
                self.workers[0]["observations"].insert(0, dict(path=PATHS[0], elapsed_ms=1, **fault))
                result = self.summarize()["directories"]
                self.assertIs(result[PATHS[0]]["observations_per_vm_ordered"], False)
                self.assertIs(result[PATHS[1]]["observations_per_vm_ordered"], True)

    def test_startup_missing_peer_is_allowed_but_disappearance_is_rejected(self):
        for worker in self.workers:
            for obs in worker["observations"]:
                visible = obs["peer_seq"] is not None
                obs.update(peer_vm=("2" if worker["vm"] == "1" else "1") if visible else None,
                           peer_valid=True if visible else None, read_error=None if visible else "ENOENT")
        self.workers[0]["observations"].insert(0, dict(
            path=PATHS[0], peer_seq=None, read_error="ENOENT", elapsed_ms=1))
        self.assertIs(self.summarize()["directories"][PATHS[0]]["observations_per_vm_ordered"], True)
        self.workers[0]["observations"].append(dict(
            path=PATHS[0], peer_seq=None, read_error="ENOENT", elapsed_ms=1))
        self.assertIs(self.summarize()["directories"][PATHS[0]]["observations_per_vm_ordered"], False)


def atomic_evidence():
    return dict(workers=[dict(vm=vm, uid=20001, gid=20001, completed=True,
                             iterations=1000, errors=[], shared_reads=[
                                 dict(observed=record(vm, seq), error=None) for seq in range(1, 1001)])
                         for vm in ("1", "2")],
                host=dict(present=2000, missing=0, corrupted=0, final=record("2", 1000)),
                guests=[dict(vm=vm, present=2000, missing=0, corrupted=0, final=record("2", 1000),
                             final_reads=[dict(observed=record("2", 999), error=None),
                                          dict(observed=record("2", 1000), error=None)])
                        for vm in ("1", "2")])


class AtomicTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location(
            "mch02_atomic", pathlib.Path(__file__).with_name("concurrent.py"))
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def test_accepts_complete_atomic_evidence_for_either_final_writer(self):
        for vm in ("1", "2"):
            data = atomic_evidence()
            for view in [data["host"], *data["guests"]]:
                view["final"] = record(vm, 1000)
            for guest in data["guests"]:
                guest["final_reads"][-1]["observed"] = record(vm, 1000)
            self.assertIs(self.module.atomic_pass(data), True)

    def test_rejects_incomplete_atomic_evidence_and_any_invalid_shared_read(self):
        cases = []
        for field in ("workers", "guests"):
            for fault in ("missing", "duplicate"):
                data = atomic_evidence()
                data[field] = data[field][:1] if fault == "missing" else [data[field][0], copy.deepcopy(data[field][0])]
                cases.append((f"{field}-{fault}", data))
        for key, value in (("uid", 0), ("gid", 0), ("completed", False), ("iterations", 999),
                           ("iterations", 1000.0), ("errors", ["write failed"])):
            data = atomic_evidence()
            data["workers"][0][key] = value
            cases.append((f"worker-{key}-{value}", data))
        for count in (999, 1001):
            data = atomic_evidence()
            reads = data["workers"][0]["shared_reads"]
            data["workers"][0]["shared_reads"] = reads[:count] if count == 999 else reads + [copy.deepcopy(reads[-1])]
            cases.append((f"shared_reads-{count}", data))
        invalid_reads = [dict(observed=None, error="ENOENT"), dict(observed=None, error="EIO"), dict(observed=record("1", 1), error="EIO"),
                         dict(observed='{"vm":', error=None), dict(observed={}, error=None),
                         dict(observed=record("3", 1), error=None),
                         dict(observed=dict(vm="1", seq=1, payload="torn"), error=None)]
        for index, invalid in enumerate(invalid_reads):
            for field in ("shared_reads", "final_reads"):
                data = atomic_evidence()
                owner = data["workers"][0] if field == "shared_reads" else data["guests"][0]
                owner[field][0] = invalid
                cases.append((f"{field}-invalid-{index}", data))
        for vm in (0, 1):
            data = atomic_evidence()
            del data["guests"][vm]["final_reads"]
            cases.append((f"guest{vm+1}-missing-final_reads", data))
            data = atomic_evidence()
            data["guests"][vm]["final"] = record("1", 1000)
            data["guests"][vm]["final_reads"][-1]["observed"] = record("1", 1000)
            cases.append((f"guest{vm+1}-inconsistent-final-writer", data))
        data = atomic_evidence()
        data["host"]["final"] = record("1", 1000)
        cases.append(("host-inconsistent-final-writer", data))
        data = atomic_evidence()
        data["guests"][0]["sha_mismatches"] = ["vm1-1"]
        cases.append(("guest-sha-mismatch", data))
        data = atomic_evidence()
        data["guests"][0]["final_reads"] = []
        cases.append(("empty-final_reads", data))
        for view in ("host", "guest1", "guest2"):
            for key, value in (("present", 1999), ("missing", 1), ("corrupted", 1),
                               ("final", record("2", 999)), ("final", record("3", 1000)),
                               ("final", dict(vm="2", seq=1000, payload="torn"))):
                data = atomic_evidence()
                target = data["host"] if view == "host" else data["guests"][int(view[-1]) - 1]
                target[key] = value
                cases.append((f"{view}-{key}-{value}", data))
        for fault, data in cases:
            with self.subTest(fault=fault):
                self.assertIs(self.module.atomic_pass(data), False)


    def test_atomic_rejects_malformed_evidence_without_raising(self):
        malformed = [None, [], "not a report", {}, dict(workers=None),
                     dict(workers=[None]), dict(workers="12", guests="12")]
        for key in ("workers", "guests", "host"):
            data = atomic_evidence()
            data[key] = None
            malformed.append(data)
        for value in malformed:
            with self.subTest(value_type=type(value).__name__):
                self.assertIs(self.module.atomic_pass(value), False)


class LifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location(
            "mch02_lifecycle", pathlib.Path(__file__).with_name("concurrent.py"))
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def test_extension_requires_completed_clean_lifecycle_and_step6(self):
        report = dict(completed=True, errors=[], unremoved_vms=[], atomic=atomic_evidence())
        self.assertIs(self.module.extension_pass(report), True)
        for key, value in (("completed", False), ("errors", ["worker failed"]),
                           ("unremoved_vms", ["owned-vm"]), ("atomic", {})):
            with self.subTest(key=key):
                damaged = copy.deepcopy(report)
                damaged[key] = value
                self.assertIs(self.module.extension_pass(damaged), False)
        for key in ("completed", "errors", "unremoved_vms", "atomic"):
            with self.subTest(missing=key):
                damaged = copy.deepcopy(report)
                del damaged[key]
                self.assertIs(self.module.extension_pass(damaged), False)
        damaged = copy.deepcopy(report)
        damaged["atomic"]["workers"][0]["shared_reads"][0] = dict(observed=None, error="ENOENT")
        damaged["atomic"]["passed"] = True
        self.assertIs(self.module.extension_pass(damaged), False)
        for malformed in (None, [], "not a report"):
            self.assertIs(self.module.extension_pass(malformed), False)

    def test_lock_exclusion_requires_controlled_live_holder(self):
        for held_during in (False, True):
            for held_code in (0, 1, 2):
                for control_code in (0, 1, 2):
                    for tried_code in (0, 1, 2):
                        with self.subTest(held_during=held_during, held=held_code,
                                          control=control_code, tried=tried_code):
                            held = dict(command="holder", exit_code=held_code)
                            tried = dict(command="contender", exit_code=tried_code)
                            control = dict(command="same-vm control", exit_code=control_code)
                            result = self.module.lock_result(PATHS[0], "vm1", "vm2", held,
                                                             tried, control, held_during)
                            controlled = held_during and held_code == 0 and control_code == 1
                            self.assertIs(result["controlled"], controlled)
                            self.assertIs(result["exclusion"], controlled and tried_code == 1)
                            self.assertEqual(result["path"], PATHS[0])
                            self.assertEqual((result["holder"], result["contender"]), ("vm1", "vm2"))
                            self.assertEqual(result["holder_receipt"], held)
                            self.assertEqual(result["contender_receipt"], tried)
                            self.assertEqual(result["same_vm_receipt"], control)
                            self.assertIs(result["held_during_attempt"], held_during)

    def test_lock_control_receipts_cannot_be_missing(self):
        receipt = dict(command="flock", exit_code=0)
        blocked = dict(command="flock -n", exit_code=1)
        for field in ("held", "control", "tried"):
            values = dict(held=receipt, control=blocked, tried=blocked)
            values[field] = {}
            result = self.module.lock_result(PATHS[0], "vm1", "vm2", values["held"],
                                             values["tried"], values["control"], True)
            with self.subTest(field=field):
                self.assertIs(result["exclusion"], False)
                if field != "tried": self.assertIs(result["controlled"], False)


if __name__ == "__main__":
    unittest.main()

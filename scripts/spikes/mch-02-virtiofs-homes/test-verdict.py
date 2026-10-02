#!/usr/bin/env python3
"""Synthetic evidence tests; these do not execute or claim microVM measurements."""
import copy
import json
import importlib.util
import pathlib
import subprocess
import sys
import tempfile
import unittest


def evidence(layout="B"):
    steps = []
    for member, uid, other in (("ben", 20001, 20002), ("alice", 20002, 20001)):
        if layout == "A":
            steps.append(dict(phase="initial", kind="chown", member=member, exit_code=0))
        steps.append(dict(phase="initial", kind="chmod", member=member, exit_code=0))
        steps.append(dict(phase="initial", kind="write", member=member, actor_uid=uid,
                          exit_code=0, data=dict(uid=uid, gid=uid, errno=None)))
        for phase in ("initial", "reboot", "second_vm"):
            steps.append(dict(phase=phase, kind="stat", member=member, exit_code=0,
                              data=dict(uid=uid, gid=uid, mode="700")))
            for actor in (uid, other, 19999):
                steps.append(dict(phase=phase, kind="read", member=member, actor_uid=actor,
                                  exit_code=0 if actor == uid else 1,
                                  data=dict(uid=actor, gid=actor,
                                            errno=None if actor == uid else "EACCES",
                                            value="login-" + member if actor == uid else None)))
    return dict(completed=True, errors=[], unremoved_vms=[], host_uid=501, layouts={layout: dict(
        steps=steps,
        samples=[dict(seq=i, expected=f"mch02-{i}", observed=f"mch02-{i}",
                      write_exit_code=0, read_exit_code=0, delay_ms=1000) for i in range(1, 101)],
        host=[dict(path=p, uid=501, gid=20, mode="700") for p in (".", "ben", "alice")]
             + [dict(path="ben/.config/tool/login.json", uid=501, gid=20, mode="644")],
        boot_mounts_required=layout == "B",
        boot_mount_note="Every member needs a mount at VM boot." if layout == "B" else "")})


def atomic_evidence():
    def record(vm, seq):
        return dict(vm=vm, seq=seq, payload=f"{vm}:{seq:06d}:" + "x" * 128)

    return dict(workers=[dict(vm=vm, uid=20001, gid=20001, completed=True,
                             iterations=1000, errors=[], shared_reads=[
                                 dict(observed=record(vm, seq), error=None) for seq in range(1, 1001)])
                         for vm in ("1", "2")],
                host=dict(present=2000, missing=0, corrupted=0, final=record("2", 1000)),
                guests=[dict(vm=vm, present=2000, missing=0, corrupted=0, final=record("2", 1000),
                             final_reads=[dict(observed=record("2", 1000), error=None)])
                        for vm in ("1", "2")])


def full_evidence():
    report = evidence()
    report["layouts"]["B"]["hot_add"] = dict(
        attempt=dict(command="msb exec vm -- mount -t virtiofs member /home/member", exit_code=1),
        guest_after=dict(command="msb exec vm -- cat /proc/mounts", exit_code=0))
    report["concurrent"] = dict(completed=True, errors=[], unremoved_vms=[], atomic=atomic_evidence())
    return report


class VerdictTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location(
            "mch02_verdict", pathlib.Path(__file__).with_name("verdict.py"))
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def check(self, report, passed):
        verdict = self.module.evaluate_matrix(report)
        self.assertIs(verdict["passed"], passed)
        return verdict

    def cli(self, report, passed):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "results.json"
            path.write_text(json.dumps(report))
            result = subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name("verdict.py")),
                                     str(path)], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0 if passed else 1, result.stderr or result.stdout)
        verdict = json.loads(result.stdout)
        self.assertIs(verdict["passed"], passed)
        return verdict

    def test_accepts_complete_evidence_and_protected_interior(self):
        for layout in ("A", "B"):
            with self.subTest(layout=layout):
                result = self.check(evidence(layout), layout == "B")
                self.assertIs(result["layouts"][layout]["passed"], True)
                self.assertEqual(result["layouts"][layout]["p95_ms"], 1000)

    def test_rejects_missing_or_incorrect_permission_evidence(self):
        for phase in ("initial", "reboot", "second_vm"):
            for member in ("ben", "alice"):
                for kind in ("stat", "read"):
                    for fault in ("missing", "failed", "wrong_uid", "wrong_gid", "wrong_value"):
                        with self.subTest(phase=phase, member=member, kind=kind, fault=fault):
                            report = evidence("B")
                            steps = report["layouts"]["B"]["steps"]
                            row = next(s for s in steps if s["phase"] == phase and
                                       s["member"] == member and s["kind"] == kind and s["exit_code"] == 0)
                            if fault == "missing": steps.remove(row)
                            elif fault == "failed": row["exit_code"] = 1
                            elif fault in ("wrong_uid", "wrong_gid"): row["data"][fault[6:]] = 0
                            else: row["data"]["mode" if kind == "stat" else "value"] = "755"
                            self.check(report, False)
                for actor in (20002 if member == "ben" else 20001, 19999):
                    for fault in ("missing", "allowed", "ENOENT", "wrong_actor"):
                        with self.subTest(phase=phase, member=member, actor=actor, fault=fault):
                            report = evidence("B")
                            steps = report["layouts"]["B"]["steps"]
                            row = next(s for s in steps if s["phase"] == phase and
                                       s["member"] == member and s["kind"] == "read" and s["actor_uid"] == actor)
                            if fault == "missing": steps.remove(row)
                            elif fault == "allowed": row["exit_code"] = 0
                            elif fault == "ENOENT": row["data"]["errno"] = "ENOENT"
                            else: row["data"]["uid"] = row["data"]["gid"] = 0
                            self.check(report, False)

    def test_rejects_incomplete_commands_host_or_samples(self):
        for fault in ("incomplete", "chmod", "write", "write_actor", "host_missing",
                      "host_uid", "host_mode", "99", "101", "duplicate", "duplicate_expected", "stale", "empty_expected",
                      "write_failure", "read_failure", "negative", "nan", "infinity", "p95"):
            with self.subTest(fault=fault):
                report = evidence()
                data = report["layouts"]["B"]
                if fault == "incomplete": report["completed"] = False
                elif fault in ("chmod", "write", "write_actor"):
                    row = next(s for s in data["steps"] if s["kind"] == ("write" if fault == "write_actor" else fault))
                    if fault == "write_actor": row["data"]["uid"] = 0
                    else: row["exit_code"] = 1
                elif fault == "host_missing": data["host"].pop(1)
                elif fault == "host_uid": data["host"][0]["uid"] = 0
                elif fault == "host_mode": data["host"][1]["mode"] = "755"
                elif fault == "99": data["samples"].pop()
                elif fault == "101": data["samples"].append(copy.deepcopy(data["samples"][-1]))
                elif fault == "duplicate": data["samples"][-1] = copy.deepcopy(data["samples"][0])
                elif fault == "duplicate_expected": data["samples"][-1].update(expected="mch02-1", observed="mch02-1")
                elif fault == "stale": data["samples"][0]["observed"] = "previous"
                elif fault == "empty_expected": data["samples"][0].update(expected="", observed="")
                elif fault in ("write_failure", "read_failure"): data["samples"][0][fault.split("_")[0] + "_exit_code"] = 1
                elif fault == "p95":
                    for sample in data["samples"][-6:]: sample["delay_ms"] = 1000.001
                else: data["samples"][0]["delay_ms"] = {"negative": -1, "nan": float("nan"), "infinity": float("inf")}[fault]
                self.check(report, False)

    def test_nearest_rank_p95_allows_five_slow_fresh_samples(self):
        report = evidence()
        for sample in report["layouts"]["B"]["samples"][-5:]: sample["delay_ms"] = 1200
        self.check(report, True)

    def test_requires_actual_host_owner_identity(self):
        report = evidence()
        report.pop("host_uid")
        for entry in report["layouts"]["B"]["host"]: entry.pop("uid")
        self.check(report, False)

    def test_b_requires_mount_caveat_and_a_failure_can_select_b(self):
        for field in ("boot_mounts_required", "boot_mount_note"):
            report = evidence("B")
            report["layouts"]["B"].pop(field)
            self.check(report, False)
        report = evidence("B")
        report["layouts"]["B"]["boot_mount_note"] = "No mount needed."
        self.check(report, False)
        report = evidence("A")
        report["layouts"].update(evidence("B")["layouts"])
        report["layouts"]["A"]["steps"][0]["exit_code"] = 1
        result = self.check(report, True)
        self.assertIs(result["layouts"]["A"]["passed"], False)
        self.assertIs(result["layouts"]["B"]["passed"], True)


    def test_a_retains_permission_diagnostics_but_cannot_select_layout(self):
        report = evidence("A")
        verdict = self.check(report, False)
        self.assertIs(verdict["layouts"]["A"]["passed"], True)
        for kind in ("chown", "chmod", "write", "stat", "read"):
            damaged = copy.deepcopy(report)
            next(row for row in damaged["layouts"]["A"]["steps"]
                 if row["kind"] == kind)["exit_code"] = 1
            with self.subTest(kind=kind):
                result = self.check(damaged, False)
                self.assertIs(result["layouts"]["A"]["passed"], False)
                self.assertTrue(result["layouts"]["A"]["reasons"])

    def test_cli_matrix_only_evidence_is_partial_and_never_passes(self):
        for layout in ("A", "B"):
            with self.subTest(layout=layout):
                verdict = self.cli(evidence(layout), False)
                self.assertIs(verdict["partial"], True)
                self.assertIs(verdict["atomic_passed"], False)
                self.assertIs(verdict["matrix_passed"], layout == "B")
                self.assertTrue(verdict["reasons"])

    def test_cli_accepts_complete_matrix_and_step6(self):
        verdict = self.cli(full_evidence(), True)
        self.assertIs(verdict["partial"], False)
        self.assertIs(verdict["matrix_passed"], True)
        self.assertIs(verdict["atomic_passed"], True)
        self.assertEqual(verdict["reasons"], [])

    def test_cli_rejects_183_missing_atomic_shared_reads(self):
        report = full_evidence()
        reads = report["concurrent"]["atomic"]["workers"][0]["shared_reads"]
        for index in range(183):
            reads[index] = dict(observed=None, error="ENOENT")
        report["concurrent"]["atomic"]["passed"] = True  # Cached claims cannot override receipts.
        verdict = self.cli(report, False)
        self.assertIs(verdict["partial"], False)
        self.assertIs(verdict["matrix_passed"], True)
        self.assertIs(verdict["atomic_passed"], False)
        self.assertTrue(verdict["reasons"])

    def test_complete_atomic_evidence_cannot_replace_layout_b(self):
        report = full_evidence()
        report["layouts"] = evidence("A")["layouts"]
        verdict = self.cli(report, False)
        self.assertIs(verdict["matrix_passed"], False)
        self.assertIs(verdict["atomic_passed"], True)

    def test_overall_rejects_incomplete_error_and_cleanup_receipts(self):
        for section in ("matrix", "concurrent"):
            for field, value in (("completed", False), ("errors", ["operation failed"]),
                                 ("unremoved_vms", ["spike-vm"])):
                with self.subTest(section=section, field=field):
                    report = full_evidence()
                    target = report if section == "matrix" else report["concurrent"]
                    target[field] = value
                    verdict = (self.cli(report, False) if section == "concurrent"
                               else self.module.evaluate(report))
                    self.assertIs(verdict["passed"], False)
                    self.assertTrue(verdict["reasons"])
        for field in ("completed", "errors", "unremoved_vms", "atomic"):
            report = full_evidence()
            del report["concurrent"][field]
            with self.subTest(missing=field):
                verdict = self.cli(report, False) if field == "atomic" else self.module.evaluate(report)
                self.assertIs(verdict["passed"], False)
                if field == "atomic": self.assertIs(verdict["partial"], True)

    def test_overall_requires_recorded_hot_add_attempt_and_guest_after(self):
        for receipt in ("attempt", "guest_after"):
            for fault in ("missing", "command", "empty_command", "exit_code", "bool_exit_code"):
                report = full_evidence()
                hot_add = report["layouts"]["B"]["hot_add"]
                if fault == "missing": del hot_add[receipt]
                elif fault == "empty_command": hot_add[receipt]["command"] = ""
                elif fault == "bool_exit_code": hot_add[receipt]["exit_code"] = False
                else: del hot_add[receipt][fault]
                with self.subTest(receipt=receipt, fault=fault):
                    verdict = self.module.evaluate(report)
                    self.assertIs(verdict["passed"], False)
                    self.assertTrue(verdict["reasons"])
        report = full_evidence()
        del report["layouts"]["B"]["hot_add"]
        self.assertIs(self.cli(report, False)["matrix_passed"], True)


if __name__ == "__main__":
    unittest.main()

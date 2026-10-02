#!/usr/bin/env python3
"""Synthetic evidence tests; these do not execute or claim microVM measurements."""
import copy
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest


def evidence(layout="A"):
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
    return dict(completed=True, host_uid=501, layouts={layout: dict(
        steps=steps,
        samples=[dict(seq=i, expected=f"mch02-{i}", observed=f"mch02-{i}",
                      write_exit_code=0, read_exit_code=0, delay_ms=1000) for i in range(1, 101)],
        host=[dict(path=p, uid=501, gid=20, mode="700") for p in (".", "ben", "alice")]
             + [dict(path="ben/.config/tool/login.json", uid=501, gid=20, mode="644")],
        boot_mounts_required=layout == "B",
        boot_mount_note="Every member needs a mount at VM boot." if layout == "B" else "")})


class VerdictTests(unittest.TestCase):
    def check(self, report, passed):
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
                result = self.check(evidence(layout), True)
                self.assertIs(result["layouts"][layout]["passed"], True)
                self.assertEqual(result["layouts"][layout]["p95_ms"], 1000)

    def test_rejects_missing_or_incorrect_permission_evidence(self):
        for phase in ("initial", "reboot", "second_vm"):
            for member in ("ben", "alice"):
                for kind in ("stat", "read"):
                    for fault in ("missing", "failed", "wrong_uid", "wrong_gid", "wrong_value"):
                        with self.subTest(phase=phase, member=member, kind=kind, fault=fault):
                            report = evidence()
                            steps = report["layouts"]["A"]["steps"]
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
                            report = evidence()
                            steps = report["layouts"]["A"]["steps"]
                            row = next(s for s in steps if s["phase"] == phase and
                                       s["member"] == member and s["kind"] == "read" and s["actor_uid"] == actor)
                            if fault == "missing": steps.remove(row)
                            elif fault == "allowed": row["exit_code"] = 0
                            elif fault == "ENOENT": row["data"]["errno"] = "ENOENT"
                            else: row["data"]["uid"] = row["data"]["gid"] = 0
                            self.check(report, False)

    def test_rejects_incomplete_commands_host_or_samples(self):
        for fault in ("incomplete", "chown", "chmod", "write", "write_actor", "host_missing",
                      "host_uid", "host_mode", "99", "101", "duplicate", "duplicate_expected", "stale", "empty_expected",
                      "write_failure", "read_failure", "negative", "nan", "infinity", "p95"):
            with self.subTest(fault=fault):
                report = evidence()
                data = report["layouts"]["A"]
                if fault == "incomplete": report["completed"] = False
                elif fault in ("chown", "chmod", "write", "write_actor"):
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
        for sample in report["layouts"]["A"]["samples"][-5:]: sample["delay_ms"] = 1200
        self.check(report, True)

    def test_requires_actual_host_owner_identity(self):
        report = evidence()
        report.pop("host_uid")
        for entry in report["layouts"]["A"]["host"]: entry.pop("uid")
        self.check(report, False)

    def test_b_requires_mount_caveat_and_a_failure_can_select_b(self):
        for field in ("boot_mounts_required", "boot_mount_note"):
            report = evidence("B")
            report["layouts"]["B"].pop(field)
            self.check(report, False)
        report = evidence("B")
        report["layouts"]["B"]["boot_mount_note"] = "No mount needed."
        self.check(report, False)
        report = evidence()
        report["layouts"].update(evidence("B")["layouts"])
        report["layouts"]["A"]["steps"][0]["exit_code"] = 1
        result = self.check(report, True)
        self.assertIs(result["layouts"]["A"]["passed"], False)
        self.assertIs(result["layouts"]["B"]["passed"], True)


if __name__ == "__main__":
    unittest.main()

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


def retained_fixture(root):
    # C-SPK-02 Result and steps 2-9: independent historical NO oracle.
    report = evidence("B")
    report["layouts"].update(evidence("A")["layouts"])
    report.update(msb_version="msb 0.6.16", revision="a" * 40,
                  image="node@sha256:71fed097c6e5bae40e1aff698793dda483e2380cc2530d7367a72a9d037c798b")
    logs = []
    for layout in ('A', 'B'):
        mounts = (f'--mount-dir /scratch/A/homes:/home' if layout == 'A' else
                  '--mount-dir /scratch/B/homes/ben:/home/ben:uid=20001,gid=20001 '
                  '--mount-dir /scratch/B/homes/alice:/home/alice:uid=20002,gid=20002')
        for vm in (1, 2):
            logs.append(dict(command=f"msb create {report['image']} -n {layout}{vm} {mounts}",
                             exit_code=0, stdout='', stderr=''))
        for action in ('stop', 'start'):
            logs.append(dict(command=f'msb {action} -q {layout}1', exit_code=0, stdout='', stderr=''))
    def put(name, value):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value) + "\n")
    for layout in ("A", "B"):
        data = report["layouts"][layout]
        original = data["steps"]
        steps = []
        for phase in ("initial", "reboot", "second_vm"):
            steps.append(dict(phase=phase, kind="mount_root", member=".", exit_code=0,
                              stdout="0:0 700 /home\n"))
            for row in original:
                if row["phase"] != phase: continue
                row = copy.deepcopy(row)
                if layout == "A" and row["kind"] in ("read", "write"):
                    row.update(exit_code=1)
                    row["data"].update(errno="EACCES", value=None)
                steps.append(row)
                if layout == "A" and phase == "initial" and row["kind"] == "chown":
                    steps.append(dict(phase=phase, kind="mkdir", member=row["member"], exit_code=0))
        for row in steps:
            row.setdefault("command", ["stat", "fixture"])
            row["stdout"] = row.get("stdout", "") if row["kind"] == "mount_root" else json.dumps(row.get("data"))
            row["stderr"] = ""
            row["vm"] = 2 if row["phase"] == "second_vm" else 1
            if "actor_uid" in row:
                row["data"]["groups"] = []
                row["stdout"] = json.dumps(row["data"])
        data["steps"] = steps
        for phase in ("initial", "reboot", "second_vm"):
            raw = [{k: v for k, v in row.items() if k != "vm"}
                   for row in steps if row["phase"] == phase]
            logs.append(dict(command=f"msb exec --stream -u 0 {layout}{2 if phase == 'second_vm' else 1} -- node matrix {layout} {phase}", exit_code=0,
                             stdout=json.dumps(raw), stderr=""))
        if layout == "A":
            for row in data["samples"]:
                row.update(observed=None, write_exit_code=1, read_exit_code=1)
        import csv
        with (root / f"{layout}-delays.csv").open("w") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(data["samples"][0]))
            writer.writeheader(); writer.writerows(data["samples"])
        (root / f"{layout}-host-ls-ln.txt").write_text("drwx------ 2 501 20 64 Oct 2 12:00 ben\ndrwx------ 2 501 20 64 Oct 2 12:00 alice\n")
    hot = dict(attempt=dict(command="msb modify vm --mount-dir third", exit_code=1, stdout="", stderr="unsupported"),
               guest_after=dict(command="msb exec vm -- stat /home/carol", exit_code=1, stdout="", stderr="absent"))
    report["layouts"]["B"]["hot_add"] = hot
    logs.extend(hot.values())
    matrix = copy.deepcopy(report)
    atomic = atomic_evidence()
    atomic["workers"][0]["shared_reads"][0] = dict(error="ENOENT", observed=None)
    manifest = [dict(path=f"vm{vm}-{seq}", exists=True, correct=True, sha256="b" * 64)
                for vm in ("1", "2") for seq in range(1, 1001)]
    for guest in atomic["guests"]: guest["manifest"] = copy.deepcopy(manifest)
    workers = [dict(vm=vm, uid=20001, gid=20001, completed=True, iterations=1000)
               for vm in ("1", "2")]
    concurrent = dict(completed=True, errors=[], unremoved_vms=[], msb_version="msb 0.6.16",
                      image=report["image"], revision="a" * 40, host=dict(uid=501),
                      atomic=atomic, files=dict(workers=workers),
                      sqlite={mode: dict(workers=copy.deepcopy(workers)) for mode in ("DELETE", "WAL")},
                      locks=[dict(path=path, holder=holder, contender=other, held_during_attempt=True,
                                  holder_receipt=dict(command=f"flock holder {path} {holder}", exit_code=0, stdout="LOCK_HELD\n", stderr=""),
                                  contender_receipt=dict(command=f"flock contender {path} {other}", exit_code=0, stdout="", stderr=""))
                             for path in (".claude", ".config/gh", ".npm/_cacache")
                             for holder, other in (("1", "2"), ("2", "1"))])
    clog = []
    for phase, rows in (("files", workers), ("atomic", atomic["workers"]),
                        ("sqlite-delete", concurrent["sqlite"]["DELETE"]["workers"]),
                        ("sqlite-wal", concurrent["sqlite"]["WAL"]["workers"])):
        for row in rows:
            stdout = "RESULT " + json.dumps(row) + "\n"
            path = root / f"concurrent/{phase}-vm{row['vm']}.stdout"
            path.parent.mkdir(parents=True, exist_ok=True); path.write_text(stdout)
            clog.append(dict(command=f"msb exec {phase}-{row['vm']}", exit_code=0,
                             stdout=stdout, stderr=""))
    for guest in atomic['guests']:
        clog.append(dict(command=f"msb exec verify-{guest['vm']}", exit_code=0,
                         stdout=json.dumps(guest) + '\n', stderr=''))
    for row in concurrent['locks']:
        clog.extend([row['holder_receipt'], row['contender_receipt']])
    put("concurrent/atomic-manifest.json", manifest)
    put("concurrent/results.json", concurrent)
    (root / "concurrent/commands.jsonl").write_text("".join(json.dumps(row) + "\n" for row in clog))
    (root / "concurrent/create-help.txt").write_text("--mount-dir uid=<N>,gid=<N>\n")
    (root / "concurrent/host-ls-ln.txt").write_text("host-owned fixture\n")
    report["concurrent"] = concurrent
    report["concurrent_exit_code"] = 1
    # Oracle is transcribed from C-SPK-02 Result; cached fields never suffice.
    report["verdict"] = dict(passed=False, partial=False, matrix_passed=True, atomic_passed=False,
        layouts={"A": dict(passed=False, reasons=[
            reason for member in ("ben", "alice") for reason in
            [f"{member}: owner write failed"] +
            [f"{phase}/{member}: read as {20001 if member == 'ben' else 20002} failed expectation"
             for phase in ("initial", "reboot", "second_vm")]] +
            ["requires 100/100 successful fresh cross-VM samples"], p95_ms=1000),
                 "B": dict(passed=True, reasons=[], p95_ms=1000)},
        reasons=["Concurrent atomic-write step 6 failed or incomplete."])
    put("results.json", report); put("matrix-results.json", matrix)
    put("check-summary.json", report["verdict"])
    (root / "commands.jsonl").write_text("".join(json.dumps(row) + "\n" for row in logs))


class DecisionCommandTests(unittest.TestCase):
    def command(self, *args):
        return subprocess.run(["bash", str(pathlib.Path(__file__).with_name("run.sh")), *args],
                              capture_output=True, text=True)

    def test_decision_evidence_retains_no(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            retained_fixture(root)
            before = {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()}
            run = self.command("--decision-evidence", tmp)
            self.assertEqual(run.returncode, 0, run.stderr)
            receipt = json.loads(run.stdout)
            self.assertEqual(receipt["hypothesis"], "NO")
            self.assertIs(receipt["hypothesis_verdict"]["passed"], False)
            self.assertIs(receipt["shared_homes_enabled"], False)
            self.assertEqual(receipt["homes"], "per-machine")
            self.assertEqual(receipt["lock_classifications"], ["uncontrolled"] * 6)
            self.assertEqual(before, {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()})

    def test_decision_evidence_preserves_callers_relative_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp); retained_fixture(root)
            run = subprocess.run(["bash", str(pathlib.Path(__file__).with_name("run.sh").resolve()),
                                  "--decision-evidence", "."], cwd=root, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(json.loads(run.stdout)["hypothesis"], "NO")

    def test_decision_evidence_refuses_truncated_and_forged_logs(self):
        for name in ("commands.jsonl", "matrix-results.json", "results.json", "check-summary.json",
                     "A-delays.csv", "B-delays.csv", "A-host-ls-ln.txt", "B-host-ls-ln.txt",
                     "concurrent/results.json", "concurrent/atomic-manifest.json",
                     "concurrent/commands.jsonl", "concurrent/atomic-vm1.stdout",
                     "concurrent/files-vm2.stdout", "concurrent/sqlite-wal-vm1.stdout"):
            for fault in ("absent", "empty", "truncated", "symlink"):
                with self.subTest(name=name, fault=fault), tempfile.TemporaryDirectory() as tmp:
                    root = pathlib.Path(tmp); retained_fixture(root)
                    path = root / name
                    content = path.read_text()
                    if fault == "empty": path.write_text("")
                    elif fault == "truncated": path.write_text(content[:len(content)//2])
                    elif fault == "absent": path.unlink()
                    else:
                        path.unlink(); path.symlink_to(root / "results.json")
                    run = self.command("--decision-evidence", tmp)
                    self.assertNotEqual(run.returncode, 0, run.stdout)
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp); retained_fixture(root)
            report = json.loads((root / "results.json").read_text())
            report["verdict"]["passed"] = True
            (root / "results.json").write_text(json.dumps(report))
            self.assertNotEqual(self.command("--decision-evidence", tmp).returncode, 0)

    def test_decision_evidence_separates_controlled_lock_receipts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp); retained_fixture(root)
            report = json.loads((root / "results.json").read_text())
            for row in report["concurrent"]["locks"]:
                row.update(same_vm_receipt=dict(command="flock same-vm", exit_code=1),
                           held_during_attempt=True, controlled=True, exclusion=False)
            with (root / "concurrent/commands.jsonl").open("a") as stream:
                for row in report["concurrent"]["locks"]:
                    stream.write(json.dumps(dict(row["same_vm_receipt"], stdout="", stderr="")) + "\n")
                    row["same_vm_receipt"].update(stdout="", stderr="")
            (root / "results.json").write_text(json.dumps(report) + "\n")
            (root / "concurrent/results.json").write_text(json.dumps(report["concurrent"]) + "\n")
            run = self.command("--decision-evidence", tmp)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(json.loads(run.stdout)["lock_classifications"], ["controlled"] * 6)
            self.assertEqual(json.loads(run.stdout)["hypothesis"], "NO")

    def test_decision_evidence_rejects_wrong_identity_and_duplicate_matrix(self):
        for fault in ("root_host", "guest_groups", "stat_owner", "duplicate", "missing", "sample_count"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as tmp:
                root = pathlib.Path(tmp); retained_fixture(root)
                report = json.loads((root / "results.json").read_text())
                steps = report["layouts"]["A"]["steps"]
                if fault == "root_host": report["host_uid"] = 0
                elif fault == "guest_groups": next(r for r in steps if r["kind"] == "read")["data"]["groups"] = [0]
                elif fault == "stat_owner": next(r for r in steps if r["kind"] == "stat")["data"]["uid"] = 0
                elif fault == "duplicate": steps.append(copy.deepcopy(steps[0]))
                elif fault == "missing": steps.pop()
                else: report["layouts"]["A"]["samples"].pop()
                (root / "results.json").write_text(json.dumps(report) + "\n")
                self.assertNotEqual(self.command("--decision-evidence", tmp).returncode, 0)

    def test_decision_evidence_does_not_execute_command_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp); retained_fixture(root)
            log = root / "commands.jsonl"
            text = log.read_text().replace("msb create ", f"msb create ; touch {root}/EXECUTED; ")
            log.write_text(text)
            run = self.command("--decision-evidence", tmp)
            self.assertNotEqual(run.returncode, 0)
            self.assertFalse((root / "EXECUTED").exists())

    def test_review_mutations_refuse_even_when_duplicate_records_agree(self):
        for fault in ('atomic_host', 'guest_manifest', 'final_reads', 'create', 'mount_uid',
                      'restart', 'matrix_stdout', 'locks', 'shared_reads', 'guest_raw'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as tmp:
                root = pathlib.Path(tmp); retained_fixture(root)
                report = json.loads((root / 'results.json').read_text())
                logs = [json.loads(line) for line in (root / 'commands.jsonl').read_text().splitlines()]
                atomic = report['concurrent']['atomic']
                if fault == 'atomic_host': del atomic['host']
                elif fault == 'guest_manifest':
                    for g in atomic['guests']: g['manifest'] = [dict(path=m['path']) for m in g['manifest']]
                elif fault == 'final_reads': atomic['guests'][0]['final_reads'] = ['garbage']
                elif fault == 'shared_reads': atomic['workers'][0]['shared_reads'][0] = dict(error='ENOENT')
                elif fault == 'locks': report['concurrent']['locks'] = [{}] * 6
                elif fault in ('create', 'mount_uid', 'restart'):
                    for r in logs:
                        if fault == 'create' and ' create ' in r['command']: r['command'] = 'msb create unrelated'
                        elif fault == 'mount_uid': r['command'] = r['command'].replace('uid=20001', 'uid=0')
                        elif fault == 'restart' and ' stop ' in r['command']: r['command'] = 'msb inspect A1'
                elif fault == 'matrix_stdout':
                    for data in report['layouts'].values():
                        for r in data['steps']:
                            if r['kind'] != 'mount_root': r['stdout'] = ''
                    for r in logs:
                        if r['stdout'].startswith('['):
                            rows = json.loads(r['stdout'])
                            for row in rows:
                                if row['kind'] != 'mount_root': row['stdout'] = ''
                            r['stdout'] = json.dumps(rows)
                else:
                    path = root / 'concurrent/commands.jsonl'
                    path.write_text(''.join(line + '\n' for line in path.read_text().splitlines()
                                            if 'verify-' not in line))
                for name, value in [('results.json', report),
                                    ('matrix-results.json', {k:v for k,v in report.items() if k not in
                                     ('concurrent', 'concurrent_exit_code', 'verdict')}),
                                    ('concurrent/results.json', report['concurrent'])]:
                    (root / name).write_text(json.dumps(value) + '\n')
                (root / 'commands.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in logs))
                self.assertNotEqual(self.command('--decision-evidence', tmp).returncode, 0)

    def test_decision_evidence_refuses_incomplete(self):
        with tempfile.TemporaryDirectory() as tmp:
            for content in (None, "{", "{}", json.dumps(full_evidence())):
                path = pathlib.Path(tmp) / "results.json"
                if content is not None: path.write_text(content)
                run = self.command("--decision-evidence", tmp)
                self.assertNotEqual(run.returncode, 0, run.stdout)
                self.assertIn("evidence", run.stderr.lower())

    def test_rerun_refuses_until_trusted_root_inputs_exist(self):
        # T-MCH-02 Security preconditions: until reviewed main-pinned inputs
        # exist, every rerun refuses before lifecycle dispatch. No fake msb.
        for args in ((), ("--concurrent",), ("--rerun",),
                     ("--image", "/tmp/branch"), ("--mount-dir", "/tmp/outside")):
            with self.subTest(args=args):
                run = self.command(*args)
                self.assertNotEqual(run.returncode, 0)
                self.assertIn("reruns refused", run.stderr.lower())
        run = subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name("concurrent.py"))],
                             capture_output=True, text=True)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("reruns refused", run.stderr.lower())


if __name__ == "__main__":
    unittest.main()

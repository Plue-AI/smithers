"""Offline behavioral checks through the report.py CLI and its report files.

    python3 -B fixtures/check_report.py

Two synthetic Harbor jobs, one per arm, shaped like the retained
`luna-tb4-full` and `luna-B-smoke` trials. No Harbor install, network or
model seat is needed.
"""
from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPORT = HERE.parent / "report.py"
SMITHERS = "evals.harbor.smithers_agent:SmithersAgent"
BASELINE = "evals.harbor.codex_pool:PooledCodex"
MODEL = "openai/gpt-6-sol"
ENVIRONMENT = "evals.harbor.plue_env:PlueEnvironment"
DDL = """CREATE TABLE flows_journal_events (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL, source_seq INTEGER NOT NULL, emitted_at_ms INTEGER NOT NULL,
  event_type TEXT NOT NULL, payload_json TEXT NOT NULL, meta_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq))"""


class ReportCLI(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="report-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.jobs = {"smithers": self.root / "smithers-job", "baseline": self.root / "baseline-job"}
        self.job("smithers", SMITHERS)
        self.job("baseline", BASELINE)
        self.serial = 0

    def job(self, arm: str, agent: str, **extra: object) -> None:
        self.jobs[arm].mkdir(exist_ok=True)
        (self.jobs[arm] / "config.json").write_text(json.dumps({
            "job_name": self.jobs[arm].name,
            "environment": {"import_path": ENVIRONMENT},
            "agents": [{"name": agent, "model_name": MODEL, "kwargs": {"arm": arm}}],
            "datasets": [{"name": "terminal-bench/terminal-bench", "ref": "sha256:d1"}],
            **extra,
        }))

    def trial(self, arm: str, task: str, *, reward: float | None = 1.0, exception: str | None = None,
              tokens: tuple = (1000, 800, 50), checksum: str | None = None, host_command: str | None = None,
              config: dict | None = None, succeeded: int = 3) -> Path:
        self.serial += 1
        directory = self.jobs[arm] / f"{task}__{arm[:1]}{self.serial:04d}"
        summary = self.jobs[arm] / "result.json"
        planned = json.loads(summary.read_text())["n_total_trials"] if summary.is_file() else 0
        summary.write_text(json.dumps({"n_total_trials": planned + 1}))
        (directory / "agent").mkdir(parents=True)
        trial_config = {
            "task": {"name": f"terminal-bench/{task}"},
            "timeout_multiplier": 1.0,
            "agent": {"name": SMITHERS if arm == "smithers" else BASELINE, "import_path": None, "model_name": MODEL,
                      "kwargs": {"arm": arm}, "extra_allowed_hosts": [], "override_timeout_sec": None},
            "environment": {"import_path": ENVIRONMENT, "mounts": None, "extra_allowed_hosts": [],
                            "override_cpus": None},
            "verifier": {"override_timeout_sec": None},
        }
        for section, values in (config or {}).items():
            if isinstance(values, dict):
                trial_config[section].update(values)
            else:
                trial_config[section] = values
        (directory / "config.json").write_text(json.dumps({"trial_name": directory.name}))
        reached = {"attempted": succeeded + 1, "succeeded": succeeded}
        result = {
            "task_name": f"terminal-bench/{task}",
            "trial_name": directory.name,
            "task_checksum": checksum or f"sum-{task}",
            "config": trial_config,
            "agent_result": {
                "n_input_tokens": tokens[0], "n_cache_tokens": tokens[1], "n_output_tokens": tokens[2],
                "metadata": {"container_commands": reached,
                             **({"harness_revision": "abc123"} if arm == "smithers" else {})},
            },
            "verifier_result": {"rewards": {"reward": reward}} if reward is not None else None,
            "exception_info": {"exception_type": exception, "exception_message": "x"} if exception else None,
            "started_at": f"2026-10-01T00:{self.serial % 60:02d}:00Z",
            "finished_at": f"2026-10-01T01:{self.serial % 60:02d}:00Z",
        }
        (directory / "result.json").write_text(json.dumps(result))
        (directory / "agent" / "trajectory.json").write_text("{}")
        if arm == "smithers":
            self.journal(directory, host_command)
        else:
            (directory / "agent" / "codex-account.json").write_text(json.dumps({"containerCommands": reached}))
        return directory

    def journal(self, trial: Path, host_command: str | None) -> None:
        flows = trial / "agent" / "workspace" / ".flows"
        flows.mkdir(parents=True)
        calls = [{"command": "ls /app", "container": "ws-1", "mode": "unhermetic"}]
        if host_command:
            calls.append({"command": host_command, "mode": "unhermetic"})
        connection = sqlite3.connect(flows / "control.db")
        connection.execute(DDL)
        seq = 0
        for index, given in enumerate(calls):
            for kind, payload in (
                ("control.agent.cell-call-started", {"callId": f"c{index}", "flowName": "bash", "input": given}),
                ("control.agent.cell-call-settled", {"callId": f"c{index}", "outcome": "success", "value": {"exitCode": 0}}),
            ):
                connection.execute("insert into flows_journal_events values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                                   ("r", seq, f"e{seq}", "f", seq, seq, kind, json.dumps(payload), "{}"))
                seq += 1
        connection.commit()
        connection.close()

    def paired(self, tasks: int, *, solved: dict[str, int] | None = None) -> None:
        solved = solved or {"smithers": tasks, "baseline": tasks}
        for index in range(tasks):
            for arm in ("smithers", "baseline"):
                self.trial(arm, f"task-{index:03d}", reward=1.0 if index < solved[arm] else 0.0)

    def run_report(self, expected_exit: int, *extra: str) -> tuple[str, dict]:
        out = self.root / "out" / "nested"
        process = subprocess.run(
            [sys.executable, "-B", str(REPORT), str(self.jobs["smithers"]), str(self.jobs["baseline"]), str(out), *extra],
            text=True, capture_output=True, timeout=60,
        )
        self.assertEqual(process.returncode, expected_exit, process.stdout + process.stderr)
        self.assertEqual(process.stderr, "")
        text = (out / "report.md").read_text()
        self.assertEqual(text, process.stdout, "stdout and the persisted report must agree")
        return text, json.loads((out / "report.json").read_text())

    def assert_refused(self, *reasons: str) -> dict:
        text, report = self.run_report(3)
        self.assertFalse(report["publishable"])
        self.assertIsNone(report["results"], "a refused report carries no pass rates")
        self.assertIn("**Not publishable.**", text)
        self.assertNotIn("Pass rate", text)
        for reason in reasons:
            self.assertIn(reason, report["refusals"])
            self.assertIn(f"- {reason}\n", text)
        return report

    def test_fifty_sealed_paired_tasks_publish_rates_and_tokens(self) -> None:
        self.paired(50, solved={"smithers": 30, "baseline": 25})
        text, report = self.run_report(0)
        self.assertTrue(report["publishable"], report["refusals"])
        self.assertEqual(report["refusals"], [])
        self.assertEqual(report["pairedTasks"], 50)
        self.assertEqual(report["results"]["smithers"]["passRate"], 0.6)
        self.assertEqual(report["results"]["baseline"]["passRate"], 0.5)
        self.assertEqual(report["results"]["smithers"]["solved"], 30)
        self.assertEqual(report["results"]["baseline"]["tokens"], {"input": 50_000, "cached": 40_000, "output": 2_500})
        self.assertEqual(report["results"]["smithers"]["harnessRevisions"], ["abc123"])
        self.assertIn(f"| {SMITHERS} | 60.0% | 30 of 50 | 50,000 | 40,000 | 2,500 |\n", text)
        self.assertIn(f"| {BASELINE} | 50.0% | 25 of 50 | 50,000 | 40,000 | 2,500 |\n", text)
        self.assertIn("- 50 paired tasks; attempts per task: 1.\n", text)
        self.assertIn("| terminal-bench/task-000 | 1.0 | 1.0 |\n", text)
        self.assertIn("| terminal-bench/task-049 | 0.0 | 0.0 |\n", text)
        first = report["tasks"][0]
        self.assertEqual(first["smithers"]["trajectories"], [f"{first['smithers']['trials'][0]}/agent/trajectory.json"])
        again_text, again = self.run_report(0)
        self.assertEqual((again_text, again), (text, report), "the report is deterministic")

    def test_forty_nine_paired_tasks_are_refused_and_min_tasks_is_a_parameter(self) -> None:
        self.paired(49)
        self.assert_refused("49 paired tasks; 50 required")
        text, report = self.run_report(0, "--min-tasks", "49")
        self.assertEqual(report["pairedTasks"], 49)
        self.assertIn("100.0%", text)

    def test_missing_usage_is_refused_per_trial(self) -> None:
        self.paired(2)
        trial = self.trial("baseline", "task-002", tokens=(None, None, None))
        self.trial("smithers", "task-002", tokens=(10, None, 5))
        report = self.assert_refused(f"baseline: {trial.name} reports no n_input_tokens, n_cache_tokens, n_output_tokens")
        self.assertTrue(any(r.endswith("reports no n_cache_tokens") and r.startswith("smithers: ") for r in report["refusals"]),
                        report["refusals"])

    def test_a_smithers_host_call_unseals_the_trial(self) -> None:
        self.paired(1)
        trial = self.trial("smithers", "task-001", host_command="cat ../tests/test_outputs.py")
        self.trial("baseline", "task-001")
        self.assert_refused(f"smithers: {trial.name} is not sealed: host-call audit TAINTED")

    def test_a_benign_host_call_still_unseals_the_trial(self) -> None:
        self.paired(1)
        trial = self.trial("smithers", "task-001", host_command="uname -a")
        self.trial("baseline", "task-001")
        self.assert_refused(f"smithers: {trial.name} is not sealed: host-call audit host-calls-benign")

    def test_extra_hosts_mounts_and_no_container_command_unseal(self) -> None:
        hosts = self.trial("baseline", "task-000", config={"agent": {"extra_allowed_hosts": ["example.com"]}})
        mounts = self.trial("baseline", "task-001", config={"environment": {"mounts": ["/data:/data"]}})
        idle = self.trial("baseline", "task-002", succeeded=0)
        for index in range(3):
            self.trial("smithers", f"task-{index:03d}")
        self.assert_refused(
            f"baseline: {hosts.name} is not sealed: agent extra_allowed_hosts ['example.com']",
            f"baseline: {mounts.name} is not sealed: environment mounts ['/data:/data']",
            f"baseline: {idle.name} is not sealed: no command exited 0 in the task container",
        )

    def test_infra_and_running_trials_block_publication(self) -> None:
        self.paired(1)
        infra = self.trial("baseline", "task-001", reward=None, exception="PlueError")
        running = self.trial("smithers", "task-001")
        data = json.loads((running / "result.json").read_text())
        data["finished_at"] = None
        (running / "result.json").write_text(json.dumps(data))
        self.assert_refused(
            f"baseline: {infra.name} is infra (PlueError); re-run it before publishing",
            f"smithers: {running.name} is running (no exception); re-run it before publishing",
        )

    def test_unplaceable_task_leaves_both_arms_and_is_listed(self) -> None:
        self.paired(2)
        self.trial("smithers", "gpu-task", reward=None, exception="PlueUnplaceable")
        self.trial("baseline", "gpu-task")
        text, report = self.run_report(0, "--min-tasks", "2")
        self.assertEqual(report["pairedTasks"], 2)
        self.assertEqual(report["unplaceable"], ["terminal-bench/gpu-task"])
        self.assertEqual(report["results"]["baseline"]["trials"], 2, "the baseline's gpu-task trial is not scored")
        self.assertIn("- 1 tasks could not be placed and are excluded from both arms: terminal-bench/gpu-task.\n", text)

    def test_unequal_attempts_one_sided_tasks_and_changed_tasks_are_refused(self) -> None:
        self.paired(1)
        self.trial("smithers", "task-000")
        self.trial("baseline", "only-baseline")
        self.trial("smithers", "changed", checksum="a")
        self.trial("baseline", "changed", checksum="b")
        self.assert_refused(
            "terminal-bench/task-000: 2 scored attempts in smithers, 1 in baseline; 1 planned",
            "terminal-bench/only-baseline: no scored trial in the smithers arm",
            "terminal-bench/changed: task checksums differ across trials: ['a', 'b']",
        )

    def test_every_paired_task_has_the_planned_attempts(self) -> None:
        self.job("smithers", SMITHERS, n_attempts=2)
        self.job("baseline", BASELINE, n_attempts=2)
        self.paired(1)
        self.paired(1)
        self.trial("smithers", "task-001")
        self.trial("baseline", "task-001")
        self.assert_refused("terminal-bench/task-001: 1 scored attempts in smithers, 1 in baseline; 2 planned")

    def test_arms_must_share_dataset_model_environment_and_attempts(self) -> None:
        self.paired(1)
        self.job("baseline", BASELINE, n_attempts=5)
        config = json.loads((self.jobs["baseline"] / "config.json").read_text())
        config["datasets"][0]["version"] = "4.0.1"
        config["environment"] = {"type": "daytona"}
        config["agents"][0]["model_name"] = "openai/gpt-6-luna"
        (self.jobs["baseline"] / "config.json").write_text(json.dumps(config))
        report = self.assert_refused(
            "arms differ in model: openai/gpt-6-sol vs openai/gpt-6-luna",
            "arms differ in attempts: 1 vs 5",
        )
        for field in ("datasetSpec", "environmentSpec"):
            self.assertTrue(any(r.startswith(f"arms differ in {field}: ") for r in report["refusals"]), field)

    def test_every_trial_ran_what_its_job_names(self) -> None:
        self.paired(1)
        luna = self.trial("baseline", "task-001", config={"agent": {"model_name": "openai/gpt-6-luna"}})
        docker = self.trial("smithers", "task-001", config={"environment": {"import_path": None, "type": "docker"}})
        self.assert_refused(
            f"baseline: {luna.name} ran model openai/gpt-6-luna, not the job's {MODEL}",
            f"smithers: {docker.name} ran environment docker, not the job's {ENVIRONMENT}",
        )

    def test_the_arms_must_be_smithers_then_a_baseline(self) -> None:
        self.paired(1)
        self.job("smithers", BASELINE)
        self.job("baseline", SMITHERS)
        self.assert_refused(f"smithers: agent is {BASELINE}, not {SMITHERS}", "baseline: agent is the Smithers harness")

    def test_import_path_names_the_agent_harbor_loads(self) -> None:
        self.paired(1)
        config = json.loads((self.jobs["baseline"] / "config.json").read_text())
        config["agents"][0]["import_path"] = SMITHERS
        (self.jobs["baseline"] / "config.json").write_text(json.dumps(config))
        self.assert_refused("baseline: agent is the Smithers harness")

    def test_timeout_and_resource_overrides_are_refused(self) -> None:
        self.paired(1)
        slow = self.trial("smithers", "task-001", config={"timeout_multiplier": 2.0, "agent": {"override_timeout_sec": 7200}})
        big = self.trial("baseline", "task-001", config={"environment": {"override_cpus": 8}})
        self.assert_refused(
            f"smithers: {slow.name} overrides timeout_multiplier=2.0, agent.override_timeout_sec=7200",
            f"baseline: {big.name} overrides environment.override_cpus=8",
        )

    def test_a_trial_the_job_planned_but_did_not_retain_is_refused(self) -> None:
        self.paired(1)
        (self.jobs["baseline"] / "result.json").write_text(json.dumps({"n_total_trials": 2}))
        self.assert_refused("baseline: 1 trials retained; the job planned 2")

    def test_missing_job_directory_is_refused(self) -> None:
        missing = self.root / "nowhere"
        self.jobs["baseline"] = missing
        self.assert_refused(f"baseline: {missing} is not a Harbor job directory")

    def test_usage_text_on_bad_arguments(self) -> None:
        process = subprocess.run([sys.executable, "-B", str(REPORT), "one"], text=True, capture_output=True, timeout=30)
        self.assertEqual(process.returncode, 64)
        self.assertIn("python3 report.py <smithers-job> <baseline-job> <out-dir>", process.stderr)


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=0).result
    if not result.wasSuccessful():
        sys.exit(1)
    print(f"check_report.py: {result.testsRun} publication checks hold.")

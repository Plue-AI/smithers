"""Offline behavioral checks through the health.py CLI and its report file.

    python3 -B fixtures/check_health.py

Synthetic retained trials exercise reporting and the existing trip thresholds;
no Harbor installation, network, or model seat is needed.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

HEALTH = Path(__file__).resolve().parents[1] / "health.py"


class HealthCLI(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="health-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.jobs = Path(self.temp.name) / "jobs"
        self.jobs.mkdir()
        (self.jobs / "current").mkdir()
        self.now = datetime.now(timezone.utc)

    def trial(self, name: str, *, reward: float | None = None,
              exception: str | None = None, message: str = "",
              finished: bool = True, age: int = 0, wall: float = 120,
              reached: dict | None = None, aside: bool = False,
              receipt: str | None = None) -> Path:
        directory = self.jobs / ("current.infra" if aside else "current") / name
        directory.mkdir(parents=True)
        (directory / "config.json").write_text("{}")
        end = self.now - timedelta(seconds=age)
        result = {
            "finished_at": end.isoformat() if finished else None,
            "exception_info": {"exception_type": exception, "exception_message": message} if exception else None,
            "verifier_result": {"rewards": {"reward": reward}} if reward is not None else None,
            "agent_execution": {
                "started_at": (end - timedelta(seconds=wall)).isoformat(),
                "finished_at": end.isoformat() if finished else None,
            },
            "agent_result": {"metadata": {"container_commands": reached}} if reached is not None and not receipt else None,
        }
        (directory / "result.json").write_text(json.dumps(result))
        if receipt:
            (directory / "agent").mkdir()
            (directory / "agent" / receipt).write_text(json.dumps({"containerCommands": reached}))
        return directory

    def report(self, expected_exit: int = 0, *names: str) -> str:
        out = Path(self.temp.name) / "nested" / "health.md"
        process = subprocess.run(
            [sys.executable, "-B", str(HEALTH), str(self.jobs), str(out), *(names or ("current",))],
            text=True, capture_output=True, timeout=10,
        )
        self.assertEqual(process.returncode, expected_exit, process.stdout + process.stderr)
        self.assertEqual(process.stderr, "")
        self.assertTrue(out.is_file(), "the CLI must persist its report")
        report = out.read_text()
        self.assertEqual(report, process.stdout, "stdout and the persisted receipt must agree")
        return report

    def assert_counts(self, report: str, solved: int, retained: int,
                      scored: int, tasks: int, graded: int, agent: int) -> None:
        self.assertIn(f"- solved {solved} of {retained} retained current trials\n", report)
        self.assertIn(f"- scored subset {scored} trials ({tasks} tasks): {graded} graded, {agent} agent outcomes\n", report)

    def test_mixed_outcomes_keep_complete_denominator_and_causes(self) -> None:
        self.trial("solved__one", reward=1)
        self.trial("zero__one", reward=0)
        self.trial("timeout__one", reward=0, exception="AgentTimeoutError", message="agent timed out")
        self.trial("verifier__one", exception="RewardFileNotFoundError", message="missing /logs/verifier/reward.txt")
        self.trial("capacity__one", exception="PlueUnplaceable", message="task asks for 8 vCPU\nplan has 6")
        self.trial("pending__one", finished=False)
        report = self.report()
        self.assert_counts(report, 1, 6, 3, 3, 2, 1)
        self.assertIn("'running': 1", report)
        self.assertIn("'infra': 1", report)
        self.assertIn("- unplaceable: 1 trials (1 tasks)", report)
        self.assertIn("unplaceable capacity__one (task capacity): PlueUnplaceable task asks for 8 vCPU plan has 6", report)
        self.assertIn("infra verifier__one: RewardFileNotFoundError missing /logs/verifier/reward.txt", report)
        self.assertNotIn("33.3%", report, "a scored-subset solve percentage hides the retained denominator")

    def test_empty_and_missing_jobs(self) -> None:
        report = self.report(0, "current", "missing")
        self.assert_counts(report, 0, 0, 0, 0, 0, 0)
        self.assertIn("infra last hour: 0 of 0 finished (0%)", report)
        self.assertIn("## missing\n\n- not started", report)

    def test_running_trials_and_non_trial_directories(self) -> None:
        self.trial("running__one", reward=1, finished=False)
        missing = self.trial("missing-result__one")
        (missing / "result.json").unlink()
        corrupt = self.trial("corrupt-result__one")
        (corrupt / "result.json").write_text("{")
        (self.jobs / "current" / "logs").mkdir()
        (self.jobs / "current" / "README").write_text("not a trial")
        report = self.report()
        self.assert_counts(report, 0, 3, 0, 0, 0, 0)
        self.assertIn("trials 3: {'running': 3}", report)
        self.assertIn("infra last hour: 0 of 0 finished", report)

    def test_aside_attempts_affect_health_but_not_current_denominator(self) -> None:
        self.trial("same__current", reward=1)
        self.trial("same__old1", exception="PlueError", message="first workspace failed", aside=True)
        self.trial("same__old2", exception="PlueError", message="second workspace failed", aside=True)
        self.trial("old-score__one", reward=1, aside=True)
        report = self.report(3)
        self.assert_counts(report, 1, 1, 1, 1, 1, 0)
        self.assertIn("infra last hour: 2 of 4 finished (50%); attempts kept aside: 3", report)
        self.assertIn("current: 2 of 4 trials finished in the last hour were infra (50%)", report)

    def test_zero_reward_is_scored_and_never_solved(self) -> None:
        self.trial("zero__one", reward=0)
        self.trial("zero-agent__one", reward=0, exception="NonZeroAgentExitCodeError", message="Command failed (exit 1): agent failed")
        report = self.report()
        self.assert_counts(report, 0, 2, 2, 2, 1, 1)

    def test_exception_with_reward_does_not_override_outcome(self) -> None:
        self.trial("capacity__one", reward=1, exception="PlueUnplaceable", message="GPU is unsupported")
        self.trial("capacity__two", reward=0, exception="PlueUnplaceable", message="memory request too large\n" + "x" * 180)
        self.trial("infra__one", reward=1, exception="VerifierTimeoutError", message="verifier timed out")
        self.trial("agent__one", reward=1, exception="AgentTimeoutError", message="agent timed out")
        report = self.report()
        self.assert_counts(report, 1, 4, 1, 1, 0, 1)
        self.assertIn("- unplaceable: 2 trials (1 tasks)", report)
        self.assertIn("unplaceable capacity__one (task capacity): PlueUnplaceable GPU is unsupported", report)
        bounded = ("memory request too large\n" + "x" * 180)[:160].replace("\n", " ")
        detail = f"  - unplaceable capacity__two (task capacity): PlueUnplaceable {bounded}"
        self.assertIn(detail + "\n", report)
        self.assertNotIn(detail + "x", report)
        self.assertIn("infra infra__one: VerifierTimeoutError verifier timed out", report)

    def test_duplicate_task_attempts_remain_separate_trials(self) -> None:
        self.trial("same__one", reward=1)
        self.trial("same__two", reward=0)
        report = self.report()
        self.assert_counts(report, 1, 2, 2, 1, 2, 0)

    def test_infra_trip_requires_two_and_strictly_over_twenty_percent(self) -> None:
        for failures, total, exit_code, rate in ((1, 1, 0, "100%"), (2, 10, 0, "20%"), (2, 9, 3, "22%")):
            with self.subTest(failures=failures, total=total):
                job = f"boundary-{total}"
                (self.jobs / job).mkdir()
                for index in range(total):
                    path = self.trial(f"{job}-{index}__one", exception="PlueError" if index < failures else None, reward=None if index < failures else 0)
                    path.rename(self.jobs / job / path.name)
                report = self.report(exit_code, job)
                self.assertIn(f"infra last hour: {failures} of {total} finished ({rate})", report)
                self.assertEqual("## TRIPPED" in report, exit_code == 3)

    def test_old_infra_cancellation_and_placement_do_not_trip(self) -> None:
        for index in range(2):
            self.trial(f"old-{index}__one", exception="PlueError", age=7200)
            self.trial(f"cancel-{index}__one", exception="CancelledError")
            self.trial(f"capacity-{index}__one", exception="PlueUnplaceable")
        self.trial("pending__one", finished=False)
        report = self.report()
        self.assert_counts(report, 0, 7, 0, 0, 0, 0)
        self.assertIn("infra last hour: 0 of 4 finished (0%)", report)
        self.assertNotIn("## TRIPPED", report)

    def test_broken_trip_keeps_wall_and_container_command_boundaries(self) -> None:
        self.trial("boundary__one", reward=0, wall=60)
        self.trial("fast__one", reward=0, wall=59)
        report = self.report()
        self.assertNotIn("## TRIPPED", report, "one broken trial does not trip")
        self.assertIn("broken fast__one: wall 59.0", report)
        self.assertNotIn("broken boundary__one", report)
        self.trial("commands__one", reward=1, reached={"succeeded": 0})
        self.trial("healthy__one", reward=0, reached={"succeeded": 1})
        report = self.report(3)
        self.assertIn("current: 2 scored trials look broken", report)
        self.assertIn("broken commands__one", report)
        self.assertNotIn("broken healthy__one", report)

    def test_container_receipts_and_non_scored_trials_keep_broken_rule(self) -> None:
        self.trial("smithers__one", reward=0, reached={"succeeded": 0}, receipt="smithers-run.json")
        self.trial("codex__one", reward=0, reached={"succeeded": 0}, receipt="codex-account.json")
        self.trial("capacity__one", reward=0, exception="PlueUnplaceable", wall=1, reached={"succeeded": 0})
        self.trial("infra__one", reward=0, exception="PlueError", wall=1, reached={"succeeded": 0})
        report = self.report(3)
        self.assertIn("current: 2 scored trials look broken", report)
        self.assertIn("broken smithers__one", report)
        self.assertIn("broken codex__one", report)
        self.assertNotIn("broken capacity__one", report)
        self.assertNotIn("broken infra__one", report)


if __name__ == "__main__":
    unittest.main(verbosity=2)

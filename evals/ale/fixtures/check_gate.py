"""Behavioral evidence gates; run with python -m unittest discover -p check_gate.py."""
import copy
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gate as gate_module
from gate import validate_oracle, validate_pair

TASKS = ["docker/a", "docker/b"]


def oracle(task):
    return dict(task_path=task, variant_index=0, status="completed",
                eval_status="completed", reward=1.0,
                oracle=dict(inputs_verified=True, positive_outputs_copied=True, skipped=False))


def pair(task, arm):
    record = oracle(task)
    record.update(arm=arm, model="gpt-6-sol", reasoning_effort="max",
                  auth_mode="chatgpt", harness_revision="a" * 40, oracle_gate_digest="sha256:receipt")
    return record


class OracleGateTests(unittest.TestCase):
    def setUp(self):
        self.records = [oracle(task) for task in TASKS]

    def reject(self, records, tasks=TASKS):
        result = validate_oracle(records, tasks)
        self.assertIs(result["passed"], False)
        self.assertTrue(result["errors"])

    def test_nonobject_records_and_duplicate_roster_are_rejected(self):
        self.reject(self.records + [None, []])
        self.reject(self.records, TASKS + [TASKS[0]])

    def test_complete_verified_roster_passes_without_mutation(self):
        before = copy.deepcopy(self.records)
        result = validate_oracle(self.records, TASKS)
        self.assertEqual(result["errors"], [])
        self.assertIs(result["passed"], True)
        self.assertEqual(result["attempted"], 2)
        self.assertEqual(self.records, before)

    def test_exact_roster_and_variant_required(self):
        for records in ([], self.records[:1], self.records + [oracle(TASKS[0])],
                        self.records + [oracle("docker/extra")]):
            with self.subTest(records=records):
                self.reject(records)
        self.records[0]["variant_index"] = 1
        self.reject(self.records)
        self.reject(self.records, [])

    def test_rewards_must_be_positive_finite_numbers(self):
        for reward in (None, 0, -1, float("nan"), float("inf"), float("-inf"), True, False, "1"):
            with self.subTest(reward=reward):
                records = copy.deepcopy(self.records)
                records[0]["reward"] = reward
                self.reject(records)

    def test_required_fields_cannot_be_omitted(self):
        for key in ("task_path", "variant_index", "status", "eval_status", "reward", "oracle"):
            with self.subTest(key=key):
                records = copy.deepcopy(self.records)
                del records[0][key]
                self.reject(records)

    def test_execution_and_fixture_failures_fail_closed(self):
        mutations = [("status", "failed"), ("status", "timeout"),
                     ("eval_status", "failed"), ("eval_status", "not_executed"),
                     ("oracle", None), ("oracle", {}),
                     ("oracle", dict(inputs_verified=False, positive_outputs_copied=True, skipped=False)),
                     ("oracle", dict(inputs_verified=True, positive_outputs_copied=False, skipped=False)),
                     ("oracle", dict(inputs_verified=True, positive_outputs_copied=True, skipped=True))]
        for key, value in mutations:
            with self.subTest(key=key, value=value):
                records = copy.deepcopy(self.records)
                records[0][key] = value
                self.reject(records)


class PairGateTests(unittest.TestCase):
    def setUp(self):
        self.records = [pair(task, arm) for task in TASKS for arm in ("smithers", "codex")]

    def reject(self, records):
        result = validate_pair(records, TASKS)
        self.assertIs(result["passed"], False)
        self.assertTrue(result["errors"])

    def test_matched_roster_accepts_zero_partial_and_full_rewards(self):
        for rewards in ((0, 1, .5, 0), (1, 1, 1, 1)):
            records = copy.deepcopy(self.records)
            for record, reward in zip(records, rewards):
                record["reward"] = reward
            before = copy.deepcopy(records)
            result = validate_pair(list(reversed(records)), TASKS)
            self.assertIs(result["passed"], True)
            self.assertEqual(result["errors"], [])
            self.assertEqual(records, before)

    def test_missing_duplicate_extra_or_unknown_arm_fail(self):
        for records in ([], self.records[:-1], self.records + [self.records[0]],
                        self.records + [pair("docker/extra", "smithers")]):
            with self.subTest(records=records):
                self.reject(records)
        self.records[0]["arm"] = "oracle"
        self.reject(self.records)

    def test_pinned_comparison_conditions_and_completion_required(self):
        mutations = [("model", "gpt-6.1-sol"), ("reasoning_effort", "high"),
                     ("auth_mode", "api"), ("harness_revision", ""), ("harness_revision", "short"), ("harness_revision", "A" * 40),
                     ("oracle_gate_digest", ""), ("oracle_gate_digest", "different"),
                     ("variant_index", 1), ("status", "failed"),
                     ("status", "timeout"), ("eval_status", "not_executed")]
        for key, value in mutations:
            with self.subTest(key=key, value=value):
                records = copy.deepcopy(self.records)
                records[0][key] = value
                self.reject(records)

    def test_required_comparison_receipts_cannot_be_omitted(self):
        for key in ("arm", "task_path", "variant_index", "status", "eval_status", "reward",
                    "model", "reasoning_effort", "auth_mode", "harness_revision", "oracle_gate_digest"):
            with self.subTest(key=key):
                records = copy.deepcopy(self.records)
                del records[0][key]
                self.reject(records)

    def test_graded_agent_failures_remain_in_matched_roster(self):
        for status, kind in (("timeout", "agent_timeout"), ("failed", "agent_nonzero"), ("failed", "model_failed")):
            with self.subTest(status=status, kind=kind):
                records = copy.deepcopy(self.records)
                records[0].update(status=status, failure_kind=kind, reward=0, error="agent failed")
                result = validate_pair(records, TASKS)
                self.assertTrue(result["passed"], result["errors"])
                self.assertEqual(result["attempted"], len(records))

    def test_grading_and_infrastructure_failures_never_count_as_agent_loss(self):
        for changes in ({"failure_kind": "route_failed"}, {"failure_kind": "auth_failed"},
                        {"failure_kind": "unknown"}, {"failure_kind": "agent_timeout", "eval_status": "failed"},
                        {"failure_kind": "agent_timeout", "infra_error": "bridge unavailable"},
                        {"failure_kind": "agent_timeout", "eval_error": {"message": "judge failed"}}):
            with self.subTest(changes=changes):
                records = copy.deepcopy(self.records)
                records[0].update(status="failed", reward=0, **changes)
                self.reject(records)

    def test_each_arm_requires_immutable_revision_but_arms_can_differ(self):
        records = copy.deepcopy(self.records)
        for record in records:
            record["harness_revision"] = ("a" if record["arm"] == "smithers" else "b") * 40
        self.assertTrue(validate_pair(records, TASKS)["passed"])
        records[0]["harness_revision"] = "c" * 40
        self.reject(records)
        for invalid in ("short", "A" * 40):
            with self.subTest(invalid=invalid):
                for record in records:
                    record["harness_revision"] = invalid
                self.reject(records)

    def test_reward_boundaries_and_types(self):
        for reward in (None, -.01, 1.01, True, False, "0.5", float("nan"), float("inf")):
            with self.subTest(reward=reward):
                records = copy.deepcopy(self.records)
                records[0]["reward"] = reward
                self.reject(records)


class HostContractTests(unittest.TestCase):
    def test_subscription_pool_ownership_source_contract(self):
        # Offline source contract only: live pool availability/login is acceptance
        # evidence outside these tests. Changing fallback ownership invalidates ALE.
        root = Path(__file__).resolve().parents[3]
        source = (root / "packages/smithers/src/internal/NativeEquipment.ts").read_text()
        self.assertRegex(source, r'poolOwnsRoute\s*=.*route === "chatgpt"')
        refusal = source.index('The configured subscription pool has no available account for this seat.')
        guard = source[source.rfind('const platformFallback', 0, refusal):refusal]
        self.assertIn('pool.routes.includes(poolRoute)', guard)
        self.assertIn('poolOwnsRoute(poolRoute)', guard)
        self.assertIn('!platformFallback', guard)
        self.assertIn('new Seat.SeatUnresolved', guard)
        self.assertLess(refusal, source.index('credential(provider, host)', refusal))



class GateCLITests(unittest.TestCase):
    """Synthetic receipts validate the command; they are not benchmark results."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get("ALE_TEST_SCRATCH"))
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.gate = Path(__file__).resolve().parents[1] / "gate.py"
        self.roster = self.gate.with_name("docker_support.txt")
        self.tasks = [line.strip() for line in self.roster.read_text().splitlines()
                      if line.strip() and not line.startswith("#")]
        self.assertEqual(len(self.tasks), 99)

    def command(self, mode, records, receipt=None):
        path = self.work / "records.json"
        raw = json.dumps(records).encode()
        path.write_bytes(raw)
        args = [sys.executable, str(self.gate), mode, str(path)]
        if receipt is not None:
            args.extend(["--oracle-receipt", str(receipt)])
        result = subprocess.run(args, capture_output=True, text=True, timeout=10)
        return result, json.loads(result.stdout), raw

    def oracle_receipt(self):
        result, receipt, _ = self.command("oracle", [oracle(task) for task in self.tasks])
        self.assertEqual(result.returncode, 0, result.stderr)
        path = self.work / "oracle.json"
        path.write_text(result.stdout)
        return path, receipt

    def pairs(self, receipt):
        digest = "sha256:" + hashlib.sha256(receipt.read_bytes()).hexdigest()
        records = [pair(task, arm) for task in self.tasks for arm in ("smithers", "codex")]
        for record in records:
            record["oracle_gate_digest"] = digest
        return records

    def test_oracle_command_emits_exact_source_hashes_and_rejects_missing_task(self):
        result, receipt, raw = self.command("oracle", [oracle(task) for task in self.tasks])
        self.assertEqual(result.returncode, 0)
        self.assertTrue(receipt["passed"])
        self.assertEqual(receipt["mode"], "oracle")
        self.assertEqual(receipt["attempted"], 99)
        self.assertEqual(receipt["records_sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(receipt["roster_sha256"], hashlib.sha256(self.roster.read_bytes()).hexdigest())
        result, receipt, _ = self.command("oracle", [oracle(task) for task in self.tasks[:-1]])
        self.assertEqual(result.returncode, 1)
        self.assertFalse(receipt["passed"])

    def test_public_command_refuses_wrong_record_shape_and_absent_oracle(self):
        records_path = self.work / "wrong-shape.json"
        records_path.write_text(json.dumps({"task_path": self.tasks[0]}))
        result = subprocess.run([sys.executable, str(self.gate), "oracle", str(records_path)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn("JSON array", result.stderr)
        records_path.write_text(json.dumps([pair(task, arm) for task in self.tasks for arm in ("smithers", "codex")]))
        result = subprocess.run([sys.executable, str(self.gate), "pair", str(records_path)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn("requires --oracle-receipt", result.stderr)

    def test_public_command_refuses_changed_pinned_roster(self):
        # Execute the unchanged command against an alternate install layout;
        # no production roster is modified and no benchmark result is published.
        gate = self.work / "gate.py"
        gate.write_bytes(self.gate.read_bytes())
        (self.work / "docker_support.txt").write_text("one/task\n")
        records = self.work / "records.json"
        records.write_text("[]")
        result = subprocess.run([sys.executable, str(gate), "oracle", str(records)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn("99 tasks", result.stderr)
        # The same original Python function reads its install-relative roster.
        with patch.object(gate_module, "__file__", str(gate)), patch.object(sys, "argv", [str(gate), "oracle", str(records)]), patch("sys.stderr", io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                gate_module.main()
            self.assertEqual(raised.exception.code, 2)

    def test_pair_command_binds_exact_successful_oracle_receipt(self):
        path, _ = self.oracle_receipt()
        records = self.pairs(path)
        result, receipt, _ = self.command("pair", records, path)
        self.assertEqual(result.returncode, 0, receipt["errors"])
        self.assertEqual(receipt["attempted"], 198)
        records[0]["oracle_gate_digest"] = "sha256:wrong"
        result, receipt, _ = self.command("pair", records, path)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(receipt["passed"])

    def test_pair_command_rejects_failed_contradictory_or_unhashed_oracle(self):
        path, original = self.oracle_receipt()
        for changes in ({"passed": False}, {"errors": ["failed"]},
                        {"records_sha256": ""}, {"records_sha256": "invalid"}):
            with self.subTest(changes=changes):
                bad = dict(original, **changes)
                path.write_text(json.dumps(bad))
                result, receipt, _ = self.command("pair", self.pairs(path), path)
                self.assertEqual(result.returncode, 1)
                self.assertFalse(receipt["passed"])


if __name__ == "__main__":
    unittest.main()

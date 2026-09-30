"""Fail-closed gates for ALE oracle and matched subscription-run receipts."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from pathlib import Path
from typing import cast

UPSTREAM_REVISION = "d10fb61a14f9719774c3520c5763068b28ef5546"


def _reward(value: object) -> bool:
    if type(value) not in (int, float):
        return False
    number = cast(int | float, value)
    return math.isfinite(number) and 0 <= number <= 1


def _validate(records: list[dict], task_ids: list[str], paired: bool) -> dict:
    errors: list[str] = []
    if not task_ids or len(set(task_ids)) != len(task_ids):
        errors.append("task roster must be nonempty and unique")
    arms = ("smithers", "codex") if paired else ("oracle",)
    expected = {(arm, task, 0) for arm in arms for task in task_ids}
    seen: set[tuple] = set()
    digests = set()
    revisions: dict[str, set[str]] = {}
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            errors.append(f"record {index}: expected an object")
            continue
        arm = record.get("arm") if paired else "oracle"
        task = record.get("task_path")
        variant = record.get("variant_index")
        if not isinstance(task, str) or type(variant) is not int or not isinstance(arm, str):
            errors.append(f"record {index}: invalid task identity")
            continue
        key = (arm, task, variant)
        if key in seen:
            errors.append(f"duplicate: {key}")
        seen.add(key)
        if key not in expected:
            errors.append(f"unexpected: {key}")
        graded_agent_failure = paired and record.get("status") in ("failed", "timeout") and record.get("failure_kind") in (
            "agent_timeout", "agent_nonzero", "model_failed"
        )
        if (record.get("status") != "completed" and not graded_agent_failure) or record.get("eval_status") != "completed":
            errors.append(f"{key}: execution or grading incomplete")
        if (record.get("error") and not graded_agent_failure) or record.get("eval_error") or record.get("infra_error"):
            errors.append(f"{key}: infrastructure error")
        reward = record.get("reward")
        if not _reward(reward) or (not paired and reward != 1):
            errors.append(f"{key}: invalid reward")
        if paired:
            for field, value in (("model", "gpt-6-sol"), ("reasoning_effort", "max"), ("auth_mode", "chatgpt")):
                if record.get(field) != value:
                    errors.append(f"{key}: {field} must be {value}")
            for field in ("harness_revision", "oracle_gate_digest"):
                if not isinstance(record.get(field), str) or not record[field].strip():
                    errors.append(f"{key}: missing {field}")
            revision = record.get("harness_revision")
            if not isinstance(revision, str) or re.fullmatch(r"[0-9a-f]{40}", revision) is None:
                errors.append(f"{key}: harness revision must be a full commit SHA")
            if isinstance(revision, str):
                revisions.setdefault(arm, set()).add(revision)
            digest = record.get("oracle_gate_digest")
            if isinstance(digest, str):
                digests.add(digest)
        else:
            fixture = record.get("oracle")
            if not isinstance(fixture, dict) or any(fixture.get(f) is not True for f in ("inputs_verified", "positive_outputs_copied")) or fixture.get("skipped") is not False:
                errors.append(f"{key}: oracle fixtures unverified or skipped")
    for key in sorted(expected - seen):
        errors.append(f"missing: {key}")
    if paired and any(len(values) != 1 for values in revisions.values()):
        errors.append("each comparison arm must use one immutable harness revision")
    if paired and len(digests) != 1:
        errors.append("paired runs must cite one oracle gate receipt")
    return {"passed": not errors, "errors": errors, "attempted": len(seen), "expected": len(expected)}


def validate_oracle(records: list[dict], task_ids: list[str]) -> dict:
    return _validate(records, task_ids, False)


def validate_pair(records: list[dict], task_ids: list[str]) -> dict:
    return _validate(records, task_ids, True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("oracle", "pair"))
    parser.add_argument("records", type=Path, help="JSON array of normalized episode receipts")
    parser.add_argument("--oracle-receipt", type=Path, help="required for pair; successful oracle gate JSON")
    args = parser.parse_args()
    roster_path = Path(__file__).with_name("docker_support.txt")
    roster = [line.strip() for line in roster_path.read_text().splitlines() if line.strip() and not line.startswith("#")]
    if len(roster) != 99:
        parser.error("pinned Docker roster must contain 99 tasks")
    raw = args.records.read_bytes()
    records = json.loads(raw)
    if not isinstance(records, list):
        parser.error("records must be a JSON array")
    result = (validate_oracle if args.mode == "oracle" else validate_pair)(records, roster)
    if args.mode == "pair":
        if args.oracle_receipt is None:
            parser.error("pair requires --oracle-receipt")
        oracle_raw = args.oracle_receipt.read_bytes()
        oracle = json.loads(oracle_raw)
        if (not isinstance(oracle, dict) or oracle.get("passed") is not True or
                oracle.get("errors") != [] or
                not isinstance(oracle.get("records_sha256"), str) or
                re.fullmatch(r"[0-9a-f]{64}", oracle["records_sha256"]) is None or
                oracle.get("mode") != "oracle" or
                oracle.get("upstream_revision") != UPSTREAM_REVISION or
                oracle.get("roster_sha256") != hashlib.sha256(roster_path.read_bytes()).hexdigest() or
                oracle.get("expected") != 99 or oracle.get("attempted") != 99):
            result["errors"].append("oracle gate receipt is incomplete or belongs to another roster")
        digest = "sha256:" + hashlib.sha256(oracle_raw).hexdigest()
        if any(record.get("oracle_gate_digest") != digest for record in records if isinstance(record, dict)):
            result["errors"].append("paired records do not cite the supplied oracle receipt")
        result["passed"] = not result["errors"]
    result.update(mode=args.mode, upstream_revision=UPSTREAM_REVISION,
                  roster_sha256=hashlib.sha256(roster_path.read_bytes()).hexdigest(),
                  records_sha256=hashlib.sha256(raw).hexdigest())
    print(json.dumps(result, indent=2, allow_nan=False))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

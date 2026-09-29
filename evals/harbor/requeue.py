#!/usr/bin/env python3
"""Move a job's infrastructure trials aside so `harbor jobs resume` re-runs them.

    python3 requeue.py <job-dir>        # then: harbor jobs resume -p <job-dir>

Run it only when no harbor process is working on the job: an unfinished
trial is then one a dead process left behind, and it is moved too (resume
would otherwise keep its result.json and never re-run it). The workspaces
those trials left running in PLUE_REPO are deleted through SMITHERS_CLI.

`harbor jobs resume -f <type>` filters by exception type alone and deletes
the evidence. The health rule is not type-only (an agent's exit 255 is infra
when OpenSSH printed it; an agent outcome with no grade is infra), so this
applies `outcome.classify` and moves each infra trial to
`<job-dir>.infra/<trial>` instead. Prints how many moved.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import outcome
import workspace_ownership


def requeue(job: Path) -> list[str]:
    aside = job.parent / f"{job.name}.infra"
    moved = []
    for trial in sorted(job.iterdir()):
        result = trial / "result.json"
        if not trial.is_dir() or not result.is_file():
            continue
        try:
            data = json.loads(result.read_text())
        except (OSError, ValueError):
            continue
        if outcome.classify(data) not in ("infra", "running"):
            continue
        # Keep attempts discoverable until cleanup succeeds.
        reap([trial.name])
        aside.mkdir(exist_ok=True)
        target = aside / trial.name
        n = 1
        while target.exists():
            n += 1
            target = aside / f"{trial.name}.{n}"
        shutil.move(str(trial), str(target))
        moved.append(trial.name)
    return moved


def _reap(trials: list[str] | None) -> list[str]:
    """Delete only IDs recorded by create; workspace names confer no ownership."""
    cli, repo = os.environ.get("SMITHERS_CLI", "smithers"), os.environ.get("PLUE_REPO", "").strip()
    if trials == []:
        return []
    matching = [row for row in workspace_ownership.records() if trials is None or any(
        row["session"] == trial + "__env" or row["session"].startswith(trial + "__verifier__")
        for trial in trials)]
    owned = [row for row in matching if row["repo"] == repo]
    if matching and ("/" not in repo or (trials is not None and not owned)):
        raise ValueError("PLUE_REPO does not match workspace receipts; cleanup refused")
    if not owned:
        return []
    deleted, failed = [], []
    for receipt in owned:
        ident = receipt["id"]
        if trials is None:
            detail = subprocess.run([cli, "workspace", "view", ident, "--repo", repo, "--format", "json"],
                                    capture_output=True, text=True, timeout=120, check=False)
            data = json.loads(detail.stdout)
            if detail.returncode:
                error = data.get("error") or {}
                if workspace_ownership.is_missing(error.get("code", ""), error.get("message", "")):
                    workspace_ownership.forget(repo, ident)
                    continue
                raise RuntimeError(f"workspace view failed for {ident}; receipt retained")
            data = data.get("data", data)
            if data.get("id") != ident:
                raise ValueError("workspace view returned a different ID; receipt retained")
            if data.get("status") not in ("failed", "suspended"):
                continue
        result = subprocess.run([cli, "workspace", "delete", ident, "--yes", "--repo", repo, "--format", "json"],
                                capture_output=True, text=True, timeout=300, check=False)
        missing = False
        if result.returncode:
            try:
                envelope = json.loads(result.stdout)
                error = envelope.get("error") or {}
                missing = workspace_ownership.is_missing(error.get("code", ""), error.get("message", ""))
            except (ValueError, AttributeError):
                pass
        if result.returncode and not missing:
            failed.append(ident)
            continue
        workspace_ownership.forget(repo, ident)
        deleted.append(ident)
    if failed:
        raise RuntimeError(f"workspace delete failed; receipts retained: {', '.join(failed)}")
    return deleted


def reap(trials: list[str]) -> list[str]:
    """Delete recorded agent/verifier IDs for the selected trials."""
    return _reap(trials)


def reap_dead() -> list[str]:
    """Delete recorded IDs that the repository reports failed or suspended."""
    return _reap(None)


if __name__ == "__main__":
    if sys.argv[1:] == ["--reap-dead"]:
        print(f"deleted {len(reap_dead())} dead trial workspaces")
        sys.exit(0)
    names = requeue(Path(sys.argv[1]))
    print(f"requeued {len(names)}: {' '.join(names)}")

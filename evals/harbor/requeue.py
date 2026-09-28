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
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import outcome  # noqa: E402


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
        aside.mkdir(exist_ok=True)
        target = aside / trial.name
        n = 1
        while target.exists():
            n += 1
            target = aside / f"{trial.name}.{n}"
        shutil.move(str(trial), str(target))
        moved.append(trial.name)
    return moved


def workspace_name(session_id: str) -> str:
    """plue_env._sanitize_name, without importing the Harbor adapter."""
    return (re.sub(r"[^a-z0-9-]+", "-", session_id.lower()).strip("-") or "trial")[:63]


def reap(trials: list[str]) -> list[str]:
    """Delete the agent and verifier workspaces the given trials left behind."""
    cli, repo = os.environ.get("SMITHERS_CLI", "smithers"), os.environ.get("PLUE_REPO", "")
    if not trials or "/" not in repo:
        return []
    listing = subprocess.run([cli, "workspace", "list", "--repo", repo, "--format", "json"],
                             capture_output=True, text=True, timeout=120)
    text = listing.stdout
    try:
        rows = json.loads(text[text.find("["):]) if "[" in text else []
    except ValueError:
        return []
    # Exactly each trial's own workspaces (`<trial>__env`, `<trial>__verifier__<key>`):
    # a bare prefix would also match trial `x-10`'s when requeuing `x-1`.
    envs = {workspace_name(f"{t}__env") for t in trials}
    verifiers = tuple(workspace_name(f"{t}__verifier__") + "-" for t in trials)
    deleted = []
    for row in rows:
        name, ident = str(row.get("name") or ""), row.get("id")
        if ident and (name in envs or name.startswith(verifiers)):
            subprocess.run([cli, "workspace", "delete", ident, "--yes", "--repo", repo, "--format", "json"],
                           capture_output=True, text=True, timeout=300)
            deleted.append(name)
    return deleted


def reap_dead() -> list[str]:
    """Delete trial workspaces (`…-env`, `…-verifier-<key>`) that are failed or
    suspended: trials create them with --idle-timeout 0, so either state means
    a dead VM that still holds host CPU and disk."""
    cli, repo = os.environ.get("SMITHERS_CLI", "smithers"), os.environ.get("PLUE_REPO", "")
    if "/" not in repo:
        return []
    listing = subprocess.run([cli, "workspace", "list", "--repo", repo, "--format", "json"],
                             capture_output=True, text=True, timeout=120)
    text = listing.stdout
    try:
        rows = json.loads(text[text.find("["):]) if "[" in text else []
    except ValueError:
        return []
    deleted = []
    for row in rows:
        name, ident, status = str(row.get("name") or ""), row.get("id"), row.get("status")
        trial_named = name.endswith("-env") or re.search(r"-verifier-[a-z0-9-]+$", name) is not None
        if ident and trial_named and status in ("failed", "suspended"):
            subprocess.run([cli, "workspace", "delete", ident, "--yes", "--repo", repo, "--format", "json"],
                           capture_output=True, text=True, timeout=300)
            deleted.append(name)
    return deleted


if __name__ == "__main__":
    if sys.argv[1:] == ["--reap-dead"]:
        print(f"deleted {len(reap_dead())} dead trial workspaces")
        sys.exit(0)
    names = requeue(Path(sys.argv[1]))
    print(f"requeued {len(names)}: {' '.join(names)}")
    reaped = reap(names)
    print(f"deleted {len(reaped)} orphaned workspaces: {' '.join(reaped)}")

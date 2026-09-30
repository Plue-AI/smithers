#!/usr/bin/env python3
"""Health of running Harbor jobs, by the rule in `outcome.py`.

    python3 health.py <jobs-dir> <out.md> <job> [<job> ...]

Writes the report and exits 3 when a job trips:

- infrastructure outcomes (anything but graded or a whitelisted agent
  outcome; see outcome.classify; CancelledError excluded, since it is the
  harness being stopped) are more than 20% of that job's trials that
  finished in the last hour, with at least 2 of them; or
- more than one scored trial looks broken: reward 0 in under 60 s of agent
  time, or graded with zero successful container commands.

Unplaceable tasks are listed apart and never trip. Infra trials are never
scored: `requeue.py` moves them aside and `harbor jobs resume` re-runs them.
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import outcome  # noqa: E402

INFRA_RATE = 0.20
WINDOW_SEC = 3600


def _load(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def _time(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def trial_rows(job: Path) -> list[dict]:
    rows = []
    for trial in sorted(job.iterdir()):
        if not trial.is_dir() or not (trial / "config.json").is_file():
            continue
        data = _load(trial / "result.json")
        exception = data.get("exception_info") or {}
        timing = data.get("agent_execution") or {}
        start, end = _time(timing.get("started_at")), _time(timing.get("finished_at"))
        meta = (data.get("agent_result") or {}).get("metadata") or {}
        reached = meta.get("container_commands")
        for name in ("smithers-run.json", "codex-account.json"):
            reached = reached or _load(trial / "agent" / name).get("containerCommands")
        rows.append({
            "trial": trial.name, "task": trial.name.split("__")[0], "kind": outcome.classify(data),
            "exception": exception.get("exception_type"),
            "message": (exception.get("exception_message") or "")[:160].replace("\n", " "),
            "reward": ((data.get("verifier_result") or {}).get("rewards") or {}).get("reward"),
            "finished_at": _time(data.get("finished_at")),
            "wall": (end - start).total_seconds() if start and end else None,
            "reached": reached,
        })
    return rows


def main(argv: list[str]) -> int:
    jobs_dir, out, names = Path(argv[0]), Path(argv[1]), argv[2:]
    now = datetime.now(timezone.utc)
    lines = [f"# TB4 health, {now.astimezone().strftime('%Y-%m-%d %H:%M %Z')}", ""]
    trips: list[str] = []
    horizon = now.timestamp() - WINDOW_SEC
    for name in names:
        job = jobs_dir / name
        if not job.is_dir():
            lines += [f"## {name}", "", "- not started", ""]
            continue
        rows = trial_rows(job)
        # Attempts Harbor retried in-process or requeue.py moved aside.
        aside = jobs_dir / f"{name}.infra"
        retried = trial_rows(aside) if aside.is_dir() else []
        kinds = Counter(r["kind"] for r in rows)
        scored = [r for r in rows if outcome.is_healthy(r["kind"])]
        solved = [r for r in scored if r["reward"] == 1.0]
        unplaceable = [r for r in rows if r["kind"] == "unplaceable"]
        recent = [r for r in rows + retried if r["finished_at"] and r["finished_at"].timestamp() >= horizon]
        # CancelledError means the harness process was stopped (a pause, a
        # restart, a crash the liveness check catches). It is retried like any
        # infra outcome but left out of the rate: counting it lets one pause
        # trip the next.
        recent_infra = [r for r in recent if r["kind"] == "infra" and r["exception"] != "CancelledError"]
        rate = len(recent_infra) / len(recent) if recent else 0.0
        if len(recent_infra) >= 2 and rate > INFRA_RATE:
            trips.append(f"{name}: {len(recent_infra)} of {len(recent)} trials finished in the last hour were infra ({rate:.0%})")
        broken = [r for r in scored if (r["reward"] == 0 and r["wall"] is not None and r["wall"] < 60)
                  or (isinstance(r["reached"], dict) and r["reached"].get("succeeded", 0) == 0)]
        if len(broken) > 1:
            trips.append(f"{name}: {len(broken)} scored trials look broken (reward 0 under 60 s, or no container command)")
        lines += [f"## {name}", "",
                  f"- trials {len(rows)}: {dict(kinds)}",
                  f"- solved {len(solved)} of {len(rows)} retained current trials",
                  f"- scored subset {len(scored)} trials ({len({r['task'] for r in scored})} tasks): "
                  f"{kinds['graded']} graded, {kinds['agent']} agent outcomes",
                  f"- infra last hour: {len(recent_infra)} of {len(recent)} finished ({rate:.0%}); attempts kept aside: {len(retried)}",
                  f"- unplaceable: {len(unplaceable)} trials ({len({r['task'] for r in unplaceable})} tasks)"]
        for r in unplaceable:
            lines.append(f"  - unplaceable {r['trial']} (task {r['task']}): {r['exception']} {r['message']}")
        for r in rows:
            if r["kind"] == "infra":
                lines.append(f"  - infra {r['trial']}: {r['exception']} {r['message']}")
        for r in broken:
            lines.append(f"  - broken {r['trial']}: wall {r['wall']} reached {r['reached']}")
        lines.append("")
    if trips:
        lines += ["## TRIPPED", ""] + [f"- {t}" for t in trips] + [""]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 3 if trips else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

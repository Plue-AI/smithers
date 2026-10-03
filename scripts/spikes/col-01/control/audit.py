#!/usr/bin/env python3
"""Audit completed controls without rewriting measurements or summaries."""
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import sys

directory = Path(sys.argv[1])
if (directory / "control-audit.json").exists():
    raise RuntimeError("Refusing to overwrite an existing control audit")
environment = json.loads((directory / "env.json").read_text())
deviation = environment["deviation"]
context = "Host-only writes; " + deviation
audits = []
for name in ["control", "one-exec-control"]:
    csv_path = directory / f"{name}.csv"
    summary_path = directory / f"{name}-summary.json"
    original_csv = csv_path.read_bytes()
    original_summary = summary_path.read_bytes()
    rows = list(csv.DictReader(io.StringIO(original_csv.decode())))
    summary = json.loads(original_summary)
    assert len(rows) == 100, (name, "wrong sample count", len(rows))
    assert [int(row["seq"]) for row in rows] == list(range(1, 101)), (name, "lost or reordered samples")
    durations = [int(row["write_ns"]) for row in rows]
    assert all(duration > 0 for duration in durations), (name, "nonpositive write timing")
    for index, row in enumerate(rows, 1):
        content = f"write={index}\n" + "".join(
            f"line {line:03d}: collaboration control seed content\n"
            for line in range(2, 401)
        )
        data = content.encode()
        assert int(row["content_bytes"]) == len(data), (name, index, "payload size")
        assert row["sha256"] == hashlib.sha256(data).hexdigest(), (name, index, "payload hash")
    ordered = sorted(durations)
    computed = {
        "n": len(rows),
        **{f"p{percentile}_ns": ordered[math.ceil(len(rows) * percentile / 100) - 1]
           for percentile in [50, 95, 99]},
    }
    for key, value in computed.items():
        assert summary[key] == value, (name, key, summary[key], value)
    assert summary["all_readbacks_verified"] is True, (name, "readbacks not verified")
    assert "no warm-up discarded" in summary["method"], (name, "method mismatch")
    audits.append({
        "series": name,
        "status": "passed",
        "recomputed": {key: {"value": value, "deviation": context} for key, value in computed.items()},
        "sample_sequence": "exactly 1 through 100, original order preserved",
        "content": "all 400-line sequence payload byte counts and SHA-256 match independent reconstruction",
        "source_csv": csv_path.name,
        "source_summary": summary_path.name,
        "source_csv_sha256": hashlib.sha256(original_csv).hexdigest(),
        "source_summary_sha256": hashlib.sha256(original_summary).hexdigest(),
    })
audit = {"status": "passed", "audit_method": "Independent nearest-rank percentile and payload hash reconstruction; original CSV and summaries remain byte-identical", "deviation": context, "series": audits}
(directory / "control-audit.json").write_text(json.dumps(audit, indent=2) + "\n")
(directory / "control-topology.json").write_text(json.dumps({"deviation": context, "host_only": True, "source_environment": "env.json", "series": [{"summary": item["source_summary"], "csv": item["source_csv"], "numbers_with_context": item["recomputed"]} for item in audits]}, indent=2) + "\n")
print(json.dumps(audit, indent=2))

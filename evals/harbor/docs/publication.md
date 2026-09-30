---
title: "Benchmark publication"
description: "Publish a paired Smithers and baseline run only when it is complete, sealed and measured."
---

```bash
python3 -B evals/harbor/report.py <smithers-job> <baseline-job> <out-dir>
```

The first job runs `SmithersAgent`; the second runs the baseline, such as
`PooledCodex`. The command writes `report.md` and `report.json` to
`<out-dir>`, exits `0` when the run is publishable, and exits `3` with every
reason when it is not. A refused report has no pass rates.

A publishable run meets every rule:

| Rule     | Requirement                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------- |
| Same run | One dataset, model, environment and attempt count; every trial ran them; no timeout overrides   |
| Finished | Every planned trial retained; none running or infrastructure                                    |
| Paired   | Each task has one checksum and exactly the planned scored attempts in both arms                 |
| Size     | At least 50 paired tasks (`--min-tasks`); unplaceable tasks leave both arms and are listed      |
| Measured | Every scored trial reports input, cached and output tokens                                      |
| Sealed   | No extra allowed hosts or mounts; a command exited 0 in the task container; host audit clean    |

The pass rate is the mean verifier reward over every scored trial of the
paired tasks. `report.json` names each trial and its `agent/trajectory.json`.

Run [benchmark health](health.md) while a job runs. The full paired
Terminal-Bench 4.0 run is tracked in
[#1917](https://github.com/smithersai/smithers/issues/1917) and publication
in [#1846](https://github.com/smithersai/smithers/issues/1846).

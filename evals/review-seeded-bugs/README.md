# Review Seeded-Bug Eval

Sixteen fixture repositories with known outcomes, used to measure the review
app. Each fixture has a `base/` tree, a `head/` tree, and a `label.json`. Twelve
plant one labelled defect; four are clean controls that should produce no
findings.

Fixtures carry regular files only. `fixtureRepo.ts` refuses a symbolic link or
a git control file (`.git`, `.gitattributes`, `.gitmodules`, in any letter
case) anywhere under `base/` or `head/`. It also refuses a fixture, `base/`, or
`head/` directory that is itself a symbolic link. `fixtureRepo.test.ts` fails
the build if the corpus holds any of these.

Covered bug classes:

- `missing-await`
- `off-by-one-boundary`
- `sql-injection`
- `resource-leak`
- `deleted-null-check`
- `tautological-test`
- `cross-file-signature-mismatch`

`score.ts` is the deterministic scorer. It performs no I/O and calls no model:
it matches findings to labels by relative path and line-anchor tolerance, then
reports recall, precision, F1, anchor accuracy, and severity calibration.

## What the gate measures

```bash
node evals/review-seeded-bugs/run.ts
```

This is the default run, and it is offline. Every fixture is materialized as a
real git repository, the real review flow runs over its real diff, and the
reviewing seat is `deterministicReviewer.ts` — a small pattern-matching reviewer
that reads the same per-file prompt a model reads and never sees `label.json`.

`baseline.json` is that run's per-fixture score, so a red gate means the
**pipeline** moved: diff ingestion, per-file fan-out, scoping, anchoring,
de-duplication, or the scorer's matching. It does not mean a model regressed,
because no model ran.

A record keeps the fixture's status and counts plus one anchor per planted bug,
holding the line the review anchored to and the severity it assigned. A finding
that slides inside the three-line match tolerance, or that keeps its line and
drops from critical to info, leaves the counts alone and still fails the gate.

Re-record deliberately, and only when you can name what changed:

```bash
node evals/review-seeded-bugs/run.ts --update
```

## What the live run measures

```bash
node evals/review-seeded-bugs/run.ts --live
```

The same suite against real seats, credentialed the way the CLI is
(`SMITHERS_REVIEW_SEAT`, `ANTHROPIC_API_KEY`, and friends). It spends real
inference budget, writes a timestamped report under `.report/`, and never
touches `baseline.json`: a model's score is not reproducible and must not gate a
build. Its numbers belong in `SCORECARD.md`.

`.report/` is gitignored; do not commit live run outputs.

## The unit suites

```bash
bun test evals/review-seeded-bugs
```

`score.test.ts` validates corpus integrity and the scoring math.
`deterministicReviewer.test.ts` pins the offline reviewer's diff parsing, its
signals, and the structural guarantee that it reads nothing but its prompt.
Both are free and touch no network.

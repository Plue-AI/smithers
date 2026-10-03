# C-PRC-01 Declared-input existence in //:targetIndex and the drift set at landing

Proves: spec.md §21.2 · Layer: integration · Stage: S1 · Tickets: T-PRC-01
Automation: `scripts/check-process-gates.test.mjs` (new) · Runs in: CI (isolated fixture checkout; no live push or issue write)

## Setup

An isolated fixture checkout with a recorded commit and command logs. Stub remote writes only; execute the local production gate.

## Steps

1. Index a valid fixture, then rename a declared input without changing its declaration.
2. Exercise file, paths, workflows, glob, brace-expansion and ignore-rule fixtures.
3. Attempt landing with stale workflow input, generated drift, tracked temporary-path leakage and a conflict marker.
4. Land a clean fixture and inspect the per-SHA drift configuration.

## Pass when

- Missing inputs fail with source and resolved path; valid declarations pass.
- Every drift failure prevents push; a clean fixture reaches the push seam after all five gates pass.
- Drift includes //:ci, never cancels another SHA and is required on main.

## Fail when

- A defective fixture reaches the push or close seam.
- A valid fixture fails, or prose PASS claims replace observed output.

## Evidence

`.artifacts/checks/C-PRC-01/<ts>/`: fixture inputs, per-step command logs and exit codes, refusal assertions, log digests and tested commit. T-PRC-03 adds receipt.json when its runner lands.

# C-PRC-03 Check receipts required to close a ticket

Proves: spec.md §21.4 · Layer: integration · Stage: S1 · Tickets: T-PRC-03
Automation: `scripts/check-receipts.test.mjs` (new) · Runs in: CI (isolated fixture checkout; no live push or issue write)

## Setup

An isolated fixture checkout with a recorded commit and command logs. Stub remote writes only; execute the local production gate.

## Steps

1. Run a fixture check, inspect its receipt and recompute its log digest.
2. Invoke the runner with absent automation and a to write declaration.
3. Attempt close with no receipts, incomplete coverage, failed exit, different commit and altered log.
4. Close a fixture ticket using passing receipts for every named check at its landed commit.

## Pass when

- Receipt fields equal the observed command, commit, layer, times, exit and log digest.
- Absent or unwritten automation creates no passing receipt.
- Every invalid receipt set exits 2 before closing; complete passing receipts permit exactly one close.

## Fail when

- A defective fixture reaches the push or close seam.
- A valid fixture fails, or prose PASS claims replace observed output.

## Evidence

`.artifacts/checks/C-PRC-03/<ts>/`: fixture inputs, per-step command logs and exit codes, refusal assertions, log digests and tested commit. T-PRC-03 adds receipt.json when its runner lands.

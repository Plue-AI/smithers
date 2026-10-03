# C-PRC-03 Check receipts required to close a ticket

Proves: spec.md §21.4 · Layer: integration · Stage: S1 · Tickets: T-PRC-03
Automation: `scripts/check-receipts.test.mjs` (new) · Runs in: CI (isolated fixture checkout; no live push or issue write)

## Setup

An isolated fixture checkout in a machine with literal check coverage, landed commit, commands, layers and refusal outcomes. Invoke production scripts/check-run.mjs and scripts/issue-claim.mjs comment --close; intercept remote GitHub writes only. Fixture check documents are parser input; no test derives expectations from engineering/product Markdown or production code.

## Steps

1. Run a fixture check on its declared CI host. Inspect version-1 receipt fields and independently recompute the log digest. Assert all three publication variables absent and issue-claim configuration unreadable.
2. Invoke the runner with absent, unwritten and unparsable Automation and an unavailable declared host. Run a failed fixture command.
3. Attempt close with no receipts, incomplete coverage, failed exit, different commit and altered log, using --release, omitted --release and --force variants. Assert exit 2 and zero comment, release or close writes.
4. Test missing --landed, non-full SHA, non-ancestor of origin/main, free-text --note, invented coverage, symlink receipts/logs/parent directories, .. components and realpath escape. Required check IDs come from the ticket.
5. Refuse machine execution; assert no passing receipt and no issue writes. Keep publication credentials out of the fixture check process.
6. Close using passing receipts for every named ticket check with receipt.commit equal to --landed <sha>, verified as an ancestor of origin/main. Repeat without --release and with --force. Test a held claim separately.

## Pass when

- Literal receipt fields are `{version: 1, check, commit, layer, command, exit, started, ended, log_digest}`: full commit SHA, integer exit, ISO UTC timestamps and `sha256:<hex>`. Values match observed command, layer, time bounds and independently hashed logs.
- Execution uses the declared host, no GH_TOKEN/GITHUB_TOKEN/SMITHERS_GITHUB_PROXY, and unreadable ~/.config/issue-claim. Publication credentials remain behind issue-claim write().
- Absent, unwritten or unparsable Automation and unavailable hosts create no passing receipt. Failed commands remain failed evidence.
- Invalid evidence exits 2 with `action: "evidence-refused"` and per-check `{check, receipt?, reason: missing|coverage|failed|commit|digest}` before comment, release or close writes. Held claims retain `action: "refused"`.
- Landed ancestry, exact receipt.commit, ticket-derived coverage and receipt/log path confinement are enforced. Symlinks and .. are refused. Complete passing evidence permits exactly one close.

## Fail when

- A defective fixture reaches the push or close seam.
- A valid fixture fails, or prose PASS claims replace observed output.

## Evidence

`.artifacts/checks/C-PRC-03/<ts>/`: fixture inputs, per-step command logs and exit codes, refusal assertions, log digests and tested commit. T-PRC-03 adds receipt.json when its runner lands.

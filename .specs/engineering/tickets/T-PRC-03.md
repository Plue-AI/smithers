# T-PRC-03 Check receipts required to close a ticket

Stage S1 · Size S · Depends on — · Unblocks T-REL-02 · Issue: [#3615](https://github.com/smithersai/smithers/issues/3615)
Spec: spec.md §21.4 · Delta: delta.md (engineering process) · Product: mvp.md §12.1 (acceptance evidence) · Owner: smithers-22

## Goal

A ticket closes only with a machine-written receipt for every named check, bound to the landed commit. `scripts/check-run.mjs C-XXX-NN` runs its `Automation:` command, refuses an absent path or `to write` declaration, and writes `.artifacts/checks/<id>/<ts>/receipt.json` with `{check, commit, layer, command, exit, started, ended, log_digest}`. `issue-claim.mjs comment --release --close --receipt <path>...` requires passing receipts for every named check at the landed commit and verifies log digests. Missing, failed or mismatched evidence exits 2 before the issue write. Reports list receipts; prose PASS claims do not close tickets.

## Scope

In:
- `scripts/check-run.mjs` (new): parse Automation, execute the declared command, hash the log and write the receipt after completion.
- `scripts/issue-claim.mjs`: gate comment --release --close on receipt coverage, successful exit, landed commit and log digest.
- `.specs/engineering/tickets/README.md` and checks/README.md: require receipts for completion; reports list receipt paths.

Out:
- Product runtime behavior and unrelated repairs.

## Changes

- `scripts/check-run.mjs` (new): parse Automation, execute the declared command, hash the log and write the receipt after completion.
- `scripts/issue-claim.mjs`: gate comment --release --close on receipt coverage, successful exit, landed commit and log digest.
- `.specs/engineering/tickets/README.md` and checks/README.md: require receipts for completion; reports list receipt paths.

## Tests

- integration: `scripts/check-receipts.test.mjs` implements C-PRC-03 with positive and refusal fixtures.

## Acceptance

- [C-PRC-03](../checks/C-PRC-03.md): every Pass when assertion holds.

## Risks and notes

- Use an isolated fixture issue writer; the check closes no live issue.

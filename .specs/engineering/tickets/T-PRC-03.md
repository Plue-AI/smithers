# T-PRC-03 Check receipts required to close a ticket

Stage S1 · Size S · Depends on — · Unblocks T-REL-02 · Issue: [#3615](https://github.com/smithersai/smithers/issues/3615)
Spec: spec.md §21.4 · Delta: delta.md (engineering process) · Product: mvp.md §12.1 (acceptance evidence) · Owner: smithers-22

## Goal

A ticket closes only with a machine-written receipt for every named check, bound to the landed commit. `scripts/check-run.mjs C-XXX-NN` runs its `Automation:` command, refuses an absent path or `to write` declaration, and writes `.artifacts/checks/<id>/<ts>/receipt.json` with `{check, commit, layer, command, exit, started, ended, log_digest}`. `issue-claim.mjs comment --release --close --receipt <path>...` requires passing receipts for every named check at the landed commit and verifies log digests. Missing, failed or mismatched evidence exits 2 before any issue write, including comment or claim release. Validate whenever `comment --close` is requested, with or without `--release`; `--force` does not bypass evidence. Reports list receipts; prose PASS claims do not close tickets. smithers-22 accepts check-to-command mapping and landed-commit verification; smithers-8a decides named-check coverage for the ticket; smithers-b8 signs off CLI errors and receipt contract.

## Scope

In:
- `scripts/check-run.mjs` (new): resolve Automation to an executable command, refuse absent paths and unwritten declarations, execute it in a machine, write `log.txt` beside `receipt.json`, hash the completed log and write the receipt after completion. smithers-22 approves explicit command mappings for Automation rows that currently name only test paths; no guessed command or prose PASS creates a receipt.
- `scripts/issue-claim.mjs`: gate every comment --close variant on receipt coverage, successful exit, landed commit and log digest before comment, release or close writes. Reuse the production proxy write path; intercept only that remote seam in tests.
- `.specs/engineering/tickets/README.md` and checks/README.md: require receipts for completion; reports list receipt paths.

Out:
- Product runtime behavior, implementing the checks this runner invokes, closing live issues in acceptance tests, changing claim arbitration, release/deploy approval policy, and a receipt bypass via --force or omitted --release. This ticket adds no product table or hosted evidence service.

## Changes

- `scripts/check-run.mjs` (new): resolve Automation to an executable command, refuse absent paths and unwritten declarations, execute it in a machine, write `log.txt` beside `receipt.json`, hash the completed log and write the receipt after completion. smithers-22 approves explicit command mappings for Automation rows that currently name only test paths; no guessed command or prose PASS creates a receipt.
- `scripts/issue-claim.mjs`: gate every comment --close variant on receipt coverage, successful exit, landed commit and log digest before comment, release or close writes. Reuse the production proxy write path; intercept only that remote seam in tests.
- `.specs/engineering/tickets/README.md` and checks/README.md: require receipts for completion; reports list receipt paths.

## Tests

- Integration: `scripts/check-receipts.test.mjs` (new) executes production `scripts/check-run.mjs C-XXX-NN` with a fixture check command in a machine, then production `scripts/issue-claim.mjs comment --release --close --receipt <path>...` against an isolated fixture issue writer. Exercise `comment --close` without --release and with --force too. Only remote GitHub writes are intercepted; receipt parsing, commit binding, coverage and log hashing run unchanged. Literal fixtures name the ticket’s checks, landed commit, command, layer, exit and expected write count; timestamps are checked against observed start/end bounds. Missing, incomplete, failed, stale-commit or altered-log evidence exits 2 and writes nothing; complete matching evidence closes exactly once. The runner refuses missing/to-write automation and records a failed command as failed evidence. No test reads engineering/product Markdown to derive expectations or obtains expected policy from production code; fixture check documents are parser input, not the oracle.

## Acceptance

- [C-PRC-03](../checks/C-PRC-03.md): every Pass when assertion holds.

## Risks and notes

- Use an isolated fixture issue writer; the check closes no live issue. Before enabling closure enforcement, smithers-22 inventories each named check’s executable Automation mapping and smithers-8a accepts coverage; an unimplemented check remains uncloseable, not waived. This is an operational activation prerequisite, not a dependency on the checks’ implementation tickets.
- Automation commands and repository test code execute only in machines under M-29. The runner never evaluates a check document as host shell code; dispatch a validated command to the machine and bind the result to its tested commit. Keep publication credentials in the trusted issue writer, outside the check process. smithers-3f reviews execution and receipt/log path confinement; smithers-b8 reviews the CLI-to-writer boundary. C-PRC-03 proves execution refusal creates no passing receipt and reaches no issue write.

## Ready checklist

1. Dependencies: no MVP runtime prerequisite is added; existing issue-claim proxy write path and isolated fixture writer supply the base. Machine execution and approved executable Automation mappings are prerequisites to activation; unavailable checks fail closed.
2. Exclusions: check implementation, live-issue testing, claim-policy changes, deploy/release policy and receipt bypasses are explicit.
3. Boundary: C-PRC-03 exercises the production runner and comment --close command variants, intercepting remote writes only, with literal check coverage, commit and refusal expectations.
4. Decisions: smithers-22 accepts executable mappings and commit verification; smithers-8a accepts named-check coverage; smithers-b8 approves CLI/receipt contract; smithers-3f approves execution and path confinement.
5. Owner pre-review before start: smithers-b8 asks: Do all comment --close variants validate before every write? Are receipt errors and the persisted contract stable? smithers-3f asks: Can Automation execute only in a machine without publication credentials? Are receipt/log reads confined and bound to the tested commit? smithers-22 asks: Which path-only Automation entries need explicit executable mappings?
6. Security: repository Automation and tests execute only in machines under M-29; publication credentials stay with the trusted writer. smithers-3f reviews command/path confinement; smithers-b8 reviews fail-closed CLI dispatch. C-PRC-03 covers execution refusal and zero writes on invalid evidence.


# T-PRC-03 Check receipts required to close a ticket

Stage S1 · Size S · Depends on — · Unblocks T-REL-02 · Issue: [#3615](https://github.com/smithersai/smithers/issues/3615)
Spec: spec.md §21.4 · Delta: delta.md (engineering process) · Product: mvp.md §12.1 (acceptance evidence) · Owner: smithers-22
Ready: 2026-10-02 smithers-8a sha256:398385973e06

## Goal

A ticket closes only with a machine-written receipt for every named check, bound to `--landed <sha>`. `scripts/check-run.mjs C-XXX-NN` runs an approved executable mapping on the check’s declared `Runs in` host. It refuses absent, unwritten or unparsable mappings. It writes `.artifacts/checks/<id>/<ts>/receipt.json` with `{version: 1, check, commit, layer, command, exit, started, ended, log_digest}`. `commit` is a full SHA; `exit` is an integer; `started` and `ended` are ISO UTC timestamps; `log_digest` is `sha256:<hex>`. Every `comment --close` variant requires `--landed <sha>` and passing receipts for all ticket checks before any comment, release or close write. `--note` is free text and is never commit evidence. `--force` and omitted `--release` do not bypass evidence. Refusal exits 2 with `action: "evidence-refused"` and per-check `{check, receipt?, reason: missing|coverage|failed|commit|digest}`, distinct from held-claim `action: "refused"`. Check: C-PRC-03.

## Scope

In:
- `scripts/check-run.mjs` (new): map Automation explicitly to an executable command and its declared `Runs in` host. Refuse absent paths, unwritten declarations, unparsable Automation and unavailable declared hosts. Execute with a scrubbed environment: no `GH_TOKEN`, `GITHUB_TOKEN` or `SMITHERS_GITHUB_PROXY`; `~/.config/issue-claim` is unreadable to the check process. Write `log.txt` beside `receipt.json`, hash the completed log and write the version-1 receipt after completion. Publication credentials stay behind `issue-claim.mjs` write(). smithers-22 approves each mapping; no guessed command or prose PASS creates a receipt. Check: C-PRC-03.
- `scripts/issue-claim.mjs`: require `--landed <sha>` for every `comment --close` variant; verify a full SHA that is an ancestor of `origin/main`. Derive required check IDs from the ticket, not caller-supplied coverage. Require each receipt’s `commit` to equal that SHA and verify version, successful integer exit, ISO UTC timestamps and log digest. Resolve receipts and sibling logs under `.artifacts/checks/`; refuse symlinks in either path and `..` components before reading, then verify realpath confinement. Refuse before every issue write with exit 2, `action: "evidence-refused"` and per-check `{check, receipt?, reason: missing|coverage|failed|commit|digest}`. Keep held-claim exit 2 as `action: "refused"`. Reuse the production proxy write path; tests intercept only remote writes. Check: C-PRC-03.
- Completion reports list receipt paths.

Out:
- Product runtime behavior, check implementations, live-issue closure in tests, claim arbitration changes, release/deploy policy, a hosted evidence service and any receipt bypass. M-29 governs branch machines and does not require this engineering runner to execute on a machine. Check: C-PRC-03.

## Changes

- `scripts/check-run.mjs` (new): map Automation explicitly to an executable command and its declared `Runs in` host. Refuse absent paths, unwritten declarations, unparsable Automation and unavailable declared hosts. Execute with a scrubbed environment: no `GH_TOKEN`, `GITHUB_TOKEN` or `SMITHERS_GITHUB_PROXY`; `~/.config/issue-claim` is unreadable to the check process. Write `log.txt` beside `receipt.json`, hash the completed log and write the version-1 receipt after completion. Publication credentials stay behind `issue-claim.mjs` write(). smithers-22 approves each mapping; no guessed command or prose PASS creates a receipt. Check: C-PRC-03.
- `scripts/issue-claim.mjs`: require `--landed <sha>` for every `comment --close` variant; verify a full SHA that is an ancestor of `origin/main`. Derive required check IDs from the ticket, not caller-supplied coverage. Require each receipt’s `commit` to equal that SHA and verify version, successful integer exit, ISO UTC timestamps and log digest. Resolve receipts and sibling logs under `.artifacts/checks/`; refuse symlinks in either path and `..` components before reading, then verify realpath confinement. Refuse before every issue write with exit 2, `action: "evidence-refused"` and per-check `{check, receipt?, reason: missing|coverage|failed|commit|digest}`. Keep held-claim exit 2 as `action: "refused"`. Reuse the production proxy write path; tests intercept only remote writes. Check: C-PRC-03.
- Before activation, inventory and approve executable mappings for all named checks, including the reported unparsable Automation entries C-REL-01, C-STK-01, C-SPK-03, C-SPK-07, C-GH-01, C-DUR-03, C-UI-08, C-UI-13, C-MCH-05, C-AGT-01, C-AGT-02 and C-MNT-01 through C-MNT-06. Refuse each unmapped entry until its owner supplies a command and declared host. Check: C-PRC-03.

## Tests

- `scripts/check-receipts.test.mjs` (new) runs the production runner on the fixture check’s declared CI host, then production `comment --release --close --landed <sha> --receipt <path>...` against an isolated fixture writer. Exercise `comment --close` without `--release` and with `--force`. Intercept remote writes only. Assert literal `version: 1`, full commit SHA, integer exit, ISO UTC timestamps, `sha256:<hex>`, check IDs, command, layer and write count; independently hash logs and compare times with observed bounds. Complete matching evidence closes exactly once. Check: C-PRC-03.
- Missing, incomplete, failed, wrong-commit and altered-log evidence exits 2 with literal `action: "evidence-refused"` and the per-check reason from `missing|coverage|failed|commit|digest`; assert optional receipt paths when supplied. A held claim returns the distinct `action: "refused"`. Test missing `--landed`, non-full SHA, a non-ancestor of `origin/main`, free-text `--note`, caller-invented coverage, malformed receipt fields, symlink receipts/logs/parents, `..` paths and realpath escape. Every refusal makes zero comment, release and close writes. Check: C-PRC-03.
- Run a credential canary on the declared host; assert all three publication environment variables absent and `~/.config/issue-claim` unreadable. An unavailable host or absent/unwritten/unparsable mapping creates no passing receipt and reaches no write. A failed command produces failed evidence. Fixture documents are parser input; expected policy comes from literal fixtures, never engineering/product Markdown or production code. Check: C-PRC-03.

## Acceptance

- [C-PRC-03](../checks/C-PRC-03.md): every Pass when assertion holds.

## Risks and notes

- Use an isolated fixture issue writer; the check closes no live issue. Before enabling closure enforcement, smithers-22 inventories each named check’s executable Automation mapping and smithers-8a accepts coverage; an unimplemented check remains uncloseable, not waived. This is an operational activation prerequisite, not a dependency on the checks’ implementation tickets.
- Execute mapped engineering automation only on the check’s declared host with the scrubbed environment and unreadable issue-claim configuration. Publication credentials remain behind the trusted writer’s write() boundary. M-29 governs branch machines, not this runner. smithers-3f reviews host selection and receipt/log confinement; smithers-b8 reviews the stable CLI refusal contract. C-PRC-03 proves credential exclusion, path refusal and zero writes on invalid evidence.

## Ready checklist

1. Dependencies: no MVP runtime prerequisite is added. The issue-claim proxy write path and isolated fixture writer supply the base. Approved executable mappings and available declared hosts gate activation; unavailable checks fail closed.
2. Exclusions: check implementation, live-issue testing, claim-policy changes, deploy/release policy and receipt bypasses are explicit.
3. Boundary: C-PRC-03 exercises the production runner and comment --close command variants, intercepting remote writes only, with literal check coverage, commit and refusal expectations.
4. Decisions: smithers-22 accepts executable mappings and commit verification; smithers-8a accepts named-check coverage; smithers-b8 approves CLI/receipt contract; smithers-3f approves execution and path confinement.
5. Owner pre-review: smithers-b8: answered, BLOCKING edits applied (tech lead adopts). smithers-3f: answered, BLOCKING edits applied (tech lead adopts). smithers-22 must accept executable mappings and named-check coverage before activation.
6. Security: execute on each check’s declared host with no GH_TOKEN, GITHUB_TOKEN or SMITHERS_GITHUB_PROXY and unreadable ~/.config/issue-claim. Publication credentials remain behind write(). Verify --landed ancestry and exact receipt commit; derive checks from the ticket; refuse symlinks, .. and realpath escape. C-PRC-03 proves confinement and zero writes.


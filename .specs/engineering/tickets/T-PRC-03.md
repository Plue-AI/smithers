# T-PRC-03 Check receipts required to close a ticket; one check runner

Stage S1 · Size S · Depends on — · Unblocks T-MCH-01, T-REL-02 · Issue: [#3615](https://github.com/smithersai/smithers/issues/3615)
Spec: spec.md §21.4–§21.4a · Delta: delta.md §11 (one check runner) · Product: mvp.md §12 item 1 (acceptance evidence), M-29 · Owner: smithers-22
Rescoped by the minimal-code synthesis, 2026-10-03 (v2 ruling 3; v1 §6 host-profile readers). #3663 is re-scoped to this ticket.
Ready: 2026-10-03 smithers-8a sha256:95198577c4ce

## Goal
A ticket closes only with a machine-written receipt for every named check, bound to `--landed <sha>`, and one check runner writes those receipts. A receipt is `.artifacts/checks/<id>/<ts>/receipt.json` with `{version: 1, check, commit, layer, command, exit, started, ended, log_digest}`; `commit` is a full SHA, `exit` an integer, times ISO UTC, `log_digest` `sha256:<hex>`. A receipt records CI's own result for the check's target at the landed SHA; it executes nothing locally.

## Scope
In:
- One runner, `scripts/check-run.mjs` (landed a109c5d0c). It maps Automation through `scripts/check-commands.json` to an approved smthrs target on CI, reads the check and mapping with `git show` at the required `--landed <sha>`, and records CI's own result. Argv mappings are not executable; map the check to a smthrs target. Absent, unwritten or unparsable mappings and non-CI hosts refuse.
- `scripts/issue-claim.mjs` close gate through `scripts/check-evidence.mjs` (`issue-claim.mjs:42`): every `comment --close` variant needs `--landed <sha>`, a full SHA that is an ancestor of `origin/main`, and passing receipts for the check IDs derived from the ticket. Receipts and logs resolve under `.artifacts/checks/` with no symlinks, no `..` and realpath confinement. Refusal exits 2 with `action: "evidence-refused"` and per-check `{check, receipt?, reason: missing|coverage|failed|commit|digest}`, distinct from held-claim `action: "refused"`. `--force` and `--note` never bypass evidence.
- Non-landing closes: `--reason not-planned|duplicate|superseded --note <link>` close with GitHub's `state_reason` and no receipts, never as completed.
- Enforcement is on with no switch. Each new check implementation adds its mapping in the same change. NEEDS-OWNER and MANUAL entries remain uncloseable until an approved CI target supplies evidence; an owner signature alone does not bypass the gate. C-PRC-03 proves both markers refuse.
- No new ticket code or schema is called: Depends on remains empty. Missing CI results, unapproved mappings and unavailable targets fail closed per check, without disabling the close gate. Lands dark until T-SEC-01 for mappings that rely on R1–R3: keep them pending-owner until its root-validation checks pass. Apply the same refusal until T-MCH-10 for R4 and T-FLW-01 for R5. These are mapping activation conditions, not recorder dependencies (C-PRC-03/root-check-mapping-validation).

Out: product runtime, check implementations, live-issue closure in tests, claim arbitration, release policy, a hosted evidence service, any bypass, local Automation execution, a second runner or qualifier, new host-profile readers, machine/bootstrap/toolchain/root setup, reference-host execution support and manual-receipt approval APIs.

## Changes
- Reuse `scripts/check-run.mjs`, `scripts/check-evidence.mjs`, `scripts/check-receipts.test.mjs`, `scripts/check-commands.json` and the `issue-claim.mjs` proxy write path.
- Duplicate runner, qualifier, obligation manifest and targets removed. Proposed bindings, including Playwright population contracts, are retained as unapproved `pendingBinding` data in `scripts/check-commands.json`.
- Duplicate host-profile and ops-health-line parsing removed. Checks needing host facts use the `/api/install` contract owned by T-INS-06; this recorder adds no API client or host-profile reader.
- Inventory mappings for every named check, including the unparsable entries C-REL-01, C-STK-01, C-SPK-03, C-SPK-07, C-GH-01, C-DUR-03, C-UI-08, C-UI-13, C-MCH-05, C-AGT-01, C-AGT-02 and C-MNT-01 through C-MNT-06. Retain unimplemented or unvalidated entries as pending-owner. smithers-22 approves each implemented mapping; smithers-8a accepts coverage; smithers-3f accepts security evidence for privileged targets. Extend the existing tests and `scripts/fixtures/check-receipts.mjs`; do not add a parallel harness.

## Tests

C-PRC-03 (folded steps and assertions):
1. C-PRC-03/recorder-to-close: invoke `node scripts/check-run.mjs C-FIX-01 --landed <sha>` against isolated GitHub transport and real results artifact zips, then pass its receipt through `issue-claim.mjs` production `run()` comment/close dispatch. Inspect version-1 receipt fields and independently recompute the log digest. Include a successful executable CLI close against an isolated proxy. Intercept only external transport; retain production parsing, verification, artifact extraction and write admission. Fixture check documents are inputs, never expectation sources. Hard-code expected check IDs, target labels, commands, statuses, refusal reasons and write counts in the test; do not derive them from mappings, spec files or production helpers at runtime. Use observed SHA/time only for identity and time-bound comparisons.
2. Invoke the runner with absent, unwritten and unparsable Automation and an unavailable declared host. Verify failed CI label results.
3. Attempt close with no receipts, incomplete coverage, failed exit, different commit and altered log, using --release, omitted --release and --force variants. Assert exit 2 and zero comment, release or close writes.
4. Test missing --landed, non-full SHA, non-ancestor of origin/main, free-text --note, invented coverage, symlink receipts/logs/parent directories, .. components and realpath escape. Required check IDs come from the ticket.
5. Refuse argv mappings even with CI=true; assert no receipt and no issue writes. Require --landed and approved target mappings without command or paths.
6. Close using passing receipts for every named ticket check with receipt.commit equal to --landed <sha>, verified as an ancestor of origin/main. Repeat without --release and with --force. Test a held claim separately.
7. C-PRC-03/root-check-mapping-validation: at the recorder and comment/close boundaries, keep mappings with missing owner-reviewed root-input validation evidence pending-owner. Verify exit 2, no passing receipt, no publication and no root/setup dispatch. A validated mapping reads only CI results; branch-built root executable bytes remain forbidden. Test MANUAL and pending-owner refusal with literal expectations.

Pass when:
- Literal receipt fields are `{version: 1, check, commit, layer, command, exit, started, ended, log_digest}`: full commit SHA, integer exit, ISO UTC timestamps and `sha256:<hex>`. Values match observed command, layer, time bounds and independently hashed logs.
- The runner records CI results only and executes no mapped argv. Closure re-reads CI for the issue repository. Publication credentials remain behind issue-claim write().
- Absent, unwritten or unparsable Automation and unavailable hosts create no passing receipt. Failed CI label results remain failed evidence.
- Invalid evidence exits 2 with `action: "evidence-refused"` and per-check `{check, receipt?, reason: missing|coverage|failed|commit|digest}` before comment, release or close writes. Held claims retain `action: "refused"`.
- Landed ancestry, exact receipt.commit, ticket-derived coverage and receipt/log path confinement are enforced. Symlinks and .. are refused. Complete passing evidence permits exactly one close.

Fail when:
- A defective fixture reaches the push or close seam.
- A valid fixture fails, or prose PASS claims replace observed output.

- `scripts/check-receipts.test.mjs` uses recorder-produced receipts for the passing path and synthetic receipts only for mutation/refusal cases, then `comment --release --close --landed <sha> --receipt <path>...` against an isolated fixture writer. Literal receipt fields; independent log hash; one close for complete evidence. Existing fixture helpers must stop deriving expected CI rows and receipt commands from mappings.
- Missing, incomplete, failed, wrong-commit and altered-log evidence; missing `--landed`, non-full SHA, non-ancestor, free-text `--note`, invented coverage, symlinks, `..` and realpath escape: each exits 2 with its literal reason and zero writes.
- Argv mappings refuse without execution. A receipt citing a CI check run at a different SHA is refused with `commit`.
- A read-only file/import inventory finds no duplicate runner under `scripts/checks`; retain the existing host-process sampler and its test. No VCS command is needed for this assertion.

## Acceptance
- [C-PRC-03](../checks/C-PRC-03.md): every Pass when assertion holds.

## Risks and notes
- Use an isolated fixture writer; the check closes no live issue. Before enforcement, smithers-22 inventories mappings and smithers-8a accepts coverage; an unimplemented check stays uncloseable, not waived.
- smithers-22 decides mapping approvals and receipt/CLI contract changes; smithers-8a accepts check coverage. smithers-3f signs off the CI artifact, credential and root-provenance boundaries. No ADR, product API or UI change is authorized.
- Security: the recorder and issue publication run unprivileged and execute no repository command, target, setup or root step. M-29 confines repository execution by the approved targets to unprivileged users inside machines. Target execution has GH_TOKEN, GITHUB_TOKEN and SMITHERS_GITHUB_PROXY absent and ~/.config/issue-claim unreadable; publication credentials stay behind issue-claim write(). smithers-3f reviews this separation (C-PRC-03).
- Recorder inputs are the caller's check ID, paths and landed SHA (member/branch data); ticket, check declaration, mapping, target label, approval identity and layer at the landed SHA (main ancestry verified before completed closure); origin/issue repository identity and GitHub main/CI run/artifact records (configured repository and GitHub); receipts/logs and artifact zip contents (untrusted data). Consume these only as data, validate ancestry, CI identity, digests and confined paths, and never execute artifact contents (C-PRC-03).
- This ticket has no root-input consumer. Root inventories and validation belong to T-SEC-01 (R1–R3), T-MCH-10 (R4), T-FLW-01 (R5), T-INS-03 (C-SPK-06) and T-TRM-06 (C-SPK-08). Before approving a mapping for a privileged target, smithers-3f requires that target's complete main/branch input inventory and named tests proving validation of every branch-sourced data input before root use. Missing evidence blocks that mapping, not this ticket's landing. Branch-built root executable, script, plist and toolchain bytes are forbidden regardless of test results. C-PRC-03/root-check-mapping-validation proves pending mappings fail closed.

## Ready checklist
1. Depends on —: reuse the landed recorder, verifier and issue writer; call no new ticket code/schema. Scope keeps unavailable targets and R1–R5 mappings dark until their named activation conditions pass.
2. Out of scope names local execution, duplicate runners/qualifiers, host readers, root setup, reference-host support, manual approval APIs and product surfaces.
3. C-PRC-03/recorder-to-close exercises the production recorder and comment/close command, including executable CLI closure; literal fixtures define expectations and independent hashes verify logs. Root-mapping refusal runs at those same boundaries.
4. smithers-22 approves mappings and receipt/CLI contracts; smithers-8a accepts coverage; smithers-3f accepts security boundaries. No ADR or product API change is in scope.
5. Owner pre-review: smithers-3f (infra/security): Are CI artifacts treated only as confined data? Are execution and publication credentials separated? Does each privileged mapping have a complete input inventory and named validation evidence before approval? smithers-b8 (CLI seam): Do all comment/close variants use the production gate? Are non-completion reasons and evidence refusals preserved? smithers-22 owns the scripts and smithers-8a reviews coverage; recorded owner answers stand and owners review post hoc under the parallel-build directive.
6. M-29 restricts repository code to unprivileged machine users; this recorder executes no repository payload or root step. smithers-3f reviews credential isolation and privileged-target mapping evidence; missing root-input validation keeps mappings dark (C-PRC-03/root-check-mapping-validation).

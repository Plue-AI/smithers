# T-GH-03 TODO PRs both ways: slug branch, body, item-only diff, drafts; checks, GitHub's refusal text, merged, closed, reopened, out-of-order merge

Stage S1 · Size M · Depends on T-STK-01, T-STK-02, T-STK-12, T-GH-02, T-GH-09, T-ACC-03, T-FLW-11, T-MCH-14, T-INS-02, T-INS-04, T-SEC-01 · Unblocks T-APP-01, T-FLW-06, T-GH-04, T-GH-06, T-GH-07, T-REL-02, T-STK-04 · Issue: [#3452](https://github.com/smithersai/smithers/issues/3452)
Spec: spec.md §4.1, §8.1.1, §10.3.2, §10.6.2–§10.6.4, §12.3, §12.4.1–§12.4.2, §12.5, §14.3 (Diff) · Delta: delta.md §6, §7 · Product: mvp.md J10.1, J10.5, §4.2, §6.3, M-22
Ready: 2026-10-03 smithers-8a sha256:17feb9b14bcf

Rescoped by the minimal-code synthesis, 2026-10-03 (v2 ticket merges, GH-03+05). Absorbs T-GH-03 ([#3517](https://github.com/smithersai/smithers/issues/3517)).

## Goal
A TODO in review has one PR from `smithers/<slug>` into `main` with the item's accepted tree, a body with prompt, evidence, included items and "Requested by @owner", and drafts for every item after the first. A merge, close or reopen on GitHub moves the TODO to Merged, Dropped or In review; checks show by name; a blocked merge shows GitHub's own sentence; a later item merged first marks both merged and asks maintainers for OK.

## Scope
In: PR shape and draft policy (§12.5.1); inbound PR facts (§12.3); the 7-day reopen window; out-of-order merge (§10.6.4); controlled git configuration on every host publication caller (hooks, external diff, textconv, merge drivers and credential helpers disabled).
- Lands dark until T-STK-08 (rule 3; automatic cycle cut 2026-10-03): build against its spec'd contract; the dependent path refuses with a typed error until T-STK-08 lands.
Out: keyed write recovery (T-GH-09 wraps every write here); evidence collection (T-STK-01); merge command and guards (T-STK-04); rebase execution (T-STK-08); next attempt after reopen (T-STK-05); review/comment steer delivery (T-GH-04, T-STK-06); foreign-push resolution (T-GH-06); UI Views and Containers; scratch-branch publication; stacked bases, in-app line comments and agent replies in GitHub review threads [D].

Dark landing: build against every listed dependency's specified contract. Until its provider and named checks are available, disable the affected production path and refuse before effects: T-STK-01/02/12 gate identity, accepted manifests, placement, folding and fences; T-GH-02/09 gate App facts and outbound recovery; T-ACC-03 gates authorization; T-FLW-11 and T-MCH-14 gate run settlement and machine retention; T-INS-02/04 and T-SEC-01 gate installed isolation, origin and guest security; T-STK-08 (S1) gates rebase execution and subsequent PR promotion. Missing containment evidence never settles an earlier item. Retain committed facts for absent later consumers; do not launch a replacement run or use host execution. C-J10-01, C-J10-08 and the folded C-STK-04 suite exercise each absent-provider refusal and recovery after activation.

## Changes
- Code paths below are relative to `packages/backend/internal/services/` unless stated otherwise.
- Reshape `mythical_items.go:2115` (`mythicalBranch`): read the recorded branch name; delete the `issue-<n>`, `change-<hex>` and `-r<k>` forms.
- Reshape `:2126` (`proposal`): render the §12.5.1 body from the item's latest revision, latest attempt evidence and accepted included-items manifest; title = TODO title. Keep `mythicalNoClosingKeywords`.
- Reshape `:2081` (`openPull`) and `mythical_github.go:282` (`CreatePull`): `draft` unless first; add `UpdatePullBody`, `MarkReadyForReview` and `ConvertToDraft` (GraphQL). Draft-unavailable fallback: title prefix `[waits for Tn]` and label `smithers:waiting`.
- Reshape `:2419` (`proposalDiff`): diff the accepted prefix candidate against the item's tree; serve it as `GET /api/branches/{b}/diff` `{files: DiffModel[]}` (planned OpenAPI file `docs/api/openapi/branches.yaml`, absent on main; reuse the existing diff parsing/model path rather than a second diff implementation).
- Reshape `:2163` (`follow`) and `:2827` (`ObserveGitHubEvent`): one pure `decideGitHubFact(fact, item, now)` Go switch returns events, a no-op reason or an attention kind. No `.tsv` table; poll, review and foreign-push consumers share it.
- Reshape `mythical_github.go:611` (`HeadChecks`): checks on every PR head, named, with `required` from `main`'s protection and rulesets (`administration: read`); the completion caller (`mythical_items.go:3224`) reads the same facts.
- Reshape `landing_github_pull.go:455` (`landingGitHubStatusError`): keep the body's `message` and `errors[].message` (class `github`, code `github_refused`).
- Reshape `:85` (`mythicalSettledStates`): a GitHub-closed TODO stays followed for 7 days; reopen restores its position if free, else appends, and recreates the branch from the last verified candidate.
- Reshape `:3118` (`mythicalLanded`) and `:2223` (`mythicalHold`): out-of-order merge marks every contained earlier item merged with the note "T3 merged before T2; T2's change is in T3's commit" and holds the stack's merges until a maintainer presses OK. The hold is the existing notice, not a `stack_attention` table.
- Reshape `:3168-3255` (`complete`, `completionBody`): close the issue only when `fixes_issue`, through T-GH-09.
- Reuse `internal/githubfake/`: add `draft`, the ready and draft mutations, and protection reads.
- New: none.

## Tests

Acceptance boundary: `packages/backend/internal/services/mythical_pr_shape_integration_test.go` (planned, C-J10-01) drives packaged `stack.candidate`/`stack.propose` dispatch, production PR publication and served `GET /api/branches/{b}/diff`; `github_inbound_pulls_integration_test.go` (planned, C-J10-08) drives the production pulls worker and webhook hint ingestion. Extend these suites for the folded C-STK-04 cases below and the lifecycle cases from C-GH-13; direct `decideGitHubFact` calls are supplemental. Invoke OK through the production catalog dispatcher with `order.ok` and the displayed revision; invoke merge through `POST /api/todos/{n}/merge` owned by T-STK-04. Expected states, trees, body text, envelopes and write counts are literal checked-in fixtures, never loaded from spec files or derived from production code at runtime.

C-STK-04 (folded steps and assertions):
1. On the fake GitHub, mark T3's PR ready and squash-merge it.
2. Poll once. Read T2, T3 and T4, their `product_job_events` and activity, `main` in the mirror, and the Home card for Ben and for Alice.
3. Ben merges T4 through `POST /api/todos/4/merge`.
4. Alice presses **OK** on the attention.
5. Ben presses **OK**.
- Drive the production OK route with delegated owner/maintainer credentials and a stale revision. Drive definitive GitHub 405/409/422 refusals through the production merge route.

Pass when:
- T-GH-03 containment crash fixtures run through production polling: receipt, proven-item transitions, order attention, projections and keyed close/comment intents commit together. Before-commit crash leaves none; after-commit restart retains one set. Remote-success-before-ack recovery creates no duplicate effective close/comment and leaves every unproven item unchanged.
- S11 exception already in §12.3.0a item 3: a dropped change proven contained in a later merged PR becomes merged with `merged_via`. Terminal-absorption fixtures must preserve this exception.
- S18: Add later-undrafted-not-merged fixture → synced draft=false, order/Tfirst, zero convert-to-draft writes and zero PUTs. Keep C-STK-04 external undraft/merge path and placement-triggered draft fixtures.
- S16: Add F2/F3 true/false issue fixtures → one durable close/comment per fixing item; false stays open unless a person independently closed it. Unproven S15 items get none. C-J10-05 no-approval/no-PUT invariant remains; already-existing genuine approvals are not erased merely to meet a fixture expecting none.
- S15: F11/new partial-proof rows: foreign merged head that excludes T2 → T3 merged, T2 unchanged, zero T2 PR/issue closes, one order attention with unverified sentence, zero merge PUTs. Add missing manifest, superseded retained candidate and missing-head-read fixtures. F2 proof must be explicit fixture input; head equality alone without inclusion evidence is insufficient.
- S14: F10/C-05: fold-before-claim → zero PUT; claim-before-fold → at most one initial PUT, one merged event, no duplicate cancellation/issue close/steer delivery. Add retained unknown outbound row despite cleared TODO fence. The fold changes only items proved contained under S15.
- S13: F9/TestQAFoldWhileAttentionOpen → one row, two entries, original preserved. Add duplicate, append-vs-OK and current-revision OK fixtures. Amend P2 “one attention per event” to one entry per event and at most one open row.
- S12: F3 → one attention text `T4 merged before T2; T2's change is in T4's commit` followed by newline and the T3 sentence; two notes and two close comments. F2/C-STK-04 stays byte-for-byte unchanged.
- After step 2:
  - T3 and T2 are both `merged`. T2 carries the note "T3 merged before T2; T2's change is in T3's commit" in its `product_job_events` row and its activity (§10.6.4).
  - `main` is folded: the mirror's `main` equals GitHub's, and the stack holds only T4.
  - One order attention is open in `mythical_stacks.attention` with that sentence and revision; Ben's Home projection shows it, and Alice's doesn't. No `stack_attention` table is added.
  - T4 is rebased onto the new `main`, its PR is force-updated, and it is marked ready once it is first.
- Step 3 is refused with class `conflict` naming the open attention, and the fake server records no merge call.
- Step 4 is refused with class `permission`; the row stays open.
- After step 5 the row is settled by Ben, and T4's Merge is enabled.
- Delegated OK returns 403 never/never; lower-role OK returns 403 permission/permission; stale OK returns 409 conflict/stale_attention. Refused OK requests have no effects. Definitive GitHub 405/409/422 responses return github/github_refused envelopes through the production merge route.

Fail when:
- T3's merge is treated as normal while T2 is still first, or T2 stays unmerged with its change already in `main`.
- T2 is marked merged without the note.
- A member can settle the attention, or a merge goes through while it is open.

- Unit: body holds the latest revision only, `Tn` links in stack order, no closing keyword, under 65,536 characters; title equals the TODO title.
- Unit: `decideGitHubFact` over literal fixtures for merged in order and out of order, closed, reopened at day 6, 7 and 8 (inclusive), closed twice; duplicates are no-ops.
- Unit: a 405 body reaches the merge refusal unchanged; a 422 keeps each `errors[].message`.
- Integration, real PostgreSQL, real git and `githubfake`, production routes and poller: T1 ready, T2 and T3 drafts; T1 merged on GitHub then T2 rebases, drops T1 from its body and turns ready once; T3 merged first marks T2 and T3 merged and holds merges until OK; OK from a member is refused and a stale revision returns 409.
- Integration: crash before and after the inbound commit; replay yields one transition and no second close or comment.
- Security, C-J10-01/C-SEC-02: drive production candidate/propose, publication and served diff with hostile repository-local hooks, external diff, textconv, merge drivers and credential helpers. Independent host canaries remain absent for every publication caller, with a machine positive control. Missing isolation or guest security refuses before dispatch with no host fallback. Require T-SEC-01's `TestGuestHelperInstallPinsInterpreterAndEnv`, `TestRootSetupNeverFollowsMemberSymlinks` and `TestRootPreflightParsesOnlyEnvelope` receipts through production fresh and retained machine paths before enabling any guest work.

## Acceptance
- [C-J10-01](../checks/C-J10-01.md), [C-J10-05](../checks/C-J10-05.md), [C-J10-08](../checks/C-J10-08.md), [C-GH-13](../checks/C-GH-13.md), [C-STK-04](../checks/C-STK-04.md), [C-STK-08](../checks/C-STK-08.md) (merges on GitHub during a steer, question or pause), [C-J1-04](../checks/C-J1-04.md), [C-SEC-02](../checks/C-SEC-02.md).

## Risks and notes
- Activation with T-STK-06: PR lifecycle ingestion lands before steer delivery; retain undelivered review facts until the consumer is installed. Missing providers refuse; joint acceptance gates enabling the path.
- Risk: a 24 KiB prompt plus evidence exceeds GitHub's body limit; GitHub answers 422. The body truncates evidence and links back.
- Risk: `closed_by` is null when the head branch is deleted; the reason then reads "closed on GitHub".
- smithers-3f decides and accepts fact precedence, containment proof, reopen boundaries, crash/replay behavior, controlled git configuration and guest security. smithers-b8 decides and signs off the public diff/OpenAPI and `order.ok` contracts, including body truncation and refusal rendering. Changes to product behavior go to Will before implementation; no ADR is required by this slice.
- Owner review: smithers-3f reviews Go/infra and security seams; smithers-b8 reviews user-facing API seams; smithers-38 reviews any packages/ TypeScript model or generated-client changes. Recorded owner answers stand; under the parallel-build directive, pending owner review is post hoc and does not block start. This ticket changes no UI View.

## Security preconditions
Repository code and checks run only as an unprivileged user in a machine (M-29); host git reads/transfers data under controlled configuration and never runs repository programs. smithers-3f accepts C-J10-01 and C-SEC-02 security receipts. This ticket adds no root command or branch-built privileged artifact. Its machine calls inherit T-SEC-01's full R1–R3 root-input inventory and validation, not a separate bootstrap:
- R1 helper install/startup consumes helper bytes/digest/install script and destination from main in the approved bundle; msb/path, child environment, machine id and deadlines from install configuration; image metadata/blobs and OS tools/interpreter from the pinned base; snapshot, import/search paths and existing helper/temp/ancestor entries can contain branch/member data. `TestGuestHelperInstallPinsInterpreterAndEnv` must prove provenance and replacement resistance before use.
- R2 setup/home defaults consume argv/login/UID/directories and HOME_LINKS/GO_SETTINGS from main and install-allocated identities; passwd/group and OS tools from the pinned image; env.json keys/values and cache/home entries, metadata and symlinks from main-generated configuration plus branch/member-derived tool selection, dependency output and retained state. Filesystem responses come from the guest kernel over those entries. `TestRootSetupNeverFollowsMemberSymlinks` must prove bounded values and no-follow confined writes before use.
- R3 exec/fs/terminal/cleanup/relay consume envelope ids and fixed user/root fields, exec/cgroup ids, relay endpoints, deadlines and transport settings from main/install authority; argv/env/cwd/stdin, paths/content/modes/read limits, request files/parents/descriptors, terminal sizes/signals, capture/results and network bytes can contain branch/member data. Startup env/account/directory inputs retain R1/R2 provenance; process, filesystem, fork/wait/signal and network observations come from the guest kernel and member processes. `TestRootPreflightParsesOnlyEnvelope` must prove bounded identity/request/cgroup/relay validation and group/GID/UID drop before payload use.
Branch/member inputs to root remain an activation blocker until these named production tests prove validation. Branch-built scripts, binaries, interpreters, imports or toolchains are never installed, loaded or executed by root, even after a digest check.

## Ready checklist
1. Dependencies: existing runtime edges plus T-STK-08 (S1 rebase) and T-SEC-01 (shared guest validation); Scope names dark/refusing behavior for every listed unavailable provider and retained facts for later consumers.
2. Exclusions: Scope explicitly excludes recovery implementation, evidence collection, merge guards, rebase execution, restart, steer delivery, foreign-push resolution, UI work, scratch publication and deferred PR features.
3. Acceptance: named C-J10-01/C-J10-08 production-dispatch, publication, diff and polling suites cover literal fixtures; folded C-STK-04 drives `order.ok` and the real merge route; no runtime spec/code oracle.
4. Decisions: smithers-3f accepts Go/infra, lifecycle and security policy; smithers-b8 signs off public API/body/refusal contracts; Will decides product deviations.
5. Owner review: smithers-3f: Does the actual merged head and retained manifest prove each fold? Do transaction/replay and unavailable-provider paths preserve facts without unsafe writes? Do host git and inherited R1–R3 boundaries pass security receipts? smithers-b8: Are diff/OpenAPI and `order.ok` contracts compatible with app callers? Are body truncation and refusal text faithful to product? smithers-38, for TypeScript model/client changes: Can existing per-module models be reused? Do generated clients preserve the served response contract? Recorded answers stand; pending reviews are post hoc under the directive.
6. Security: machine-only unprivileged repository execution, no host fallback, controlled publication git, no new root step; Security preconditions list inherited root inputs/sources and named validation blockers, reviewed by smithers-3f.

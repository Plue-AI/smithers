# T-GH-09 Recover one GitHub operation per item

Stage S1 · Size M · Depends on T-GH-01, T-STK-01, T-GH-02, T-ACC-02, T-ACC-03, T-STK-12 · Unblocks T-FLW-09, T-FLW-11, T-GH-03, T-GH-06, T-INS-07, T-MNT-01, T-MNT-03, T-REL-04, T-STK-04, T-STK-05, T-STK-09 · Issue: [#3520](https://github.com/smithersai/smithers/issues/3520)
Spec: spec.md §12.4, §10.6.2b · Delta: delta.md §7 (Reshape PendingOp) · Product: mvp.md §6.1 Restart, §6.3, M-29 · Checks: C-GH-09, C-DUR-03, C-SEC-03
Ready: 2026-10-03 smithers-8a sha256:855820a8baa1

## Goal
Recover proposal, merge and Drop writes without duplicate effects.

## Scope
In: push, open PR, body, merge and close PR from the existing propose/merge/drop paths.
Out: a per-target queue, supersession, mirror/landing writers and check-run creation; inbound effects, candidate capture, MergeReady/DecideMerge implementation and approval UI; new outbound tables, repository hooks/checks/scripts and privileged machine setup.

Land dark against each unlanded dependency contract: T-GH-01 supplies canonical App credentials/identity; T-STK-01 supplies item persistence and the stack lease; T-GH-02 supplies budgeted transport; T-ACC-02 supplies current membership; T-ACC-03 supplies command authorization; T-STK-12 supplies accepted-generation receipts and the TODO fence/Drop obligation. Missing required providers retain existing intents and refuse affected sends before token issuance. T-STK-04 supplies the shared DecideMerge dispatch/recovery contract; until wired and its merge checks pass, reconcile already-applied merges by reads only and refuse new merge sends. C-GH-09 tests each absent-provider guard; unfinished integrations remain pending.

## Changes
- Reshape `packages/backend/internal/services/mythical_items.go` (propose/push/open/merge), `internal/services/mythical.go:224` (`runClaimed`) and `internal/db/mythical_ext.go` item persistence. Extend mythical_items.pending_op to {kind, target, desired, precondition, state}. Reuse the stack lease and current push recovery branch; no parallel queue or recovery service.
- Reuse `packages/backend/internal/services/mythical_github.go:440` (`mythicalCommentMarker`) and reshape canonical-App comment/event lookup. Refuse proxy mutations at `internal/routes/github_proxy.go:30` before `internal/services/github_proxy.go` resolves a token.
- Commit intent and mark it potentially sent before the call. At restart or uncertain response, reconcile that slot before the next operation. Do not overwrite it.
- Push compares the remote head with desired/precondition; open PR looks up the head branch; body compares its digest; merge reads the PR; close uses the canonical App's event then current state. A foreign change refuses a repeat.
- Merge sends only with current maintainer authority, the bound head, checks.Land or checks.Automerge, and the shared readiness decision. An already-merged PR settles without a second send. Missing decision wiring refuses sends.
- Drop waits for an uncertain proposal operation to settle, then closes any created PR. The item's dropped state preserves that obligation across restart.
- Labels, unlabels, comments and issue-close remain best-effort retries. Keep mythicalCommentMarker and require canonical App identity when finding its comment.
- Refuse machine proxy POST/PUT/PATCH/DELETE before token issuance or upstream mutation.

## Tests
- C-GH-09/C-DUR-03: use production install composition and `MythicalService.runClaimed` with real PostgreSQL, githubfake and a bare remote. Enter proposal through T-STK-12’s production `stack.propose` dispatcher, Drop through the production `todo.drop` dispatcher, and merge through T-STK-04’s `prs.land` handler/`POST /api/todos/{n}/merge` route. Kill before send, after potentially-sent commit and after remote success before settlement for each kind. Restart the production worker on the same database: one slot, lookup before repeat, one effective result. Do not call recovery helpers as the acceptance boundary. Use fixed fixture bytes and literal expected rows, calls and refusals; never read spec Markdown or derive expectations from implementation at runtime.
- Hold CreatePull's response, Drop, restart and release it: the PR closes once. A later body waits for the current slot to settle.
- Remote push head differs from desired and precondition: conflict, no overwrite. A person reopens a closed PR after the App's close: recovery does not close it again.
- Lost merge response: settle from GitHub with no second merge. Revoked approver, stale head, missing approval or competing fence: no send.
- A member or another App quoting a comment marker cannot satisfy canonical-App lookup.
- C-SEC-03: send machine-credential POST/PUT/PATCH/DELETE payloads through `POST /api/repos/{owner}/{repo}/github-proxy` (current registration: `compose/router.go:1164`, handler: `routes/github_proxy.go:30`); zero token issuance, outbound rows and upstream calls.
- C-GH-09: hostile branch hook/config/script fixtures produce zero repository-code execution on the host during push/recovery. Missing-provider fixtures produce zero sends and preserve uncertain slots.

## Acceptance
- [C-J1-04](../checks/C-J1-04.md): passes for this ticket’s phase at its stated layer.
- [C-GH-09](../checks/C-GH-09.md): scoped five-kind recovery and authority cases pass.
- [C-DUR-03](../checks/C-DUR-03.md): process-kill recovery passes for those kinds.
- [C-SEC-03](../checks/C-SEC-03.md): machine proxy refuses mutation.
- [C-STK-06](../checks/C-STK-06.md): accepted proposal replay and Drop settle once.

## Risks and notes
An uncertain slot blocks the next item operation until lookup establishes its result. It never authorizes a new merge.

smithers-3f approves persistence, stack/TODO fencing, recovery and security seams; smithers-b8 approves public route/refusal contracts; smithers-8a accepts seam changes. Recovery does not invent approval or alter product merge policy.

Security preconditions (reviewer: smithers-3f): M-29 and spec §1.3 require all repository code execution in machines. Host recovery handles objects and calls GitHub with packaged tools and trusted install configuration only; it must not execute branch hooks, credential helpers, filters, checks or scripts. Preserve the push hook bypass and trusted bare-object transport. This ticket adds no root step and consumes no branch input as root; privileged image/setup work is excluded. C-GH-09 proves the host execution boundary; C-SEC-03 proves proxy refusal before token issuance.

## Ready checklist
1. Dependencies: header lists App identity, item/lease, budgeted transport, current membership, authorization and candidate/fence contracts; Scope names each absent-provider guard and the dark T-STK-04 integration without a circular edge.
2. Exclusions: Scope explicitly excludes queues, supersession, mirror/landing writers, check runs, inbound effects, capture, merge decisions/UI, parallel tables, repository execution and root setup.
3. Tests: C-GH-09/C-DUR-03 use production composition, dispatcher/route and restarted stack worker; C-SEC-03 uses the composed proxy route. Fixed bytes and literal rows/call counts supply independent expectations.
4. Decisions: smithers-3f approves backend/security seams, smithers-b8 public contracts, and smithers-8a accepts seam changes; merge policy follows the existing product contract.
5. Owner pre-review: smithers-3f must answer: Does slot persistence preserve stack/TODO fence ordering across crash and Drop? Do absent providers refuse sends while retaining reconciliation obligations? Can host transport execute any branch hook/helper/filter? smithers-b8 must answer: Does the composed proxy refuse before token issuance with the existing public error contract? Do production merge/Drop doors reach this recovery path? Owner review is post hoc under the parallel-build directive; no owner answer is fabricated here.
6. Security: smithers-3f reviews machine-only repository execution, trusted host transport and proxy refusal, proved by C-GH-09/C-SEC-03. No root step exists in scope, so there are no root-consumed inputs to enumerate.

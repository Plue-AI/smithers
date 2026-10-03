# T-STK-04 Merge: person session, one predicate and an in-flight fence, sha-bound, squash

Stage S1 · Size L · Depends on first merge: T-STK-01, T-ACC-01, T-INS-02; rest of S1: T-ACC-03, T-STK-12, T-ACC-04, T-APP-04 (delegated 202 only), T-GH-02, T-GH-03, T-GH-09 · Unblocks T-APP-01, T-APP-02, T-APP-07, T-FLW-02, T-FLW-06, T-GH-07, T-INS-07, T-REL-02, T-REL-04, T-STK-05 · Issue: [#3529](https://github.com/smithersai/smithers/issues/3529)
Spec: spec.md §4.1, §4.1.2a, §5.2, §5.3, §6.2.4, §10.4.5, §10.6.1, §10.6.2, §10.6.2a, §10.6.2b, §10.6.2c, §10.6.3, §12.1.2, §12.3 (TODO PR merged), §12.5, §16.4 · Delta: delta.md §6 (Modify merge; Delete `change.land` path) · Product: mvp.md §4.2 Merging, §6.10, J1.7, J2.6, M-01, M-05, rule 6, Appendix B.4 (Stack: merge)
Ready: 2026-10-03 smithers-8a sha256:f019275e074a

## Goal
A merge happens only by Review & merge from an owner or maintainer signed in with a browser session, or by a maintainer's standing pre-approval (M-39, T-STK-04, which reuses this ticket's `DecideMerge`), and only while the one merge predicate holds: the first unmerged item, in review, at its accepted generation with no pending work, rebase or open wait, and at exactly the PR head the person reviewed (Review & merge) or at the current head with required checks green (pre-approval, which is not revision-bound). A moved head, a pending edit or steer, a rebase, a reorder or an out-of-order request merges nothing.

## Scope
First merge: Rename LandTodo to session-only Merge with reviewed_head_sha; retain current merge/readiness/maintainer checks. Check: C-J1-04.
Later dependency integrations land dark until their providers and phase checks pass.

- Remove the TUI landCommand and its landable caller in apps/tui/src/factory.ts, plus the CLI smthrs history land handler in packages/smithers/src/internal/backend/History.ts and Definitions.ts. Update factory.test.ts and BackendHistory.test.ts. Publish a root CHANGELOG.md Removed migration note through the routed follow-up. Preserve ChangeCards.tsx landablePrefix, which is unrelated. Check: C-STK-07.

- Rename StackCard’s existing TODO Land control and binding to Merge for the first merge. Bind `{n, reviewed_head_sha: head}` to the PR head displayed on the person’s card. Keep this session door until TodoContainer’s Merge is live; T-APP-02 deletes the StackCard control and binding in the same commit that mounts its working replacement. Check: C-STK-07.
In:
- `POST /api/todos/{n}/merge {reviewed_head_sha}` and the `/merge Tn` catalog command (`agent: confirm`, kind `review_merge`; agents get a Review & merge confirmation, and execution requires an eligible person session, mvp.md Appendix B.2).
- T-ACC-03 authorizes session eligibility and role before readiness. `DecideMerge` applies authorization then the single `MergeReady` predicate for route, projection, confirmation and dispatch/recovery. Required reviews must satisfy GitHub branch protection; otherwise `merge_block.reason = review_required`. Check: C-STK-07.
- Reuse T-STK-12's item version CAS, stack claim and held-signal delivery (§10.6.2b). The fence is `mythical_items.pending_op {kind: merge, target: pr, desired: head, precondition: {generation, by}, state}` (T-GH-09 shape) under the stack claim; `merging` in §10.6.2b is its projection. This ticket owns the locked merge predicate, fresh pre-dispatch rechecks, dispatch and reconciliation on every stack pass. Shared primitives refuse fenced mutations and hold steers, review comments, rebases and proposes. Check: C-STK-07.
- `checks.Land` values carrying the D-23 rule: an approval counts only from a person's session and only for the generation and PR head it names (§10.6.2c); a new generation voids it.
- GitHub merge with `sha = reviewed_head_sha` and `merge_method = squash`; `in_review → merged` once GitHub reports the merge and `main` contains the commit.
- The linked issue closes only when `fixes_issue` is true.
- `merge_block = {reason, detail?}` on the `home` and `todo:<n>` projections, from `MergeReady` (§10.6.2a): "Merges after Tn", the failing required check's name, GitHub's refusal text as received, or the reason code.
- Keep the maintainer-applied automerge label as the pre-approval door. Rename Land to Review & merge over the same guarded merge function; remove only obsolete change.land exposure. Checks: C-STK-07, C-STK-13.

Out:
- New Merge/Confirm Views and unrelated Plue-only landing remain outside this deletion.
- The Confirm card and person confirmations for delegated credentials (T-APP-04).
- Reading required checks from branch protection, protection reason text and out-of-order merges on GitHub (T-GH-03).
- Implementing outbound idempotency keys and crash reconcile (T-GH-09); the merge path must consume them before it is enabled.
- New card Views, generic Plue landing removal, direct agent merge and host execution of checks.
- The squash-merge check at setup (T-INS-06). Stacked PR bases (spec §0 [D]).

## Changes
- Preapprove/unapprove set or clear `checks.Automerge` with maintainer attribution; retain `checks.Land`, `appliedByMaintainer` and `landedByMaintainer`. Recheck authority at send. The owner default lives in `install_settings` and applies only to later TODOs. No new approval table or evaluator. Check: C-STK-13.

- Remove the TUI landCommand and its landable caller in apps/tui/src/factory.ts, plus the CLI smthrs history land handler in packages/smithers/src/internal/backend/History.ts and Definitions.ts. Update factory.test.ts and BackendHistory.test.ts. Publish a root CHANGELOG.md Removed migration note through the routed follow-up. Preserve ChangeCards.tsx landablePrefix, which is unrelated. Check: C-STK-07.

- This ticket owns deletion of the `prs.land` command handler and its install route. T-APP-04 owns binding and removal of the control only. Preserve Plue-only landing services and routes. Check: C-STK-07.

- Complete TODO Land deletion inventory: rename the history.land button in `apps/app/src/mainview/cards/StackCard.tsx:111` and landStackItem entries in `apps/app/src/mainview/state/AppController.ts:469`, `:1597` to session Merge; T-APP-02 deletes that control and binding only in the commit that mounts a live TodoContainer Merge replacement. Remove the change.land button in `apps/app/src/mainview/cards/ChangeCards.tsx:1016`, the HISTORY_LAND_USER_ONLY_REASON import and policy row in `apps/app/src/mainview/flows/Flows.ts:66` and `:106`, and landChange entries in `apps/app/src/mainview/state/AppController.ts:549`, `:1654`. Update the matching StackCard, ChangeCards, flow-order, agent-parity and controller tests. New Merge/Confirm Views remain owned by their UI tickets. Check: C-STK-07.

- Extract the shared readiness decision from the existing merge implementation; call it from the renamed Merge handler, pre-approval evaluator and dispatch recovery. Session Merge binds reviewed_head_sha in checks.Land; pre-approval retains checks.Automerge. Recheck head, checks, main and authority under the existing item/stack fence. No second merge service. Checks: C-STK-07, C-STK-13.
- Reshape `mythical_items.go`: keep `automergeLabel`, `checks.Automerge`, `checks.Land`, `appliedByMaintainer` and `landedByMaintainer`. Recheck the label applier's current maintainer authority before dispatch. Rename `LandTodo` to `Merge`, bind `reviewed_head_sha`, and refuse token auth. Keep `gate()` → `merge()` for both Review & merge and pre-approval. The first-merge route retains `LandTodo`'s shape (`packages/backend/internal/services/mythical_land_todo.go:74-100`): record `checks.Land{generation, head}` with person attribution under the item version CAS and wake the worker. The worker sends the PUT inside the stack claim. A route PUT without that lease races the evaluator's PUT for the same item; the second request can return 405 and write a bogus hold receipt (`mythical_items.go:2530-2534`). Preserve the version CAS immediately before the PUT and settlement through `follow()` after remote success, without a second PUT. Completion closes the issue only when `mythical_items.fixes_issue`. Checks: C-STK-07, C-STK-13.
- After a merge, later items rebase onto the new `main` and their open PRs are force-updated (§10.6.3) through the existing integrate path. Record the voiding reason before clearing checks.Land when a new generation starts (§10.6.2).
- Keep head-bound approval in `checks.Land` and the merge fence on the existing item/stack claim. No approval table migration. Check: C-STK-07.
- Persist the merge `pending_op` under the existing stack claim and item version CAS; reuse T-STK-12's held-signal delivery. Reconcile fences and unsent intents on every stack pass before new dispatch, including lease takeover after `mythical_stacks.lease_expires_at`. Reuse T-GH-09 lookup for unknown sends. Clear an abandoned unsent fence with no live claim and deliver held inputs once; retain a confirmed merge's fence until settlement. Follow the stale-work recovery pattern in `ResetStalledRepoPushEvents` (`packages/backend/db/product/queries/repo_push_events.sql:79`). Do not create another lock or held-signal queue. Check: C-STK-07.
- At cutover, unattributed `checks.Automerge` is authorized only through `landedByMaintainer` at `checks.Land.Head` (`packages/backend/internal/services/mythical_items.go:2466-2488`), never as standing pre-approval (§10.6.2d). A `checks.Land` without a generation is honored only at its Head and voided on the next generation, even if the head is unchanged. No attribution backfill is required. Checks: C-STK-07, C-STK-13.
- Rename `packages/backend/internal/routes/mythical.go` to `mythical_items.go` and update the existing route in place; add no parallel route file. Refusals use §10.6.2’s exact §6.2.3 envelopes and row precedence. Authorization is T-ACC-03’s decision; `MergeReady` owns readiness only. Eligible delegated requests return 202 with a private confirmation through T-APP-04; only its author’s eligible session executes Merge (§5.2.1, C-ACC-02).
- Rename `packages/backend/internal/services/mythical_land_todo.go` to `mythical_merge_todo.go` and `mythical_land_todo_test.go` to `mythical_merge_todo_test.go`; reshape the existing implementation and tests into session-only Merge with `reviewed_head_sha`. Replace the old /land route and OpenAPI row in the same change; keep its authorization, checks.Land attribution and head checks. Extend these tests rather than adding parallel merge test files. Check: C-STK-07.
- Rename the app’s existing history.land/StackSeam binding and CLI door to the new Merge route. Every slash and CLI `POST /api/todos/{n}/merge` body includes `reviewed_head_sha`, set to the head the person’s card displayed. Never substitute a freshly fetched head for that reviewed head. If the door has no reviewed head, refuse without effects: HTTP 400, class `user`, code `invalid_reviewed_head_sha`, message `reviewed_head_sha must be a 40-character hexadecimal commit SHA`. A well-formed stale head refuses with `stale_head` under §10.6.2. Remove obsolete aliases at cutover; retain StackCard’s session Merge until T-APP-02 mounts a live replacement in the same commit that deletes it. Check: C-STK-07.
- `docs/api/openapi/mythical_items.yaml` → the merge row; regenerate `ProductApi.ts` (`smthrs run //:openapiClients`); update `packages/backend/docs/mythical_items.md` and run the docs gates.

## Tests
- Apply automerge as an outsider, another App and a revoked maintainer: zero merges. A current maintainer’s label permits only the existing head/readiness-checked path. Preserve appliedByMaintainer and landedByMaintainer coverage. Check: C-STK-13.

C-STK-13 (folded steps and assertions):
1. As maintainer, preapprove T1 while its required check is pending. Settle it green through production ingestion and deliver the fact twice.
2. Attempt both commands with delegated, agent, run and machine credentials, including a forged person attribution. Attempt preapprove as Member. Inspect rows, events and outbound intents.
3. Hold evaluation before send, remove T1's approval, then release evaluation. In a separate case remove after the fake receives the request and lose its response; restart and reconcile.
4. Preapprove, rebase onto a new main, and settle rebase. Deliver green for the old head while the new head is pending, then green for the new head.
5. Preapprove T1 and T2 with initially green checks. Hold T1's merge response. Complete T1 and fold main; settle T2's rebase and new-head checks.
6. Persist a ready, pre-approved TODO without an outbound intent. Restart twice and redeliver its ready fact. Repeat with a pending and an unknown merge intent.
7. Open Needs you on a pre-approved green TODO; deliver readiness facts, then clear Needs you through its production command.
8. Create a TODO with the default off. As owner enable **New TODOs start pre-approved**; create another TODO through the normal creation path. Disable the setting and create a third. Attempt setting writes as non-owner and agent. Make the inherited approved TODO ready.
9. Keep a required check pending, then failed; provide optional green checks. Exercise a protected-path refusal, then remove approving-member authority before send.

Pass when:
- Step 1: pending blocks; green produces exactly one squash merge request with current sha, one durable completion and `Merged · pre-approved by <name>` after main contains the commit.
- Step 2: disallowed credentials receive 403 permission/permission with no pre-approval, confirmation, fence or outbound intent. Member approval also fails permission. Valid add/remove events name the actual person and via.
- Step 3: removal before send produces zero merge requests and retains an attributed removal event. After send, §12.4.1b lookup settles the result without a blind repeat or fabricated approval.
- Step 4: the approval record survives unchanged; no old-head merge occurs; exactly one merge uses the green new head.
- Step 5: only T1 sends first. T2 sends only after T1 is confirmed on main and T2's rebased current head is green.
- Step 6: boot evaluation merges once; existing intents reconcile through the same outbound path before new dispatch. Duplicate recovery adds no merge.
- Step 7: Needs you blocks all sends; clearing it triggers evaluation and one ready merge.
- Step 8: only the second TODO inherits the enabling owner's attributed approval. Existing approvals remain after disable. Unauthorized writes change no field or event. The inherited TODO merges only when ready.
- Step 9: each blocking fact prevents send; pre-approval bypasses no protected-path, required-check or current-authority rule.

Fail when:
An agent grants approval, removal before send loses, a stale head merges, a later TODO merges first, recovery duplicates a merge, or a default-setting change rewrites existing TODO approvals.


C-STK-07 (folded steps and assertions):
- Exercise every MergeReady refusal through the production route and card with identical facts. Assert literal priority, status/class/code/detail, zero merge PUTs and no authorization-side reads when authority fails. Pending/failed required checks precede mergeability; optional failures do not block.
- Supply malformed and uppercase SHAs, missing/stale facts and unknown required-check configuration. Normalize valid SHA input; stale/unknown facts report rechecking. Re-read null mergeability after 2 s; a moved head refuses, and repeated null reports the literal GitHub-computing message.
- Hold the merge fence; race steer, comment, capture, reorder, amendment, Drop and a second merge. No fenced capture or stale merge occurs. Success cancels the run and retains undelivered inputs as facts; definitive refusal clears the fence and delivers held inputs once, retaining the failure receipt.
- Edit immediately before and after capture. Pre-fence edits block with pending_work; post-fence edits remain in the final capture and are never falsely reported merged. Main movement after readiness blocks.
- Revoke/demote the approver before dispatch and during recovery: no new send; claim-before-revocation permits only the already-authorized call, whose GitHub result wins.
- Kill before send, after claim and after remote success. Recover the existing pending_op by lookup; no approval without an intent sends. Already merged settles without another PUT; otherwise repeat only under current authority, head and readiness.
- Exercise GitHub 405/409/422 with literal upstream text. A definitive refusal retains the bound receipt and no automatic retry; an already-merged read settles honestly after main catches up.
- Repeat the same idempotency key and normalized request: same result. Change TODO, operation or SHA: 409 idempotency_mismatch. Revoked callers cannot retrieve protected cached success.
- Recapture keeps the last usable accepted prefix; stale/obsolete heads never become current. Candidate acceptance atomically records rebase demand. A changed base or manifest requires a new candidate and checks, voids old approval and permits review reuse only for equal own-diff patch-id.
- Reject invalid, future, regressing and unacknowledged input cursors; another item’s amendment cannot advance this item’s input cursor. Newest ordered capture wins; conflicting equal-order reports refuse.
- Reconcile an actual older GitHub-merged head from its retained inclusion manifest, not a newer pending head. Preserve unlanded bytes and fabricate no approval or second merge. Missing containment evidence leaves predecessors unchanged and opens order attention.
- Duplicate out-of-order folds create one attention with one entry per event; concurrent acknowledgement cannot erase a later entry. Issue closes require fixes_issue and proved containment. A later undrafted PR alone never triggers a fold or convert-to-draft write.
- Every successful request is sha-bound squash; one effective merge, checks.Land names the reviewed head, and no fence survives settlement.


- Assert TUI and CLI expose no TODO Land command and send no POST /items/{id}/land. Retain tests for unrelated landablePrefix and Plue-only landing. Check: C-STK-07.

- Gate only the delegated 202 confirmation door on T-APP-04’s confirmation-to-action seam to the real merge service. Enable the eligible person’s session door at first merge without this dependency. Drive production confirmation approval and merge routes through the composed router with real PostgreSQL and fake GitHub. Prove C-ACC-02’s session/role/revision checks, pending-on-state-conflict behavior and outbound reconciliation through T-GH-09 after a kill between approval and the external call. A test-only merge handler cannot discharge this gate. Keep Depends on T-APP-04; do not add a reverse edge.
- `review_merge` binds generation plus reviewed PR head. Changing generation with unchanged displayed head refuses without effects. MergeReady and definitive GitHub refusals leave the confirmation pending; only confirmed merge approves it. Prove through the real approval route and production merge consumer. Check: C-ACC-02.
- Include `prs.land` in the C-STK-07 executable-door deletion gate; assert its install command and route are absent and the control binds only the supported Merge command.

- C-STK-07 deletion gate: search app/backend/OpenAPI production sources and tests for history.land, change.land, HISTORY_LAND_USER_ONLY_REASON, landStackItem, landChange and the removed TODO Land route. No executable TODO Land door, controller binding or obsolete test expectation remains. Render the production StackCard and ChangeCards and assert no Land dispatch; verify TODO Merge/Confirm use the authorized merge route. Preserve Plue LandingService and its Plue-only API. Run existing app type and flow-parity gates. Before T-APP-02 cutover, render StackCard and execute its session Merge with the displayed head; after cutover, render the mounted TodoContainer and execute its replacement with that same head binding. Reject missing and stale SHA bodies through slash, CLI and card doors with zero effects. Assert the replacement mounts in the same commit that deletes StackCard’s Merge control and binding; the delegated 202 door stays dark until its T-APP-04 integration passes. Check: C-STK-07.

- C-J2-05: TODO and Confirm use the same required-check decision at the reviewed SHA. Failed optional plus passed required permits merge; pending required blocks both Containers and the service, with zero GitHub calls.
- Unit, renamed `mythical_merge_todo_test.go`: extend the existing guard table. Each guard fails alone (delegated, run and machine credentials; member role; each `MergeReady` row of §10.6.2a with its reason code) and yields no merge PUT. The shared `DecideMerge` function gives the route's refusal and `merge_block`.
- Integration with real PostgreSQL and the fake GitHub server, renamed `mythical_merge_todo_test.go`: extend the existing tests; a maintainer session merges T1 at its head. Exactly one `PUT /pulls/{n}/merge` with `sha` and `merge_method=squash`; one `checks.Land` value; `merged` only after `OnMain` (`mythical_github.go:539`) is true.
- Integration, same file: a head change after approval deletes the approval, and a merge with the old head is refused.
- Integration, same file: the issue closes for `fixes_issue = true` and stays open for `false`.
- Unit mythical_items_test.go: no worker fabricates person approval; preserve automatic evaluation authorized by current maintainer pre-approval or recorded head-bound session approval. Seed unattributed Automerge with a generation-less Land: only landedByMaintainer at Land.Head authorizes it; a moved head refuses, and the next generation voids Land even with an unchanged head. Preapprove must not turn that legacy row into standing approval. Checks: C-STK-07, C-STK-13.
- Integration, renamed `mythical_merge_todo_test.go`, for C-STK-07: a steer, an edit, a reorder, `rebase_pending`, a `main` move and a second merge, each against a merge the fake GitHub holds; zero merge PUTs for pre-dispatch refusals; one initial PUT and at most one lookup-authorized repeat after uncertainty; the fence and unsent intent reconciled on the next worker pass without restart. Kill the operation's process after persisting the fence and before send; after lease expiry, the next surviving worker pass clears the abandoned fence, sends no abandoned intent and delivers held inputs once. Check: C-STK-07.

## Acceptance
- [C-STK-13](../checks/C-STK-13.md): all folded steps and assertions above pass at the source check’s layer; any stated failure fails acceptance.

- [C-J4-03](../checks/C-J4-03.md): only the first unmerged item merges; later items show "Merges after Tn".
- [C-ACC-02](../checks/C-ACC-02.md): eligible delegated requests return 202 with a private confirmation and no merge; run and machine credentials get `permission` refusals. Only the requesting person’s eligible session approves and merges.
- [C-J2-05](../checks/C-J2-05.md) (S1 part): merge turns the TODO Merged and closes the issue only when it fixes it.
- [C-J1-04](../checks/C-J1-04.md): First TODO to merged PR, unassisted, within 60 minutes of starting the install

## Risks and notes
- Rollback to an old binary strands but never duplicates a merge `pending_op`: label-less Automerge sends nothing, and the old proposal decoder clears or blocks the merge row. Checks: C-STK-07, C-STK-13.
- Rollback to an old binary strands but never duplicates a merge `pending_op`: label-less Automerge sends nothing, and the old proposal decoder clears or blocks the merge row. Checks: C-STK-07, C-STK-13.
- First merge uses verified T-ACC-01 sessions and current maintainer/readiness/lease/pending_op services. Later Authorize/Confirm/fence/capture providers remain gated by C-ACC-02/C-STK-07; missing current authority/head/check/recovery facts refuse before send. Check: C-J1-04.
- `/api/repos/{o}/{r}/landings*` and `LandingService` (`services/landing.go`) still serve Plue. This ticket deletes only their TODO doors. The routes stay for Plue and are unmounted in the install composition, with `x-composition: plue` on their OpenAPI rows (§6.2.4); T-CUT-02 does the unmount.
- Risk: GitHub reports `mergeable: null` while it computes. Observation: a refusal on a fresh PR head in the integration log. Retry the read once after 2 s before refusing.

## Ready checklist
1. T-STK-01/T-ACC-01/T-INS-02 plus current maintainer/readiness/lease/recovery; later Confirm/new fences remain dark.
2. Out of scope explicitly includes new Confirm Views/check/outbound implementation, Plue landing removal, agent merge/host checks/stacked bases and public landable helper removal.
3. C-STK-07/C-J1-04: composed Merge route/app dispatcher, real PG/GitHub fake and repeat/restart recovery. Commit literal layout/step/state/SHA/status/error/UID/role/secret fixtures; independent hashes and external effect logs supply expectations, never runtime spec/production oracles. Later checks run only with their providers.
4. smithers-b8 accepts apps/CLI/API; smithers-38 accepts packages TypeScript/public schemas; smithers-3f accepts Go/infra/security; smithers-06 accepts touched View/navigation contracts; smithers-8a accepts shared/schema/Plue seams. Will decides product-policy exceptions.
5. smithers-3f: answered 16:2x, changes applied (tech lead adopts). smithers-b8: answered 16:4x, changes applied (tech lead adopts). re-review needed: smithers-38, consumer deletion with public helpers preserved; Are callers complete? smithers-06: answered 18:3x, unchanged reason/tone rule; Are failed checks ember and waits neutral? Prior answers stand where unchanged.
6. Host processes are unprivileged; no sudo lane plist. Execution consumers inherit the complete R1–R5 inventories and named production tests in T-INS-02/T-INS-06/T-STK-01; smithers-3f accepts receipts. M-29 confines code to unprivileged machines; unvalidated branch data blocks and branch-built root code is forbidden.

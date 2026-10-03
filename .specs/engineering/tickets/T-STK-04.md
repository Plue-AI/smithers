# T-STK-04 Merge: person session, one predicate and an in-flight fence, sha-bound, squash

Stage S1 · Size L · Depends on T-STK-01, T-ACC-03, T-STK-12, T-ACC-04, T-ACC-05, T-STK-07, T-GH-02, T-GH-05, T-GH-09, T-INS-02 · Unblocks T-APP-04, T-REL-02, T-STK-05, T-STK-16 · Issue: [#3529](https://github.com/smithersai/smithers/issues/3529)
Spec: spec.md §4.1, §4.1.2a, §5.2, §5.3, §6.2.4, §10.4.5, §10.6.1, §10.6.2, §10.6.2a, §10.6.2b, §10.6.2c, §10.6.3, §12.1.2, §12.3 (TODO PR merged), §12.5, §16.4 · Delta: delta.md §6 (Modify merge; Delete `change.land` path) · Product: mvp.md §4.2 Merging, §6.10, J1.7, J2.6, M-01, M-05, rule 6, Appendix B.4 (Stack: merge)

## Goal
Only an owner or maintainer signed in with a browser session can merge, and only while the one merge predicate holds: the first unmerged item, in review, at its accepted generation with no pending work, rebase or open wait, and at exactly the PR head the person reviewed. A moved head, a pending edit or steer, a rebase, a reorder or an out-of-order request merges nothing.

## Scope

- Delete all legacy TODO Land controls and their controller/flow bindings in this ticket. This includes removal from StackCard and ChangeCards; the new Merge and Confirm Views stay with their UI tickets. Check: C-STK-07.
In:
- `POST /api/todos/{n}/merge {reviewed_head_sha}` and the `/merge Tn` catalog command (`agent: confirm`, kind `review_merge`; agents get a Review & merge confirmation, and execution requires an eligible person session, mvp.md Appendix B.2).
- T-ACC-03 authorizes session eligibility and role before readiness. `DecideMerge` applies authorization then the single `MergeReady` predicate for route, projection, confirmation and dispatch/recovery. Required reviews must satisfy GitHub branch protection; otherwise `merge_block.reason = review_required`. Check: C-STK-07.
- Consume T-STK-12's `LockStack`, `todos.merging` and held-signal delivery (§10.6.2b). This ticket owns the locked merge predicate, fresh pre-dispatch rechecks, dispatch and restart reconciliation. Shared primitives refuse fenced mutations and hold steers, review comments, rebases and proposes (C-STK-07).
- `todo_approvals` rows carrying the D-23 rule: an approval counts only from a person's session and only for the generation and PR head it names (§10.6.2c); a new generation voids it.
- GitHub merge with `sha = reviewed_head_sha` and `merge_method = squash`; `in_review → merged` once GitHub reports the merge and `main` contains the commit.
- The linked issue closes only when `fixes_issue` is true.
- `merge_block = {reason, detail?}` on the `home` and `todo:<n>` projections, from `MergeReady` (§10.6.2a): "Merges after Tn", the failing required check's name, GitHub's refusal text as received, or the reason code.
- One merge path: delete the `automerge`-label merge, Land and `change.land` paths in this change (mvp.md Appendix B.4: "today it merges on the `automerge` label").

Out:
- The Confirm card and person confirmations for delegated credentials (T-ACC-05, T-APP-04).
- Reading required checks from branch protection, protection reason text and out-of-order merges on GitHub (T-GH-05).
- Implementing outbound idempotency keys and crash reconcile (T-GH-09); the merge path must consume them before it is enabled.
- New card Views, generic Plue landing removal, direct agent merge and host execution of checks.
- The squash-merge check at setup (T-INS-06). Stacked PR bases (spec §0 [D]).

## Changes

- This ticket owns deletion of the `prs.land` command handler and its install route. T-APP-04 owns binding and removal of the control only. Preserve Plue-only landing services and routes. Check: C-STK-07.

- Complete TODO Land deletion inventory: remove the history.land button in `apps/app/src/mainview/cards/StackCard.tsx:111`, the change.land button in `apps/app/src/mainview/cards/ChangeCards.tsx:1023`, the HISTORY_LAND_USER_ONLY_REASON import and policy row in `apps/app/src/mainview/flows/Flows.ts:72` and `:119`, and the AppController type/binding entries for landStackItem (`apps/app/src/mainview/state/AppController.ts:528`, `:1781`) and landChange (`:603`, `:1837`). Update the matching StackCard, ChangeCards, flow-order, agent-parity and controller tests. This removal of legacy controls is in scope; new Merge/Confirm Views remain owned by their UI tickets. Check: C-STK-07.

- S22: Row 9, after required checks pass, requires the PR not to be draft, including when GitHub's `mergeable` field is true. A draft PR returns HTTP 409, class `github`, code `github`, with GitHub's supplied draft refusal text verbatim, or detail and message `PR is still draft on GitHub` when none is supplied; no merge PUT is sent. This check precedes other mergeability evaluation within row 9. The normal first-item ready transition (§12.5.1) runs through §12.4; Merge and confirmation approval do not change draft state themselves, and a refused confirmation remains pending under §10.6.2c. Checks: C-STK-07.


- S21: At row 1, when the supplied PR lifecycle fact is known and closed unmerged, refuse with HTTP 409, class `conflict`, code `state`, detail and message `PR is closed on GitHub`; do not fall through to head or check failures. A live recheck that discovers this fact clears its fence and submits the same inbound close transition used by polling (§12.3), without a merge PUT. A PR reported merged is reconciled as a merge fact, not classified as closed unmerged; completion still waits for its commit on `main`. Earlier authorization failures retain priority. Checks: C-STK-07.


- S20: After live reads and immediately before claiming dispatch, `DecideMerge` rechecks the approving person's credential eligibility, current membership and role, and confirmation ownership where applicable; it never treats a stored approval as current authorization. The dispatch claim serializes with role changes and credential revocation, so a downgrade or revocation committed first sends no PUT, clears this operation's fence and returns the applicable permission or unauthenticated refusal. It records the reason any existing approval is no longer usable. A change committed after the claim cannot cancel a sent GitHub request; its outcome is reconciled as usual. Recovery applies the same check to the recorded person and bound authorization, without minting a session. Checks: C-STK-07.


- S19: An idempotency record is scoped to the authenticated actor and stores the operation, subject and canonical validated request, including the normalized reviewed SHA for Merge. After authentication and authorization to access the recorded result, the same key with the same operation, subject and canonical request returns the original result without executing again. The same key in that actor's scope with a different operation, subject or canonical request returns HTTP 409, class `conflict`, code `idempotency_mismatch`, message `Idempotency-Key was already used for a different request`, and creates no new confirmation, fence, approval or outbound write. Checks: C-STK-07.


- S18: If a person marks a later PR ready on GitHub without a stack-position change, sync its actual draft state and do not issue a corrective redraft merely because it is later. Smithers still enforces §10.6.2a's order and shows `Merges after Tn`. A subsequent change of position applies the ordinary ready/draft policy through §12.4, subject to its event and conflict reconciliation. If that later PR actually merges, apply §10.6.4. Checks: C-STK-07, C-STK-04.


- S17: At boot, recover unsent `pending` merge rows as well as `unknown` merge rows. A pending row whose PR is already merged settles `done`; otherwise it sends its first request only with its existing bound session approval, current approving-member authorization and a fresh `DecideMerge` under a newly acquired or verified merge fence. If those conditions fail, settle it `superseded`, retain the approval's receipt and expose the current decision on the card. Before crossing the send boundary, durably claim the row as potentially sent; a crash after that claim recovers by lookup as `unknown`. An unknown row looks up the PR and, only if it is open at the reviewed head and the same authorization/readiness conditions hold, may repeat once as this table specifies. Recovery neither fabricates a new approval nor sends an approval with no outbound merge intent. Only the matching operation's verified fence is excluded from row 4 during its own dispatch/recovery decision; every competing fence still refuses with `merging`. The statement that merges are never superseded in §12.4.1a forbids supersession by newer queued writes, not the failed-precondition outcomes here or the external fold in §10.6.2b. Checks: C-STK-07.


- S16: Every item marked merged by a proven containment fold receives the ordinary merged effects, including closing its linked issue only when `fixes_issue` is true. The closing comment links the PR and commit that actually landed its change and names `Merged via #<n> (Tk)`. Issue-close and comment writes use §12.4's durable deduplication; duplicate polls create no additional writes. An external merge or containment fold never creates a `todo_approvals` row. Checks: C-STK-07, C-STK-04.


- S15: Containment is proved from the PR head actually merged, fetched from GitHub, matched to the persisted accepted-generation PR head and its immutable prefix manifest of item identities, generation heads and changes. That manifest must record which changes are present in that candidate, not merely which items preceded it. The reported merge commit must also be present on `main`; squash ancestry alone is not evidence of earlier-item containment. If the merged head does not match a retained accepted head, the manifest is missing, or inclusion of an earlier change cannot be proved, do not mark that earlier item merged, close its PR or close its issue. Mark the directly merged PR's TODO merged once its merge commit is on `main`, fold the mirror, and add an order attention entry `Tk merged out of order; containment of Tj is unverified` for each unproven earlier item in pre-fold stack order. Proven contained items still fold normally. Later rebases continue under §10.6.3; Smithers merges remain blocked by the attention. Missing head evidence is retried by polling; an ambiguous head is never guessed to contain another item's work. Checks: C-STK-07, C-STK-04.


- S14: A GitHub merge confirmed on `main` is an exception to fence deferral: its inbound transition and containment fold take the stack lock and TODO locks in the usual order, apply even across a set fence, and clear fences for items actually marked merged. The dispatch claim and this fold serialize on those locks. A fold that wins before dispatch makes the unsent merge row `superseded` and sends no PUT; a dispatch that wins may finish but its result cannot revert or repeat the inbound transition. An already-sent row remains subject to target serialization and lookup until settled, even after the TODO fence clears. The originating request returns HTTP 202 with `{state: requested}` if the target is proven merged by the fold; otherwise it returns its normal decision or GitHub refusal. Held inputs remain recorded and undelivered for merged items. Checks: C-STK-07, C-STK-04.


- S13: A stack has at most one open `order` attention row. Each new out-of-order merge appends an event entry to that row, deduplicated by PR identity and merge commit, and increments its revision; entries preserve application order and each entry's sentences follow pre-fold stack order. OK requires an eligible maintainer session and the displayed attention revision. If an entry arrived after that revision, return HTTP 409, class `conflict`, code `stale_attention`, keep the row open and show its current entries. A duplicate poll appends nothing. Checks: C-STK-07, C-STK-04.


- S12: For one out-of-order merge containing several earlier items, create one order attention entry for that merge event. Its text joins, with a newline, one sentence per contained earlier item in pre-fold stack order: `Tk merged before Tj; Tj's change is in Tk's commit`. Each earlier item's note contains only its own sentence, and each open earlier PR receives `Merged via #<n> (Tk)` once. Checks: C-STK-07, C-STK-04.


- S10: A recorded session approval is retained after a definitive GitHub refusal, with an activity receipt naming its generation, head and failure; clearing the fence does not erase it. A Review & merge confirmation remains pending after such a refusal unless its revision or lifetime has expired; it becomes approved only when GitHub confirms the merge. A retained approval is not permission to retry a definitively refused merge automatically: retry requires another explicit eligible session press and a fresh `DecideMerge`. Reconciliation of a pending or unknown dispatch follows §12.4.1b. Voiding an approval because work, generation or head changed records why it was cleared before removing it from the active approvals; a head change expires its pending confirmation. Checks: C-STK-07.


- S9: A definitive refusal from GitHub's merge endpoint returns its HTTP 405, 409 or 422 status in the §6.2.3 envelope with class `github`, code `github_refused`, and GitHub's `message` verbatim. If the response may mean the PR is already merged, look up the PR before treating it as a refusal: a confirmed merge settles the outbound row `done`, returns HTTP 202 with `{state: requested}`, and projects completion only after `main` contains the commit. A timeout, reset or response that cannot establish whether the write took effect leaves the outbound row `unknown` and follows §12.4.1b, rather than clearing its fence as a definitive refusal. Checks: C-STK-07.


- S8: Unless a more specific rule names a code, a credential-scope, actor-eligibility, minimum-role or confirmation-owner refusal returns HTTP 403, class `permission`, code `permission`. The explicit delegated `never` refusal retains class and code `never`; §5.1.0 retains `owner_unverified`. Checks: C-STK-07.


- S7: After authorization succeeds for execution or eligible confirmation creation, `reviewed_head_sha` must be a string of exactly 40 hexadecimal characters; normalize it to lowercase. A missing, empty or malformed value returns HTTP 400, class `user`, code `invalid_reviewed_head_sha`, message `reviewed_head_sha must be a 40-character hexadecimal commit SHA`, before any confirmation, fence, approval or outbound merge row is created. A well-formed value differing from the PR head fails row 8 with `stale_head`. Checks: C-STK-07.


- S6: For Merge and merge-gating approval, an absent or invalid credential, a setup-only session, or a credential revoked because its member is suspended or removed returns HTTP 401, class `permission`, code `unauthenticated`. A valid provisional-owner session instead retains §5.1.0's `owner_unverified` permission refusal. Neither refusal creates a confirmation, fence, approval or outbound merge row. Checks: C-STK-07.


- S5: An S1 `delegated(via=terminal)` credential requesting Merge is refused with HTTP 403, class `permission`, code `permission`, without a confirmation or merge side effect. In S2 the same `via` follows the full catalog policy and an eligible owner or maintainer receives the usual Review & merge confirmation. Checks: C-STK-07.


- S4: `DecideMerge` is the shared decision function for the merge route, the viewer's `merge_block`, Review & merge confirmation approval, and dispatch or recovery rechecks. It applies the catalog authorizer and then the single `MergeReady` predicate; eligible delegated creation yields Confirm without executing a merge. The caller supplies synced facts for projection and live facts for dispatch. At rows 8–9, a required fact that has never been synced or whose stream is not fresh under §12.2.3 returns HTTP 409, class `conflict`, code `rechecking`, detail and message `Waiting for fresh GitHub merge facts`. Unknown required-check configuration is not an empty required-check set. Earlier failing rows retain priority; known facts use the normal row reasons, including the known-null rule. Checks: C-STK-07.


- S3: If GitHub reports `mergeable: null`, re-read the PR once after 2 seconds. If it is still null, refuse with HTTP 409, class `github`, code `github`, and detail and message `GitHub is still computing mergeability`; clear the fence and send no merge request. Re-evaluate rows 8–9 against the second read, including checks for its head. Checks: C-STK-07.


- S2: Row 9 first evaluates required checks: a failed or pending required check returns HTTP 409, class `conflict`, code `checks`, with its name as detail and message. If several checks block, choose the first by bytewise check name, then stable GitHub check identifier. Only after required checks pass does a known non-mergeable PR return HTTP 409, class `github`, code `github`; any GitHub reason text is preserved verbatim. If no reason text is supplied, detail and message are `GitHub reports this PR is not mergeable`. Checks: C-STK-07.


- S1: For merge readiness refusals, zero GitHub calls means zero calls to the merge endpoint (`PUT /repos/{owner}/{repo}/pulls/{number}/merge`); the reads required by §10.6.2b are permitted. Authorization refusals do not start readiness reads or create a fence, approval or outbound merge row. Checks: C-STK-07.

- `packages/backend/internal/services/todo_merge.go` (new) → `Merge(ctx, n, reviewedHead)`: authorize `merge` through `Authorize` (T-ACC-03); refuse token auth (`AuthInfo.IsTokenAuth`, `internal/middleware/scope.go:59`) so only a session passes; evaluate `MergeReady` rows 1-7 and set the fence in one transaction that locks the stack row, then the TODO row; recheck before dispatch with a fresh capture when the machine is awake, `git ls-remote` of `main`, the PR read live (`mythicalGitHubAPI.Pull`, `mythical_github.go:258`) and checks with their `required` flag (T-GH-05); insert `todo_approvals` with the generation; call `Merge` (`:314`, already `sha` + squash) through the outbound path (T-GH-09); the fence is the merge-in-flight marker that `smthrs host upgrade` and `POST /api/install/quiesce` read (§16.4, §16.5).
- `packages/backend/internal/services/mythical_items.go` → `gate` (`:2238`) stops after the agent review and never calls `merge` (`:2435`). Delete the label applier checks (`:2466-2516`), `automergeLabel` (`:65`), `checks.Automerge`, `checks.Land` and `landedByMaintainer`. Completion (`complete`, `:3168`) closes the issue only when `todos.fixes_issue`.
- After a merge, later items rebase onto the new `main` and their open PRs are force-updated (§10.6.3) through the existing integrate path. Record the voiding reason before deleting active approvals when a new generation starts (S10).
- `todo_approvals.generation` migration remains here. T-STK-12 owns the `todos.merging` migration (C-STK-07).
- Consume `LockStack(tx)` and `FenceSet(tx, todo)` from T-STK-12 in every merge transaction. Do not create another lock or held-signal queue (C-STK-07).
- `packages/backend/internal/routes/todos.go` (new) → the merge route. Refusals use S1–S22’s exact §6.2.3 envelopes and row precedence. Authorization is T-ACC-03’s decision; `MergeReady` owns readiness only. Eligible delegated requests return 202 with a private confirmation through T-ACC-05; only its author’s eligible session executes Merge (§5.2.1, C-ACC-02).
- Delete `packages/backend/internal/services/mythical_land_todo.go`, `mythical_land_todo_test.go`, route `POST /mythical/items/{id}/land` (`internal/compose/router.go:1123`, `routes/mythical.go:321`) and its OpenAPI row (`docs/api/openapi/repositories.yaml:12095`).
- Delete the app doors: `history.land` and `HISTORY_LAND_USER_ONLY_REASON` (`apps/app/src/mainview/flows/entries/history.ts:24`, `:120`), `StackSeam.landStackItem` (`state/seams/StackSeam.ts:613`), `landable` (`packages/rpc/src/StackView.ts:81`), `change.land` (`flows/entries/change.ts:76`) and `ChangeSeam.landChange`/`land` (`state/seams/ChangeSeam.ts:1347-1364`), with their tests.
- `docs/api/openapi/todos.yaml` → the merge row; regenerate `ProductApi.ts` (`smthrs run //:openapiClients`); update `packages/backend/docs/todos.md` and run the docs gates.

## Tests

- Wire T-ACC-05’s confirmation-to-action seam to the real merge service before enabling Merge. Drive production confirmation approval and merge routes through the composed router with real PostgreSQL and fake GitHub. Prove C-ACC-02’s session/role/revision checks, pending-on-state-conflict behavior and outbound reconciliation through T-GH-09 after a kill between approval and the external call. A test-only merge handler cannot discharge this gate. Keep Depends on T-ACC-05; do not add a reverse edge.
- `review_merge` binds generation plus reviewed PR head. Changing generation with unchanged displayed head refuses without effects. MergeReady and definitive GitHub refusals leave the confirmation pending; only confirmed merge approves it. Prove through the real approval route and production merge consumer. Check: C-ACC-02.
- Include `prs.land` in the C-STK-07 executable-door deletion gate; assert its install command and route are absent and the control binds only the supported Merge command.

- C-STK-07 deletion gate: search app/backend/OpenAPI production sources and tests for history.land, change.land, HISTORY_LAND_USER_ONLY_REASON, landStackItem, landChange and the removed TODO Land route. No executable TODO Land door, controller binding or obsolete test expectation remains. Render the production StackCard and ChangeCards and assert no Land dispatch; verify TODO Merge/Confirm use the authorized merge route. Preserve Plue LandingService and its Plue-only API. Run existing app type and flow-parity gates.

- C-J2-05: TODO and Confirm use the same required-check decision at the reviewed SHA. Failed optional plus passed required permits merge; pending required blocks both Containers and the service, with zero GitHub calls.
- Unit, `todo_merge_test.go` (new): the guard table. Each guard fails alone (delegated, run and machine credentials; member role; each `MergeReady` row of §10.6.2a with its reason code) and yields no merge PUT. The shared `DecideMerge` function gives the route's refusal and `merge_block`.
- Integration with real PostgreSQL and the fake GitHub server, `todo_merge_db_test.go` (new): a maintainer session merges T1 at its head. Exactly one `PUT /pulls/{n}/merge` with `sha` and `merge_method=squash`; one `todo_approvals` row; `merged` only after `OnMain` (`mythical_github.go:539`) is true.
- Integration, same file: a head change after approval deletes the approval, and a merge with the old head is refused.
- Integration, same file: the issue closes for `fixes_issue = true` and stays open for `false`.
- Unit, `mythical_items_test.go` (existing): no worker pass calls `Merge`, whatever labels the issue carries.
- Integration, `todo_merge_race_db_test.go` (new), for C-STK-07: a steer, an edit, a reorder, `rebase_pending`, a `main` move and a second merge, each against a merge the fake GitHub holds; zero merge PUTs for pre-dispatch refusals; one initial PUT and at most one lookup-authorized repeat after uncertainty; the fence reconciled after an engine restart.

## Acceptance






- [C-J4-03](../checks/C-J4-03.md): only the first unmerged item merges; later items show "Merges after Tn".
- [C-ACC-02](../checks/C-ACC-02.md): eligible delegated requests return 202 with a private confirmation and no merge; run and machine credentials get `permission` refusals. Only the requesting person’s eligible session approves and merges.
- [C-J2-05](../checks/C-J2-05.md) (S1 part): merge turns the TODO Merged and closes the issue only when it fixes it.
- [C-STK-07](../checks/C-STK-07.md): races against Merge merge nothing stale; concurrent merges make one GitHub call.
- [C-J1-04](../checks/C-J1-04.md): First TODO to merged PR, unassisted, within 60 minutes of starting the install

## Risks and notes
- May start against T-ACC-03's final `Authorize` seam using test-only fixtures. Land after T-ACC-03 and every listed dependency; C-ACC-02 must use the real authorizer.
- `/api/repos/{o}/{r}/landings*` and `LandingService` (`services/landing.go`) still serve Plue. This ticket deletes only their TODO doors. The routes stay for Plue and are unmounted in the install composition, with `x-composition: plue` on their OpenAPI rows (§6.2.4); T-CUT-02 does the unmount.
- Risk: GitHub reports `mergeable: null` while it computes. Observation: a refusal on a fresh PR head in the integration log. Retry the read once after 2 s before refusing.

## Ready checklist

1. Dependencies include credentials/confirmation, independent waits, required-check data and reads, outbound recovery and the isolation launcher. Resolve the T-GH-05 and T-GH-09 prerequisite cycles listed in the edit draft before start.
2. Out names Confirm Views, implementing check ingestion and outbound recovery, Plue landing removal, direct agent merge, host checks and stacked PR bases. Consuming prerequisite services is in scope.
3. C-STK-07 and `todo_merge_db_test.go` call `POST /api/todos/{n}/merge` through the install router with real middleware, PostgreSQL and GitHub fake. C-ACC-02 exercises `/merge` and confirmation approval through the production catalog dispatcher. Assert each literal guard fixture’s route status, merge_block and GitHub call count. Expected statuses, graphs, timings and outputs are literal test fixtures or independent input logs. No test reads spec files or computes expectations from production code at runtime.
4. smithers-8a decides merge-contract changes and Plue/install deletion ambiguity. smithers-b8 approves catalog/app seams; smithers-38 signs off removing `landable` under §21.1.
5. Before start, smithers-3f: do all stack writers use the same lock/fence; do fresh capture and outbound recovery prevent stale or duplicate merge? smithers-b8: do delegated requests use confirmation and all TODO Land doors disappear? smithers-38: is removing `landable` complete for every caller? Legacy Land-control deletion is in scope; new View behavior still needs smithers-06 pre-review. smithers-3f: answered, BLOCKING edits applied (tech lead adopts). smithers-b8: answered, BLOCKING edits applied (tech lead adopts). smithers-06: answered 18:3x, ok. Design condition: "ok. The Merge control uses the §10.6.2a reasons, with failed checks in ember and waits neutral."
6. Fresh capture uses the machine boundary. Checks and repository flows never execute on the host; T-INS-02 refuses missing isolation (§1.3). Packaged host Git operations on captured trees disable repository hooks/helpers (§10.5.5). smithers-3f reviews this boundary and session-only execution; C-STK-07, C-ACC-02 and C-SEC-02 prove it.

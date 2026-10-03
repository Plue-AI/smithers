# T-GH-05 Checks on every PR, protection text, closed/reopened, out-of-order merge marks both merged

Stage S1 · Size M · Depends on T-GH-02, T-STK-01, T-STK-07, T-GH-09, T-STK-02, T-STK-12, T-STK-13, T-ACC-03, T-FLW-11, T-MCH-14 · Unblocks T-APP-01, T-GH-03, T-GH-04, T-GH-06, T-GH-07, T-REL-02, T-STK-04, T-STK-10 · Issue: [#3517](https://github.com/smithersai/smithers/issues/3517)
Spec: spec.md §3.0, §4.1, §4.1.2a, §6.1.2 (in-card), §10.6.2, §10.6.4, §12.1.2 (`administration: read`), §12.3 (checks, approved, merged, closed rows), §12.4.1, §14.5.2 · Delta: delta.md §7 "PR closed → dropped…" · Product: mvp.md J10.5, §6.3 (checks, merged, closed, branch protection rows), M-22

## Goal
Every TODO PR shows its GitHub checks by name, a blocked merge shows GitHub's own sentence, and a merge, close or reopen made on GitHub moves the TODO to Merged, Dropped or back to In review exactly as if done in Smithers. A later draft un-drafted and merged first marks both items merged with a note, folds `main`, and asks maintainers for an OK.

## Scope

- `order.ok` requires an eligible maintainer person session. Eligible delegated credentials return HTTP 403, class and code `never`; lower roles return HTTP 403, class and code `permission`. A stale attention revision returns HTTP 409, class `conflict`, code `stale_attention`, without clearing attention. Check: C-STK-04.

- Each inbound PR transition commits its consumed-fact/deduplication receipt, TODO/item changes, semantic events, projections and all keyed outbound intents in one PostgreSQL transaction. A rolled-back transition admits no effects; only committed intents reach GitHub. Recovery reconciles remote success before retrying a keyed write. Checks: C-GH-13, C-J10-08, C-STK-04.

- Read required-review satisfaction from GitHub branch protection/rulesets and publish it as merge facts. `MergeReady` returns `review_required` until satisfied; T-ACC-03 owns role authorization. Check: C-STK-07.

In:
- Checks on every TODO PR head, not only on the automerge path. The `pr-state` stream (T-GH-02) feeds `{name, status, conclusion, required}` into the latest attempt's evidence, the `todo:<n>` evidence's GitHub check items and the home `merge_block`.
- Required checks come from `main`'s branch protection and rulesets, read with `administration: read` (§12.1.2). A failed required check holds Merge and names itself (§12.3). Other failures show in evidence but don't block.
- GitHub's refusal text, built (delta.md §7): `landingGitHubStatusError` (`landing_github_pull.go:421-453` (`request`) and `:455-465` (`landingGitHubStatusError`)) discards the response body today and returns generic sentences. Keep the body's `message` and `errors[].message` on every non-2xx response, so a blocked merge shows GitHub's sentence, for example "1 approving review required on GitHub" (§10.6.2).
- PR merged on GitHub → `merged` once `main` contains the commit (§4.1). The linked issue closes, with a comment linking the change, only when `fixes_issue` is true. Later items are force-updated (§10.6.3).
- PR closed unmerged → `dropped` with `state_reason` "closed on GitHub by @x", the actor read from the issue's `closed_by`. Later items get `rebase_pending` (§4.1 drop guard).
- PR reopened within 7 days → `in_review` (§4.1) at the TODO's previous stack position when it is still free, otherwise appended. `smithers/<slug>` is recreated on GitHub from the last verified candidate captured in the host repository store, whatever happened to the machine (§12.3). A TODO dropped by a GitHub close stays followed for those 7 days.
- Out-of-order merge (§10.6.4): someone un-drafts a later item's PR and merges it first. Its squash commit contains the earlier unmerged items' changes. The engine marks the merged item and every earlier unmerged item it contained as `merged`, notes on each earlier one "T3 merged before T2; T2's change is in T3's commit", folds `main`, and opens `stack_attention{kind: order}` for maintainers with that sentence (§4.1.2a). The attention holds the stack's merges until a maintainer presses **OK** (in-card). Later items rebase as after any merge.

Out: GitHub branch-protection or ruleset administration; GitHub App permission expansion; card Views and Containers; automatic replay of a merge approval; starting a reopened TODO's next attempt (T-STK-05); the merge command and its session and role guards (T-STK-04); rebase execution (T-STK-08, T-STK-11); the PR body and draft state (T-GH-03); keyed issue close and comment writes (T-GH-09 wraps them); stacked bases ([D]); merge methods other than squash (§10.6.2 fixes squash).

## Changes

- Document definitive GitHub merge refusals as HTTP 405, 409 or 422 passed through with class `github`, code `github_refused`, and GitHub’s message. Preserve T-STK-04’s lookup and uncertainty rules. Check: C-STK-04.

- Replace direct completion CloseIssue followed by SaveMythicalItem with the atomic inbound transition and T-GH-09 keyed outbound intents. Route every landingGitHubStatusError caller through the typed body-preserving error, including `packages/backend/internal/services/mythical_github.go:329`. Checks: C-GH-13, C-J10-08.

- Owner smithers-3f: pure `decideGitHubFact(fact, todo, item, now) → Decision{Events | Noop reason | Attention kind}` in `github_inbound.go` owns the §12.3 fact TSV mapping. Set exactly one outcome. Derive item mutation from the decision; duplicate and stale facts record no-ops. Poll, review and foreign-push consumers have no private mapping. Checks: C-GH-13, C-STK-04.

- `packages/backend/internal/services/github_inbound_pulls.go` (new) → the T-GH-02 consumer for PR state and checks of TODO PRs, reading the `github_synced_*` store (§3.0).
- `mythical_items.go` (`follow`) consumes `decideGitHubFact`. Prove containment from the actually merged accepted head and immutable prefix manifest; stack position alone proves nothing. Apply S12–S16 attention, partial-proof and durable close effects. Check: C-STK-04.
- `mythical_items.go:85` (`mythicalSettledStates`) → keep GitHub-closed TODOs followed for 7 days.
- `packages/backend/internal/services/mythical_github.go` (`HeadChecks`): migrate both merge and completion callers to the synced PR-head checks and required-check configuration. Completion currently calls HeadChecks at `packages/backend/internal/services/mythical_items.go:3224`; preserve the completion comment’s named check evidence from the synced facts, with no second per-head REST path. Check: C-GH-13.
- `packages/backend/internal/services/landing_github_pull.go:421-453` (`request`) and `:455-465` (`landingGitHubStatusError`) → parse the response body and carry `message` and `errors[].message` verbatim in the typed error (§6.2.3 class `github`).
- `mythical_items.go:2455` ("CI failed on the approved head") and `:2532` ("GitHub refused the merge") → the named failing checks and GitHub's sentence.
- `mythical_items.go:3168-3255` (`complete`, `completionBody`) → close the issue only when `todos.fixes_issue`, through T-GH-09's keyed close/comment adapters. This ticket owns the inbound close/reopen transaction: cancel the closed attempt through T-FLW-11, retain final capture through T-MCH-14, restore the last accepted generation and position through T-STK-02 on reopen, and leave no live run. T-STK-05 owns the subsequent input-triggered attempt. Check: C-J10-08.
- Catalog: **OK** on the `order` attention as an `in-card` command, maintainers only (§6.1.2), through `POST /api/stack/attention/{id} {action: ok}` (shared with T-GH-07); OpenAPI row in `docs/api/openapi/`.
- `packages/backend/docs/github-sync.md` → "Checks, merges and closes" section; docs gates as in T-GH-02.

## Tests

- C-STK-04 integration uses the production OK route with delegated maintainer and owner credentials, lower roles and a stale displayed revision. Assert `403 never`, `403 permission`, `409 conflict/stale_attention` and no effects. Assert GitHub 405/409/422 `github/github_refused` envelopes through the production merge route.

- Integration (C-GH-13, C-J10-08, C-STK-04): crash immediately before the inbound transaction commits, immediately after commit and after remote close/comment success before local acknowledgement. Replay the same fact through production polling. Assert zero transition/receipt/intents before commit; one transition, receipt, projection and keyed intent set after commit; and remote-success reconciliation without another effective close/comment after restart. Read literal named completion evidence from synced checks and assert no per-head REST request from either HeadChecks caller.

- Required-check/protection tests use backfilled open PRs and fixed PR fixtures; PR-shape end-to-end cases run after T-GH-03. Check: C-STK-07.

- Unit, `github_inbound_pulls_test.go` (new): checks classification by name and `required` from classic protection and from a ruleset.
- Unit, `landing_github_pull_test.go` (extend): a 405 body `{"message":"At least 1 approving review is required by reviewers with write access."}` reaches the merge refusal unchanged; a 422 with `errors[]` keeps each message.
- Unit: committed literal state fixtures for {merged in order, merged out of order, closed, reopened at day 6, exactly day 7, reopened at day 8, closed twice} with a fake clock. The 7-day boundary is inclusive (§12.3.0a).
- Integration, real PostgreSQL + real git + `githubfake`: start T-GH-02 in the production install worker composition, inject only clock/GitHub, and observe committed TODO events and outbound write logs. Close/reopen and containment facts enter through scheduled fetches, never a direct decision call. Use the production `POST /api/stack/attention/{id}` route for OK with its displayed revision and `Idempotency-Key`. [C-J10-08](../checks/C-J10-08.md).
- Integration, [C-STK-04](../checks/C-STK-04.md): T3 un-drafted and merged while T2 is first → T2 and T3 `merged`, T2's note, `main` folded, `stack_attention{order}` visible to maintainers and refused to members, later merges held until **OK**.
- Integration: a reopen restores the previous position when free and appends otherwise, and recreates the GitHub branch at the last verified candidate after the machine was cleaned up.
- Integration: `fixes_issue` false leaves the issue open; true closes it with a comment linking the merge commit, and only after the main pull shows the commit.
- e2e: [C-J10-05](../checks/C-J10-05.md). The merge-refusal sentence is a step of [C-J4-03](../checks/C-J4-03.md): branch protection requires one review, and Merge shows GitHub's sentence.

## Acceptance





- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.


- [C-GH-13](../checks/C-GH-13.md): pure fact matrix and production consumers use one decision seam.

- [C-J10-05](../checks/C-J10-05.md): a merge on GitHub turns the TODO Merged and closes its issue with a link.
- [C-J10-08](../checks/C-J10-08.md): a close on GitHub turns the TODO Dropped with the actor; a reopen within 7 days restores In review.
- [C-STK-04](../checks/C-STK-04.md): a later draft merged first marks both items merged with the note, folds `main`, and opens `order` attention settled by OK.
- [C-STK-08](../checks/C-STK-08.md): Independent waits: question + foreign push, pause + conflict, Stop with open waits, resume after step 1, and merges on GitHub during a steer, a question or a pause each give the §4.1.0a state

## Risks and notes
- Risk: `closed_by` can be null for a PR closed by deleting its head branch. Confirmed by deleting a TODO branch on the scratch repository and reading `GET /issues/{n}`. The reason then reads "closed on GitHub".
- Resolved: §10.6.4 closes each earlier item's open PR with "Merged via #<n> (Tk)" through `outbound_writes`.
- Resolved: mvp.md Appendix B.4 now has `order.ok` for the order attention's **OK** control, and spec §6.1.2 names OK.

## Ready checklist

1. Dependencies supply synced facts, waits, ordering, accepted-generation manifests, state precedence, authorization, durable outbound effects and close-time run/capture safety. T-GH-05 implements inbound close/reopen restoration; T-STK-05 owns later work restart, avoiding a cycle through T-STK-04. Full C-J10-08 steps 4b–4c and merge-route cases wait for those downstream callers.
2. Out excludes protection administration, App permission expansion, Views/Containers, approval replay, next-attempt launch, merge commands, rebase execution and non-squash methods.
3. C-GH-13, C-J10-08 and C-STK-04 drive production polling and the OK route. Required-check fixtures assert literal names, required flags and refusal text; containment fixtures persist independently authored manifests, including partial/missing proof. No test reads spec files or computes expected values from production code at runtime. Downstream merge-route validation uses T-STK-04's real route after it lands.
4. smithers-3f approves fact decisions, containment and close/reopen transactions; smithers-b8 signs off catalog/OpenAPI payloads; smithers-8a accepts the close/reopen ownership split and any mapping or proof-policy change. Checks: C-GH-13, C-STK-04, C-J10-08.
5. Before start, smithers-3f: does the actual merged head's retained manifest prove each contained change; are close/reopen and outbound effects atomic and deduplicated; can restoration land without T-STK-04 or T-STK-05? smithers-b8: does OK bind the displayed revision and enforce maintainer sessions; do public errors retain GitHub's messages and statuses? smithers-38: do check facts and attention revisions fit the topic schemas? smithers-06: can existing Home/TODO Views display partial-proof attention and named checks without a new visual component? smithers-3f: answered, BLOCKING edits applied (tech lead adopts). smithers-b8: answered, BLOCKING edits applied (tech lead adopts).
6. Host work reads GitHub facts and immutable repository objects with hooks/helpers disabled; it never evaluates fetched code. Final capture and any work triggered after reopen run through the machine boundary (§1.3, M-29), with no host fallback. smithers-3f reviews this boundary. C-J10-08 proves retained capture/restoration; C-SEC-02 proves machine-only execution.

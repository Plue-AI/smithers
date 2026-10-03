# T-GH-04 Reviews and comments on TODO PRs become steers

Stage S1 · Size M · Depends on T-GH-02, T-STK-06, T-GH-03, T-ACC-04, T-MCH-14, T-ACC-02, T-FLW-11, T-STK-12, T-INS-02 · Unblocks T-REL-02 · Issue: [#3516](https://github.com/smithersai/smithers/issues/3516)
Spec: spec.md §2, §3 (`activity`), §3.0, §4.1 (`in_review → working`), §10.4.1, §10.7.3, §12.3 (review rows), §12.5.3, §14.6a, §17.1, §17.5 · Delta: delta.md §7 "Inbound reviews…" · Product: mvp.md J10.2, §6.3 "A review or review comment on a TODO's PR", §6.10 "Line comments", M-22
Ready: 2026-10-03 smithers-8a sha256:f162afb934d1

## Goal
A member's GitHub review, line comment or PR conversation comment on a TODO's PR reaches the TODO's run as a steer attributed to that person within 60 s, the TODO goes back to Working, and the agent's fix updates the PR.

## Scope

- Reuse `ActorSchema` and `ColorIndexSchema` in `packages/rpc/src/CardPrimitives.ts:30,129-150` unchanged: member colors 0–5, undelegated agents 6, GitHub/outside 7. Decode GitHub authors with `kind: "github"`, `login` and `color_index: 7`; resolve active members to their existing person actor. Preserve record-only outsider behavior. Check: C-J10-02.
In (adopted owner pre-review):
- Use one transaction for activity, delivery key, TODO transition/events and durable steer signal intent. Supply a transaction-aware signal admission API; a separately committed dispatcher Admit call does not join the transaction. Dispatch only after commit and recover pending intents idempotently. Resolve the GitHub author to a current active member at steer admission and again before held delivery; removed, suspended and outsider authors have record-only activity and no effective steer. Check: C-J10-02.

In:
- Land dark against the declared contracts while any dependency is unavailable: T-GH-02 provides fetched facts and retryable delivery, T-GH-03 the decision seam, T-ACC-02 current membership, T-ACC-04 attribution, T-STK-06 transactional steer admission, T-STK-12 ordered input consumption, T-FLW-11 the durable TODO run, T-MCH-14 retained workspace/wake, and T-INS-02 microVM-only launch. Keep the consumer disabled until these providers are wired; refuse effective steers without authority or execution readiness. Preserve fetched facts for replay without acknowledging delivery or committing a TODO transition/signal on a missing provider. Enable only after C-GH-13, the C-J10-02 production integration cases and C-SEC-02 pass.
- Sources, all from T-GH-02 streams: reviews through the existing TODO PR reads, review comments (`GET /pulls/comments?since=…`) and conversation comments (`GET /issues/comments?since=…`) whose PR is a TODO PR. Reuse these reads; no GraphQL `pr-state` query or second poller (§12.2; delta.md §7).
- Mapping (§12.3):
  - A review with "changes requested", a review comment (a line comment or a commented review's body) or a conversation comment → one `activity` entry (kind `github`) with the GitHub mark, attributed to the member whose GitHub login wrote it.
  - From a member: one steer per review submission (its body plus its line comments batched, each anchored `path:line` with the commit it was made on) or per standalone comment, through T-STK-06's steer path; `in_review → working`, and approvals for the old head are void (§4.1).
  - From a non-member: the activity entry uses `ActorSchema` with `kind: "github"`, `login` and `color_index: 7`, rendered "@login" with the GitHub mark (§14.6a), and is never delivered as a steer (§17.5).
  - "Approved" → recorded on the PR card (`todo:<n>` PR `reviews`). Never a Smithers approval (§10.6).
  - An edited comment updates its entry and is re-delivered only if the run hasn't consumed it; a deleted one hides its entry and withdraws its steer only while held, never after delivery (§12.3.0a). A member review while failed is held for Retry; it does not start an attempt.
- Each GitHub object id is delivered at most once, whether it arrives by poll, webhook hint, replay or after a restart.
- Comments and reviews made by the install's own App are ignored.
- `pull_request_review_comment` joins the accepted webhook events, so a delivery triggers its stream's fetch (§12.2.4).

Out:
- A new review service, delivery table, signal queue, GraphQL review scheduler, root setup/install step and changes to hosted Plue workers are excluded. A {github: login} wire variant, a second color schema and RPC implementation outside the existing RPC schema are excluded. GitHub App permission changes; evaluating GitHub text or running repository code on the host; UI Views and actor rendering (T-APP-09); in-app line comments and agent replies inside GitHub review threads ([D] §12.5.3); the steer delivery inside the run (T-STK-06); stacked bases ([D]); the Branch card that lists activity (T-APP-10, S2); `/review` on non-TODO PRs (unchanged).

## Changes

- Reuse `ActorSchema` and `ColorIndexSchema` in `packages/rpc/src/CardPrimitives.ts:30,129-150` unchanged: member colors 0–5, undelegated agents 6, GitHub/outside 7. Decode GitHub authors with `kind: "github"`, `login` and `color_index: 7`; resolve active members to their existing person actor. Preserve record-only outsider behavior. Check: C-J10-02.
- Use one transaction for activity, delivery key, TODO transition/events and durable steer signal intent. Supply a transaction-aware signal admission API; a separately committed dispatcher Admit call does not join the transaction. Dispatch only after commit and recover pending intents idempotently. Resolve the GitHub author to a current active member at steer admission and again before held delivery; removed, suspended and outsider authors have record-only activity and no effective steer. Check: C-J10-02.


- Consume `decideGitHubFact` from `github_inbound.go`; no private mapping. Unit fixtures cover fact/state/duplicate/reordered cells; DB integration proves this consumer calls the seam. Check: C-GH-13.

- Reshape `packages/backend/internal/services/mythical_items.go:2163,2827` (`follow`, `ObserveGitHubEvent`): share one review/comment normalizer between the T-GH-02 fetched-fact consumer and poll fallback. Filter to TODO PRs, read `github_synced_*` (§3.0), consume T-GH-03's planned `decideGitHubFact` seam and call T-STK-06's `SignalInTx` contract. Reuse `packages/backend/flowdispatch/service.go:80,94` (`AdmitInTx`, `Signal`) and its durable jobs worker; do not add a separate review service or queue.
- `packages/backend/internal/services/mythical_items.go:2827` (`ObserveGitHubEvent`) → no review or comment payload handling; webhook deliveries only request fetches (T-GH-02).
- `packages/backend/internal/services/github_webhook.go:85-95` (`supportedGitHubWebhookEvents`) → add `pull_request_review_comment`.
- Reuse T-GH-02's durable consumer delivery identity/receipt and T-STK-12's input cursor. Record activity and review/comment lifecycle metadata in `product_job_events`; commit the receipt, TODO facts and signal intent together. Key the effective steer by object kind/id (review id for a batched submission), and track edits/deletions as versions of that input. Reuse `packages/backend/jobs/store.go:81` transaction admission; no `github_inbound_deliveries` table. Check: C-J10-02.
- Actor: adapt T-ACC-04's attribution contract to the unchanged RPC actor schema; T-ACC-02 supplies current membership. T-APP-09 owns rendering. Check: C-J10-02.
- Extend `packages/backend/docs/github-sync.md` supplied by T-GH-02 with "Reviews and comments"; do not create a second sync guide. Docs gates as in T-GH-02.

## Tests

C-GH-13 (folded steps and assertions):

Pass when:
- Decode the shared github_check facts {name, state, required, url}, ActorSchema kind:"github" authors and foreign_push waits with id/sha via the existing RPC schema. Assert wrong attention/wait bindings refuse with no effects; no parallel check or actor model exists.
1. Call `decideGitHubFact(fact, todo, item, now)` for every matrix cell.
2. Deliver poll, review and foreign-push facts through their production consumer with real PostgreSQL.
3. Repeat and reorder each delivery and inspect semantic events and activity.
4. Crash the review/comment consumer before commit, after commit before signal dispatch, and after signal delivery before acknowledgement. Restart and replay through the production poll dispatcher; assert one effective steer. Retain the T-GH-03 cross-consumer fixtures: crash each T-GH-03 inbound consumer before commit, after commit and after a keyed remote effect succeeds but before acknowledgement. Restart and replay through production polling. Exercise both merge and completion check callers against the synced-head fixtures.
- Step 4: before-commit crash leaves no receipt, transition, projection or outbound intent. After-commit restart retains one complete atomic set. Replays and remote-success recovery add no effective close or comment. Merge and completion read synced facts with no second per-head REST path; the completion comment retains the literal named checks.
- Every cell has one asserted `Events`, `Noop reason` or `Attention kind` result; an unknown cell fails.
- Each consumer uses the pure decision, not a private mapping. Item mutation follows its events.
- Duplicate and stale facts record no-ops without repeated merge, issue-close or learning effects.

Fail when:
- A cell is unasserted, a consumer bypasses the seam, or duplicate delivery repeats an effect.


- Decode GitHub authors with kind:"github", login and color_index 7. Decode member 0–5, undelegated agent 6 and outside 7 fixtures; reject indices outside 0–7. Retain no-steer assertions for outsiders and removed or suspended members. Check: C-J10-02.
- Send reviews through production webhook hints/poll consumers with real PostgreSQL and the real durable signal receiver. Crash before transaction commit and after commit before dispatch; assert all-or-none rows and one recovered steer. Repeat held review delivery after author removal/suspension and include outsider authors: retain allowed activity attribution but no signal, TODO transition or authority from historical roster/login. Check: C-J10-02.

- Unit, extend `mythical_items_test.go`: the mapping over review state × author (member, non-member, own App) × location (line, review body, conversation) gives steer, record-only or ignore exactly as Scope states.
- Unit: a review with three line comments yields one steer carrying the three `path:line` anchors.
- Integration, `github_inbound_reviews_integration_test.go` (new): start T-GH-02 through the production install worker composition and advance its clock against real PostgreSQL and `githubfake`; send webhook hints through the production signed webhook route. The test-only process runtime runs only a packaged fixture, never repository flows or coding agents. Assert that a "changes requested" review moves the TODO `in_review → working`, appends one `product_job_events` row and one `activity` row with the GitHub actor, and the run receives one durable steer signal.
- Integration: the same review seen by poll, by a webhook hint and again after a host restart produces one steer and one event.
- Integration, same production install composition: omit each declared provider in turn. Poll and signed webhook hints produce no effective steer, TODO transition, consumed receipt, run launch or machine request; fetched facts remain replayable. Restore providers and replay to get one attributed steer. C-GH-13 and C-J10-02 gate activation.
- Lifecycle integration, C-SEC-02: send an active member's review through the production polling consumer to a sleeping TODO machine. Observe the resumed coding host and repository canary execution in the guest as a non-root uid without sudo, with no host execution. Remove the configured runtime or deny wake; the signal stays durable and no host fallback runs. GitHub text and anchors remain data and never become root commands or paths.
- Integration: an edit before the run consumes the steer replaces it; an edit after updates only the entry; a deleted comment hides its entry.
- Integration: an "approved" review changes no TODO state and creates no `checks.Land` row; a non-member's comment creates an entry and no steer.
- e2e: [C-J10-02](../checks/C-J10-02.md).

## Acceptance

- [C-GH-13](../checks/C-GH-13.md): pure fact matrix and production consumers use one decision seam.

- [C-J10-02](../checks/C-J10-02.md): a GitHub review comment becomes an attributed steer within 60 s, the TODO returns to Working, and the agent pushes a fix that updates the PR.
- [C-SEC-02](../checks/C-SEC-02.md): the review-triggered wake/resume uses the production machine lifecycle, executes repository code as non-root in the guest and refuses missing isolation without host fallback.

## Risks and notes
- Risk: a review arrives days after the PR opened, and the steer finds no live run or no workspace. The `todo` run waits durably after `stack.propose` (T-FLW-11, §10.4.1), and T-MCH-14 keeps the workspace and wakes it before delivering the signal (C-STK-05). Confirmed in the integration test when the steer signal has no run to deliver to.
- Risk: line anchors drift after a force-update. Confirmed when a comment's `line` is null and only `original_line` is set. Send `original_line` with the commit id.

## Ready checklist

1. Depends on explicitly covers polling/delivery (T-GH-02), decision (T-GH-03), active roster (T-ACC-02), attribution (T-ACC-04), transactional steers (T-STK-06), durable run (T-FLW-11), input cursor (T-STK-12), retained workspace/wake (T-MCH-14) and microVM launcher (T-INS-02). Scope specifies dark landing and provider-refusal/replay tests; unlanded contracts do not block Ready.
2. Out explicitly excludes a new review service/table/queue/scheduler, root setup, hosted Plue changes, App permissions, host repository execution, Views, in-app line comments, GitHub thread replies and non-TODO review changes.
3. C-GH-13 and the integration test enter through the production poll dispatcher and signed webhook route; C-J10-02 uses the installed machine run. Use committed literal actor, state, anchor and delivery fixtures, including failed/Retry and deletion before/after delivery. No test reads spec files or derives expected values from production code at runtime.
4. smithers-3f approves transaction/receipt reuse, provider activation, deduplication and membership resolution; smithers-38 approves unchanged RPC schema use; smithers-b8 approves public actor/activity contract compatibility; smithers-06 approves the existing actor presentation seam. smithers-8a accepts cross-owner seams and decides batching and failed/Retry/edit/deletion interpretations; Will decides product-policy changes. Checks: C-GH-13, C-J10-02, C-SEC-02.
5. Before start, smithers-3f: are activity, delivery keys and durable signals crash-safe; does membership checking prevent outsider steers? smithers-38: does the GitHub actor form parse without changing existing actor forms? smithers-06: can the actor chip show the GitHub mark and outsider login through the existing T-APP-09 contract? Rendering remains with its owner. smithers-3f: answered, BLOCKING edits applied (tech lead adopts). smithers-06: answered 18:3x, ok. Design condition: "ok. The github actor is the GitHub mark plus @login at color_index 7, through T-APP-09." smithers-38: answered, changes applied (tech lead adopts). smithers-b8 pre-review: Does activity preserve the public actor contract without a new API or command? Do disabled providers expose no success or authority? Recorded owner answers stand; owners review these minimal-code and dark-landing changes post hoc under Will's 2026-10-03 directive.
6. GitHub text is untrusted data; only current active members steer. smithers-3f reviews admission and review-triggered wake/resume. C-J10-02 and C-SEC-03 prove outsider refusal; C-SEC-02 exercises the production review-to-machine lifecycle, observes non-root guest execution without sudo, and refuses unavailable isolation without host fallback. This ticket adds no root step and passes no review text/anchor or branch-built artifact to root. Root input inventory for this change: none. Existing provisioning stays with machine/launcher owners; root consumes only main-pinned or bundle-shipped bytes, never branch-built code, scripts, binaries, toolchains or plists. No sudo plist load is added; INS-03's reviewed installed-bundle spike remains the only allowed load procedure (engineering README hard rules 1–2).

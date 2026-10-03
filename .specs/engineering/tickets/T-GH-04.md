# T-GH-04 Reviews and comments on TODO PRs become steers

Stage S1 · Size M · Depends on T-GH-02, T-STK-06, T-GH-05, T-ACC-04, T-MCH-14 · Unblocks T-REL-02 · Issue: [#3516](https://github.com/smithersai/smithers/issues/3516)
Spec: spec.md §2, §3 (`activity`), §3.0, §4.1 (`in_review → working`), §10.4.1, §10.7.3, §12.3 (review rows), §12.5.3, §14.6a, §17.1, §17.5 · Delta: delta.md §7 "Inbound reviews…" · Product: mvp.md J10.2, §6.3 "A review or review comment on a TODO's PR", §6.10 "Line comments", M-22

## Goal
A member's GitHub review, line comment or PR conversation comment on a TODO's PR reaches the TODO's run as a steer attributed to that person within 60 s, the TODO goes back to Working, and the agent's fix updates the PR.

## Scope
In (adopted owner pre-review):
- Use one transaction for activity, delivery key, TODO transition/events and durable steer signal intent. Supply a transaction-aware signal admission API; a separately committed dispatcher Admit call does not join the transaction. Dispatch only after commit and recover pending intents idempotently. Resolve the GitHub author to a current active member at steer admission and again before held delivery; removed, suspended and outsider authors have record-only activity and no effective steer. Check: C-J10-02.

In:
- Sources, all from T-GH-02 streams: reviews (the `pr-state` query's last 20 reviews per TODO PR), review comments (`GET /pulls/comments?since=…`) and conversation comments (`GET /issues/comments?since=…`) whose PR is a TODO PR.
- Mapping (§12.3):
  - A review with "changes requested", a review comment (a line comment or a commented review's body) or a conversation comment → one `activity` entry (kind `github`) with the GitHub mark, attributed to the member whose GitHub login wrote it.
  - From a member: one steer per review submission (its body plus its line comments batched, each anchored `path:line` with the commit it was made on) or per standalone comment, through T-STK-06's steer path; `in_review → working`, and approvals for the old head are void (§4.1).
  - From a non-member: the activity entry shows `{github: login}`, rendered "@login" with the GitHub mark (§14.6a), and is never delivered as a steer (§17.5).
  - "Approved" → recorded on the PR card (`todo:<n>` PR `reviews`). Never a Smithers approval (§10.6).
  - An edited comment updates its entry and is re-delivered only if the run hasn't consumed it; a deleted one hides its entry and withdraws its steer only while held, never after delivery (§12.3.0a). A member review while failed is held for Retry; it does not start an attempt.
- Each GitHub object id is delivered at most once, whether it arrives by poll, webhook hint, replay or after a restart.
- Comments and reviews made by the install's own App are ignored.
- `pull_request_review_comment` joins the accepted webhook events, so a delivery triggers its stream's fetch (§12.2.4).

Out: GitHub App permission changes; evaluating GitHub text or running repository code on the host; UI Views and actor rendering (T-APP-09); in-app line comments and agent replies inside GitHub review threads ([D] §12.5.3); the steer delivery inside the run (T-STK-06); stacked bases ([D]); the Branch card that lists activity (T-APP-10, S2); `/review` on non-TODO PRs (unchanged).

## Changes
- Use one transaction for activity, delivery key, TODO transition/events and durable steer signal intent. Supply a transaction-aware signal admission API; a separately committed dispatcher Admit call does not join the transaction. Dispatch only after commit and recover pending intents idempotently. Resolve the GitHub author to a current active member at steer admission and again before held delivery; removed, suspended and outsider authors have record-only activity and no effective steer. Check: C-J10-02.


- Consume `decideGitHubFact` from `github_inbound.go`; no private mapping. Unit fixtures cover fact/state/duplicate/reordered cells; DB integration proves this consumer calls the seam. Check: C-GH-13.

- `packages/backend/internal/services/github_inbound_reviews.go` (new) → the consumer registered with the T-GH-02 dispatch: filter to TODO PRs, read the objects from the `github_synced_*` store (§3.0), map per the table above, write the activity entry and a delivery key, and call the steer path with the GitHub actor.
- `packages/backend/internal/services/mythical_items.go:2827` (`ObserveGitHubEvent`) → no review or comment payload handling; webhook deliveries only request fetches (T-GH-02).
- `packages/backend/internal/services/github_webhook.go:85-95` (`supportedGitHubWebhookEvents`) → add `pull_request_review_comment`.
- `packages/backend/db/product/migrations/<next>_github_inbound_deliveries.sql` (new) → unique `(kind, github_id)` delivery record with the TODO, steer id, consumed flag and `delivered_at`.
- Actor: agree the `{github: login}` wire form with smithers-3f and smithers-38 before start; extend T-ACC-04's actor resolver and the matching wire schema without changing existing actor forms. T-APP-09 renders the mark.
- `packages/backend/docs/github-sync.md` → "Reviews and comments" section; docs gates as in T-GH-02.

## Tests
- Send reviews through production webhook hints/poll consumers with real PostgreSQL and the real durable signal receiver. Crash before transaction commit and after commit before dispatch; assert all-or-none rows and one recovered steer. Repeat held review delivery after author removal/suspension and include outsider authors: retain allowed activity attribution but no signal, TODO transition or authority from historical roster/login. Check: C-J10-02.

- Unit, `github_inbound_reviews_test.go` (new): the mapping over review state × author (member, non-member, own App) × location (line, review body, conversation) gives steer, record-only or ignore exactly as Scope states.
- Unit: a review with three line comments yields one steer carrying the three `path:line` anchors.
- Integration, `github_inbound_reviews_integration_test.go` (new): start T-GH-02 through the production install worker composition and advance its clock against real PostgreSQL and `githubfake`; send webhook hints through the production signed webhook route. The test-only process runtime runs only a packaged fixture, never repository flows or coding agents. Assert that a "changes requested" review moves the TODO `in_review → working`, appends one `todo_events` row and one `activity` row with the GitHub actor, and the run receives one durable steer signal.
- Integration: the same review seen by poll, by a webhook hint and again after a host restart produces one steer and one event.
- Integration: an edit before the run consumes the steer replaces it; an edit after updates only the entry; a deleted comment hides its entry.
- Integration: an "approved" review changes no TODO state and creates no `todo_approvals` row; a non-member's comment creates an entry and no steer.
- e2e: [C-J10-02](../checks/C-J10-02.md).

## Acceptance



- [C-GH-13](../checks/C-GH-13.md): pure fact matrix and production consumers use one decision seam.

- [C-J10-02](../checks/C-J10-02.md): a GitHub review comment becomes an attributed steer within 60 s, the TODO returns to Working, and the agent pushes a fix that updates the PR.

## Risks and notes
- Risk: a review arrives days after the PR opened, and the steer finds no live run or no workspace. The `todo` run waits durably after `stack.propose` (T-FLW-11, §10.4.1), and T-MCH-14 keeps the workspace and wakes it before delivering the signal (C-STK-05). Confirmed in the integration test when the steer signal has no run to deliver to.
- Risk: line anchors drift after a force-update. Confirmed when a comment's `line` is null and only `original_line` is set. Send `original_line` with the commit id.

## Ready checklist

1. T-GH-02 supplies polling, synced objects and roster checks; T-GH-05 supplies the fact decision; T-ACC-04 supplies actor attribution; T-STK-06 brings T-FLW-11's durable run and T-STK-12's input cursor; T-MCH-14 retains and wakes the workspace before delivery.
2. Out excludes App permission changes, host repository execution, Views, in-app line comments, GitHub thread replies and non-TODO review changes.
3. C-GH-13 and the integration test enter through the production poll dispatcher and signed webhook route; C-J10-02 uses the installed machine run. Use committed literal actor, state, anchor and delivery fixtures, including failed/Retry and deletion before/after delivery. No test reads spec files or derives expected values from production code at runtime.
4. smithers-3f approves delivery transactions, deduplication and actor resolution; smithers-38 approves the wire schema; smithers-8a decides any change to batching or the failed/Retry and deletion rules. Checks: C-GH-13, C-J10-02.
5. Before start, smithers-3f: are activity, delivery keys and durable signals crash-safe; does membership checking prevent outsider steers? smithers-38: does the GitHub actor form parse without changing existing actor forms? smithers-06: can the actor chip show the GitHub mark and outsider login through the existing T-APP-09 contract? Rendering remains with its owner. smithers-3f: answered, BLOCKING edits applied (tech lead adopts). smithers-06: answered 18:3x, ok. Design condition: "ok. The github actor is the GitHub mark plus @login at color_index 7, through T-APP-09."
6. GitHub text is untrusted data. Only current members steer; non-members and the install's own App never start work. Coding agents, repository flows and checks run only in machines (§1.3, M-29); no host fallback. smithers-3f reviews this boundary. C-J10-02 and C-SEC-03 prove outsider refusal; C-SEC-02 proves machine-only execution.

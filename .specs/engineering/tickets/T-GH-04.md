# T-GH-04 Reviews and comments on TODO PRs become steers

Stage S1 · Size M · Depends on T-GH-02, T-STK-06 · Unblocks — · Issue: to file
Spec: spec.md §2, §3 (`activity`), §3.0, §4.1 (`in_review → working`), §10.4.1, §10.7.3, §12.3 (review rows), §12.5.3, §14.6a, §17.1, §17.5 · Delta: delta.md §7 "Inbound reviews…" · Product: mvp.md J10.2, §6.3 "A review or review comment on a TODO's PR", §6.10 "Line comments", M-22

## Goal
A member's GitHub review, line comment or PR conversation comment on a TODO's PR reaches the TODO's run as a steer attributed to that person within 60 s, the TODO goes back to Working, and the agent's fix updates the PR.

## Scope
In:
- Sources, all from T-GH-02 streams: reviews (`GET /pulls/{n}/reviews` for TODO PRs whose `updated_at` changed), review comments (`GET /pulls/comments?since=…`) and conversation comments (`GET /issues/comments?since=…`) whose PR is a TODO PR.
- Mapping (§12.3):
  - A review with "changes requested", a review comment (a line comment or a commented review's body) or a conversation comment → one `activity` entry (kind `github`) with the GitHub mark, attributed to the member whose GitHub login wrote it.
  - From a member: one steer per review submission (its body plus its line comments batched, each anchored `path:line` with the commit it was made on) or per standalone comment, through T-STK-06's steer path; `in_review → working`, and approvals for the old head are void (§4.1).
  - From a non-member: the activity entry shows `{github: login}`, rendered "@login" with the GitHub mark (§14.6a), and is never delivered as a steer (§17.5).
  - "Approved" → recorded on the PR card (`todo:<n>` PR `reviews`). Never a Smithers approval (§10.6).
  - An edited comment updates its entry and is re-delivered only if the run hasn't consumed it; a deleted one hides its entry.
- Each GitHub object id is delivered at most once, whether it arrives by poll, webhook hint, replay or after a restart.
- Comments and reviews made by the install's own App are ignored.
- `pull_request_review_comment` joins the accepted webhook events, so a delivery triggers its stream's fetch (§12.2.4).

Out: in-app line comments and agent replies inside GitHub review threads ([D] §12.5.3); the steer delivery inside the run (T-STK-06); stacked bases ([D]); the Branch card that lists activity (T-APP-10, S2); `/review` on non-TODO PRs (unchanged).

## Changes
- `packages/backend/internal/services/github_inbound_reviews.go` (new) → the consumer registered with the T-GH-02 dispatch: filter to TODO PRs, read the objects from the `github_synced_*` store (§3.0), map per the table above, write the activity entry and a delivery key, and call the steer path with the GitHub actor.
- `packages/backend/internal/services/mythical_items.go:2827` (`ObserveGitHubEvent`) → no review or comment payload handling; webhook deliveries only request fetches (T-GH-02).
- `packages/backend/internal/services/github_webhook.go:85-95` (`supportedGitHubWebhookEvents`) → add `pull_request_review_comment`.
- `packages/backend/db/product/migrations/<next>_github_inbound_deliveries.sql` (new) → unique `(kind, github_id)` delivery record with the TODO, steer id, consumed flag and `delivered_at`.
- Actor: the §2 actor JSON gains the `{github: login}` form for authors who aren't members. The wire schema is the one T-ACC-04 adds for `via`; T-APP-09 renders the mark.
- `packages/backend/docs/github-sync.md` → "Reviews and comments" section; docs gates as in T-GH-02.

## Tests
- Unit, `github_inbound_reviews_test.go` (new): the mapping over review state × author (member, non-member, own App) × location (line, review body, conversation) gives steer, record-only or ignore exactly as Scope states.
- Unit: a review with three line comments yields one steer carrying the three `path:line` anchors.
- Integration, real PostgreSQL + `githubfake` + the `todo` flow on the test-only process runtime (`github_inbound_reviews_integration_test.go`, new): a "changes requested" review moves the TODO `in_review → working`, appends one `todo_events` row and one `activity` row with the GitHub actor, and the run receives one durable steer signal.
- Integration: the same review seen by poll, by a webhook hint and again after a host restart produces one steer and one event.
- Integration: an edit before the run consumes the steer replaces it; an edit after updates only the entry; a deleted comment hides its entry.
- Integration: an "approved" review changes no TODO state and creates no `todo_approvals` row; a non-member's comment creates an entry and no steer.
- e2e: [C-J10-02](../checks/C-J10-02.md).

## Acceptance
- [C-J10-02](../checks/C-J10-02.md): a GitHub review comment becomes an attributed steer within 60 s, the TODO returns to Working, and the agent pushes a fix that updates the PR.

## Risks and notes
- Risk: a review arrives days after the PR opened, and the steer finds no live run or no workspace. The `todo` run waits durably after `stack.propose` (T-FLW-11, §10.4.1), and T-MCH-14 keeps the workspace and wakes it before delivering the signal (C-STK-05). Confirmed in the integration test when the steer signal has no run to deliver to.
- Risk: line anchors drift after a force-update. Confirmed when a comment's `line` is null and only `original_line` is set. Send `original_line` with the commit id.

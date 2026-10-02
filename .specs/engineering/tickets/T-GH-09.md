# T-GH-09 Outbound write keys and reconcile lookups

Stage S1 · Size M · Depends on T-GH-03 · Unblocks T-FLW-09 · Issue: to file
Spec: spec.md §3 (`outbound_writes`), §12.4, §12.5.2, §19.1, §19.2 · Delta: delta.md §7 · Product: mvp.md §6.1 "Restart", §9 "Durability", §12 item 1 (restart mid-run, recovery receipts)

## Goal
Killing the host at any point during a GitHub write leaves exactly one PR, comment, label, merge, close or pushed head on GitHub after restart, because every write is keyed before the call and looked up by key before any repeat.

## Scope
In:
- The write kinds of §12.4.1: open PR (title = TODO title), update the PR body, merge, close a PR on Drop, close an issue on merge, add a label (with its "Committed as Tn" comment), revert a non-member's label, comment, and push. Each gets a deterministic key recorded in `outbound_writes` with state `intended`, in its own committed transaction before the call.
- Keys: `pr:<todo>`; `body:<todo>:<body digest>`; `merge:<todo>:<reviewed head sha>`; `close-pr:<todo>`; `close-issue:<issue>:<todo>`; `label:<issue>:<label>`; `unlabel:<issue>:<label event id>`; `comment:<subject>:<purpose>:<revision>`; `push:<branch>:<intended head>`.
- States (§3): `intended` before the call, `done` with `github_ref` once settled, `unknown` for a row found `intended` after a restart. Reconcile looks up every `unknown` row before any repeat (§12.4.1, §19.2):
  - PR: find by head branch (`FindPull`).
  - Body: re-read it and compare the digest.
  - Merge: `GET /pulls/{n}`. Merged with any sha settles it; a merge is never repeated after one succeeded.
  - Close PR, close issue: read the state.
  - Comment: the marker `<!-- smithers:<key> -->`, searched with `since` = the key's record time minus 1 min.
  - Label, revert: read the issue's labels.
  - Push: `git ls-remote`. The intended head settles it, the expected old head means push again, and anything else raises `foreign_push` (T-GH-06).
- A row not found by its lookup repeats once under the same key.
- Attribution in the written text (§12.4.2): "Requested by @owner"; actions taken for a person read "by @ben via Smithers".
- One outbound module used by every GitHub writer in the host. The proposal `PendingOp` mechanism folds into it.

Out: reconcile of run steps (push, GitHub write and shell) inside the flow runtime (T-FLW-09, S2); non-GitHub side effects; webhook delivery dedupe (T-GH-02); the PR body's content (T-GH-03).

## Changes
- `packages/backend/db/product/migrations/<next>_outbound_writes.sql` (new) → `outbound_writes(key PK, kind, target jsonb, state[intended|done|unknown], github_ref NULL, created_at, done_at NULL)` (§3). Queries in `packages/backend/db/product/queries/outbound_writes.sql` (new); regenerate sqlc.
- `packages/backend/internal/services/github_outbound.go` (new) → `Write(ctx, key, kind, call, lookup)`: record, call, settle; `Reconcile(ctx)` at boot and on each worker claim, before new writes. Each reconciled row writes one recovery receipt (key, lookup result, action taken).
- `packages/backend/internal/services/mythical_github.go` → route `CreatePull` (`:282`), `UpdatePullBody` (T-GH-03), `Merge` (`:314`), `ClosePull` (T-STK-05), `Comment` (`:484`), `AddLabel` (`:547`), `RemoveLabel` (`:334`) and `CloseIssue` (`:521`) through `github_outbound.go`. Keep `mythicalCommentMarker` (`:440`); `findComment` (`:452`) searches with `since` instead of the 10-page cap (`mythicalCommentPages`, `:446`).
- `packages/backend/internal/services/mythical_items.go:1978-2001` and `:2040-2063` (`PendingOp` record and recovery in `propose`) and `:2066-2079` (`pushProposal`) → use the push kind; delete the `pending_op` column use and its recovery branch.
- `packages/backend/internal/githubfake/` → a write log (JSON lines: method, path, key marker, effect, object id) and hooks that hold a response or stop before or after applying a write, used by the fault tests.
- `packages/backend/docs/github-sync.md` → "Writes and recovery" section; docs gates as in T-GH-02.

## Tests
- Unit, `github_outbound_test.go` (new): keys are stable across restarts for the same subject and revision, and differ when the body digest or reviewed sha differs.
- Fault, in process (`github_outbound_fault_test.go`, new): [C-GH-09](../checks/C-GH-09.md), each kind × each kill point.
- Fault, process kill: [C-DUR-03](../checks/C-DUR-03.md).
- Integration: a comment thread with 1,200 earlier comments still finds its marker, so no duplicate is posted.
- Integration: a merge that GitHub applied but whose response was lost settles from `GET /pulls/{n}` without a second `PUT /merge`.

## Acceptance
- [C-GH-09](../checks/C-GH-09.md): no duplicate at any kill point inside the write path.
- [C-DUR-03](../checks/C-DUR-03.md): SIGKILL of the host during each write kind and during a push reconciles without duplication (the S1 part).

## Risks and notes
- Risk: a person who quotes the marker in a later comment could make a lookup settle on the wrong comment. Confirmed by a fault-test case where a member's comment carries the marker. The lookup keeps today's App-author check (`findComment`, `:452`).
- Risk: a body write that crosses a newer body write under a different key could leave the older body. Confirmed by two body revisions racing in the fault test. Only the newest digest's write may run; an older `intended` body write settles `done` without a call.

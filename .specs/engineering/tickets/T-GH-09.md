# T-GH-09 Outbound writes: keys, per-target order, supersession and reconcile

Stage S1 · Size M · Depends on T-GH-02 · Unblocks T-MNT-01, T-MNT-03, T-STK-04, T-GH-03, T-FLW-11, T-FLW-09 · Issue: to file
Spec: spec.md §3 (`outbound_writes`), §12.4.1–§12.4.1b, §12.5.2, §19.1, §19.2 · Delta: delta.md §7 · Product: mvp.md §6.1 "Restart", §9 "Durability", §12 item 1 (restart mid-run, recovery receipts)

## Goal
Killing the host at any point during a GitHub write leaves exactly one PR, comment, label, merge, close or pushed head on GitHub after restart, because every write is keyed before the call and looked up by key before any repeat. Writes to one target keep their order, a newer decision supersedes an unsent older one, and reconcile never replays a write that a newer action on GitHub has overtaken.

## Scope
In:
- The write kinds of §12.4.1: open PR (title = TODO title), update the PR body, mark ready or draft, push, merge, close a PR on Drop, close an issue on merge, add a label (with its "Committed as Tn" comment), revert a label, and comment. Each is recorded in `outbound_writes` with state `intended`, in its own committed transaction before the call, with `target`, `field`, `desired`, `precondition` and `seq` (§12.4.1).
- Keys `<kind>:<target>:<revision>`: `pr:<branch>`; `body:<pr>:<body digest>`; `ready:<pr>:<event seq>` and `draft:<pr>:<event seq>`; `push:<branch>:<intended head>`; `merge:<pr>:<reviewed head sha>`; `close-pr:<pr>:<event seq>`; `close-issue:<issue>:<event seq>`; `label:<issue>:<label>:<event seq>`; `unlabel:<issue>:<label event id>`; `comment:<subject>:<purpose>:<revision>`. The event seq is the `todo_events` sequence, attention id or confirmation id of the action that asked for the write, so a TODO that is reopened and dropped again gets a new close key.
- Order (§12.4.1a): writes to one target are sent one at a time in `seq` order. A write starts only when every earlier write to its target is `done`, `superseded` or `conflict`. A response that doesn't arrive makes the row `unknown` at once.
- Supersession (§12.4.1a): recording a write marks every earlier unsent row for the same target and field `superseded`, and that row is never sent. Comments and merges are never superseded.
- Reconcile (§12.4.1b), at boot and before the next write to a target, per kind: open PR by head branch (`FindPull`); comment by the marker `<!-- smithers:<key> -->`, searched with `since` = the key's record time minus 1 min; body by digest; close, ready, draft and labels by the App's own events on the target since the row's `created_at`, then the current value against `desired` and `precondition`; merge by `GET /pulls/{n}`, never repeated after one succeeded; push by `git ls-remote`. A value that matches neither `desired` nor `precondition` settles `conflict` and hands the change to the §12.3 mapping (for a push, `foreign_push`, T-GH-06); nothing is written over it. A row whose lookup finds nothing repeats once under the same key.
- States (§3): `intended`, `unknown`, `done`, `superseded` and `conflict`, with `settled_by` (`response`, `event`, `state` or `lookup`) and one recovery receipt per reconciled row.
- Attribution in the written text (§12.4.2): "Requested by @owner"; actions taken for a person read "by @ben via Smithers".
- One outbound module used by every GitHub writer in the host. The proposal `PendingOp` mechanism folds into it.

Out: reconcile of run steps (push, GitHub write and shell) inside the flow runtime (T-FLW-09, S2); non-GitHub side effects; webhook delivery dedupe (T-GH-02); the PR body's content (T-GH-03).

## Changes
- `packages/backend/db/product/migrations/<next>_outbound_writes.sql` (new) → `outbound_writes(key PK, seq bigserial, kind, target jsonb, field NULL, desired jsonb, precondition jsonb NULL, state[intended|unknown|done|superseded|conflict], settled_by NULL, github_ref NULL, created_at, done_at NULL)` (§3), indexed on `(target, seq)`. Queries in `packages/backend/db/product/queries/outbound_writes.sql` (new); regenerate sqlc.
- `packages/backend/internal/services/github_outbound.go` (new) → `Write(ctx, row, call)`: record the row and supersede older unsent rows for its field, wait until the target's earlier rows settle, call, settle. `Reconcile(ctx, target)` runs at boot and before the next write to a target. Each reconciled row writes one recovery receipt (key, lookup result, action taken).
- `packages/backend/internal/services/mythical_github.go` → route `CreatePull` (`:282`), `UpdatePullBody` (T-GH-03), `Merge` (`:314`), `ClosePull` (T-STK-05), `Comment` (`:484`), `AddLabel` (`:547`), `RemoveLabel` (`:334`) and `CloseIssue` (`:521`) through `github_outbound.go`. Keep `mythicalCommentMarker` (`:440`); `findComment` (`:452`) searches with `since` instead of the 10-page cap (`mythicalCommentPages`, `:446`).
- `packages/backend/internal/services/mythical_items.go:1978-2001` and `:2040-2063` (`PendingOp` record and recovery in `propose`) and `:2066-2079` (`pushProposal`) → use the push kind; delete the `pending_op` column use and its recovery branch.
- `packages/backend/internal/githubfake/` → a write log (JSON lines: method, path, key marker, effect, object id) and hooks that hold a response or stop before or after applying a write, used by the fault tests, plus issue events and PR timeline events with their actor, so reconcile can find the App's own events.
- `packages/backend/docs/github-sync.md` → "Writes and recovery" section; docs gates as in T-GH-02.

## Tests
- Unit, `github_outbound_test.go` (new): keys are stable across restarts for the same subject and revision, and differ when the body digest or reviewed sha differs.
- Fault, in process (`github_outbound_fault_test.go`, new): [C-GH-09](../checks/C-GH-09.md), each kind × each kill point.
- Fault, in process, same file: [C-GH-09](../checks/C-GH-09.md) ordering cases. A close the fake applied before the kill, followed by a person's reopen, settles `done` from the App's event and is never sent again. An unsent `ready` is superseded by a later `draft`. A held body v1 settles before body v2 is sent. A push leased against `A2` after `A3` arrived settles `conflict` and raises `foreign_push`.
- Fault, process kill: [C-DUR-03](../checks/C-DUR-03.md).
- Integration: a comment thread with 1,200 earlier comments still finds its marker, so no duplicate is posted.
- Integration: a merge that GitHub applied but whose response was lost settles from `GET /pulls/{n}` without a second `PUT /merge`.

## Acceptance
- [C-GH-09](../checks/C-GH-09.md): no duplicate at any kill point inside the write path.
- [C-DUR-03](../checks/C-DUR-03.md): SIGKILL of the host during each write kind and during a push reconciles without duplication (the S1 part).

## Risks and notes
- Risk: a person who quotes the marker in a later comment could make a lookup settle on the wrong comment. Confirmed by a fault-test case where a member's comment carries the marker. The lookup keeps today's App-author check (`findComment`, `:452`).
- Resolved by supersession (§12.4.1a): an older unsent body write is `superseded`, and an older sent one is reconciled before the newer one is sent.

# C-STK-04 An out-of-order merge on GitHub opens order attention

Proves: mvp.md §6.3 (merge out of stack order) · spec.md §10.6.4, §4.1.2a · Layer: integration · Stage: S1 · Tickets: T-GH-05
Automation: `packages/backend/internal/services/stack_order_attention_test.go` (new) · Runs in: CI with a fake GitHub server

## Setup
- Real PostgreSQL, real git and jj, and the fake GitHub server with its write log.
- Stack T2, T3, T4, all in review, with maintainer Ben and member Alice. T2's PR is ready for review; T3's and T4's PRs are drafts (§12.5.1). T3's head is the verified candidate `main` + T2 + T3. Persist its accepted-generation head and immutable prefix manifest proving T2’s accepted change is present; the reported merge commit is on `main`.

## Steps
1. On the fake GitHub, mark T3's PR ready and squash-merge it.
2. Poll once. Read T2, T3 and T4, their `todo_events` and activity, `main` in the mirror, and the Home card for Ben and for Alice.
3. Ben merges T4 through `POST /api/todos/4/merge`.
4. Alice presses **OK** on the attention.
5. Ben presses **OK**.
- Drive the production OK route with delegated owner/maintainer credentials and a stale revision. Drive definitive GitHub 405/409/422 refusals through the production merge route.

## Pass when

- T-GH-05 containment crash fixtures run through production polling: receipt, proven-item transitions, order attention, projections and keyed close/comment intents commit together. Before-commit crash leaves none; after-commit restart retains one set. Remote-success-before-ack recovery creates no duplicate effective close/comment and leaves every unproven item unchanged.

- S11 exception already in §12.3.0a item 3: a dropped change proven contained in a later merged PR becomes merged with `merged_via`. Terminal-absorption fixtures must preserve this exception.


- S18: Add later-undrafted-not-merged fixture → synced draft=false, order/Tfirst, zero convert-to-draft writes and zero PUTs. Keep C-STK-04 external undraft/merge path and placement-triggered draft fixtures.


- S16: Add F2/F3 true/false issue fixtures → one durable close/comment per fixing item; false stays open unless a person independently closed it. Unproven S15 items get none. C-J10-05 no-approval/no-PUT invariant remains; already-existing genuine approvals are not erased merely to meet a fixture expecting none.


- S15: F11/new partial-proof rows: foreign merged head that excludes T2 → T3 merged, T2 unchanged, zero T2 PR/issue closes, one order attention with unverified sentence, zero merge PUTs. Add missing manifest, superseded retained candidate and missing-head-read fixtures. F2 proof must be explicit fixture input; head equality alone without inclusion evidence is insufficient.


- S14: F10/C-05: fold-before-claim → zero PUT; claim-before-fold → at most one initial PUT, one merged event, no duplicate cancellation/issue close/steer delivery. Add retained unknown outbound row despite cleared TODO fence. The fold changes only items proved contained under S15.


- S13: F9/TestQAFoldWhileAttentionOpen → one row, two entries, original preserved. Add duplicate, append-vs-OK and current-revision OK fixtures. Amend P2 “one attention per event” to one entry per event and at most one open row.


- S12: F3 → one attention text `T4 merged before T2; T2's change is in T4's commit` followed by newline and the T3 sentence; two notes and two close comments. F2/C-STK-04 stays byte-for-byte unchanged.

- After step 2:
  - T3 and T2 are both `merged`. T2 carries the note "T3 merged before T2; T2's change is in T3's commit" in its `todo_events` row and its activity (§10.6.4).
  - `main` is folded: the mirror's `main` equals GitHub's, and the stack holds only T4.
  - One `stack_attention{kind: order}` row is open with that sentence; Ben's Home card shows it, and Alice's doesn't.
  - T4 is rebased onto the new `main`, its PR is force-updated, and it is marked ready once it is first.
- Step 3 is refused with class `conflict` naming the open attention, and the fake server records no merge call.
- Step 4 is refused with class `permission`; the row stays open.
- After step 5 the row is settled by Ben, and T4's Merge is enabled.
- Delegated OK returns 403 never/never; lower-role OK returns 403 permission/permission; stale OK returns 409 conflict/stale_attention. Refused OK requests have no effects. Definitive GitHub 405/409/422 responses return github/github_refused envelopes through the production merge route.

## Fail when
- T3's merge is treated as normal while T2 is still first, or T2 stays unmerged with its change already in `main`.
- T2 is marked merged without the note.
- A member can settle the attention, or a merge goes through while it is open.

## Evidence
`.artifacts/checks/C-STK-04/<ts>/`: the fake GitHub write log, `todo_events` for T2 to T4, the `stack_attention` rows, the mirror's `main` before and after, and the commit.

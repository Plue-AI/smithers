# C-STK-04 An out-of-order merge on GitHub opens order attention

Proves: mvp.md §6.3 (merge out of stack order) · spec.md §10.6.4, §4.1.2a · Layer: integration · Stage: S1 · Tickets: T-GH-05
Automation: `packages/backend/internal/services/stack_order_attention_test.go` (new) · Runs in: CI with a fake GitHub server

## Setup
- Real PostgreSQL, real git and jj, and the fake GitHub server with its write log.
- Stack T2, T3, T4, all in review, with maintainer Ben and member Alice. T2's PR is ready for review; T3's and T4's PRs are drafts (§12.5.1). T3's head is the verified candidate `main` + T2 + T3.

## Steps
1. On the fake GitHub, mark T3's PR ready and squash-merge it.
2. Poll once. Read T2, T3 and T4, their `todo_events` and activity, `main` in the mirror, and the Home card for Ben and for Alice.
3. Ben merges T4 through `POST /api/todos/4/merge`.
4. Alice presses **OK** on the attention.
5. Ben presses **OK**.

## Pass when
- After step 2:
  - T3 and T2 are both `merged`. T2 carries the note "T3 merged before T2; T2's change is in T3's commit" in its `todo_events` row and its activity (§10.6.4).
  - `main` is folded: the mirror's `main` equals GitHub's, and the stack holds only T4.
  - One `stack_attention{kind: order}` row is open with that sentence; Ben's Home card shows it, and Alice's doesn't.
  - T4 is rebased onto the new `main`, its PR is force-updated, and it is marked ready once it is first.
- Step 3 is refused with class `conflict` naming the open attention, and the fake server records no merge call.
- Step 4 is refused with class `permission`; the row stays open.
- After step 5 the row is settled by Ben, and T4's Merge is enabled.

## Fail when
- T3's merge is treated as normal while T2 is still first, or T2 stays unmerged with its change already in `main`.
- T2 is marked merged without the note.
- A member can settle the attention, or a merge goes through while it is open.

## Evidence
`.artifacts/checks/C-STK-04/<ts>/`: the fake GitHub write log, `todo_events` for T2 to T4, the `stack_attention` rows, the mirror's `main` before and after, and the commit.

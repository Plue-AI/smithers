# C-APP-02 Edit a Queued TODO's prompt from the TODO card

Proves: mvp.md §6.6 TODO card ("The prompt is editable while Queued"), Appendix A `/todo.amend` · spec.md §10.2.2, §15.1.5, §6.2.1 · Layer: e2e · Stage: S1 · Tickets: T-APP-02, T-STK-02
Automation: `apps/app/e2e/real/todo-edit-queued.spec.ts` (new) · Runs in: reference host

## Setup
- Install with capacity and `parallel` lowered to 1 in Settings. T1 is Working, so Ben's T2 is Queued.
- The test `flows/todo/flow.ts` of C-J4-01 is Active; its plan step records the prompt it receives.
- Ben and Alice signed in.

## Steps
1. Ben opens `/todo T2`, presses **Edit**, changes the prompt to `PROMPT-B` and one acceptance line, and presses Save twice within 100 ms.
2. Alice opens `/todo T2`.
3. Ben prompts the app agent "change T2's prompt to PROMPT-C" and doesn't press the card it posts.
4. T1 moves to In review and releases its machine, so T2 admits.
5. With T2 Working, Ben opens `/todo T2`.

## Pass when
- Step 1: exactly one new revision (2), authored by Ben, and no new TODO; the card shows `PROMPT-B` and "+1"; both presses carry one `Idempotency-Key`.
- Step 2: Alice sees revision 2 and its author.
- Step 3: the app agent posts a one-click Confirm card for Ben (`todo.amend` is `confirm`), and T2's revisions don't change.
- Step 4: T2's plan step receives `PROMPT-B`, never revision 1's prompt.
- Step 5: T2's card has no Edit; `/todo.amend` and Steer remain.

## Fail when
- Edit creates a TODO, or the run starts on an older revision.
- Edit shows on a TODO that isn't Queued.
- The agent's amend runs before Ben confirms it.

## Evidence
`.artifacts/checks/C-APP-02/<UTC timestamp>/`: the videos, T2's `todo_revisions` rows, the plan step's recorded input, the confirmation rows, the commit and install version.

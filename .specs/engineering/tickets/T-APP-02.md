# T-APP-02 TODO card and Draft card

Stage S1 · Size L · Depends on T-STK-01, T-APP-08 · Unblocks T-CUT-01 · Issue: [#3466](https://github.com/smithersai/smithers/issues/3466)
Spec: spec.md §14.2, §14.3 (TODO), §14.5.1, §4.1, §6.1.4, §6.2.1–6.2.2, §10.2, §10.4, §10.5.4, §10.6, §10.7, §10.8, §12.3, §12.5.1, §15.1.5, §19.3 · Delta: delta.md §9 (Add cards [S1] TODO, Draft), §6 · Product: mvp.md J2, J4, J9, §4.1, §4.2, §6.6 TODO card, Appendix A "TODOs and the stack"

## Goal
A member opens `/todo Tn` and sees the TODO's prompt, place, flow progress, its one pending question, failure or evidence, and acts on it (answer, steer, stop, resume, retry, drop, amend) from the card; `/todo.new` and "make that a TODO" open a Draft card that commits a placed TODO exactly once.

## Scope
In:
- `todo` card on the `todo:<n>` topic, embedded and maximized from one component:
  - header: title, state word (Queued with its queue position, Starting while the machine wakes and the coding agent launches, Working with its current step, §4.1), owner avatar;
  - meta: place ("next to merge", "3rd in stack"), "from #i" or "closed #i" for a linked issue, owner;
  - prompt and acceptance while Queued or Dropped, step strip otherwise, "+n" amendments disclosure with author and text;
  - Needs you by kind (§10.8.1): a question or approval inline with an Answer field (`/todo.answer Tn`); after the first answer, "Ben answered …"; a late submitter's `409 {answered_by}` keeps their text with **Send as steer** (`/todo.steer Tn`) (§10.8.2). `foreign_push` shows the commit link with **Keep Smithers' version** and **Drop TODO** (§12.3). A conflict shows the S1 conflict view: conflicted files, the terminal and SSH line, and **Done** (§10.5.4); from S2 Resolve opens the Branch card;
  - failure: "<step> failed", message, optional steer and Retry (`/todo.retry Tn`);
  - evidence of the current attempt (§10.4.3): PR link ("#pr on GitHub ↗"), diff stat, machine checks with duration, GitHub passed/total, review summary, the earlier items the PR includes ("Includes T3, T4 until they merge", §12.5.1), "approval cleared by rebase";
  - Merge control: Merge (`/merge Tn` with the head sha shown) only for the first item and a viewer who may merge; otherwise "Merges after Tn", "Checks running", the failing check's name, or GitHub's refusal text verbatim (§10.6.2);
  - actions while live or paused: Open branch (`/branch Tn`), Inspect (`/run.inspect <id>`), Stop or Resume, Drop (confirm). Stop parks the run in a durable pause wait; Resume continues the same run from its last finished step; Retry starts a new attempt from step 1 and keeps the earlier attempt and its evidence (§4.1, §10.4.1).
- `draft` card: Title, Prompt, Place (Append, Before Tn, Amend Tn over unmerged items), "Closes #i when merged" when drafted from an issue, Discard (`card.dismiss`) and Commit. The draft lives in the card payload through `form.set` (AGENTS.md form law). Until Commit the entry is private to its author (`audience_member_id`, §14.5.1); after Commit it is shared and shows "Committed <title>" linking the TODO. Commit sends one `Idempotency-Key`, so a double press makes one TODO (§6.2.1).
- Commands for the Appendix A TODO group: `/todo.new`, `/todo Tn`, `/todo.answer`, `/todo.steer`, `/todo.amend`, `/todo.stop`, `/todo.resume`, `/todo.retry`, `/todo.drop`. Each has three doors and a typed payload; a missing input renders a form card (§6.1.4). Those marked A✓ in mvp.md Appendix B (commit, amend, steer, stop, retry, drop) never run directly from the app agent: it posts a one-click Confirm card that the prompt's author presses (§15.1.5, T-APP-04).
- J9 answer doors: an answer offers **Make TODO** (drafted from the conversation into a Draft card) and **Save to wiki** (`/wiki.save`, a thin command over the shared `wiki.create` operation, `packages/smithers/ui/src/app-operations/wiki.ts:53`).

Out:
- `/todo.from-issue` drafting and the `todo` label (T-STK-09); state transitions, placement, steer delivery and conflict waits (T-STK-01/02/05/06/07/08); merge execution (T-STK-04); Confirm card (T-APP-04); moved-off controls on the Branch card (T-COL-05, S2).
- Line comments ([D] §12.5.3); browser notifications ([D] §14.6); the lessons receipt (T-FLW-06, S3).

## Changes
- `apps/app/src/mainview/cards/TodoCard.tsx`, `DraftCard.tsx` (new) with tests; spread both families into `cards/CardRenderers.tsx`.
- `packages/rpc/src/Cards.ts`: kinds `todo {n}` and `draft {title, prompt, place, issue?, fixes, committed?}`.
- `packages/rpc/src/Todo.ts` (new): the TODO card model, with a golden fixture shared with T-STK-01's projection test.
- `apps/app/src/mainview/state/seams/TodoSeam.ts` (new): command handlers over `/api/todos` (§6.3) with `Idempotency-Key`; responses settle toasts only through `todo:<n>` events (§6.2.2).
- `apps/app/src/mainview/flows/entries/history.ts`: replace `history.view` (`:38`), `history.todo` (`:87`) and `history.retry` (`:102`) with the `/todo*` entries; delete them, not alias them. Delete `fileTodo` from `state/seams/StackSeam.ts` (`:77`) and its `POST /mythical/todos` client path.
- `apps/app/src/mainview/flows/entries/wiki.ts`: add `/wiki.save`.
- `apps/app/e2e/playwright/stack-todo.spec.ts`: rewrite for the TODO and Draft cards.

## Tests
- Unit (`TodoCard.test.tsx`): the Merge control for each combination of first-in-order, role, check state, `merge_block` and `approval_cleared`; exactly one control renders.
- Unit: question flow: unanswered, answered by another member, and the late submitter's 409 keeping the draft with Send as steer.
- Unit: `foreign_push` renders its two answers; a conflict renders the S1 conflict view with Done.
- Unit (`DraftCard.test.tsx`): place options list only unmerged items; "Closes #i" appears only with an issue; Commit is disabled while a commit is in flight; an uncommitted draft entry carries `audience_member_id`.
- Integration (`TodoSeam.test.ts`, real backend with PostgreSQL): two Commit presses with one key create one TODO; a 409 answer returns `answered_by`; Retry after a failure creates attempt 2 and keeps attempt 1's evidence.
- Unit (`flows/agent-parity.test.ts`, existing): every new `/todo*` entry has three doors; `/todo.drop` confirms.
- e2e: the C-J2-01, C-J4-02 and C-J9-01 scripts.

## Acceptance
- [C-J2-01](../checks/C-J2-01.md): the Draft card drafted from an issue is edited, placed and committed once.
- [C-J4-02](../checks/C-J4-02.md): answer, merge next and retry with a steer from the TODO card while chatting.
- [C-J9-01](../checks/C-J9-01.md): an answer's Make TODO and Save to wiki work.

## Risks and notes
- Spec gap: §14.3 TODO does not list `failure`, the issue link with `fixes_issue`, or the branch, though `todos` stores them (§3). The tech lead adds them to the model; the card reads them from it.
- Spec gap: `POST /api/todos` (§6.3) takes no `acceptance`, though `todo_revisions.acceptance` exists and §10.4.2 sends it to the agent. The Draft card has no Acceptance field until the tech lead adds it to the create payload.
- PRs are based on `main` (§12.5.1, E-15), so the evidence row says "into main" and lists the included items; the mock's "stacked on #n" (`Todo.tsx:80`) is wrong.
- Evidence is per attempt (§14.3): the card shows the current attempt; earlier attempts stay in the model and open through Inspect.
- Risk: the mock shows no editable Queued prompt (mvp.md §6.6) and no Make TODO or Save to wiki on answers (J9.3). Design places them before the e2e can pass.
- `/wiki.save` is owned here because C-J9-01 names this ticket.

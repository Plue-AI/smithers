# T-APP-02 TODO card and Draft card

Stage S1 · Size M · Depends on T-STK-01, T-STK-02, T-STK-05, T-STK-06, T-STK-08, T-STK-09, T-ACC-02, T-APP-16, T-APP-04, T-APP-09, T-UI-03, T-UI-04, T-GH-06, T-FLW-07, T-MCH-10, T-APP-15 · Unblocks T-APP-01, T-APP-03, T-APP-05, T-REL-02 · Issue: [#3466](https://github.com/smithersai/smithers/issues/3466)
Spec: spec.md §14.2, §14.3 (TODO, Draft), §5.6, §8.6.1, §14.5.1, §4.1, §6.1.4, §6.2.1–6.2.2, §10.2, §10.4, §10.5.4, §10.6, §10.7, §10.8, §12.3, §12.5.1, §15.1.5, §19.3 · Product: mvp.md J2, J4, J9, §4.1, §4.2, §6.6 TODO card, Appendix A "TODOs and the stack"

## Goal
A member opens `/todo Tn` and sees the TODO's prompt, place, flow progress, every open wait, failure or evidence, and acts on it from the card; `/todo.new` and "make that a TODO" open a Draft card that commits a placed TODO exactly once.

## Scope
In:
- `todo` card: title, state word (Queued with its position, Starting, Working with its step, §4.1), owner; place and linked issue; prompt and acceptance while Queued or Dropped, step strip otherwise, "+n" amendments.
- Needs you by kind (§10.8.1): Answer inline (`/todo.answer Tn`); after the first answer "Ben answered …"; a late submitter's `409 {answered_by}` keeps their text with **Send as steer**. `foreign_push` shows **Bring in** and **Discard** (§12.3). A conflict shows conflicted files, the terminal and SSH line, and **Done** (§10.5.4).
- Failure: "<step> failed", message, Retry (`/todo.retry Tn`). Evidence of the current attempt (§10.4.3): PR link, diff stat, checks, review summary, included items, "approval cleared by rebase". The PR/diff/merge section stays unavailable until T-GH-03 supplies PR data; its handlers refuse `503 infra/pr_projection_unavailable` before any effect, with no fake PR URL, diff or head.
- Merge (`/merge Tn` with the head sha) only for the first item and a viewer who may merge, from `merge_block` (§10.6.2a); otherwise its reason.
- Open branch, Inspect, Stop, Resume, Drop (confirm). Stop parks the run in a durable wait; Resume continues it; Retry starts a new attempt and keeps the earlier one's evidence.
- **Edit** while Queued (mvp.md §6.6): Save runs `/todo.amend Tn {prompt, acceptance}` with one `Idempotency-Key`, appends revision n+1 and creates no TODO.
- **Take over** (`todo.takeover`, `agent: never`) on a removed or suspended owner's TODO (§5.6), for maintainers and the owner: `POST /api/todos/{n} {takeover}`.
- **Add to machine image** (`image.add`) on a failure naming a missing package (`failure.missing_tool`): reads `main:.smithers/machine.json` (absent means `{"packages": []}`), validates the §8.6.1 rules, keeps package order and opens a private Draft whose read-only seed touches only that file. This ticket owns the shared command; T-APP-03 binds Settings to it.
- `draft` card (§14.3 Draft): Title, Prompt, Acceptance, Place (Append, Before Tn, Amend Tn), "Closes #i" from an issue, read-only seed, Discard and Commit. Private to its author until Commit, which clears the audience in the transaction that creates the TODO; one `Idempotency-Key` per Commit (§6.2.1).
- Commands `/todo.new`, `/todo Tn`, `/todo.answer`, `/todo.steer`, `/todo.amend`, `/todo.stop`, `/todo.resume`, `/todo.retry`, `/todo.drop`, three doors each. Commit, amend and drop are `agent: confirm` (T-APP-04).
- J9: an answer offers **Make TODO** and **Save to wiki** (`/wiki.save` over `wiki.cloud.new`, `flows/entries/wiki.ts:50`, not the refresh in `app-operations/wiki.ts:53`).
- Queue reason `daily_limit` and the daily-budget pause render as on Home (T-APP-01). Check: C-STK-06.

Out: `/todo.from-issue` (T-STK-09); state transitions, placement and steer delivery (T-STK-01/02/05/06/08); merge execution (T-STK-04); Confirm (T-APP-04); line comments; notifications (T-APP-18); S2 Branch card and moved-off controls (T-COL-05, T-APP-10); package installation and host execution of seeds.

## Changes
- `cards/TodoContainer.tsx` and `cards/DraftContainer.tsx` (landed, 96aed3b0a) are the card files. They map `TodoSeam`'s entries to `TodoView` and the landed `DraftView` (f18e88958..c60db0f4b) props and bind actions with `flows/cardActions.ts`. Remove `todo` and `draft` from `PENDING_CARD_KINDS` (`CardRenderers.tsx:58`) and render them there. Draft field edits arrive as `gestures.set` and write the private entry's `card` column through `form.set` (T-APP-16): title and prompt as strings, acceptance as a JSON string array, place as `{mode, n?}` (`n` required for before and amend, absent for append), fixes as literal `true` or `false`; anything else is a typed error.
- `state/seams/TodoSeam.ts` (landed): it calls `/api/todos` and `/api/todos/{n}/{operation}` (`:126-127`), which no route serves today (only `POST /mythical/todos`, `compose/router.go:1134`). Point it at T-STK-01's routes. Toasts settle on the TODO's terminal event (§6.2.2).
- `flows/entries/todo.ts` (landed): add `todo.retry-current-flow` and `todo.takeover`.
- Delete StackSeam's TODO paths (`fileTodo`, `StackSeam.ts:77`, and its `POST /mythical/todos` client) and the `history.view`, `history.todo` and `history.retry` entries in `flows/entries/history.ts`, `FlowArgs.ts:46-49,199-202` and `FlowName.ts:139-143`, with their `StackCard.test.tsx` cases (pair: TodoView and DraftView ↔ the TODO rows in StackCard and StackSeam; minimal-code synthesis v1 §2).
- `flows/entries/wiki.ts`: `/wiki.save` over page creation.
- `flows/entries/image.ts` (new) and `packages/rpc/src/MachineJson.ts` (new, `addImagePackage(current, name) → {next, diff}`), shared with T-APP-03. Existing code considered: the Go validator in `packages/backend/microsandbox/machine_json*.go` runs only on the server; extend its test with the same pinned names.
- `packages/backend/microsandbox/missing_tool.go`: emit `failure.missing_tool {name, file: ".smithers/machine.json"}` only from a verified exit-127 missing-executable diagnostic whose name passes the package rule.
- `e2e/playwright/stack-todo.spec.ts`: rewrite for the TODO and Draft cards.

## Tests
- Unit (`TodoContainer.test.tsx`, landed): one literal case per §4.1 state. For each (first in order, viewer role, `merge_block.reason`) exactly one holds: enabled Merge, disabled Merge with the reason, or no Merge; passed required checks with a failed optional check enable Merge; a pending required check shows "Checks running". An unanswered question gives Answer; one answered by another member gives no Answer; a late 409 keeps the text with Send as steer. `foreign_push` gives Discard only to maintainers. Edit appears only while Queued, prefilled from the newest revision. Add to machine image appears only with `failure.missing_tool`.
- Unit (`DraftContainer.test.tsx`, landed): place options list only unmerged items; `issue` only from an issue; Commit disabled while in flight; each malformed `gestures.set` value (bad JSON, non-string acceptance, before without `n`, append with `n`, non-literal fixes) returns the typed error and sends no Commit.
- Unit (`MachineJson.test.ts`): `addImagePackage` keeps order, refuses a duplicate, a 65th name and `Fig Let`, creates the file when absent, and its diff touches only `.smithers/machine.json`.
- Integration (real PostgreSQL, composed router, production dispatcher): duplicate Commit with one key creates one TODO; Amend creates revision 2 and no TODO; a second Answer gets literal `409` with `answered_by`; Retry keeps attempt 1's evidence; two member subscriptions see the Draft only for its author until Commit.
- Take over (from C-APP-01): Maya owner, Ben maintainer, Alice and Eve members; Eve owns T3 (Queued) and T4 (Working, attempt 1). After Eve is removed, every browser shows Eve as removed owner and T3 keeps its revisions. Ben's T3 card offers Take over; Alice's doesn't. The app agent's tools lack `todo.takeover`. Alice's `POST /api/todos/3 {takeover}` gets 403 `permission`; a delegated credential gets 403 `never`; neither changes anything. Ben's press makes him T3's owner in all three browsers within 1 s, writes one owner event with actor Ben, and keeps T3's place. Taking over T4 continues attempt 1 with no restart, and T4's next question toast reaches Ben.
- Edit (from C-APP-02): with `parallel` 1, T1 Working and T2 Queued, Ben edits T2 to `PROMPT-B` and one acceptance line and presses Save twice within 100 ms: exactly one revision 2 by Ben, no new TODO, card shows `PROMPT-B` and "+1", one `Idempotency-Key`. Alice sees revision 2 and its author. Ben's prompt "change T2's prompt to PROMPT-C" posts a one-click Confirm card and leaves revisions unchanged. When T1 reaches In review, T2's plan step receives `PROMPT-B`. Working T2 shows no Edit; `/todo.amend` and Steer remain.
- e2e: C-J2-01, C-J4-02 and C-J9-01 run `/todo` and `/todo.new` through the production dispatcher, `CardRenderers`, both card files and their Views. C-J9-01 asserts a persisted wiki page with the literal answer Markdown.

## Acceptance
- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.
- [C-J2-01](../checks/C-J2-01.md): the Draft card drafted from an issue is edited, placed and committed once.
- [C-J4-02](../checks/C-J4-02.md): answer, merge next and retry with a steer from the TODO card while chatting.
- [C-J9-01](../checks/C-J9-01.md): an answer's Make TODO and Save to wiki work.
- [C-UI-13](../checks/C-UI-13.md): `TodoView` and `DraftView` are reachable from `CardRenderers`; StackSeam's TODO paths and `history.view`, `history.todo` and `history.retry` are deleted.

## Risks and notes
- PRs are based on `main` (§12.5.1), so evidence says "into main" and lists the included items. Earlier attempts stay in the model and open through Inspect.
- Draft text, issue content and seed diffs are data. Commit and Retry admit the TODO flow on a machine (T-FLW-11, T-INS-02; §17.3, M-29), with no host import, shell or package install. smithers-3f reviews that boundary.

## Ready checklist
1. Before start, smithers-3f confirms Commit, Amend and Answer are atomic and idempotent on T-STK-01's routes. Record pre-review in #3466.

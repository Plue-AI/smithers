# T-APP-02 TODO card and Draft card

Stage S1 · Size L · Depends on T-STK-01, T-APP-08, T-UI-03, T-UI-04, T-APP-19, T-STK-02, T-ACC-06, T-APP-16, T-STK-05, T-STK-06, T-STK-07, T-STK-08, T-STK-10, T-STK-15, T-GH-03, T-GH-06, T-STK-09, T-FLW-07, T-APP-04, T-APP-09, T-UI-23, T-MCH-10, T-APP-15 · Unblocks T-APP-01, T-APP-03, T-APP-05, T-REL-02 · Issue: [#3466](https://github.com/smithersai/smithers/issues/3466)
Spec: spec.md §14.2, §14.3 (TODO, Draft), §5.6, §8.6.1, §14.5.1, §4.1, §6.1.4, §6.2.1–6.2.2, §10.2, §10.4, §10.5.4, §10.6, §10.7, §10.8, §12.3, §12.5.1, §15.1.5, §19.3 · Delta: delta.md §9 (Add cards [S1] TODO, Draft), §6 · Product: mvp.md J2, J4, J9, §4.1, §4.2, §6.6 TODO card, Appendix A "TODOs and the stack"

## Goal
A member opens `/todo Tn` and sees the TODO's prompt, place, flow progress, every open wait, failure or evidence, and acts on it (answer, steer, stop, resume, retry, drop, amend) from the card; `/todo.new` and "make that a TODO" open a Draft card that commits a placed TODO exactly once.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the `TodoView` and the `DraftView`, with the CSS, in T-UI-04 and T-UI-03. This ticket builds no View, CSS or editor presentation. It owns the topic decoder and golden fixture, the adapter, the Container and the commands in Changes ([card-kinds.md §1](../card-kinds.md)). The seam is the view model from T-APP-19 (spec §14.2.1).

## Scope
In:
- `todo` card on the `todo:<n>` topic, embedded and maximized from one component:
  - header: title, state word (Queued with its queue position, Starting while the machine wakes and the coding agent launches, Working with its current step, §4.1), owner avatar;
  - meta: place ("next to merge", "3rd in stack"), "from #i" or "closed #i" for a linked issue, owner;
  - prompt and acceptance while Queued or Dropped, step strip otherwise, "+n" amendments disclosure with author and text;
  - Needs you by kind (§10.8.1): a question or approval inline with an Answer field (`/todo.answer Tn`); after the first answer, "Ben answered …"; a late submitter's `409 {answered_by}` keeps their text with **Send as steer** (`/todo.steer Tn`) (§10.8.2). `foreign_push` shows the commit link with **Bring in** and **Discard** (§12.3, M-33). A conflict shows the S1 conflict view: conflicted files, the terminal and SSH line, and **Done** (§10.5.4); from S2 Resolve opens the Branch card;
  - failure: "<step> failed", message, optional steer and Retry (`/todo.retry Tn`);
  - evidence of the current attempt (§10.4.3): PR link ("#pr on GitHub ↗"), diff stat, machine checks with duration, GitHub passed/total, review summary, the earlier items the PR includes ("Includes T3, T4 until they merge", §12.5.1), "approval cleared by rebase";
  - Merge control: Merge (`/merge Tn` with the head sha shown) only for the first item and a viewer who may merge; otherwise "Merges after Tn", "Checks running", the failing check's name, or GitHub's refusal text verbatim (§10.6.2);
  - actions while live or paused: Open branch (`/branch Tn`), Inspect (`/run.inspect <id>`), Stop or Resume, Drop (confirm). Stop parks the run in a durable pause wait; Resume continues the same run from its last finished step; Retry starts a new attempt from step 1 and keeps the earlier attempt and its evidence (§4.1, §10.4.1).
- `draft` card, the §14.3 Draft model: Title, Prompt, Acceptance, Place (Append, Before Tn, Amend Tn over unmerged items), "Closes #i when merged" when drafted from an issue, a read-only seed patch when one exists, Discard (`card.dismiss`) and Commit. The draft lives in the private entry's `card` column through `form.set` (AGENTS.md form law, §3). Until Commit the entry is private to its author (`audience_member_id`, §14.5.1). Commit clears the audience in the transaction that creates the TODO, so from then on the entry is shared and shows "Committed <title>" (or "+1" on Tn for an amendment) linking the TODO. Commit sends one `Idempotency-Key`, so a double press makes one TODO (§6.2.1).
- Commands for the Appendix A TODO group: `/todo.new`, `/todo Tn`, `/todo.answer`, `/todo.steer`, `/todo.amend`, `/todo.stop`, `/todo.resume`, `/todo.retry`, `/todo.drop`. Each has three doors and a typed payload; a missing input renders a form card (§6.1.4). Those marked A✓ in mvp.md Appendix B.2 (commit, amend, drop) never run directly from the app agent: it posts a one-click Confirm card that the prompt's author presses (§15.1.5, T-APP-04).
- J9 answer doors: an answer offers **Make TODO** (drafted from the conversation into a Draft card) and **Save to wiki** (`/wiki.save`, using the existing page-create operation `wiki.cloud.new` in `flows/entries/wiki.ts:50` and `CloudWiki.create` in `wiki/CloudWiki.ts:296`, with the answer as Markdown body). `packages/smithers/ui/src/app-operations/wiki.ts:53`'s `wiki.create` refreshes the repository wiki and is not the save operation.
- **Edit** while Queued (mvp.md §6.6): the prompt and acceptance open inline, prefilled from the newest revision, and Save runs `/todo.amend Tn {prompt, acceptance}` from the person's session with one `Idempotency-Key`. It appends revision n+1 ("+1", §10.2.2), creates no TODO, and the run starts on the newest revision. The Container offers Edit only while the TODO is Queued; after admission, `/todo.amend` and Steer remain (§10.2.2). The app agent's amend stays `confirm` (§15.1.5). Check: C-APP-02.
- **Take over** (`todo.takeover`, in-card, Appendix B.4) on a TODO whose owner was removed or suspended (§5.6), for maintainers and the owner only. It is person-only (`agent: never`) and runs `POST /api/todos/{n} {takeover}` (T-ACC-06). The owner chip shows the removed owner until then. Check: C-APP-01.
- **Add to machine image** (`image.add`) on a failure that names a missing package (`failure.missing_tool`, T-MCH-10), prefilled with the package name. This ticket owns the shared command, seed helper and required system-package failure metadata; T-APP-03 wires the Settings control after it. Read `main:.smithers/machine.json` through the file-content route (T-APP-15), treat absence as `{"packages": []}`, validate the §8.6.1 name/64-name/no-duplicate rules and preserve existing package order. Open a private Draft titled "Add <name> to the machine image", whose read-only seed touches only that file. `image.add` is P, A✓ (Appendix B.4): an app-agent request confirms before opening the Draft; Commit separately follows `todo.new` confirmation. Check: C-APP-03.
- Decode queued.queue.reason daily_limit from spec.md §4.1.1 and render "Daily limit reached · starts tomorrow". Decode the §14.3 TODO pause reason and install owner for "Paused · daily token budget · <owner>"; preserve §4.1.0a branch-wait precedence (FLW-11 G12/R60, product 17:00). Checks: C-STK-06, C-STK-03, C-UI-13.

Out:
- `/todo.from-issue` drafting and the `todo` label (T-STK-09); state transitions, placement, steer delivery and conflict waits (T-STK-01/02/05/06/07/08); merge execution (T-STK-04); Confirm card (T-APP-04); moved-off controls on the Branch card (T-COL-05, S2).
- Line comments ([D] §12.5.3); browser notifications (T-APP-18, S2); the lessons receipt (T-FLW-06, S3).
- S2 Branch-card navigation, moved-off controls and live machine presence, Settings presentation, package installation, new toolchains and host execution of seed patches. S1 Open branch/Resolve uses the existing workspace/terminal conflict path; the Branch card appears with T-APP-10.

## Changes
- `packages/rpc/src/topics/Todo.ts` (new): the `todo:<n>` decoder. `packages/rpc/test/fixtures/topics/todo.json` (new): the golden snapshot, which `packages/backend/internal/services/todo_topic_golden_test.go` (new) compares with T-STK-01's builder on a seeded TODO.
- `apps/app/src/mainview/cards/containers/todoModel.ts` (new): `toTodoModel(topic, viewer)` returns the `TodoCard` model and actions. The merge control comes from `merge_block` (`MergeReady`, §10.6.2a), never from check states read here. Actions follow state, `needs_you.kind`, the viewer's role and the attempt: each open wait's own actions in `waits[]` (Answer first for the primary wait), Steer, Stop, Resume, Retry, Retry with the current flow, Drop, Edit (Queued only: the `todo.amend` action labelled Edit, with `input` prefilled from the newest revision, the prompt field multiline), Take over (removed owner, maintainer or owner viewer), Add to machine image (missing package), Bring in and Discard (Discard for maintainers), Done on a conflict, Open branch and Inspect. A late answer's `409 {answered_by}` keeps the draft text with Send as steer.
- `apps/app/src/mainview/cards/containers/draftModel.ts` (new): `toDraftModel(entry.card, stack)`: place options from unmerged items only, `issue` only when drafted from an issue, Commit disabled while a commit is in flight.
- `apps/app/src/mainview/cards/containers/TodoContainer.tsx` and `DraftContainer.tsx` (new): subscribe `todo:<n>` and the author's `view:<member>:<branch>`, bind actions with `cardActions`, and render `TodoView` (T-UI-04) and `DraftView` (T-UI-03). Draft field edits arrive as `gestures.set` on blur and write the private entry's `card` column through `form.set` (T-APP-16).
- `packages/rpc/src/Cards.ts`: kinds `todo {n}` and `draft`, whose payload is the §14.3 Draft model (`DraftCard.ts`, T-APP-19).
- `apps/app/src/mainview/state/seams/TodoSeam.ts` (new): command handlers over `/api/todos` (§6.3) with `Idempotency-Key`; responses settle toasts only through `todo:<n>` events (§6.2.2).
- `apps/app/src/mainview/flows/entries/todo.ts` (new): `/todo.new`, `/todo Tn`, `/todo.answer`, `/todo.steer`, `/todo.amend`, `/todo.stop`, `/todo.resume`, `/todo.retry`, `/todo.drop`, and the in-card `todo.retry-current-flow` and `todo.takeover`. In `flows/entries/history.ts`, `history.view` (`:38`), `history.todo` (`:87`) and `history.retry` (`:102`) are deleted, not aliased. Delete `fileTodo` (`state/seams/StackSeam.ts:77`) and its `POST /mythical/todos` client path.
- `apps/app/src/mainview/flows/entries/wiki.ts`: add `/wiki.save` over page creation, not background refresh. T-APP-16's entry adapter (`cards/containers/entryModel.ts`) gains Make TODO and Save to wiki on answers.
- `apps/app/src/mainview/flows/entries/image.ts` (new): the shared in-card `image.add` command, using the same authorizer and private Draft writer. `packages/rpc/src/MachineJson.ts` (new): `addImagePackage(current, name) → {next, diff}`; `packages/rpc/test/fixtures/machineJson.json` (new) pins accepted/refused names and literal seed diffs. T-APP-03 consumes them. Extend existing `packages/backend/microsandbox/machine_json_test.go` with the same pinned validator fixtures; this follow-up does not edit frozen T-MCH-10.
- `packages/backend/microsandbox/missing_tool.go` and its existing `internal/services/workspace_command_jobs.go` failure projection: provide the missing system-package metadata this card requires, `failure.missing_tool {name, file: ".smithers/machine.json"}`, including C-APP-03's `figlet`. Accept a system-package name only from a verified exit-127 missing-executable diagnostic that passes the package-name rule; retain language-tool declaration-file fixes and leave unrelated or unconfirmed exits unchanged. Add literal fixtures in `missing_tool_test.go` and the service/route integration, including `figlet`, malformed names and an internal exit 127. No host package install follows diagnosis.
- `apps/app/e2e/playwright/stack-todo.spec.ts`: rewrite for the TODO and Draft Containers.

## Tests
- Unit (`todoModel.test.ts`): from `topics/todo.json` and one fixture per §4.1 state, the model parses with the `TodoCard` schema. For each combination of first in order, viewer role and `merge_block.reason`, exactly one of these holds: an enabled Merge, a disabled Merge carrying the reason's detail, or no Merge. Passed required checks with a failed optional check give an enabled Merge; a pending required check gives "Checks running" (the same cases as T-APP-04).
- Unit, same file: a question unanswered gives Answer; answered by another member gives `first_answer` and no Answer; a late submitter's 409 keeps the text with Send as steer.
- Unit, same file: `foreign_push` gives Bring in, and Discard only for a maintainer; a conflict gives the S1 conflict actions with Done.
- Unit, same file: Edit appears only while Queued, with its inputs prefilled from the newest revision; Take over appears only for a maintainer or owner viewer on a removed or suspended owner's TODO, and never in the agent's tools; Add to machine image appears only with `failure.missing_tool`, prefilled.
- Unit (`draftModel.test.ts`): place options list only unmerged items; `issue` appears only with an issue; Commit is disabled while a commit is in flight; an uncommitted draft entry carries `audience_member_id`.
- Unit: every `Action.label` and `disabled.reason` the adapter emits passes C-UI-02's `lintText` (engineering's copy; the View's copy is its T-UI ticket's).
- Integration (`TodoSeam.test.ts`, real PostgreSQL and composed production router): invoke the production dispatcher/authorizer and mounted create/amend/answer/retry/takeover commands, not direct service methods. Duplicate Commit with one key creates one TODO; Amend creates revision 2 and no TODO; Answer conflict returns literal 409 and answered_by; Retry keeps attempt 1 evidence; eligible takeover records one owner event and a member gets literal 403 permission. Two real member subscriptions prove Draft/form.set privacy and atomic shared publication after Commit. `todo_topic_golden_test.go` compares the real builder with the pinned golden.
- Unit (`flows/agent-parity.test.ts`, existing): every `/todo*` entry has three doors; commit, `/todo.amend` and `/todo.drop` are `confirm` for agents; `todo.takeover` is person-only.
- e2e: C-J2-01, C-J4-02, C-J9-01, C-APP-01/02 and C-APP-03's failed-step half invoke `/todo` and `/todo.new` through the production dispatcher, CardRenderers, TodoContainer/DraftContainer and their Views. C-J9-01 asserts a persisted wiki page with the literal answer Markdown, not a refresh run. Image tests exercise the mounted main-file read and production image.add/Draft/Commit path; pin the exact diff instead of computing expected seed output with addImagePackage. Record literal state/action/error expectations in fixtures; no test reads spec files or computes expectations from production code at runtime.

## Acceptance







- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-J2-01](../checks/C-J2-01.md): the Draft card drafted from an issue is edited, placed and committed once.
- [C-J4-02](../checks/C-J4-02.md): answer, merge next and retry with a steer from the TODO card while chatting.
- [C-J9-01](../checks/C-J9-01.md): an answer's Make TODO and Save to wiki work.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned
- [C-APP-01](../checks/C-APP-01.md): a maintainer takes over a removed member's TODO from the TODO card; members and agents can't.
- [C-APP-02](../checks/C-APP-02.md): a Queued TODO's prompt is edited from the card and the run starts on the new revision.
- [C-APP-03](../checks/C-APP-03.md) (failed-step half): Add to machine image from a failure that names a missing package.

## Risks and notes
- §14.3 TODO lists `failure`, the issue link and the branch. The issue link's `fixes` flag comes from B-08's §14.3 change; the adapter maps `todos.fixes_issue` once T-APP-19's `TodoCard` carries it, so this ticket starts after that field lands.
- Resolved: `POST /api/todos` (§6.3) takes `acceptance`, and the Draft model carries it (§14.3 Draft).
- PRs are based on `main` (§12.5.1, E-15), so the evidence row says "into main" and lists the included items.
- Evidence is per attempt (§14.3): the card shows the current attempt; earlier attempts stay in the model and open through Inspect.
- Edit, Take over and Add to machine image need T-UI-04 additions (the editable prompt from the action's prefilled inputs, the removed-owner chip, the failure's action). C-APP-01 to C-APP-03 fail until they land.
- `/wiki.save` and shared `image.add` are owned here; T-APP-03 consumes the image command after the Draft destination exists. smithers-8a accepts that ownership split and any S1/S2 navigation change. smithers-06 accepts TodoView/DraftView/T-UI-23 callbacks, smithers-b8 accepts command behavior, smithers-38 signs off decoders/helpers under §21.1, and smithers-3f accepts the transaction, revision and execution seams.

## Ready checklist

1. Depends on lists lifecycle, steers, independent waits/conflict controls, amendments, evidence/PR/foreign-push/issue drafting, Inspect, Confirm, actor/View seams, tool detection and main-file reads, in addition to the private/shared Draft writer and live topics. S2 navigation stays outside S1.
2. Out names backend semantics, issue admission, Confirm, moved-off/Branch/live presence, notifications, learning, Settings visuals, toolchain expansion and package installation. Shared image.add belongs here so Draft and Settings do not depend on each other.
3. Acceptance runs the production catalog dispatcher, CardRenderers/Containers, composed TODO and main-file routes, private/shared subscriptions and wiki page creation. Golden rows, action/error matrices, answer Markdown and image diffs have independent literal expectations.
4. smithers-8a accepts ownership/stage changes; smithers-06 accepts the View callbacks; smithers-b8 owns command/API behavior; smithers-38 accepts RPC decoders/helpers; smithers-3f accepts transaction/revision/security seams.
5. Before start, smithers-06: do the Todo/Draft and T-UI-23 seams cover every wait, prefilled edit and image action? smithers-b8: do all S1 commands have live handlers and private Draft/Confirm destinations; does wiki.save create a page? smithers-38: do pinned topic rows and MachineJson fixtures define compatible exports? smithers-3f: are Commit/Amend/Answer atomic and idempotent; does Retry/seed execution stay on machines; does verified missing-package metadata match MachineJson validation without changing language-tool diagnostics? Record pre-review in #3466.
6. Draft text, issue content and seed diffs are data; Commit/Retry admit the pinned TODO flow through T-FLW-11/T-INS-02 on a machine (§17.3, M-29), with no host import, shell or package installation. smithers-3f reviews that boundary; C-APP-03 and route integration prove no package change before reviewed TODO execution and merge.


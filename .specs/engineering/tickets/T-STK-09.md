# T-STK-09 Make TODO from an issue; the `todo` label freezes revision 1

Stage S1 · Size M · Depends on T-STK-01, T-ACC-02, T-GH-02, T-STK-02, T-STK-14, T-ACC-05, T-GH-09, T-APP-16, T-FLW-11 · Unblocks T-APP-02, T-MNT-01, T-REL-02 · Issue: [#3457](https://github.com/smithersai/smithers/issues/3457)
Spec: spec.md §3 (`todo_revisions`), §3.0, §5.2, §6.1.2b, §10.2.1–§10.2.1b, §10.4.2, §12.3 (issue labeled `todo`), §12.4.1, §14.5.1, §15.1.5, §17.5 · Delta: delta.md §6 (Modify admission from GitHub; `FileTodo` no longer creates an issue), §7 · Product: mvp.md J2.2, §6.3 (label and Make TODO rows), §14 trust rules, M-16, M-22, Appendix B.2 (`issue.implement`)

## Goal
A member turns an issue with team text into a TODO by **Make TODO** or by the `todo` label, and only a maintainer can do so for an issue with outsider text (§10.2.1). Revision 1 is the issue as admitted at that action; later issue edits, comments and repeated deliveries change nothing; any other label is reverted with a comment and starts no work.

## Scope

- Poll and Make TODO commit admission share one PostgreSQL transaction serialized per repository and issue. After authorization, lock that admission key; atomically record event consumption or request idempotency, TODO/revision 1/context, placement, semantic events, projections and keyed outbound intents. Advance the issue-events cursor only past durably consumed events; a pre-commit crash leaves it unchanged. Concurrent polls and commits admit one live TODO, and a losing door records a deduplicated no-op. Checks: C-J2-02, C-SEC-03.
- Enforce one unmerged TODO per repository/issue, not one TODO for the issue’s lifetime. Release the admission claim when its earlier TODO is dropped or merged; a fresh label after drop may create a new TODO while retaining the earlier TODO’s identity and history. Checks: C-J2-02, C-SEC-03.
In:
- `/todo.from-issue #n` (GitHub issue #n): the app agent drafts title, prompt, acceptance and `fixes` from the issue thread. The draft is a private Draft card entry (`audience_member_id`) until its author commits it (§14.5.1). The member edits, places and commits through `POST /api/todos {issue, issue_digest, fixes, place}`. The command is `agent: confirm` in the catalog (A✓): the app agent posts a one-click confirmation that the prompt's author presses (§15.1.5).
- On commit, the App labels the issue `todo` and comments "Committed as T12 ↗" (one comment, keyed, §12.4.1).
- Issue text (§10.2.1): team text when the author and the last editor of the title and body are members or the install's App (GraphQL `Issue.author` and `Issue.editor`, plus `renamed` events), the rule of today's `approvesIssueText` (`github_issue_trust.go:158`); otherwise outsider text. The §10.2.1 table decides each door by issue text and the actor's role.
- The label door: each `labeled` event for `todo` from T-GH-02's issue-events cursor is decided once. An admitted label creates a TODO appended to the stack. Revision 1 = the issue's title and body in the first read after the event is consumed; that read's comments are the issue context; `issue_digest` and the read time are recorded, and the TODO card shows the admitted text. A rename or body edit by a non-member after the event (GraphQL `Issue.lastEditedAt` and `editor`, or a `renamed` event) reverts the label with "Changed after it was labeled. Label it again to make a TODO." Idempotent by `(issue, label event id)`.
- An issue has at most one unmerged TODO; labeling it again while one exists is a no-op. TODOs made from an issue default to `fixes_issue = true` (§10.2.1).
- Exactly three doors exist (§10.2.1): chat, Make TODO and a member's label.
- Labels the table refuses are reverted with one keyed comment (§12.4.1, §17.5): a non-member's, a suspended member's, another App's, and a Member's on outsider text ("Only a maintainer can make a TODO from this issue"). The App's own label never creates a second TODO.
- Outsider issues, comments and mentions start no work without a maintainer's action (§17.5). Make TODO on outsider text is refused with class `permission` for a Member before any draft is written; an agent's request is checked against its member's role before a confirmation is posted (§6.1.2b).
- The draft (`/todo.from-issue`) reads the issue as one snapshot, as quoted data, in a call with no tools. The committed TODO keeps that snapshot's digest as its issue context. The run receives the issue context as quoted data marked with each author, and never a later comment (§10.2.1b).

Out:
- The Draft card UI (T-APP-02). The issues poll stream (T-GH-02). Membership and the live write check (T-ACC-02).
- Triage, duplicate search and author replies (mvp.md §14, deferred with no promised release).
- Issue creation, automatic admission from repository policy, later-comment steering, visual Draft/TODO components and a second issue cache. Reuse T-APP-16's private entry writer; T-STK-02 owns Append and Before.

## Changes

- Resolve `issue_digest` to the author’s private Draft snapshot and preserve that exact issue context on commit. Do not re-read GitHub to replace it. Refuse an unknown or another member’s digest before admission. Check: C-J2-01.

- Replace the lifetime `mythical_items_issue_idx` uniqueness in `packages/backend/db/product/migrations/0026_mythical_stacks.sql:120` through a new forward migration, never by editing a recorded migration. Use per-issue admission serialization and a schema constraint for one active unmerged TODO; dropped and merged historical rows keep their issue link. Update issue lookup queries to distinguish history from the active claim. Check: C-J2-02.
- Remove or replace every sweep/auto-door caller, including `packages/backend/internal/services/mythical_items.go:1065` (Backfill in advanceItems), `:2892` (labelAutoTodo in webhook processing), and `packages/backend/internal/services/mythical_file_todo.go:93`. Retained Make TODO code must enter the authorized admission transaction and cannot auto-label into a fourth door. Checks: C-J2-02, C-SEC-03.
- `packages/backend/internal/services/todo_from_issue.go` (new) → commit path: `todo_revisions(rev 1, reason 'from-issue', issue_digest)`, then `AddLabel` (`services/mythical_github.go:547`) and `Comment` (`:484`, marker key `todo-committed:<n>`) through `outbound_writes` (T-GH-09).
- `packages/backend/internal/services/mythical_items.go:165` (`ObserveIssue`) → on a fresh member label event, create the TODO with revision 1 frozen. Delete the "only an item that has not started takes new text" path (`:236-262`); edits never touch `todo_revisions`. Keep `checks.TodoEvent` semantics (`:196-200`) as a unique `(issue_number, label_event_id)` on the TODO.
- `mythicalAuthorize` (`:2942`) and `policy.maintains` → the member check from T-ACC-02 (roster, not suspended, live `push` permission). A label applied by the App (`ViaApp`) is never a door. `approvesIssueText` (`github_issue_trust.go:158`) keeps its rule, with members as the trusted writers and maintainers as the approvers of outsider text. The polled admission fills `issueText` from GraphQL `author` and `editor` instead of webhook stamps.
- The run's issue context (§10.4.2) → the admitted snapshot, with outsider text rendered as quoted data marked with its author; later comments are never appended.
- `revertLabel` (`:3063`) → also posts one keyed comment naming why: "only members of this install can add `todo`", "Only a maintainer can make a TODO from this issue" or "Changed after it was labeled. Label it again to make a TODO."
- Delete the factory policy's auto-TODO door (`mythicalAutoTodo` `:2976`, `labelAutoTodo` `:2988`), which isn't one of the three doors.
- After T-STK-14’s existing-item backfill, the new forward migration deletes only verified unadmitted skipped rows with null todo_id, no member-commit identity and no retained member work or PR identity. Abort the migration on any other null todo_id; do not infer unadmitted from NULL alone. Then set mythical_items.todo_id NOT NULL. Execute the registered production migration over literal old-row fixtures and preserve all member TODO, branch and PR identities. Checks: C-J2-02, C-SEC-03.
- Delete the admit-all-open-issues sweep (`Backfill`, `:300-410`), route `POST /mythical/backfill` (`internal/compose/router.go:1119`), its OpenAPI row (`docs/api/openapi/repositories.yaml:11952`) and `history.backfill` (`apps/app/src/mainview/flows/entries/history.ts:60`). Label changes arrive through T-GH-02's issues stream, and a webhook delivery only requests that fetch.
- `packages/backend/internal/services/mythical_proposal.go:111` (`observeMention`) → a non-member's mention records nothing.
- `issue.implement` → renamed `/todo.from-issue` in the catalog (mvp.md Appendix B.2). The draft reads the issue and its comments from the `github_synced_*` store (§3.0) and never posts.
- `docs/api/openapi/todos.yaml` (new; `issue`, `issue_digest`, `fixes`), regenerated `packages/smithers/src/internal/backend/ProductApi.ts`, `packages/backend/docs/todos.md` (new); docs gates.

## Tests

- C-J2-01 changes the remote issue after drafting, then commits with the original `issue_digest` through the production route. Revision 1 and run context equal the literal draft snapshot; another member’s or unknown digest admits nothing.

- C-J2-02/C-SEC-03 integration: race two production poll workers with POST /api/todos for the same repository/issue. Crash before admission commit, after commit before cursor advancement and after remote label/comment success before acknowledgement. Assert one admitted live TODO, one frozen context/revision and one committed receipt/projection/intent set; the cursor never skips an uncommitted event and replay creates no duplicate effective remote write. Drop then relabel creates one new TODO with the old TODO retained; labels while an active TODO exists create none.
- Registered production migration, real PostgreSQL (C-J2-02): seed T-STK-14 backfilled member work, retained PR number/head, verified unadmitted skipped rows and a null-todo non-skipped or member-work row. An unknown null row aborts before deletion/NOT NULL; after correcting it through the approved backfill, only verified unadmitted skipped rows disappear and member TODO/branch/PR identities remain byte-identical.
- Integration with real PostgreSQL and the fake GitHub server (issue events API), `todo_label_db_test.go` (new): a member label → one TODO whose revision 1 equals the title and body of the first read after the event; a member's edit between the label and that read is in revision 1, and the card shows the read time. Three redeliveries (webhook, poll, webhook) → still one. An issue edit before and after admission → the revision count stays 1.
- Same file: the App's label after Make TODO creates nothing; a non-member's label is removed once and commented once, with zero `jobs` launch rows; a second member label while a TODO is unmerged is a no-op.
- Same file: a suspended member's label is treated as a non-member's.
- Same file: a label removed and reapplied between two polls, on an issue whose earlier TODO was dropped, creates one TODO from the second `labeled` event; while a TODO is unmerged it creates none.
- Same file, for [C-SEC-03](../checks/C-SEC-03.md): the §10.2.1 table over issue text (team; outsider; team text last edited by a non-member) × actor (owner, maintainer, Member, suspended member, non-member, another App) × door (label, session Make TODO, CLI Make TODO). A non-member's edit after a maintainer's label reverts it.
- Integration, `todo_from_issue_db_test.go` (new): a commit with a repeated `Idempotency-Key` yields one TODO, one label call and one comment; the uncommitted draft is visible only to its author.
- Unit, `mythical_items_test.go` (existing, `fakeMythicalGitHub` at `:36`): `ObserveIssue` never rewrites the prompt of an existing TODO.

## Acceptance




- [C-J2-01](../checks/C-J2-01.md): Make TODO drafts from the discussion, is edited, placed and committed; the issue is labeled and commented.
- [C-J2-02](../checks/C-J2-02.md): the label door freezes revision 1, ignores later edits and deduplicates deliveries.
- [C-SEC-03](../checks/C-SEC-03.md): issue admission by issue text, role and door; an issue with outsider text becomes a TODO only by a maintainer; later outsider text never reaches the run.

## Risks and notes
- The label door only appends through T-STK-01. The Before option uses T-STK-02 once it lands; C-J2-01 requires that real placement integration. The append-only label check C-J2-02 does not wait for T-STK-02.
- Resolved: T-GH-02's repository issue-events cursor replaces `labelHistory` (`mythical_github.go:398`), which read one page of events per issue.
- Risk: GraphQL `Issue.editor` names only the last editor, so an outsider's edit followed by a member's edit reads as team text. Confirmed by a test where Carol edits Ben's issue and Ben edits it after. This matches `approvesIssueText` today: the member's later edit makes the text theirs.

## Ready checklist
1. Dependencies: T-STK-02 supplies placement, T-STK-14 finishes member-item backfill before NOT NULL, T-ACC-05 supplies authorized confirmation dispatch, T-GH-09 supplies durable writes, T-APP-16 supplies private draft entries, and T-FLW-11 supplies the single run receiving the frozen context. Existing dependencies supply identity, schema and issue-event polling. All are S1; none transitively depends on this ticket in the current index.
2. Exclusions: Scope names issue creation, policy auto-admission, triage, later-comment steering, visual components and a second cache. Deferred work has no promised release.
3. Boundary tests: C-J2-02 and C-SEC-03 drive the production issue-events scheduler and webhook hint route against fake REST/GraphQL servers and real PostgreSQL; session and delegated Make TODO drive the production catalog dispatcher and POST /api/todos, including confirmation approval. Literal fixture text, roles, event ids and expected counts are checked in; no expected result is read from spec files or production policy code at runtime. C-J2-01 remains the app placement integration with T-APP-02.
4. Decisions: smithers-3f decides admission transactions and migration sequencing; smithers-b8 approves the public command/API and private-draft seam; smithers-8a accepts changes to the trust rule or scope before implementation. The documented last-editor rule is fixed, not an implementation choice.
5. Owner pre-review before start: smithers-3f: Does the event cursor and admission transaction deduplicate concurrent polls and commits? Does backfill precede deletion and NOT NULL without losing member work? smithers-b8: Do session and delegated doors use the same dispatcher and confirmation owner? Does the private draft stay invisible to other members and agent context? No View edit is in scope; any proposed View change requires smithers-06 pre-review on its action and admitted-text props. smithers-3f: answered, BLOCKING edits applied (tech lead adopts). smithers-b8: answered, BLOCKING edits applied (tech lead adopts). smithers-06: answered 18:3x, ok. Design condition: "ok. Admitted text renders as the TODO's prompt revision ("+n"), and its actions as given."
6. Security: smithers-3f reviews C-SEC-03 and the inherited T-INS-02/T-FLW-11 execution boundary before start. Drafting is a packaged host model call with quoted input and no tools. Any repository flow, coding agent or check runs only in an isolated branch machine (M-29, §1.3), never by host fallback; missing isolation refuses launch. Outsider input cannot mint run credentials or request a machine before authorized admission.

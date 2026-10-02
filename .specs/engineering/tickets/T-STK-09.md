# T-STK-09 Make TODO from an issue; the `todo` label freezes revision 1

Stage S1 · Size M · Depends on T-STK-02, T-ACC-02, T-GH-02 · Unblocks — · Issue: [#3457](https://github.com/smithersai/smithers/issues/3457)
Spec: spec.md §3 (`todo_revisions`), §3.0, §5.2, §6.1.2b, §10.2.1–§10.2.1b, §10.4.2, §12.3 (issue labeled `todo`), §12.4.1, §14.5.1, §15.1.5, §17.5 · Delta: delta.md §6 (Modify admission from GitHub; `FileTodo` no longer creates an issue), §7 · Product: mvp.md J2.2, §6.3 (label and Make TODO rows), §14 trust rules, M-16, M-22, Appendix B.2 (`issue.implement`)

## Goal
A member turns an issue with team text into a TODO by **Make TODO** or by the `todo` label, and only a maintainer can do so for an issue with outsider text (§10.2.1). Revision 1 is the issue as admitted at that action; later issue edits, comments and repeated deliveries change nothing; any other label is reverted with a comment and starts no work.

## Scope
In:
- `/todo.from-issue #n` (GitHub issue #n): the app agent drafts title, prompt, acceptance and `fixes` from the issue thread. The draft is a private Draft card entry (`audience_member_id`) until its author commits it (§14.5.1). The member edits, places and commits through `POST /api/todos {issue, fixes, place}`. The command is `agent: confirm` in the catalog (A✓): the app agent posts a one-click confirmation that the prompt's author presses (§15.1.5).
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
- Triage, duplicate search and author replies (mvp.md §14, maintainer release).

## Changes
- `packages/backend/internal/services/todo_from_issue.go` (new) → commit path: `todo_revisions(rev 1, reason 'from-issue', issue_digest)`, then `AddLabel` (`services/mythical_github.go:547`) and `Comment` (`:484`, marker key `todo-committed:<n>`) through `outbound_writes` (T-GH-09).
- `packages/backend/internal/services/mythical_items.go:165` (`ObserveIssue`) → on a fresh member label event, create the TODO with revision 1 frozen. Delete the "only an item that has not started takes new text" path (`:236-262`); edits never touch `todo_revisions`. Keep `checks.TodoEvent` semantics (`:196-200`) as a unique `(issue_number, label_event_id)` on the TODO.
- `mythicalAuthorize` (`:2942`) and `policy.maintains` → the member check from T-ACC-02 (roster, not suspended, live `push` permission). A label applied by the App (`ViaApp`) is never a door. `approvesIssueText` (`github_issue_trust.go:158`) keeps its rule, with members as the trusted writers and maintainers as the approvers of outsider text. The polled admission fills `issueText` from GraphQL `author` and `editor` instead of webhook stamps.
- The run's issue context (§10.4.2) → the admitted snapshot, with outsider text rendered as quoted data marked with its author; later comments are never appended.
- `revertLabel` (`:3063`) → also posts one keyed comment naming why: "only members of this install can add `todo`", "Only a maintainer can make a TODO from this issue" or "Changed after it was labeled. Label it again to make a TODO."
- Delete the factory policy's auto-TODO door (`mythicalAutoTodo` `:2976`, `labelAutoTodo` `:2988`), which isn't one of the three doors.
- `packages/backend/db/product/migrations/01xx_todo_item_not_null.sql` (new) → delete `mythical_items` rows that have no TODO (the `skipped` rows T-STK-01's backfill left; an issue is not a TODO until a member acts, M-16) and set `mythical_items.todo_id` NOT NULL.
- Delete the admit-all-open-issues sweep (`Backfill`, `:300-410`), route `POST /mythical/backfill` (`internal/compose/router.go:1119`), its OpenAPI row (`docs/api/openapi/repositories.yaml:11952`) and `history.backfill` (`apps/app/src/mainview/flows/entries/history.ts:60`). Label changes arrive through T-GH-02's issues stream, and a webhook delivery only requests that fetch.
- `packages/backend/internal/services/mythical_proposal.go:111` (`observeMention`) → a non-member's mention records nothing.
- `issue.implement` → renamed `/todo.from-issue` in the catalog (mvp.md Appendix B.2). The draft reads the issue and its comments from the `github_synced_*` store (§3.0) and never posts.
- `docs/api/openapi/todos.yaml` (`issue`, `fixes`), regenerated `ProductApi.ts`, `packages/backend/docs/todos.md`; docs gates.

## Tests
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
- Resolved: T-GH-02's repository issue-events cursor replaces `labelHistory` (`mythical_github.go:398`), which read one page of events per issue.
- Risk: GraphQL `Issue.editor` names only the last editor, so an outsider's edit followed by a member's edit reads as team text. Confirmed by a test where Carol edits Ben's issue and Ben edits it after. This matches `approvesIssueText` today: the member's later edit makes the text theirs.

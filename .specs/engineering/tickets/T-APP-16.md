# T-APP-16 Branch conversations: storage, topics, view state, branch tree, Earlier archive

Stage S1 · Size L · Depends on T-COL-02, T-ACC-02, T-UI-07, T-APP-19, T-APP-22, T-APP-09 · Unblocks T-AGT-03, T-APP-01, T-APP-02, T-APP-04, T-APP-05, T-APP-06, T-APP-10, T-APP-23, T-REL-02, T-REL-03, T-STK-09 · Issue: [#3446](https://github.com/smithersai/smithers/issues/3446)
Spec: spec.md §2 (Conversation), §3, §6.3 (`/api/conversations`), §7.2, §14.1, §14.1.5, §14.5.1, §15.1.2a · Delta: delta.md §9 · Product: mvp.md §3 Conversation, §6.4 Branch conversations, M-08 · Reference: [card-kinds.md](../card-kinds.md)

## Goal
Everyone on a branch reads one conversation with the same entries in the same order, each member keeps their own scroll and card state, `main`'s conversation opens on the Home card, and every legacy per-member conversation stays readable under "Earlier". This ticket lands the storage, topics, API and Containers. T-APP-23 moves turns to the host and switches the shell over in one cutover.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the conversation shell, the branch tree, the entry rows and the Earlier node in T-UI-07. This ticket builds no View. It owns the §3 conversation tables, the `conversation:<branch>` and `view:<member>:<branch>` builders, decoders and goldens, the entry adapter and the shell Containers ([card-kinds.md §1](../card-kinds.md)).

## Scope
In (adopted owner pre-review):
- Lock the conversation row in the append transaction, allocate seq from its transactional counter and enforce UNIQUE(conversation_id, seq). Advance the counter only with committed entries and projection rows; branch/conversation creation shares its caller transaction. GET, snapshots and live subscriptions authorize the conversation and filter private entries and queued prompts to their audience member. Foreign view-state reads/writes and snapshots are refused; SharedEntries excludes every private entry, including the reader’s own. Check: C-APP-04.

In:
- Storage, decided here (B-28): the §3 tables `conversations` (1:1 with a branch, created in the branch's transaction), `conversation_entries` (shared, ordered by `seq`), `member_conversation_state` and `agent_turns`, in new migrations. `AppTimelineService` (`packages/backend/internal/services/app_timeline.go`) doesn't fit and stays unchanged: it rewrites history (`Rewrite`, `:454`, through `DeleteAllAppTimelineEvents` at `:474`; suffix truncation uses `DeleteAppTimelineEventsFrom` at `:389`), keys a timeline by owner and client key (`FindOrCreate`, `:247`) with its own member roles (`AddMember`, `:578`), and has no audience filter or turn queue, while §14.5.1 needs append-only, branch-keyed entries under install membership.
- Topics (§7.2.2): `conversation:<branch>` carries only shared entries, identical for every subscriber. `view:<member>:<branch>` carries that member's view state (scroll anchor, card view, `last_seen_seq`, toast hiding, `timeline_visible_until`) and their private entries; only that member can subscribe.
- Entries are append-only: no route deletes or edits one (§14.5.1).
- Private entries (`audience_member_id`, §14.5.1): a Confirm card and a Draft card until its author commits it. The commit clears the audience in the transaction that creates the TODO (T-APP-02 calls it). Unsent composer text never leaves the browser.
- `POST /api/conversations/{b}/prompt` inserts one `queued` `agent_turns` row holding the prompt text and `author_actor`. The shared prompt entry is appended when the turn starts (T-APP-23), so a queued prompt stays editable by its author without breaking append-only entries (§14.5.1, §15.1.1); until then it shows only in its author's queue on `view:<member>:<branch>`. T-APP-23 runs the turn; until its cutover, only tests call this route.
- The audience filter (§15.1.2a) as one store query, `SharedEntries(conversation)`: entries with `audience_member_id IS NULL`. Every read a turn makes uses it (T-APP-23, T-APP-17).
- The branch tree: a branch, its fork parent and its children, with `main` at the root opening on the Home card. T-APP-23 makes `/branches` open it; T-APP-10 adds presence to its nodes in S2.
- Earlier (§14.1.5): each legacy per-member conversation, from the browser store (`apps/app/src/mainview/state/AppStore.ts`, OPFS or localStorage) and from the server journal (`GET /api/agent/conversations` and `/replay`, `packages/backend/internal/chat/http.go`), opens read-only for its member only. Its cards decode through T-APP-22's decoder. Nothing is migrated into a shared conversation.

Out:
- Shell cutover, live person-to-person messaging, replaying legacy tool calls, executing archived custom views or repository modules, and migrating legacy entries into shared storage. Earlier renders data and read-only retained cards or tombstones.
- Host turns, the turn credential, turn revocation, UI-only instructions and the shell switch (T-APP-23).
- Summaries, tone and the timeline (T-APP-07); preflight (T-APP-17).
- Person-to-person messages, which never exist (M-08).

## Changes
- Lock the conversation row in the append transaction, allocate seq from its transactional counter and enforce UNIQUE(conversation_id, seq). Advance the counter only with committed entries and projection rows; branch/conversation creation shares its caller transaction. GET, snapshots and live subscriptions authorize the conversation and filter private entries and queued prompts to their audience member. Foreign view-state reads/writes and snapshots are refused; SharedEntries excludes every private entry, including the reader’s own. Check: C-APP-04.

- `packages/backend/db/product/migrations/<next>_conversations.sql` (new): the four §3 tables; queries in `packages/backend/db/product/queries/conversations.sql` (new); `sqlc generate`.
- `packages/backend/internal/services/conversations.go` (new): create a conversation with its branch; append entries with a per-conversation `seq`; `SharedEntries`; the view-state upsert; the queued `agent_turns` row for a prompt, and the append of its prompt entry when the turn starts. Each write publishes `conversation:<branch>` or `view:<member>:<branch>` through `Publish` in the same transaction (§3.1).
- `packages/backend/internal/routes/conversations.go` (new): `GET /api/conversations/{b}`, `POST …/prompt` and `PUT …/view-state` (§6.3), and the subscription rule that only a member subscribes to their own `view:` topic; rows in `docs/api/openapi/conversations.yaml` (new); regenerate the API clients.
- `packages/rpc/src/topics/Conversation.ts` and `topics/ViewState.ts` (new): the decoders, with entries carrying `author_actor`. Goldens `packages/rpc/test/fixtures/topics/conversation.json` and `view-state.json` (new), compared by `conversations_golden_test.go` (new).
- `apps/app/src/mainview/cards/containers/entryModel.ts` (new): `toEntryRow(entry, viewer)` for T-UI-07's entry row: the author through `toActor` (T-APP-09), title, card reference and private mark. A tombstone gives a title-only row with no action (card-kinds.md L2). T-APP-07 adds summary, tone, state and action; T-APP-02 adds Make TODO and Save to wiki on answers; T-APP-17 adds the Context line.
- `apps/app/src/mainview/cards/containers/ConversationContainer.tsx`, `BranchTreeContainer.tsx` and `EarlierContainer.tsx` (new): subscribe and map; `onView` patches go to `PUT …/view-state`. T-APP-23 mounts them in `App.tsx` at the cutover.

## Tests
- Drive concurrent appends and branch creation through production routes with real PostgreSQL. Inject failure after entry allocation, after projection insert and during branch creation; assert no orphan entry, projection or conversation, and no consumed committed sequence. Alice’s authenticated GET and snapshot omit Ben’s private entries and queued prompts. Foreign view-state GET/PUT/snapshot/subscription refuse without data disclosure. Check: C-APP-04.

- Boundary (C-APP-04, `routes/conversations_test.go`): mount the production authenticated router and `/api/live` with real PostgreSQL. Exercise `GET /api/conversations/{b}`, `POST …/prompt`, `PUT …/view-state`, private-topic subscription refusals and legacy history/replay through their served routes; do not call handlers or `SharedEntries` directly as the acceptance boundary. Service tests remain supplemental for append concurrency. Create branches through the production fork/TODO commands and assert conversation creation commits or rolls back with them. Earlier uses the real history/replay client in the boundary test, with checked-in legacy records and literal expected entry lists. No oracle reads spec files or computes expected rows with the store builder/decoder.
- Integration (real PostgreSQL, `conversations_db_test.go`): two members' concurrent appends on one branch give one ordered entry list with a gap-free `seq`; each prompt inserts one `queued` `agent_turns` row and no shared entry, and shows only on its author's `view:` topic; `DELETE` and `PATCH` on an entry answer 405.
- Integration: Alice's subscription to `view:<ben>:<branch>` is refused; a private entry is published only on its member's topics, never on `conversation:<branch>`; `SharedEntries` omits every private entry, the reader's own included.
- Integration: view state round-trips per member; Alice's maximize leaves Ben's state unchanged.
- Integration: a branch created by a fork or by a TODO has its conversation row in the same transaction; the goldens equal the builders' output.
- Unit (`entryModel.test.ts`): author, title and card reference for prompt, answer, card and event entries; a tombstone gives a title-only row with no action.
- Unit (`EarlierContainer.test.tsx`, a seeded browser store and a fake journal): each legacy conversation lists for its member only, read-only, with every entry decoded.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-APP-04](../checks/C-APP-04.md): ordered, append-only shared entries; private entries only on their member's topics and never in `SharedEntries`; view state per member; Earlier readable for its member only. C-UI-06, the shared conversation end to end, moves to T-APP-23.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- The storage decision above replaces the one-day evaluation this ticket used to carry. `AppTimelineService` and its routes stay as they are; nothing in this ticket writes to them.
- Risk: a large legacy conversation stalls Earlier on open. Load it in pages of 200 entries; confirmed if the C-CUT-02 archive takes longer to open than the newest shared conversation.

## Ready checklist
1. Runtime preconditions: T-COL-02 supplies live transport, projection writes and authorization through its prerequisites; T-ACC-02 supplies membership; T-APP-09 supplies `toActor`; T-UI-07, T-APP-19 and T-APP-22 supply Views, schemas/action wiring and legacy decoding. The prompt route stays test-only until T-APP-23 cuts over.
2. Exclusions: Out names host turns, cutover, preflight, summaries, messaging, legacy migration and replay execution; Earlier is read-only data.
3. Boundary tests: C-APP-04 mounts the authenticated production router and live server, uses real history/replay clients and PostgreSQL, and creates branches through real commands. Literal shared/private and legacy fixture expectations supplement store-level tests.
4. Decisions: smithers-3f accepts the branch-keyed storage choice, transaction/API contract and table reservations (§21.3); smithers-38 signs off topic-decoder subpaths and compatibility under §21.1; smithers-06 accepts shell/entry props; smithers-b8 accepts Container and Earlier client wiring. smithers-8a resolves cross-owner seams; Will approves product changes.
5. Before start: smithers-3f: are seq allocation, branch creation and projection writes atomic, and private reads authorized? smithers-38: do goldens and legacy fixtures cover the public decoder contract? smithers-06: do entry/tree/Earlier props preserve the agreed View seam? smithers-b8: can Earlier read both stores without tool replay or cross-member leakage? smithers-3f: answered, BLOCKING edits applied (tech lead adopts). smithers-b8: answered 18:23, ok. smithers-06: answered 18:3x, ok. Design condition: "ok. Tombstones and Earlier follow my tier-1 T-UI-07 answer."
6. Security: storage, decoding and Earlier treat repository/legacy content as data and execute no repository code; no archived tool or repository custom view is invoked. smithers-3f reviews authenticated routes and private-topic isolation; smithers-b8 reviews archive rendering before start. C-APP-04 proves member isolation and read-only archives; repository execution remains machine-only (§1.3, M-29).

# C-APP-04 Shared conversation storage: ordered, append-only, private entries private, view state per member, Earlier readable

Proves: mvp.md M-08, §6.4 Branch conversations · spec.md §3, §7.2.2, §14.1, §14.1.5, §14.5.1, §15.1.2a · Layer: integration · Stage: S1 · Tickets: T-APP-16
Automation: `packages/backend/internal/services/conversations_db_test.go` (new), `packages/backend/internal/routes/conversations_test.go` (new) and `apps/app/src/mainview/cards/containers/EarlierContainer.test.tsx` (new) · Runs in: CI

## Setup
- Check in conversation/view-state topic goldens and legacy journal page/replay JSON fixtures under `packages/rpc/test/fixtures/` via T-APP-19b (#3601). Root `PACKAGE.ts` backend test inputs declare `//packages/rpc/test/fixtures/topics/*.json`.

- Real PostgreSQL with the product migrations; members Ben and Alice; branches `main` and `smithers/t1`; the live-channel server (T-COL-02) with one subscribed client per member.
- For Earlier: a seeded browser store holding two legacy conversations of Ben's, and a journal behind `GET /api/agent/conversations` holding one more.

- Mount the production authenticated conversation router, live server and legacy history/replay routes. Expected entry lists, private canaries and golden bytes are checked-in fixtures; no oracle reads spec files or computes expectations using production builders or decoders.

## Steps
- Adopted T-APP-16 boundary cases: Drive concurrent appends and branch creation through production routes with real PostgreSQL. Inject failure after entry allocation, after projection insert and during branch creation; assert no orphan entry, projection or conversation, and no consumed committed sequence. Alice’s authenticated GET and snapshot omit Ben’s private entries and queued prompts. Foreign view-state GET/PUT/snapshot/subscription refuse without data disclosure

1. Ben and Alice append 20 entries each to `smithers/t1` concurrently through the conversation service, and each posts one prompt.
2. Post a private Draft entry for Alice and a private Confirm entry for Ben, then commit Alice's Draft.
3. Alice subscribes to `view:<ben>:smithers/t1`; Ben subscribes to his own.
4. Send `DELETE` and `PATCH` for an entry.
5. Ben and Alice write different view states; each reads theirs back.
6. Read `SharedEntries` for the conversation.
7. Open Earlier as Ben, then as Alice.

8. Create a branch through each production fork/TODO command, including a rolled-back creation. Assert its conversation commits or rolls back with the branch. Exercise prompt and view-state mutations through their HTTP routes and Earlier through the real history/replay client; direct service tests supplement these boundary cases.

## Pass when
- Each topic golden parses with its actual RPC `topics/*` `z.object` decoder, and the same goldens pass the Go builder comparison. Both topics import the single ConversationEntry wire schema. `AgentConversationPageSchema` and `AgentConversationReplaySchema` parse the checked-in legacy journal fixtures; Earlier’s production history/replay client opens those same records and matches literal expected entries. Golden changes invalidate the backend test target through declared inputs.

- Lock the conversation row in the append transaction, allocate seq from its transactional counter and enforce UNIQUE(conversation_id, seq). Advance the counter only with committed entries and projection rows; branch/conversation creation shares its caller transaction. GET, snapshots and live subscriptions authorize the conversation and filter private entries and queued prompts to their audience member. Foreign view-state reads/writes and snapshots are refused; SharedEntries excludes every private entry, including the reader’s own

- Step 1: one entry list with a gap-free `seq`, identical on both subscribers; two `queued` `agent_turns` rows holding their prompt text, with no shared entry yet, each shown only on its author's `view:` topic.
- Step 2: each private entry is published only on its member's `view:` topic; after the commit, Alice's Draft appears once on `conversation:smithers/t1`, already committed.
- Step 3: Alice is refused; Ben receives his state.
- Step 4: both answer 405 and change nothing.
- Step 5: each member reads only their own state.
- Step 6: no private entry is returned, Ben's own included.
- Step 7: Ben sees three read-only archives with every entry decoded; Alice sees none.
- The golden tests for `conversation:<branch>` and `view:<member>:<branch>` pass.

## Fail when
- Two subscribers see different orders, or an entry is lost under concurrency.
- A private entry reaches a shared topic or `SharedEntries`.
- An entry can be deleted or edited.
- A legacy conversation fails to open, opens for another member, or accepts a prompt.

## Evidence
`.artifacts/checks/C-APP-04/<UTC timestamp>/`: `go test -json` and `bun test` output, the topic frame log per subscriber, the commit.

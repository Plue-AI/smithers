# C-APP-05 Host-turn cutover: the browser runs no tool, legacy turn writes are gone, legacy conversations stay readable

Proves: spec.md §14.1.5, §15.1.3–15.1.4a · AGENTS.md "Zero tech debt; one backend", "Old sessions and recorded events must remain readable" · Layer: integration · Stage: S1 · Tickets: T-APP-23
Automation: `packages/backend/internal/chat/cutover_integration_test.go` (new) and `apps/app/src/mainview/Architecture.test.ts` (existing) · Runs in: CI

## Setup
- Real PostgreSQL holding the previous build's data, including Ben's legacy server conversations (journal rows); the backend and model host built at the cutover commit; members Ben and Alice.
- A fake model that, in one turn, calls `todo.stop T2`, `todo.drop T2` and `/theme dark`.

## Steps
- Sweep symbol imports and `/api/agent/turn` and `/api/chat/` literals. Run recording prompt/stop fixtures for launch-seam-probe and all launch-checklist callers; inspect the command registry and retained Earlier clients.

- Adopted T-APP-23 boundary cases: Run two independent production dispatchers against two queued turns in one conversation with barriers; at most one launches. Inject mint-success/launch-failure, shutdown and crashes after mint and after lease acquisition. Restart and inspect revocation/lease cleanup before the next turn starts; every old credential is refused and no lease survives. Assert cleanup on success, failure and cancellation as well

1. Start the cutover build on that database.
2. Ben posts a prompt to `main`; the fake model makes its three calls.
3. Send the previous build’s requests: `POST /api/agent/turn`, `/api/agent/turn/cancel`, `/api/agent/turn/retire`, `/api/chat/turn` and `/api/chat/cancel`.
4. Read Ben's legacy conversations through `GET /api/agent/conversations` and `/api/agent/conversations/replay`.
5. Ben queues two prompts behind a running turn and edits the second. Alice tries to edit it and to remove it.
6. Run the architecture test.

## Pass when
- `TURN_PATH`, `CANCEL_PATH`, `TURN_RETIRE_PATH`, `CHAT_TURN_PATH`, `CHAT_CANCEL_PATH` and `chat.queue.resume` are absent. `TURN_REPLAY_PATH`, `CONVERSATIONS_PATH`, `CONVERSATION_REPLAY_PATH` and `TURN_ERASE_PATH` remain. Migrated probes invoke only the shared prompt/stop write routes; Earlier remains readable and never starts a turn. Confirm dispatch reports literal `state: "pending"`.

- Acquire a conversation-level database lock before claiming a queued turn; enforce a partial unique index permitting at most one running turn per conversation. Claim, persisted credential identity and model-host lease ownership are durable. Mint-success/launch-failure, shutdown and crash recovery revoke the credential and release the lease. Recovery reconciles and revokes every prior owned credential/lease before admitting the next turn; a row lock on one queued turn is insufficient

- Step 2: the host executes all three calls with Ben's delegated credential (the request log shows `Smithers-Via: smithers`); T2 pauses; a one-click Confirm card for the drop is posted to Ben; the theme instruction is published only on `view:<ben>:main`; no browser request carries a command call for this turn.
- Step 3: each answers 404 and writes nothing.
- Step 4: every legacy conversation reads in full, with removed card kinds as tombstones (C-CUT-02).
- Step 5: the edited text runs; Alice gets 403 `permission` for both requests.
- Step 6: no module under `apps/app/src/mainview` executes a non-UI-only command for an agent turn, and none imports the deleted turn client.

## Fail when
- A tool call runs in a browser, or a browser receives the turn credential.
- A legacy write route still accepts a request, or a legacy read route is gone.
- A legacy conversation loses an entry.

## Evidence
`.artifacts/checks/C-APP-05/<UTC timestamp>/`: `go test -json` output, the request log for step 2, the step 3 responses, the replay output, the architecture test output, the commit.

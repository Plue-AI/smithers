# C-UI-05 Honest state on the live channel

Proves: mvp.md §2 rule 5, §9 Honesty · spec.md §3.1–3.2, §4.1, §6.2.1–6.2.2, §7.1.2, §7.2, §7.6 (row 1), §14.4, §19.3; AGENTS.md "Instant chat; slow work runs in the background" · Layer: integration+e2e · Stage: S1 · Tickets: T-COL-02, T-APP-08, T-STK-01, T-COL-10
Automation: `packages/backend/internal/live/honest_state_integration_test.go` (new) and `apps/app/e2e/real/honest-state.spec.ts` (new) · Runs in: CI (integration, real PostgreSQL) and reference host (e2e)

## Setup

- Integration: real PostgreSQL, the host service with a test hook that pauses any handler at a named point, and a fake flow runtime that emits run events on command.
- e2e:
  - a fresh install at the commit under test, scratch repository `smithers-mvp-canary/<date>`, Ben (owner) signed in at the install's origin;
  - `parallel` = 1 and capacity lowered to 1 in Settings (§8.2.1), with one TODO already `working` so the next one queues;
  - the backend hold hook available (test builds only).

## Steps

1. Integration: drive a TODO through queued → starting → working → needs_you → working → in_review. Record every delta on `todo:<n>` and `home`, and every `todo_events` row.
2. Integration: fail a transition after its row update and before commit.
3. e2e: Ben sends `/todo.new` with the backend hold on the create handler. While it is held, he sends a chat message.
4. e2e: release the hold. The TODO queues behind the working one.
5. e2e: Ben reloads the tab while the TODO is queued, then lets it run until it fails (the fake model returns an error).
6. e2e: Ben submits the same `/todo.retry Tn` twice within 100 ms. The two submissions carry the same `Idempotency-Key`.
7. e2e: block Ben's live socket for 10 s while the TODO moves through two states. Then unblock it.
8. Integration (T-COL-10 contract): two writes to one branch file carry the same `base_digest`, and the app's write door renders the second response.

## Pass when

- Every delta's state has a committed `todo_events` row with that `to_state`. Delta order equals event `seq` order. Step 2 emits no delta.
- During the hold (step 3):
  - the toast and card show only "requested", never "queued" or "working";
  - the chat message sends and gets its answer while the launch is still held;
  - the toast appears no sooner than 300 ms after the command (the shared debounce).
- After step 4, the card shows "waiting for a machine #1" (§4.1.1) until admission. It shows "starting" only after the `starting` event exists, and "working" only after the `working` event exists.
- After the reload in step 5, the toast reconnects and shows the current state from the snapshot. It settles to failed with **Retry** only after the `failed` event.
- Step 6 creates one attempt, and the second response returns the first result (§6.2.1).
- After step 7, the client resubscribes with its cursors and receives both missed deltas once, in order, with no `gap`. The card ends on the final state without showing a state out of order.
- In step 8, the second write returns `409 stale` (§7.6 row 1). The caller shows it as refused and reloads the file, and never shows it as saved.

## Fail when

- A card or toast shows "working", "done" or "merged" before the corresponding event row exists. For example, an HTTP 202 is rendered as started, or a toast settles on transport success.
- The chat composer is disabled, or the message waits, while a launch is pending.
- After reload, the toast is gone or shows a terminal state the projection never sent.
- A duplicate retry starts two attempts.
- A stale write shows "Saved", or is applied.
- A delta is lost or applied twice across the reconnect, or a stale response from the pre-reload socket changes the card.

## Evidence

`.artifacts/checks/C-UI-05/<UTC timestamp>/`: the integration test log with the delta/event pairing table, Ben's video and Playwright trace, the deltas captured from his socket (`deltas.jsonl`) and the `todo_events` export for the TODO, and `env.json` (commit, install version).

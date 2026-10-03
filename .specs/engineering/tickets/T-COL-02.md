# T-COL-02 Live channel `/api/live`: topics, cursors, backpressure

Stage S1 · Size M · Depends on T-STK-01, T-ACC-03, T-INS-04, T-FLW-01 · Unblocks T-AGT-02, T-APP-01, T-APP-04, T-APP-06, T-APP-07, T-APP-16, T-COL-06, T-COL-08b, T-FLW-03, T-FLW-04, T-FLW-07, T-FLW-08, T-GH-07, T-MCH-08, T-REL-02 · Issue: [#3506](https://github.com/smithersai/smithers/issues/3506)
Spec: spec.md §3 (source durable cursors), §3.1, §3.3, §5.6, §6.2.2, §7.1, §7.2, §7.6, §14.1, §14.5.1, §16.3.2–16.3.3, §19.3, §20.3 · Delta: delta.md §4 (live channel row), §9 (seams row) · Product: mvp.md §2 rule 5, §9 Honesty, J4, M-08, M-28

## Goal

A browser tab opens one WebSocket to `/api/live` on the page's origin (`ws://` on a plain-HTTP origin, `wss://` behind HTTPS, §16.3.2), subscribes to projection topics with cursors, and receives every committed card change as a snapshot and then as gap-free deltas within 1 s p95.

## Scope

- Keep Live subpath exports without a barrel. Define frames as z.discriminatedUnion("t") via the existing RPC schema. Add packages/rpc/test/fixtures/Live.ts and decode tests over every frame, following the committed old-record convention in Cards.test.ts. Reserved presence and binary kinds decode to err unsupported. Check: C-COL-02.

In:
- Lands before T-ACC-04 (tech lead 2026-10-02, edge cut): Live transport uses ACC-03's trusted credential decision; before ACC-04's stored-kind classifier is installed, reject every bearer upgrade before subscription/snapshot/frames. Do not interpret existing PATs as sessions. Cookie transport can activate only with INS-04 origin checks and the real active-member/revocation provider; if that provider is absent, refuse the whole upgrade with a typed unavailable response. ACC-02's revocation integration is an explicit activation gate, since removing ACC-04 also removes its transitive ACC-02 edge. ACC-04 later qualifies production bearer login → live subscribe → revoke.; its integration test with T-ACC-04 runs after T-ACC-04 lands and gates C-COL-02, C-ACC-01 and C-UI-05 (S1 authenticated live/revocation exit).
- Endpoint with subprotocol `smithers.live.v1`, authenticated by the session cookie or a bearer token. Apply T-INS-04’s effective-origin rules (§16.3.3): unknown request hosts get 421, cookie upgrades require Origin equal to the effective origin, and cookie-free bearer upgrades need no Origin. Settings changes apply without a restart.
- Text frames `sub`, `unsub`, `snap`, `delta`, `gap` and `err` (§7.1). `err` refuses one subscription with `unknown_topic`, `forbidden` or `unsupported`, and the socket stays open.
- Per-topic cursors. Reconnect with jitter from 250 ms to 5 s and resubscribe with the last cursors (§7.1.2).
- Reuse each source’s durable cursor and existing broker; publish after the source transaction commits.
- Retention: 24 h or 10,000 rows per topic, whichever is larger. An older cursor gets a fresh `snap` (§3.3).
- A topic registry. Each topic declares a snapshot builder and an authorization rule, enforced through the one authorizer (§5.2.1).
- Shared and member topics (§7.2.2). One `(topic, seq)` stream serves every subscriber, so `NOTIFY` fan-out needs no member filter:
  - shared topics (`home`, `todo:<n>`, `branch:<id>` with `:activity` and `:files`, `run:<id>`, `conversation:<branch>` and the card topics) carry only shared state, identical for every subscriber;
  - member topics are named with the member id and refuse every other subscriber with `forbidden`: `confirmations:<member>` (pending confirmations) and `view:<member>:<branch>` (view state, `last_seen_seq`);
  - Confirm cards publish on `confirmations:<member>`; uncommitted Drafts remain browser-local. Neither enters shared conversation output.
- The base `run:<id>` topic (§7.2): run summary and steps, projected from runtime events (§11.6.1). It ships in S1 so Inspect and the monitor (T-FLW-07) build on it.
- Backpressure: a 2 MiB send budget per connection. On overflow, projection subscriptions receive `gap` (§7.1.1).
- Revocation closes the member's sockets within 5 s (§5.6).
- A connection count in the in-process metrics (§20.3).
- Stage-3 contract (§7.6 row 2, ADR 0003 from T-COL-10), reserved now:
  - Topic names `doc:code:<branch>:<path>` and `doc:wiki:<page>`.
  - Binary frame kinds 1 (yjs-sync) and 2 (yjs-awareness). Terminals retain their WebSocket.
  - The `presence` text frame (S2).
  - The S1 server parses these and answers `{"t":"err","id":…,"code":"unsupported"}` (§7.1, T-COL-10). The connection stays open, and nothing is ignored silently.

Out:
- A barrel export, replacement fixture history and RPC implementation outside the existing RPC schema are excluded.
- Presence (T-COL-06), terminal frames (T-TRM-01), Yjs relay and documents (T-COL-08, T-COL-09).
- Move app seams in this change. Delete each SSE route only after its last consumer moves, S2 at the earliest.
- Card Views, document authority placement, repository-code execution and new public flow-library abstractions.
- Each topic's projection rows and snapshot model (§7.2 lists them). Each owning ticket registers its builder: `home` T-COL-02, `todo:<n>` T-STK-01, `conversation:<branch>` and `view:<member>:<branch>` T-APP-16, `confirmations:<member>` T-APP-04, timeline fields T-APP-07. T-FLW-07 extends `run:<id>` with cost, waits since and the raw journal.
- Client derivations from shared rows plus the member's own `last_seen_seq` and role: `merged_since_last_look` and the Home card's `attention[]` (T-APP-01).

## Changes
- Absorb T-COL-02: move each seam to the live adapter and delete its replaced consumer in the same change. Retain an SSE route until its last consumer, including other compositions, has moved; S2 at the earliest. Check: C-UI-05.

- Keep Live subpath exports without a barrel. Define frames as z.discriminatedUnion("t") via the existing RPC schema. Add packages/rpc/test/fixtures/Live.ts and decode tests over every frame, following the committed old-record convention in Cards.test.ts. Reserved presence and binary kinds decode to err unsupported. Check: C-COL-02.

- Add `routes/live.go` and its frame codec only: share the origin/auth prefix of workspace socket preflight, without its workspace-session lookup; map sub/unsub to `sse.Broker.Subscribe` and reconnect cursors to the replay/snapshot behavior of `DurableStream.OnConnect`, adapted to WebSocket frames. Reuse source snapshots, retention and authorization; no parallel hub, registry, writer or cursor table.
- `packages/backend/internal/compose/router.go`: mount `GET /api/live` outside the JSON timeout group, beside the terminal WebSocket (`router.go:789`).
- `docs/api/openapi/live.yaml` (new) describes the upgrade route and the frames. `packages/backend/internal/compose/openapi_conformance_test.go` covers it (§6.2.4).
- `packages/rpc/src/Live.ts` (new): frame schemas shared by the app and the CLI.
- `apps/app/src/mainview/runtime/LiveChannel.ts` (existing): one socket per tab, cursor store, backoff, resubscribe, `gap` → resubscribe without a cursor.
- `packages/backend/docs/live-channel.md` (new). Run `pnpm docs:sync` and `pnpm docs:check`, then `smthrs docs //packages/backend:docs`.

## Tests

C-UI-05 (folded steps and assertions):
1. Integration: drive a TODO through queued → starting → working → needs_you → working → in_review. Record every delta on `todo:<n>` and `home`, and every `product_job_events` row.
2. Integration: fail a transition after its row update and before commit.
3. e2e: Ben sends `/todo.new` with the backend hold on the create handler. While it is held, he sends a chat message.
4. e2e: release the hold. The TODO queues behind the working one.
5. e2e: Ben reloads the tab while the TODO is queued, then lets it run until it fails (the fake model returns an error).
6. e2e: Ben submits the same `/todo.retry Tn` twice within 100 ms. The two submissions carry the same `Idempotency-Key`.
7. e2e: block Ben's live socket for 10 s while the TODO moves through two states. Then unblock it.
8. Integration (T-COL-10 contract): two writes to one branch file carry the same `base_digest`, and the app's write door renders the second response.
8a. Integration (T-COL-10): dispatch the real coding-agent read and each of write, edit and apply_patch through coding/edit-atom in a machine, with an outside fixture write between read and mutation. Observe the tool result and its displayed run event through the production path.

Pass when:
- T-COL-10 agent-write extension: apply_patch add, delete, update and move all use the guarded mutation boundary. A stale source or destination reports refused, never saved. A later stale hunk leaves every earlier hunk unchanged; no move source disappears and no destination is created.
- Every delta's state has a committed `product_job_events` row with that `to_state`. Delta order equals event `seq` order. Step 2 emits no delta.
- During the hold (step 3):
  - the toast and card show only "requested", never "queued" or "working";
  - the chat message sends and gets its answer while the launch is still held;
  - the toast appears no sooner than 300 ms after the command (the shared debounce).
- After step 4, the card shows "waiting for a machine #1" (§4.1.1) until admission. It shows "starting" only after the `starting` event exists, and "working" only after the `working` event exists.
- After the reload in step 5, the toast reconnects and shows the current state from the snapshot. It settles to failed with **Retry** only after the `failed` event.
- Step 6 creates one attempt, and the second response returns the first result (§6.2.1).
- After step 7, the client resubscribes with its cursors and receives both missed deltas once, in order, with no `gap`. The card ends on the final state without showing a state out of order.
- In step 8, the second write returns `409 stale` (§7.6 row 1). The caller shows it as refused and reloads the file, and never shows it as saved.
- Step 8a returns stale_read and leaves the outside fixture bytes unchanged; its run event displays refused and never saved. The oracle uses fixed fixture bytes and literal expected states, never spec files or production code at runtime.

Fail when:
- A card or toast shows "working", "done" or "merged" before the corresponding event row exists. For example, an HTTP 202 is rendered as started, or a toast settles on transport success.
- The chat composer is disabled, or the message waits, while a launch is pending.
- After reload, the toast is gone or shows a terminal state the projection never sent.
- A duplicate retry starts two attempts.
- A stale write shows "Saved", or is applied.
- A delta is lost or applied twice across the reconnect, or a stale response from the pre-reload socket changes the card.


- Decode every committed Live frame and old record. Assert discriminator t and reserved presence/binary kinds produce err unsupported with the socket left open. Preserve subpath exports and assert no barrel export. Check: C-COL-02.

- `LiveChannel.test.ts`: two Containers on the same and different topics share one socket. Send one `sub` per topic, send `unsub` only after its last subscriber leaves, and reconnect with one `sub` per topic and its stored cursor. Check: C-COL-02.

- unit (`packages/backend/internal/live/protocol_test.go`, new): every frame round-trips. Reserved topics, kinds 1–5 and `presence` get `err` `unsupported`, an unknown topic gets `unknown_topic`, and a refused topic gets `forbidden`, each with the socket left open. Malformed frames close the socket with a typed reason. The §7.6 row-2 assertion goes in `packages/backend/internal/compose/cocontracts_test.go` (T-COL-10).
- unit (`apps/app/src/mainview/runtime/LiveChannel.test.ts`, new, fake clock):
  - backoff stays within 250 ms to 5 s with jitter;
  - resubscribe carries the last cursors;
  - `gap` drops the cursor.
- integration, real PostgreSQL (`packages/backend/internal/live/hub_integration_test.go`, new):
  - A rolled-back transaction publishes nothing.
  - 50 concurrent writers on one topic yield gap-free seq in commit order.
  - Resume from cursor *c* returns exactly the rows after *c*.
  - A cursor past retention gets `snap`.
  - A slow consumer over 2 MiB gets `gap`, while a second subscriber on the same topic misses nothing.
- integration: two members on one `conversation:<branch>` receive byte-identical snapshots and deltas. Ben's subscription to `view:<alice>:<branch>` or `confirmations:<alice>` gets `err forbidden`, and Alice's private Draft entry reaches only `view:<alice>:<branch>`. A wrong Origin is refused, and an origin added in Settings is accepted without a restart. Removing a member closes their socket in ≤ 5 s.
- integration: a run's step start and finish reach a `run:<id>` subscriber in order, with no gap after a reconnect from the cursor.
- perf: C-PERF-02 on the reference host.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.


- [C-PERF-02](../checks/C-PERF-02.md): the committing transaction to the delta at a subscriber in < 1 s p95.
- [C-COL-02](../checks/C-COL-02.md): Live channel: a `gap` or reconnect resubscribes from the cursor with no duplicated or missing delta

## Risks and notes

- The topic row lock serializes writers on hot topics (`home`). Confirmed if p95 commit latency for a TODO transition exceeds 50 ms with 50 concurrent writers. Escalate to the tech lead before sharding topics.
- `NOTIFY` payloads cap at 8,000 bytes, so the notification carries only the topic and the hub reads rows. Confirmed broken if any test publishes payload bytes through `NOTIFY`.
- An HTTPS proxy the team puts in front (§16.3.4) must pass WebSocket upgrades. Falsified by C-INS-01's run behind an HTTPS proxy. No code depends on any particular proxy.
- The reserved topics and frame kinds must match ADR 0003 (T-COL-10). Do not change them without it.

## Ready checklist

1. Dependencies cover the projection writer, authorizer, live origin settings, approved ADR 0003 and base runtime events. Card owners register their builders when their own tickets land; transport does not wait for all cards. Landing condition for the T-ACC-04 edge cut: Live transport uses ACC-03's trusted credential decision; before ACC-04's stored-kind classifier is installed, reject every bearer upgrade before subscription/snapshot/frames. Do not interpret existing PATs as sessions. Cookie transport can activate only with INS-04 origin checks and the real active-member/revocation provider; if that provider is absent, refuse the whole upgrade with a typed unavailable response. ACC-02's revocation integration is an explicit activation gate, since removing ACC-04 also removes its transitive ACC-02 edge. ACC-04 later qualifies production bearer login → live subscribe → revoke.; its integration test with T-ACC-04 runs after T-ACC-04 lands and gates C-COL-02, C-ACC-01 and C-UI-05 (S1 authenticated live/revocation exit).
2. Out names presence/terminals/documents, SSE migration, card models, Views, authority placement and repository execution.
3. C-COL-02, C-UI-05 and C-PERF-02 connect through `GET /api/live` mounted by `compose/router.go`, with real PostgreSQL and the production LiveChannel client. Add `packages/backend/internal/compose/live_integration_test.go` (new) cases for unsupported frames, private topics, Origin, bearer auth and removal. Expected statuses, graphs, timings and outputs are literal test fixtures or independent input logs. No test reads spec files or computes expectations from production code at runtime.
4. smithers-8a accepts ADR 0003 and decides topic sharding. smithers-3f approves the transport/authorization seam; smithers-b8 approves the client seam; smithers-38 signs off `@smthrs/rpc/Live` under §21.1.
5. Before start, smithers-3f: is there one projection writer; do origin, topic authorization and revocation pass through real middleware? smithers-b8: does one tab keep one socket and resubscribe correctly? smithers-38: do per-module frame exports preserve decoding compatibility? Views are excluded; any View change needs smithers-06 pre-review. smithers-3f: answered 18:2x, ok. smithers-b8: answered, BLOCKING edits applied (tech lead adopts). smithers-06: answered 18:3x, ok. Design condition: "ok. I review line flags and spans in its first visual pass." smithers-38: answered, changes applied (tech lead adopts).
6. This transport executes no repository code. Snapshot builders are packaged host code; frames cannot launch processes or import repository modules. smithers-3f reviews this boundary and private-topic authorization; the route cases and C-UI-05 verify it.

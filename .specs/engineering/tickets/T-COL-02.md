# T-COL-02 Live channel `/api/live`: topics, cursors, backpressure

Stage S1 · Size M · Depends on T-STK-01, T-ACC-03, T-INS-04, T-FLW-01 · Unblocks T-AGT-02, T-APP-01, T-APP-04, T-APP-06, T-APP-07, T-APP-11, T-APP-12, T-APP-13, T-APP-14a, T-APP-16, T-COL-03, T-COL-04, T-COL-05, T-COL-06, T-COL-08b, T-FLW-03, T-FLW-04, T-FLW-07, T-FLW-08, T-GH-07, T-MCH-08, T-REL-02 · Issue: [#3506](https://github.com/smithersai/smithers/issues/3506)
Spec: spec.md §3 (source durable cursors), §3.1, §5.6, §6.2.2, §7.1, §7.2, §7.6, §14.1, §14.5.1, §16.3.2–16.3.3, §19.3, §20.3 · Delta: delta.md §4 (live channel row), §9 (seams row) · Product: mvp.md §2 rule 5, §9 Honesty, J4, M-08, M-28
Ready: 2026-10-03 smithers-8a sha256:80b92a9630c9

## Goal

A browser tab opens one WebSocket to `/api/live` on the page's origin (`ws://` on a plain-HTTP origin, `wss://` behind HTTPS, §16.3.2), subscribes to projection topics with cursors, and receives every committed card change as a snapshot and then as gap-free deltas within 1 s p95.

## Scope

- Keep Live subpath exports without a barrel. Define frames as z.discriminatedUnion("t") via the existing RPC schema. Add packages/rpc/test/fixtures/Live.ts and decode tests over every frame, following the committed old-record convention in Cards.test.ts. Reserved presence and binary kinds decode to err unsupported. Check: C-COL-02.

In:
- Build against the declared contracts; unavailable dependencies do not block Ready. Lands dark until T-ACC-03: refuse the upgrade with HTTP 503, class `infra`, code `live_unavailable`, before subscriptions, snapshots or frames if the trusted credential decision or topic authorizer is absent. Lands dark until T-INS-04: refuse the upgrade with the same envelope if effective-origin validation is absent. Lands dark until T-STK-01: leave `home` and `todo:<n>` subscriptions unavailable (`err unsupported`) until their committed source projection and replay providers exist. Lands dark until T-FLW-01: leave `run:<id>` unavailable (`err unsupported`) until its ordered runtime-event provider exists. Never substitute optimistic state or an empty successful snapshot. Check: C-COL-02 through the composed route.
- Lands dark until T-ACC-02: refuse upgrades with `503 infra/live_unavailable` unless the real active-member and revocation provider is installed. Lands dark until T-ACC-04: reject every bearer upgrade with `401 permission/unauthenticated` before subscriptions, snapshots or frames; never treat an existing PAT as a session. These are activation gates, not code dependencies. Production bearer login → live subscribe → revoke runs after T-ACC-04 lands and gates authenticated S1 exit in C-COL-02 and C-UI-05.
- Endpoint with subprotocol `smithers.live.v1`, authenticated by the session cookie or a bearer token. Apply T-INS-04’s effective-origin rules (§16.3.3): unknown request hosts get 421, cookie upgrades require Origin equal to the effective origin, and cookie-free bearer upgrades need no Origin. Settings changes apply without a restart.
- Text frames `sub`, `unsub`, `snap`, `delta`, `gap` and `err` (§7.1). `err` refuses one subscription with `unknown_topic`, `forbidden` or `unsupported`, and the socket stays open.
- Per-topic cursors. Reconnect with jitter from 250 ms to 5 s and resubscribe with the last cursors (§7.1.2).
- Reuse each source’s durable cursor and existing broker; publish after the source transaction commits.
- Reuse source retention and cursor validation. If the source can no longer replay a cursor, build a fresh `snap` from committed facts; never return partial replay. Do not add a per-topic retention store. Check: C-COL-02.
- Adapt existing source registrations with snapshot builders and authorization through the one authorizer (§5.2.1); do not add a parallel registry. Unavailable builders return `err unsupported`. Check: C-COL-02.
- Shared and member topics (§7.2.2). One `(topic, seq)` stream serves every subscriber, so `NOTIFY` fan-out needs no member filter:
  - shared topics (`home`, `todo:<n>`, `branch:<id>` with `:activity` and `:files`, `run:<id>`, `conversation:<branch>` and the card topics) carry only shared state, identical for every subscriber;
  - member topics are named with the member id and refuse every other subscriber with `forbidden`: `confirmations:<member>` (pending confirmations) and `view:<member>:<branch>` (view state, `last_seen_seq`);
  - Confirm cards publish on `confirmations:<member>`; uncommitted Drafts remain browser-local. Neither enters shared conversation output.
- The base `run:<id>` topic (§7.2): run summary and steps, projected from runtime events (§11.6.1). It ships in S1 so Inspect and the monitor (T-FLW-07) build on it.
- Backpressure: a 2 MiB send budget per connection. On overflow, projection subscriptions receive `gap` (§7.1.1).
- Revocation closes the member's sockets within 5 s (§5.6).
- A connection count in the in-process metrics (§20.3).
- Recognize unsupported `doc:` topics, binary kinds 1 and 2 and `presence` only to return `err unsupported` with the subscription id and keep the socket open. Do not implement their transport or codec contracts in S1; those belong to §7.6.2–7.6.3 at their first use. Check: C-COL-02.

Out:
- A barrel export, replacement fixture history and RPC implementation outside the existing RPC schema are excluded.
- Presence (T-COL-06), terminal frames (T-TRM-01), Yjs relay and documents (T-COL-08, T-COL-09).
- Business logic or View changes in app seams. Move only existing transport consumers to the Live adapter. Delete each replaced consumer at cutover; retain each SSE route until its last consumer moves, S2 at the earliest.
- Card Views, document authority placement, repository-code execution and new public flow-library abstractions.
- New projection tables and other tickets' snapshot models (§7.2 lists them). This ticket builds `home` from existing committed sources; each other owning ticket registers its builder: `todo:<n>` T-STK-01, `conversation:<branch>` and `view:<member>:<branch>` T-APP-16, `confirmations:<member>` T-APP-04, timeline fields T-APP-07. T-FLW-07 extends `run:<id>` with cost, waits since and the raw journal.
- Client derivations from shared rows plus the member's own `last_seen_seq` and role: `merged_since_last_look` and the Home card's `attention[]` (T-APP-01).

## Changes
- Reshape existing transport consumers to use the landed Live adapter; delete replaced consumer code in the same change. Keep each SSE route until its last consumer, including other compositions, has moved, S2 at the earliest. Check: C-UI-05.

- Keep Live subpath exports without a barrel. Define frames as z.discriminatedUnion("t") via the existing RPC schema. Add packages/rpc/test/fixtures/Live.ts and decode tests over every frame, following the committed old-record convention in Cards.test.ts. Reserved presence and binary kinds decode to err unsupported. Check: C-COL-02.

- Reshape `packages/backend/internal/sse/broker.go:296` (`Subscribe`), `sse/durable.go:50` (`OnConnect`) and source adapters in `routes/durable_streams.go` for WebSocket delivery. Add only `packages/backend/internal/routes/live.go` and its frame codec: existing handlers emit SSE and do not serve `/api/live`. Extract the origin/auth prefix of `routes/workspace_socket_preflight.go:47` without workspace-session lookup. Reuse source snapshots, replay, retention and authorization; no parallel hub, registry, writer, event table or cursor table.
- `packages/backend/internal/compose/router.go`: mount `GET /api/live` outside the JSON timeout group, beside the terminal WebSocket (`router.go:796–828`).
- `docs/api/openapi/live.yaml` (new) describes the upgrade route and the frames. `packages/backend/internal/compose/openapi_conformance_test.go` covers it (§6.2.4).
- `packages/rpc/src/Live.ts` (new): the existing RPC modules lack Live frame schemas; put the one shared app/CLI contract here, using the existing wildcard subpath exports. No barrel or second client-local schema.
- Reshape `apps/app/src/mainview/runtime/LiveChannel.ts:28–30` and its existing test: remove the unread TanStack collection and its writes, deletes and cleanup; retain the topic map, listeners, singleton, cursors, backoff, resubscribe and `gap` handling. Decode frames through `@smthrs/rpc/Live`; do not rebuild the client.
- Extend existing `packages/backend/docs/live-streams.md` with `/api/live`; do not create a second inventory. Keep route behavior assertions in literal fixtures, independent of the Markdown inventory. Run `pnpm docs:sync` and `pnpm docs:check`, then `smthrs docs //packages/backend:docs`.

## Tests

C-UI-05 (folded steps and assertions): drive `/todo.new` and `/todo.retry` through the production command dispatcher and observe the composed `GET /api/live` route with the production LiveChannel client. Integration transition and rollback cases exercise the production transition service, not direct SQL state changes. Literal fixtures and independently recorded committed source events supply expected states, bytes and cursor order; no test derives expectations from spec files or production helpers at runtime. Full journey cases enable only after their command, card and machine providers land; they do not add transport dependencies.
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

- Codec unit coverage in `packages/backend/internal/routes/live_test.go` (new; no existing Live codec): every S1 frame round-trips against literal fixtures. Repeat unsupported `doc:` topics, binary kinds 1 and 2, `presence`, unknown and forbidden topics over the composed production upgrade route; each refusal leaves the socket open. Malformed frames close it with a typed reason. S2/S3 contracts are tested by their first consumers (§7.6.2–7.6.3), not a new S1 co-editing suite.
- unit (`apps/app/src/mainview/runtime/LiveChannel.test.ts`, existing, extend its fake-clock harness):
  - backoff stays within 250 ms to 5 s with jitter;
  - resubscribe carries the last cursors;
  - `gap` drops the cursor.
- Integration, real PostgreSQL: extend `packages/backend/internal/compose/live_streams_integration_test.go` and `live_streams_resilience_integration_test.go` to connect through the install router's production `GET /api/live` upgrade. Do not create a hub. Include C-COL-02 fault cases and:
  - A rolled-back transaction publishes nothing.
  - 50 concurrent writers on one topic deliver every committed source event once in source-cursor order; numeric cursor gaps do not imply missing events.
  - Resume from cursor *c* returns exactly the rows after *c*.
  - A cursor past retention gets `snap`.
  - A slow consumer over 2 MiB gets `gap`, while a second subscriber on the same topic misses nothing.
- integration: two members on one `conversation:<branch>` receive byte-identical snapshots and deltas. Ben's subscription to `view:<alice>:<branch>` or `confirmations:<alice>` gets `err forbidden`, and Alice's uncommitted Draft never reaches any socket; only her persisted view state reaches `view:<alice>:<branch>`. A wrong Origin is refused, and an origin added in Settings is accepted without a restart. Removing a member closes their socket in ≤ 5 s.
- integration: a run's step start and finish reach a `run:<id>` subscriber in order, with no gap after a reconnect from the cursor.
- perf: C-PERF-02 on the reference host.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.


- [C-PERF-02](../checks/C-PERF-02.md): the committing transaction to the delta at a subscriber in < 1 s p95.
- [C-COL-02](../checks/C-COL-02.md): Live channel: a `gap` or reconnect resubscribes from the cursor with no duplicated or missing delta

## Risks and notes

- Source ordering barriers can serialize writers. If p95 TODO commit latency exceeds 50 ms with 50 concurrent writers, smithers-8a decides whether to change the source ordering scheme; do not introduce a topic-row writer or sharding in this adapter.
- `NOTIFY` payloads cap at 8,000 bytes; reuse broker wakeups and read durable source rows through the adapter, not a new hub. C-COL-02 verifies that missed wakeups recover from source replay.
- An HTTPS proxy the team puts in front (§16.3.4) must pass WebSocket upgrades. Falsified by C-INS-01's run behind an HTTPS proxy. No code depends on any particular proxy.
- smithers-3f approves replay-to-snapshot behavior and unsupported-frame handling; smithers-b8 approves OpenAPI and client cutover; smithers-38 approves the Live subpath API under §21.1. Will decides any product-policy exception. S2/S3 wire decisions stay with their first consumers (§7.6.2–7.6.3).

## Ready checklist

1. Depends on remains T-STK-01 (TODO facts/projection), T-ACC-03 (trusted authorization), T-INS-04 (effective-origin guard), T-FLW-01 (runtime events). Scope names fail-closed behavior for all four contracts and the T-ACC-02/T-ACC-04 activation gates; missing implementations do not block Ready. No new table requires a reservation. Header and index agree.
2. Out names presence, terminals, documents, business/View changes, other owners' models, authority placement, repository execution, barrels and parallel stores. Only transport consumer cutover is in scope; SSE route deletion waits for the last consumer.
3. C-COL-02, C-UI-05 and C-PERF-02 connect through `GET /api/live` mounted by `compose/router.go`, with real PostgreSQL and the production LiveChannel client. Extend the existing composed stream integration/resilience suites for unsupported frames, private topics, Origin, bearer auth, removal and each absent-provider refusal in Scope. Expected statuses, graphs, timings and outputs are literal test fixtures or independent input logs. No test reads spec files or computes expectations from production code at runtime.
4. smithers-8a decides source-ordering changes and cross-owner seams; smithers-3f approves transport, replay fallback and authorization; smithers-b8 approves client cutover and OpenAPI; smithers-38 signs off `@smthrs/rpc/Live` under §21.1. Will decides product-policy exceptions. Later-stage wire decisions belong to their first consumers.
5. Owner pre-review questions; recorded answers below stand and owners review these amendments post hoc. smithers-3f: is there one projection writer; do origin, topic authorization and revocation pass through real middleware? smithers-b8: does one tab keep one socket and resubscribe correctly; does OpenAPI describe the real upgrade and its refusals? smithers-38: do per-module frame exports preserve decoding compatibility? Views are excluded; any View change needs smithers-06 pre-review. smithers-3f: answered 18:2x, ok. smithers-b8: answered, BLOCKING edits applied (tech lead adopts). smithers-06: answered 18:3x, ok. Design condition: "ok. I review line flags and spans in its first visual pass." smithers-38: answered, changes applied (tech lead adopts).
6. Snapshot builders are packaged host code; frames cannot launch processes or import repository modules. M-29/§1.3: C-UI-05 coding-agent and file-mutation cases execute repository code only in isolated machines as non-root users, with no sudo; absent machine isolation refuses execution through the production dispatcher. No root step is added or exercised by this ticket; root-input inventory: none, from main or branch. Machine provisioning and its root-input validation remain owned by T-INS-02/T-SEC-01. smithers-3f reviews this boundary, provider refusals and private-topic authorization in C-COL-02 and C-UI-05.

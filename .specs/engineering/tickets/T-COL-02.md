# T-COL-02 Live channel `/api/live`: topics, cursors, backpressure

Stage S1 · Size L · Depends on T-STK-01, T-ACC-03, T-INS-04, T-FLW-01, T-APP-19b · Unblocks T-APP-04, T-ACC-02, T-AGT-02, T-APP-01, T-APP-07, T-APP-08, T-APP-16, T-COL-06, T-COL-08b, T-FLW-03, T-FLW-04, T-FLW-07, T-FLW-08, T-GH-07, T-MCH-01, T-MCH-08, T-REL-02 · Issue: [#3506](https://github.com/smithersai/smithers/issues/3506)
Spec: spec.md §3 (`projection_events`), §3.1, §3.3, §5.6, §6.2.2, §7.1, §7.2, §7.6, §14.1, §14.5.1, §16.3.2–16.3.3, §19.3, §20.3 · Delta: delta.md §4 (live channel row), §9 (seams row) · Product: mvp.md §2 rule 5, §9 Honesty, J4, M-08, M-28

## Goal

A browser tab opens one WebSocket to `/api/live` on the page's origin (`ws://` on a plain-HTTP origin, `wss://` behind HTTPS, §16.3.2), subscribes to projection topics with cursors, and receives every committed card change as a snapshot and then as gap-free deltas within 1 s p95.

## Scope

- Keep Live subpath exports without a barrel. Define frames as z.discriminatedUnion("t") via T-APP-19b (#3601). Add packages/rpc/test/fixtures/Live.ts and decode tests over every frame, following the committed old-record convention in Cards.test.ts. Reserved presence and binary kinds decode to err unsupported. Check: C-COL-02.

In:
- Lands before T-ACC-04 (tech lead 2026-10-02, edge cut): Live transport uses ACC-03's trusted credential decision; before ACC-04's stored-kind classifier is installed, reject every bearer upgrade before subscription/snapshot/frames. Do not interpret existing PATs as sessions. Cookie transport can activate only with INS-04 origin checks and the real active-member/revocation provider; if that provider is absent, refuse the whole upgrade with a typed unavailable response. ACC-02's revocation integration is an explicit activation gate, since removing ACC-04 also removes its transitive ACC-02 edge. ACC-04 later qualifies production bearer login → live subscribe → revoke.; its integration test with T-ACC-04 runs after T-ACC-04 lands and gates C-COL-02, C-ACC-01 and C-UI-05 (S1 authenticated live/revocation exit).
- Endpoint with subprotocol `smithers.live.v1`, authenticated by the session cookie or a bearer token. Apply T-INS-04’s effective-origin rules (§16.3.3): unknown request hosts get 421, cookie upgrades require Origin equal to the effective origin, and cookie-free bearer upgrades need no Origin. Settings changes apply without a restart.
- Text frames `sub`, `unsub`, `snap`, `delta`, `gap` and `err` (§7.1). `err` refuses one subscription with `unknown_topic`, `forbidden` or `unsupported`, and the socket stays open.
- Per-topic cursors. Reconnect with jitter from 250 ms to 5 s and resubscribe with the last cursors (§7.1.2).
- `projection_events` with a per-topic monotonic `seq`. A shared `Publish(tx, topic, payload)` writes the row in the caller's transaction and runs `NOTIFY live, '<topic>'` (§3.1).
- Retention: 24 h or 10,000 rows per topic, whichever is larger. An older cursor gets a fresh `snap` (§3.3).
- A topic registry. Each topic declares a snapshot builder and an authorization rule, enforced through the one authorizer (§5.2.1).
- Shared and member topics (§7.2.2). One `(topic, seq)` stream serves every subscriber, so `NOTIFY` fan-out needs no member filter:
  - shared topics (`home`, `todo:<n>`, `branch:<id>` with `:activity` and `:files`, `run:<id>`, `conversation:<branch>` and the card topics) carry only shared state, identical for every subscriber;
  - member topics are named with the member id and refuse every other subscriber with `forbidden`: `confirmations:<member>` (pending confirmations) and `view:<member>:<branch>` (view state, `last_seen_seq`);
  - private entries (`audience_member_id`: Confirm cards and uncommitted Draft cards, §14.5.1) publish on their member's `view:<member>:<branch>` topic, never on `conversation:<branch>`.
- The base `run:<id>` topic (§7.2): run summary and steps, projected from runtime events (§11.6.1). It ships in S1 so Inspect and the monitor (T-FLW-07) build on it.
- Backpressure: a 2 MiB send budget per connection. On overflow, projection subscriptions receive `gap` (§7.1.1).
- Revocation closes the member's sockets within 5 s (§5.6).
- A connection count in the in-process metrics (§20.3).
- Stage-3 contract (§7.6 row 2, ADR 0003 from T-COL-10), reserved now:
  - Topic names `doc:code:<branch>:<path>` and `doc:wiki:<page>`.
  - Binary frame kinds 1 (yjs-sync) and 2 (yjs-awareness), plus kinds 3–5 (terminals, S2).
  - The `presence` text frame (S2).
  - The S1 server parses these and answers `{"t":"err","id":…,"code":"unsupported"}` (§7.1, T-COL-10). The connection stays open, and nothing is ignored silently.

Out:
- A barrel export, replacement fixture history and RPC implementation outside T-APP-19b (#3601) are excluded.
- Presence (T-COL-06), terminal frames (T-TRM-01), Yjs relay and documents (T-COL-08, T-COL-09).
- Moving the app's seams and deleting per-resource SSE routes (T-APP-08).
- Card Views, document authority placement, repository-code execution and new public flow-library abstractions.
- Each topic's projection rows and snapshot model (§7.2 lists them). Each owning ticket registers its builder: `home` T-APP-08, `todo:<n>` T-STK-01, `conversation:<branch>` and `view:<member>:<branch>` T-APP-16, `confirmations:<member>` T-ACC-05, timeline fields T-APP-07. T-FLW-07 extends `run:<id>` with cost, waits since and the raw journal.
- Client derivations from shared rows plus the member's own `last_seen_seq` and role: `merged_since_last_look` and the Home card's `attention[]` (T-APP-01).

## Changes

- Keep Live subpath exports without a barrel. Define frames as z.discriminatedUnion("t") via T-APP-19b (#3601). Add packages/rpc/test/fixtures/Live.ts and decode tests over every frame, following the committed old-record convention in Cards.test.ts. Reserved presence and binary kinds decode to err unsupported. Check: C-COL-02.

- Reuse T-STK-01’s `projection_events` migration and writer (§3.1); do not add a second migration or writer. Add `projection_topics(topic PK, last_seq)` and topic-row locking to that writer so seq order equals commit order.
- `packages/backend/db/product/queries/projection_events.sql` (new) and the sqlc output in `packages/backend/internal/db/` (run `scripts/check-sqlc-drift.sh`).
- `packages/backend/internal/live/` (new):
  - `protocol.go`: frame codec, including the reserved kinds.
  - `hub.go`: one `LISTEN live`, reusing `packages/backend/internal/sse/listener.go`. It reads rows once per notification and fans them out.
  - `registry.go` (with the member-topic rule: the topic's member id must equal the credential's member), `publish.go`, `retention.go`.
  - `run_topic.go`: the base `run:<id>` builder, fed by the host's projection of runtime events (§11.6.1) in the same transaction as the run row change.
- `packages/backend/internal/routes/live.go` (new): upgrade through `github.com/coder/websocket` (`go.mod:6`, already used by `packages/backend/internal/routes/terminal_session_manager.go:14`). Auth uses the existing `authLoader`. For the install, validate every upgrade against T-INS-04’s live effective-origin source. The static configuration seam (`packages/backend/internal/config/config.go:246`, AllowedOrigins) is not the install authority. Check: C-COL-02.
- `packages/backend/internal/compose/router.go`: mount `GET /api/live` outside the JSON timeout group, beside the terminal WebSocket (`router.go:789`).
- `docs/api/openapi/live.yaml` (new) describes the upgrade route and the frames. `packages/backend/internal/compose/openapi_conformance_test.go` covers it (§6.2.4).
- `packages/rpc/src/Live.ts` (new): frame schemas shared by the app and the CLI.
- `apps/app/src/mainview/runtime/LiveChannel.ts` (new): one socket per tab, cursor store, backoff, resubscribe, `gap` → resubscribe without a cursor.
- `packages/backend/docs/live-channel.md` (new). Run `pnpm docs:sync` and `pnpm docs:check`, then `smthrs docs //packages/backend:docs`.

## Tests

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
- [C-UI-05](../checks/C-UI-05.md): no card state shown before its committed event. Reconnect replays from cursors without duplicates or gaps.
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

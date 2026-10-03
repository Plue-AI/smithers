# T-APP-08 Seams move to the live channel; delete per-resource SSE

Stage S1 · Size M · Depends on T-COL-02, T-STK-01, T-GH-08, T-GH-07, T-INS-06, T-CUT-01 · Unblocks T-APP-01, T-APP-02, T-APP-03, T-APP-04, T-APP-05, T-APP-06, T-APP-07, T-REL-02 · Issue: [#3502](https://github.com/smithersai/smithers/issues/3502)
Spec: spec.md §7.1, §7.2, §6.2.2, §6.2.4, §14.2, §19.3; overview.md E-05, E-06 · Delta: delta.md §9 (Modify: seams move from per-resource SSE to live-channel topics) · Product: mvp.md §2 rule 5, §9 Honesty

## Goal
The app and the `smthrs` CLI read projection state only through `/api/live` topics, and the per-resource SSE routes that served the stack and workspace status are gone from the router, the OpenAPI document and the live-stream inventory.

## Scope
In:
- Browser client of §7.1: one WebSocket per tab (`smithers.live.v1`); `sub`/`unsub`; snapshot then deltas by cursor; `gap` → resubscribe without a cursor while the card keeps its last snapshot; reconnect with jittered backoff from 250 ms to 5 s and resubscribe with the last cursors (§7.1.2). Subscriptions are reference-counted, so two cards on one topic share one subscription.
- A `useTopic(topic)` hook over `useSyncExternalStore`; snapshots and deltas project into TanStack DB collections (apps/app/AGENTS.md: components are projections; no `useEffect`).
- Honest state in the client: a command's toast stays running on `202 requested` and settles only on its topic's terminal event (§6.2.2, §19.3).
- Move the consumers of `GET …/mythical/events` to the `home` topic: the app's `StackSeam` watch (`state/seams/StackSeam.ts:337`) and the CLI hint loop (`packages/smithers/src/internal/backend/History.ts:7`, `:302`), the CLI with a bearer token (§7.1).
- Delete, each with its OpenAPI row and its row in `packages/backend/docs/live-streams.md`:
  - `GET /api/repos/{o}/{r}/mythical/events` (`internal/compose/router.go:718`, `routes/mythical.go:157`, repo-root `docs/api/openapi/repositories.yaml:11102`, `live-streams.md:22`, `packages/rpc/src/Mythical.ts:49`);
  - `GET …/workspaces/{id}/stream` and `GET …/workspace/sessions/{id}/stream` (`router.go:784-785`, `routes/workspace.go:1080`, `:1128`, `repositories.yaml:8305`, `:7666`, `live-streams.md:30-31`), whose only app reader, `applyStatusEvent` (`state/seams/WorkspaceSeam.ts:149-154`, `:1591`), has no production caller.
- Regenerate the clients that list the deleted routes (`packages/backend/apiclient/client.gen.go`, `packages/smithers/src/internal/backend/ProductApi.ts`).

Out:
- The live channel server and backpressure (T-COL-02); card adapters, Containers and commands (T-APP-01 to T-APP-06). This ticket owns the shared `home` snapshot builder needed before either SSE consumer can move; T-STK-01 owns its item deltas.
- The wiki stream (`router.go:461`, `wiki/CloudWiki.ts:307`): it moves with code co-editing in S3 (T-COL-09, §7.4.3).
- The terminal WebSocket (`router.go:818`) and the Bun `/api/cloud-ws/` tunnel: T-TRM-01 moves terminal traffic onto the live channel (§7.5) and deletes them in S2.
- Notification and agent-session streams: cut surfaces (T-CUT-01, T-CUT-02).

## Changes
- Extend T-COL-02's `apps/app/src/mainview/runtime/LiveChannel.ts` and `LiveChannel.test.ts` with reference-counted subscriptions; add `apps/app/src/mainview/state/useTopic.ts` (new). T-COL-02 supplies the one client; do not create a second transport.
- `packages/backend/internal/services/home_projection.go` (new): register the shared `home` snapshot with T-COL-02. Read T-STK-01's TODOs and attention, T-GH-08's sync health, T-INS-06's host capacity, existing S1 workspace admission facts and background runs. S2 presence and machine-table fields remain absent or empty until their owning tickets land (§14.3.0). Add `background_dismissals` with the §3 shape and reserve its `ownership.csv` row as `planned:T-APP-08`, owner smithers-3f; T-APP-01 implements its commands. Add `packages/rpc/src/topics/Home.ts` and pinned `packages/rpc/test/fixtures/topics/home.json`, plus `home_projection_golden_test.go`; T-APP-01 consumes this decoder and golden.
- `apps/app/src/mainview/state/seams/StackSeam.ts`: replace both the SSE watch and its snapshot refetch with the committed `home` projection; adapt the shared rows for the existing stack renderer until T-APP-01 removes it. `History.ts` also projects its output from `home`; neither consumer polls `GET …/mythical` for projection state.
- `packages/smithers/src/internal/backend/History.ts`: hints from the `home` topic; `packages/smithers/test/BackendHistory.test.ts` follows.
- The deletions listed in Scope, in the same change as their last consumer's move (AGENTS.md zero tech debt). OpenAPI sources are at repo-root `docs/api/openapi/`; `packages/backend/docs/live-streams.md` is the stream inventory.
- `apps/app/src/bun/server.ts`: the dev server forwards `/api/live` upgrades to the backend, as it already bridges `/api/cloud-ws/` (`server.ts:191`).
- `apps/app/src/mainview/Architecture.test.ts` (existing): production files under `src/mainview` open no `text/event-stream` except `wiki/CloudWiki.ts`; exclude test fixtures. T-CUT-01 must remove `AgentSessionSeam.ts`'s production stream before this assertion turns on.

## Tests
- Unit (`LiveChannel.test.ts`, fake socket and clock): resume from a cursor; `gap` resubscribes without a cursor and never renders a guessed state; backoff stays within 250 ms–5 s; a delta with a cursor at or below the applied one is ignored; the last release unsubscribes.
- Integration (`apps/app/e2e/contracts/live-channel.spec.ts`, new): boot the production Bun server and composed Go router with real PostgreSQL; use the real LiveChannel client through `/api/live`. Send 100 accepted TODO changes through the mounted commands, drop the socket midway, and assert exactly the independently recorded input ids in order after resume, with no duplicates. Assert the retained snapshot on `gap`, two consumers sharing one subscription and the last consumer unsubscribing. Compare the Home builder against the pinned golden. Authenticate removed SSE requests and assert HTTP 404 through the same router; assert their literal route paths are absent from OpenAPI and the inventory.
- Integration (Go): `TestLiveStreamInventoryMatchesTheRouter` and `internal/compose/openapi_conformance_test.go` pass with the rows removed.
- Unit (CLI): `BackendHistory.test.ts` reads snapshots and deltas from `home`. Add a CLI integration case invoking the production `history watch` dispatcher against the composed `/api/live` route with a delegated bearer credential; a `202 requested` does not settle it before the terminal delta. Expected frames, route paths, statuses and output are pinned literals or an independent input log; no test reads spec files or computes expectations from production code at runtime.
- Perf: the client adds no buffering that pushes delta delivery past 1 s p95 (C-PERF-02, run by T-COL-02).

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-UI-05](../checks/C-UI-05.md): no state is shown before its event, and toasts settle only on terminal events, across a reconnect.

## Risks and notes
- Both `/mythical/events` consumers move only after this ticket registers and verifies `home`; T-STK-01 supplies item deltas, not the snapshot builder.
- smithers-8a decides the deletion after smithers-3f supplies a Plue consumer inventory and any coordinated replacement. Record that review in #3502; an unresolved private consumer blocks deletion.
- Risk: a slow tab loops on `gap` under backpressure (§7.1.1). Falsified if a tab receiving a 3 MiB burst resubscribes more than three times in 10 s.

## Ready checklist

1. Depends on covers the live client/server and origin/auth chain, TODO events, sync health and force-push attention, setup capacity and removal of the other production SSE reader. This ticket supplies `home` before moving its last readers; later card tickets do not provide its landing preconditions.
2. Out names transport/backpressure, card wiring, wiki co-editing, terminal traffic, notifications and agent sessions. Full S2 machine presence and a second live client are excluded.
3. C-UI-05 and `live-channel.spec.ts` exercise the production Bun upgrade, composed `/api/live`, mounted TODO commands and CLI dispatcher with PostgreSQL; removed-route requests use the same router. Expectations are pinned literals and an independent input log.
4. smithers-8a decides the private-consumer deletion and any protocol change; smithers-3f accepts the snapshot, migration and proxy seam; smithers-b8 accepts the app/CLI migration; smithers-38 signs off the RPC decoder and exports under §21.1.
5. Before start, smithers-b8: do both readers stop refetching and retain honest toasts; does the client remain single and reference-counted? smithers-3f: can the composed route authorize and resume `home` before deletion; are Plue consumers accounted for; is `background_dismissals` reserved once? smithers-38: does the pinned Home decoder cover the S1 payload without breaking existing readers? No View change is included; any View change requires smithers-06 pre-review.
6. The channel and snapshot builder execute packaged code only. Repository payloads are data and cannot import modules or launch commands on the host; any command-triggered repository work stays on a machine under T-INS-02/T-FLW-01 (§17.3, M-29). smithers-3f reviews this boundary and bearer/origin authorization; C-UI-05 covers the route.


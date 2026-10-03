# T-APP-08 Seams move to the live channel; delete per-resource SSE

Stage S1 · Size M · Depends on T-COL-02, T-STK-01 · Unblocks T-APP-01, T-APP-02, T-APP-07, T-REL-02 · Issue: [#3502](https://github.com/smithersai/smithers/issues/3502)
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
  - `GET /api/repos/{o}/{r}/mythical/events` (`internal/compose/router.go:718`, `routes/mythical.go:157`, `docs/api/openapi/repositories.yaml:11102`, `live-streams.md:22`, `packages/rpc/src/Mythical.ts:49`);
  - `GET …/workspaces/{id}/stream` and `GET …/workspace/sessions/{id}/stream` (`router.go:784-785`, `routes/workspace.go:1080`, `:1128`, `repositories.yaml:8305`, `:7666`, `live-streams.md:30-31`), whose only app reader, `applyStatusEvent` (`state/seams/WorkspaceSeam.ts:149-154`, `:1591`), has no production caller.
- Regenerate the clients that list the deleted routes (`packages/backend/apiclient/client.gen.go`, `packages/smithers/src/internal/backend/ProductApi.ts`).

Out:
- The live channel server, topics and backpressure (T-COL-02); each card's topic model (T-APP-01 to T-APP-06).
- The wiki stream (`router.go:461`, `wiki/CloudWiki.ts:307`): it moves with code co-editing in S3 (T-COL-09, §7.4.3).
- The terminal WebSocket (`router.go:818`) and the Bun `/api/cloud-ws/` tunnel: T-TRM-01 moves terminal traffic onto the live channel (§7.5) and deletes them in S2.
- Notification and agent-session streams: cut surfaces (T-CUT-01, T-CUT-02).

## Changes
- `apps/app/src/mainview/runtime/LiveChannel.ts` (new) and `LiveChannel.test.ts` (new); `apps/app/src/mainview/state/useTopic.ts` (new).
- `apps/app/src/mainview/state/seams/StackSeam.ts`: replace the SSE watch with a `home` subscription. T-APP-01 then deletes the stack model.
- `packages/smithers/src/internal/backend/History.ts`: hints from the `home` topic; `packages/smithers/test/BackendHistory.test.ts` follows.
- The deletions listed in Scope, in the same change as their last consumer's move (AGENTS.md zero tech debt).
- `apps/app/src/bun/server.ts`: the dev server forwards `/api/live` upgrades to the backend, as it already bridges `/api/cloud-ws/` (`server.ts:191`).
- `apps/app/src/mainview/Architecture.test.ts` (existing): add a rule that no file under `src/mainview` opens `text/event-stream` except `wiki/CloudWiki.ts`.

## Tests
- Unit (`LiveChannel.test.ts`, fake socket and clock): resume from a cursor; `gap` resubscribes without a cursor and never renders a guessed state; backoff stays within 250 ms–5 s; a delta with a cursor at or below the applied one is ignored; the last release unsubscribes.
- Integration (`apps/app/e2e/contracts/live-channel.spec.ts`, new, real backend with PostgreSQL): drop the socket during 100 `todo_events` writes; after reconnect the client's cursor sequence has no hole and no duplicate.
- Integration (Go): `TestLiveStreamInventoryMatchesTheRouter` and `internal/compose/openapi_conformance_test.go` pass with the rows removed.
- Unit (CLI): `BackendHistory.test.ts` reads hints from the topic with a bearer token.
- Perf: the client adds no buffering that pushes delta delivery past 1 s p95 (C-PERF-02, run by T-COL-02).

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-UI-05](../checks/C-UI-05.md): no state is shown before its event, and toasts settle only on terminal events, across a reconnect.

## Risks and notes
- Both `/mythical/events` consumers move only once T-STK-01 publishes `home`.
- Risk: Plue (private repository) may still read the workspace status streams. This repository cannot show it; confirm with `rg "workspaces/.*/stream"` in Plue before the deletion lands.
- Risk: a slow tab loops on `gap` under backpressure (§7.1.1). Falsified if a tab receiving a 3 MiB burst resubscribes more than three times in 10 s.

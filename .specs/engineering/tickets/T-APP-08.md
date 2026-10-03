# T-APP-08 Seams move to the live channel; delete per-resource SSE

Stage S1 · Size S · Depends on T-COL-02, T-APP-01, T-CUT-01 · Unblocks T-REL-02 · Issue: [#3502](https://github.com/smithersai/smithers/issues/3502)
Spec: spec.md §7.1, §7.2, §6.2.2, §19.3; overview.md E-05, E-06 · Delta: delta.md §9 (Modify: seams move from per-resource SSE to live-channel topics) · Product: mvp.md §2 rule 5, §9 Honesty

## Goal
The app and the `smthrs` CLI read live state only through `/api/live`, and the per-resource SSE routes for the stack and workspace status are gone from the router, the OpenAPI document and the live-stream inventory.

## Scope
In:
- The client is the landed `apps/app/src/mainview/runtime/LiveChannel.ts` (one transport, reference-counted topics) and `state/useTopic.ts`. Delete its unread TanStack collection (`LiveChannel.ts:28-30`); `useTopic` reads the topic snapshot directly. No second transport and no new hook.
- `/api/live` is the WebSocket adapter over the existing `sse.Broker` and durable-stream cursors that T-COL-02 serves (ruling 2). No `projection_events` table.
- Move the CLI hint loop (`packages/smithers/src/internal/backend/History.ts:7`, `:302`) from `GET …/mythical/events` to the `home` topic that T-APP-01 publishes, with a bearer token. The app's other consumer, `state/seams/StackSeam.ts`, is deleted by T-APP-01.
- Delete, each with its OpenAPI row and its row in `packages/backend/docs/live-streams.md`:
  - `GET /api/repos/{o}/{r}/mythical/events` (`internal/routes/mythical.go:157-178`, `internal/compose/router.go:718`, `docs/api/openapi/repositories.yaml`, `packages/rpc/src/Mythical.ts:49`);
  - `GET …/workspaces/{id}/stream` and `GET …/workspace/sessions/{id}/stream` (`internal/routes/workspace.go:1080-1175`, `router.go:791-792`). No app code calls them.
- Regenerate the clients that list the deleted routes (`packages/backend/apiclient/client.gen.go`, `packages/smithers/src/internal/backend/ProductApi.ts:4347`).

Out:
- The `/api/live` server and backpressure (T-COL-02); the `home` data and the Home card (T-APP-01).
- The wiki stream (`router.go:461`, `wiki/CloudWiki.ts:307`): moves with code co-editing in S3.
- The terminal WebSocket and the Bun `/api/cloud-ws/` tunnel (T-TRM-01, S2).
- Notification and agent-session streams (T-CUT-01, T-CUT-02).

## Changes
- `apps/app/src/mainview/runtime/LiveChannel.ts`: delete the `collection` field and its `@tanstack/db` import; `LiveChannel.test.ts` and `state/useTopic.test.tsx` follow.
- `packages/smithers/src/internal/backend/History.ts`: hints from the `home` topic; `packages/smithers/test/BackendHistory.test.ts` follows.
- The route deletions in Scope, in the same change as the last consumer's move (AGENTS.md zero tech debt).
- `apps/app/src/bun/server.ts`: the dev server forwards `/api/live` upgrades to the backend, as it already bridges `/api/cloud-ws/` (`server.ts:191`).
- `apps/app/src/mainview/Architecture.test.ts`: production files under `src/mainview` open no `text/event-stream` except `wiki/CloudWiki.ts`.

## Tests
- Unit (`LiveChannel.test.ts`, fake socket and clock): resume from a cursor; `gap` resubscribes without a cursor and keeps the last snapshot; backoff stays within 250 ms–5 s; a delta at or below the applied cursor is ignored; two consumers share one subscription; the last release unsubscribes.
- Integration (Go): authenticated requests to the three removed paths return 404 through the composed router; `TestLiveStreamInventoryMatchesTheRouter` and `internal/compose/openapi_conformance_test.go` pass with the rows removed.
- Unit (CLI, `BackendHistory.test.ts`): `history watch` reads snapshots and deltas from `home`; a `202 requested` does not settle before the terminal delta. Expected frames and output are literals.

## Acceptance
- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

## Risks and notes
- smithers-8a decides the deletion after smithers-3f supplies a Plue consumer inventory of the three routes. Record that review in #3502; an unresolved private consumer blocks deletion.

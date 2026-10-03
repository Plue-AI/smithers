# T-APP-21 `/debug-api` playground: call the documented API from the app

Stage S2 · Size M · Depends on T-APP-19, T-UI-22, T-CAT-01, T-ACC-03 · Unblocks T-REL-02 · Issue: [#3559](https://github.com/smithersai/smithers/issues/3559)
Spec: spec.md §5.2, §6.2, §6.3 · Delta: delta.md §9 · Product: mvp.md M-36 (advanced primitive), §6.13 API

## Goal

An advanced user opens `/debug-api`, picks a documented endpoint, fills its typed parameters and sends it, seeing the request and the response, so the API is learnable and debuggable without a separate client.

## Ownership (Will, 2026-10-02)

Owner: smithers-b8 (frontend lead): container and flow. Design (smithers-06) builds the `DebugApiView` (T-UI-22): operation list, schema-generated request form, response pane. This ticket owns the Debug API view model, `packages/rpc/src/DebugApiCard.ts`, because it joined the card list after T-APP-19 ([card-kinds.md §1](../card-kinds.md)).

## Scope

In:
- The flow `debug.api [operationId]` (slash `/debug-api`, mvp.md M-36) opens the playground at an operation, reached from the advanced area (§6.14) and listed under Advanced in `/help`. It is person-only (`agent: never`; the parity test lists it as `userOnly` with the reason "raw API bypasses flow typing and approvals; agents use flows"). Requests are same-origin fetches with the viewer's own session cookie and go through the same authorizer as every call (§5.2.1), so the playground grants nothing the person couldn't do with the API. No token is entered or stored in the page.
- Operations, parameters and response schemas come from `docs/api/openapi.yaml`, converted to JSON at build time and loaded as a lazy chunk only when the playground opens. App and backend ship from one commit, so no backend route is needed. Only documented operations appear.
- GET and HEAD run on Send. POST, PUT, PATCH and DELETE need an in-card confirmation naming the method and path before anything is sent; nothing is sent on open. (This is the person confirming their own request, not a §5.4 person confirmation.)
- The response shows status, headers, body and duration. A 401 or other refusal renders as a typed failure, never a crash. Nothing persists beyond the session. Secret values never render: no secrets-read operation exists (§8.8).

Out:
- Saved requests, history across sessions, other users' credentials, and any endpoint not in the OpenAPI source.

## Changes

- `DebugApiContainer.tsx`, `packages/rpc/src/DebugApiCard.ts`, `flows/entries/debug.ts` and the `debug.api` descriptor (T-CAT-01), the OpenAPI YAML-to-JSON build step and lazy chunk.

## Tests

- unit: every operation in `openapi.yaml` appears in the playground; `flows/parity.test.ts` lists `debug.api` as `userOnly` with its reason; a delegated credential calling it gets `never`.
- unit: a mutating call never sends without the confirmation; a 401 renders the typed failure.
- integration (real backend): a member's GET succeeds; the same member's maintainer-only POST returns 403 `permission` through the playground exactly as through `curl` (C-UI-10).

## Acceptance

- [C-UI-10](../checks/C-UI-10.md).
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes

- Stage S2 (product, 2026-10-02): the playground is not on the J1/J2 path.

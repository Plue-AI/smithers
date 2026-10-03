# T-APP-21 `/debug-api` playground: call the documented API from the app

Stage S2 · Size M · Depends on T-UI-22, T-CAT-01, T-ACC-03 · Unblocks T-REL-02 · Issue: [#3559](https://github.com/smithersai/smithers/issues/3559)
Spec: spec.md §5.2, §6.2, §6.3 · Delta: delta.md §9 · Product: mvp.md M-36 (advanced primitive), §6.13 API

## Goal

An advanced user opens `/debug-api`, picks a documented endpoint, fills its typed parameters and sends it, seeing the request and the response, so the API is learnable and debuggable without a separate client.

## Ownership (Will, 2026-10-02)

Owner: smithers-b8 (frontend lead): the card file and flow. Design (smithers-06) builds the `DebugApiView` (T-UI-22): operation list, schema-generated request form, response pane. This ticket owns the Debug API card file; T-UI-22 adds back the props type in `packages/rpc/src/DebugApiCard.ts`.

## Scope

In:
- The flow `debug.api [operationId]` (slash `/debug-api`, mvp.md M-36) opens the playground at an operation, reached from the advanced area (§6.14) and listed under Advanced in `/help`. It is person-only (`agent: never`; the parity test lists it as `userOnly` with the reason "raw API bypasses flow typing and approvals; agents use flows"). Requests are same-origin fetches with the viewer's own session cookie and go through the same authorizer as every call (§5.2.1), so the playground grants nothing the person couldn't do with the API. No token is entered or stored in the page.
- Operations, parameters and response schemas come from `docs/api/openapi.yaml`, converted to JSON at build time and loaded as a lazy chunk only when the playground opens. App and backend ship from one commit, so no backend route is needed. Only documented operations appear.
- GET and HEAD run on Send. POST, PUT, PATCH and DELETE need an in-card confirmation naming the method and path before anything is sent; nothing is sent on open. (This is the person confirming their own request, not a §5.4 person confirmation.)
- The response shows status, headers, body and duration. A 401 or other refusal renders as a typed failure, never a crash. Nothing persists beyond the session. Secret values never render: no secrets-read operation exists (§8.8).

Out:
- Saved requests, history across sessions, other users' credentials, and any endpoint not in the OpenAPI source.

## Changes

- `apps/app/src/mainview/cards/DebugApiCard.tsx` (new card file, the only mount point through `CardRenderers.tsx`): no API card exists to reshape. It replaces no legacy card.
- `flows/entries/debug.ts` (existing `debug` namespace) and the `debug.api` descriptor (T-CAT-01), the OpenAPI YAML-to-JSON build step and lazy chunk.

## Tests

- unit: every operation in `openapi.yaml` appears in the playground; `flows/parity.test.ts` lists `debug.api` as `userOnly` with its reason; a delegated credential calling it gets `never`.
- unit: a mutating call never sends without the confirmation; a 401 renders the typed failure.
- integration (`apps/app/e2e/playwright/debug-api.spec.ts`, new; real backend and PostgreSQL; Ben is a Member, Mia a Maintainer):
  - Ben sends a documented member-readable GET: 200 with the same body as `curl` with Ben's session.
  - Ben picks a documented maintainer-only write and presses Send: nothing is sent; after he confirms the method and path, it returns 403 `permission`, identical to `curl`. Mia's same request succeeds.
  - Ben signs out in another tab and sends a GET: a typed 401 failure renders, not a crash.
  - `/debug-api` through the app agent and through `smthrs` with a delegated credential is refused with `never`.
  - The operation set the playground lists equals `docs/api/openapi.yaml` exactly, and opening the playground sends no request.

## Acceptance
- [C-UI-10](../checks/C-UI-10.md): passes for this ticket’s phase at its stated layer.

- [C-UI-13](../checks/C-UI-13.md): `DebugApiView` is reachable from `CardRenderers`; it replaces no legacy card.

## Risks and notes

- M-36 (the API playground) awaits Will's product decision (synthesis v2, "Still for Will"); this ticket stays specified until he rules.
- Stage S2 (product, 2026-10-02): the playground is not on the J1/J2 path.

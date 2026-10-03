# T-APP-21 `/debug-api` playground: call the documented API from the app

Stage S2 · Size M · Depends on T-UI-22, T-CAT-01, T-ACC-03 · Unblocks — · Issue: [#3559](https://github.com/smithersai/smithers/issues/3559)
Spec: spec.md §1.3, §5.2, §6.2, §6.3, §14.2, §14.3 · Delta: delta.md §9 · Product: mvp.md M-36 (advanced primitive), §6.13 API
Ready: 2026-10-03 smithers-8a sha256:a95ba03df399

## Goal

An advanced user opens `/debug-api`, picks a documented endpoint, fills its typed parameters and sends it, seeing the request and the response, so the API is learnable and debuggable without a separate client.

## Ownership (Will, 2026-10-02)

Owner: smithers-b8 (frontend lead): the card file and flow. Design (smithers-06) builds the `DebugApiView` (T-UI-22): operation list, schema-generated request form, response pane. This ticket owns the Debug API card file. Reuse `packages/rpc/src/DebugApiCard.ts`, which already exports `DebugApiViewProps`; T-UI-22 reshapes that contract to the props-only View rule. smithers-b8 approves the request/response contract and literal API test fixtures; smithers-06 approves View bindings and copy; smithers-38 approves shared TypeScript contract changes; smithers-3f approves authorization and machine-only execution ordering. smithers-8a accepts seam changes. Recorded owner answers stand; owners review implementation post hoc under the parallel-build directive.

## Scope

In:
- Build against the specified contracts. Lands dark until T-UI-22: no live card mount without `DebugApiView`. Lands dark until T-CAT-01: no advertised `/debug-api` door or Send action without the shared descriptor and dispatcher. Lands dark until T-ACC-03: Send refuses before fetch when the install cannot enforce the shared authorizer. C-UI-10 tests each unavailable dependency independently and verifies zero API effects. These are the existing code/schema dependencies; no landing-only edge is added.
- Lands dark for repository-executing operations until T-INS-02 and T-FLW-01 supply machine isolation and dispatch: the production route refuses before execution when either is unavailable. Reuse that route guard; the playground supplies no host execution fallback. C-UI-10 exercises an execution request with isolation unavailable and verifies refusal and no host process.
- The flow `debug.api [operationId]` (slash `/debug-api`, mvp.md M-36) opens the playground at an operation, reached from the advanced area (§6.14) and listed under Advanced in `/help`. It is person-only (`agent: never`; the parity test lists it as `userOnly` with the reason "raw API bypasses flow typing and approvals; agents use flows"). Requests are same-origin fetches with the viewer's own session cookie and go through the same authorizer as every call (§5.2.1), so the playground grants nothing the person couldn't do with the API. No token is entered or stored in the page.
- Operations, parameters and response schemas come from `docs/api/openapi.yaml`, converted to JSON at build time and loaded as a lazy chunk only when the playground opens. App and backend ship from one commit, so no backend route is needed. Only documented operations served by the install composition appear; exclude `x-composition: plue` rows (§6.2.4). Treat the bundled schema as data, not executable code. C-UI-10 checks composition filtering against a committed literal fixture.
- GET and HEAD run on Send. POST, PUT, PATCH and DELETE need an in-card confirmation naming the method and path before anything is sent; nothing is sent on open. (This is the person confirming their own request, not a §5.4 person confirmation.) Generate `Idempotency-Key` for each confirmed mutation and keep it for retries of that same request (§6.2.1). Editing the method, path or body invalidates the pending confirmation. C-UI-10 verifies these behaviors through the Send action.
- The response shows status, headers, body and duration. A 401 or other refusal renders as a typed failure, never a crash. Nothing persists beyond the session. Secret values never render: no secrets-read operation exists (§8.8).

Out:
- Saved requests, history across sessions, other users' credentials, token entry/storage, arbitrary URLs, cross-origin requests or redirects, Plue-only routes, new backend routes, a second authorizer, and changes to endpoint permissions or machine execution guards.
- Raw developer tools (seams, network inspectors, sync operations and the admin console), a separate API client/runtime, and implementation of `DebugApiView` (T-UI-22).

## Changes

- Reshape `apps/app/src/mainview/flows/entries/debug.ts` and bind `debug.api` through T-CAT-01's descriptor in `packages/smithers/ui/src/app-operations/index.ts`; reuse the existing dispatcher and card action bindings. Do not add a parallel catalog.
- Reuse `packages/rpc/src/DebugApiCard.ts` and `docs/api/openapi.yaml`; add only the YAML-to-JSON build conversion and lazy load that the existing source lacks. No runtime schema endpoint.
- `apps/app/src/mainview/cards/DebugApiCard.tsx` (new card file mounted only through the existing `apps/app/src/mainview/cards/CardRenderers.tsx`): no API card exists to reshape. Bind the T-UI-22 View; no separate Container or legacy replacement. Reuse existing form generation and typed failure rendering.

## Tests

C-UI-10 is folded into these tests. Commit literal fixtures for install operation IDs, methods, paths, input/output schemas, role outcomes and error envelopes, reviewed by smithers-b8 and smithers-3f. Never read spec Markdown or derive expected values from OpenAPI, generated JSON, descriptors or production code at runtime. OpenAPI is the production input under test, not the oracle.

- unit: extend `apps/app/src/mainview/flows/agent-parity.test.ts` with the literal `debug.api` person-only reason; extend `apps/app/src/mainview/flows/parity.test.ts` for the Send/confirmation dispatcher bindings. Exercise the production controller's `runCommandForResult`, not a direct card handler.
- unit: through the production Send action, no mutation fetch occurs before confirmation or after the request changes; retries retain the same idempotency key. Typed 401 rendering uses a literal error fixture. Reject an unknown operation, an absolute/cross-origin URL and a redirect before any off-origin fetch. Render response bodies as text; cookie and authorization headers never appear in the exchange. No token input or storage is created.
- integration (`apps/app/e2e/playwright/debug-api.spec.ts`, new; real install backend and PostgreSQL; Ben is a Member, Mia a Maintainer):
  - Open `/debug-api` through the slash dispatcher and Advanced door, reaching the card through `CardRenderers`; selecting a literal operation sends no API request.
  - Ben sends `GET /api/stack`: 200 and the literal seeded stack body; compare separately with `curl` using Ben's session.
  - Ben sends a literal `PUT /api/secrets` fixture: zero requests before confirmation, then 403 `permission`; Mia's same request succeeds. Assert literal status/envelope and persisted effects independently of the `curl` comparison.
  - Ben signs out in another tab, then sends: the literal 401 refusal renders without a crash.
  - Invoke `debug.api` through the production app-agent dispatcher and `smthrs` parser/dispatcher with an eligible delegated credential: person-only refusal `never`, with no API effects. Scope/role failures retain their earlier refusal (§5.2.1).
  - The displayed operations and form fields equal the committed literal install-composition fixture; Plue-only and undocumented operations are absent.
  - Each dark-landing guard refuses with no effects. A literal repository-flow execution request goes through its production route: unavailable isolation refuses without a host process; available execution runs only in a branch machine.
- C-UI-13: add `DebugApiView` with T-APP-21 and an empty legacy-file list to the existing literal reachability table when mounted; do not add a second inventory gate.
## Acceptance
- [C-UI-10](../checks/C-UI-10.md): passes for this ticket’s phase at its stated layer.

- [C-UI-13](../checks/C-UI-13.md): `DebugApiView` is reachable from `CardRenderers`; it replaces no legacy card.

## Risks and notes

- Will decides any change to M-36. Current M-36 scope remains binding while the synthesis decision is pending; it does not block dark landing or authorize additional scope.
- This ticket adds no root step. Its build consumes the release source's OpenAPI file; browser requests consume the shipped JSON chunk and viewer-entered parameters/body under the viewer's session. None is a root input. Repository-executing requests remain behind §1.3's machine-only route guard. Any proposed root step must first list every input and its main/branch source; branch input blocks that step unless a named validation test proves it safe. smithers-3f reviews this boundary (C-UI-10).
- Stage S2 (product, 2026-10-02): the playground is not on the J1/J2 path.

## Ready checklist

1. Dependencies: T-UI-22 supplies the View/props, T-CAT-01 the descriptor/dispatcher, and T-ACC-03 the authorizer called by the API. Scope states fail-closed dark landing for each and for unavailable machine execution; landing-only gates add no Depends edge (C-UI-10).
2. Exclusions: Out names credential storage, arbitrary/off-origin requests, Plue routes, backend/API policy changes, raw developer tools, separate runtimes and T-UI-22's View implementation.
3. Tests: C-UI-10 uses slash/Advanced, Send, app-agent, CLI and real install routes with literal fixtures; C-UI-13 uses the existing reachability table. No expected value comes from spec or production code at runtime.
4. Decisions: Will owns M-36; smithers-b8 owns API fixtures/contracts, smithers-06 View/copy, smithers-38 shared types, smithers-3f security, and smithers-8a seam acceptance.
5. Owner pre-review: smithers-b8 (apps): Do slash, Advanced and Send use one dispatcher and preserve idempotency? smithers-06 (UI): Do existing View props cover confirmation and typed failure without a second renderer? smithers-38 (packages TypeScript): Can the existing shared contract serve without a duplicate schema? smithers-3f (Go/security): Do production routes preserve authorization and refuse unavailable machine execution before effects? Recorded answers stand; implementation review is post hoc.
6. Security: Scope retains viewer-session authorization, same-origin requests and machine-only repository execution; C-UI-10 tests refusal, redirect blocking and inert response rendering. No root step or root input is added; smithers-3f reviews the boundary and any proposed root-input inventory.

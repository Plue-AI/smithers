# T-CUT-02 Delete cut backend routes with their OpenAPI rows

Stage S1 · Size M · Depends on T-CUT-01, T-INS-08 · Unblocks T-INS-06, T-REL-02 · Issue: [#3509](https://github.com/smithersai/smithers/issues/3509)
Spec: spec.md §6.2.4, §6.3 (target surface), §17.5, §20.2 · Delta: delta.md §10 (Delete backend/OpenAPI row), §6 (Hide `history.bootstrap/backfill`) · Product: mvp.md §8 (Cut rows), §12 release item 3, §14 (kept machinery), M-09

## Goal
The install serves no route for a surface mvp.md §8 cuts. Every route deleted from the code is deleted from `docs/api/openapi/*.yaml` in the same change. Routes that Plue still serves are unmounted in the install composition only, and their OpenAPI rows carry `x-composition: plue` (§6.2.4).

## Scope
In: one decision per route, recorded in `packages/rpc/src/catalog/cuts.json` (from T-CUT-01) under `routes`. Backend paths are under `packages/backend/internal/`. Before deletion, smithers-3f approves the route/query consumer inventory and Plue compatibility, smithers-b8 approves removal of app/CLI consumers, and smithers-38 approves shared TypeScript flow and RPC changes. A route with a kept consumer remains served and documented; a search result alone is not deletion approval. Will decides changes to product Cut/Hide/Defer policy; smithers-8a resolves spec conflicts.

| §8 row | Routes (source) | Decision |
| --- | --- | --- |
| Five-job setup UI | `/api/repository-setup/{operation}` GET and POST (`compose/browser_flow.go:374,379`, `compose/repository_setup.go`, `services/repository_setup.go`) | Delete |
| Five-job setup, CI | `/api/gateways/{hostID}/repository-jobs/{job}/trials/{requestID}` and `.../ci/check-receipts/{requestID}` (`compose/router.go:568,571`) | Delete, once `rg` shows no event-admission caller |
| Five-job setup | The other repository-jobs machinery (router.go:567,569,570,1270–1278) | Keep the internal implementation for admission, dispatch, replies and approvals (§14). T-CUT-03 unmounts user-management HTTP doors from the install under §6.3.1; Plue retains its operations. |
| Registration and admin review | Registration RPC procedures in `compose/browser_flow.go:121,277-302`, `compose/registration_review.go`, `registration_report.go` | Delete |
| Splitting across TODOs | `POST /api/repos/{o}/{r}/changes/{change_id}/split` (`router.go:1143`) | Delete with `SplitChange` |
| Signup poll, first-run | `POST /api/recommend`, `/api/recommend/outcome` (`router.go:873-874`) | Delete if no kept consumer remains after T-CUT-01 |
| Admin console | `/api/admin/*` (`router.go:1778-1845`) | Unmount in the install composition; `x-composition: plue` (§6.2.4) |
| Cloud agent sessions | `/api/admin/agent-sessions*` and repo `agent-sessions` routes (`router.go:1349,1827-1828`) | Admin routes as the admin row; repo routes are deleted if only cut app code called them |

Out:
- `/api/agent/turn*` and `/api/agent/conversations*` (`packages/rpc/src/AgentApiRoutes.ts:13-48`). Research listed them among the agent-session cuts, but they are the app agent's turn routes. T-APP-16 deletes the write half (`/api/agent/turn`, `/cancel`, `/retire`) at the host-turn cutover and keeps the read half for the Earlier archive (spec §14.1.5).
- Branch locks (T-CUT-02).
- Billing routes (T-CUT-03).
- Deleting kept event-admission, dispatch, reply or approval machinery; deleting Plue-only admin routes; changing generic workflow RPC behavior or installing a host executor. Preserve the existing GET /api/health route. T-INS-08's host status must report process health without /api/install before the install admin routes are unmounted; T-INS-06 later adds richer install telemetry.
- **Hide** rows: `mythical/{bootstrap,backfill,config}` (`router.go:1118-1120`), `mirror-sync`, notifications and devtools keep running and stay documented.

## Changes
- Delete branch-lock service, routes, queries and generated client entries in S1; no app consumer uses them. Shared access uses workspace_shares. Check: C-CUT-01.
- Delete each "Delete" route with its handler, service, sqlc queries (then regenerate) and tests. Delete its rows in `docs/api/openapi/{repository-setup,admin,repositories,…}.yaml`, then re-bundle with `scripts/openapi-bundle.mjs`.
- `compose/router.go:1778`: mount `/admin` only outside the install composition (`config.IsMultitenant(cfg.Auth)`, `config/auth_mode.go:19`). Its rows in `docs/api/openapi/admin.yaml` gain `x-composition: plue`. The owner's health view is `/api/install` (§20.2, T-INS-06), not `/api/admin/system/health`.
- `compose/openapi_conformance_test.go`: each composition is checked against its own rows. The install router serves exactly the rows without `x-composition: plue`; the Plue router serves every row (§6.2.4).
- `docs/api/failure-codes.json` and `packages/rpc/src/PlueFailureCodes.ts`: delete codes that only deleted routes raise.
- `flows/register-repository/` and the cut modules of `flows/repository/` (`activation.ts`, `checks.ts`, `check-context.ts`, `check-receipt.ts`, `ci-policy.ts`) are deleted only where `rg` finds no importer among the kept modules (`intake.ts`, `replies.ts`, `jev-reproduction.ts`, `registry.ts`, …).
- CLI: `smthrs repo report` (registration report) is deleted with its `Definitions.ts:953` entry.
- Generated clients: regenerate `packages/backend/apiclient/client.gen.go` and `packages/smithers/src/internal/backend/ProductApi.ts` operations. smithers-3f and smithers-b8 approve the resulting public Go and CLI API removals before landing; smithers-38 approves RPC failure-code removals.
- Docs: the backend package docs (`packages/backend/docs/`) pages for deleted routes. Run `pnpm docs:sync` and `pnpm docs:check`.

## Tests
- Integration: `compose/openapi_conformance_test.go:222` (`TestOpenAPIDescribesEveryServedRoute`) passes separately for the install and Plue production compositions, each against its own documented operations. Schema/route parity supplements the assertions below.
- Integration: `compose/cut_routes_test.go` (new, C-CUT-01 backend half) sends HTTP requests through both production routers with real PostgreSQL, normal middleware and credentials. Pin literal method/path, composition and expected status entries in `compose/testdata/cut_routes.json` (new), reviewed against product when authored. Deleted routes return 404 in both compositions and have no OpenAPI operation; Plue-only routes return 404 in the install and their pinned served result in Plue; kept repository-job routes retain their pinned results, and GET /api/health still returns 200 with body ok. Supply the handlers/capabilities that would expose a removed route, so nil dependencies cannot make a false 404 pass. `cuts.json`, route walking and OpenAPI are actual results or supplemental parity inputs, never the expectation source; read no spec file at runtime.
- Integration in the same suite: send removed Registration procedures through the production `POST /api/workflow/rpc` dispatcher and assert refusal without registration work, while a pinned kept procedure still dispatches. Do not require the shared RPC route to disappear.
- Regression: event admission and dispatch suites (`services/repository_jobs*_test.go`) stay green. Exercise outsider and maintainer events through the production signed-webhook/admission boundary with literal outcomes and real PostgreSQL (C-SEC-03): outsider text produces no credentialed work; admitted repository work uses machines only, with no host fallback (§1.3, §17.3). smithers-3f reviews these security preconditions before start.

## Acceptance
- [C-CUT-01](../checks/C-CUT-01.md): cut routes are absent from the install's served routes and from OpenAPI.

## Risks and notes
- **Plue consumers of `/api/admin/*`:** `~/plue/apps/admin/src/commands/{user,token,status,invite}.ts` and `~/plue/apps/observe/internal/smithers/{client,analytics}.go` call `/api/admin/users`, `tokens`, `system/*`, `analytics/summary`, `agent-sessions`, `workspaces`, `sandbox/*` and `github-app/reconcile`. That is why these routes are unmounted, not deleted (§6.2.4; AGENTS.md "one backend"). Observation that confirms a mistake: Plue's admin CLI fails against a backend built from this change.
- **Repository-jobs keep/cut line:** research flags that a naive delete breaks §14 and contributor trust rules. Each route's decision above needs the owner of §14 (T-STK-09 / C-SEC-03) to agree before deletion. Falsified if C-SEC-03 fails after this ticket.
- **`/api/recommend`:** this route may also serve Jev's recommended actions. Confirm with `rg "/api/recommend" apps/app/src packages` after T-CUT-01. Delete only if no kept caller remains.
- **Generated SDK:** Plue pins the backend module and regenerates Observe's OpenAPI (research `deleted-features.md` risks). List every deleted operation in the issue for the Plue bump. smithers-3f signs off that consumer list; do not treat an unavailable Plue checkout as proof of no consumer.

## Ready checklist
1. Dependencies: T-CUT-01 removes cut app consumers and supplies cuts.json; T-INS-08 supplies host status process diagnostics before install admin routes are unmounted, and GET /api/health remains served. T-INS-06's richer telemetry is downstream, not a landing prerequisite. Existing kept admission/dispatch machinery is preserved.
2. Exclusions: turn/archive routes, branch locks, billing, Hide plumbing, kept event machinery, Plue-only admin APIs and generic RPC behavior are explicit.
3. Tests: cut_routes_test.go calls both production routers and the shared RPC dispatcher with pinned literal expectations; OpenAPI and cuts.json comparisons supplement that oracle (C-CUT-01). Real webhook/admission regression covers C-SEC-03.
4. Decisions: smithers-3f approves route/query deletion and Go public API compatibility; smithers-b8 approves app/CLI consumer removal and CLI API changes; smithers-38 approves TS flow/RPC seams; Will decides product-policy changes and smithers-8a resolves spec conflicts.
5. Owner pre-review before start: smithers-3f: Which trial/check-receipt, recommendation and session routes still have kept or Plue callers? Do host status and /api/health remain usable before /api/install lands? Do both compositions retain admission and trust enforcement? smithers-b8: Which app/CLI consumers remain after T-CUT-01? Does repo report removal affect any kept command? smithers-38: Which flow imports prevent deleting shared modules? Which failure codes remain reachable?
6. Security: deletion preserves contributor trust and credential checks; admitted repository code executes only in machines, never in the host runtime. smithers-3f reviews the execution/admission boundary and C-SEC-03 before start.

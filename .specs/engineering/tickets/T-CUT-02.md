# T-CUT-02 Delete cut backend routes with their OpenAPI rows

Stage S1 · Size M · Depends on T-CUT-01 · Unblocks T-REL-02 · Issue: [#3509](https://github.com/smithersai/smithers/issues/3509)
Spec: spec.md §6.2.4, §6.3 (target surface), §17.5, §20.2 · Delta: delta.md §10 (Delete backend/OpenAPI row), §6 (Hide `history.bootstrap/backfill`) · Product: mvp.md §8 (Cut rows), §12 release item 3, §14 (kept machinery), M-09

## Goal
The install serves no route for a surface mvp.md §8 cuts. Every route deleted from the code is deleted from `docs/api/openapi/*.yaml` in the same change. Routes that Plue still serves are unmounted in the install composition only, and their OpenAPI rows carry `x-composition: plue` (§6.2.4).

## Scope
In: one decision per route, recorded in `packages/rpc/src/catalog/cuts.json` (from T-CUT-01) under `routes`. Backend paths are under `packages/backend/internal/`.

| §8 row | Routes (source) | Decision |
| --- | --- | --- |
| Five-job setup UI | `/api/repository-setup/{operation}` GET and POST (`compose/browser_flow.go:374,379`, `compose/repository_setup.go`, `services/repository_setup.go`) | Delete |
| Five-job setup, CI | `/api/gateways/{hostID}/repository-jobs/{job}/trials/{requestID}` and `.../ci/check-receipts/{requestID}` (`compose/router.go:568,571`) | Delete, once `rg` shows no event-admission caller |
| Five-job setup | The other `repository-jobs` routes (`router.go:567,569,570,1270-1278`) | Keep: admission, dispatch, replies and approvals stay for §14 (§8 row 1) |
| Registration and admin review | Registration RPC procedures in `compose/browser_flow.go:121,277-302`, `compose/registration_review.go`, `registration_report.go` | Delete |
| Splitting across TODOs | `POST /api/repos/{o}/{r}/changes/{change_id}/split` (`router.go:1143`) | Delete with `SplitChange` |
| Signup poll, first-run | `POST /api/recommend`, `/api/recommend/outcome` (`router.go:873-874`) | Delete if no kept consumer remains after T-CUT-01 |
| Admin console | `/api/admin/*` (`router.go:1778-1845`) | Unmount in the install composition; `x-composition: plue` (§6.2.4) |
| Cloud agent sessions | `/api/admin/agent-sessions*` and repo `agent-sessions` routes (`router.go:1349,1827-1828`) | Admin routes as the admin row; repo routes are deleted if only cut app code called them |

Out:
- `/api/agent/turn*` and `/api/agent/conversations*` (`packages/rpc/src/AgentApiRoutes.ts:13-48`). Research listed them among the agent-session cuts, but they are the app agent's turn routes. T-APP-23 deletes the write half (`/api/agent/turn`, `/cancel`, `/retire`) at the host-turn cutover and keeps the read half for the Earlier archive (spec §14.1.5).
- Branch locks (T-MCH-05).
- Billing routes (T-CUT-03).
- **Hide** rows: `mythical/{bootstrap,backfill,config}` (`router.go:1118-1120`), `mirror-sync`, notifications and devtools keep running and stay documented.

## Changes
- Delete each "Delete" route with its handler, service, sqlc queries (then regenerate) and tests. Delete its rows in `docs/api/openapi/{repository-setup,admin,repositories,…}.yaml`, then re-bundle with `scripts/openapi-bundle.mjs`.
- `compose/router.go:1778`: mount `/admin` only outside the install composition (`config.IsMultitenant(cfg.Auth)`, `config/auth_mode.go:19`). Its rows in `docs/api/openapi/admin.yaml` gain `x-composition: plue`. The owner's health view is `/api/install` (§20.2, T-INS-06), not `/api/admin/system/health`.
- `compose/openapi_conformance_test.go`: each composition is checked against its own rows. The install router serves exactly the rows without `x-composition: plue`; the Plue router serves every row (§6.2.4).
- `docs/api/failure-codes.json` and `packages/rpc/src/PlueFailureCodes.ts`: delete codes that only deleted routes raise.
- `flows/register-repository/` and the cut modules of `flows/repository/` (`activation.ts`, `checks.ts`, `check-context.ts`, `check-receipt.ts`, `ci-policy.ts`) are deleted only where `rg` finds no importer among the kept modules (`intake.ts`, `replies.ts`, `jev-reproduction.ts`, `registry.ts`, …).
- CLI: `smthrs repo report` (registration report) is deleted with its `Definitions.ts:953` entry.
- Generated clients: regenerate `packages/backend/apiclient/client.gen.go` and the TS `ProductApi.ts` operations.
- Docs: the backend package docs (`packages/backend/docs/`) pages for deleted routes. Run `pnpm docs:sync` and `pnpm docs:check`.

## Tests
- Integration: `compose/openapi_conformance_test.go:222` (`TestOpenAPIDescribesEveryServedRoute`) passes for the install and Plue compositions, each against its own rows.
- Integration: `compose/cut_routes_test.go` (new, the C-CUT-01 backend half). For each `cuts.json` route, the install-mode router answers 404, and a deleted route is absent from `docs/api/openapi.yaml`. An `x-composition: plue` route is absent from the install router and still served by the Plue composition.
- Regression: event admission and dispatch integration suites (`services/repository_jobs*_test.go`) stay green. An outsider issue still never starts credentialed work (shared with C-SEC-03).

## Acceptance
- [C-CUT-01](../checks/C-CUT-01.md): cut routes are absent from the install's served routes and from OpenAPI.

## Risks and notes
- **Plue consumers of `/api/admin/*`:** `~/plue/apps/admin/src/commands/{user,token,status,invite}.ts` and `~/plue/apps/observe/internal/smithers/{client,analytics}.go` call `/api/admin/users`, `tokens`, `system/*`, `analytics/summary`, `agent-sessions`, `workspaces`, `sandbox/*` and `github-app/reconcile`. That is why these routes are unmounted, not deleted (§6.2.4; AGENTS.md "one backend"). Observation that confirms a mistake: Plue's admin CLI fails against a backend built from this change.
- **Repository-jobs keep/cut line:** research flags that a naive delete breaks §14 and contributor trust rules. Each route's decision above needs the owner of §14 (T-STK-09 / C-SEC-03) to agree before deletion. Falsified if C-SEC-03 fails after this ticket.
- **`/api/recommend`:** this route may also serve Jev's recommended actions. Confirm with `rg "/api/recommend" apps/app/src packages` after T-CUT-01. Delete only if no kept caller remains.
- **Generated SDK:** Plue pins the backend module and regenerates Observe's OpenAPI (research `deleted-features.md` risks). List every deleted operation in the issue for the Plue bump.

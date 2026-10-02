# T-MCH-05 Delete branch locks

Stage S2 · Size M · Depends on T-MCH-04 · Unblocks — · Issue: to file
Spec: spec.md §8.1.2, §6.2.4 · Delta: delta.md §3 (branch locks row), §10 · Product: mvp.md §8 (Branch locks: Cut), M-17

## Goal

No branch lock exists anywhere in the product: the six routes, two tables, service, client types, error code and OpenAPI paths are gone, and `rg -il 'branch.?lock'` outside migrations finds nothing.

## Scope

In:
- Delete the service, handler, routes, queries, generated code, error code, notification kind, billing/admission hook, client types, OpenAPI rows and tests in one change (AGENTS.md "zero tech debt").
- A forward-only drop migration for `branch_locks` and `branch_lock_join_requests`.

Out:
- One machine per branch (T-MCH-04, already landed).
- Presence (T-COL-06). Nothing replaces the lock: everyone on a branch shares it (spec §8.1.2).

## Changes

Deleted files:
- `packages/backend/internal/services/branch_lock.go` (503 lines) and its tests `branch_lock_test.go`, `branch_lock_repo_scope_test.go`, `branch_lock_product_integration_test.go`.
- `packages/backend/internal/routes/branch_lock.go` and `branch_lock_test.go`, `branch_lock_repo_scope_test.go`.
- `packages/backend/internal/compose/branch_lock_repo_scope_integration_test.go`.
- `packages/backend/db/product/queries/branch_locks.sql` and `packages/backend/internal/db/branch_locks.sql.go` (regenerated away by `sqlc generate`).

Edited files:
- `packages/backend/internal/compose/router.go:1385-1400`: remove the six routes. `packages/backend/internal/compose/main.go:1092-1100`: remove the handler wiring.
- `packages/backend/internal/services/billing.go:1110` `AuthorizeBranchLockJoin`, `billing_composition.go`, `packages/backend/admission/admission.go`: remove the hook from both interfaces.
- `packages/backend/internal/services/notification.go`, `notification_facts.go`, `notification_test.go`: remove the notification kind.
- `packages/backend/internal/pkg/errors/errors.go`, `registry.go`; `packages/rpc/src/PlueFailureCodes.ts`, `packages/rpc/src/plue-failure-codes.json`; `docs/api/failure-codes.json`: remove the error code.
- `packages/backend/internal/db/models.go`: regenerated.
- `docs/api/openapi/repositories.yaml`: remove the six paths; rebundle `docs/api/openapi.yaml` with `node scripts/openapi-bundle.mjs`; regenerate `packages/backend/apiclient/client.gen.go` and `packages/smithers/src/internal/backend/ProductApi.ts` with `node scripts/openapi-clients.mjs`.
- `packages/backend/db/ownership.csv`, `packages/backend/db/product/test_adopt.py`: remove the two tables.
- Router and coverage tests that enumerate routes: `compose/router_test.go`, `router_compat_test.go`, `main_cover_h_test.go`, `main_router_f_test.go`, `github_user_repos_router_test.go`, `routes/route_gap_coverage_test.go`, `db/product/review_regressions_integration_test.go`.
- `packages/backend/db/product/migrations/0105_drop_branch_locks.sql` (new; number at landing) and its ledger row in `packages/backend/db/product/migrate.go`. `0010_branch_lock_and_workflow_invocations.sql` stays, because the ledger is forward-only.

## Tests

- integration (real PostgreSQL): migrating a database that holds lock rows drops both tables and leaves `workflow_invocations` (also created by 0010) intact.
- integration: `TestOpenAPIDescribesEveryServedRoute` (`packages/backend/internal/compose/openapi_conformance_test.go:222`) passes with the six paths gone from both router and document.
- unit: the failure-code registry test and the generated-client drift checks (`scripts/check-api-baseline.mjs`) pass.
- No new behavior test: the proof is absence, checked by C-CUT-01.

## Acceptance

- [C-CUT-01](../checks/C-CUT-01.md): branch-lock routes, OpenAPI paths, error code, client types and commands are absent; the only remaining references are migrations 0010 and the new drop migration.

## Risks and notes

- Plue pins the backend module and embeds its generated OpenAPI (research/deleted-features.md "API baseline"). Removing 6 operations needs a Plue pin bump. Confirmed if Plue's Observe regeneration fails on the missing operations. File the Plue follow-up in the same change.
- `scripts/check-api-baseline.mjs` may treat removed operations as a breaking change and fail. Confirmed by running it. Record the removal in its baseline as an intended cut (mvp.md §8).
- The blast radius comes from `rg -l` (41 files including generated ones). A missed file shows up as a compile error, not a silent leftover. The final `rg -il 'branch.?lock'` is the gate.

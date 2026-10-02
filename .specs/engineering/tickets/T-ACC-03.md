# T-ACC-03 One authorizer over the permission matrix

Stage S1 · Size M · Depends on T-ACC-02 · Unblocks T-ACC-04, T-STK-04, T-FLW-08, T-FLW-12, T-MCH-04 · Issue: to file
Spec: spec.md §5.2, §5.2.1, §5.3, §5.4, §6.2.3, §6.3 (`/api/agents`), §11.5a, §15.1.4, §17.2 · Delta: delta.md §2 (Modify `repo_permissions.go` → one `Authorize`) · Product: mvp.md §6.15 "Roles", M-05, §2 rule 6, Appendix B.6

## Goal
Every served `/api` route is allowed or refused by one function, `Authorize(credential, action, subject)`, evaluating spec §5.2 for every credential kind. Delegated credentials, whoever holds them (the app agent, an external agent through the CLI or skill, a terminal session), get the same cells. A refused call gets the typed `permission` error whatever the UI shows.

## Scope
In (backend paths are under `packages/backend/internal/` unless shown in full):
- `Authorize` and its action enum, one value per §5.2 row: `install.settings`, `merge`, `approve`, `members.write`, `secrets.write`, `flow.merge`, `todo.write`, `branch.join`, `secrets.read`. `public` and `self` cover routes outside the matrix. The owner's agent model setting (`PUT /api/agents/{role}/model`, §11.5a) maps to `install.settings`.
- Delegated cells (§5.2, §15.1.5), identical for every `via`:
  - `merge` and `flow.merge`: refused with `fix: {kind: "confirmation", confirmation: "review_merge"}` when the member's own role may merge (owner or maintainer), so the caller can open the person's **Review & merge**; a plain `permission` error otherwise.
  - `approve` (flow-step approvals that gate a merge), `members.write`, `secrets.write`, `install.settings`: `never`. A plain `permission` error with no `fix`; no confirmation path exists.
  - `todo.write` and `branch.join`: allowed as the person. Which of those commands run at once and which post a one-click confirmation is the catalog's `agent` field, applied at command dispatch (T-ACC-05), not here.
- `machine` has no §5.2 row: it is refused for every row and may only report its own branch's events and read what that branch needs (§5.2). Its RPC surface (§9.1.2) is authorized by T-COL-03.
- Credential classification into the four §5.3 kinds plus the member's role. A `session` is a cookie. `delegated` reads T-ACC-04's stored kind. `run` is the per-run agent token (`middleware/agent_token.go:30`). `machine` is a system-issued token with a workspace restriction scope (`services/workspace_head.go:199-204`).
- A route→action table covering every route the install composition serves, enforced as router middleware, so a new route can't ship unmapped.
- Replace the scattered checks on the install's repository with `Authorize`:
  - secrets write (`services/secret.go:582` `requireAdminAccess`);
  - merge and land (`canLandRepo`, `repo_permissions.go:195`);
  - person-only decisions (`RequirePerson`, `RefuseRunCredentials`, `middleware/run_credential.go:145,168`; route uses at `compose/router.go:758,1137,1274,1278,1288,1317,1374`);
  - T-ACC-02's interim owner-or-maintainer check.

Out:
- Minting delegated credentials, `via`, attribution (T-ACC-04).
- Creating and approving confirmations, and per-command `agent: run | confirm | never` dispatch (T-ACC-05). This ticket only returns the `fix`.
- The S1 terminal token's scope list (T-TRM-02, §8.11.1), which narrows a terminal's delegated credential further.
- Multitenant (Plue) repository ACLs: org, team and collaborator. Plue keeps `repo_permissions.go` behind the same `Authorize` entry point (see Risks).

## Changes
- `packages/backend/internal/access/authorize.go` and `actions.go` (new): the matrix as data (row × {owner, maintainer, member, delegated, run, machine}), plus `Authorize`.
  - The run column's scoped cells are evaluated against `subject`: "answer own conflicts only" and "within its own branch".
- `packages/backend/internal/access/routes.go` (new): the route→action table and `RequireAction(action)` middleware, wired in `compose/router.go`.
- `packages/backend/internal/middleware/run_credential.go:14-31,62-77`: `CredentialKind` gains `delegated` and `machine`.
  - `TokenCredentialKind` classifies workspace-restricted system tokens as `machine`.
  - `RequirePerson` and `RefuseRunCredentials` become thin calls to `Authorize` and are deleted once no caller remains (zero tech debt).
- `packages/backend/internal/services/repo_permissions.go:183-219`: in install mode the `canAdminRepo`, `canLandRepo` and `canOwnRepo` callers for the install repository go through `Authorize`. The helpers remain only for the multitenant ACL path.
- `services/secret.go:582`: delete `requireAdminAccess`, replaced by `secrets.write`.
- Errors carry `{code, class: "permission", message, fix?}` (§6.2.3). The app's fault copy maps `permission` (`apps/app/src/mainview/flows/CommandFailureCopy.ts`).
- OpenAPI: each served operation documents its 403 envelope; no new paths.

## Tests
- Unit: `access/authorize_test.go` (new). Enumerate every row × kind × role cell against a hand-written expected table taken from §5.2 and §15.1.5, not from the implementation's data. Add the scoped run cells (its own branch vs another, its own conflict vs a question) and the delegated cells: an Owner's or Maintainer's delegated merge gets `fix.confirmation = review_merge`; a Member's gets none; `approve`, `members.write`, `secrets.write` and `install.settings` get no `fix` for any role.
- Unit, same file: the delegated cells are the same for `via` = smithers, claude-code, codex, cli and terminal.
- Unit: `access/routes_test.go` (new). Compose the install router (as `openapi_conformance_test.go:150` does) and fail on any served `/api` route without an action.
- Integration, real PostgreSQL: the C-ACC-01 suite `compose/access_matrix_integration_test.go` (new). It uses real credentials of each kind against one representative route per action.
- Regression: keep `compose/run_credential_landing_gates_integration_test.go:206` and the `run_credential_*_integration_test.go` suites green, rewritten to the new kinds.

## Acceptance
- [C-ACC-01](../checks/C-ACC-01.md): every §5.2 cell is enforced server-side for session, delegated, run and machine credentials. The delegated column passes once T-ACC-04 mints delegated tokens.

## Risks and notes
- Open (tech lead): the existing trigger routes (§11.7 [D]) have no §5.2 row. This ticket maps them to owner-only `install.settings` so no served route is unmapped; T-CUT-03 keeps them off every member door.
- §5.2 lists "approve a revision" beside merge with "confirmation only". This ticket reads it as the approval recorded by Review & merge, and treats flow-step approvals as `never` per §15.1.5.
- **Two policies behind one entry point:** install mode uses §5.2, and multitenant keeps the repository ACL. That's one seam, not two authorizers (§6.2.4 composition split). Falsified if any install-mode route still calls `canLandRepo` or `canAdminRepo` directly (`rg` over `services/`).
- About 100 call sites use the `can*Repo` helpers (`rg -c` over `services/`). Migrate only the §5.2 actions here. Read and write repository access stays membership-based (T-ACC-02).

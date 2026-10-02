# T-ACC-03 One authorizer over the permission matrix

Stage S1 · Size M · Depends on T-ACC-02 · Unblocks T-ACC-04, T-STK-04, T-FLW-08, T-FLW-12, T-MCH-04 · Issue: to file
Spec: spec.md §5.2, §5.2.1, §5.3, §5.4, §6.2.3, §6.3 (`/api/agents`), §11.5a, §15.1.4, §17.2 · Delta: delta.md §2 (Modify `repo_permissions.go` → one `Authorize`) · Product: mvp.md §6.15 "Roles", M-05, §2 rule 6, Appendix B.6

## Goal
Every served `/api` command is authorized by `Authorize(credential, command, subject)` from the literal catalog descriptors (§5.2.1), including actor eligibility, minimum role, credential scope and agent policy. Forbidden delegated commands return 403 `never`; scope or role failures return 403 `permission`; eligible confirmable commands create a confirmation through T-ACC-05 and return 202 with its id. Checks: C-ACC-01, C-ACC-02.

## Scope
In (backend paths are under `packages/backend/internal/` unless shown in full):
- `Authorize` reads each command’s catalog descriptor (§6.1.2b), not a coarse `todo.write` or `branch.join` permission that loses amend, commit or add-to-stack policy. Every served route declares its command id; `public` and `self` cover non-command authentication routes. C-ACC-01 audits all route mappings.
- Delegated cells (§5.2, §15.1.5), identical for every `via`:
  - `merge` and `flow.merge`: return an internal confirmation-required decision only when the requesting member is owner or maintainer and its scope permits confirmations. T-ACC-05 turns that decision into `202 {confirmation: id, state: "requested"}` with kind `review_merge`; it is never an HTTP 403 with a confirmation fix.
  - `approve`, `members.write`, `secrets.write`, `install.settings`: delegated policy `never`. An eligible delegated member gets 403 `never`; an insufficient role or scope gets 403 `permission`. Neither creates a confirmation.
  - TODO and branch commands retain their individual catalog ids. Apply `run` or return the internal confirmation-required decision for `confirm`; T-ACC-05 creates the row before returning 202. C-ACC-01 exercises each command, not one representative per broad row.
- `machine` has no §5.2 row: it is refused for every row and may only report its own branch's events and read what that branch needs (§5.2). Its RPC surface (§9.1.2) is authorized by T-COL-03.
- Credential classification into the four §5.3 kinds plus the member's role and, for the owner, the provisional state (§5.1.0): a provisional owner's session is refused every action except the setup steps, with `owner_unverified`. A `session` is a cookie. `delegated` reads T-ACC-04's stored kind. `run` is the per-run agent token (`middleware/agent_token.go:30`). `machine` is a system-issued token with a workspace restriction scope (`services/workspace_head.go:199-204`).
- A route→action table covering every route the install composition serves, enforced as router middleware, so a new route can't ship unmapped.
- Replace the scattered checks on the install's repository with `Authorize`:
  - secrets write (`services/secret.go:582` `requireAdminAccess`);
  - merge and land (`canLandRepo`, `repo_permissions.go:195`);
  - person-only decisions (`RequirePerson`, `RefuseRunCredentials`, `middleware/run_credential.go:145,168`; route uses at `compose/router.go:758,1137,1274,1278,1288,1317,1374`);
  - T-ACC-02's interim owner-or-maintainer check.

Out:
- Minting delegated credentials, `via`, attribution (T-ACC-04).
- Confirmation storage and session approval belong to T-ACC-05. The authorizer returns a typed internal decision; the dispatcher must consume it before any route handler runs (§5.2.1).
- The S1 terminal token's scope list (T-TRM-02, §8.11.1), which narrows a terminal's delegated credential further.
- Multitenant (Plue) repository ACLs: org, team and collaborator. Plue keeps `repo_permissions.go` behind the same `Authorize` entry point (see Risks).

## Changes
- `packages/backend/internal/access/authorize.go` and `actions.go`: load catalog descriptor fields and evaluate member role, credential scope, actor eligibility and delegated policy in §5.2.1 order. C-ACC-01 uses the catalog artifact as its independent oracle, never authorizer code.
  - The run column's scoped cells are evaluated against `subject`: "answer own conflicts only" and "within its own branch".
- `packages/backend/internal/access/routes.go` (new): the route→action table and `RequireAction(action)` middleware, wired in `compose/router.go`.
- `packages/backend/internal/middleware/run_credential.go:14-31,62-77`: `CredentialKind` gains `delegated` and `machine`.
  - `TokenCredentialKind` classifies workspace-restricted system tokens as `machine`.
  - `RequirePerson` and `RefuseRunCredentials` become thin calls to `Authorize` and are deleted once no caller remains (zero tech debt).
- `packages/backend/internal/services/repo_permissions.go:183-219`: in install mode the `canAdminRepo`, `canLandRepo` and `canOwnRepo` callers for the install repository go through `Authorize`. The helpers remain only for the multitenant ACL path.
- `services/secret.go:582`: delete `requireAdminAccess`, replaced by `secrets.write`.
- Refusals use §6.2.3’s error envelope with class `permission` for scope/role failures and `never` for eligible forbidden delegation. Confirmation-required is an internal decision, consumed into HTTP 202 with a confirmation id, never a refusal fix. C-ACC-01 verifies the exact status and class.
- OpenAPI: each served operation documents its 403 envelope; no new paths.

## Tests
- Unit: `access/authorize_test.go` exercises each literal catalog command descriptor across credential kinds, member roles and scopes, including own conflict/branch restrictions. An eligible delegated merge returns the internal confirmation-required decision; insufficient role returns permission; eligible forbidden delegation returns never. The oracle is catalog.mvp.json validated by C-CAT-01, not a second transcription of §5.2.
- Unit, same file: the delegated cells are the same for `via` = smithers, claude-code, codex, cli and terminal. A provisional owner's session is refused every row except the setup steps (`owner_unverified`).
- Unit: `access/routes_test.go` (new). Compose the install router (as `openapi_conformance_test.go:150` does) and fail on any served `/api` route without an action.
- Integration, real PostgreSQL: C-ACC-01 exercises every retained command and in-card action across its served dispatch doors with real credentials, not one representative per broad action.
- Regression: keep `compose/run_credential_landing_gates_integration_test.go:206` and the `run_credential_*_integration_test.go` suites green, rewritten to the new kinds.

## Acceptance
- [C-J10-07](../checks/C-J10-07.md): `main.reset-to-github` requires the Owner's session, with no delegated confirmation. C-ACC-01 also proves Owner-only GitHub App changes.
- [C-ACC-01](../checks/C-ACC-01.md): every §5.2 cell is enforced server-side for session, delegated, run and machine credentials. The delegated column passes once T-ACC-04 mints delegated tokens.

## Risks and notes
- Open (tech lead): the existing trigger routes (§11.7 [D]) have no §5.2 row. This ticket maps them to owner-only `install.settings` so no served route is unmapped; T-CUT-03 keeps them off every member door.
- Merge records a person’s approval only through Review & merge. Standalone merge-gating approval commands are person-only, agent policy never (§5.2.1, §15.1.5); no confirmation path exists for them.
- **Two policies behind one entry point:** install mode uses §5.2, and multitenant keeps the repository ACL. That's one seam, not two authorizers (§6.2.4 composition split). Falsified if any install-mode route still calls `canLandRepo` or `canAdminRepo` directly (`rg` over `services/`).
- About 100 call sites use the `can*Repo` helpers (`rg -c` over `services/`). Migrate only the §5.2 actions here. Read and write repository access stays membership-based (T-ACC-02).

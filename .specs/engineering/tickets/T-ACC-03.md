# T-ACC-03 One authorizer over the permission matrix

Stage S1 · Size M · Depends on T-ACC-01, T-CAT-01 · Unblocks T-ACC-04, T-STK-04, T-FLW-08, T-FLW-12, T-MCH-04, T-COL-02, T-APP-21 · Issue: to file
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

- Out of scope: new command behavior, catalog generation (T-CAT-01), app views, machine RPC, confirmation approval/storage, credential minting, new engine APIs, and changing Plue ACL policy.

## Changes
- `packages/backend/internal/access/authorize.go` and `actions.go` (both new; absent today): load catalog descriptor fields and evaluate member role, credential scope, actor eligibility and delegated policy in §5.2.1 order. C-ACC-01 uses committed, reviewed literal request/result fixtures as its oracle; the catalog is an input under test, not the source of expected results at runtime.
  - The run column's scoped cells are evaluated against `subject`: "answer own conflicts only" and "within its own branch".
- `packages/backend/internal/access/routes.go` (new): the route→action table and `RequireAction(action)` middleware, wired in `compose/router.go`.
- `packages/backend/internal/middleware/run_credential.go:14-31,62-77`: `CredentialKind` gains `delegated` and `machine`.
  - `TokenCredentialKind` classifies workspace-restricted system tokens as `machine`.
  - `RequirePerson` and `RefuseRunCredentials` become thin calls to `Authorize` and are deleted once no caller remains (zero tech debt).
- `packages/backend/internal/services/repo_permissions.go:183-219`: in install mode the `canAdminRepo`, `canLandRepo` and `canOwnRepo` callers for the install repository go through `Authorize`. The helpers remain only for the multitenant ACL path.
- `services/secret.go:582`: delete `requireAdminAccess`, replaced by `secrets.write`.
- Refusals use §6.2.3’s error envelope with class `permission` for scope/role failures and `never` for eligible forbidden delegation. Confirmation-required is an internal decision, consumed into HTTP 202 with a confirmation id, never a refusal fix. C-ACC-01 verifies the exact status and class.
- OpenAPI: each served operation documents its 403 envelope; no new paths.

## Decisions and pre-review
- Before start, smithers-3f approves the install/Plue split, route coverage and credential classification. smithers-b8 approves public status/error contracts and dispatch bindings; smithers-38 approves catalog artifact consumption across the TypeScript/Go boundary. smithers-8a accepts the shared seam and the owner-only mapping for retained trigger routes. Will decides product-policy exceptions; none are implied by that mapping.
- T-CAT-01 must land first to supply literal descriptors. T-ACC-04 and T-ACC-05 are downstream, not dependencies: reject unknown credential kinds and fail closed before the handler if a confirmation-required decision has no installed confirmation consumer. Return a typed unavailable error, never success or a fabricated 202. T-ACC-05 must replace that guard and persist a private confirmation before enabling confirmable dispatch. No acceptance row for unmintable delegated credentials or unavailable confirmations counts as passed.
- This authorizer does not execute repository code. It authorizes flow/run doors before dispatch; execution still requires the machine-only guard of §1.3. smithers-3f reviews that ordering and verifies machine credentials cannot enter person command handlers (C-ACC-01).

## Tests
- Unit: `access/authorize_test.go` exercises each catalog command across credential kinds, member roles and scopes, including own conflict/branch restrictions. Reviewed literal fixtures assert confirmation-required, permission and never results. Test expectations do not come from spec Markdown, catalog descriptors or authorizer code at runtime; catalog freshness and policy equality are separate checks.
- Unit, same file: the delegated cells are the same for `via` = smithers, claude-code, codex, cli and terminal. A provisional owner's session is refused every row except the setup steps (`owner_unverified`).
- Unit: `access/routes_test.go` (new). Compose the install router (as `openapi_conformance_test.go:150` does) and fail on any served `/api` route without an action.
- Integration, real PostgreSQL: C-ACC-01 exercises every retained command and in-card action across its served dispatch doors with real credentials, not one representative per broad action.
- Regression: keep `compose/run_credential_landing_gates_integration_test.go:206` and the `run_credential_*_integration_test.go` suites green, rewritten to the new kinds.

- Boundary integration in `compose/access_matrix_integration_test.go` (C-ACC-01): send reviewed literal request/result cases through the composed install router and production command dispatcher; observe database changes and fake GitHub writes. Enumerate served routes only to measure coverage, never to generate expected policy. Include public/self routes, provisional owner, denied machine actions and retained trigger routes. Read no spec file or implementation-derived expected policy at runtime. Real delegated-token minting and persisted 202 cases become mandatory when T-ACC-04/T-ACC-05 land; until then test the guard and report those full-check rows pending.

## Acceptance
- [C-J10-07](../checks/C-J10-07.md): `main.reset-to-github` requires the Owner's session, with no delegated confirmation. C-ACC-01 also proves Owner-only GitHub App changes.
- [C-ACC-01](../checks/C-ACC-01.md): every §5.2 cell is enforced server-side for session, delegated, run and machine credentials. The delegated column passes once T-ACC-04 mints delegated tokens.
- [C-J1-04](../checks/C-J1-04.md): First TODO to merged PR, unassisted, within 60 minutes of starting the install

## Risks and notes
- Open (tech lead): the existing trigger routes (§11.7 [D]) have no §5.2 row. This ticket maps them to owner-only `install.settings` so no served route is unmapped; T-CUT-03 keeps them off every member door.
- Merge records a person’s approval only through Review & merge. Standalone merge-gating approval commands are person-only, agent policy never (§5.2.1, §15.1.5); no confirmation path exists for them.
- **Two policies behind one entry point:** install mode uses §5.2, and multitenant keeps the repository ACL. That's one seam, not two authorizers (§6.2.4 composition split). Falsified if any install-mode route still calls `canLandRepo` or `canAdminRepo` directly (`rg` over `services/`).
- About 100 call sites use the `can*Repo` helpers (`rg -c` over `services/`). Migrate only the §5.2 actions here. Read and write repository access stays membership-based (T-ACC-02).

## Ready checklist
1. Dependencies: T-ACC-01 supplies the member-reader and role/active-status type contract; T-CAT-01 supplies literal descriptors. C-ACC-01 uses real PostgreSQL member and credential fixtures; roster mutation endpoints are not prerequisites. Unknown credential kinds and absent confirmation consumers fail closed until downstream integrations land.
2. Exclusions: minting, confirmation storage/approval, terminal scopes, machine RPC, new command behavior, UI and Plue policy changes are explicit.
3. Tests: C-ACC-01 uses production routes/dispatch with reviewed literal outcomes; route enumeration measures coverage only. Later delegated/confirmation rows remain pending.
4. Decisions: smithers-3f approves backend policy seams, smithers-b8 public contracts, smithers-38 catalog consumption; smithers-8a accepts seam/trigger mapping and Will decides product exceptions.
5. Owner pre-review: smithers-3f: Does every install route authorize before side effects while preserving Plue ACLs? Does an absent confirmation consumer fail closed? smithers-b8: Are status/classes and command bindings complete? smithers-38: Is the catalog artifact consumed without a duplicate runtime policy table?
6. Security: no repository execution is added; smithers-3f reviews authorization-before-dispatch and refusal of machine/run credentials outside their subjects; machine execution remains required by §1.3.

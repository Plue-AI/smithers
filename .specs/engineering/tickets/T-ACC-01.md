# T-ACC-01 GitHub sign-in creates the owner; delete the single-owner password path

Stage S1 · Size M · Depends on first merge: —; rest of S1: — · Unblocks T-ACC-02, T-ACC-03, T-FLW-08, T-GH-01, T-INS-02, T-INS-04, T-INS-06, T-INS-08, T-REL-02, T-STK-04 · Issue: [#3443](https://github.com/smithersai/smithers/issues/3443)
Spec: spec.md §5.1.0–§5.1.2, §3 (`collaborators`, `install_settings`), §16.2 step 3, §16.3.3 · Delta: delta.md §2 (Delete row) · Product: mvp.md J1.1, J1.2, J1.8, §6.2, M-05, M-17
Edited by the minimal-code synthesis, 2026-10-03 (v2 ruling 1; v1 §6): owner and members live on `collaborators`; GH-01's second setup login is deleted here.

## Goal
On a fresh install the first GitHub sign-in from a setup session becomes the owner, on any known origin, and that owner can do only setup until GitHub confirms push access on the chosen repository. Every later sign-in is checked against the roster and live GitHub push permission, and no password or local-auth route exists. This ticket is on the thin path and starts on day 1.

## Scope
First merge: Claim the owner and create its collaborator row; owner-only routes suffice. Check: C-J1-04.
Later dependency integrations land dark until their providers and phase checks pass.
In:
- The owner is the existing `self_host_owners` row (one owner, `0004_single_owner_identity.sql:3`) plus a `collaborators` row with `admin` (`0001_product_baseline.sql:2605`), so the existing `can*Repo` helpers (`services/repo_permissions.go:114-207`) apply. No `members` table (v2 ruling 1). `users` stays the identity row that sessions and tokens reference.
- The one-time setup token (§5.1.0). The backend mints it while no owner exists and stores only its digest in `install_settings`. The launcher prints the setup URL for `http://localhost:4000` and each configured origin (T-INS-02), and `smthrs host start` prints it at install time (T-INS-08).
- Setup sessions (§5.1.0): the token exchanges for an HttpOnly setup-session cookie stored as a digest (`setup.session.<digest>`, 24 h idle expiry). Any number may exist, and each reaches only `GET /api/install`, the setup steps before the claim and the OAuth start and callback.
- Owner claim (§5.1.0): the OAuth callback with a setup-session cookie runs one transaction that deletes the token digest (aborting if it is gone), inserts the owner row, deletes every setup session and mints a `session` credential. Other setup sessions and replays get `401 setup_closed`. A sign-in without a setup session while no owner exists is refused. Any known origin works, so the owner may finish setup from a laptop on the LAN (J1.1).
- Provisional owner (§5.1.0): until the §5.1.2 check passes, the member boundary (and `Authorize` once T-ACC-03 lands) allows only setup steps and refuses the rest with `owner_unverified`. After the App is installed, the host reads the installation with the App JWT (`GET /repos/{owner}/{repo}/installation`), never from a callback parameter, records repository and installation, and runs the check; a pass sets `last_access_check_at`. On the thin path the App, repository and installation come from env, so the check runs at the callback.
- Sign-in gate (§5.1.2) with the roster reduced to the owner: owner ∧ `push` or higher, read with the installation token.
- GitHub App credentials for the thin path come from env (today's `auth.github_client_id`, client secret and `SMITHERS_GITHUB_APP_*`), so this ticket doesn't wait for T-GH-01. When T-GH-01 lands, the install composition reads its sealed store instead, and T-GH-01 moves the env reader behind Plue's composition.
- A member boundary that replaces `SingleOwnerBoundary` on HTTP, SSE and git with one `AuthorizeMember(ctx, userID)` seam. T-ACC-02 widens it to the roster.
- Delete the local password owner path end to end: backend, CLI, app, OpenAPI, docs.

Out:
- Adding members, roles, hourly recheck, `/api/members` (T-ACC-02).
- The permission matrix (T-ACC-03) and credential kinds (T-ACC-04).
- `RejectTenantProvisioning` (`packages/backend/internal/middleware/single_owner.go:21`) stays: `/api/orgs*` remains 404 on the install (T-CUT-03).
- App manifest flow and sealed App credentials (T-GH-01). The setup card (T-APP-03) and setup steps (T-INS-06).

## Changes
- Reuse `self_host_owners` (`0004_single_owner_identity.sql:3`) as the one-owner record; the claim also inserts the owner's `collaborators` row through the uncalled `AddCollaborator` (`queries/repos.sql:313`). T-ACC-02 adds the `github_id`, `unix_uid` and `suspended_at` columns. Drop only `local_credentials` (`0004:9`).
- Reuse `services/install_setup_session.go` and the cookie exchange in `routes/github_app_setup.go` as the only setup login; T-ACC-01 owns expiry and claim invalidation. Keep the manifest and sealed App credentials.
- Reshape the existing bootstrap token: backend mint, constant-time verification, digest in `install_settings`, single-use owner claim. Keep the launcher’s bootstrap-token handling; extend the existing setup-session service for expiry and atomic claim invalidation.
- `packages/backend/internal/services/auth.go:599-621` (`resolveOAuthUser`): in install mode, stop refusing "external identity is not linked to the installation owner". Load or create the `users` row, then call the gate in `members.go`. The setup-session cookie, on the callback's effective origin (§16.3.3), identifies the setup session. The token never appears in the OAuth `state` or in any URL after the exchange.
- `packages/backend/internal/services/members.go` (new; T-ACC-02 extends it over `collaborators`): `ClaimOwner(setupSession, githubUser)`, `VerifyOwner(repository)` and `AdmitSignIn` (owner check plus GitHub permission; a provisional owner skips the check and stays provisional). Reuse one permission lookup extracted from `services/github_issue_text_writer.go:144-170`; do not copy it. The lookup reads `role_name` as well as `permission`, because `maintain` reads as `write` today (`:165`).
- Reshape `identity/single_owner.go` into the member boundary at its existing five call sites; retain the singleton owner record.
- Delete `/api/auth/local/{status,bootstrap,login,token,password}` (`compose/router.go:919-924`) and their handlers in `routes/auth.go`; `services/local_identity.go` (including `ValidateLocalIdentityStartup`, `:73`) and its tests; `db/product/queries/local_identity.sql`; then regenerate sqlc.
- GitHub OAuth for the install keeps reading the client id and secret from `auth.github_client_id` (`config.go:362-365`) on the thin path; T-GH-01 replaces that read with `OAuthClient()`.
- CLI: delete `smthrs auth local login|bootstrap` (`packages/smithers/src/internal/backend/Auth.ts:233-280`), the `"auth local"` group (`Commands.ts:72`), and its local-auth calls in `ProductApi.ts`.
- App: delete `apps/app/src/mainview/LocalAuthPanel.tsx` and its test, and its use in `SessionNavigation.tsx`. Remove the local branch of `state/IdentityProvider.ts` and `packages/rpc/src/ApplicationAuth.ts`. Sign-in is one "Sign in with GitHub" door.
- OpenAPI: delete the `/api/auth/local/*` rows in `docs/api/openapi/authentication.yaml:425-592`, then re-bundle with `scripts/openapi-bundle.mjs`. `openapi_conformance_test.go:222` stays green.
- Docs: replace the bootstrap-token steps in `apps/site/src/content/docs/docs/self-hosting.mdx` with the setup URL. Run `pnpm docs:sync` and `pnpm docs:check`.

## Tests
- Integration, real PostgreSQL (`testkit/postgresfixture`) plus an httptest GitHub fake: `packages/backend/internal/compose/owner_signin_integration_test.go` (new). Cases:
  - a sign-in from a setup session creates exactly one owner, on the loopback origin and, in a second run, on a configured LAN origin;
  - a sign-in without the token, or with a wrong one, while no owner exists is refused, and no owner is created;
  - two setup sessions claiming at once yield one owner and one `401 setup_closed`, and no setup session survives the claim;
  - the host killed between the claim and the verification restarts with the owner still provisional at the same step;
  - the token is gone after the claim: its digest row is deleted and a replay is refused;
  - a provisional owner gets `owner_unverified` on every route outside setup; an owner without `push` on the installed repository stays provisional with "needs access on GitHub", and one with `push` becomes verified; a forged `installation_id` callback parameter is ignored;
  - a second GitHub user is refused with "not a member".
- Integration: `/api/auth/local/*` answers 404, and the backend boots in install mode without a bootstrap token, with App credentials from env only.
- Unit: `identity/member_boundary_test.go` (new) replaces `single_owner_test.go:25,37`, covering HTTP, SSE ticket and git proxy refusal for a non-member. `setup_token_test.go`: only the digest is stored.
- Migration test: an existing `self_host_owners` row keeps its owner and gains its `collaborators` admin row; `local_credentials` is gone.
- `/api/github-app/setup` accepts no setup-session cookie of its own; only this ticket's setup session reaches the App setup step.
- CLI unit: `packages/smithers/test/OneCli.test.ts` has no `auth local` group.

## Acceptance
- [C-ACC-04](../checks/C-ACC-04.md): the owner-claim and refusal rows pass here; the roster rows pass with T-ACC-02.
- [C-SEC-04](../checks/C-SEC-04.md): nobody without the setup token can claim the install, on any listener, and the token dies at the claim.
- [C-J1-04](../checks/C-J1-04.md): First TODO to merged PR, unassisted, within 60 minutes of starting the install

## Risks and notes
- The setup token replaces origin-based trust: a proxy or LAN bind in front of the install before setup can't claim it without the installer's terminal output (§5.1.0). Falsified if any claim path accepts a sign-in without the token.
- An owner whose GitHub account lacks `push` on the repository stays provisional. Observation: C-SEC-04's read-only owner. The fix is on GitHub (or another repository); owner transfer stays deferred (§5.1.4).
- delta.md §2 still lists the `/api/orgs*` 404 middleware for deletion. This ticket follows spec.md §5.1.0 and keeps the 404 (T-CUT-03).
- The thin-path journey C-J1-04 needs this ticket's owner session to merge, but it isn't this ticket's check.
- **Plue impact:** `IsSingleOwner` (`config/auth_mode.go:13`) selects the install path. Multitenant (Plue) must not change; `servedAPIRoutes` (`openapi_conformance_test.go:150`) covers both modes.

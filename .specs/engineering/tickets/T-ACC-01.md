# T-ACC-01 GitHub sign-in creates the owner; delete the single-owner password path

Stage S1 · Size M · Depends on — · Unblocks T-INS-06, T-ACC-02 · Issue: [#3443](https://github.com/smithersai/smithers/issues/3443)
Spec: spec.md §5.1.0–§5.1.2, §3 (`members`, `install_settings`), §16.2 step 3, §16.3.3 · Delta: delta.md §2 (Delete row, Add `members`) · Product: mvp.md J1.1, J1.2, J1.8, §6.2, M-05, M-17

## Goal
On a fresh install the first GitHub sign-in that carries the one-time setup token becomes the owner, on any listener. Every later sign-in is checked against the roster and live GitHub push permission, and no password or local-auth route exists. This ticket is on the thin path and starts on day 1.

## Scope
In:
- `members` table (spec §3) with the owner as its first row; `users` stays the identity row that sessions and tokens reference.
- The one-time setup token (§5.1.0). The backend mints it while no owner exists and stores only its digest in `install_settings`. The launcher prints the setup URL for each listener (T-INS-02), and `smthrs host start` prints it at install time (T-INS-05).
- Owner claim: succeeds only for a request that carries the token and completes GitHub sign-in, on any listener (loopback or a configured bind), so the owner may finish setup from a laptop on the LAN (J1.1). The claim deletes the token. A sign-in without the token while no owner exists is refused.
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
- `packages/backend/db/product/migrations/01NN_members.sql` (new, next free number): create `members` per §3 (`user_id` FK to `users`, `github_user_id UNIQUE`, `role`, `unix_uid UNIQUE` allocated from 20000, `added_by`, `added_at`, `suspended_at`, `suspended_reason`, `removed_at`, `last_access_check_at`), plus a partial unique index allowing one `role='owner'` (§2: one owner). Copy `self_host_owners.user_id` into an owner row, then drop `self_host_owners` and `local_credentials` (`0004_single_owner_identity.sql:3,9`).
- `packages/backend/internal/services/setup_token.go` (new): mint, digest, verify and delete the setup token in `install_settings`; constant-time compare; no token exists once an owner does.
- `packages/backend/internal/services/auth.go:599-621` (`resolveOAuthUser`): in install mode, stop refusing "external identity is not linked to the installation owner". Load or create the `users` row, then call the gate in `members.go`. The OAuth `state` carries the setup token through the GitHub round trip.
- `packages/backend/internal/services/members.go` (new): `ClaimOwner(token)` and `AdmitSignIn` (owner check plus GitHub permission). Reuse one permission lookup extracted from `services/github_issue_text_writer.go:144-170`; do not copy it. The lookup reads `role_name` as well as `permission`, because `maintain` reads as `write` today (`:165`).
- `packages/backend/internal/identity/single_owner.go` → delete; add `identity/member_boundary.go` (new). Rewire the five call sites: `compose/router.go:141-142`, `middleware/auth.go:128-134,277`, `middleware/sse_ticket.go:80`, `services/git_http_proxy.go:47-51,328`, `compose/main.go:376-377`.
- Delete `/api/auth/local/{status,bootstrap,login,token,password}` (`compose/router.go:919-924`) and their handlers in `routes/auth.go`; `services/local_identity.go` (including `ValidateLocalIdentityStartup`, `:73`) and its tests; `db/product/queries/local_identity.sql`; `SMITHERS_AUTH_BOOTSTRAP_TOKEN` in `packages/backend/localbootstrap/bootstrap.go:30` and `auth.bootstrap_token` in `internal/config/config.go`; then regenerate sqlc.
- GitHub OAuth for the install keeps reading the client id and secret from `auth.github_client_id` (`config.go:362-365`) on the thin path; T-GH-01 replaces that read with `OAuthClient()`.
- CLI: delete `smthrs auth local login|bootstrap` (`packages/smithers/src/internal/backend/Auth.ts:233-280`), the `"auth local"` group (`Commands.ts:72`), and its local-auth calls in `ProductApi.ts`.
- App: delete `apps/app/src/mainview/LocalAuthPanel.tsx` and its test, and its use in `SessionNavigation.tsx`. Remove the local branch of `state/IdentityProvider.ts` and `packages/rpc/src/ApplicationAuth.ts`. Sign-in is one "Sign in with GitHub" door.
- OpenAPI: delete the `/api/auth/local/*` rows in `docs/api/openapi/authentication.yaml:425-592`, then re-bundle with `scripts/openapi-bundle.mjs`. `openapi_conformance_test.go:222` stays green.
- Docs: replace the bootstrap-token steps in `apps/site/src/content/docs/docs/self-hosting.mdx` with the setup URL. Run `pnpm docs:sync` and `pnpm docs:check`.

## Tests
- Integration, real PostgreSQL (`testkit/postgresfixture`) plus an httptest GitHub fake: `packages/backend/internal/compose/owner_signin_integration_test.go` (new). Cases:
  - a sign-in carrying the setup token creates exactly one owner, on the loopback listener and, in a second run, on a LAN bind;
  - a sign-in without the token, or with a wrong one, while no owner exists is refused, and no owner is created;
  - two concurrent claims with the same token yield one owner and one refusal;
  - the token is gone after the claim: its digest row is deleted and a replay is refused;
  - an owner without `push` is refused with "needs access on GitHub";
  - a second GitHub user is refused with "not a member".
- Integration: `/api/auth/local/*` answers 404, and the backend boots in install mode without a bootstrap token, with App credentials from env only.
- Unit: `identity/member_boundary_test.go` (new) replaces `single_owner_test.go:25,37`, covering HTTP, SSE ticket and git proxy refusal for a non-member. `setup_token_test.go`: only the digest is stored.
- Migration test: an existing `self_host_owners` row becomes the owner member; the dropped tables are gone.
- CLI unit: `packages/smithers/test/OneCli.test.ts` has no `auth local` group.

## Acceptance
- [C-ACC-04](../checks/C-ACC-04.md): the owner-claim and refusal rows pass here; the roster rows pass with T-ACC-02.
- [C-SEC-04](../checks/C-SEC-04.md): nobody without the setup token can claim the install, on any listener, and the token dies at the claim.

## Risks and notes
- The setup token replaces origin-based trust: a proxy or LAN bind in front of the install before setup can't claim it without the installer's terminal output (§5.1.0). Falsified if any claim path accepts a sign-in without the token.
- delta.md §2 still lists the `/api/orgs*` 404 middleware for deletion. This ticket follows spec.md §5.1.0 and keeps the 404 (T-CUT-03).
- The thin-path journey C-J1-04 needs this ticket's owner session to merge, but it isn't this ticket's check.
- **Plue impact:** `IsSingleOwner` (`config/auth_mode.go:13`) selects the install path. Multitenant (Plue) must not change; `servedAPIRoutes` (`openapi_conformance_test.go:150`) covers both modes.

# T-GH-01 App manifest flow from localhost; sealed App credentials

Stage W0, S1 · Size M · Depends on W0: — · S1: T-INS-02 · Unblocks T-GH-02, T-GH-09, T-GH-10, T-GH-11, T-GH-12, T-GH-13, T-GH-14, T-INS-06, T-REL-02 · Issue: [#3440](https://github.com/smithersai/smithers/issues/3440)
Spec: spec.md §3 (`github_app`), §5.1.0, §5.1.1, §6.3 (`/api/install`), §12.1, §16.2 steps 1–2, §16.3.3, §17.4 · Delta: delta.md §1 (App credentials are not launcher settings), §7 · Product: mvp.md J1.2, §6.3 "GitHub App setup", M-03, §11 item 7

## Goal
On an install with no public address, the owner creates the install's GitHub App in one browser round trip from the origin the setup page is served from (`http://localhost:4000` on the Mac, or a LAN origin from a laptop) and installs it on the repository. The host then holds the App id, slug, PEM, webhook secret, client id and secret, and installation id, sealed in PostgreSQL.

## Scope
In:
- **Spike (W0, ≤ 1 day, disposable).** Run it from a second machine on the LAN as well as on the Mac. A static HTML form posts a manifest to `github.com/settings/apps/new` with `redirect_url = <setup origin>/setup/github/callback` and `setup_url = <setup origin>/setup/github/installed`, once from `http://localhost:4000` on the Mac and once from a plain-HTTP LAN origin on a laptop. Record three answers: GitHub accepts both redirects; the code converts with `POST /app-manifests/{code}/conversions`; the install redirect reaches `setup_url` with `installation_id`. If GitHub refuses a redirect, the fallback is a manual "paste App credentials" step (App id, PEM, client id and secret), validated with `GET /app` under an App JWT. Decide on day 3.
- Ordering (§16.2): setup step 0, Address (bind and public origins), comes before the App is created, because callback URLs are fixed at creation. This ticket reads the confirmed origins; T-INS-06 owns the step.
- Setup asks for the repository first, so it knows the owner (§12.1.1). A user-owned repository gets an App owned by that user (`settings/apps/new`). An organization repository gets an organization-owned App (`organizations/<org>/settings/apps/new`); when the signed-in person isn't an organization owner, setup says so and shows the URL to hand to one.
- The manifest's `redirect_url` and `setup_url` use the origin the setup page is served from (§12.1.1). It's a browser redirect, so no public address is needed.
- Manifest: permissions exactly as §12.1.2 (including `workflows: write` and `administration: read`); the webhook created inactive (`hook_attributes.active = false`); callback URLs = the configured origins plus `http://localhost:4000` (§12.1.2, §16.3.3).
- Callback URLs are fixed at creation, and GitHub has no API to edit them (§16.3.3). The install records them. When a configured origin is missing from them, the `install` model carries the manual fix: the App settings URL and the exact URL to add. T-APP-03 renders it in Settings.
- SECURITY EXCEPTION to the freeze (smithers-3f reviewed, smithers-8a routed, 2026-10-02 17:35): a single-use `state` token per attempt (≥128 random bits, stored only as its SHA-256 digest, compared in constant time, TTL 10 min) is bound to the initiating setup-session digest and effective origin, with expires_at and used_at. The production callback requires the same unexpired setup session and effective origin, and atomically consumes state (`UPDATE … SET used_at = now() WHERE digest = $1 AND used_at IS NULL AND expires_at > now() RETURNING …`) before exchanging the code. Missing, foreign, used or expired state or session is refused with a typed error, no GitHub exchange, no credential write, and no state value in logs. The setup-session cookie is SameSite=Lax, so it survives GitHub's top-level redirect back to the install. Before the claim, the setup steps need a setup session (§5.1.0, §6.3 `POST /api/install/setup/{step}`, C-GH-01).
- Code exchange, then seal and store the credentials in `github_app` (§3, §12.1.1, §17.4). One App per install: a second conversion is refused once one exists.
- Installation id from `GET /repos/{owner}/{repo}/installation` under the App JWT; the `setup_url` redirect only triggers that read, and its `installation_id` parameter is never trusted (§5.1.0, C-GH-01). Setup confirms the repository is in the installation (§12.1.3).
- One credential interface that every App caller reads, with two adapters chosen by composition: the sealed store for the install, and env credentials for Plue. Until this ticket lands, the install's thin path (T-ACC-01) reads App credentials from env; afterwards the install composition never reads them.

Out: the Setup card UI (T-APP-03); step sequencing including step 0, model access and the squash check (T-INS-06); bind and origin settings (T-INS-04); owner sign-in through the App's user authorization (T-ACC-01); polling (T-GH-02); webhook delivery to a public URL (optional, §12.2.4).

## Changes
- `packages/backend/internal/services/github_app_manifest.go` (new) → build the manifest from the confirmed origins, begin (`{action_url, manifest, state}`), convert, record the installation and the callback URLs.
- `packages/backend/internal/services/github_app_credentials.go` (new) → the interface: `Slug()`, `InstallURL()` (`https://github.com/apps/<slug>/installations/new`), `AppJWT()`, `WebhookSecret()`, `OAuthClient()`. The store adapter unseals on load and seals with `AESGCMSecretCodec` (`packages/backend/internal/webhook/secret_codec.go:21`) under the install key in `$STATE/config/secrets.json` (`packages/backend/localbootstrap/bootstrap.go:24-35`). The env adapter wraps `readGitHubAppCredentialsFromEnv` (`repo_connection_github_app.go:1028`) for Plue.
- `packages/backend/db/product/migrations/<next>_github_app.sql` (new) → singleton `github_app` with the §3 columns, plus `github_app_manifest_states(state, expires_at, used_at)`. The callback URLs go in `install_settings` (`github.callback_urls`). Queries in `packages/backend/db/product/queries/github_app.sql` (new); regenerate sqlc (`scripts/check-sqlc-drift.sh`).
- `packages/backend/internal/routes/github_app_setup.go` (new) → `GET /setup/github/callback`, `GET /setup/github/installed`, and the `github_app` step on `/api/install`. If T-INS-06 hasn't landed `/api/install`, create it with this step only.
- `packages/backend/internal/services/repo_connection_github_app.go` → callers at `:482`, `:773` and `:1017` read the interface. Delete the hard-coded `smitherspreviewrelease` fallback (`defaultGitHubAppInstallURL`, `:97`, `:1005-1011`). Keep `SMITHERS_GITHUB_APP_API_BASE_URL` (`:101`): tests point it at `githubfake`.
- `packages/backend/internal/services/github_access_diagnosis.go:59` → derive the permissions URL from the slug and owner; delete `SMITHERS_GITHUB_APP_PERMISSIONS_URL`. `:262` and `stack.go:985` read the interface.
- `packages/backend/internal/config/config.go` → `webhook.github_app_secret` (`:384,559,716`) and `auth.github_client_id`/secret (`:362-365`, read by T-ACC-01's thin path) move behind the env adapter; the install composition reads `WebhookSecret()` and `OAuthClient()` from the store.
- `packages/smithers/src/internal/backend/Repositories.ts:270` → delete the hard-coded install URL fallback.
- `apps/app/src/bun/NativeBackendProcess.ts:62-72` → pass no `SMITHERS_GITHUB_APP_*` variable; App credentials are not launcher settings (delta.md §1).
- `packages/backend/internal/githubfake/` (new) → fake GitHub server: `POST /app-manifests/{code}/conversions`, `GET /app`, `GET /repos/{owner}/{repo}/installation`, installation tokens, and an append-only write log. T-GH-02 extends it.
- `docs/api/openapi/` → rows for every new `/api` route; re-bundle with `pnpm exec smithers-build run '//:openapiBundle'`. `packages/backend/docs/github-app.md` (new); `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/backend:docs`.

## Tests
- Security (exception above): two concurrent callbacks carrying one `state` produce exactly one GitHub code exchange; a foreign setup session, a different effective origin, a used state and an expired state are each refused with a typed error, no exchange and no credential write; the state value never appears in logs; the database holds only its digest.
- Unit, `github_app_manifest_test.go` (new): the manifest's permissions equal §12.1.2 exactly (golden file); the webhook is inactive; callback URLs equal the configured origins plus `http://localhost:4000`; the redirect and setup URLs use the requesting setup origin, localhost or LAN; the App name fits GitHub's 34-character limit; the user or organization action URL follows the repository owner.
- Unit: a used, expired or foreign `state` is refused, and the code is never exchanged.
- Unit: an origin added after creation produces the fix `{settings_url, add_url}`; an origin already registered produces none.
- Integration, real PostgreSQL + `githubfake` (`github_app_credentials_integration_test.go`, new): conversion stores sealed values; a `pg_dump` contains no `BEGIN RSA PRIVATE KEY` and no client secret; a restart reloads the store; a second conversion is refused.
- Integration: before the claim, a setup step request without a setup session is refused on every listener (C-GH-01).
- Integration: the install composition with `SMITHERS_GITHUB_APP_*` set still reads the store; the Plue composition reads env.
- e2e and spike: [C-GH-01](../checks/C-GH-01.md).

## Acceptance
- [C-GH-01](../checks/C-GH-01.md): from a fresh install on the reference host, the manifest flow (or the recorded fallback) completes from `http://localhost:4000` and from a LAN origin with no public address, and the stored App matches §12.1.2.
- [C-J1-04](../checks/C-J1-04.md): First TODO to merged PR, unassisted, within 60 minutes of starting the install

## Risks and notes
- Risk: GitHub refuses `http://localhost` or a plain-HTTP LAN host as a manifest `redirect_url`. Confirmed by the spike's GitHub error page. Then ship the paste fallback for that origin; the tech lead updates overview.md.
- Risk: GitHub drops `default_events` for an App whose webhook is inactive, so the optional webhooks (§12.2.4) would need events added on GitHub later. Confirmed when `GET /app` returns an empty `events` list. Polling is unaffected (M-03).
- Risk: GitHub App names are unique across GitHub. Confirmed by "Name is already in use". The default name carries a short random suffix, and the owner can edit it on GitHub's page.
- Risk: Plue may rely on the `smitherspreviewrelease` fallback. Confirm with `rg smitherspreviewrelease ~/plue` before landing; Plue then sets the variable explicitly.

# T-GH-01 GitHub App setup: rework the landed manifest flow onto one token minter; setup order, durable step, manual fallback, App identity

Stage W0, S1 · Size M · Depends on W0: — · S1: T-INS-02, T-INS-04, T-ACC-01 · Unblocks T-APP-03, T-GH-02, T-GH-09, T-INS-06, T-REL-02 · Issue: [#3440](https://github.com/smithersai/smithers/issues/3440)
Spec: spec.md §3 (`github_app`), §5.1.0, §5.1.1, §6.3 (`/api/install`), §12.1, §16.2 steps 1–2, §16.3.3, §17.4 · Delta: delta.md §1, §7 · Product: mvp.md J1.2, §6.3 "GitHub App setup", M-03, M-28, §11 item 7
Ready: 2026-10-03 smithers-8a sha256:f97663b49e26

Rescoped by the minimal-code synthesis, 2026-10-03 (v1 §6 token minters, §7 merges; v2 ruling 6). Absorbs T-GH-01 ([#3616](https://github.com/smithersai/smithers/issues/3616)), T-GH-01 ([#3617](https://github.com/smithersai/smithers/issues/3617)), T-GH-01 ([#3618](https://github.com/smithersai/smithers/issues/3618)), T-GH-01 ([#3619](https://github.com/smithersai/smithers/issues/3619)) and T-GH-01 ([#3620](https://github.com/smithersai/smithers/issues/3620)). In the first-merge set as "T-GH-01 (rework)".

## Goal
The manifest flow landed in d3915e36f keeps working from `http://localhost:4000` and a LAN origin, and every GitHub App caller mints installation tokens through one function. Setup runs Address, account, App, claim, repository in that order, the App step is durable and single-start, and a recorded redirect refusal has a validated manual fallback.

## Scope
In: the rework below; setup ordering (from GH-11); the durable `app` step and literal manifest fixtures (GH-12); the manual fallback on either origin (GH-13); App identity for attribution (GH-14).
Out: the second setup login (`install_setup_session.go`, cookie path in `routes/github_app_setup.go`), deleted by T-ACC-01; the general setup-step engine (T-INS-06); polling (T-GH-02); outbound writes (T-GH-09); Setup card UI (T-APP-03).

## Changes
- Keep (landed d3915e36f): `services/github_app_manifest.go`, `services/github_app_credentials.go`, the `github_app` migration, `internal/githubfake/`, the single-use `state` security exception and server-derived installation id.
- Reshape, token minters 7 → 1: `RepoConnectionService.CreateGitHubInstallationToken` (`services/repo_connection_github_app.go:244`) and its scoped variants (`:282`, `:324`, `:454`) are the only minter. Delete the mint in `github_app_manifest.go:486` and the raw one in `stack.go:1002`; `github_proxy.go`, `github_check_runs.go:225` and `mythical_github.go:157,165,301` take the issuer by interface. `scripts/github-app-auth.mjs` stays operator-side.
- Reshape: replace `discoverInstallation` (`github_app_manifest.go:441-515`) with `GitHubUserReposService.lookupRepoInstallation` (`github_access_diagnosis.go:255`).
- Reshape: delete the hand-built client `GitHubAppManifestService.request` (`github_app_manifest.go:390`); call `landingGitHubAPI.request` (`landing_github_pull.go:421`).
- Reshape (from GH-11, GH-12): serve only `POST /api/install/setup/app`, with no `github_app` alias; T-INS-06 adopts the handler under its `{step}` route. Begin refuses until Address is confirmed (T-INS-04). Account choice precedes App creation; repository selection follows the owner claim (T-ACC-01). Step state is `install_settings` keys with compare-and-set (`github_app_manifest.go:354,378`); conversion commits sealed credentials, callback configuration and step completion in one transaction. No source durable cursors writer (v2 ruling 2).
- Reshape (from GH-13): the same route accepts the manual payload `{app_id, slug, pem, client_id, client_secret, webhook_secret, callbacks_confirmed[]}`, validates it with an App JWT `GET /app`, seals it, and never marks the step done before validation. Declare it in `docs/api/openapi/install.yaml`.
- Use as is (from GH-14): canonical App id and slug already come from the sealed store (`github_app_credentials.go:146`) and from the env adapter's lazy, cached `GET /app` validation (`:335-377`). Add only the tests below.
- New: none.

## Tests
- Security: two concurrent callbacks with one `state` make one exchange; foreign session, other origin, used and expired state each refuse with no exchange or credential write; logs and `pg_dump` hold no state value, PEM or secret.
- Unit: literal manifest permissions (§12.1.2), inactive webhook, callback URLs, user and organization action URLs, missing-origin fix.
- Integration, real PostgreSQL and `githubfake`, through the production router: begin before Address makes no GitHub request; two concurrent starts run one begin; restart after conversion keeps `app=done` and one App; `POST /api/install/setup/github_app` is 404.
- Integration: every caller's request log shows tokens from the one minter; no other code path posts to `/access_tokens`.
- Integration: manual fallback for a localhost refusal and a LAN refusal separately; missing fields or callbacks refuse with HTTP 400 naming the field and echoing no secret.
- Integration: Plue's env adapter makes no `GET /app` at boot, validates at the first caller, caches success, never caches failure, and ignores a poisoned env slug.

## Acceptance
- [C-GH-01](../checks/C-GH-01.md): manifest flow or recorded fallback from localhost and a LAN origin; durable single-start step; stored identity selected after restart.
- [C-J1-02](../checks/C-J1-02.md): Address, account, claim, repository order in the browser.
- [C-GH-09](../checks/C-GH-09.md): App-attributed events, evidenced jointly when T-GH-09 consumes the identity.
- [C-J1-04](../checks/C-J1-04.md).

## Risks and notes
- Risk: GitHub refuses a plain-HTTP redirect. Confirmed by the spike's error page; the manual fallback covers that origin.
- Risk: Plue relies on `smitherspreviewrelease`. Check `rg smitherspreviewrelease ~/plue` before deleting the fallback.
- smithers-3f reviews the minter collapse and the security tests; the d3915e36f security tests stay.

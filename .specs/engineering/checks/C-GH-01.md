# C-GH-01 The App manifest flow completes from localhost with no public address

Proves: mvp.md J1.2, §6.3 "GitHub App setup", M-03, M-28 · spec.md §3 (`github_app`), §5.1.0, §12.1, §16.2 steps 1–2, §16.3.3, §17.4 · Layer: e2e · Stage: W0, S1 · Tickets: T-GH-01
Automation: to write, as a `smthrs test` target · Runs in: recorded manual (W0), reference host (S1)

## Setup
- Reference host with a fresh `$STATE`, install at the commit under test. Settings has a LAN bind address and one plain-HTTP LAN origin (T-INS-04). No reverse proxy, tunnel or router port forwarding, so the install has no public address.
- A GitHub test account that owns the organization `smithers-mvp-canary`, signed in on the Mac's browser. Scratch repository `smithers-mvp-canary/<date>` with squash merging allowed. No Smithers App exists for the organization.
- No `SMITHERS_GITHUB_APP_*` variable in the launchd environment. The setup token printed by `smthrs host start` is at hand.

- Pin localhost, http://lan-a:4000 and https://box.example origin/callback fixtures and the nine permissions reviewed in T-GH-12. Drive production setup/OAuth routes with real PostgreSQL; no runtime .specs reads or production-derived expectations. smithers-8a accepts these fixed fixtures.

Candidate Automation declaration (unapproved): W0: the disposable T-GH-01 form, recorded manually. S1: `apps/app/e2e/real/github-j10/app-manifest.spec.ts` (new), driving a signed-in GitHub profile · Runs in: recorded manual (W0), reference host (S1)

Receipt: CI's own check run at the landed SHA, or a `smthrs test` run on the reference host, recorded through `scripts/check-run.mjs` (minimal-code synthesis ruling 3).

## Steps
- Adopted T-GH-12 boundary cases: Use production setup/callback routes and independent GitHub request counts. Expired and claim-invalidated durable setup sessions, foreign/replayed state and invalid origin each make zero outbound exchanges. Race two starts, crash after durable CAS and around callback conversion/local commit, and assert one begin, single-use state and all-or-none sealed credentials/configuration/completion/projection; restart preserves done and prevents overwrites

1. Record `lsof -nP -iTCP -sTCP:LISTEN` for the host processes and the configured origins.
2. Open the token-backed setup session on http://localhost:4000, complete Address, choose the owning user or organization account, and start Create GitHub App. Do not select a repository yet.
3. Create the App on GitHub and record the prefilled form.
4. Return through /setup/github/callback, then sign in through /api/auth/github/callback to claim the owner. A non-setup request returns owner_unverified.
5. Select the scratch repository, install the App on it, return through /setup/github/installed, and verify repository access using the server-derived installation id.
6. Read `GET /app` (App JWT) and `GET /installation/repositories` (installation token) through the test harness.
7. Run `pg_dump` on the install database and search it for `PRIVATE KEY`, the client secret and the webhook secret.
8. Restart the host (`launchctl kickstart -k`). Mint an installation token.
9. Load the step 4 callback URL again.
10. In a fresh unclaimed install, from a second Mac, call `POST /api/install/setup/app` at the LAN origin without the setup token.
11. Delete the App on GitHub and start a fresh `$STATE`. Repeat steps 2–5 from the second Mac at the LAN origin with the setup URL printed for that listener (§5.1.0).

W0 uses T-GH-01's disposable manifest form at localhost and plain-HTTP LAN origins. On a recorded refusal at either origin, exercise T-GH-13's complete manual fallback: App id/slug, PEM, client id/secret, webhook secret and confirmed OAuth callback registrations, validated with authenticated GET /app.

- Boot the production Plue credential composition with env App id/private key, no env slug and githubfake unavailable. Record zero identity-validation requests during boot. At the first production installation credential caller, return an authenticated GET /app response with literal id/slug; assert the request JWT issuer, returned canonical identity and successful credential use. Call again and assert no second identity request. Restart and assert validation repeats only at the first caller. A poisoned env slug cannot override the authenticated response.
- At that production caller, return GET /app failure, a response id different from the configured env id, and missing canonical identity. Assert refusal with no installation lookup or token-mint request. A later successful response supplies identity; a failed validation is not cached as success. Use independent request logs and literal fixtures.
- Invoke the app setup path and the rejected github_app alias through the production router; inspect route registrations and OpenAPI.
- Submit manual App setup through `POST /api/install/setup/app` with literal `{app_id, slug, pem, client_id, client_secret, webhook_secret, callbacks_confirmed[]}`. Compare callbacks with the `GET /api/install` URL set; omit each field and URL in separate cases.

## Pass when
- Commit the durable app-step CAS to running before beginning external App creation. Validate durable setup session, state and effective origin before any outbound exchange. Consume callback state durably before the remote exchange; do not claim remote/local atomicity. After successful exchange, commit sealed credentials, callback configuration, app-step completion and its projection in one local transaction. A failed transaction exposes no partial completion and never overwrites existing credentials

- Steps 2–5 need no copy of any credential by hand (manifest path) and no public address.
- The App's permissions equal the literal fixture {contents:write, workflows:write, pull_requests:write, issues:write, checks:read, statuses:read, administration:read, metadata:read, members:read}; its webhook is inactive.
- The App's OAuth callback URLs equal the literal fixtures http://localhost:4000/api/auth/github/callback and http://lan-a:4000/api/auth/github/callback; the HTTPS case adds https://box.example/api/auth/github/callback. Its owner is smithers-mvp-canary.
- The installation's repository list is exactly the scratch repository, and the host recorded its installation id.
- Step 7 finds no plaintext secret. `ps eww` of the backend shows no `SMITHERS_GITHUB_APP_ID` or `_PRIVATE_KEY`.
- Step 8 mints a token. Step 9 creates no second App and returns a refusal. Step 10 is refused, since no owner exists and the request carries no setup token (§5.1.0).
- Step 11: GitHub redirects back to `<LAN origin>/setup/github/callback`, and the App is created the same way (§12.1.1).

- The production installation credential caller uses the converted App id and slug after restart with poisoned shell credentials; its JWT issuer equals the fixed App-id fixture. Plue composition validates its explicit env App identity through authenticated GET /app and fails closed on absent or mismatched identity. The fixture values are literal, never read from the spec or derived from production code.

- Plue boot makes no identity-validation request and succeeds without GitHub availability. The first credential caller takes the App id from SMITHERS_GITHUB_APP_ID and the canonical slug from authenticated GET /app without requiring SMITHERS_GITHUB_APP_SLUG. It validates the response id against the configured id and caches successful validation in the adapter. Restart requires first-caller validation again.
- GET /app failure, mismatched id or missing canonical identity refuses identity and installation credentials before installation lookup or token minting.
- POST /api/install/setup/app has one handler and one OpenAPI row; POST /api/install/setup/github_app returns 404 without state changes or outbound exchanges. INS-06 adopts this handler under its single {step} route.
- Manual App setup uses `POST /api/install/setup/app` only, with no github_app alias. Callbacks equal the `GET /api/install` URL set. A missing field or URL returns 400 class user naming it without secrets.

## Fail when
- The callback needs a public URL, a tunnel or a proxy.
- In install mode, a credential is stored in plaintext, read from env, or printed in logs. Plue credentials are never printed in logs.
- The App asks for a permission beyond the literal nine-permission fixture, lacks one, or has an active webhook.
- Any page or log shows `smitherspreviewrelease`.
- A replayed callback creates or overwrites an App.

- Plue boot depends on GitHub identity validation, an absent env slug refuses otherwise valid credentials, an env slug overrides authenticated identity, or identity/credentials escape after failed or mismatched validation.

## Evidence
`.artifacts/checks/C-GH-01/<UTC timestamp>/`: screenshots or video of steps 2–5 and 11, `listeners.txt`, `origins.json`, `app.json` and `installation-repos.json` (PEM redacted), `pgdump-grep.txt`, `env.txt`, the step 10 response, host logs, the commit and install version.

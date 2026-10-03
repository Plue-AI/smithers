# C-GH-01 The App manifest flow completes from localhost with no public address

Proves: mvp.md J1.2, §6.3 "GitHub App setup", M-03, M-28 · spec.md §3 (`github_app`), §5.1.0, §12.1, §16.2 steps 1–2, §16.3.3, §17.4 · Layer: e2e · Stage: W0, S1 · Tickets: T-GH-01, T-GH-10, T-GH-11, T-GH-12, T-GH-13, T-GH-14
Automation: W0: the disposable T-GH-01a form, recorded manually. S1: `apps/app/e2e/real/github-j10/app-manifest.spec.ts` (new), driving a signed-in GitHub profile · Runs in: recorded manual (W0), reference host (S1)

## Setup
- Reference host with a fresh `$STATE`, install at the commit under test. Settings has a LAN bind address and one plain-HTTP LAN origin (T-INS-04). No reverse proxy, tunnel or router port forwarding, so the install has no public address.
- A GitHub test account that owns the organization `smithers-mvp-canary`, signed in on the Mac's browser. Scratch repository `smithers-mvp-canary/<date>` with squash merging allowed. No Smithers App exists for the organization.
- No `SMITHERS_GITHUB_APP_*` variable in the launchd environment. The setup token printed by `smthrs host start` is at hand.

## Steps
- Adopted T-GH-12 boundary cases: Use production setup/callback routes and independent GitHub request counts. Expired and claim-invalidated durable setup sessions, foreign/replayed state and invalid origin each make zero outbound exchanges. Race two starts, crash after durable CAS and around callback conversion/local commit, and assert one begin, single-use state and all-or-none sealed credentials/configuration/completion/projection; restart preserves done and prevents overwrites

1. Record `lsof -nP -iTCP -sTCP:LISTEN` for the host processes and the configured origins.
2. On the Mac, open the setup URL on `http://localhost:4000`, choose the scratch repository, and start "Create GitHub App".
3. On GitHub's App page, screenshot the prefilled form, then create the App.
4. Observe the browser land on `http://localhost:4000/setup/github/callback?code=…&state=…` and the step turn done.
5. Install the App on the scratch repository only. Observe the return to `/setup/github/installed`.
6. Read `GET /app` (App JWT) and `GET /installation/repositories` (installation token) through the test harness.
7. Run `pg_dump` on the install database and search it for `PRIVATE KEY`, the client secret and the webhook secret.
8. Restart the host (`launchctl kickstart -k`). Mint an installation token.
9. Load the step 4 callback URL again.
10. From a second Mac, call `POST /api/install/setup/github_app` at the LAN origin without the setup token.
11. Delete the App on GitHub and start a fresh `$STATE`. Repeat steps 2–5 from the second Mac at the LAN origin with the setup URL printed for that listener (§5.1.0).

W0 variant: steps 2–4 with the T-GH-01a HTML form, plus `POST /app-manifests/{code}/conversions` by hand. If GitHub refuses the localhost redirect, run the paste fallback instead: paste the App id, PEM and client id and secret, then step 6.

## Pass when
- Commit the durable app-step CAS to running before beginning external App creation. Validate durable setup session, state and effective origin before any outbound exchange. Consume callback state durably before the remote exchange; do not claim remote/local atomicity. After successful exchange, commit sealed credentials, callback configuration, app-step completion and its projection in one local transaction. A failed transaction exposes no partial completion and never overwrites existing credentials

- Steps 2–5 need no copy of any credential by hand (manifest path) and no public address.
- The App's permissions equal §12.1.2 exactly, `workflows: write` and `administration: read` included, and its webhook is inactive.
- The App's callback URLs are exactly the configured origins plus `http://localhost:4000`. Its owner is `smithers-mvp-canary`, since the repository belongs to the organization (§12.1.1).
- The installation's repository list is exactly the scratch repository, and the host recorded its installation id.
- Step 7 finds no plaintext secret. `ps eww` of the backend shows no `SMITHERS_GITHUB_APP_ID` or `_PRIVATE_KEY`.
- Step 8 mints a token. Step 9 creates no second App and returns a refusal. Step 10 is refused, since no owner exists and the request carries no setup token (§5.1.0).
- Step 11: GitHub redirects back to `<LAN origin>/setup/github/callback`, and the App is created the same way (§12.1.1).

## Fail when
- The callback needs a public URL, a tunnel or a proxy.
- A credential is stored in plaintext, read from env, or printed in logs.
- The App asks for a permission beyond §12.1.2, lacks one, or has an active webhook.
- Any page or log shows `smitherspreviewrelease`.
- A replayed callback creates or overwrites an App.

## Evidence
`.artifacts/checks/C-GH-01/<UTC timestamp>/`: screenshots or video of steps 2–5 and 11, `listeners.txt`, `origins.json`, `app.json` and `installation-repos.json` (PEM redacted), `pgdump-grep.txt`, `env.txt`, the step 10 response, host logs, the commit and install version.

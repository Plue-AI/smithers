---
title: "GitHub App setup"
description: "Create the install's GitHub App and keep its credentials sealed on the host."
---

Open the terminal's `/setup?token=…` URL on a configured origin. It exchanges the token for a durable setup session. Before claim, `GET /api/install` and `POST /api/install/setup/app_manifest` require that session; a raw bootstrap header cannot start a step. Afterwards they require the owner's browser session. Setup POSTs require the same origin and CSRF cookie/header.
Post `{ "owner_login": "your-login", "owner_kind": "user", "repository": "your-repo" }` to `/api/install/setup/app_manifest`. In the same browser, submit the returned `manifest` as a JSON string in a form field named `manifest` to `action_url`, using `POST`. Organization repositories use `https://github.com/organizations/<org>/settings/apps/new`; an organization owner must create the App there. Hand that URL to an owner if needed.

GitHub redirects to `/setup/github/callback`. The host checks the same unexpired setup session and original setup origin. The 256-bit state is stored only as a SHA-256 digest, expires after ten minutes, and is atomically consumed before exchanging the code with `POST /app-manifests/{code}/conversions`, then redirects to the stored App's installation page. Install it on the selected repository. `/setup/github/installed` verifies the installation belongs to this App and includes that repository before recording its id. The host derives the id by listing the App's installations and verifying repository access; the redirect id is ignored. If the App is uninstalled and reinstalled on GitHub, repeat installation resume; the host records the new id only after verifying the same App and repository. Installation can resume through `/setup/github/installed` with a live setup or owner session after conversion state expires. `POST /api/install/setup/app_manifest` with `{"resume":true}` returns the stored installation URL. An expired, foreign, or replayed callback is refused without exchanging a code. A failed exchange consumes that attempt; start again.

The default manifest uses localhost redirects. Setup served on another configured origin uses that origin for the browser redirects. Authorization callback URLs append `/api/auth/github/callback` to each configured origin and `http://localhost:4000`; GitHub permits ten. The creation-time URLs are recorded in `install_settings` as `github.callback_urls`. `GET /api/install` returns that snapshot and `callback_fixes`, each containing the App's `settings_url` and the exact `add_url` for a newly configured origin. Add the URL on GitHub; its API cannot update App callbacks. The App requests `contents`, `workflows`, `pull_requests`, and `issues` write access; `checks`, `statuses`, `administration`, `metadata`, and `members` read access. Its webhook starts inactive. Polling does not require a public address. The manifest subscribes to issue, comment, pull request, review, push, check, and status events; live GitHub retention of those events with an inactive webhook remains a release check.

One App belongs to each install. Its PEM, webhook secret, and OAuth client secret are AES-GCM sealed in PostgreSQL under the install key in `$STATE/config/secrets.json` (mode `0600`). Restarting reloads them through the same store used by installation tokens, permission diagnosis, webhook verification, and existing GitHub sign-in. `OAuthClient()` reloads the client pair before authorization, code exchange, and refresh; sign-in refuses unavailable credentials before saving OAuth state. Owner claim and member admission belong to T-ACC-01. Operator-key rotation reseals the three columns before retiring the previous key. Self-hosting reads no App credential environment variable or default App slug. Plue explicitly selects `app.Config.EnvGitHubAppCredentials`; that adapter reads the existing App variables and lazily validates identity with authenticated `GET /app` at the first credential call. The canonical slug overrides shell values; only successful validation is cached, and self-hosting refuses that composition. `SMITHERS_GITHUB_APP_API_BASE_URL` remains a backend test seam for the local `githubfake` HTTP server; the native launcher does not pass App variables through.

## Pushes from outside

TODO branch publication is held while the current GitHub facts, own-push reconciliation and independent wait providers are unavailable. A previously observed foreign head remains held even if a later poll reports the recorded Smithers head or a PR behind main. Polling does not answer a person's wait.

Bring in and Discard remain unavailable until the shared authorization, confirmation, catalog and checkpoint contracts pass their production boundary tests. No repository code runs on the host to bring in a commit. The eventual branch answer input is `{id, revision}`: the foreign wait id and its displayed `sha`, with an `Idempotency-Key`; a newer head requires a new decision.

## Polling transport

The existing GitHub callers have shared client wiring for response-header budget admission, including repository lists, visibility checks, installation-token minting and stack decoration. Header-based accounting remains unmounted until the install's production guards and delivery checks qualify it. Scoped tokens for the same installation share its resource budget. GitHub's limit, remaining and reset headers supply capacity; no local hourly request-count cap or linear refill applies. Hosted compositions retain their existing worker and budget policy. The install metadata reconciler uses the guarded fetched-state path described below.

A 403 or 429 with `Retry-After` pauses only its stream. Exhausted primary capacity pauses the resource until its reset. Below 20 percent remaining, the cadence helper doubles issues, issue events and permission reads until reset. Conditional 304 responses consume no local debit. The existing request API also exposes `If-None-Match`, 304 status and response headers without replacing a cached fact.

The install polling integration remains incomplete. Required cadences are refs every 30 seconds; pulls, PR checks and comment streams every 45 seconds; issues and repository issue events every 120 seconds; permissions every hour. Stream ETags and health belong in memory. Repository issue events require an `install_settings` cursor and an atomic cache/cursor/pending-delivery commit, followed by consumer receipt/effect commit and acknowledgement. The full stream, cursor and freshness contracts remain unqualified.

## Fetched-state delivery

On installs, issue, pull-request and comment webhooks wake the existing metadata
reconciler. Their payloads cannot update cached objects, rename the registry row
or establish freshness. Hosted webhook/cache behavior is unchanged.

Fetched issue and pull-request batches commit their cache rows and consumer
requests together in the existing product jobs store. Each request identifies
the installation, immutable GitHub repository, stream and object version.
Repeated polls reuse the request; stale object versions do not replace newer
cache rows. A malformed object or failed delivery write rolls back the batch.
Absence from a fetched page does not silently delete a cached object; deletion
still needs an authoritative tombstone and its consumer delivery.

The shared jobs worker retains requests when no consumer is registered. A
consumer writes through the same PostgreSQL transaction that acknowledges its
request. Failure rolls back both, and a later version in the stream waits for
earlier pending work. Delivery rechecks current repository/installation binding
and provider authority. No separate delivery table or scheduler is introduced.

Production provider qualification and downstream handlers are not registered
yet. Install metadata fetching and per-issue comment baselines remain disabled;
last-good cached data stays visibly stale. Main-ref polling is separate and
continues through its existing service. Repository issue-event paging/cursors,
review and comment streams, ETags, cadence integration and the full production
recovery/freshness checks remain required before activation.

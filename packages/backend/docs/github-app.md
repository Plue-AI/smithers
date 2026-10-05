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

The install's production service assembly selects shared response-header budget admission for repository lists, visibility checks, installation-token minting and stack decoration. Scoped tokens for the same installation share its resource budget; a person's own credential has separate headroom shared by their repository-list and access-check clients. GitHub's limit, remaining and reset headers supply capacity; no local hourly request-count cap or linear refill applies. Hosted compositions retain their existing worker and budget policy. Selecting the install budget does not enable unqualified metadata workers or consumers: the install metadata reconciler uses the guarded fetched-state path described below.

A 403 or 429 with `Retry-After` pauses only its stream. Exhausted primary capacity pauses the resource until its reset. Below 20 percent remaining, the cadence helper doubles issues, issue events and permission reads until reset. Conditional 304 responses consume no local debit. The existing request API also exposes `If-None-Match`, 304 status and response headers without replacing a cached fact.

Startup creates this budget before auth and setup. Manifest owner discovery, conversion and installation discovery, OAuth exchange and refresh, and profile/email reads use it too. Profile, email and repository reads with the same user token share headroom; a temporary OAuth pause does not invalidate a stored refresh token. Setup retains its refusal to follow redirects.

The sealed credential source registers each JWT under the App ID it signed for. Renewing that JWT retains the App's resource limits and stream pauses across setup, access diagnosis, member checks and installation reconciliation. App and installation-token budgets remain distinct. Registrations expire with their credentials; removing an expired registration does not clear the principal's rate-limit history. Incoming JWT claims never establish an accounting identity.

Rate-limit refusals retain the `github` class, `github_rate_limited` code and absolute `retry_at` through the shared request helper, installation minting/discovery, metadata/import callers and install setup/member envelopes. `Retry-After` remains available for existing clients. HTTP 403 is a rate limit only with retry or exhausted-budget headers; ordinary permission denials remain distinct. The shared parser keeps GitHub's full retry interval, including HTTP dates and pauses longer than an hour. Local budget refusals carry the same typed deadline as upstream refusals.

Non-rate-limit GitHub failures use HTTP 502 with class `github`, keeping local 401/403 authorization failures distinct. Required App reads report `github_permission` for inaccessible resources and `github_unavailable` for transport, incomplete-body or decoding failures. Only an upstream 404 from the installation-token endpoint maps to `github_not_installed`; an absent optional discovery result still returns no installation. The shared HTTP transport preserves cancellation, and the transport never retries an uncertain write. Token and installation-list responses must be complete and within their size limits before decoding or caching; failed stream reads retain the previously committed cache, cursor and pending deliveries. Direct user repository listings, installation repository listings and push-permission reads apply the same bounded, complete-response requirement. A rejected installation token is evicted without treating it as a local sign-in failure. Rejected user tokens retain the one-refresh/reconnect path; failed refreshes keep their own error and retry deadline, so a temporary refresh pause neither invalidates the last-good listing nor reports a broken credential. Missing installation bindings report `github_not_installed`. OAuth exchange/refresh and profile/email reads classify rate-limit headers before interpreting credential errors. Exchange and refresh credentials are accepted only from a complete response within 1 MiB; malformed or interrupted refreshes leave the stored credential unchanged. Profile and email identity reads also require a complete response within 1 MiB. Sign-in preserves typed GitHub failures and rate-limit deadlines; failed identity reads cannot create an account or issue a token. Required repository metadata and diff reads use the shared failure classification, and diff rate-limit headers take precedence over unreadable bodies. Optional discovery and missing-access verdicts remain explicit at their callers. Installation verification retains dependency failures and their absolute retry deadline; an App access failure does not become an empty successful inventory.

The install polling integration remains incomplete. Required cadences are refs every 30 seconds; pulls, PR checks and comment streams every 45 seconds; issues and repository issue events every 120 seconds; permissions every hour. Stream ETags and health belong in memory. Repository issue events use an `install_settings` cursor and an atomic cache/cursor/pending-delivery commit, followed by consumer receipt/effect commit and acknowledgement. Full production stream and freshness contracts remain unqualified.

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

Repository issue events are paged newest first back to the durable cursor.
Every new event is retained by its GitHub event id, including separate label
removal and reapplication events. Cache updates, event deliveries and the cursor
commit together; interrupted paging and failed writes leave the cursor intact.
The cursor is scoped to the installation and immutable repository id. It marks
durable admission; pending consumer work survives its advancement and restart.
Delivery follows numeric event order, independently of database timestamps.
Embedded issue text is cached data; downstream label admission must still check
its authorship and current membership.

The shared jobs worker retains requests when no consumer is registered. A
consumer writes through the same PostgreSQL transaction that acknowledges its
request. Failure rolls back both, and a later version in the stream waits for
earlier pending work. Delivery rechecks current repository/installation binding
and provider authority. No separate delivery table or scheduler is introduced.

Production provider qualification and downstream handlers are not registered
yet. Install metadata fetching and per-issue comment baselines remain disabled;
last-good cached data stays visibly stale. Main-ref polling is separate and
continues through its existing service. Transactional TODO consumer integration, review and comment streams,
cadence integration and the full production recovery/freshness checks remain
required before activation.

Issue, pull-request and repository-event pages use conditional install reads
through the shared HTTP transport and scoped token minter. In-memory ETags are
bound to the registry row, installation, immutable repository, owner/name,
resource and complete query. A stream retains new validators only after its
whole fetched interval commits with its pending deliveries. Failed paging,
revoked authority or failed database writes leave the prior validators intact.
A 304 can end a walk only for a page from a previously committed interval;
an unsolicited 304 is an error. Response bodies are never a second object cache.
Restart drops ETags and rereads GitHub; durable event and object identities
prevent duplicate deliveries. Install issue and pull walks no longer stop at
ten pages, and incomplete HTTP bodies cannot be accepted as valid snapshots.
Issue and pull cursors retain the newest committed `updated_at` in poller
memory. Issue reads use a stable `since` URL with a one-second overlap because
[GitHub excludes the boundary timestamp](https://docs.github.com/en/rest/issues/issues#list-repository-issues).
Pull reads use the same overlap when stopping their newest-first page walk.
Objects in that second are compared through their existing canonical versions,
so a later same-second edit is retained without replaying identical effects.
Unordered or invalid timestamps, failed reads and failed commits cannot advance
the cursor. Old issue-query validators are discarded when its cursor advances.

A page validator also retains its row count and oldest timestamp, not its
objects. An unchanged full page inside the overlap window still leads to the
next page: a page-two edit can share the cursor timestamp without changing
page one. Short pages or pages reaching older timestamps end the walk. Restart
loses cursors and validators together and repeats a full read; durable delivery
identities preserve deduplication.

The existing install metadata reconciler runs pulls every 45 seconds and issues
and repository events every 120 seconds, using separate in-memory schedules.
Issue and PR webhook hints request their corresponding streams without moving
the next regular poll. Repeated hints coalesce, and a busy database claim leaves
them pending. Final synchronization status rechecks the current binding and
provider authority under the registry lock; an intervening disable or rebind
cannot be overwritten by a successful read. Each due stream commits independently; an issue-stream refusal
does not prevent a due pull read or erase its last successful state. The install
reads all eligible registry entries rather than sharing the hosted batch limit.
Pull requests use 50 rows per page; issues and events use 100.

When response-header budget accounting is qualified and enabled, metadata
scheduling consults its shared pauses before token minting. Issues and events
double to 240 seconds below 20 percent remaining, returning to 120 at reset;
pulls remain at 45. A 403 or 429 with Retry-After holds only that stream, including
pending hints, until its retry time. Restart forgets these schedules and starts
with a fresh read. Hosted scheduling remains unchanged. PR check, review/comment
and permission stream scheduling, health projection and full production
qualification remain incomplete.

Label provenance readers use the same repository event pager. They isolate the
requested issue, read complete history, and retain the check against its current
labels. Failed pages cannot supply partial approval evidence. A matching GitHub
App action within the attribution window prevents attribution to a person.
The former main-ref-loop registration that directly admitted TODOs is removed;
TODO admission must join the shared fetched-event transaction before activation.

The existing TODO follow loop selects a 45-second pull-state interval on installs;
hosted workers retain five minutes. Install reads use the shared conditional
transport, scoped token minter and fetched-state qualification. Missing providers
refuse before token minting. Pull detail updates and their pending deliveries
commit to the same store as pull list updates. The loop does not apply fetched
PR state or run the legacy review/merge gate: those effects belong to the
transactional consumer, which remains unregistered.

Detail ETags retain the canonical version of their committed cache row. If a
list read, concurrent detail read or deletion changes that row, the next detail
read fetches a body again. An intervening cache change during a 304, a failed
commit or revoked binding cannot validate a different representation. Restart
forgets ETags and retains pending delivery identities. Shared pull-stream pauses
are checked before minting and retain their absolute retry deadline. Check and
review reads and complete freshness acceptance remain outstanding.

Pull webhook hints also wake the existing stack worker for every unsettled TODO
with a PR, including items beyond the display limit. During a scheduled wait,
the worker fetches the hinted PR without moving its regular deadline. Repeated
hints coalesce; a hint arriving during a fetch survives for the next pass. Both
shared budget pauses and failed-read backoff remain in force after another hint.
The worker rechecks the effective repository destination before fetching. Missing
provider qualification leaves this path disabled.

The install's existing sync service now requires every stream owner: refs,
repository metadata and per-TODO reads, checks, reviews and permissions. A main
receipt alone cannot qualify polling, aggregate health or Retry. The production
assembly leaves the absent check and review owners unregistered;
main polling and the sync actions report unavailable until the complete provider
boundary is qualified.

Retry checks all owners before scheduling their existing workers. Repository
reads and per-TODO reads use the same hints as webhooks; main pulls use their
existing durable request generations and wake channel. Retry returns before
HTTP, preserves cadence and shared budget state, and propagates scheduling
failures instead of claiming completion. Repository health includes missing
per-TODO observations rather than inferring them from the pull list.

The main reader checks shared admission before token minting or ref reads.
Install token refusals and empty credentials stop the read instead of falling
back to anonymous GitHub access. Rate-limit failures retain their absolute retry
deadline in the worker's existing backoff. Hosted anonymous public reads retain
their previous behavior. Full stream, main-move/attention, live-health and
production acceptance evidence remain outstanding.

Permission polling uses the existing member-recheck worker. Its one-second
driver checks an hourly read deadline; low shared budget doubles that deadline
until reset. Retry wakes this same worker, preserves the regular deadline and
coalesces requests during an active read. Shared permission and token-mint
pauses apply before minting. The qualified registry supplies the installation,
avoiding a second installation-discovery request.

Permission ETags are held in memory and tied to the committed roster row
version. A changed row or repository binding invalidates an in-flight response,
including 304. Suspension, credential revocation and restoration commit before
an ETag is retained; restart performs a fresh read. Confirmed read/none access
suspends a member, while installation refusals, malformed responses and
transient failures preserve access. Restoring write access never restores old
credentials. This worker remains disabled without fetched-state qualification;
its integration tests do not establish live transport or guest revocation
acceptance.

Conversation comments use the repository-wide `issues/comments` stream every
45 seconds. The existing pager requests `sort=updated&direction=desc` with
100 comments per page and the same exclusive-since overlap as issues, following
[GitHub's repository comment parameters](https://docs.github.com/en/rest/issues/comments#list-issue-comments-for-a-repository).
It continues past unchanged full pages to retain equal-timestamp edits on later
pages. The cursor and ETags advance only after the complete interval commits.

Comment payloads and versioned delivery requests commit together in the existing
comment cache and product jobs. The fetched issue URL must match the configured
API origin and repository; it is parsed only as identity data. Initial batches
are admitted oldest first, with a stable comment-id tie break. Older responses
cannot replace newer cached comments, and a comment id cannot move to another
issue. Edits retain their object identity for the eventual consumer to decide
whether held input may still change.

Signed issue-comment webhooks request an immediate comment fetch without
postponing the regular cadence or applying their payload. Low remaining budget
does not stretch this stream; its own rate-limit pause still applies. Restart
rereads the stream and reuses durable delivery identities. Consumer effects and
acknowledgements use the shared transaction boundary. Effective TODO steering
remains disabled until its providers qualify. Incremental absence does not prove
a deletion; authoritative comment tombstones and review-comment storage remain
outstanding.

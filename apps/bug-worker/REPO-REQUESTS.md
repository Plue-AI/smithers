# Community repository requests

The home page no longer embeds the nomination form: registration is GitHub
sign-in plus installing the Smithers GitHub App on the repository. This Worker
still serves the nomination, claim, and notification contract below.
Nominating is operator-only; browsing and following need no account.

## Lifecycle and app handoff

`POST /api/repo-requests` is operator-only: without the deployed
`BUG_ADMIN_TOKEN` in `x-bug-admin` it answers `401` before it reads the body,
calls GitHub, forks, sends mail, or writes anything. A nomination forks the
repository into smithers-community and can email any address, and no product
surface submits one, so it stays closed until the app's GitHub sign-in flow
replaces it. It accepts `{ "repo": "owner/repo", "email": "optional@example.com" }`.
It checks GitHub for a public, enabled repository with a recognized license,
then stores it as `smithering`. GitHub URLs and `.git` suffixes normalize to
one case-insensitive repository identity. This records a request for the team
to support the repository; it does not launch an agent or provision the app.
Every accepted request is one nomination. The response is
`{ repo, subscribed }`, and `repo.nominations` is the repository's current
nomination count, including this one. `subscribed` means a confirmation email
was sent; the address receives the completion email only after the recipient
confirms (see Notifications). When a confirmation could not be sent, the
response adds `confirmation` with `rate_limited`, `send_failed`, or
`email_not_configured`.

Each public record has `name`, `url`, `status` (`smithering` or `ready`),
`appUrl` (null until ready), and `nominations`.

`GET /api/repo-requests` returns `{ repos }`: the 20 most nominated
repositories, most nominated first, ties by name, exact at any catalog size.
The response carries `cache-control: public, max-age=60`, so a browser reuses
it for a minute; the page bypasses that cache after a submission. Readiness
in the list is materialized when a repository is nominated or completed, so
the list is fresh as soon as the completion call returns and stale for at
most that one-minute browser cache plus KV propagation.
`GET /api/repo-requests?repo=owner/repo` returns `{ repo }` for one
repository, 404 when nobody has requested it, and 400 for an invalid name.
Public `GET` reads, including `GET /api/repo-claims`, share a per-client
throttle of 100 per hour and answer `429` above it.
The upcoming app can consume this same public catalog and use ready entries
as its supported repositories.

## Nomination counts

Each repository has one counter key, `repo-nominations:<owner/repo>`, holding
the count as a decimal string. An accepted `POST` reads it, adds one, and
writes it back; rejected requests (invalid input, private or unlicensed
repository, missing operator token) never touch it. KV has no atomic increment, so two
nominations that arrive at the same moment can record as one. The tally is
public and informational, so that undercount is accepted rather than adding a
Durable Object. The count is not idempotent either: any resubmission, including
a retry after a 503 that arrived once the request was stored, records another
nomination.

The same `POST` then rewrites one leaderboard key, `repo-nominations-top`: a
JSON array of `{ "name", "count", "appUrl" }` sorted by count, then name,
capped at 20. It replaces the repository's own entry with the new count and
its current readiness (`appUrl` is null while smithering) and drops anything
past 20. `POST /api/repo-requests/complete` writes the published `appUrl`
into the repository's entry when it is listed. The list endpoint reads
that one key, one KV read at any catalog size, and never scans the catalog. Entries written before readiness was materialized have no
`appUrl` field and cost one readiness read each until their next nomination
or completion. The leaderboard shares the counter's read-modify-write, so the
same concurrent-write undercount applies to it and nothing else.

Once the app supports a repository **and its repository view works for an
anonymous visitor**, call `POST /api/repo-requests/complete` with the existing
`x-bug-admin` secret header and this JSON body:

```json
{
  "repo": "owner/repo",
  "appUrl": "https://app.smithers.sh/repos/owner/repo"
}
```

The URL is supplied by the app integration, not inferred by the landing page.
Only HTTPS URLs on `smithers.sh`, `app.smithers.sh`, and `canary.smithers.sh`
are accepted. The completion endpoint does not test the destination's access
policy: anonymous access must be verified before publishing. Do not publish
an app URL until that repo view exists. Publishing is monotonic: new requests
cannot reset readiness, and changing a published URL returns 409.

A successful completion answers `200` with the published repository and the
delivery state. It sends no email itself; it queues the repository for the
scheduled sweep described under [Notifications](#notifications):

```json
{
  "repo": { "name": "owner/repo", "url": "https://github.com/owner/repo", "status": "ready", "appUrl": "https://app.smithers.sh/repos/owner/repo" },
  "delivery": "queued"
}
```

`delivery` is `"email_not_configured"` while `RESEND_API_KEY` or
`NOTIFICATION_FROM` is unset; the queue entry is kept and drains once both are
configured. A storage failure after the durable commit answers `503`; retry the
same completion, which is idempotent and queues the repository again.

All visitors then see **Smithered / Open in Smithers**. The current app is still
being built; this change supplies the intake, public catalog, and completion
contract, not the repository view inside that app.

## Community forks

The first accepted nomination of a repository forks it into the
[smithers-community](https://github.com/smithers-community) GitHub
organization with `POST https://api.github.com/repos/{owner}/{repo}/forks` and
the body `{ "organization": "smithers-community" }`. The deploy requires
`GITHUB_FORK_TOKEN`, a token that can create forks in that organization. The same token authenticates the repository lookup on every
new nomination; without it the lookup uses GitHub's anonymous quota of 60
requests per hour, shared by every Worker on the same egress IP. The outcome is stored under `repo-fork:<owner/repo>` as
`{ "status": "forked", "forkedAt": "..." }`, `{ "status": "failed", "error": "..." }`,
or `{ "status": "skipped" }` when the token is unset. A fork failure is logged
and recorded but never fails the nomination; the repository is still stored as
`smithering`. Fork status is not part of the public listing.

## Maintainer claims

A maintainer can claim a nominated repository. Claiming only records who
claimed it; it does not grant access or start any work yet.

### Recording a claim (operator-only)

`POST /api/repo-claims` is temporary and operator-only. A typed login from an
anonymous caller proves nothing, so the Worker refuses every request without a
valid `x-bug-admin` header before it reads the body or looks up the repository.
Maintainers cannot call it themselves. It stays in place until the OAuth-backed
`repo.claim` flow ships on the product Worker, which will verify maintainership
through GitHub sign-in and replace this endpoint.

Operators send the deployed `BUG_ADMIN_TOKEN` in `x-bug-admin` with the JSON
body `{ "repo": "owner/repo", "login": "github-login", "email": "optional@example.com" }`:

```sh
curl -X POST https://bug.smithers.sh/api/repo-claims \
  -H "content-type: application/json" \
  -H "x-bug-admin: $BUG_ADMIN_TOKEN" \
  -d '{"repo":"owner/repo","login":"github-login","email":"optional@example.com"}'
```

Responses, in the order the handler checks them:

- `401` when `x-bug-admin` is missing or wrong, or when `BUG_ADMIN_TOKEN` is
  unset on the deployment. Nothing is read or written.
- `429` when the per-IP claims throttle is exhausted.
- `413` when the body exceeds 4096 bytes.
- `400` for a body that is not a JSON object, or an invalid repository, login,
  or email.
- `404` if the repository has never been nominated.
- `409` if the repository is already claimed.
- `200` with `{ repo, login, claimedAt }` for the first claim.

### Reading a claim (public)

`GET /api/repo-claims?repo=owner/repo` needs no authentication. It returns
`{ repo, login, claimedAt }` or `404`, and `400` without a valid `repo` query.
Claims live under `repo-claim:<owner/repo>`. The claimant's email is stored
with the claim and never appears in responses.

## Notifications

The deploy requires `RESEND_API_KEY` and `NOTIFICATION_FROM` (a verified
sender). No emails are sent during development tests. Delivery
uses the [Resend send endpoint](https://resend.com/docs/api-reference/emails/send-email)
and [idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys).

Subscription requires recipient consent. A submission with an email stores no
subscriber: it stores a pending record under `repo-confirm:<token>` for 24
hours, then sends one confirmation email, so every link that leaves has a
record. The token is 128 random bits, hex encoded,
and single-use. Emailed links are safe to prefetch: a `GET` on
`/api/repo-requests/confirm?token=<token>` or `/cancel?token=<token>` writes
nothing and returns a page whose one button `POST`s to the same URL, because
mail scanners open every link in an inbound message. Malformed tokens return
400 on either method. `POST /api/repo-requests/confirm?token=<token>` creates
the deliverable subscriber and then deletes the pending record; expired or used
tokens return 410. The confirmation response includes a `cancel` URL, and every
notification email ends with an unsubscribe link. Both point at
`/api/repo-requests/cancel?token=<token>`, whose `POST` removes a pending
confirmation or a confirmed subscription (`repo-cancel:<token>` maps the
cancellation token to the subscriber key, and is deleted after the subscriber)
and returns 404 for unknown tokens. Confirm and cancel write before they consume
their token, so a 503 from either is safe to retry with the same link.
Confirmed subscribers are stored as `{ "email", "cancel" }` JSON. A
plain-address record written before this flow is rewritten to that shape, with
a new `repo-cancel:` token, before its notification is sent, so every
notification carries an unsubscribe link. Without provider configuration no consent email can be sent, so the
submission stores nothing and reports `confirmation: "email_not_configured"`.
A failed confirmation never fails the nomination: it reports `"send_failed"` and
logs one JSON line naming the fault. `repo_confirmation.failed` means storage
failed and nothing was sent; `repo_confirmation.unavailable` means the provider
or network failed and the message may have arrived; `repo_confirmation.rejected`
means the provider refused the message. A failed send keeps the pending record
for its 24 hours, so a message that did arrive still confirms. Confirmation
attempts, sent or not, are throttled to three per recipient per hour across all
repositories (excess submissions report `confirmation: "rate_limited"`).

Confirmed subscribers receive one transactional email after completion. The
scheduled sweep, which runs every ten minutes, is the only sender: completion,
`/notify`, and a confirmation that arrives after completion only queue the
repository. Receipts under `repo-notified:` skip already-sent messages.

A repository joins the pending queue under `repo-pending:<owner/repo>` on
completion, on `/notify`, when a subscriber confirms after the repository has
completed, and when a sweep leaves work owing: an unfinished page, a rejected
send, or a cut page. Each invocation drains up to two queued repositories, then
reconciles up to two more from the full scan, sending at most one page of 50
subscribers per repository. An entry is removed only once the repository owes
nothing, so a pending delivery is never spent behind completed repositories
with nothing left to send. The full scan remains as the slower reconciliation
pass: it finds subscriber records written outside the confirmation flow and
re-queues work whose enqueue was lost to a KV failure. A queued repository
whose readiness record reads as missing or corrupt keeps its entry, because
only completed repositories are queued and a stale read must not drop a pending
delivery; a record that stays corrupt holds one of the two queue slots until an
operator repairs or removes it, and delivery for other repositories continues
through the full scan.

Every send outcome names who is at fault:

- **Unavailable** (network error, the ten-second timeout, any 5xx, and 401,
  403, 408, 409, or 429): the provider or our configuration failed. The sweep
  stops the page at that send, keeps the subscriber cursor at the page's start,
  keeps the repository queued, and charges no recipient. The next sweep re-reads
  the page and receipts skip whoever was already sent.
- **Rejected** (any other 4xx): the provider refused this message. The
  subscriber cursor still advances, and the recipient is retried when the scan
  wraps. The third rejection records a terminal state under
  `repo-notification-failure:<subscriber-key>` with `attempts`, `terminal`,
  `failedAt`, and `error`, and later sweeps skip that recipient. An operator can
  remove the failure record and call `/notify` to permit retries after resolving
  the cause.

A sweep starts no send after five minutes. The page it was on is cut and held
like an unavailable one, and the scan cursor advances only past repositories the
sweep visited, so a cut never skips a repository. Five minutes plus one
ten-second send timeout ends every sweep before the next ten-minute tick and
well inside Cloudflare's fifteen-minute Cron Trigger limit. Corrupt readiness
records and repository-specific storage errors are skipped and logged, so
healthy repositories continue. Future full scans revisit those records.

Each sweep writes one JSON line per event to Workers Logs, all keyed by `repo`:
`repo_notification.swept` (per repository: `sent`, `rejected`, `pending`, and
`cut` when the page was held), `repo_notification.unavailable`,
`repo_notification.terminal`, and `repo_notification.failed` for storage or
readiness errors.

Completion reports `email_not_configured` while the provider is unconfigured.

Maintainers can also call `POST /api/repo-requests/notify` with `x-bug-admin`
and `{ "repo": "owner/repo" }` to queue a completed repository for the next
sweep. It sends nothing, rewrites the `repo-ready:` mirror from the committed
record, and answers with the same receipt as completion, or `409` while the
repository is still smithering.

KV is eventually consistent. New requests, readiness, and counts may take up
to a minute to reach other locations; the page loads the most nominated list
once per visit and again, bypassing the browser cache, after each submission.
Records and per-email subscriptions use separate keys so concurrent
submissions cannot overwrite a subscriber list or reset completed work. Provider keys
protect concurrent delivery retries for 24 hours; if a send succeeds but its
KV receipt cannot be saved for longer than that, a retry may send a duplicate.
Throttles are atomic: each bucket is a `RateLimiter` Durable Object behind the
`RATE_LIMITS` binding that counts inside a storage transaction. A client is
Cloudflare's `cf-connecting-ip`, charged per /64 for IPv6; `x-forwarded-for`
is ignored.

Email addresses never appear in public responses. Confirmed subscribers live
under `repo-subscriber:<owner/repo>:<sha256(email)>`, pending confirmations
under `repo-confirm:`, cancellation tokens under `repo-cancel:`, and the
per-recipient confirmation throttle under `repo-confirm-throttle:`, separate
from public metadata
under `repo-request:`, counts under `repo-nominations:`, the leaderboard under
`repo-nominations-top`, and completion under
`repo-ready:`. Notification receipts use `repo-notified:`, failure records use
`repo-notification-failure:`, the pending-delivery queue uses `repo-pending:`,
forks use `repo-fork:`, and claims use `repo-claim:`.

The `RepoCompletion` Durable Object behind the `REPO_COMPLETIONS` binding,
keyed by the normalized repository name, is the only authority for a
repository's published URL. A storage transaction commits the first URL;
conflicting completions return 409 even when KV reads are stale. `repo-ready:`
is a mirror: completion and `/notify` rewrite it from the committed record
before returning success or queueing notifications, and nothing reads it back
into the Durable Object. A stale, missing, or corrupt mirror never changes the
committed record; retry completion with the same URL or call `/notify` to
repair it. Alchemy provisions the `RepoCompletion` class and its SQLite storage
migration with the Worker. A Durable Object failure is logged as
`repo_request.failed` and answers 503.

## Validation and deployment

Run `pnpm -C apps/bug-worker test` and `pnpm -C apps/site build`. Deploy the
Worker before the site; otherwise the new form gets a visible API error and
the most nominated list stays hidden. `alchemy.run.ts` is an Alchemy 2 stack
(`import * as Alchemy from "alchemy"` and `alchemy/Cloudflare`), matching the
`alchemy` version the workspace installs; deploy as the README's Deploy
section describes. The stack declares the ten-minute cron and fails the
deploy when the email bindings above or `GITHUB_FORK_TOKEN` are missing.

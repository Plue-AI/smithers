---
title: "API reference"
description: "Every public export of @smthrs/integrations: signatures, behavior, and errors, for the Core and GitHub namespaces."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/integrations/docs/api.md"
---

The package exports `Core` and `GitHub` from `@smthrs/integrations`,
`@smthrs/integrations/core`, and `@smthrs/integrations/github`.
`Environment` is available through `@smthrs/integrations/Environment`.

Conventions worth knowing before the signatures:

- Clients are Effect services. Each has a tag (for example `GitHubClient`), a
  `make` constructor for direct use, and a `layer` for composition.
- Failing Effect values fail with `Core.IntegrationError`.
- Plan-time helpers validate their arguments by throwing, the way an ordinary
  constructor does. Those throws are `SmithersError` values with codes such
  as `INVALID_INPUT`, or an `IntegrationError`, and they mean the caller has
  a bug to fix rather than a failure to journal. See
  [the errors API](https://errors.smithers.sh/reference/api/) for `SmithersError`.
- Explicit configuration wins over the environment, and a passed `env` record
  replaces the ambient environment rather than layering over it.

## Example

```ts
import { GitHub } from "@smthrs/integrations"

const client = GitHub.GitHubClient.make({})

await Effect.runPromise(
  client.request("POST", "/repos/OWNER/REPO/issues/1/comments", { body: "Triaged." })
)
```

## Core

The service-agnostic pieces every provider builds on, exported as `Core`.

### Core.Signature

Constant-time HMAC-SHA256 verification, the check every webhook source uses.

| Export                    | Signature                                                   | Notes                                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verifySignature`         | `(options: VerifyOptions) => boolean`                       | Accepts GitHub's `sha256=<hex>`, a bare hex digest, and a base64 digest. Returns `false`, never throws, for a missing signature, an empty secret, a wrong prefix, or an undecodable digest. |
| `constantTimeEqual`       | `(left: Uint8Array, right: Uint8Array) => boolean`          | Always scans the longer input and folds the length difference into the result, so a mismatch leaks nothing through timing.                                                                  |
| `computeHmacSha256Hex`    | `(payload: string \| Uint8Array, secret: string) => string` | The lowercase hex digest, for signing test deliveries.                                                                                                                                      |
| `GITHUB_SIGNATURE_PREFIX` | `"sha256="`                                                 | The prefix GitHub puts in front of its hex digest.                                                                                                                                          |

`VerifyOptions` fields: `payload` (the exact bytes the provider signed, never
a re-serialized copy), `secret`, `signature` (nullable), and an optional
`prefix` that is required and stripped before decoding. Omit `prefix` to
strip an optional `sha256=` and otherwise accept a bare digest.

### Core.Channel

The binding between a provider webhook and a `@smthrs/control` `Channel`.
[How adapters sit on the control plane](/concepts/control-plane/) explains
the contract.

| Export             | Signature                                                                           | Notes                                                                                                                                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make`             | `(config: Config) => Channel`                                                       | Builds the control-plane channel for one provider webhook. A delivery whose signature does not verify fails `Unauthorized` before the decoder or `Control` is reached; the decoder's output is validated against `Core.ExternalEvent` before it leaves the channel. |
| `constantSecret`   | `(secret: Redacted<string>) => SecretResolver`                                      | Always answers with one secret, for a single-tenant deployment.                                                                                                                                                                                                     |
| `credentialSecret` | `(credentials: Credential) => SecretResolver`                                       | Resolves through the control plane's credential store.                                                                                                                                                                                                              |
| `startFlow`        | `(flowId: FlowId) => (event: ExternalEvent) => Effect<InboundResult, InvalidInput>` | A route that starts `flowId` with the event as its input.                                                                                                                                                                                                           |
| `signalRun`        | `(runId: RunId) => (event: ExternalEvent) => Effect<InboundResult, InvalidInput>`   | A route that signals `runId` with the event's signal name and payload.                                                                                                                                                                                              |

`Config` fields: `name` (the name `Channels.register` and `Channels.ingest`
address the channel by), `credential` (the journal-safe `CredentialRef`),
`secret` (a `SecretResolver`), optional `fingerprintHeaders` (non-secret
headers whose values affect the decoded event), `verify`, `decode`, `route`,
and an optional `project` that defaults to a no-op projection posting
nothing.

`SecretResolver` is
`(credential: Redacted<CredentialRef>) => Effect<Redacted<string>, Unauthorized>`.

### Core.ExternalEvent

The normalized event every source produces. Fields: `source` (the channel
or polling source id, defaulting to the provider name), `eventName`
(refined to a name `SignalName.eventName` could build), `correlationId`
(string or `null`), `payload` (JSON), `dedupeKey`, and `receivedAtMs`.

| Export          | Signature                                   | Notes                                                                                                                   |
| --------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ExternalEvent` | `Schema.Struct<...>`                        | The schema and its inferred type.                                                                                       |
| `decode`        | `(value: unknown) => Effect<ExternalEvent>` | Decodes an unknown value; fails with a schema issue. Sources run their own output through this at the ingress boundary. |

### Core.SignalName

The reserved `integration:` namespace and the mapping onto control-plane
signals and notifications.

| Export                      | Signature                                                              | Notes                                                                                                                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eventName`                 | `(service: string, event: string) => string`                           | Builds `integration:<service>:<event>`. The event segment may contain dots (`pull_request.opened`); neither segment may contain `:`. Both are trimmed. Throws `SmithersError` `INVALID_INPUT` for an empty or colon-bearing segment. |
| `parse`                     | `(name: string) => { service: string; event: string } \| null`         | Splits a name back into its parts. A name `eventName` could not have produced parses as `null`.                                                                                                                                      |
| `receivedBy`                | `(service: string) => string`                                          | The attribution stamped on a delivered signal: `integration:<service>`. Throws `INVALID_INPUT` for an empty or colon-bearing service.                                                                                                |
| `toSignalPayload`           | `(event: ExternalEvent) => SignalPayload`                              | The control-plane signal: name plus payload.                                                                                                                                                                                         |
| `toNotification`            | `(event: ExternalEvent, options: NotificationOptions) => Notification` | A queued `system-event` that coalesces on `<eventName>:<correlationId>`. `options.id` defaults to the event's dedupe key; `targetLineageId` and `provenance` are required.                                                           |
| `isSegment`                 | `(value: unknown) => value is string`                                  | The one refinement constructor and parser agree on.                                                                                                                                                                                  |
| `isEventName`               | `(value: unknown) => value is string`                                  | Whether `parse` accepts the value.                                                                                                                                                                                                   |
| `isIntegrationSignalName`   | `(name: unknown) => name is string`                                    | Whether the name carries the reserved prefix.                                                                                                                                                                                        |
| `INTEGRATION_SIGNAL_PREFIX` | `"integration:"`                                                       | A workflow's own signals must not use it.                                                                                                                                                                                            |

### Core.CursorStore

Durable cursor persistence for polling sources, deliberately limited to `get`
and `set`. The contract is ordering: a proposed cursor is committed after the
batch it acknowledges has been handled.

| Export        | Signature                               | Notes                                                                                                                      |
| ------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `CursorStore` | service tag and interface               | `get(sourceId): Effect<string \| null, IntegrationError>`; `set(sourceId, cursor): Effect<void, IntegrationError>`.        |
| `makeMemory`  | `Effect<CursorStore>`                   | Cursors live as long as the process.                                                                                       |
| `layerMemory` | `Layer<CursorStore>`                    | The in-memory store as a layer.                                                                                            |
| `makeSql`     | `Effect<CursorStore, never, SqlClient>` | Over the control database's `smithers_integration_cursors` table. Requires the migration in `Core.Migrations` to have run. |
| `layerSql`    | `Layer<CursorStore, never, SqlClient>`  | The SQL store as a layer.                                                                                                  |

### Core.Migrations

The cursor table's schema migrations. They run through
[the database API](https://database.smithers.sh/reference/api/)'s migration ladder in block `8000`, after
control (`6000`) and memory (`7000`). Compose `Core.Migrations.set` with the
other sets installed in a shared control database, or use it on its own for
a separate cursor database. The same composition can reopen the database
without resetting its cursor.

| Export  | Signature           | Notes                                                                |
| ------- | ------------------- | -------------------------------------------------------------------- |
| `set`   | `MigrationSet`      | Namespace `integrations`, one migration: `0001_integration_cursors`. |
| `run`   | `Effect<void, ...>` | Applies the set.                                                     |
| `layer` | `Layer<never, ...>` | Runs `run` once as a layer.                                          |

### Core.IntegrationError

The normalized provider-error vocabulary. Details are provider-safe by
construction: no constructor in this package puts a token, an API key, or a
webhook secret into `details`.

`new IntegrationError(reason, message, details?, { cause? }?)` extends
`SmithersError` with code `INTEGRATION_ERROR` and carries the
machine-readable `reason`.

| Reason                | Raised when                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-config`      | A declaration, option, or stored cursor is unusable.                                                                                                             |
| `invalid-signature`   | A webhook signature did not verify.                                                                                                                              |
| `decode-failed`       | A payload or response could not be read as expected.                                                                                                             |
| `poll-failed`         | A polling source's request failed.                                                                                                                               |
| `delivery-failed`     | An API call failed. `details.retryable` says whether another attempt is worth making, and `details.outcomeUnknown` says the write may already have been applied. |
| `credentials-missing` | A required credential was not configured.                                                                                                                        |
| `permission-denied`   | The credential lacks the scope the operation needs.                                                                                                              |
| `listener-conflict`   | An unowned hook holds a declared callback URL, or a reconcile apply lock is held.                                                                                |
| `rate-limited`        | A rate limiter refused to wait for the budget. Nothing was sent; `details.retryAt` is the instant to retry.                                                      |

| Export               | Signature                                       | Notes                                                                           |
| -------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `reasons`            | `readonly Reason[]`                             | Every classification, in one runtime list.                                      |
| `isReason`           | `(value: unknown) => value is Reason`           | Whether a value is a classification this build can encode.                      |
| `isIntegrationError` | `(error: unknown) => error is IntegrationError` | Guarded against cross-instance forgeries and throwing getters.                  |
| `isRetryable`        | `(error: unknown) => boolean`                   | True when the error is an `IntegrationError` with `details.retryable === true`. |
| `toUnauthorized`     | `(error: IntegrationError) => Unauthorized`     | Maps onto the control plane's `Unauthorized`. Only the summary crosses.         |
| `toInvalidInput`     | `(error: IntegrationError) => InvalidInput`     | Maps onto the control plane's `InvalidInput`.                                   |

### Core.ActionFailure

The failure a durable action journals: the schema form of `IntegrationError`.
[Durable actions](/concepts/durable-actions/) explains why a schema and
not the class.

| Export                 | Signature                                                    | Notes                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IntegrationFailure`   | `Schema.TaggedError`, tag `/integrations/IntegrationFailure` | Fields: `reason`, `message`, `retryable`, optional `outcomeUnknown`, optional `deliveredMessageIds`.                                                                                                    |
| `fromIntegrationError` | `(error: unknown) => IntegrationFailure`                     | Total: anything that is not a well-formed `IntegrationError` converts to a non-retryable `delivery-failed` instead of throwing inside `Effect.mapError`. The message is capped at `MAX_MESSAGE_LENGTH`. |
| `toIntegrationError`   | `(failure: IntegrationFailure) => IntegrationError`          | Converts back to the class, preserving `retryable`, `outcomeUnknown`, and `deliveredMessageIds` in `details`.                                                                                           |
| `Reason`               | schema                                                       | The classification as a schema, built from `IntegrationError.reasons`.                                                                                                                                  |
| `MessageId`            | schema                                                       | A provider message id: a positive integer within the safe range.                                                                                                                                        |
| `isMessageId`          | `(value: unknown) => value is number`                        | The refinement `MessageId` applies.                                                                                                                                                                     |
| `MAX_MESSAGE_LENGTH`   | `512`                                                        | The longest provider text a failure persists.                                                                                                                                                           |

### Core.Pkce

RFC 7636 PKCE parameters for the GitHub OAuth apps. All three
constructors throw `TypeError` or `RangeError` for invalid arguments.

| Export                | Signature                           | Notes                                                                                          |
| --------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `createPkcePair`      | `(byteLength?: number) => PkcePair` | A fresh verifier with its S256 challenge.                                                      |
| `createCodeVerifier`  | `(byteLength?: number) => string`   | 32 to 96 bytes of entropy, producing the 43 to 128 characters RFC 7636 allows. Defaults to 32. |
| `deriveCodeChallenge` | `(codeVerifier: string) => string`  | Base64url of the verifier's SHA-256, unpadded.                                                 |

`PkcePair` fields: `codeVerifier`, `codeChallenge`, and
`codeChallengeMethod: "S256"`.

### Core.AuthorizationUrl

The RFC 6749 authorization-code request URL, with PKCE.

| Export                  | Signature                                   | Notes                                                                                                                                                                          |
| ----------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `buildAuthorizationUrl` | `(request: AuthorizationRequest) => string` | Throws `TypeError` for a non-HTTP(S) endpoint, an empty required field, or an `extraParams` key in `RESERVED_PARAMS`. `response_type` stays overridable through `extraParams`. |
| `RESERVED_PARAMS`       | `readonly string[]`                         | `client_id`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method`: the CSRF and PKCE bindings the builder validates.                                             |

`AuthorizationRequest` fields: `authorizationEndpoint` (absolute `http:` or
`https:` URL; its own query parameters survive), `clientId`, `redirectUri`,
`state`, `codeChallenge`, optional `scope` (a string, or scopes to
space-join; omitted when empty), optional `codeChallengeMethod` (defaults to
`S256`), and optional `extraParams` applied after the standard parameters.

### Core.JsonPath

Dot-path reads over decoded provider payloads, used by the decoders instead
of type assertions.

| Export         | Signature                                                | Notes                                                                                                        |
| -------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `readJsonPath` | `(value: unknown, path?: string \| null) => unknown`     | Only own properties are read; arrays count as non-objects; an empty or absent path returns the value itself. |
| `readString`   | `(value: unknown, path: string) => string \| undefined`  | The value when it is a non-empty string.                                                                     |
| `readInteger`  | `(value: unknown, path: string) => number \| undefined`  | The value when it is an integer.                                                                             |
| `readHeader`   | `(raw: HasHeaders, name: string) => string \| undefined` | Case-insensitive header lookup over a transport-neutral record.                                              |

`HasHeaders` is anything with `headers` in the `RawInbound` shape.

### Core.AccessToken

Where a client gets its bearer token. `AccessTokenSource` has `token`
(`Effect<Redacted<string>, IntegrationError>`) and `invalidate`, which drops a
cached token after the provider refused it. `fixed(token)` always answers the
same token.

### Core.OAuthToken

Short-lived OAuth access tokens minted from a stored refresh token, behind an
`AccessTokenSource`. `make(options)` caches a token until `skew` before it
expires and refreshes on demand; a rotated refresh token is written back
through the `RefreshTokenStore` (`memoryStore`, or `credentialStore(credentials, reference)`
over the control plane's credential boundary with a compare-and-set).
`exchangeCode` completes an authorization-code grant. `reasonForOAuthError`
maps an OAuth error code to an `IntegrationError` reason.

### Core.Connection

A configured provider connection as journal-safe data: `id`, `provider`,
`label`, `credential` (a `CredentialReference`, never the secret), the granted
`scopes`, `personal`, `containers`, and an optional `apiBaseUrl`.

| Export              | Signature                                                                                           | Notes                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `Connection`        | schema                                                                                              | `decode` decodes an unknown value.                                                                                                 |
| `ANY_CONTAINER`     | `"*"`                                                                                               | Allows every container. An empty list allows none.                                                                                 |
| `containersAllowed` | `(connection, container: string) => boolean`                                                        | Whether the connection lists the container or `*`.                                                                                 |
| `personalPolicy`    | `({ personalPrincipals, shared? }) => Authorize`                                                    | Fail-closed host policy: a personal connection only for the named principals.                                                      |
| `resolveSecret`     | `({ credentials, connection, principal, authorize }) => Effect<Redacted<string>, IntegrationError>` | Asks `authorize` first, then the broker. A refusal is `permission-denied`; missing or unopenable storage is `credentials-missing`. |

### Core.SourceRecord, Core.SourceStore, Core.Source, Core.Sync

Retrieved provider objects as versioned, access-scoped records, and the
driver that keeps them current.

- `SourceRecord`: the record schema (identity, `access` scope and containers,
  `thread`, author, text, payload, version, deletion) with `compare`,
  `supersedes`, `tombstone`, and `reference`.
- `SourceStore`: `layerMemory` and `layerSql` (requires `Core.Migrations`).
  `commit` applies a page and advances the stream cursor in one transaction;
  a copy replaces the stored one only when it is newer; tombstones and
  revocation purge content; `retrieve` filters by the caller's `Grant`s inside
  the query; `validate` re-checks references a run kept.
- `Sync.runSync(adapter, options)`: reads the committed cursor, asks the
  `SyncAdapter` for pages, and commits each. A `reset` listing tombstones
  whatever it did not contain. A revoked connection is refused first.
- `Source.runWithCursor`: the polling-source loop over `CursorStore` that
  commits a cursor only after the handler succeeds.

## Environment

`@smthrs/integrations/Environment`: explicit access to the host's process
environment, the one place the package spells that decision.

| Export               | Signature                                             | Notes                                                                                                                        |
| -------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ambientEnvironment` | `() => Readonly<Record<string, string \| undefined>>` | Reads the ambient process environment. Callers that require account isolation pass an environment record explicitly instead. |

## GitHub

The GitHub surface, exported as `GitHub` or from `@smthrs/integrations/github`.

### GitHub.Config

Credential and endpoint resolution. Explicit configuration wins; what it
omits falls back to `env`, which defaults to the ambient environment.

`GitHubConfig` fields: `token` (falls back to `SMITHERS_GITHUB_TOKEN`, then
`GITHUB_TOKEN`), `apiBaseUrl` (falls back to `SMITHERS_GITHUB_API_BASE_URL`,
default `https://api.github.com`), `maxRetries` (defaults to 3), and
`requestTimeout` (defaults to 30 seconds).

`requestTimeout` is the deadline for one attempt, covering the response
headers and the body read. The retry budget bounds only completed attempts, so
without it a peer that answers and then trickles the body forever holds the
call open. It must be a finite, positive `Duration.Input`.

| Export                    | Signature                                               | Notes                                |
| ------------------------- | ------------------------------------------------------- | ------------------------------------ |
| `resolve`                 | `(config?: GitHubConfig, env?) => ResolvedGitHubConfig` | First non-empty value wins, trimmed. |
| `DEFAULT_API_BASE_URL`    | `"https://api.github.com"`                              | The public REST endpoint.            |
| `DEFAULT_REQUEST_TIMEOUT` | `Duration.seconds(30)`                                  | The default per-attempt deadline.    |

### GitHub.GitHubClient

The REST client. Rate-limit handling, bounded pagination, and token hygiene:
the token reaches the `Authorization` header and nothing else, and every
request URL, including a `rel="next"` target, is pinned to the configured API
origin. A 3xx is not followed: it fails `delivery-failed` with its status, so
the token never reaches a `Location` host. Provider and transport errors redact the token and Authorization
header value from summaries, details, and retained cause messages before
construction. Raw upstream stacks and nested causes are discarded.

Service interface:

| Method     | Signature                                                                                                                                                                                                                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`  | `(method: RequestMethod, path: string, body?: unknown, options?: RequestOptions) => Effect<unknown, IntegrationError>`, or `<A>(method: RequestMethod, path: string, body: unknown, options: DecodedRequestOptions<A>) => Effect<A, IntegrationError>` | One REST call. Without a schema the result is the parsed JSON as `unknown`; a `schema` decodes it, fixes the result type, and fails `decode-failed` when the body does not match. A rate limit (a 429, or the 403 forms GitHub uses for a secondary limit) is retried for every method, waiting the server's `Retry-After` or `x-ratelimit-reset` capped at one minute. A 5xx or transport failure is retried only for a read; on a write it reports `outcomeUnknown` unless `retryUnsafeWrites` is set. An unserializable body or an unparseable path fails `invalid-config` before any request. Interrupting the fiber aborts the request in flight. Each attempt also carries the configured `requestTimeout`; expiring aborts the exchange and fails `delivery-failed` with `timedOut: true`, and on a write with `outcomeUnknown: true`. |
| `paginate` | `(path: string, options?: { perPage?: number; maxPages?: number }) => Effect<Page, IntegrationError>`                                                                                                                                                  | Follows `Link: rel="next"` within the page budget and concatenates the pages. `perPage` defaults to 100 and accepts 1 to 100; `maxPages` defaults to 10 and accepts 1 to 1000. A bound outside its range fails `invalid-config` before the first request. Running out of budget with a next link outstanding is reported as `truncated: true`, never as a short but complete answer.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

| Export                | Signature                                                                | Notes                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GitHubClient`        | service tag and interface                                                |                                                                                                                                                                                                |
| `make`                | `(config?: GitHubConfig, env?) => GitHubClient`                          | Throws `IntegrationError` `invalid-config` for an `apiBaseUrl` that is not a valid HTTP(S) URL, a `maxRetries` outside 0 to 10, or a `requestTimeout` that is not a finite, positive duration. |
| `layer`               | `(config?: GitHubConfig, env?) => Layer<GitHubClient, IntegrationError>` | The client as a layer. An invalid config fails the build with `invalid-config`.                                                                                                                |
| `isRateLimitResponse` | `(status: number, headers: Headers, body: unknown) => boolean`           | Whether a response is GitHub telling the client to slow down.                                                                                                                                  |
| `retryAfterMs`        | `(headers: Headers, nowMs?: number) => number \| null`                   | The wait the server asked for, capped at one minute.                                                                                                                                           |
| `nextPageUrl`         | `(linkHeader: string \| null) => string \| null`                         | The `rel="next"` URL in an RFC 5988 `Link` header.                                                                                                                                             |
| `UNSAFE_METHODS`      | `readonly RequestMethod[]`                                               | `POST`, `PATCH`, `PUT`, `DELETE`: the verbs whose effect the server may already have applied when the answer is lost.                                                                          |
| `MAX_PER_PAGE`        | `100`                                                                    | The largest `per_page` GitHub accepts.                                                                                                                                                         |
| `DEFAULT_MAX_PAGES`   | `10`                                                                     | The default page budget.                                                                                                                                                                       |
| `MAX_PAGES_LIMIT`     | `1000`                                                                   | The largest accepted page budget.                                                                                                                                                              |
| `PROXY_RETRY_AT`      | `"x-smithers-retry-at"`                                                  | The header in which the GitHub proxy names when a refused request may be retried.                                                                                                              |
| `PROXY_REASON`        | `"x-smithers-rate-limit-reason"`                                         | The header in which the GitHub proxy names why it refused.                                                                                                                                     |

A `429` that carries `PROXY_RETRY_AT` comes from the [GitHub proxy](#githubproxy),
which never sent the request to GitHub. The client fails `rate-limited` at once
with `details.retryAt` and does not repeat the call, because a retry before
that instant only waits again.

`RequestOptions` fields: `query` and `retryUnsafeWrites`.
`DecodedRequestOptions<A>` adds the required `schema`, whose type is the
request's result type: a caller cannot name a response type the client never
decoded. `Page` fields: `items` and `truncated`. `RequestMethod` is
`"GET" | "POST" | "PATCH" | "PUT" | "DELETE"`.

### GitHub.RateLimit

The limiter the [GitHub proxy](#githubproxy) runs for each principal, so a
machine stays inside GitHub's documented limits. Before a request it waits for
a write slot (`POST`, `PATCH`, `PUT`, `DELETE`: 1 s apart, at most 80 a minute
and 500 an hour), a concurrency permit (50), the pause a limit response
imposed, and the primary budget of the request's resource, modeled from every
response's `x-ratelimit-*` headers. A `403` or `429` limit response pauses
every caller: for `retry-after`, until `x-ratelimit-reset` when the budget is
spent, or for at least a minute, doubling while limits persist. A wait longer
than `maxWait` fails `rate-limited` without running the request.

| Export             | Signature                                                                             | Notes                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make`             | `(options?: { limits?: Limits; maxWait?: Duration }) => Effect<RateLimiter>`          | A limiter with its own state.                                                                                                                                                                                     |
| `RateLimiter`      | `{ limit(method, path, attempt, observe), earliestStart(writes, path) }`              | `limit` runs `attempt` once the budget allows and folds `observe(exit)` into it; `earliestStart` books nothing.                                                                                                   |
| `Observation`      | `{ headers?: Headers; limited: boolean }`                                             | What one finished attempt tells the limiter.                                                                                                                                                                      |
| `resolveLimits`    | `(explicit?: Partial<Limits>, env?) => Limits`                                        | Explicit values, then `SMITHERS_GITHUB_MAX_CONCURRENT`, `_WRITE_SPACING_MS`, `_WRITES_PER_MINUTE`, `_WRITES_PER_HOUR`, `_MIN_PAUSE_MS`, `_MAX_PAUSE_MS`, then the defaults. Throws for a value below its minimum. |
| `DEFAULT_LIMITS`   | `Limits`                                                                              | 50 concurrent, 1000 ms spacing, 80 per minute, 500 per hour, 60 s minimum pause, 1 h maximum pause.                                                                                                               |
| `DEFAULT_MAX_WAIT` | `Duration.minutes(1)`                                                                 | The longest one request waits.                                                                                                                                                                                    |
| `rateLimited`      | `(retryAt: number, reason: string, method: string, path: string) => IntegrationError` | The `rate-limited` failure: `details` carries `retryAt`, `reason`, `method`, `path`, `rateLimited: true`, `retryable: false`.                                                                                     |
| `waits`, `pauses`  | `Metric` counters                                                                     | `smithers_github_rate_limit_waits` by `reason` (`spacing`, `paused`, `budget`) and `smithers_github_rate_limit_pauses`.                                                                                           |

### GitHub.Proxy

The machine's one GitHub client: a reverse proxy that every other GitHub
client on the machine calls instead of `api.github.com`. It owns one
`RateLimit` limiter per principal and the credential: it drops any
`Authorization` a caller sends and injects the principal's token. A request
the limiter will not wait for is answered `429` with `retry-after`,
`PROXY_RETRY_AT`, and `PROXY_REASON`. Everything else is forwarded once with
GitHub's status, headers, and body; a `rel="next"` link is rewritten to the
proxy. A transport failure is `502` and a deadline `504`; the proxy never
repeats a request. The [GitHub guide](/guides/github/#stay-inside-githubs-rate-limits)
shows how to run it.

| Export           | Signature                                                                                 | Notes                                                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make`           | `(options: ProxyOptions) => Effect<Effect<HttpServerResponse, never, HttpServerRequest>>` | The proxy as an HTTP application.                                                                                                                                                                       |
| `layer`          | `(options: ProxyOptions) => Layer<never, never, HttpServer>`                              | Serves it on the `HttpServer` in context, such as `NodeHttpServer.layer`.                                                                                                                               |
| `ProxyOptions`   | `{ credential, upstream?, capability?, limits?, maxWait?, requestTimeout? }`              | `credential(repository)` answers `{ token, principal }` for a request on `owner/name` or on no repository. `capability`, when set, is required from every caller as `Authorization: Bearer` or `token`. |
| `Credential`     | `{ token: string; principal: string }`                                                    | Credentials with one `principal` share one budget.                                                                                                                                                      |
| `repositoryOf`   | `(path: string) => string \| undefined`                                                   | The `owner/name` a REST path addresses.                                                                                                                                                                 |
| `CONTROL_PREFIX` | `"/_smithers/"`                                                                           | `GET /_smithers/health` answers `{ ok: true }`. `GET /_smithers/admission?repo=owner/name&writes=n` answers `{ principal, startsAt, deferred }` without booking anything.                               |

### GitHub.Repository

Repository coordinates, validated before they become a request path. Encoding
is not enough: `encodeURIComponent("..")` is `".."`, and the URL parser
removes dot segments afterwards, so an unvalidated repository string walks a
token-bearing request to a different GitHub endpoint on the same origin.
Every path this package builds from an owner and a repository goes through
`repositoryPath`.

| Export                  | Signature                                                           | Notes                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `repositoryPath`        | `(owner: string, repo: string) => string`                           | Validated, then encoded. Throws an `IntegrationError` `invalid-config` when either half is not a name GitHub could have issued.                 |
| `fullNamePath`          | `(fullName: string) => string`                                      | The same, for the `owner/repository` spelling a listener declaration uses.                                                                      |
| `requireRepositoryPath` | `(owner: string, repo: string) => Effect<string, IntegrationError>` | `repositoryPath` in the Effect channel.                                                                                                         |
| `requireFullNamePath`   | `(fullName: string) => Effect<string, IntegrationError>`            | `fullNamePath` in the Effect channel.                                                                                                           |
| `isOwner` / `isRepo`    | `(value: unknown) => value is string`                               | Refinements over `OWNER_PATTERN` and `REPO_PATTERN`.                                                                                            |
| `Owner` / `Repo`        | schemas                                                             | The same rules as schemas an action payload can demand.                                                                                         |
| `IssueNumber`           | schema                                                              | An integer of at least 1.                                                                                                                       |
| `OWNER_PATTERN`         | regex                                                               | 1 to 39 characters, alphanumerics and hyphens, not starting with a hyphen, with one underscore allowed as an Enterprise Managed User separator. |
| `REPO_PATTERN`          | regex                                                               | 1 to 100 characters of alphanumerics, dots, underscores, and hyphens, excluding `.` and `..`.                                                   |

### GitHub.Payload

Schemas for the webhook payloads this package types: `User`, `Repository`,
`PullRequest`, `Issue`, `Comment`, `PullRequestEvent`, `IssuesEvent`,
`IssueCommentEvent`, and `PushEvent`. Every schema validates the fields a
caller is likely to read and passes everything else through untouched.

### GitHub.Actions

The durable GitHub actions. [Durable actions](/concepts/durable-actions/)
explains the pattern.

| Export                                                                          | Signature                                                     | Notes                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CommentOnIssue`                                                                | `Action`, tag `integrations/github/comment-on-issue`          | Posts a comment on an issue or pull request. Tier `irreversible`. Error schema `IntegrationFailure`.                                                                                                   |
| `CommentOnIssuePayload`                                                         | schema                                                        | `owner`, `repo`, `issueNumber`, `body`. The coordinates demand the `Owner` and `Repo` shapes, so a payload built from a webhook body or a model's output fails to decode rather than reaching the API. |
| `Comment`                                                                       | schema                                                        | The comment GitHub created: `id` and `url`.                                                                                                                                                            |
| `layerCommentOnIssue`                                                           | `Layer<Requirement<...>, never, GitHubClient \| FlowRuntime>` | Implements the action over the client in context.                                                                                                                                                      |
| `retryPolicy`                                                                   | `RetryPolicy`                                                 | Three attempts, 0.5 s then 1 s apart, for the keyed write-back actions below.                                                                                                                          |
| `AddLabels`                                                                     | `Action`, tag `integrations/github/add-labels`                | Adds the labels in `labels` the issue lacks, compared without case. Keyed; reads the labels first. Success: `added`, `labels`.                                                                         |
| `UpsertComment`                                                                 | `Action`, tag `integrations/github/upsert-comment`            | Creates, edits or leaves the one comment whose first line is `stickyMarker(key)`. Keyed. Fails without writing on a thread longer than `RECONCILE_PAGES` pages. Success: `id`, `url`, `outcome`.       |
| `stickyMarker`                                                                  | `(key: string) => string`                                     | `<!-- smithers:key=KEY -->`.                                                                                                                                                                           |
| `CheckRun`                                                                      | `Action`, tag `integrations/github/check-run`                 | Creates or updates the check run whose `external_id` is `key` on `headSha`. Keyed. Needs a GitHub App installation token. Success: `id`, `url`, `status`, `conclusion`, `created`.                     |
| `LinkPullRequest`                                                               | `Action`, tag `integrations/github/link-pr`                   | Appends `Closes <issue>` to the pull request's description unless `closesIssue` already finds one. Keyed. Success: `pullNumber`, `url`, `reference`, `updated`.                                        |
| `closesIssue`                                                                   | `(body, issue, sameRepository) => boolean`                    | Whether a description closes the issue with any GitHub closing keyword.                                                                                                                                |
| `layerAddLabels`, `layerUpsertComment`, `layerCheckRun`, `layerLinkPullRequest` | same as `layerCommentOnIssue`                                 | Implement each action over the client in context.                                                                                                                                                      |
| `layer`                                                                         | same                                                          | Every GitHub action's implementation in one layer.                                                                                                                                                     |

### GitHub.Sync

`make(options)` is a `Core.Sync` adapter over one repository's issues, pull
requests, and issue comments, paged by change time so an item edited during a
walk is met again. External ids use the numeric repository id
(`repo:<id>:issue:<number>`, `repo:<id>:comment:<id>`); `issueId` and
`commentId` build them. Public repositories give `public` records, private
ones `container`-scoped records. Deletions are not listed by GitHub; run a
`fullListing` adapter periodically or map the deletion webhooks to
tombstones.

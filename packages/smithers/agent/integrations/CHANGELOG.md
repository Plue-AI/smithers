# @smthrs/integrations

## [Unreleased]

### Removed

- Deferred Linear, Slack, Telegram, Gmail, Google Calendar, and X adapters
  from the MVP. GitHub, shared webhook channels, durable dispatch, and stored
  integration data remain. Earlier entries below describe pre-cut behavior.
  Restoration source: `0448786fcd3634143161c29117cf6dbedef1be33`
  ([#3389](https://github.com/smithersai/smithers/issues/3389)).

### Added

- `GitHub.Proxy` and `GitHub.RateLimit`: one reverse proxy per machine that
  every GitHub client calls instead of `api.github.com`. It holds the
  credential and one limiter per principal enforcing GitHub's documented
  limits: the primary budget from `x-ratelimit-*`, 50 concurrent requests,
  writes 1 s apart and at most 80 a minute and 500 an hour, and a pause of
  every caller on a `403` or `429` limit response. A request it will not wait
  for is a `429` with `x-smithers-retry-at`, which `GitHubClient` reports as
  the new `rate-limited` reason with `details.retryAt`.
- `Slack`: a Web API client, the Events API door, a Socket Mode source that
  acknowledges an envelope only after its handler succeeds, durable
  `PostMessage`/`UpdateMessage`/`Reconcile` actions, Block Kit approvals, and
  a conversation change feed. `Slack.Payload.Policy.allowedUserIds` admits an
  owner's direct messages without listing the `D…` conversation and limits
  every admitted delivery to those people. `Slack.Config.policy` reads the
  allowlists from `SMITHERS_SLACK_*` variables. `Slack.Connections.fromEnvironment`,
  `layerFromEnvironment`, and `fromConnection` build the connection an action
  posts through from the environment or the credential broker; tokens stay
  `Redacted`, and the `"*"` container admits every channel.
  `PostMessage.persona` posts under a role's name and icon
  (`chat:write.customize`). `Slack.Approval.pressedToken` names the prompt a
  press belongs to.
- `GoogleCalendar`, `Gmail`, and `X` as library code: clients, change feeds
  into source records, Calendar event actions, and Gmail draft/send actions.
  X is read-only; its client writes are not durable actions.
- `Core.AccessToken`, `Core.OAuthToken`, `Core.Connection`, `Core.Source`,
  `Core.SourceRecord`, `Core.SourceStore`, `Core.Sync`, and `GitHub.Sync`:
  connections, token sources, source records, and the sync driver, with
  public subpaths.

### Removed

- **Breaking:** `GitHub.Webhook` (the GitHub webhook channel and its
  `author_association` sender gate), `GitHub.ListenerRegistry`,
  `GitHub.Config`'s `webhookSecret`, and `Environment.ambientWorkingDirectory`.
  GitHub webhooks enter through the Smithers backend, which decides whether an
  event may start work. The `smithers integrations reconcile` command is
  removed with the registry.

### Changed

- `Telegram.Approval.decision` returns an `Outcome`: `Decided` only for an
  authorized press of an option the prompt offered, otherwise `Ignored` with
  a `reason`. A non-approver's press or a press on another prompt used to read
  as a rejection, so any chat member could deny an approval.
- `LinearClient.query` defaults `retryServerErrors` to false for a document
  containing a mutation, so a raw mutation that hits a 5xx reports
  `outcomeUnknown` instead of running twice.
- The GitHub, Linear, and Telegram client layers fail with a typed error for a
  bad config instead of dying with a defect.
- `Linear.Webhook.channel` no longer accepts `nowMs`, which froze the replay
  window clock for the channel's lifetime.

### Fixed

- `Telegram.Source.run` retries a transient `getUpdates` failure with capped
  exponential backoff instead of stopping on the first network error or 5xx.
- Linear and Telegram serialize request bodies before sending, so a BigInt or
  cyclic value fails `invalid-config` with a known outcome.
- GitHub requests and pagination, Linear queries, and listener reconciliation
  run in spans carrying method, path, attempts, and failure class.

## [1.0.0-rc.0] - 2026-09-01

The first public release candidate. Everything below is the surface it ships.

### Added

- Added `GitHub.Repository`, which validates an owner and a repository before
  either becomes part of a request path, and made it the only way this package
  builds one. `GitHub.Actions.CommentOnIssuePayload` demands the same shapes.
- Added `retryUnsafeWrites` to `GitHub.GitHubClient`'s request options, and
  `outcomeUnknown` to the failure a write raises when its result is unknown.
- Added `truncated` to what `GitHub.GitHubClient.paginate` returns, and bounds
  on `perPage`, `maxPages`, and `maxRetries`.
- Added `idempotencyKey` to `GitHub.Webhook`, `Linear.Webhook`, and
  `Telegram.Source`, so an ingress can derive the delivery identity that
  `Channels.ingest` needs to drop a redelivery.
- Added `Telegram.TelegramClient.toIntegrationError`, so a Bot API failure
  reaches the journal with a machine-readable reason.
- Added a bounded `pending` record to the listener ownership state, so a run
  interrupted between creating a hook and claiming it converges instead of
  reporting a permanent conflict. The record is retired on a refusal, dropped
  when the declaration changes, expires after `PENDING_CREATE_MAX_AGE_MS`, and
  adopts only when exactly one hook holds the URL.
- Added `outcomeUnknown` and `deliveredMessageIds` to
  `Core.ActionFailure.IntegrationFailure`, so an ambiguous write and a partial
  Telegram send are legible in the journal rather than only on the client
  error.
- Added `Environment.ambientWorkingDirectory`, package-owned documentation
  under `docs/`, and the `PACKAGE.ts` target that generates the published API
  page from it.
- Added `Core.ActionFailure.isMessageId` and `Core.ActionFailure.MessageId`,
  the one rule the Telegram guard, the journal conversion, and the persisted
  schema all read, so a list one accepts and another rejects cannot put a throw
  back into `Effect.mapError` or a `NaN` into a journal row.
- Added an exclusive workspace lock at `GitHub.ListenerRegistry.DEFAULT_LOCK_PATH`,
  held for the whole of an applying `reconcile`. Two applying runs in one
  workspace used to read the same state, plan the same `create`, and each POST
  it, leaving two hooks on one callback URL with only the second recorded: the
  first was orphaned, unowned, and doubling every delivery. The pending record
  converges an interrupted run, not a concurrent one, because both processes
  write theirs before either POSTs. A holder older than
  `PENDING_CREATE_MAX_AGE_MS`, and a record that does not parse, are reclaimed,
  so a crashed run cannot wedge the workspace; a planning run neither takes the
  lock nor waits for one.

### Changed

- Stop repeating a non-idempotent write. A rate limit is still retried for
  every method, because the request was refused rather than performed; a 5xx or
  a dropped connection on a POST, PATCH, PUT, or DELETE is not. The same rule
  applies to `issueCreate`, `issueUpdate`, and `commentCreate` in
  `Linear.LinearClient`.
- Give `Telegram.TelegramClient` and `Telegram.Source` the `(config, env)`
  signature the other providers have, so `SMITHERS_TELEGRAM_BOT_TOKEN` is
  actually read.
- Fail closed in `Telegram.Source` when an allowlist is configured and an
  update's chat cannot be determined, when a stored cursor does not parse, and
  when `getUpdates` returns something that is not an update array.
- Scope Telegram dedupe keys to the source id, since `update_id` is per bot.
- Treat an absent or empty approval token as matching nothing, and tighten
  `parseCallbackData` to the grammar `callbackData` emits.
- Validate `Telegram.Chunk.chunk`'s `maxLength`, which used to hang the event
  loop at zero, and never split a surrogate pair.
- Read own properties only in `Core.JsonPath.readJsonPath`.
- Refuse an `extraParams` entry that would overwrite an OAuth or PKCE
  parameter.
- Close `Core.SignalName.parse` over the names `eventName` can build.
- Enforce the documented "exactly one of `teamKey` and `teamId`", normalize a
  team key for both the cache and the query, freeze the cached team, and treat
  an explicit empty `labels` array as a request to clear labels.
- Run the unowned-callback collision check before every listener `create`, not
  only the one for a listener with no ownership entry, and plan a `delete` only
  for a hook that is still there, so an interrupted repository move finishes on
  the next run instead of retrying a delete GitHub answers 404.
- Raise the default coverage thresholds to the exact figures reached by real
  HTTP and SQLite tests for listener reconciliation, cursor failures, Linear
  response and retry paths, and Telegram retries, envelopes, interrupts, and
  multipart documents. Remove four guards that cannot receive their rejected
  values through the declared types and package call sites.
- Refuse a `Telegram.Approval.token` id that is not a non-empty string and a
  `Telegram.Approval.callbackData` token that is not a string, with
  `INVALID_INPUT` naming the argument. Both are reachable from JavaScript,
  where the parameter types are not enforced: an absent id used to raise a bare
  `TypeError` naming a property, and an empty one hashed to a namespace every
  miscalled prompt shared. An empty token stays legal, because that is the
  prompt a spec with no token asks for and it resolves for nobody.

### Fixed

- Fixed the CommonJS build of the migration set.
  `src/core/IntegrationCursorMigration.ts` exports `integrationCursors` as a
  named binding and `src/core/Migrations.ts` imports it by name, because
  esbuild's Node interop for a default import of a sibling module resolved to
  the whole exports object instead of the Effect, so `Core.Migrations.set` in
  `dist/cjs` held a value with no `pipe` and the migrator failed for every
  `require` consumer. Neither module is an export map entry: `Core.Migrations`
  is the only way in, and `./core/migrations/0001_integration_cursors` stays
  denied for anyone who imported the schema installation directly.
- Fixed the typed-failure channels that died as defects instead: a missing or
  unparseable listener registry, an ownership-state write, a Linear priority
  outside the scale, a caller-supplied webhook verifier that throws, a request
  path that is not a URL, and a forged or drifted `IntegrationError` reaching
  `fromIntegrationError`.
- Fixed provider responses being cast rather than decoded. A malformed GitHub
  hook list or Linear connection now fails `decode-failed` naming the field
  path, never carrying the body.
- Fixed a multi-chunk Telegram send reporting more messages than it could name,
  and made a partial send report the ids it had already delivered.
- Fixed `Telegram.InitData` reporting a malformed `publicKeyHex` as an
  unsupported runtime, and bounded the freshness window at both ends.
- Fixed the Linear webhook accepting an unbounded replay window, and a
  fractional `maxTimestampSkewMs` the option's own documentation forbids.
- Fixed `GitHub.Repository` refusing a GitHub Enterprise Managed User's
  `<name>_<shortcode>` login, which locked every enterprise-managed account out
  of the package. Only `.` and `/` can walk a request off its endpoint, and
  neither is in the widened class.
- Fixed a `sendMessage` the Bot API answered with an unusable `message_id`
  reaching the journal as an ambiguous delivery. The message was delivered and
  only its receipt is unreadable, so it is now `decode-failed` with a known
  outcome rather than a write an operator might resend.
- Fixed `Linear.LinearClient.resolveTeam` erasing a wrong-typed `key` or `name`
  on a resolved team to `undefined`, which turned "Linear changed this field"
  into "this team has no key". It now fails `decode-failed` naming the path, the
  rule the other connection readers already followed.
- Fixed the error contract in `docs/api.md` claiming every failure a caller sees
  is an `IntegrationError`. GitHub and Linear clients, sources, channels, and
  durable actions use that vocabulary; the Telegram client maps its
  `TelegramApiError` at the action boundary, and plan-time helpers throw.
- Fixed a request body that cannot be serialized being reported as a write
  whose outcome is unknown, a `sendMessage` result with a non-positive
  `message_id` counting as delivered, a `getUpdates` cursor read through
  `Number()` rather than as a decimal offset, an update member of the wrong
  shape reaching the mapper, an empty Telegram source id, an approval press
  whose select key carries a colon, and an `ExternalEvent` carrying a signal
  name `SignalName.eventName` could not build.
- Fixed the false claims in the README and the published API page: the Telegram
  environment variable, the redelivery guarantee, the retry promise on an
  irreversible action, and the uniform error contract.
- Fixed `Telegram.TelegramClient.isTelegramApiError` admitting a claimed Bot
  API failure that carries no `deliveredMessageIds`, which made
  `toIntegrationError` spread a missing array and throw a bare `TypeError`
  inside `Effect.mapError`, where a throw is a defect rather than the
  classified failure the action's type promises. A list whose members are not
  all message ids is now dropped rather than journaled, since `Schema.Number`
  encodes a non-finite member as the string "NaN".
- Fixed malformed successful Bot API responses being classified as delivery
  failures. Non-JSON bodies, non-envelope values, and missing or invalid `ok`
  members on HTTP 200 now map to `decode-failed` with a known outcome.
- Fixed `GitHub.ListenerRegistry.parseRegistry` accepting two listeners that
  declare one repository and one callback URL, which is one GitHub hook. The
  pair asked reconciliation for a second hook doubling every overlapping
  delivery, and reached apply as a `conflict` blaming an unowned hook this
  workspace had created itself. It is now refused at the declaration, naming
  both listener ids.
- Fixed `GitHub.ListenerRegistry.reconcile` dying on a malformed client
  configuration. `GitHub.GitHubClient.make` parsed `apiBaseUrl` with a bare
  `new URL`, and reconciliation built its default client outside the typed
  boundary, so an unparseable or non-HTTP base URL escaped an effect declared
  to fail only with `IntegrationError`. Both now report `invalid-config`.
- Fixed the hook id in a GitHub create or update answer being coerced rather
  than decoded. `Number(hook?.id)` read `{"id": true}` as hook 1 and
  `{"id": "42"}` as 42, so this workspace could record ownership of a hook
  GitHub never named. Only a positive safe integer is accepted; an absent id
  still keeps the planned hook id, and anything else fails `decode-failed`
  without writing ownership.
- Fixed `Linear.LinearClient` silently discarding a conflicting issue field.
  Passing both `stateId` and `stateName`, or both `labelIds` and `labels`,
  dropped the name and filed the caller's other intent on an action whose tier
  is irreversible. Both now fail `decode-failed` before any mutation is sent,
  the rule `resolveTeam` already applied to `teamId` and `teamKey`.
- Fixed the Bot API envelope being read through a cast once its outer shape had
  been checked. A wire `error_code` of `"429"` landed on `TelegramApiError`'s
  numeric field, which then failed `isTelegramApiError`, so the failure lost its
  classification, the plain-text parse-entity fallback stopped firing, and a
  partial multi-chunk send stopped naming its delivered ids. `ok`,
  `error_code`, `description`, and `parameters.retry_after` are each decoded by
  type now, and a success envelope with no `result` is `decode-failed`.
- Fixed the action-boundary conversions still being able to throw. Their
  documentation promised a total conversion, but `isIntegrationError`,
  `Core.ActionFailure.fromIntegrationError`, `isTelegramApiError`, and
  `Telegram.TelegramClient.toIntegrationError` read `name`, `code`, `summary`,
  and `details` off a caller-supplied error, and a getter is caller code: one
  that throws became the defect inside `Effect.mapError` the prose said could
  not happen. Every such read is guarded, and a value the refinements cannot
  vouch for takes the unclassified `delivery-failed` branch.

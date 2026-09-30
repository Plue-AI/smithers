/**
 * Short-lived OAuth access tokens minted from a stored refresh token.
 *
 * A provider that speaks OAuth 2.0 (Google Calendar, Gmail, X) hands out a
 * long-lived refresh token once, at consent, and expects the client to trade
 * it for an access token that expires within the hour. This module is that
 * trade, behind the {@link AccessTokenSource} every client already asks for a
 * bearer token:
 *
 * - **Caching.** A minted token is reused until its `expires_in` minus a skew,
 *   so a burst of calls costs one exchange. Concurrent callers share one
 *   refresh rather than racing the token endpoint.
 * - **Invalidation.** A client that receives a 401 calls `invalidate`; the next
 *   `token` mints a fresh one even if the clock says the old one is still
 *   good.
 * - **Rotation.** A provider may answer a refresh with a new refresh token and
 *   retire the old one. The new one is persisted with a compare-and-set against
 *   the value this source exchanged: through the control-plane `Credential`
 *   boundary with {@link credentialStore}, whose `rotate` compares the stored
 *   secret and writes over the version it compared in one step, so a writer in
 *   any process that commits first wins and this source keeps its token.
 * - **Recovery.** Independent sources sharing one credential can both present
 *   the same refresh token, and a rotating provider refuses the second with
 *   `invalid_grant`. The loser reloads the stored token and, only when it
 *   changed since the refused exchange, retries with it, a bounded number of
 *   times. An unchanged token after `invalid_grant` is a genuine refusal.
 * - **Classification.** No stored refresh token or no credential storage is
 *   `credentials-missing`; `invalid_grant` (revoked, expired, or reused grant)
 *   and a refused credential are `permission-denied`; a rejected client id or
 *   secret is `invalid-config`; a 429, a 5xx and a lost connection are
 *   `delivery-failed`, retried a bounded number of times first.
 *
 * Tokens never leave this module except as `Redacted` values and the
 * `Authorization` header or form body of the one request that needs them.
 * Every error is built by removing the refresh token, the client secret and
 * any minted access token from its text first, and a redirect from the token
 * endpoint is refused rather than followed, so a moved endpoint cannot receive
 * the form body.
 *
 * @since 1.0.0
 */

import type { Credential, CredentialRef } from "@smthrs/control/Credential"
import { Clock, Duration, Effect, Option, Redacted, Ref, Schedule, Schema, Semaphore } from "effect"
import type { AccessTokenSource } from "./AccessToken.ts"
import { IntegrationError, isRetryable } from "./IntegrationError.ts"
import { redactedError } from "./RedactedError.ts"

/**
 * How long before its stated expiry a cached token counts as stale.
 *
 * A token that expires while its request is in flight fails with a 401, so a
 * token is replaced a minute early rather than used to its last second.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_SKEW: Duration.Duration = Duration.seconds(60)

/**
 * The default deadline for one token-endpoint attempt, headers and body.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_REQUEST_TIMEOUT: Duration.Duration = Duration.seconds(30)

const DEFAULT_MAX_RETRIES = 2
/** How many times one refresh follows a stored token another source rotated. */
const MAX_ROTATION_RECOVERIES = 3
/**
 * When a refused refresh re-reads the stored token, in milliseconds after the
 * refusal. The source that won the exchange may still be persisting its
 * rotation when the loser's refusal arrives.
 */
const ROTATION_SETTLE_MS: ReadonlyArray<number> = [0, 100, 250, 500]
const MAX_RETRY_AFTER_MS = 60_000

/**
 * Where a refresh token is kept, with compare-and-set replacement.
 *
 * @category models
 * @since 1.0.0
 */
export interface RefreshTokenStore {
  /** The current refresh token. */
  readonly load: Effect.Effect<Redacted.Redacted<string>, IntegrationError>
  /**
   * Replaces `previous` with `next` only when the stored token is still
   * `previous`. Answers `false`, without writing, when another writer got
   * there first.
   */
  readonly replace: (
    previous: Redacted.Redacted<string>,
    next: Redacted.Redacted<string>
  ) => Effect.Effect<boolean, IntegrationError>
}

/**
 * A process-local store seeded with one refresh token.
 *
 * For a token supplied through configuration or the environment. A rotation
 * is kept for the life of the process only: nothing can persist it, so a
 * provider that rotates refresh tokens needs {@link credentialStore}.
 *
 * @category constructors
 * @since 1.0.0
 */
export const memoryStore = (initial: Redacted.Redacted<string>): RefreshTokenStore => {
  let current = initial
  return {
    load: Effect.sync(() => current),
    replace: (previous, next) =>
      Effect.sync(() => {
        if (Redacted.value(current) !== Redacted.value(previous)) return false
        current = next
        return true
      })
  }
}

const credentialFailure = (reference: CredentialRef) => (error: { readonly _tag: string }): IntegrationError =>
  error._tag === "/control/Unauthorized"
    ? new IntegrationError(
      "permission-denied",
      `Credential ${reference.name} is not available to this caller.`,
      { credential: reference.name, retryable: false }
    )
    : new IntegrationError(
      "credentials-missing",
      `Credential ${reference.name} could not be read from credential storage.`,
      { credential: reference.name, retryable: false }
    )

/**
 * A store backed by the control-plane credential boundary.
 *
 * The credential's secret is the refresh token itself. `load` resolves it, so
 * the host's `authorize` policy decides whether the calling principal may use
 * it; `replace` is `rotate` with `expected: previous`, which compares the
 * stored secret and writes over the version it compared, answering any other
 * writer's earlier commit with `CredentialConflict`, reported here as `false`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const credentialStore = (credential: Credential, reference: CredentialRef): RefreshTokenStore => {
  const load = credential.resolve(reference).pipe(Effect.mapError(credentialFailure(reference)))
  return {
    load,
    replace: (previous, next) =>
      credential.rotate(reference, next, { expected: previous }).pipe(
        Effect.as(true),
        Effect.catchTag("/control/CredentialConflict", () => Effect.succeed(false)),
        Effect.mapError(credentialFailure(reference))
      )
  }
}

/**
 * How the client authenticates to the token endpoint.
 *
 * `body` sends `client_id` and `client_secret` as form fields, which is what
 * Google documents. `basic` sends them as an RFC 6749 §2.3.1 `Authorization:
 * Basic` header, which X requires of a confidential client. A client with no
 * secret is a public client and sends only `client_id`, whichever is chosen.
 *
 * @category models
 * @since 1.0.0
 */
export type ClientAuthentication = "body" | "basic"

/**
 * The token endpoint and client identity shared by every exchange.
 *
 * @category models
 * @since 1.0.0
 */
export interface Endpoint {
  /** An absolute `http:` or `https:` token endpoint URL. */
  readonly tokenUrl: string
  readonly clientId: string
  readonly clientSecret?: Redacted.Redacted<string> | undefined
  /** Defaults to `body`. */
  readonly clientAuthentication?: ClientAuthentication | undefined
  /** A name for messages, such as `Google`. Defaults to `OAuth`. */
  readonly provider?: string | undefined
  /** Deadline for one attempt, headers and body. Defaults to 30 seconds. */
  readonly requestTimeout?: Duration.Input | undefined
  /** Retries for a 429, a 5xx or a lost connection. Defaults to 2, at most 10. */
  readonly maxRetries?: number | undefined
}

/**
 * What {@link make} needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options extends Endpoint {
  readonly refreshToken: RefreshTokenStore
  /** Narrows the refreshed token to these scopes. Omitted keeps the granted set. */
  readonly scopes?: ReadonlyArray<string> | undefined
  /** How early a cached token is replaced. Defaults to {@link DEFAULT_SKEW}. */
  readonly skew?: Duration.Input | undefined
}

/**
 * One successful token-endpoint answer.
 *
 * @category models
 * @since 1.0.0
 */
export interface Grant {
  readonly accessToken: Redacted.Redacted<string>
  /** Seconds until the access token expires, or `null` when the provider did not say. */
  readonly expiresInSeconds: number | null
  /** A refresh token the provider issued with this answer, or `null`. */
  readonly refreshToken: Redacted.Redacted<string> | null
  /** The granted scopes, space separated, when the provider reported them. */
  readonly scope: string | null
}

const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  token_type: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  refresh_token: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String)
})

const ErrorResponse = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String)
})

const decodeTokenResponse = Schema.decodeUnknownOption(TokenResponse)
const decodeErrorResponse = Schema.decodeUnknownOption(ErrorResponse)

/**
 * The classification an OAuth `error` code maps to.
 *
 * `invalid_grant` is a revoked, expired or already-rotated refresh token, or a
 * used authorization code: the grant itself is gone and only a new consent
 * restores it. `invalid_client` is a client id or secret the endpoint does not
 * accept, which is configuration. Anything else a 400 or 401 carries is
 * reported as a refused delivery.
 *
 * @category getters
 * @since 1.0.0
 */
export const reasonForOAuthError = (code: string): IntegrationError["reason"] => {
  switch (code) {
    case "invalid_grant":
    case "unauthorized_client":
    case "invalid_scope":
    case "access_denied":
      return "permission-denied"
    case "invalid_client":
    case "invalid_request":
    case "unsupported_grant_type":
      return "invalid-config"
    default:
      return "delivery-failed"
  }
}

const retryAfterMs = (headers: Headers): number | null => {
  const value = headers.get("retry-after")
  if (value === null) return null
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : null
}

interface Resolved {
  readonly url: URL
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted<string> | undefined
  readonly authentication: ClientAuthentication
  readonly provider: string
  readonly timeout: Duration.Duration
  readonly maxRetries: number
}

const invalidConfig = (message: string, details: Record<string, unknown>): IntegrationError =>
  new IntegrationError("invalid-config", message, { ...details, retryable: false })

const resolveEndpoint = (endpoint: Endpoint): Resolved => {
  const provider = endpoint.provider ?? "OAuth"
  if (typeof endpoint.tokenUrl !== "string" || !URL.canParse(endpoint.tokenUrl)) {
    throw invalidConfig(`${provider} tokenUrl must be an absolute HTTP or HTTPS URL.`, { provider })
  }
  const url = new URL(endpoint.tokenUrl)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidConfig(`${provider} tokenUrl must be an absolute HTTP or HTTPS URL.`, { provider })
  }
  if (typeof endpoint.clientId !== "string" || endpoint.clientId.trim().length === 0) {
    throw new IntegrationError("credentials-missing", `${provider} OAuth client id is not configured.`, {
      provider,
      retryable: false
    })
  }
  const maxRetries = endpoint.maxRetries ?? DEFAULT_MAX_RETRIES
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    throw invalidConfig(`${provider} maxRetries must be an integer between 0 and 10.`, { provider, maxRetries })
  }
  const timeout = Option.getOrUndefined(Duration.fromInput(endpoint.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT))
  if (timeout === undefined || !Duration.isFinite(timeout) || Duration.toMillis(timeout) <= 0) {
    throw invalidConfig(`${provider} requestTimeout must be a finite, positive duration.`, {
      provider,
      requestTimeout: String(endpoint.requestTimeout)
    })
  }
  return {
    url,
    clientId: endpoint.clientId.trim(),
    clientSecret: endpoint.clientSecret,
    authentication: endpoint.clientAuthentication ?? "body",
    provider,
    timeout,
    maxRetries
  }
}

interface Answer {
  readonly status: number
  readonly headers: Headers
  readonly json: unknown
}

/**
 * One POST to the token endpoint, retried for a rate limit and, when the
 * grant can be presented again, for a 5xx or a lost connection.
 *
 * `secrets` are the values the form carries; every error removes them first.
 */
const requestGrant = (
  endpoint: Resolved,
  form: Readonly<Record<string, string>>,
  secrets: ReadonlyArray<Redacted.Redacted<string>>,
  repeatable: boolean
): Effect.Effect<Grant, IntegrationError> => {
  const plain = secrets.map(Redacted.value)
  const secret = endpoint.clientSecret === undefined ? undefined : Redacted.value(endpoint.clientSecret)
  const basic = secret === undefined || endpoint.authentication !== "basic"
    ? undefined
    : Buffer.from(`${encodeURIComponent(endpoint.clientId)}:${encodeURIComponent(secret)}`).toString("base64")
  const failure = redactedError([...plain, secret, basic])
  const provider = endpoint.provider
  const path = endpoint.url.pathname

  const body = new URLSearchParams(form)
  if (basic === undefined) {
    body.set("client_id", endpoint.clientId)
    if (secret !== undefined) body.set("client_secret", secret)
  }
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded"
  }
  if (basic !== undefined) headers["authorization"] = `Basic ${basic}`
  const encoded = body.toString()
  const timeoutMs = Duration.toMillis(endpoint.timeout)
  const ambiguity = repeatable ? "" : " (outcome unknown: the grant was not presented again)"

  const attempt: Effect.Effect<Answer, IntegrationError> = Effect.tryPromise({
    try: async (signal) => {
      // A redirect is answered, not followed: following a 307 would re-send
      // the form, secret included, to wherever the endpoint pointed.
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers,
        body: encoded,
        redirect: "manual",
        signal
      })
      const text = await response.text()
      let json: unknown = null
      try {
        json = text.length === 0 ? null : JSON.parse(text)
      } catch {
        json = null
      }
      return { status: response.status, headers: response.headers, json }
    },
    // The transport's own message stays on the (redacted) cause.
    catch: (cause) =>
      failure(
        "delivery-failed",
        `${provider} token request failed before an answer arrived${ambiguity}`,
        { provider, path, retryable: repeatable, outcomeUnknown: !repeatable },
        { cause }
      )
  }).pipe(
    Effect.timeoutOrElse({
      duration: endpoint.timeout,
      orElse: () =>
        Effect.fail(failure(
          "delivery-failed",
          `${provider} token request timed out after ${timeoutMs} ms${ambiguity}`,
          { provider, path, retryable: repeatable, outcomeUnknown: !repeatable, timedOut: true }
        ))
    })
  )

  const classify = (answer: Answer): Effect.Effect<Grant, IntegrationError> => {
    if (answer.status >= 200 && answer.status < 300) {
      const decoded = decodeTokenResponse(answer.json)
      const expires = Option.isSome(decoded) ? Number(decoded.value.expires_in ?? Number.NaN) : Number.NaN
      if (
        Option.isNone(decoded) ||
        (decoded.value.token_type !== undefined && decoded.value.token_type.toLowerCase() !== "bearer") ||
        (decoded.value.expires_in !== undefined && !(Number.isFinite(expires) && expires >= 0))
      ) {
        return Effect.fail(failure(
          "decode-failed",
          `${provider} token response is not a bearer token grant.`,
          { provider, path, status: answer.status, retryable: false }
        ))
      }
      const value = decoded.value
      return Effect.succeed({
        accessToken: Redacted.make(value.access_token),
        expiresInSeconds: value.expires_in === undefined ? null : expires,
        refreshToken: value.refresh_token === undefined || value.refresh_token.length === 0
          ? null
          : Redacted.make(value.refresh_token),
        scope: value.scope ?? null
      })
    }
    const oauth = decodeErrorResponse(answer.json)
    const code = Option.isSome(oauth) ? oauth.value.error : null
    const described = Option.isSome(oauth) && oauth.value.error_description !== undefined
      ? `: ${oauth.value.error_description}`
      : ""
    const rateLimited = answer.status === 429
    const serverError = answer.status >= 500
    const retryable = rateLimited || (serverError && repeatable)
    const reason = code !== null && !rateLimited && !serverError ? reasonForOAuthError(code) : "delivery-failed"
    return Effect.fail(failure(
      reason,
      `${provider} token request refused: ${answer.status}${code === null ? "" : ` ${code}`}${described}${
        serverError && !repeatable ? ambiguity : ""
      }`,
      {
        provider,
        path,
        status: answer.status,
        oauthError: code,
        retryable,
        rateLimited,
        outcomeUnknown: serverError && !repeatable,
        retryAfterMs: retryable ? retryAfterMs(answer.headers) : null
      }
    ))
  }

  const schedule = Schedule.exponential("250 millis").pipe(
    Schedule.upTo({ times: endpoint.maxRetries }),
    Schedule.while(({ input }) => isRetryable(input)),
    Schedule.passthrough,
    Schedule.addDelay(({ input }) => {
      const wait = (input as IntegrationError).details?.["retryAfterMs"]
      return Effect.succeed(typeof wait === "number" && wait > 0 ? Duration.millis(wait) : Duration.zero)
    })
  )

  return attempt.pipe(
    Effect.flatMap(classify),
    Effect.retry(schedule),
    Effect.withSpan("OAuthToken.request", { attributes: { "oauth.provider": provider } })
  )
}

/**
 * What {@link exchangeCode} needs beyond the endpoint.
 *
 * @category models
 * @since 1.0.0
 */
export interface CodeExchange extends Endpoint {
  /** The authorization code the redirect delivered. */
  readonly code: Redacted.Redacted<string>
  /** The same redirect URI the authorization request named. */
  readonly redirectUri: string
  /** The PKCE verifier, when the authorization request carried a challenge. */
  readonly codeVerifier?: Redacted.Redacted<string> | undefined
}

/**
 * Redeems an authorization code for the first access and refresh tokens.
 *
 * This finishes the consent flow `AuthorizationUrl` and `Pkce` start; the host
 * stores the returned refresh token with `Credential.create`. A code is
 * single-use, so a 5xx or a lost connection is not retried: the provider may
 * have redeemed it and lost the answer, and the failure says the outcome is
 * unknown. A rate limit is retried, because a refused request redeemed
 * nothing.
 *
 * @category constructors
 * @since 1.0.0
 */
export const exchangeCode = (exchange: CodeExchange): Effect.Effect<Grant, IntegrationError> =>
  Effect.try({ try: () => resolveEndpoint(exchange), catch: (cause) => cause as IntegrationError }).pipe(
    Effect.flatMap((endpoint) => {
      const form: Record<string, string> = {
        grant_type: "authorization_code",
        code: Redacted.value(exchange.code),
        redirect_uri: exchange.redirectUri
      }
      const secrets = [exchange.code]
      if (exchange.codeVerifier !== undefined) {
        form["code_verifier"] = Redacted.value(exchange.codeVerifier)
        secrets.push(exchange.codeVerifier)
      }
      return requestGrant(endpoint, form, secrets, false)
    })
  )

interface Cached {
  readonly token: Redacted.Redacted<string>
  /** When the token stops being served from the cache, in Unix milliseconds. */
  readonly staleAtMs: number
}

/**
 * An access-token source that refreshes from `options.refreshToken`.
 *
 * Validates the endpoint and bounds up front, throwing a typed
 * `IntegrationError`: `invalid-config` for a malformed URL or bound, and
 * `credentials-missing` for a missing client id.
 *
 * A grant without `expires_in` is used for the call that minted it and not
 * cached, since nothing says how long it lives.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: Options): AccessTokenSource => {
  const endpoint = resolveEndpoint(options)
  const skew = Option.getOrUndefined(Duration.fromInput(options.skew ?? DEFAULT_SKEW))
  if (skew === undefined || !Duration.isFinite(skew) || Duration.toMillis(skew) < 0) {
    throw invalidConfig(`${endpoint.provider} skew must be a finite, non-negative duration.`, {
      provider: endpoint.provider,
      skew: String(options.skew)
    })
  }
  const skewMs = Duration.toMillis(skew)
  const scope = options.scopes === undefined || options.scopes.length === 0 ? undefined : options.scopes.join(" ")
  const cache = Ref.makeUnsafe<Option.Option<Cached>>(Option.none())
  const lock = Semaphore.makeUnsafe(1)

  const cached = Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    return Option.filter(yield* Ref.get(cache), (entry) => now < entry.staleAtMs)
  })

  const exchange = (current: Redacted.Redacted<string>) => {
    const form: Record<string, string> = { grant_type: "refresh_token", refresh_token: Redacted.value(current) }
    if (scope !== undefined) form["scope"] = scope
    return requestGrant(endpoint, form, [current], true).pipe(Effect.map((grant) => ({ current, grant })))
  }

  /** The stored token once it differs from `current`, re-read a bounded number of times. */
  const rotatedFrom = (current: Redacted.Redacted<string>): Effect.Effect<
    Option.Option<Redacted.Redacted<string>>,
    IntegrationError
  > =>
    Effect.gen(function*() {
      let waited = 0
      for (const at of ROTATION_SETTLE_MS) {
        yield* Effect.sleep(Duration.millis(at - waited))
        waited = at
        const stored = yield* options.refreshToken.load
        if (Redacted.value(stored) !== Redacted.value(current)) return Option.some(stored)
      }
      return Option.none()
    })

  // `invalid_grant` for a token another source has since rotated is not a
  // revocation: follow the stored token, but only while it keeps changing.
  const exchangeFollowingRotation = (
    current: Redacted.Redacted<string>,
    recoveries: number
  ): Effect.Effect<{ readonly current: Redacted.Redacted<string>; readonly grant: Grant }, IntegrationError> =>
    exchange(current).pipe(
      Effect.catchIf(
        (error) => recoveries > 0 && error.details?.["oauthError"] === "invalid_grant",
        (error) =>
          Effect.flatMap(rotatedFrom(current), (stored) =>
            Option.isNone(stored)
              ? Effect.fail(error)
              : exchangeFollowingRotation(stored.value, recoveries - 1))
      )
    )

  const refresh = Effect.gen(function*() {
    const { current, grant } = yield* exchangeFollowingRotation(
      yield* options.refreshToken.load,
      MAX_ROTATION_RECOVERIES
    )
    const now = yield* Clock.currentTimeMillis
    if (grant.refreshToken !== null && Redacted.value(grant.refreshToken) !== Redacted.value(current)) {
      const replaced = yield* options.refreshToken.replace(current, grant.refreshToken)
      if (!replaced) {
        yield* Effect.logWarning(
          `${endpoint.provider} rotated the refresh token, but another refresher replaced the stored one first; keeping the stored token.`
        )
      }
    }
    yield* Ref.set(
      cache,
      grant.expiresInSeconds === null
        ? Option.none()
        : Option.some({ token: grant.accessToken, staleAtMs: now + grant.expiresInSeconds * 1000 - skewMs })
    )
    return grant.accessToken
  })

  const token = Effect.gen(function*() {
    const hit = yield* cached
    if (Option.isSome(hit)) return hit.value.token
    return yield* lock.withPermits(1)(Effect.gen(function*() {
      // Another caller may have refreshed while this one waited for the lock.
      const again = yield* cached
      return Option.isSome(again) ? again.value.token : yield* refresh
    }))
  }).pipe(Effect.withSpan("OAuthToken.token", { attributes: { "oauth.provider": endpoint.provider } }))

  return { token, invalidate: Ref.set(cache, Option.none()) }
}

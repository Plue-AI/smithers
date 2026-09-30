/**
 * The refresh-token access-token source, against a real `node:http` token
 * endpoint and, for rotation, the real control-plane credential boundary over
 * an in-memory SQLite database with AES-GCM sealing.
 *
 * Nothing is mocked. The expiry cases move Effect's clock with `TestClock`,
 * which is the clock the source reads; the requests themselves are real.
 */
import { Unauthorized } from "@smthrs/control/ControlError"
import * as Credential from "@smthrs/control/Credential"
import * as CredentialStore from "@smthrs/control/CredentialStore"
import * as SqlCredentialStore from "@smthrs/control/SqlCredentialStore"
import * as WebCryptoCipher from "@smthrs/control/WebCryptoCipher"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Cause, Effect, Exit, Fiber, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, describe, expect, it } from "vitest"
import { IntegrationError, isIntegrationError } from "../src/core/IntegrationError.ts"
import * as OAuthToken from "../src/core/OAuthToken.ts"
import { type Fixture, json, type Recorded, startFixture } from "./Fixture.ts"

const REFRESH = "refresh-token-fixture-1"
const SECRET = "client-secret-fixture"

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const form = (request: Recorded): URLSearchParams => new URLSearchParams(request.body)

const tokenRequests = (): ReadonlyArray<Recorded> => (fixture as Fixture).requests

/** The typed failure an effect ends with. */
const failure = async <A>(effect: Effect.Effect<A, IntegrationError>): Promise<IntegrationError> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) throw new Error("expected a typed failure")
  const error = Cause.squash(exit.cause)
  if (!isIntegrationError(error)) throw error
  return error
}

const endpoint = (extra: Partial<OAuthToken.Options> = {}): OAuthToken.Options => ({
  provider: "Fixture",
  tokenUrl: `${(fixture as Fixture).origin}/token`,
  clientId: "client-id",
  clientSecret: Redacted.make(SECRET),
  refreshToken: OAuthToken.memoryStore(Redacted.make(REFRESH)),
  ...extra
})

/** A token endpoint that mints `access-<n>` for every refresh. */
const mintingEndpoint = async (answer: Record<string, unknown> = { expires_in: 3600 }) => {
  let minted = 0
  fixture = await startFixture((_request, response) => {
    minted += 1
    json(response, 200, { access_token: `access-${minted}`, token_type: "Bearer", ...answer })
  })
}

const value = (token: Redacted.Redacted<string>): string => Redacted.value(token)

describe("OAuthToken refresh", () => {
  it("exchanges the refresh token with the client credentials in the form body", async () => {
    await mintingEndpoint()
    const source = OAuthToken.make(endpoint({ scopes: ["scope.a", "scope.b"] }))
    const token = await Effect.runPromise(source.token)
    expect(value(token)).toBe("access-1")
    const request = tokenRequests()[0] as Recorded
    expect(request.method).toBe("POST")
    expect(request.url).toBe("/token")
    expect(request.headers["content-type"]).toBe("application/x-www-form-urlencoded")
    expect(request.headers["authorization"]).toBeUndefined()
    expect(Object.fromEntries(form(request))).toEqual({
      grant_type: "refresh_token",
      refresh_token: REFRESH,
      scope: "scope.a scope.b",
      client_id: "client-id",
      client_secret: SECRET
    })
  })

  it("serves the cached token until its expiry minus the skew, then refreshes", async () => {
    await mintingEndpoint({ expires_in: 3600 })
    const source = OAuthToken.make(endpoint({ skew: "60 seconds" }))
    const seen = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* source.token
        yield* TestClock.adjust("58 minutes")
        const cached = yield* source.token
        yield* TestClock.adjust("1 minute")
        const refreshed = yield* source.token
        const again = yield* source.token
        return [first, cached, refreshed, again].map(value)
      }).pipe(Effect.provide(TestClock.layer()))
    )
    expect(seen).toEqual(["access-1", "access-1", "access-2", "access-2"])
    expect(tokenRequests()).toHaveLength(2)
  })

  it("mints a fresh token after invalidate even when the old one has not expired", async () => {
    await mintingEndpoint()
    const source = OAuthToken.make(endpoint())
    const seen = await Effect.runPromise(Effect.gen(function*() {
      const first = yield* source.token
      yield* source.invalidate
      return [first, yield* source.token].map(value)
    }))
    expect(seen).toEqual(["access-1", "access-2"])
  })

  it("does not cache a grant that does not say when it expires", async () => {
    await mintingEndpoint({})
    const source = OAuthToken.make(endpoint())
    const seen = await Effect.runPromise(Effect.all([source.token, source.token]))
    expect(seen.map(value)).toEqual(["access-1", "access-2"])
  })

  it("accepts expires_in as a numeric string", async () => {
    await mintingEndpoint({ expires_in: "3600" })
    const source = OAuthToken.make(endpoint())
    const seen = await Effect.runPromise(Effect.all([source.token, source.token]))
    expect(seen.map(value)).toEqual(["access-1", "access-1"])
  })

  it("shares one refresh between concurrent callers", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let minted = 0
    fixture = await startFixture(async (_request, response) => {
      await gate
      minted += 1
      json(response, 200, { access_token: `access-${minted}`, expires_in: 3600 })
    })
    const source = OAuthToken.make(endpoint())
    const fiber = Effect.runFork(
      Effect.all(Array.from({ length: 5 }, () => source.token), { concurrency: "unbounded" })
    )
    await (fixture as Fixture).arrived
    release?.()
    const tokens = await Effect.runPromise(Fiber.join(fiber))
    expect(tokens.map(value)).toEqual(Array(5).fill("access-1"))
    expect(tokenRequests()).toHaveLength(1)
  })

  it("authenticates with HTTP Basic when asked, and keeps the secret out of the body", async () => {
    await mintingEndpoint()
    const source = OAuthToken.make(endpoint({ clientAuthentication: "basic", clientId: "id:with space" }))
    await Effect.runPromise(source.token)
    const request = tokenRequests()[0] as Recorded
    const basic = Buffer.from(`${encodeURIComponent("id:with space")}:${encodeURIComponent(SECRET)}`).toString("base64")
    expect(request.headers["authorization"]).toBe(`Basic ${basic}`)
    expect(form(request).has("client_secret")).toBe(false)
    expect(form(request).has("client_id")).toBe(false)
  })

  it("sends only the client id for a public client", async () => {
    await mintingEndpoint()
    const source = OAuthToken.make(endpoint({ clientSecret: undefined, clientAuthentication: "basic" }))
    await Effect.runPromise(source.token)
    const request = tokenRequests()[0] as Recorded
    expect(request.headers["authorization"]).toBeUndefined()
    expect(form(request).get("client_id")).toBe("client-id")
    expect(form(request).has("client_secret")).toBe(false)
  })
})

describe("OAuthToken failures", () => {
  it("reports invalid_grant as permission-denied without retrying, and never echoes a secret", async () => {
    fixture = await startFixture((request, response) => {
      json(response, 400, {
        error: "invalid_grant",
        error_description: `Token ${form(request).get("refresh_token")} has been expired or revoked (${SECRET}).`
      })
    })
    const error = await failure(OAuthToken.make(endpoint()).token)
    expect(error.reason).toBe("permission-denied")
    expect(error.details?.["oauthError"]).toBe("invalid_grant")
    expect(error.details?.["retryable"]).toBe(false)
    expect(tokenRequests()).toHaveLength(1)
    const text = JSON.stringify({ summary: error.summary, message: error.message, details: error.details })
    expect(text).not.toContain(REFRESH)
    expect(text).not.toContain(SECRET)
    expect(text).toContain("[REDACTED]")
  })

  it("maps the OAuth error codes onto the package's reasons", () => {
    expect(OAuthToken.reasonForOAuthError("invalid_grant")).toBe("permission-denied")
    expect(OAuthToken.reasonForOAuthError("unauthorized_client")).toBe("permission-denied")
    expect(OAuthToken.reasonForOAuthError("invalid_scope")).toBe("permission-denied")
    expect(OAuthToken.reasonForOAuthError("access_denied")).toBe("permission-denied")
    expect(OAuthToken.reasonForOAuthError("invalid_client")).toBe("invalid-config")
    expect(OAuthToken.reasonForOAuthError("invalid_request")).toBe("invalid-config")
    expect(OAuthToken.reasonForOAuthError("unsupported_grant_type")).toBe("invalid-config")
    expect(OAuthToken.reasonForOAuthError("temporarily_unavailable")).toBe("delivery-failed")
  })

  it("reports a rejected client as invalid-config", async () => {
    fixture = await startFixture((_request, response) => json(response, 401, { error: "invalid_client" }))
    const error = await failure(OAuthToken.make(endpoint()).token)
    expect(error.reason).toBe("invalid-config")
    expect(error.details?.["status"]).toBe(401)
  })

  it("reports a refusal without an OAuth body as delivery-failed", async () => {
    fixture = await startFixture((_request, response) => {
      response.writeHead(403, { "content-type": "text/plain" })
      response.end("forbidden")
    })
    const error = await failure(OAuthToken.make(endpoint()).token)
    expect(error.reason).toBe("delivery-failed")
    expect(error.details?.["oauthError"]).toBeNull()
    expect(error.details?.["retryable"]).toBe(false)
  })

  it("retries a 5xx and a 429 with Retry-After, then succeeds", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) return json(response, 503, { error: "temporarily_unavailable" })
      if (calls === 2) return json(response, 429, { error: "slow_down" }, { "retry-after": "0" })
      json(response, 200, { access_token: "access-after-retry", expires_in: 3600 })
    })
    const token = await Effect.runPromise(OAuthToken.make(endpoint()).token)
    expect(value(token)).toBe("access-after-retry")
    expect(calls).toBe(3)
  })

  it("waits a positive Retry-After and ignores one that is not a number", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) return json(response, 429, { error: "slow_down" }, { "retry-after": "soon" })
      if (calls === 2) return json(response, 429, { error: "slow_down" }, { "retry-after": "1" })
      json(response, 200, { access_token: "access-after-wait", expires_in: 3600 })
    })
    const token = await Effect.runPromise(OAuthToken.make(endpoint()).token)
    expect(value(token)).toBe("access-after-wait")
    const requests = tokenRequests()
    expect((requests[2] as Recorded).receivedAt - (requests[1] as Recorded).receivedAt).toBeGreaterThanOrEqual(900)
  })

  it("gives up after the retry budget with a retryable delivery-failed", async () => {
    fixture = await startFixture((_request, response) => json(response, 500, {}))
    const error = await failure(OAuthToken.make(endpoint({ maxRetries: 1 })).token)
    expect(error.reason).toBe("delivery-failed")
    expect(error.details?.["retryable"]).toBe(true)
    expect(error.details?.["outcomeUnknown"]).toBe(false)
    expect(tokenRequests()).toHaveLength(2)
  })

  it("refuses to follow a redirect, so the form never reaches another endpoint", async () => {
    fixture = await startFixture((_request, response) => {
      response.writeHead(307, { location: "https://elsewhere.example.test/token" })
      response.end()
    })
    const error = await failure(OAuthToken.make(endpoint()).token)
    expect(error.reason).toBe("delivery-failed")
    expect(error.details?.["status"]).toBe(307)
    expect(tokenRequests()).toHaveLength(1)
  })

  it("rejects an answer that is not a bearer grant as decode-failed", async () => {
    for (
      const body of [
        { access_token: "a", token_type: "mac" },
        { access_token: "" },
        { access_token: "a", expires_in: "soon" },
        { access_token: "a", expires_in: -1 },
        "not json at all"
      ]
    ) {
      fixture = await startFixture((_request, response) => {
        if (typeof body === "string") {
          response.writeHead(200, { "content-type": "text/plain" })
          response.end(body)
          return
        }
        json(response, 200, body)
      })
      const error = await failure(OAuthToken.make(endpoint()).token)
      expect(error.reason, JSON.stringify(body)).toBe("decode-failed")
      await fixture.close()
      fixture = undefined
    }
  })

  it("times out a stalled endpoint and reports the retryable failure", async () => {
    fixture = await startFixture(() => {
      // Never answers.
    })
    const error = await failure(OAuthToken.make(endpoint({ requestTimeout: "100 millis", maxRetries: 0 })).token)
    expect(error.reason).toBe("delivery-failed")
    expect(error.details?.["timedOut"]).toBe(true)
    expect(error.details?.["retryable"]).toBe(true)
  })

  it("reports a refused connection as a retryable delivery failure", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, {}))
    const origin = fixture.origin
    await fixture.close()
    fixture = undefined
    const error = await failure(
      OAuthToken.make({ ...endpoint0(origin), maxRetries: 0 }).token
    )
    expect(error.reason).toBe("delivery-failed")
    expect(error.details?.["retryable"]).toBe(true)
  })

  it("validates its configuration up front", () => {
    const thrown = (options: OAuthToken.Options): IntegrationError => {
      try {
        OAuthToken.make(options)
      } catch (error) {
        if (isIntegrationError(error)) return error
        throw error
      }
      throw new Error("expected a configuration error")
    }
    const base = endpoint0("https://token.example.test")
    expect(thrown({ ...base, tokenUrl: "not a url" }).reason).toBe("invalid-config")
    expect(thrown({ ...base, tokenUrl: "ftp://token.example.test/" }).reason).toBe("invalid-config")
    expect(thrown({ ...base, clientId: "  " }).reason).toBe("credentials-missing")
    expect(thrown({ ...base, maxRetries: 11 }).reason).toBe("invalid-config")
    expect(thrown({ ...base, maxRetries: 1.5 }).reason).toBe("invalid-config")
    expect(thrown({ ...base, requestTimeout: "0 millis" }).reason).toBe("invalid-config")
    expect(thrown({ ...base, requestTimeout: "Infinity" }).reason).toBe("invalid-config")
    expect(thrown({ ...base, skew: "Infinity" }).reason).toBe("invalid-config")
    expect(thrown({ ...base, provider: undefined, tokenUrl: "nope" }).summary).toContain("OAuth tokenUrl")
  })
})

/** The endpoint options for an origin that is not the current fixture. */
const endpoint0 = (origin: string): OAuthToken.Options => ({
  provider: "Fixture",
  tokenUrl: `${origin}/token`,
  clientId: "client-id",
  clientSecret: Redacted.make(SECRET),
  refreshToken: OAuthToken.memoryStore(Redacted.make(REFRESH))
})

describe("OAuthToken memory store", () => {
  it("replaces only the value it was asked to replace", async () => {
    const store = OAuthToken.memoryStore(Redacted.make("one"))
    const results = await Effect.runPromise(Effect.gen(function*() {
      const stale = yield* store.replace(Redacted.make("zero"), Redacted.make("two"))
      const fresh = yield* store.replace(Redacted.make("one"), Redacted.make("two"))
      return [stale, fresh, value(yield* store.load)] as const
    }))
    expect(results).toEqual([false, true, "two"])
  })

  it("keeps a rotated refresh token for the next exchange", async () => {
    let calls = 0
    fixture = await startFixture((request, response) => {
      calls += 1
      json(response, 200, {
        access_token: `access-${calls}`,
        expires_in: 3600,
        refresh_token: `${form(request).get("refresh_token")}-rotated`
      })
    })
    const source = OAuthToken.make(endpoint())
    await Effect.runPromise(Effect.gen(function*() {
      yield* source.token
      yield* source.invalidate
      yield* source.token
    }))
    expect(tokenRequests().map((request) => form(request).get("refresh_token"))).toEqual([
      REFRESH,
      `${REFRESH}-rotated`
    ])
  })
})

const HOST_KEY = Redacted.make(btoa("0123456789abcdef0123456789abcdef"))
const REFERENCE = { id: "calendar-refresh", name: "Calendar refresh token" }

/** Runs `use` against a real credential boundary over in-memory SQLite. */
const withCredentials = <A, E>(
  use: (credentials: Credential.Credential, store: CredentialStore.Service) => Effect.Effect<A, E>,
  options: {
    readonly authorize?: Credential.Options["authorize"]
    readonly wrap?: (store: CredentialStore.Service) => CredentialStore.Service
  } = {}
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const durable = yield* SqlCredentialStore.make
      const store = options.wrap === undefined ? durable : options.wrap(durable)
      const cipher = yield* WebCryptoCipher.make({ key: HOST_KEY })
      const credentials = Credential.make({ store, cipher, authorize: options.authorize })
      return yield* use(credentials, store)
    }).pipe(Effect.provide(TestDatabase.layer), Effect.scoped, Effect.orDie)
  )

/**
 * A provider that retires each refresh token the moment it is exchanged, and
 * refuses a retired one with `invalid_grant`. The first `holdFirst` requests
 * are held until all of them arrived, so their callers present the same token.
 */
const strictRotatingProvider = (options: { readonly holdFirst: number }) => {
  let current: string | null = REFRESH
  let minted = 0
  const held: Array<() => void> = []
  return {
    revoke: () => {
      current = null
    },
    handle: async (request: Recorded, response: Parameters<Parameters<typeof startFixture>[0]>[1]) => {
      if (held.length < options.holdFirst) {
        await new Promise<void>((release) => {
          held.push(release)
          if (held.length === options.holdFirst) held.forEach((resume) => resume())
        })
      }
      const presented = form(request).get("refresh_token")
      if (presented !== current) {
        return json(response, 400, { error: "invalid_grant", error_description: `Token ${presented} was already used.` })
      }
      minted += 1
      current = `rt-${minted}`
      json(response, 200, { access_token: `at-${minted}`, expires_in: 3600, refresh_token: current })
    }
  }
}

/** Persists every write late, so a refused loser can see the old token first. */
const slowWrites = (durable: CredentialStore.Service): CredentialStore.Service =>
  CredentialStore.make({
    ...durable,
    write: (record) => Effect.andThen(Effect.sleep("150 millis"), durable.write(record))
  })

describe("OAuthToken credential store", () => {
  it("persists a rotated refresh token through the credential boundary", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      json(response, 200, {
        access_token: `access-${calls}`,
        expires_in: 3600,
        refresh_token: `rotated-${calls}`,
        scope: "calendar"
      })
    })
    const stored = await withCredentials((credentials) =>
      Effect.gen(function*() {
        yield* credentials.create({ ...REFERENCE, secret: Redacted.make(REFRESH) })
        const source = OAuthToken.make(endpoint({ refreshToken: OAuthToken.credentialStore(credentials, REFERENCE) }))
        yield* source.token
        const afterFirst = value(yield* credentials.resolve(REFERENCE))
        yield* source.invalidate
        yield* source.token
        return [afterFirst, value(yield* credentials.resolve(REFERENCE))]
      })
    )
    expect(stored).toEqual(["rotated-1", "rotated-2"])
    expect(tokenRequests().map((request) => form(request).get("refresh_token"))).toEqual([REFRESH, "rotated-1"])
  })

  it("keeps the winner when another refresher rotated the stored token first", async () => {
    const stored = await withCredentials((credentials) =>
      Effect.gen(function*() {
        yield* credentials.create({ ...REFERENCE, secret: Redacted.make(REFRESH) })
        // The endpoint answers only after a competing refresher has written
        // its own rotation, which is the interleaving the compare exists for.
        fixture = yield* Effect.promise(() =>
          startFixture(async (_request, response) => {
            await Effect.runPromise(credentials.rotate(REFERENCE, Redacted.make("rotated-elsewhere")))
            json(response, 200, { access_token: "access-mine", expires_in: 3600, refresh_token: "rotated-mine" })
          })
        )
        const source = OAuthToken.make(endpoint({ refreshToken: OAuthToken.credentialStore(credentials, REFERENCE) }))
        const token = yield* source.token
        return [value(token), value(yield* credentials.resolve(REFERENCE))]
      })
    )
    expect(stored).toEqual(["access-mine", "rotated-elsewhere"])
  })

  it("reports a write that lost the version compare-and-set as not replaced", async () => {
    let interleave: (() => Promise<void>) | undefined
    const replaced = await withCredentials(
      (credentials) =>
        Effect.gen(function*() {
          yield* credentials.create({ ...REFERENCE, secret: Redacted.make(REFRESH) })
          const store = OAuthToken.credentialStore(credentials, REFERENCE)
          // A competing rotation lands between `rotate`'s compare and its write.
          interleave = () =>
            Effect.runPromise(credentials.rotate(REFERENCE, Redacted.make("rotated-elsewhere"))).then(() => undefined)
          const outcome = yield* store.replace(Redacted.make(REFRESH), Redacted.make("rotated-mine"))
          return [outcome, value(yield* credentials.resolve(REFERENCE))]
        }),
      {
        wrap: (durable) => {
          let armed = 0
          return CredentialStore.make({
            ...durable,
            read: (id) =>
              durable.read(id).pipe(Effect.tap(() =>
                Effect.promise(async () => {
                  armed += 1
                  // The first read is `rotate`'s own: the secret it compares
                  // and the version it writes over both come from it.
                  if (armed === 1 && interleave !== undefined) {
                    const run = interleave
                    interleave = undefined
                    await run()
                  }
                })
              ))
          })
        }
      }
    )
    expect(replaced).toEqual([false, "rotated-elsewhere"])
  })

  it("converges independent sources that both present the same refresh token to a rotating provider", async () => {
    const provider = strictRotatingProvider({ holdFirst: 2 })
    fixture = await startFixture(provider.handle)
    const outcome = await withCredentials(
      (credentials, store) =>
        Effect.gen(function*() {
          yield* credentials.create({ ...REFERENCE, secret: Redacted.make(REFRESH) })
          // A second process: its own credential boundary over the same rows.
          const cipher = yield* WebCryptoCipher.make({ key: HOST_KEY }).pipe(Effect.orDie)
          const elsewhere = Credential.make({ store, cipher })
          const first = OAuthToken.make(endpoint({ refreshToken: OAuthToken.credentialStore(credentials, REFERENCE) }))
          const second = OAuthToken.make(endpoint({ refreshToken: OAuthToken.credentialStore(elsewhere, REFERENCE) }))
          const tokens = yield* Effect.all([first.token, second.token], { concurrency: "unbounded" })
          const stored = value(yield* credentials.resolve(REFERENCE))
          const later = OAuthToken.make(endpoint({ refreshToken: OAuthToken.credentialStore(credentials, REFERENCE) }))
          return { tokens: tokens.map(value).sort(), stored, later: value(yield* later.token) }
        }),
      { wrap: slowWrites }
    )
    expect(outcome.tokens).toEqual(["at-1", "at-2"])
    expect(outcome.stored).toBe("rt-2")
    expect(outcome.later).toBe("at-3")
    expect(tokenRequests().map((request) => form(request).get("refresh_token"))).toEqual([
      REFRESH,
      REFRESH,
      "rt-1",
      "rt-2"
    ])
  })

  it("keeps an invalid grant a refusal when the stored refresh token never changed", async () => {
    const provider = strictRotatingProvider({ holdFirst: 0 })
    provider.revoke()
    fixture = await startFixture(provider.handle)
    const outcome = await withCredentials((credentials) =>
      Effect.gen(function*() {
        yield* credentials.create({ ...REFERENCE, secret: Redacted.make(REFRESH) })
        const source = OAuthToken.make(endpoint({ refreshToken: OAuthToken.credentialStore(credentials, REFERENCE) }))
        const error = yield* Effect.flip(source.token)
        return { error, stored: value(yield* credentials.resolve(REFERENCE)) }
      })
    )
    expect(outcome.error.reason).toBe("permission-denied")
    expect(outcome.error.details?.["oauthError"]).toBe("invalid_grant")
    expect(outcome.stored).toBe(REFRESH)
    expect(tokenRequests()).toHaveLength(1)
    expect(JSON.stringify({ message: outcome.error.message, details: outcome.error.details })).not.toContain(REFRESH)
  })

  it("stops following a stored token that keeps rotating under refused grants", async () => {
    let rotations = 0
    const outcome = await withCredentials((credentials) =>
      Effect.gen(function*() {
        yield* credentials.create({ ...REFERENCE, secret: Redacted.make(REFRESH) })
        // Every exchange is refused, and each time another writer has already
        // rotated the stored token again.
        fixture = yield* Effect.promise(() =>
          startFixture(async (request, response) => {
            rotations += 1
            await Effect.runPromise(credentials.rotate(REFERENCE, Redacted.make(`elsewhere-${rotations}`)))
            json(response, 400, {
              error: "invalid_grant",
              error_description: `Token ${form(request).get("refresh_token")} was already used.`
            })
          })
        )
        const source = OAuthToken.make(endpoint({ refreshToken: OAuthToken.credentialStore(credentials, REFERENCE) }))
        return yield* Effect.flip(source.token)
      })
    )
    expect(outcome.reason).toBe("permission-denied")
    expect(tokenRequests().map((request) => form(request).get("refresh_token"))).toEqual([
      REFRESH,
      "elsewhere-1",
      "elsewhere-2",
      "elsewhere-3"
    ])
    const text = JSON.stringify({ message: outcome.message, details: outcome.details })
    for (const token of [REFRESH, "elsewhere-3", "elsewhere-4"]) expect(text).not.toContain(token)
  })

  it("refuses a caller the credential policy denies as permission-denied", async () => {
    await mintingEndpoint()
    const error = await withCredentials(
      (credentials) =>
        Effect.gen(function*() {
          const source = OAuthToken.make(endpoint({ refreshToken: OAuthToken.credentialStore(credentials, REFERENCE) }))
          return yield* Effect.flip(source.token)
        }),
      {
        authorize: (operation) =>
          operation === "resolve"
            ? Effect.fail(new Unauthorized({ message: "denied" }))
            : Effect.void
      }
    )
    expect(error.reason).toBe("permission-denied")
    expect(tokenRequests()).toHaveLength(0)
  })

  it("reports missing credential storage as credentials-missing", async () => {
    await mintingEndpoint()
    const source = OAuthToken.make(
      endpoint({ refreshToken: OAuthToken.credentialStore(Credential.makeNoop(), REFERENCE) })
    )
    const error = await failure(source.token)
    expect(error.reason).toBe("credentials-missing")
    expect(error.summary).toContain(REFERENCE.name)
  })

  it("surfaces a store failure while persisting a rotation", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { access_token: "access", expires_in: 3600, refresh_token: "rotated" })
    )
    const store: OAuthToken.RefreshTokenStore = {
      load: Effect.succeed(Redacted.make(REFRESH)),
      replace: () => Effect.fail(new IntegrationError("credentials-missing", "no storage", { retryable: false }))
    }
    const error = await failure(OAuthToken.make(endpoint({ refreshToken: store })).token)
    expect(error.reason).toBe("credentials-missing")
    expect(error.summary).toBe("no storage")
  })
})

describe("OAuthToken code exchange", () => {
  it("redeems a code with its verifier and returns both tokens", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, {
        access_token: "access-first",
        expires_in: 3599,
        refresh_token: "refresh-first",
        scope: "https://www.googleapis.com/auth/calendar.events",
        token_type: "Bearer"
      })
    )
    const grant = await Effect.runPromise(OAuthToken.exchangeCode({
      tokenUrl: `${fixture.origin}/token`,
      clientId: "client-id",
      clientSecret: Redacted.make(SECRET),
      code: Redacted.make("code-fixture"),
      redirectUri: "http://127.0.0.1/callback",
      codeVerifier: Redacted.make("verifier-fixture")
    }))
    expect(value(grant.accessToken)).toBe("access-first")
    expect(grant.refreshToken === null ? null : value(grant.refreshToken)).toBe("refresh-first")
    expect(grant.expiresInSeconds).toBe(3599)
    expect(grant.scope).toBe("https://www.googleapis.com/auth/calendar.events")
    expect(Object.fromEntries(form(tokenRequests()[0] as Recorded))).toEqual({
      grant_type: "authorization_code",
      code: "code-fixture",
      redirect_uri: "http://127.0.0.1/callback",
      code_verifier: "verifier-fixture",
      client_id: "client-id",
      client_secret: SECRET
    })
  })

  it("does not present a code again after a lost answer", async () => {
    fixture = await startFixture((_request, response) => json(response, 502, { error: "server_error" }))
    const error = await failure(OAuthToken.exchangeCode({
      tokenUrl: `${fixture.origin}/token`,
      clientId: "client-id",
      code: Redacted.make("code-fixture"),
      redirectUri: "http://127.0.0.1/callback"
    }))
    expect(error.reason).toBe("delivery-failed")
    expect(error.details?.["outcomeUnknown"]).toBe(true)
    expect(error.details?.["retryable"]).toBe(false)
    expect(tokenRequests()).toHaveLength(1)
    expect(JSON.stringify(error.details)).not.toContain("code-fixture")
  })

  it("reports a stalled or unreachable endpoint as an unknown outcome", async () => {
    fixture = await startFixture(() => {
      // Never answers.
    })
    const stalled = await failure(OAuthToken.exchangeCode({
      tokenUrl: `${fixture.origin}/token`,
      clientId: "client-id",
      code: Redacted.make("code-fixture"),
      redirectUri: "http://127.0.0.1/callback",
      requestTimeout: "100 millis"
    }))
    expect(stalled.details?.["outcomeUnknown"]).toBe(true)
    expect(stalled.details?.["timedOut"]).toBe(true)
    const origin = fixture.origin
    await fixture.close()
    fixture = undefined
    const refused = await failure(OAuthToken.exchangeCode({
      tokenUrl: `${origin}/token`,
      clientId: "client-id",
      code: Redacted.make("code-fixture"),
      redirectUri: "http://127.0.0.1/callback"
    }))
    expect(refused.details?.["outcomeUnknown"]).toBe(true)
  })

  it("fails an invalid endpoint as a typed error rather than a defect", async () => {
    const error = await failure(OAuthToken.exchangeCode({
      tokenUrl: "not a url",
      clientId: "client-id",
      code: Redacted.make("code-fixture"),
      redirectUri: "http://127.0.0.1/callback"
    }))
    expect(error.reason).toBe("invalid-config")
  })
})

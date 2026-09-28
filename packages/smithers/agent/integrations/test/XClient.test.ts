/**
 * The X client, its config and its capability table, against a real
 * `node:http` server over a socket.
 *
 * Nothing is mocked: every case below is a request the client really sent and
 * a response the server really wrote, including dropped sockets and a server
 * that never answers. No live X account is involved.
 */
import { Duration, Effect, Layer, Redacted } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AccessTokenSource } from "../src/core/AccessToken.ts"
import type { Connection } from "../src/core/Connection.ts"
import { IntegrationError, isIntegrationError } from "../src/core/IntegrationError.ts"
import * as Capabilities from "../src/x/Capabilities.ts"
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_RETRY_AFTER,
  DEFAULT_REQUEST_TIMEOUT,
  PROVIDER,
  resolve
} from "../src/x/Config.ts"
import {
  DM_EVENT_FIELDS,
  layer,
  make,
  retryAfterMs,
  TWEET_FIELDS,
  USER_FIELDS,
  XClient,
  xError
} from "../src/x/XClient.ts"
import { type Fixture, json, type Recorded, startFixture } from "./Fixture.ts"

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const TOKEN = "x-fixture-access-token"
const ALL_SCOPES = ["tweet.read", "tweet.write", "users.read", "dm.read", "dm.write"]

const connection = (scopes: ReadonlyArray<string> = ALL_SCOPES, extra: Partial<Connection> = {}): Connection => ({
  id: "owner-x",
  provider: "x",
  label: "Owner X account",
  credential: { id: "cred-x", name: "owner-x" },
  scopes,
  personal: true,
  containers: ["*"],
  ...extra
})

/** A token source that hands out `tokens` in order, advancing on `invalidate`. */
const rotating = (tokens: ReadonlyArray<string>) => {
  let index = 0
  let invalidations = 0
  const source: AccessTokenSource = {
    token: Effect.sync(() => Redacted.make(tokens[Math.min(index, tokens.length - 1)]!)),
    invalidate: Effect.sync(() => {
      index += 1
      invalidations += 1
    })
  }
  return { source, invalidations: () => invalidations }
}

const client = (options: Partial<Parameters<typeof make>[0]> = {}) =>
  make({
    token: rotating([TOKEN]).source,
    connection: connection(),
    apiBaseUrl: (fixture as Fixture).origin,
    ...options
  }, {})

const serve = async (handler: Parameters<typeof startFixture>[0]) => {
  fixture = await startFixture(handler)
  return fixture
}

/** Closes the running server so a case can start another. */
const restart = async () => {
  await fixture?.close()
  fixture = undefined
}

const failure = <A>(effect: Effect.Effect<A, IntegrationError>): Promise<IntegrationError> =>
  Effect.runPromise(Effect.flip(effect))

const thrown = (run: () => unknown): IntegrationError => {
  try {
    run()
  } catch (error) {
    if (isIntegrationError(error)) return error
    throw error
  }
  throw new Error("expected make to throw")
}

const url = (recorded: Recorded) => new URL(`http://fixture${recorded.url}`)

const requests = () => (fixture as Fixture).requests

describe("X config", () => {
  const token = rotating([TOKEN]).source

  it("prefers explicit values, then the connection, then the environment", () => {
    const env = { SMITHERS_X_API_BASE_URL: " http://env.example.test " }
    expect(resolve({ token, apiBaseUrl: "http://explicit.example.test" }, env).apiBaseUrl)
      .toBe("http://explicit.example.test")
    expect(resolve({ token, connection: connection([], { apiBaseUrl: "http://conn.example.test" }) }, env).apiBaseUrl)
      .toBe("http://conn.example.test")
    expect(resolve({ token }, env).apiBaseUrl).toBe("http://env.example.test")
    expect(resolve({ token, apiBaseUrl: "  " }, {}).apiBaseUrl).toBe(DEFAULT_API_BASE_URL)
    const defaults = resolve({ token }, {})
    expect(defaults).toMatchObject({
      token,
      connection: undefined,
      maxRetries: DEFAULT_MAX_RETRIES,
      requestTimeout: DEFAULT_REQUEST_TIMEOUT,
      maxRetryAfter: DEFAULT_MAX_RETRY_AFTER
    })
    expect(resolve({ token, maxRetries: 0, requestTimeout: "1 second", maxRetryAfter: 0 }, {})).toMatchObject({
      maxRetries: 0,
      requestTimeout: "1 second",
      maxRetryAfter: 0
    })
    expect(PROVIDER).toBe("x")
  })

  it("never reads a token from the environment", () => {
    expect(resolve({ token }, { SMITHERS_X_TOKEN: "ambient", X_TOKEN: "ambient" }).token).toBe(token)
  })

  it("refuses a connection to another provider, a bad origin, or an out-of-range bound", () => {
    const cases: ReadonlyArray<Parameters<typeof make>[0]> = [
      { token, connection: connection([], { provider: "slack" }) },
      { token, apiBaseUrl: "not a url" },
      { token, apiBaseUrl: "ftp://example.test" },
      { token, maxRetries: -1 },
      { token, maxRetries: 11 },
      { token, maxRetries: 1.5 },
      { token, requestTimeout: 0 },
      { token, requestTimeout: Duration.infinity },
      { token, maxRetryAfter: -1 },
      { token, maxRetryAfter: Duration.infinity }
    ]
    for (const config of cases) {
      const error = thrown(() => make(config, {}))
      expect(error.reason).toBe("invalid-config")
      expect(error.details?.["retryable"]).toBe(false)
    }
    expect(thrown(() => make({ token, requestTimeout: 0 }, {})).message).toMatch(/positive/)
    expect(thrown(() => make({ token, maxRetryAfter: -1 }, {})).message).toMatch(/non-negative/)
    // A zero rate-limit cap is allowed: no rate-limit wait is sat out in process.
    expect(make({ token, maxRetryAfter: 0 }, {}).connectionId).toBeUndefined()
  })

  it("binds the connection id", () => {
    expect(make({ token, connection: connection() }, {}).connectionId).toBe("owner-x")
  })
})

describe("X capabilities", () => {
  it("states each operation's scopes and the operations a grant allows", () => {
    expect(Capabilities.operations).toEqual(["read", "dm-read", "post", "dm-write"])
    expect(Capabilities.personalAccount).toBe(true)
    expect(Capabilities.missing(["tweet.read"], "read")).toEqual(["users.read"])
    expect(Capabilities.allows(["tweet.read", "users.read"], "read")).toBe(true)
    expect(Capabilities.allows(["tweet.read", "users.read"], "post")).toBe(false)
    expect(Capabilities.available(["tweet.read", "users.read", "dm.read"])).toEqual(["read", "dm-read"])
    expect(Capabilities.available(ALL_SCOPES)).toEqual(Capabilities.operations)
    expect(Capabilities.available([])).toEqual([])
  })

  it("refuses an operation the grant lacks, naming what is missing", () => {
    expect(Capabilities.refusal(ALL_SCOPES, "dm-write")).toBeUndefined()
    const refused = Capabilities.refusal(["tweet.read", "users.read"], "dm-write") as IntegrationError
    expect(refused.reason).toBe("permission-denied")
    expect(refused.message).toMatch(/"dm-write".*dm\.read, dm\.write/)
    expect(refused.details).toMatchObject({ operation: "dm-write", missingScopes: ["dm.read", "dm.write"] })
  })
})

describe("xError and retryAfterMs", () => {
  it("reads a problem detail, a title, or the first error", () => {
    expect(xError({ detail: "Too Many Requests", title: "ignored" })).toBe("Too Many Requests")
    expect(xError({ title: "Unauthorized" })).toBe("Unauthorized")
    expect(xError({ errors: [{ message: "first" }, { message: "second" }] })).toBe("first")
    expect(xError({ errors: [{ detail: "only detail" }] })).toBe("only detail")
    expect(xError({ errors: ["not a record"] })).toBe("")
    expect(xError({ errors: "not a list" })).toBe("")
    expect(xError({ detail: 7 })).toBe("")
    expect(xError("plain text")).toBe("")
    expect(xError(null)).toBe("")
    expect(xError([1])).toBe("")
    expect(xError({ detail: "x".repeat(400) })).toHaveLength(300)
  })

  it("turns x-rate-limit-reset into a wait from now, or null", () => {
    expect(retryAfterMs(new Headers(), 0)).toBeNull()
    expect(retryAfterMs(new Headers({ "x-rate-limit-reset": " " }), 0)).toBeNull()
    expect(retryAfterMs(new Headers({ "x-rate-limit-reset": "soon" }), 0)).toBeNull()
    expect(retryAfterMs(new Headers({ "x-rate-limit-reset": "100" }), 40_000)).toBe(60_000)
    expect(retryAfterMs(new Headers({ "x-rate-limit-reset": "10" }), 40_000)).toBe(0)
  })
})

describe("X reads", () => {
  it("reads the account with the bearer token and user fields", async () => {
    await serve((_request, response) => json(response, 200, { data: { id: "42", username: "owner" } }))
    const me = await Effect.runPromise(client({ apiBaseUrl: `${(fixture as Fixture).origin}/2/` }).me)
    expect(me).toEqual({ id: "42", username: "owner" })
    const [request] = requests()
    expect(request!.method).toBe("GET")
    expect(url(request!).pathname).toBe("/2/users/me")
    expect(url(request!).searchParams.get("user.fields")).toBe(USER_FIELDS)
    expect(request!.headers["authorization"]).toBe(`Bearer ${TOKEN}`)
    expect(request!.headers["accept"]).toBe("application/json")
    expect(request!.headers["user-agent"]).toBe("smithers-integrations")
    expect(request!.headers["content-type"]).toBeUndefined()
  })

  it("pages mentions and a user's posts with every timeline parameter", async () => {
    const page = {
      data: [{ id: "101", text: "hi @owner", author_id: "7" }],
      includes: { users: [{ id: "7", username: "ada" }] },
      meta: { result_count: 1, newest_id: "101", oldest_id: "101", next_token: "n1" }
    }
    await serve((_request, response) => json(response, 200, page))
    const x = client()
    expect(
      await Effect.runPromise(x.mentions("42", {
        sinceId: "99",
        paginationToken: "p0",
        startTime: "2026-09-01T00:00:00Z",
        maxResults: 5
      }))
    ).toEqual(page)
    await Effect.runPromise(x.userTweets("42"))
    const [mentions, tweets] = requests().map(url)
    expect(mentions!.pathname).toBe("/users/42/mentions")
    expect(Object.fromEntries(mentions!.searchParams)).toEqual({
      since_id: "99",
      pagination_token: "p0",
      start_time: "2026-09-01T00:00:00Z",
      max_results: "5",
      "tweet.fields": TWEET_FIELDS,
      expansions: "author_id",
      "user.fields": USER_FIELDS
    })
    expect(tweets!.pathname).toBe("/users/42/tweets")
    // Unset options are omitted, not sent empty.
    expect([...tweets!.searchParams.keys()]).toEqual(["tweet.fields", "expansions", "user.fields"])
  })

  it("reads direct-message events across conversations and in one conversation", async () => {
    await serve((_request, response) => json(response, 200, { data: [], meta: { result_count: 0 } }))
    const x = client()
    await Effect.runPromise(x.dmEvents())
    await Effect.runPromise(x.dmEvents({ paginationToken: "p1", maxResults: 1 }))
    await Effect.runPromise(x.conversationEvents("7", { maxResults: 100 }))
    const [all, paged, conversation] = requests().map(url)
    expect(all!.pathname).toBe("/dm_events")
    expect(Object.fromEntries(all!.searchParams)).toEqual({
      event_types: "MessageCreate",
      "dm_event.fields": DM_EVENT_FIELDS,
      expansions: "sender_id",
      "user.fields": USER_FIELDS
    })
    expect(paged!.searchParams.get("pagination_token")).toBe("p1")
    expect(paged!.searchParams.get("max_results")).toBe("1")
    expect(conversation!.pathname).toBe("/dm_conversations/with/7/dm_events")
    expect(conversation!.searchParams.get("max_results")).toBe("100")
  })

  it("refuses an id that is not decimal or a page size out of range before sending", async () => {
    await serve((_request, response) => json(response, 200, {}))
    const x = client()
    const refusals = await Promise.all([
      failure(x.mentions("../admin")),
      failure(x.userTweets("42", { maxResults: 4 })),
      failure(x.userTweets("42", { maxResults: 101 })),
      failure(x.userTweets("42", { maxResults: 5.5 })),
      failure(x.dmEvents({ maxResults: 0 })),
      failure(x.conversationEvents("abc")),
      failure(x.conversationEvents("7", { maxResults: 200 })),
      failure(x.createTweet({ text: "hi", replyToTweetId: "not-an-id" })),
      failure(x.sendDirectMessage("-1", "hi"))
    ])
    for (const error of refusals) expect(error.reason).toBe("invalid-config")
    expect(refusals[0]!.details).toMatchObject({ kind: "user" })
    expect(refusals[1]!.message).toMatch(/between 5 and 100/)
    expect(refusals[4]!.message).toMatch(/between 1 and 100/)
    expect(requests()).toHaveLength(0)
  })

  it("refuses an operation the connection's grant does not cover, before sending", async () => {
    await serve((_request, response) => json(response, 200, {}))
    const x = client({ connection: connection(["tweet.read", "users.read"]) })
    const denied = await failure(x.dmEvents())
    expect(denied.reason).toBe("permission-denied")
    expect(denied.details).toMatchObject({ operation: "dm-read", missingScopes: ["dm.read"] })
    expect((await failure(x.createTweet({ text: "hi" }))).details).toMatchObject({ operation: "post" })
    expect(requests()).toHaveLength(0)
  })

  it("sends every operation when no connection is bound", async () => {
    await serve((_request, response) => json(response, 200, { data: [] }))
    await Effect.runPromise(client({ connection: undefined }).dmEvents())
    expect(requests()).toHaveLength(1)
  })
})

describe("X writes", () => {
  it("creates a post, and a reply", async () => {
    await serve((request, response) =>
      json(response, 201, { data: { id: "500", text: JSON.parse(request.body).text } })
    )
    const x = client()
    expect(await Effect.runPromise(x.createTweet({ text: "shipped" }))).toEqual({
      data: { id: "500", text: "shipped" }
    })
    await Effect.runPromise(x.createTweet({ text: "thanks", replyToTweetId: "101" }))
    const [post, reply] = requests()
    expect(post!.method).toBe("POST")
    expect(url(post!).pathname).toBe("/tweets")
    expect(post!.headers["content-type"]).toBe("application/json")
    expect(JSON.parse(post!.body)).toEqual({ text: "shipped" })
    expect(JSON.parse(reply!.body)).toEqual({ text: "thanks", reply: { in_reply_to_tweet_id: "101" } })
  })

  it("sends a direct message", async () => {
    await serve((_request, response) =>
      json(response, 201, { data: { dm_conversation_id: "7-42", dm_event_id: "900" } })
    )
    expect(await Effect.runPromise(client().sendDirectMessage("7", "hello"))).toEqual({
      data: { dm_conversation_id: "7-42", dm_event_id: "900" }
    })
    const [request] = requests()
    expect(url(request!).pathname).toBe("/dm_conversations/with/7/messages")
    expect(JSON.parse(request!.body)).toEqual({ text: "hello" })
  })

  it("reports a 5xx on a post as outcomeUnknown and never repeats it", async () => {
    await serve((_request, response) => json(response, 503, { title: "Service Unavailable" }))
    const error = await failure(client().createTweet({ text: "maybe" }))
    expect(error.reason).toBe("delivery-failed")
    expect(error.message).toMatch(/503 Service Unavailable \(outcome unknown/)
    expect(error.details).toMatchObject({ status: 503, retryable: false, outcomeUnknown: true, operation: "post" })
    expect(requests()).toHaveLength(1)
  })

  it("reports a dropped connection on a direct message as outcomeUnknown", async () => {
    await serve((_request, response) => {
      response.socket?.destroy()
    })
    const error = await failure(client().sendDirectMessage("7", "maybe"))
    expect(error.reason).toBe("delivery-failed")
    expect(error.message).toMatch(/outcome unknown/)
    expect(error.details).toMatchObject({ retryable: false, outcomeUnknown: true })
    expect(requests()).toHaveLength(1)
  })

  it("reports a write whose deadline passed as outcomeUnknown", async () => {
    await serve(() => {})
    const error = await failure(client({ requestTimeout: "50 millis" }).createTweet({ text: "slow" }))
    expect(error.message).toMatch(/timed out after 50 ms.*outcome unknown/)
    expect(error.details).toMatchObject({ timedOut: true, retryable: false, outcomeUnknown: true })
    expect(requests()).toHaveLength(1)
  })

  it("reports an accepted write with an unreadable answer as outcomeUnknown", async () => {
    await serve((_request, response) => json(response, 201, { data: { id: "not-an-id" } }))
    const error = await failure(client().createTweet({ text: "odd" }))
    expect(error.reason).toBe("decode-failed")
    expect(error.message).toMatch(/identity is unknown/)
    expect(error.details).toMatchObject({ retryable: false, outcomeUnknown: true })
  })
})

describe("X failures", () => {
  it("retries a 5xx on a read with backoff, then succeeds", async () => {
    let calls = 0
    await serve((_request, response) => {
      calls += 1
      if (calls === 1) json(response, 500, { errors: [{ message: "boom" }] })
      else json(response, 200, { data: { id: "42" } })
    })
    expect(await Effect.runPromise(client().me)).toEqual({ id: "42" })
    expect(requests()).toHaveLength(2)
  })

  it("gives up on a read after maxRetries, retryable and not ambiguous", async () => {
    await serve((_request, response) => {
      response.writeHead(502, { "content-type": "text/plain" })
      response.end("bad gateway")
    })
    const error = await failure(client({ maxRetries: 1 }).me)
    expect(error.message).toMatch(/-> 502 Bad Gateway( |$)/)
    expect(error.details).toMatchObject({ status: 502, retryable: true, outcomeUnknown: false, rateLimited: false })
    expect(requests()).toHaveLength(2)
  })

  it("retries a dropped connection and a timeout on a read", async () => {
    let calls = 0
    await serve((_request, response) => {
      calls += 1
      if (calls === 1) response.socket?.destroy()
      else json(response, 200, { data: { id: "42" } })
    })
    expect(await Effect.runPromise(client().me)).toEqual({ id: "42" })

    await restart()
    await serve(() => {})
    // The server never answers, so every attempt times out; the bound only has
    // to be long enough for each attempt to reach the server on a loaded runner.
    const timedOut = await failure(client({ requestTimeout: "250 millis", maxRetries: 1 }).me)
    expect(timedOut.message).toMatch(/timed out after 250 ms: GET \/users\/me( |$)/)
    expect(timedOut.details).toMatchObject({ timedOut: true, retryable: true, outcomeUnknown: false })
    await vi.waitFor(() => expect(requests()).toHaveLength(2))

    await restart()
    await serve((_request, response) => {
      response.socket?.destroy()
    })
    const dropped = await failure(client({ maxRetries: 0 }).me)
    expect(dropped.message).not.toMatch(/outcome unknown/)
    expect(dropped.details).toMatchObject({ retryable: true, outcomeUnknown: false })
  })

  it("retries a rate limit that resets soon, even on a write", async () => {
    let calls = 0
    await serve((_request, response) => {
      calls += 1
      if (calls === 1) {
        json(response, 429, { title: "Too Many Requests" }, {
          "x-rate-limit-reset": "0",
          "x-rate-limit-remaining": "0"
        })
      } else json(response, 201, { data: { id: "500", text: "later" } })
    })
    expect(await Effect.runPromise(client().createTweet({ text: "later" }))).toEqual({
      data: { id: "500", text: "later" }
    })
    expect(requests()).toHaveLength(2)
  })

  it("fails at once with the wait when the rate limit resets beyond maxRetryAfter", async () => {
    const reset = String(Math.ceil(Date.now() / 1000) + 900)
    await serve((_request, response) => json(response, 429, {}, { "x-rate-limit-reset": reset }))
    const error = await failure(client().me)
    expect(error.details).toMatchObject({ status: 429, rateLimited: true, retryable: true })
    expect(error.details?.["retryAfterMs"]).toBeGreaterThan(60_000)
    expect(error.message).toMatch(/-> 429 Too Many Requests/)
    expect(requests()).toHaveLength(1)
  })

  it("refreshes the token once after a 401, for a write too", async () => {
    const tokens = rotating(["stale", "fresh"])
    await serve((request, response) => {
      if (request.headers["authorization"] === "Bearer stale") json(response, 401, { title: "Unauthorized" })
      else json(response, 201, { data: { id: "500", text: "ok" } })
    })
    await Effect.runPromise(client({ token: tokens.source }).createTweet({ text: "ok" }))
    expect(tokens.invalidations()).toBe(1)
    expect(requests().map((request) => request.headers["authorization"])).toEqual(["Bearer stale", "Bearer fresh"])
  })

  it("fails permission-denied after a second 401, and on a 403, redacting an echoed token", async () => {
    const tokens = rotating(["first", "second"])
    await serve((request, response) => json(response, 401, { detail: `rejected ${request.headers["authorization"]}` }))
    const error = await failure(client({ token: tokens.source }).me)
    expect(error.reason).toBe("permission-denied")
    expect(error.details).toMatchObject({ status: 401, unauthorized: true, retryable: false })
    expect(error.message).not.toContain("second")
    expect(requests()).toHaveLength(2)
    expect(tokens.invalidations()).toBe(1)

    await restart()
    await serve((_request, response) => json(response, 403, { title: "Forbidden" }))
    const forbidden = await failure(client().me)
    expect(forbidden.reason).toBe("permission-denied")
    expect(forbidden.details).toMatchObject({ status: 403, unauthorized: false })
    expect(requests()).toHaveLength(1)
  })

  it("reports another 4xx as a known, non-retryable failure", async () => {
    await serve((_request, response) => json(response, 400, { errors: [{ message: "Invalid Request" }] }))
    const error = await failure(client().userTweets("42"))
    expect(error.reason).toBe("delivery-failed")
    expect(error.message).toMatch(/^X read failed: GET \/users\/42\/tweets -> 400 Invalid Request( |$)/)
    expect(error.details).toMatchObject({ retryable: false, outcomeUnknown: false, retryAfterMs: null })
  })

  it("fails decode-failed on a read whose body is not the schema, empty, or not JSON", async () => {
    const bodies = ["{\"data\":{\"id\":\"x\"}}", "", "not json"]
    let index = 0
    await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(bodies[index++])
    })
    for (let attempt = 0; attempt < bodies.length; attempt++) {
      const error = await failure(client().me)
      expect(error.reason).toBe("decode-failed")
      expect(error.message).not.toMatch(/identity is unknown/)
      expect(error.details).toMatchObject({ retryable: false, outcomeUnknown: false })
    }
  })
})

describe("X layer", () => {
  it("provides the client, and fails typed on a bad config", async () => {
    await serve((_request, response) => json(response, 200, { data: { id: "42" } }))
    const me = await Effect.runPromise(
      Effect.flatMap(XClient, (x) => x.me).pipe(
        Effect.provide(layer({ token: rotating([TOKEN]).source, apiBaseUrl: (fixture as Fixture).origin }, {}))
      )
    )
    expect(me).toEqual({ id: "42" })
    const error = await Effect.runPromise(
      Effect.flip(
        Layer.build(layer({ token: rotating([TOKEN]).source, apiBaseUrl: "ftp://x" }, {})).pipe(Effect.scoped)
      )
    )
    expect(error).toBeInstanceOf(IntegrationError)
    expect(error.reason).toBe("invalid-config")
    // Without an explicit env, the ambient environment decides only the origin.
    const ambient = await Effect.runPromise(
      Effect.map(XClient, (x) => x.connectionId).pipe(
        Effect.provide(layer({ token: rotating([TOKEN]).source, connection: connection() }))
      )
    )
    expect(ambient).toBe("owner-x")
    expect(make({ token: rotating([TOKEN]).source }).connectionId).toBeUndefined()
  })
})

describe("X redirects", () => {
  it("fails on a redirect and never sends the token to its target", async () => {
    const server = await serve((request, response) => {
      if (request.url === "/captured") return json(response, 200, { data: [] })
      response.writeHead(302, { location: "/captured" })
      response.end()
    })
    const error = await failure(client().dmEvents())
    expect(error.reason).toBe("delivery-failed")
    expect(error.details).toMatchObject({ status: 302, retryable: false })
    expect(server.requests).toHaveLength(1)
  })
})

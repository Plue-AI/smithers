/**
 * The Gmail client against a real `node:http` server over a socket.
 *
 * Nothing is mocked: every case below is a request the client really sent and
 * a response the server really wrote, including dropped sockets and a server
 * that never answers. No live Gmail account is involved.
 */
import { Duration, Effect, Layer, Redacted } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { AccessTokenSource } from "../src/core/AccessToken.ts"
import type { Connection } from "../src/core/Connection.ts"
import { IntegrationError, isIntegrationError } from "../src/core/IntegrationError.ts"
import * as Gmail from "../src/gmail.ts"
import * as Capabilities from "../src/gmail/Capabilities.ts"
import { DEFAULT_API_BASE_URL, resolve } from "../src/gmail/Config.ts"
import { GmailClient, googleError, layer, make, retryAfterMs } from "../src/gmail/GmailClient.ts"
import { type Fixture, json, startFixture } from "./Fixture.ts"

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const TOKEN = "ya29.fixture-access-token"

const connection = (
  scopes: ReadonlyArray<string> = [Capabilities.SCOPE_FULL],
  extra: Partial<Connection> = {}
): Connection => ({
  id: "assistant-mail",
  provider: "gmail",
  label: "Assistant mailbox",
  credential: { id: "cred-mail", name: "assistant-mail" },
  scopes,
  personal: true,
  containers: ["me"],
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

const url = (recorded: { readonly url: string }) => new URL(`http://fixture${recorded.url}`)

describe("Gmail config", () => {
  const token = rotating([TOKEN]).source

  it("prefers explicit values, then the connection, then the environment", () => {
    const env = { SMITHERS_GMAIL_API_BASE_URL: "http://env.example.test" }
    expect(resolve({ token, apiBaseUrl: "http://explicit.example.test" }, env).apiBaseUrl)
      .toBe("http://explicit.example.test")
    expect(resolve({ token, connection: connection([], { apiBaseUrl: "http://conn.example.test" }) }, env).apiBaseUrl)
      .toBe("http://conn.example.test")
    expect(resolve({ token }, env).apiBaseUrl).toBe("http://env.example.test")
    expect(resolve({ token, apiBaseUrl: "  " }, {}).apiBaseUrl).toBe(DEFAULT_API_BASE_URL)
    const defaults = resolve({ token }, {})
    expect(defaults.userId).toBe("me")
    expect(defaults.maxRetries).toBe(3)
    expect(defaults.connection).toBeUndefined()
    expect(resolve({ token, userId: " ada@example.test " }, {}).userId).toBe("ada@example.test")
  })

  it("never reads a token from the environment", () => {
    const resolved = resolve({ token }, { SMITHERS_GMAIL_TOKEN: "ambient", GMAIL_TOKEN: "ambient" })
    expect(resolved.token).toBe(token)
  })

  it("refuses a connection to another provider, a bad origin, mailbox, or bound", () => {
    const cases: ReadonlyArray<Parameters<typeof make>[0]> = [
      { token, connection: connection([], { provider: "slack" }) },
      { token, apiBaseUrl: "not a url" },
      { token, apiBaseUrl: "ftp://example.test" },
      { token, userId: "../other" },
      { token, maxRetries: -1 },
      { token, maxRetries: 11 },
      { token, maxRetries: 1.5 },
      { token, requestTimeout: 0 },
      { token, requestTimeout: Duration.infinity },
      { token, maxRetryAfter: Duration.infinity }
    ]
    for (const config of cases) {
      const error = thrown(() => make(config, {}))
      expect(error.reason, JSON.stringify(config.apiBaseUrl ?? config.userId ?? config.maxRetries)).toBe(
        "invalid-config"
      )
      expect(error.details?.["retryable"]).toBe(false)
    }
    // A zero rate-limit cap is allowed: it means "never wait in process".
    expect(make({ token, maxRetryAfter: 0 }, {}).userId).toBe("me")
  })

  it("fails the layer with the typed config error", async () => {
    const error = await failure(
      Effect.provide(Effect.asVoid(GmailClient), layer({ token, apiBaseUrl: "not a url" }, {}))
    )
    expect(error.reason).toBe("invalid-config")
    const built = await Effect.runPromise(
      Effect.provide(GmailClient, layer({ token, connection: connection() }, {}))
    )
    expect(built.connectionId).toBe("assistant-mail")
    expect(Layer.isLayer(layer({ token }))).toBe(true)
  })
})

describe("Gmail aggregate", () => {
  it("exports every module under one namespace", () => {
    expect(Object.keys(Gmail).sort()).toEqual([
      "Actions",
      "Capabilities",
      "Config",
      "GmailClient",
      "Mime",
      "Reconcile",
      "Records",
      "Sync"
    ])
    expect(Gmail.GmailClient.make).toBe(make)
  })
})

describe("Gmail capabilities", () => {
  it("names the scopes each operation accepts", () => {
    expect(Capabilities.available([Capabilities.SCOPE_METADATA])).toEqual(["metadata"])
    expect(Capabilities.available([Capabilities.SCOPE_READONLY])).toEqual(["metadata", "read"])
    expect(Capabilities.available([Capabilities.SCOPE_SEND])).toEqual(["send"])
    expect(Capabilities.available([Capabilities.SCOPE_COMPOSE])).toEqual(["draft", "send"])
    expect(Capabilities.available([Capabilities.SCOPE_MODIFY])).toEqual(["metadata", "read", "draft", "send"])
    expect(Capabilities.available([Capabilities.SCOPE_FULL])).toEqual(Capabilities.operations)
    expect(Capabilities.available([])).toEqual([])
    expect(Capabilities.personalAccount).toBe(true)
  })

  it("refuses an operation outside the grant with the scopes it needs", () => {
    expect(Capabilities.refusal([Capabilities.SCOPE_SEND], "send")).toBeUndefined()
    const refused = Capabilities.refusal([Capabilities.SCOPE_SEND], "draft")
    expect(refused?.reason).toBe("permission-denied")
    expect(refused?.details?.["requiredAnyOf"]).toEqual(Capabilities.acceptedScopes.draft)
  })

  it("stops a refused operation before any request", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, {}))
    const metadataOnly = client({ connection: connection([Capabilities.SCOPE_METADATA]) })
    for (
      const effect of [
        metadataOnly.listMessages({ q: "from:ada@example.test" }),
        metadataOnly.getMessage("abc", { format: "full" }),
        metadataOnly.createDraft("Subject: x\r\n\r\nx"),
        metadataOnly.sendMessage("Subject: x\r\n\r\nx")
      ]
    ) {
      const error = await failure(effect as Effect.Effect<unknown, IntegrationError>)
      expect(error.reason).toBe("permission-denied")
    }
    expect(fixture.requests).toHaveLength(0)
  })

  it("does not gate a client with no bound connection", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { emailAddress: "a@example.test", historyId: "1" })
    )
    const unbound = client({ connection: undefined })
    expect(unbound.connectionId).toBeUndefined()
    expect((await Effect.runPromise(unbound.getProfile)).historyId).toBe("1")
  })
})

describe("Gmail error parsing", () => {
  it("reads Google's error envelope and nothing else", () => {
    expect(googleError({
      error: { code: 403, message: "Quota", status: "RESOURCE_EXHAUSTED", errors: [{ reason: "rateLimitExceeded" }, 7] }
    })).toEqual({ reasons: ["rateLimitExceeded", "RESOURCE_EXHAUSTED"], message: "Quota" })
    expect(googleError({ error: { errors: "no" } })).toEqual({ reasons: [], message: "" })
    expect(googleError("oops")).toEqual({ reasons: [], message: "" })
    expect(googleError(null)).toEqual({ reasons: [], message: "" })
    expect(googleError({ error: { message: "x".repeat(400) } }).message).toHaveLength(300)
  })

  it("reads Retry-After seconds", () => {
    expect(retryAfterMs(new Headers({ "retry-after": "2" }))).toBe(2000)
    expect(retryAfterMs(new Headers({ "retry-after": "0" }))).toBe(0)
    expect(retryAfterMs(new Headers({ "retry-after": " " }))).toBeNull()
    expect(retryAfterMs(new Headers({ "retry-after": "soon" }))).toBeNull()
    expect(retryAfterMs(new Headers({ "retry-after": "-1" }))).toBeNull()
    expect(retryAfterMs(new Headers())).toBeNull()
  })
})

describe("GmailClient requests", () => {
  it("reads the profile with the bearer token", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { emailAddress: "assistant@example.test", messagesTotal: 3, historyId: "900" })
    )
    const profile = await Effect.runPromise(client().getProfile)
    expect(profile).toEqual({ emailAddress: "assistant@example.test", messagesTotal: 3, historyId: "900" })
    const [sent] = fixture.requests
    expect(sent?.method).toBe("GET")
    expect(url(sent!).pathname).toBe("/gmail/v1/users/me/profile")
    expect(sent?.headers["authorization"]).toBe(`Bearer ${TOKEN}`)
    expect(sent?.headers["content-type"]).toBeUndefined()
  })

  it("lists messages with repeated labels and skips what is unset", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { messages: [{ id: "m1", threadId: "t1" }], nextPageToken: "p2", resultSizeEstimate: 9 })
    )
    const page = await Effect.runPromise(
      client().listMessages({ q: "is:unread", labelIds: ["INBOX", "IMPORTANT"], pageToken: "p1", maxResults: 20 })
    )
    expect(page).toEqual({ messages: [{ id: "m1", threadId: "t1" }], nextPageToken: "p2", resultSizeEstimate: 9 })
    const sent = url(fixture.requests[0]!)
    expect(sent.pathname).toBe("/gmail/v1/users/me/messages")
    expect(sent.searchParams.get("q")).toBe("is:unread")
    expect(sent.searchParams.getAll("labelIds")).toEqual(["INBOX", "IMPORTANT"])
    expect(sent.searchParams.get("pageToken")).toBe("p1")
    expect(sent.searchParams.get("maxResults")).toBe("20")
    expect(sent.searchParams.has("includeSpamTrash")).toBe(false)

    await Effect.runPromise(client().listMessages())
    expect([...url(fixture.requests[1]!).searchParams.keys()]).toEqual([])
  })

  it("refuses a page size outside 1..500 before any request", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, {}))
    for (const maxResults of [0, 501, 1.5]) {
      expect((await failure(client().listMessages({ maxResults }))).reason).toBe("invalid-config")
      expect((await failure(client().listHistory({ startHistoryId: "1", maxResults }))).reason).toBe("invalid-config")
    }
    expect(fixture.requests).toHaveLength(0)
  })

  it("reads a message in metadata or full format", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, {
        id: "m1",
        threadId: "t1",
        labelIds: ["INBOX"],
        snippet: "hi",
        historyId: "77",
        internalDate: "1790000000000",
        payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "Hello" }], body: { size: 2 } }
      })
    )
    const message = await Effect.runPromise(client().getMessage("m1", { metadataHeaders: ["From", "Subject"] }))
    expect(message.payload?.headers).toEqual([{ name: "Subject", value: "Hello" }])
    const metadata = url(fixture.requests[0]!)
    expect(metadata.pathname).toBe("/gmail/v1/users/me/messages/m1")
    expect(metadata.searchParams.get("format")).toBe("metadata")
    expect(metadata.searchParams.getAll("metadataHeaders")).toEqual(["From", "Subject"])

    await Effect.runPromise(client().getMessage("m1", { format: "full", metadataHeaders: ["From"] }))
    const full = url(fixture.requests[1]!)
    expect(full.searchParams.get("format")).toBe("full")
    expect(full.searchParams.has("metadataHeaders")).toBe(false)
  })

  it("decodes a full message's nested MIME tree", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, {
        id: "m1",
        threadId: "t1",
        payload: {
          mimeType: "multipart/mixed",
          parts: [{
            partId: "0",
            mimeType: "multipart/alternative",
            parts: [{ partId: "0.0", mimeType: "text/plain", filename: "", body: { size: 2, data: "aGk" } }]
          }]
        }
      })
    )
    const message = await Effect.runPromise(client().getMessage("m1", { format: "full" }))
    expect(message.payload?.parts?.[0]?.parts?.[0]).toEqual({
      partId: "0.0",
      mimeType: "text/plain",
      filename: "",
      body: { size: 2, data: "aGk" }
    })
  })

  it("refuses an id that would leave the endpoint", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, {}))
    for (const id of ["..", "../profile", "a/b", "", "m1?format=raw"]) {
      expect((await failure(client().getMessage(id))).reason).toBe("invalid-config")
    }
    expect((await failure(client().sendMessage("x", { threadId: "../t" }))).reason).toBe("invalid-config")
    expect((await failure(client().listHistory({ startHistoryId: "12a" }))).reason).toBe("invalid-config")
    expect(fixture.requests).toHaveLength(0)
  })

  it("reads history with its filters", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, {
        history: [{ id: "81", messagesAdded: [{ message: { id: "m2", threadId: "t2" } }] }],
        historyId: "90"
      })
    )
    const page = await Effect.runPromise(
      client().listHistory({
        startHistoryId: "80",
        pageToken: "h2",
        maxResults: 100,
        labelId: "INBOX",
        historyTypes: ["messageAdded", "messageDeleted"]
      })
    )
    expect(page.historyId).toBe("90")
    const sent = url(fixture.requests[0]!)
    expect(sent.pathname).toBe("/gmail/v1/users/me/history")
    expect(sent.searchParams.get("startHistoryId")).toBe("80")
    expect(sent.searchParams.get("labelId")).toBe("INBOX")
    expect(sent.searchParams.getAll("historyTypes")).toEqual(["messageAdded", "messageDeleted"])
  })

  it("addresses a named mailbox", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { emailAddress: "a@example.test", historyId: "1" })
    )
    await Effect.runPromise(client({ userId: "assistant@example.test" }).getProfile)
    expect(fixture.requests[0]?.url).toBe("/gmail/v1/users/assistant%40example.test/profile")
  })

  it("writes a draft and a send as base64url raw JSON bodies", async () => {
    fixture = await startFixture((request, response) => {
      if (request.url.endsWith("/drafts")) {
        json(response, 200, { id: "r-1", message: { id: "m9", threadId: "t9", labelIds: ["DRAFT"] } })
        return
      }
      json(response, 200, { id: "m10", threadId: "t9", labelIds: ["SENT"] })
    })
    const rfc2822 = "Subject: Grüße\r\n\r\nbody"
    const draft = await Effect.runPromise(client().createDraft(rfc2822, { threadId: "t9" }))
    expect(draft).toEqual({ id: "r-1", message: { id: "m9", threadId: "t9", labelIds: ["DRAFT"] } })
    const sent = await Effect.runPromise(client().sendMessage(rfc2822))
    expect(sent).toEqual({ id: "m10", threadId: "t9", labelIds: ["SENT"] })

    const [draftRequest, sendRequest] = fixture.requests
    expect(draftRequest?.method).toBe("POST")
    expect(draftRequest?.headers["content-type"]).toBe("application/json")
    const draftBody = JSON.parse(draftRequest!.body) as { message: { raw: string; threadId: string } }
    expect(draftBody.message.threadId).toBe("t9")
    expect(draftBody.message.raw).not.toMatch(/[+/=]/)
    expect(Buffer.from(draftBody.message.raw, "base64url").toString("utf8")).toBe(rfc2822)
    expect(url(sendRequest!).pathname).toBe("/gmail/v1/users/me/messages/send")
    expect(JSON.parse(sendRequest!.body)).toEqual({ raw: Buffer.from(rfc2822).toString("base64url") })
  })
})

describe("GmailClient retries and ambiguity", () => {
  it("retries a 429 on a read after Retry-After", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) {
        json(response, 429, { error: { code: 429, message: "Too many" } }, { "retry-after": "0" })
        return
      }
      json(response, 200, { emailAddress: "a@example.test", historyId: "5" })
    })
    expect((await Effect.runPromise(client().getProfile)).historyId).toBe("5")
    expect(fixture.requests).toHaveLength(2)
  })

  // A rate-limit refusal was not performed, so repeating even a send is safe.
  it("retries a rate-limited 403 on a send", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) {
        json(response, 403, { error: { code: 403, message: "Limit", errors: [{ reason: "userRateLimitExceeded" }] } })
        return
      }
      json(response, 200, { id: "m1", threadId: "t1" })
    })
    expect((await Effect.runPromise(client().sendMessage("x"))).id).toBe("m1")
    expect(fixture.requests).toHaveLength(2)
  })

  it("fails at once, retryable, when the server asks for a longer wait than the cap", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 429, { error: { message: "Slow down" } }, { "retry-after": "120" })
    )
    const error = await failure(client().getProfile)
    expect(fixture.requests).toHaveLength(1)
    expect(error.reason).toBe("delivery-failed")
    expect(error.details).toMatchObject({ rateLimited: true, retryable: true, retryAfterMs: 120_000, status: 429 })
  })

  it("gives up on an exhausted rate limit and says it is retryable", async () => {
    fixture = await startFixture((_request, response) => json(response, 429, {}))
    const error = await failure(client({ maxRetries: 1 }).getProfile)
    expect(fixture.requests).toHaveLength(2)
    expect(error.details).toMatchObject({ rateLimited: true, retryable: true, retryAfterMs: null })
    expect(error.summary).toContain("Too Many Requests")
  })

  it("retries a 5xx read", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) {
        json(response, 503, { error: { message: "Backend Error" } })
        return
      }
      json(response, 200, { emailAddress: "a@example.test", historyId: "5" })
    })
    expect((await Effect.runPromise(client().getProfile)).historyId).toBe("5")
    expect(fixture.requests).toHaveLength(2)
  })

  it("reports a 5xx send as outcomeUnknown and never repeats it", async () => {
    fixture = await startFixture((_request, response) => json(response, 500, { error: { message: "Backend Error" } }))
    const error = await failure(client().sendMessage("x"))
    expect(fixture.requests).toHaveLength(1)
    expect(error.reason).toBe("delivery-failed")
    expect(error.details).toMatchObject({ outcomeUnknown: true, retryable: false, status: 500 })
    expect(error.summary).toContain("outcome unknown")
  })

  it("reports a dropped connection on a draft as outcomeUnknown", async () => {
    fixture = await startFixture((_request, response) => {
      response.socket?.destroy()
    })
    const error = await failure(client().createDraft("x"))
    expect(fixture.requests).toHaveLength(1)
    expect(error.details).toMatchObject({ outcomeUnknown: true, retryable: false })
  })

  it("retries a dropped connection on a read", async () => {
    fixture = await startFixture((_request, response) => {
      response.socket?.destroy()
    })
    const error = await failure(client({ maxRetries: 1 }).getProfile)
    expect(fixture.requests).toHaveLength(2)
    expect(error.details).toMatchObject({ outcomeUnknown: false, retryable: true })
  })

  it("times out a stalled send as outcomeUnknown and a stalled read as retryable", async () => {
    fixture = await startFixture(() => {
      // Never answers.
    })
    const send = await failure(client({ requestTimeout: "100 millis" }).sendMessage("x"))
    expect(send.details).toMatchObject({ outcomeUnknown: true, retryable: false, timedOut: true })
    expect(fixture.requests).toHaveLength(1)
    const read = await failure(client({ requestTimeout: "100 millis", maxRetries: 0 }).getProfile)
    expect(read.details).toMatchObject({ outcomeUnknown: false, retryable: true, timedOut: true })
  })

  it("refreshes the token once after a 401 and repeats the request", async () => {
    const tokens = rotating(["expired-token", "fresh-token"])
    fixture = await startFixture((request, response) => {
      if (request.headers["authorization"] === "Bearer expired-token") {
        json(response, 401, { error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } })
        return
      }
      json(response, 200, { id: "m1", threadId: "t1" })
    })
    const sent = await Effect.runPromise(client({ token: tokens.source }).sendMessage("x"))
    expect(sent.id).toBe("m1")
    expect(tokens.invalidations()).toBe(1)
    expect(fixture.requests.map((request) => request.headers["authorization"])).toEqual([
      "Bearer expired-token",
      "Bearer fresh-token"
    ])
  })

  it("reports a second 401 as permission-denied", async () => {
    const tokens = rotating(["revoked-a", "revoked-b"])
    fixture = await startFixture((_request, response) =>
      json(response, 401, { error: { message: "Invalid Credentials" } })
    )
    const error = await failure(client({ token: tokens.source }).getProfile)
    expect(error.reason).toBe("permission-denied")
    expect(error.details).toMatchObject({ unauthorized: true, retryable: false })
    expect(fixture.requests).toHaveLength(2)
    expect(tokens.invalidations()).toBe(1)
  })

  it("classifies a scope refusal, a missing message, and a bad request", async () => {
    fixture = await startFixture((request, response) => {
      if (request.url.includes("/profile")) {
        json(response, 403, {
          error: { message: "Insufficient Permission", errors: [{ reason: "insufficientPermissions" }] }
        })
        return
      }
      if (request.url.includes("/messages/gone")) {
        json(response, 404, { error: { message: "Requested entity was not found." } })
        return
      }
      response.writeHead(400, { "content-type": "text/plain" })
      response.end("not json")
    })
    const denied = await failure(client().getProfile)
    expect(denied.reason).toBe("permission-denied")
    expect(denied.details).toMatchObject({ retryable: false, providerReasons: ["insufficientPermissions"] })
    const missing = await failure(client().getMessage("gone"))
    expect(missing.reason).toBe("delivery-failed")
    expect(missing.details).toMatchObject({ status: 404, retryable: false })
    const bad = await failure(client().listMessages())
    expect(bad.details).toMatchObject({ status: 400, retryable: false })
    expect(bad.summary).toContain("Bad Request")
    expect(fixture.requests).toHaveLength(3)
  })

  it("reports an undecodable read as decode-failed, and an undecodable send as outcomeUnknown", async () => {
    fixture = await startFixture((request, response) => {
      if (request.method === "POST") {
        json(response, 200, { unexpected: true })
        return
      }
      response.writeHead(200)
      response.end()
    })
    const read = await failure(client().getProfile)
    expect(read.reason).toBe("decode-failed")
    expect(read.details).toMatchObject({ outcomeUnknown: false })
    const send = await failure(client().sendMessage("x"))
    expect(send.reason).toBe("decode-failed")
    expect(send.details).toMatchObject({ outcomeUnknown: true, retryable: false })
    expect(send.summary).toContain("identity is unknown")
    expect(fixture.requests).toHaveLength(2)
  })

  it("redacts a token a peer echoes back", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 400, { error: { message: `bad token ${TOKEN} in Bearer ${TOKEN}` } })
    )
    const error = await failure(client().getProfile)
    expect(error.summary).not.toContain(TOKEN)
    expect(error.summary).toContain("[REDACTED]")
  })

  it("passes a token source failure through without sending", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, {}))
    const missing: AccessTokenSource = {
      token: Effect.fail(new IntegrationError("credentials-missing", "No credential for assistant-mail.")),
      invalidate: Effect.void
    }
    const error = await failure(client({ token: missing }).sendMessage("x"))
    expect(error.reason).toBe("credentials-missing")
    expect(fixture.requests).toHaveLength(0)
  })
})

describe("Gmail redirects", () => {
  it("fails on a redirect and never sends the token to its target", async () => {
    fixture = await startFixture((request, response) => {
      if (request.url === "/captured") return json(response, 200, { messages: [] })
      response.writeHead(302, { location: "/captured" })
      response.end()
    })
    const error = await failure(client().listMessages())
    expect(error.reason).toBe("delivery-failed")
    expect(error.details).toMatchObject({ status: 302, retryable: false })
    expect(fixture.requests).toHaveLength(1)
  })
})

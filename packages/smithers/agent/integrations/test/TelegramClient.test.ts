import { ERROR_REFERENCE_URL } from "@smthrs/errors/ErrorCode"
import { Cause, type Duration, Effect, Exit, Fiber } from "effect"
import type { ServerResponse } from "node:http"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fromIntegrationError } from "../src/core/ActionFailure.ts"
import { type IntegrationError, isIntegrationError, isRetryable } from "../src/core/IntegrationError.ts"
import { resolve } from "../src/telegram/Config.ts"
import {
  isTelegramApiError,
  make,
  redactBotToken,
  TelegramApiError,
  toIntegrationError
} from "../src/telegram/TelegramClient.ts"
import { type Fixture, json, startFixture } from "./Fixture.ts"

const TOKEN = "123456:AA-bot-token"

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
  vi.unstubAllGlobals()
})

const client = (extra: { readonly maxRateLimitRetries?: number; readonly maxRetryAfterSeconds?: number } = {}) =>
  make({ botToken: TOKEN, apiBaseUrl: (fixture as Fixture).origin, ...extra })

const method = (url: string): string => url.split("/").pop() ?? ""

const ok = (result: unknown) => ({ ok: true, result })

describe("Telegram config", () => {
  it("takes the token from the environment when the caller passes none", () => {
    expect(resolve({}, { SMITHERS_TELEGRAM_BOT_TOKEN: TOKEN }).botToken).toBe(TOKEN)
    expect(resolve({ botToken: "explicit" }, { SMITHERS_TELEGRAM_BOT_TOKEN: TOKEN }).botToken).toBe("explicit")
  })

  it("names the ways to supply a token, and quotes none of it", () => {
    expect(() => resolve({}, {})).toThrow(/SMITHERS_TELEGRAM_BOT_TOKEN/)
    expect(() => make({ botToken: "" }, {})).toThrow(/SMITHERS_TELEGRAM_BOT_TOKEN/)
  })

  // Every doc names this variable as the one the client reads. Before the
  // client took an `env`, nothing in `src` called `resolve` at all, so an
  // operator who exported it got a throw naming the variable it ignored.
  it("takes the bot token from the environment the client was built with", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true, result: true }))
    await Effect.runPromise(
      make({ apiBaseUrl: fixture.origin }, { SMITHERS_TELEGRAM_BOT_TOKEN: TOKEN }).call("getMe")
    )
    expect(fixture.requests[0]?.url).toBe(`/bot${TOKEN}/getMe`)
  })

  // The same rule the GitHub and Linear clients follow: an explicit `env`
  // replaces the ambient one rather than layering over it.
  it("replaces the ambient environment rather than layering over it", () => {
    expect(() => make({ apiBaseUrl: "https://example.invalid" }, {})).toThrow(/SMITHERS_TELEGRAM_BOT_TOKEN/)
  })
})

describe("redactBotToken", () => {
  it("removes the literal token and any bot path segment", () => {
    expect(redactBotToken(`failed at https://api.telegram.org/bot${TOKEN}/sendMessage`, TOKEN))
      .toBe("failed at https://api.telegram.org/bot<redacted>/sendMessage")
    expect(redactBotToken("connect ECONNREFUSED /bot999:other/x", TOKEN))
      .toBe("connect ECONNREFUSED /bot<redacted>/x")
  })

  it("leaves text alone when there is no token to remove", () => {
    expect(redactBotToken("plain", "")).toBe("plain")
  })
})

describe("TelegramClient over a real HTTP server", () => {
  it("posts to /bot<token>/<method> with a JSON body", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, ok({ message_id: 1 })))
    expect(await Effect.runPromise(client().call("getMe"))).toEqual({ message_id: 1 })
    expect(fixture.requests[0]?.url).toBe(`/bot${TOKEN}/getMe`)
    expect(fixture.requests[0]?.headers["content-type"]).toBe("application/json")
  })

  it("fails with the API's own error code and description, redacted", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 400, { ok: false, error_code: 400, description: `bad token ${TOKEN}` })
    )
    const failure = await Effect.runPromise(Effect.flip(client().call("sendMessage")))
    expect(isTelegramApiError(failure)).toBe(true)
    expect(failure.message).not.toContain(TOKEN)
    expect(failure.message).toContain("<redacted>")
    expect(JSON.stringify(failure.details)).not.toContain(TOKEN)
  })

  it("reports a non-JSON body and a transport failure without the token", async () => {
    fixture = await startFixture((_request, response) => {
      response.writeHead(502, { "content-type": "text/html" })
      response.end("<html>bad gateway</html>")
    })
    const nonJson = await Effect.runPromise(Effect.flip(client().call("getMe")))
    expect(nonJson.message).toContain("non-JSON")

    const closed = await startFixture((_request, response) => {
      response.end()
    })
    const origin = closed.origin
    await closed.close()
    const transport = await Effect.runPromise(
      Effect.flip(make({ botToken: TOKEN, apiBaseUrl: origin }).call("getMe"))
    )
    expect(transport.message).not.toContain(TOKEN)
  })

  it("retries a 429 for the capped retry_after, then gives up", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) {
        json(response, 429, {
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 0 }
        })
        return
      }
      json(response, 200, ok({ message_id: 1 }))
    })
    expect(await Effect.runPromise(client().call("sendMessage"))).toEqual({ message_id: 1 })
    expect(calls).toBe(2)

    await fixture.close()
    fixture = await startFixture((_request, response) =>
      json(response, 429, {
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 0 }
      })
    )
    const failure = await Effect.runPromise(
      Effect.flip(client({ maxRateLimitRetries: 1 }).call("sendMessage"))
    )
    expect(isTelegramApiError(failure) && failure.errorCode).toBe(429)
    expect(fixture.requests).toHaveLength(2)
  })

  it("waits one second when a 429 carries no numeric retry_after", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) {
        json(response, 429, {
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: "soon" }
        })
        return
      }
      json(response, 200, ok(true))
    })
    const startedAt = Date.now()
    expect(await Effect.runPromise(client({ maxRateLimitRetries: 1 }).call("getMe"))).toBe(true)
    expect(calls).toBe(2)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900)
  })

  it("does not retry a 400", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 400, { ok: false, error_code: 400, description: "chat not found" })
    )
    await Effect.runPromise(Effect.flip(client().call("sendMessage")))
    expect(fixture.requests).toHaveLength(1)
  })

  it("sends a typing action, then one message per chunk", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, ok({ message_id: 1 })))
    const result = await Effect.runPromise(
      client().sendMessageSmart(42, "a".repeat(5000), { parseMode: "none" })
    )
    expect(result.chunkCount).toBe(2)
    expect(result.chatId).toBe("42")
    expect(result.messageIds).toEqual([1, 1])
    expect(fixture.requests.map((request) => method(request.url)))
      .toEqual(["sendChatAction", "sendMessage", "sendMessage"])
  })

  it("skips the typing action on request and survives one that fails", async () => {
    fixture = await startFixture((request, response) => {
      if (method(request.url) === "sendChatAction") {
        json(response, 400, { ok: false, error_code: 400, description: "no" })
        return
      }
      json(response, 200, ok({ message_id: 1 }))
    })
    await Effect.runPromise(client().sendMessageSmart(42, "hi", { typing: false }))
    expect(fixture.requests.map((request) => method(request.url))).toEqual(["sendMessage"])

    await Effect.runPromise(client().sendMessageSmart(42, "hi"))
    expect(fixture.requests.map((request) => method(request.url)).slice(1))
      .toEqual(["sendChatAction", "sendMessage"])
  })

  it("sends nothing at all for empty text", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, ok({ message_id: 1 })))
    const result = await Effect.runPromise(client().sendMessageSmart(42, ""))
    expect(result).toEqual({ chatId: "42", messageIds: [], chunkCount: 0, usedPlainTextFallback: false })
    expect(fixture.requests).toHaveLength(0)
  })

  // Formatting failure should cost formatting, not the message.
  it("resends a chunk as plain text when Telegram rejects the entities", async () => {
    fixture = await startFixture((request, response) => {
      if (method(request.url) !== "sendMessage") {
        json(response, 200, ok({}))
        return
      }
      const body = JSON.parse(request.body) as { parse_mode?: string }
      if (body.parse_mode !== undefined) {
        json(response, 400, { ok: false, error_code: 400, description: "can't parse entities: bad offset" })
        return
      }
      json(response, 200, ok({ message_id: 9 }))
    })
    const result = await Effect.runPromise(client().sendMessageSmart(42, "**bold**"))
    expect(result.usedPlainTextFallback).toBe(true)
    expect(result.messageIds).toEqual([9])
    const plain = fixture.requests.filter((request) => method(request.url) === "sendMessage").at(-1)
    expect(JSON.parse(plain?.body ?? "{}").text).toBe("**bold**")
  })

  it("does not fall back for an unrelated 400", async () => {
    fixture = await startFixture((request, response) =>
      method(request.url) === "sendMessage"
        ? json(response, 400, { ok: false, error_code: 400, description: "chat not found" })
        : json(response, 200, ok({}))
    )
    const failure = await Effect.runPromise(Effect.flip(client().sendMessageSmart(42, "hi")))
    expect(failure.message).toContain("chat not found")
  })

  it("does not fall back for a 400 response with no provider description", async () => {
    fixture = await startFixture((_request, response) => {
      response.writeHead(400, { "content-type": "text/plain" })
      response.end("bad request")
    })
    const failure = await Effect.runPromise(
      Effect.flip(client().sendMessageSmart(42, "hi", { typing: false }))
    )
    expect(failure.message).toContain("non-JSON")
    expect(fixture.requests).toHaveLength(1)
  })

  it("puts the reply on the first chunk and the keyboard on the last", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, ok({ message_id: 1 })))
    await Effect.runPromise(
      client().sendMessageSmart(42, "a".repeat(5000), {
        parseMode: "none",
        replyToMessageId: 7,
        messageThreadId: 3,
        inlineKeyboard: [[{ text: "ok", callback_data: "x" }]],
        disableNotification: true
      })
    )
    const sends = fixture.requests.filter((request) => method(request.url) === "sendMessage")
      .map((request) => JSON.parse(request.body) as Record<string, unknown>)
    expect(sends[0]).toMatchObject({ reply_to_message_id: 7, message_thread_id: 3, disable_notification: true })
    expect(sends[0]).not.toHaveProperty("reply_markup")
    expect(sends.at(-1)).toHaveProperty("reply_markup")
    expect(sends.at(-1)).not.toHaveProperty("reply_to_message_id")
  })

  it("converts markdown by default and passes an explicit parse mode through", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, ok({ message_id: 1 })))
    await Effect.runPromise(client().sendMessageSmart(42, "**bold**"))
    const converted = JSON.parse(
      fixture.requests.filter((request) => method(request.url) === "sendMessage")[0]?.body ?? "{}"
    ) as { text: string; parse_mode: string }
    expect(converted).toEqual({ chat_id: 42, text: "*bold*", parse_mode: "MarkdownV2" })

    await Effect.runPromise(client().sendMessageSmart(42, "<b>x</b>", { parseMode: "HTML", typing: false }))
    const html = JSON.parse(fixture.requests.at(-1)?.body ?? "{}") as { parse_mode: string; text: string }
    expect(html).toMatchObject({ parse_mode: "HTML", text: "<b>x</b>" })
  })

  it("edits a message in place, with the same fallback", async () => {
    fixture = await startFixture((request, response) => {
      const body = JSON.parse(request.body) as { parse_mode?: string }
      if (body.parse_mode !== undefined) {
        json(response, 400, { ok: false, error_code: 400, description: "can't parse entities" })
        return
      }
      json(response, 200, ok({ message_id: 5 }))
    })
    expect(await Effect.runPromise(client().editMessageSmart(42, 5, "**bold**"))).toEqual({ message_id: 5 })
    expect(JSON.parse(fixture.requests.at(-1)?.body ?? "{}").text).toBe("**bold**")
  })

  it("edits without a parse mode and attaches a keyboard when asked", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, ok({ message_id: 5 })))
    await Effect.runPromise(
      client().editMessageSmart(42, 5, "raw", {
        parseMode: "none",
        inlineKeyboard: [[{ text: "ok", callback_data: "x" }]]
      })
    )
    expect(JSON.parse(fixture.requests[0]?.body ?? "{}")).toEqual({
      chat_id: 42,
      message_id: 5,
      text: "raw",
      reply_markup: { inline_keyboard: [[{ text: "ok", callback_data: "x" }]] }
    })
  })

  it("surfaces an edit failure that is not a parse rejection", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 400, { ok: false, error_code: 400, description: "message is not modified" })
    )
    const failure = await Effect.runPromise(Effect.flip(client().editMessageSmart(42, 5, "same")))
    expect(failure.message).toContain("not modified")
  })

  it("sends a document by URL as JSON and raw bytes as multipart", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, ok({ message_id: 3 })))
    await Effect.runPromise(
      client().sendDocument(42, "https://x.example/a.pdf", {
        caption: "a **report**",
        replyToMessageId: 1,
        messageThreadId: 2
      })
    )
    expect(JSON.parse(fixture.requests[0]?.body ?? "{}")).toMatchObject({
      chat_id: 42,
      document: "https://x.example/a.pdf",
      caption: "a *report*",
      parse_mode: "MarkdownV2",
      reply_to_message_id: 1,
      message_thread_id: 2
    })

    await Effect.runPromise(client().sendDocument(42, { filename: "a.txt", content: "hello" }))
    expect(fixture.requests[1]?.headers["content-type"]).toContain("multipart/form-data")
    expect(fixture.requests[1]?.body).toContain("hello")
    expect(fixture.requests[1]?.body).toContain("filename=\"a.txt\"")

    await Effect.runPromise(
      client().sendDocument(42, {
        filename: "a.bin",
        content: new TextEncoder().encode("bytes"),
        contentType: "application/octet-stream"
      })
    )
    expect(fixture.requests[2]?.body).toContain("bytes")

    await Effect.runPromise(
      client().sendDocument(
        42,
        { filename: "shared.txt", content: "shared fields" },
        { caption: "a **caption**", replyToMessageId: 7, messageThreadId: 8 }
      )
    )
    expect(fixture.requests[3]?.body).toContain("shared fields")
    expect(fixture.requests[3]?.body).toContain("a *caption*")
    expect(fixture.requests[3]?.body).toContain("reply_to_message_id")
    expect(fixture.requests[3]?.body).toContain("message_thread_id")
  })

  it("answers a callback query and a Mini App query", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, ok(true)))
    await Effect.runPromise(client().answerCallbackQuery("q1", { text: "done", showAlert: true }))
    expect(JSON.parse(fixture.requests[0]?.body ?? "{}"))
      .toEqual({ callback_query_id: "q1", text: "done", show_alert: true })

    await Effect.runPromise(client().answerCallbackQuery("q2"))
    expect(JSON.parse(fixture.requests[1]?.body ?? "{}")).toEqual({ callback_query_id: "q2" })

    await Effect.runPromise(client().answerWebAppQuery("w1", { type: "article", id: "1" }))
    expect(JSON.parse(fixture.requests[2]?.body ?? "{}"))
      .toEqual({ web_app_query_id: "w1", result: { type: "article", id: "1" } })
  })

  it("interrupting the fiber aborts the request in flight", async () => {
    fixture = await startFixture(() => {
      // Never answers: the only way out is the interrupt.
    })
    const server = fixture
    // The fixture, not a duration, says when the request is in flight and when
    // its socket closed, so a loaded machine cannot interrupt before the
    // server ever saw the request. Interrupting the fiber is the interruption
    // a cancelled run delivers.
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(client().call("getMe"))
        yield* Effect.promise(() => server.arrived)
        yield* Fiber.interrupt(fiber)
        yield* Effect.timeout(Effect.promise(() => server.closed), "10 seconds")
        return yield* Effect.exit(Fiber.join(fiber))
      })
    )
    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(server.requests).toHaveLength(1)
  })

  it("does not start a request for an already-aborted run signal", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, ok(true)))
    await expect(
      Effect.runPromise(client().call("getMe"), { signal: AbortSignal.abort("already stopped") })
    ).rejects.toThrow()
    expect(fixture.requests).toHaveLength(0)
  })
})

describe("a multi-chunk send names what it delivered", () => {
  const long = `${"a".repeat(4200)}`

  // The durable record claims `chunkCount` messages, so it has to be able to
  // name every one of them.
  it("fails rather than reporting more chunks than it can name", async () => {
    fixture = await startFixture((request, response) => {
      if (request.url.endsWith("/sendChatAction")) {
        json(response, 200, ok(true))
        return
      }
      json(response, 200, ok({ chat: { id: 55 } }))
    })
    const failure = await Effect.runPromise(
      Effect.flip(client().sendMessageSmart(55, "hello", { typing: false }))
    )
    expect(failure.message).toContain("no usable message_id")
  })

  it("reports every chunk id on success", async () => {
    let id = 100
    fixture = await startFixture((_request, response) => json(response, 200, ok({ message_id: ++id })))
    const sent = await Effect.runPromise(client().sendMessageSmart(55, long, { typing: false }))
    expect(sent.chunkCount).toBeGreaterThan(1)
    expect(sent.messageIds).toHaveLength(sent.chunkCount)
  })

  // A send is not atomic: a failure after chunk one leaves a message the
  // reader can already see, and an operator deciding whether to resend needs
  // to know which.
  it("carries the already-delivered ids on a partial failure", async () => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) {
        json(response, 200, ok({ message_id: 101 }))
        return
      }
      json(response, 400, { ok: false, error_code: 400, description: "Bad Request: chat not found" })
    })
    const failure = await Effect.runPromise(
      Effect.flip(client().sendMessageSmart(55, long, { typing: false }))
    )
    expect(isTelegramApiError(failure)).toBe(true)
    expect((failure as TelegramApiError).deliveredMessageIds).toEqual([101])
    expect(failure.message).toContain("already delivered")
  })

  it.each([200, 502])("uses an empty description when a later chunk gets an unreadable %i", async (status) => {
    let calls = 0
    fixture = await startFixture((_request, response) => {
      calls += 1
      if (calls === 1) {
        json(response, 200, ok({ message_id: 101 }))
        return
      }
      response.writeHead(status, { "content-type": "text/plain" })
      response.end("bad gateway")
    })
    const failure = await Effect.runPromise(
      Effect.flip(client().sendMessageSmart(55, long, { typing: false }))
    )
    expect(isTelegramApiError(failure)).toBe(true)
    expect((failure as TelegramApiError).deliveredMessageIds).toEqual([101])
    expect(failure.details).toMatchObject({ description: "" })
    expect((toIntegrationError(failure) as IntegrationError).reason)
      .toBe(status === 200 ? "decode-failed" : "delivery-failed")
  })

  it("refuses a response that is not a Bot API envelope", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, "just a string"))
    const failure = await Effect.runPromise(Effect.flip(client().call("getMe")))
    expect(failure.message).toContain("not a Bot API envelope")
  })

  it("uses the HTTP status when optional failure fields have invalid wire types", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 403, {
        ok: false,
        error_code: "429",
        description: 403,
        parameters: "not an object"
      })
    )
    const failure = await Effect.runPromise(Effect.flip(client().call("getMe")))
    expect(isTelegramApiError(failure)).toBe(true)
    expect(failure).toMatchObject({ errorCode: 403, retryAfterSeconds: null })
    expect((toIntegrationError(failure) as IntegrationError).reason).toBe("permission-denied")
  })

  it("rejects a non-boolean ok field as a non-envelope", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: "true", result: true }))
    const failure = await Effect.runPromise(Effect.flip(client().call("getMe")))
    expect(failure.message).toContain("not a Bot API envelope")
    expect((toIntegrationError(failure) as IntegrationError).reason).toBe("decode-failed")
  })

  it("classifies a non-boolean ok field on an error status by that status", async () => {
    fixture = await startFixture((_request, response) => json(response, 403, { ok: "false" }))
    const failure = await Effect.runPromise(Effect.flip(client().call("getMe")))
    expect(failure.message).toContain("not a Bot API envelope")
    expect((toIntegrationError(failure) as IntegrationError).reason).toBe("permission-denied")
  })

  it("fails decode-failed when a success envelope omits result", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true }))
    const exit = await Effect.runPromise(Effect.exit(client().call("getMe")))
    expect(Exit.isFailure(exit)).toBe(true)
    const failure = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined
    expect(toIntegrationError(failure)).toMatchObject({ reason: "decode-failed" })
  })
})

describe("toIntegrationError", () => {
  // `TelegramApiError` is not an `IntegrationError`, so without this mapping
  // every Telegram failure journaled as an unclassified, non-retryable
  // `delivery-failed`: an exhausted rate limit looked exactly like a chat that
  // does not exist.
  it("classifies each Bot API code, and marks only the transient ones retryable", () => {
    const cases: ReadonlyArray<readonly [number, string, boolean]> = [
      [429, "delivery-failed", true],
      [500, "delivery-failed", true],
      [401, "permission-denied", false],
      [403, "permission-denied", false],
      [400, "decode-failed", false],
      [404, "decode-failed", false],
      [409, "delivery-failed", false]
    ]
    for (const [errorCode, reason, retryable] of cases) {
      const mapped = toIntegrationError(new TelegramApiError("boom", { method: "sendMessage", errorCode }))
      expect(isIntegrationError(mapped)).toBe(true)
      expect((mapped as IntegrationError).reason).toBe(reason)
      expect(isRetryable(mapped)).toBe(retryable)
    }
  })

  it("leaves anything that is not a Bot API failure alone", () => {
    const other = new Error("socket hang up")
    expect(toIntegrationError(other)).toBe(other)
    // A forged name with no shape behind it is not a Bot API failure either.
    const forged = Object.assign(new Error("forged"), { name: "TelegramApiError" })
    expect(toIntegrationError(forged)).toBe(forged)
  })

  // The realistic trigger is a `TelegramApiError` from a second copy of this
  // module, built before `deliveredMessageIds` existed. It satisfies the name,
  // the summary, and the error code, so the refinement admitted it and the
  // spread of a missing array threw a bare `TypeError` — inside
  // `Effect.mapError`, where a throw is a defect rather than the classified
  // failure the action's type promises.
  it("does not admit a claimed Bot API failure whose delivered ids are missing or malformed", () => {
    for (
      const extra of [
        {},
        { deliveredMessageIds: null },
        { deliveredMessageIds: "1,2" },
        { deliveredMessageIds: [1, "2"] }
      ]
    ) {
      const claimed = Object.assign(new Error("boom"), {
        name: "TelegramApiError",
        summary: "boom",
        errorCode: 500,
        ...extra
      })
      expect(isTelegramApiError(claimed)).toBe(false)
      expect(toIntegrationError(claimed)).toBe(claimed)
    }
  })

  it("does not trust a malformed same-module TelegramApiError instance", () => {
    for (const deliveredMessageIds of [undefined, null, "1,2", [1, "2"]]) {
      const malformed = new TelegramApiError("boom", { method: "sendMessage", errorCode: 500 }) as {
        deliveredMessageIds?: unknown
      }
      Object.defineProperty(malformed, "deliveredMessageIds", {
        configurable: true,
        value: deliveredMessageIds
      })
      expect(isTelegramApiError(malformed)).toBe(false)
      expect(toIntegrationError(malformed)).toBe(malformed)
    }
  })

  // The same value has to survive the whole path: the action maps a client
  // failure through `toIntegrationError` and then `fromIntegrationError`, so a
  // throw in either becomes a defect the caller's `catchAll` never sees.
  it("converts a claimed Bot API failure to a journalable failure rather than throwing", () => {
    const claimed = Object.assign(new Error("boom"), { name: "TelegramApiError", summary: "boom", errorCode: 500 })
    const failure = fromIntegrationError(toIntegrationError(claimed))
    expect(failure.reason).toBe("delivery-failed")
    expect(failure.retryable).toBe(false)
  })

  it("leaves Bot API-shaped Error subclasses with throwing getters unclassified", () => {
    class ThrowingGetterError extends Error {}

    for (const property of ["name", "code", "summary", "details"] as const) {
      const hostile = Object.assign(new ThrowingGetterError("boom"), {
        name: "TelegramApiError",
        code: "TELEGRAM_API_ERROR",
        summary: "boom",
        docsUrl: ERROR_REFERENCE_URL,
        details: { method: "sendMessage" },
        errorCode: 500,
        deliveredMessageIds: []
      })
      Object.defineProperty(hostile, property, {
        configurable: true,
        get: () => {
          throw new Error(`${property} getter`)
        }
      })
      expect(() => toIntegrationError(hostile), property).not.toThrow()
      expect(fromIntegrationError(toIntegrationError(hostile)), property).toMatchObject({
        reason: "delivery-failed",
        retryable: false
      })
    }
  })

  it("returns a Bot API failure unchanged when a conversion field starts throwing", () => {
    for (const property of ["details", "reason"] as const) {
      const hostile = new TelegramApiError("boom", { method: "sendMessage", errorCode: 500 })
      let reads = 0
      Object.defineProperty(hostile, property, {
        configurable: true,
        get: () => {
          reads += 1
          if (property === "details" && reads === 1) return { method: "sendMessage" }
          throw new Error(`${property} getter`)
        }
      })
      expect(() => toIntegrationError(hostile), property).not.toThrow()
      const failure = fromIntegrationError(toIntegrationError(hostile))
      expect(failure).toMatchObject({ reason: "delivery-failed", retryable: false })
    }
  })

  // Success without a usable receipt may already have delivered. It must
  // remain unreconciled rather than becoming a safe-to-retry refusal.
  it("classifies an unreadable success as decode-failed with an unknown receipt", async () => {
    fixture = await startFixture((request, response) =>
      method(request.url) === "sendMessage"
        ? json(response, 200, ok({ message_id: "not-a-number" }))
        : json(response, 200, ok(true))
    )
    const failure = await Effect.runPromise(Effect.flip(client().sendMessageSmart(42, "hi")))
    const mapped = toIntegrationError(failure) as IntegrationError
    expect(mapped.reason).toBe("decode-failed")
    expect(mapped.details).toMatchObject({ outcomeUnknown: true })
    expect(isRetryable(mapped)).toBe(false)
    expect(fromIntegrationError(mapped).reason).toBe("decode-failed")
  })

  // A 200 the transport delivered whole is not a delivery failure. What went
  // wrong is that this module could not read the answer, which is what
  // `decode-failed` is for; calling it `delivery-failed` sent an operator
  // looking at the network.
  it("classifies every unreadable 200 as decode-failed", async () => {
    const answers: ReadonlyArray<readonly [string, (response: ServerResponse) => void]> = [
      ["non-JSON", (response) => {
        response.writeHead(200, { "content-type": "text/html" })
        response.end("<html>hello</html>")
      }],
      ["not an envelope", (response) => json(response, 200, 42)],
      ["array envelope", (response) => json(response, 200, [])],
      ["no ok member", (response) => json(response, 200, { result: true })],
      ["invalid ok member", (response) => json(response, 200, { ok: "yes", result: true })]
    ]
    for (const [label, answer] of answers) {
      fixture = await startFixture((_request, response) => answer(response))
      const failure = await Effect.runPromise(Effect.flip(client().call("getMe")))
      const mapped = toIntegrationError(failure) as IntegrationError
      expect(mapped.reason, label).toBe("decode-failed")
      expect(mapped.details, label).toMatchObject({ outcomeUnknown: false })
      await fixture.close()
      fixture = undefined
    }
  })

  // A 5xx whose body is not JSON is still a delivery failure: the transport
  // answered with a failure, and the unreadable body is a symptom.
  it("still classifies an unreadable error status by its status", async () => {
    fixture = await startFixture((_request, response) => {
      response.writeHead(502, { "content-type": "text/html" })
      response.end("<html>bad gateway</html>")
    })
    const mapped = toIntegrationError(
      await Effect.runPromise(Effect.flip(client().call("getMe")))
    ) as IntegrationError
    expect(mapped.reason).toBe("delivery-failed")
    expect(isRetryable(mapped)).toBe(true)
  })

  it("classifies a non-envelope error body by its HTTP status", async () => {
    fixture = await startFixture((_request, response) => json(response, 500, 42))
    const failure = await Effect.runPromise(Effect.flip(client().call("getMe")))
    const mapped = toIntegrationError(failure) as IntegrationError
    expect(mapped.reason).toBe("delivery-failed")
    expect(mapped.details).toMatchObject({ errorCode: 500, outcomeUnknown: true })
  })

  it("uses the HTTP status when an error envelope omits error_code", async () => {
    fixture = await startFixture((_request, response) => json(response, 409, { ok: false, description: "Conflict" }))
    const failure = await Effect.runPromise(Effect.flip(client().call("getMe")))
    expect(isTelegramApiError(failure)).toBe(true)
    expect((failure as TelegramApiError).errorCode).toBe(409)
    expect((toIntegrationError(failure) as IntegrationError).reason).toBe("delivery-failed")
  })

  // The refinement admits a `TelegramApiError` from a copy of this module built
  // before `reason` existed, whose `reason` is `undefined` rather than `null`,
  // and one whose `reason` is a string this build cannot encode. Reading either
  // as an override would turn an exhausted rate limit into a non-retryable
  // failure whose outcome is claimed to be known.
  it("ignores a reason a foreign error does not carry or this build cannot encode", () => {
    for (const extra of [{}, { reason: undefined }, { reason: "invented-in-a-newer-build" }]) {
      const foreign = Object.assign(new Error("boom"), {
        name: "TelegramApiError",
        code: "TELEGRAM_API_ERROR",
        summary: "boom",
        docsUrl: ERROR_REFERENCE_URL,
        errorCode: 429,
        deliveredMessageIds: [],
        ...extra
      })
      const mapped = toIntegrationError(foreign) as IntegrationError
      expect(mapped.reason).toBe("delivery-failed")
      expect(isRetryable(mapped)).toBe(true)
      expect(mapped.details).toMatchObject({ outcomeUnknown: false })
    }
  })

  it("carries the delivered ids of a partial send onto the integration error", () => {
    const partial = new TelegramApiError("boom", {
      method: "sendMessage",
      errorCode: 500,
      deliveredMessageIds: [7, 8]
    })
    const mapped = toIntegrationError(partial) as IntegrationError
    expect(mapped.details?.["deliveredMessageIds"]).toEqual([7, 8])
    expect(fromIntegrationError(mapped).deliveredMessageIds).toEqual([7, 8])
  })

  it("keeps the original failure as the cause", () => {
    const original = new TelegramApiError("boom", { method: "sendMessage", errorCode: 429 })
    expect((toIntegrationError(original) as IntegrationError).cause).toBe(original)
  })
})

describe("Telegram response lifecycle", () => {
  it.each([false, true])("preserves write ambiguity on a body reset (multipleChunks=%s)", async (multipleChunks) => {
    const request = vi.fn<typeof fetch>()
    if (multipleChunks) request.mockResolvedValueOnce(Response.json(ok({ message_id: 101 })))
    request.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{\"ok\":true,\"result\":"))
          },
          pull(controller) {
            controller.error(new Error(`connection reset /bot${TOKEN}/sendMessage`))
          }
        })
      )
    )
    vi.stubGlobal("fetch", request)
    const failure = await Effect.runPromise(Effect.flip(
      make({ botToken: TOKEN }).sendMessageSmart(
        55,
        multipleChunks ? "x".repeat(5000) : "hi",
        { typing: false, parseMode: "none" }
      )
    ))
    const mapped = toIntegrationError(failure) as IntegrationError
    expect(mapped.reason).toBe("delivery-failed")
    expect(mapped.details).toMatchObject({ outcomeUnknown: true })
    expect(mapped.details?.["cause"]).toContain("connection reset")
    expect(JSON.stringify(mapped)).not.toContain(TOKEN)
    expect(fromIntegrationError(mapped).outcomeUnknown).toBe(true)
    expect(mapped.details?.["deliveredMessageIds"]).toEqual(multipleChunks ? [101] : [])
    expect(request).toHaveBeenCalledTimes(multipleChunks ? 2 : 1)
  })
})

it.each([200, 503, 429])("classifies a failed Telegram read body at status %i", async (status) => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(`connection reset /bot${TOKEN}/getMe`)
        }
      }),
      { status }
    )
  )
  vi.stubGlobal("fetch", request)
  const failure = await Effect.runPromise(Effect.flip(
    make({ botToken: TOKEN, maxRateLimitRetries: 0 }).call("getMe")
  ))
  const mapped = toIntegrationError(failure) as IntegrationError
  expect(mapped.reason).toBe("delivery-failed")
  expect(mapped.details).toMatchObject({ errorCode: status, outcomeUnknown: status === 503 })
  expect(mapped.details?.["cause"]).toContain("connection reset")
  expect(JSON.stringify(mapped)).not.toContain(TOKEN)
  expect(request).toHaveBeenCalledOnce()
})

it("interrupts a pending Telegram response body read", async () => {
  let closed = false
  fixture = await startFixture((_request, response) => {
    response.on("close", () => {
      closed = true
    })
    response.writeHead(200, { "content-type": "application/json" })
    response.write("{\"ok\":true,\"result\":")
  })
  const exit = await Effect.runPromise(Effect.exit(Effect.timeout(client().call("getMe"), "100 millis")))
  expect(exit._tag).toBe("Failure")
  await vi.waitFor(() => expect(closed).toBe(true))
  expect(fixture.requests).toHaveLength(1)
})

// The rate-limit budget counts completed attempts, so a peer that answers with
// headers and then trickles the body forever is outside it.
describe("Telegram request deadline", () => {
  const stalled = (onClose: () => void, answered: ReadonlyArray<string> = []) =>
    startFixture((request, response) => {
      if (answered.includes(method(request.url))) {
        json(response, 200, ok({ message_id: 11 }))
        return
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.write("{\"ok\":")
      response.on("close", onClose)
    })

  const deadlined = (requestTimeout: Duration.Input = "200 millis") =>
    make({ botToken: TOKEN, apiBaseUrl: (fixture as Fixture).origin, requestTimeout })

  it("fails a stalled read within the deadline and closes the socket", async () => {
    let closed!: () => void
    const socketClosed = new Promise<void>((resolve) => {
      closed = resolve
    })
    fixture = await stalled(closed)
    const started = Date.now()
    const failure = await Effect.runPromise(Effect.flip(deadlined().call("getMe")))
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(isTelegramApiError(failure)).toBe(true)
    expect(failure.message).toContain("timed out")
    expect(failure.details).toMatchObject({ timedOut: true, outcomeUnknown: false })
    await socketClosed
  })

  it("reports a timed-out send as an unknown outcome", async () => {
    fixture = await stalled(() => {})
    const failure = await Effect.runPromise(
      Effect.flip(deadlined().call("sendMessage", { chat_id: 1, text: "hi" }))
    )
    expect(failure.details).toMatchObject({ timedOut: true, outcomeUnknown: true })
    expect(isRetryable(toIntegrationError(failure))).toBe(false)
  })

  // A long poll asks Telegram to hold the request open, so the client's own
  // deadline has to clear that or every poll would be cancelled mid-flight.
  it("gives getUpdates its server poll timeout plus the transport budget", async () => {
    fixture = await stalled(() => {})
    const started = Date.now()
    const failure = await Effect.runPromise(
      Effect.flip(deadlined().call("getUpdates", { timeout: 1, allowed_updates: ["message"] }))
    )
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(1_000)
    expect(elapsed).toBeLessThan(6_000)
    expect(failure.details).toMatchObject({ timedOut: true })
  })

  it("refuses a deadline that is not finite and positive", () => {
    for (const requestTimeout of [0, -1, "Infinity"] as const) {
      expect(() => make({ botToken: TOKEN, requestTimeout }, {}), String(requestTimeout))
        .toThrow(/finite, positive duration/)
    }
  })

  // The indicator is cosmetic and is awaited before the first chunk, so it is
  // capped far below the request deadline rather than sharing it.
  it("caps the typing action well under the request deadline and still sends", async () => {
    fixture = await stalled(() => {}, ["sendMessage"])
    const started = Date.now()
    const sent = await Effect.runPromise(
      make({ botToken: TOKEN, apiBaseUrl: fixture.origin, requestTimeout: "60 seconds" })
        .sendMessageSmart(7, "hello")
    )
    expect(sent.messageIds).toEqual([11])
    expect(Date.now() - started).toBeLessThan(12_000)
    expect(fixture.requests.map((request) => method(request.url))).toEqual(["sendChatAction", "sendMessage"])
  }, 20_000)
})

describe("request serialization", () => {
  // `JSON.stringify` ran while building the call, so a BigInt parameter threw
  // out of `call` itself instead of failing the returned Effect.
  it("fails invalid-config without sending when params cannot be serialized", async () => {
    const request = vi.fn<typeof fetch>()
    vi.stubGlobal("fetch", request)
    const effect = make({ botToken: TOKEN, apiBaseUrl: "https://api.example" }).call("sendMessage", { chat_id: 1n })
    const failure = await Effect.runPromise(Effect.flip(effect))
    const classified = toIntegrationError(failure) as IntegrationError
    expect(classified.reason).toBe("invalid-config")
    expect(classified.details).toMatchObject({ outcomeUnknown: false, retryable: false })
    expect(request).not.toHaveBeenCalled()
  })
})

describe("Telegram redirects", () => {
  // The bot token is in the path, so a followed redirect whose Location echoes
  // it would carry the token to another host.
  it("fails on a redirect and never follows it", async () => {
    fixture = await startFixture((request, response) => {
      if (request.url === "/captured") return json(response, 200, { ok: true, result: { message_id: 1 } })
      response.writeHead(307, { location: "/captured" })
      response.end()
    })
    const failure = await Effect.runPromise(Effect.flip(client().call("getMe")))
    expect(failure.details).toMatchObject({ errorCode: 307 })
    expect(fixture.requests).toHaveLength(1)
  })
})

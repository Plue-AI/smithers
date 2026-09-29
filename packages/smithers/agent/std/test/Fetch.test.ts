import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as HttpClient from "@smthrs/kernel/HttpClient"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Cause, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as FetchModule from "../src/Fetch.ts"
import { ResolveHost } from "../src/internal/HttpNetwork.ts"
import { MAX_OUTPUT_BYTES } from "../src/internal/Text.ts"

const Fetch = {
  ...FetchModule,
  run: (input: FetchModule.Input) =>
    FetchModule.run(input).pipe(
      Effect.provideService(ResolveHost, () => Effect.succeed(["93.184.216.34"])),
      Effect.provide(
        GrantStore.layer({
          attended: false,
          rules: [new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:get", resource: "*" }) })]
        }).pipe(Layer.provide(Workspace.layer("/workspace")))
      )
    )
}

const responseStub = (body: BodyInit, status = 200) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request)
        return HttpClientResponse.fromWeb(request, new Response(body, { status }))
      })
    )
  )
  return { layer, requests }
}

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => {
  if (Exit.isSuccess(exit)) return undefined
  return exit.cause.reasons.find(Cause.isFailReason)?.error
}

describe("Fetch", () => {
  it.each(
    [
      ["headers", undefined, 30],
      ["body", undefined, 30],
      ["headers", 2, 2],
      ["body", 2, 2],
      ["body", 200, 120]
    ] as const
  )("bounds stalled %s with timeout %s and closes the transport", async (phase, timeout, seconds) => {
    let signal: AbortSignal | undefined
    let bodyClosed = false
    const http = HttpClient.make((request, _url, requestSignal) => {
      signal = requestSignal
      if (phase === "headers") return Effect.never
      const response = HttpClientResponse.fromWeb(request, new Response("prefix"))
      return Effect.succeed(
        new Proxy(response, {
          get(target, property, receiver) {
            return property === "stream"
              ? Stream.concat(Stream.make(new TextEncoder().encode("prefix")), Stream.never).pipe(
                Stream.ensuring(Effect.sync(() => {
                  bodyClosed = true
                }))
              )
              : Reflect.get(target, property, receiver)
          }
        })
      ).pipe(Effect.delay(500))
    })
    const settled = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.exit(
          Fetch.run({ url: "https://example.test/stalled", ...(timeout === undefined ? {} : { timeout }) }).pipe(
            Effect.provideService(HttpClient.HttpClient, http)
          )
        ).pipe(Effect.timeoutOption((seconds + 1) * 1_000), Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust(seconds * 1_000 - 1)
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust(1)
        // The body has only had seconds - 0.5 seconds: the budget must not restart after headers.
        const atDeadline = fiber.pollUnsafe()
        yield* TestClock.adjust("1 second")
        const result = yield* Fiber.join(fiber)
        expect(atDeadline).toBeDefined()
        return result
      }).pipe(Effect.provide(TestClock.layer()))
    )
    expect(Option.isSome(settled)).toBe(true)
    if (Option.isSome(settled)) {
      expect(failureOf(settled.value)).toMatchObject({
        code: "timeout",
        message: `Request timed out after ${seconds} seconds`,
        path: "https://example.test/stalled"
      })
    }
    expect(signal?.aborted).toBe(true)
    if (phase === "body") expect(bodyClosed).toBe(true)
  })

  it.each([0, -1, NaN, Infinity, -Infinity])("rejects invalid timeout %s before dispatch", async (timeout) => {
    const input = { url: "https://example.test/invalid", timeout }
    expect(Schema.is(Fetch.Input)(input)).toBe(false)
    const stub = responseStub("unexpected")
    const exit = await Effect.runPromise(Effect.exit(Fetch.run(input).pipe(Effect.provide(stub.layer))))
    expect(failureOf(exit)).toMatchObject({ code: "invalid_input" })
    expect(stub.requests).toHaveLength(0)
  })

  it("returns HTTP error statuses as successful values with their body", async () => {
    const stub = responseStub("server detail", 500)
    const result = await Effect.runPromise(
      Fetch.run({ url: "https://example.test/failure" }).pipe(Effect.provide(stub.layer))
    )

    expect(result).toEqual({ status: 500, body: "server detail", truncated: false })
  })

  it("truncates display output with exact UTF-8 byte accounting", async () => {
    const source = `${"x".repeat(MAX_OUTPUT_BYTES - 1)}😀`
    const stub = responseStub(source)
    const result = await Effect.runPromise(
      Fetch.run({ url: "https://example.test/large" }).pipe(Effect.provide(stub.layer))
    )

    expect(result.body).toBe("x".repeat(MAX_OUTPUT_BYTES - 1))
    expect(result).toMatchObject({
      truncated: true,
      notice: `Showing ${MAX_OUTPUT_BYTES - 1} of ${MAX_OUTPUT_BYTES + 3} bytes; output was truncated.`
    })
  })

  it("refuses a response that exceeds the bounded capture before decoding", async () => {
    const stub = responseStub("x".repeat(5 * 1024 * 1024 + 1))
    const exit = await Effect.runPromise(
      Effect.exit(Fetch.run({ url: "https://example.test/too-large" }).pipe(Effect.provide(stub.layer)))
    )

    expect(failureOf(exit)).toMatchObject({ code: "response_too_large" })
  })

  it("forwards custom request headers", async () => {
    const stub = responseStub("ok")
    await Effect.runPromise(
      Fetch.run({ url: "https://example.test/headers", headers: { "x-recorded": "yes" } }).pipe(
        Effect.provide(stub.layer)
      )
    )

    expect(stub.requests[0]?.headers["x-recorded"]).toBe("yes")
  })

  it.each([
    ["file", "file:///etc/passwd"],
    ["data", "data:text/plain,hello"],
    ["ftp", "ftp://example.test/file"],
    ["protocol-relative", "//example.test/file"],
    ["malformed", "http://[::1"],
    ["userinfo", "https://user:pass@example.test/private"]
  ])("rejects %s URLs before dispatch", async (_kind, url) => {
    const stub = responseStub("unexpected")
    const exit = await Effect.runPromise(
      Effect.exit(Fetch.run({ url }).pipe(Effect.provide(stub.layer)))
    )

    expect(failureOf(exit)).toMatchObject({ code: "invalid_input", path: url })
    expect(stub.requests).toHaveLength(0)
  })

  it.each([
    ["http", "http://example.test/resource"],
    ["https", "https://example.test/resource"],
    ["IPv6", "http://[2606:4700:4700::1111]/resource"]
  ])("dispatches ordinary %s URLs", async (_kind, url) => {
    const stub = responseStub("ok")
    const result = await Effect.runPromise(Fetch.run({ url }).pipe(Effect.provide(stub.layer)))

    expect(result.body).toBe("ok")
    expect(stub.requests).toHaveLength(1)
  })
})

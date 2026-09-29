import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as HttpClient from "@smthrs/kernel/HttpClient"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Cause, Effect, Exit, Fiber, Layer, Schema, Tracer } from "effect"
import { TestClock } from "effect/testing"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { toMarkdown, toText } from "../src/internal/Html.ts"
import { ResolveHost } from "../src/internal/HttpNetwork.ts"
import * as WebFetchModule from "../src/WebFetch.ts"

const WebFetch = {
  ...WebFetchModule,
  run: (input: WebFetchModule.Input) =>
    WebFetchModule.run(input).pipe(
      Effect.provideService(ResolveHost, () => Effect.succeed(["93.184.216.34"])),
      Effect.provide(
        GrantStore.layer({
          attended: false,
          rules: [new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:get", resource: "*" }) })]
        }).pipe(Layer.provide(Workspace.layer("/workspace")))
      )
    )
}

const responseLayer = (
  body: BodyInit | null,
  headers: Readonly<Record<string, string>>,
  status = 200
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(body, { status, headers }))
      )
    )
  )

describe("WebFetch", () => {
  it("completes a response whose headers and body arrive inside one timeout budget", async () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(
        request,
        new Response("ready", {
          headers: { "content-type": "text/plain" }
        })
      )).pipe(Effect.delay("1 second"))
    )
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* WebFetch.run({ url: "https://example.test/ready", timeout: 2 }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.forkChild
        )
        yield* TestClock.adjust("1 second")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))
    )
    expect(result.content).toBe("ready")
  })

  it.each(
    [
      [undefined, 30],
      [2, 2],
      [200, 120]
    ] as const
  )("bounds stalled headers with timeout %s at %i seconds", async (timeout, seconds) => {
    let signal: AbortSignal | undefined
    const client = HttpClient.make((_request, _url, requestSignal) => {
      signal = requestSignal
      return Effect.never
    })
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.exit(
          WebFetch.run({
            url: "https://example.test/stalled",
            ...(timeout === undefined ? {} : { timeout })
          }).pipe(Effect.provideService(HttpClient.HttpClient, client))
        ).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust((seconds - 1) * 1_000)
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust("1 second")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))
    )
    expect(result._tag).toBe("Failure")
    if (Exit.isFailure(result)) {
      expect(result.cause.reasons.find(Cause.isFailReason)?.error).toMatchObject({ code: "timeout" })
    }
    expect(signal?.aborted).toBe(true)
  })

  it.each([0, -1, NaN, Infinity, -Infinity])("refuses invalid timeout %s before dispatch", async (timeout) => {
    const input = { url: "https://example.test/invalid", timeout }
    expect(Schema.is(WebFetch.Input)(input)).toBe(false)
    let requests = 0
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requests++
        return HttpClientResponse.fromWeb(
          request,
          new Response("unexpected", {
            headers: { "content-type": "text/plain" }
          })
        )
      })
    )
    const failure = await Effect.runPromise(Effect.flip(
      WebFetch.run(input).pipe(
        Effect.provideService(HttpClient.HttpClient, client)
      )
    ))
    expect(failure).toMatchObject({ code: "invalid_input" })
    expect(requests).toBe(0)
  })

  it.each(["body", "redirect"] as const)("holds one timeout budget across %s", async (phase) => {
    const requests: Array<string> = []
    let bodyClosed = false
    let pullStarted = false
    const client = HttpClient.make((request) => {
      requests.push(request.url)
      if (phase === "redirect" && request.url.endsWith("/start")) {
        return Effect.succeed(HttpClientResponse.fromWeb(
          request,
          new Response(null, {
            status: 302,
            headers: { location: "/final" }
          })
        )).pipe(Effect.delay("1 second"))
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("prefix"))
        },
        pull() {
          pullStarted = true
          return new Promise<void>(() => {})
        },
        async cancel() {
          await Promise.resolve()
          bodyClosed = true
        }
      })
      const response = HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          headers: { "content-type": "text/plain" }
        })
      )
      return phase === "body" ? Effect.succeed(response).pipe(Effect.delay("1 second")) : Effect.succeed(response)
    })
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.exit(
          WebFetch.run({ url: "https://example.test/start", timeout: 2 }).pipe(
            Effect.provideService(HttpClient.HttpClient, client)
          )
        ).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("1 second")
        yield* Effect.yieldNow
        const pendingAtOneSecond = fiber.pollUnsafe() === undefined
        yield* TestClock.adjust("1 second")
        const atDeadline = fiber.pollUnsafe()
        const closedAtDeadline = bodyClosed
        const pullingAtDeadline = pullStarted
        yield* Fiber.interrupt(fiber)
        return { atDeadline, closedAtDeadline, pendingAtOneSecond, pullingAtDeadline }
      }).pipe(Effect.provide(TestClock.layer()))
    )
    expect(requests).toHaveLength(phase === "redirect" ? 2 : 1)
    expect(result.pendingAtOneSecond).toBe(true)
    expect(result.pullingAtDeadline).toBe(true)
    expect(result.atDeadline).toBeDefined()
    expect(result.closedAtDeadline).toBe(true)
    if (result.atDeadline === undefined || !Exit.isSuccess(result.atDeadline)) {
      throw new Error("deadline did not settle the forked effect")
    }
    const timedOut = result.atDeadline.value
    if (!Exit.isFailure(timedOut)) throw new Error("deadline did not fail the web fetch")
    const failure = timedOut.cause.reasons.find(Cause.isFailReason)?.error
    expect(failure).toMatchObject({
      code: "timeout",
      message: "Web fetch timed out after 2 seconds"
    })
    expect(failure).not.toHaveProperty("path")
  })

  it("follows a relative redirect and reports the final URL and status", async () => {
    const seen: Array<string> = []
    const layer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          seen.push(request.url)
          return HttpClientResponse.fromWeb(
            request,
            request.url.endsWith("/start")
              ? new Response(null, { status: 302, headers: { location: "../final" } })
              : new Response("done", { status: 201, headers: { "content-type": "text/plain" } })
          )
        })
      )
    )
    const output = await Effect.runPromise(
      WebFetch.run({ url: "https://example.test/path/start", format: "text" }).pipe(Effect.provide(layer))
    )
    expect(seen).toEqual(["https://example.test/path/start", "https://example.test/final"])
    expect(output).toMatchObject({ url: "https://example.test/final", status: 201, content: "done" })
  })

  it("follows a cross-origin redirect without changing the requested format", async () => {
    const seen: Array<{ readonly url: string; readonly accept: string | undefined }> = []
    const layer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          seen.push({ url: request.url, accept: request.headers.accept })
          return HttpClientResponse.fromWeb(
            request,
            request.url.startsWith("https://first.test")
              ? new Response(null, { status: 301, headers: { location: "https://second.test/final" } })
              : new Response("<p>Second origin</p>", { headers: { "content-type": "text/html" } })
          )
        })
      )
    )
    const output = await Effect.runPromise(
      WebFetch.run({ url: "https://first.test/start", format: "html" }).pipe(Effect.provide(layer))
    )
    expect(seen).toEqual([
      { url: "https://first.test/start", accept: "text/html, text/plain;q=0.8" },
      { url: "https://second.test/final", accept: "text/html, text/plain;q=0.8" }
    ])
    expect(output).toMatchObject({ url: "https://second.test/final", content: "<p>Second origin</p>" })
  })

  it("reports the final URL after the kernel client authorizes each redirect hop", async () => {
    const requests: Array<string> = []
    const checks: Array<{ readonly action: string; readonly resource: string }> = []
    const raw = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url)
        return HttpClientResponse.fromWeb(
          request,
          request.url === "https://first.test/start"
            ? new Response(null, { status: 302, headers: { location: "https://second.test/final" } })
            : new Response("arrived", { headers: { "content-type": "text/plain" } })
        )
      })
    )
    const grants = GrantStore.GrantStore.of({
      check: (capability) => {
        checks.push(capability)
        return Effect.void
      },
      reply: () => Effect.die("unused"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })
    const result = await Effect.runPromise(
      WebFetchModule.run({ url: "https://first.test/start", format: "text" }).pipe(
        Effect.provide(HttpClient.layer),
        Effect.provideService(HttpClient.HttpClient, raw),
        Effect.provideService(GrantStore.GrantStore, grants),
        Effect.provideService(ResolveHost, () => Effect.succeed(["93.184.216.34"]))
      )
    )
    expect(requests).toEqual(["https://first.test/start", "https://second.test/final"])
    expect(checks).toEqual([
      { action: "net:get", resource: "first.test" },
      { action: "net:get", resource: "second.test" }
    ])
    expect(result).toMatchObject({
      url: "https://second.test/final",
      status: 200,
      content: "arrived"
    })
  })

  it("enforces one ten-hop redirect limit through the kernel client", async () => {
    const requests: Array<string> = []
    const checks: Array<{ readonly action: string; readonly resource: string }> = []
    const raw = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url)
        return HttpClientResponse.fromWeb(
          request,
          new Response(null, { status: 302, headers: { location: `/hop-${requests.length}` } })
        )
      })
    )
    const grants = GrantStore.GrantStore.of({
      check: (capability) => {
        checks.push(capability)
        return Effect.void
      },
      reply: () => Effect.die("unused"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })
    const failure = await Effect.runPromise(Effect.flip(
      WebFetchModule.run({ url: "https://first.test/start" }).pipe(
        Effect.provide(HttpClient.layer),
        Effect.provideService(HttpClient.HttpClient, raw),
        Effect.provideService(GrantStore.GrantStore, grants),
        Effect.provideService(ResolveHost, () => Effect.succeed(["93.184.216.34"]))
      )
    ))
    expect(failure).toMatchObject({ code: "request_failed", message: "Web fetch exceeded the redirect limit" })
    expect(requests).toHaveLength(11)
    expect(checks).toHaveLength(11)
    expect(checks.every((capability) => capability.action === "net:get" && capability.resource === "first.test"))
      .toBe(true)
  })

  it("accepts ten redirects followed by a final response through the kernel client", async () => {
    const requests: Array<string> = []
    const checks: Array<{ readonly action: string; readonly resource: string }> = []
    const raw = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url)
        const hop = requests.length - 1
        return HttpClientResponse.fromWeb(
          request,
          hop < 10
            ? new Response(null, { status: 302, headers: { location: `/hop-${hop + 1}` } })
            : new Response("last", { headers: { "content-type": "text/plain" } })
        )
      })
    )
    const grants = GrantStore.GrantStore.of({
      check: (capability) => {
        checks.push(capability)
        return Effect.void
      },
      reply: () => Effect.die("unused"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })
    const result = await Effect.runPromise(
      WebFetchModule.run({ url: "https://first.test/start" }).pipe(
        Effect.provide(HttpClient.layer),
        Effect.provideService(HttpClient.HttpClient, raw),
        Effect.provideService(GrantStore.GrantStore, grants),
        Effect.provideService(ResolveHost, () => Effect.succeed(["93.184.216.34"]))
      )
    )
    expect(requests).toEqual([
      "https://first.test/start",
      ...Array.from({ length: 10 }, (_, index) => `https://first.test/hop-${index + 1}`)
    ])
    expect(checks).toHaveLength(11)
    expect(checks.every((capability) => capability.action === "net:get" && capability.resource === "first.test"))
      .toBe(true)
    expect(result).toMatchObject({ url: "https://first.test/hop-10", status: 200, content: "last" })
  })

  it("returns a typed request failure when the host has no HTTP client", async () => {
    const failure = await Effect.runPromise(Effect.flip(
      WebFetch.run({ url: "https://example.test" }).pipe(
        Effect.provideService(HttpClient.HttpClient, HttpClient.makeNoop())
      )
    ))
    expect(failure).toMatchObject({
      code: "request_failed",
      message: "Web fetch request failed: https://example.test/"
    })
  })

  it("returns a typed response failure when the body stream breaks", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("connection reset"))
      }
    })
    const failure = await Effect.runPromise(Effect.flip(
      WebFetch.run({ url: "https://example.test/broken" }).pipe(
        Effect.provide(responseLayer(body, { "content-type": "text/plain" }))
      )
    ))
    expect(failure).toMatchObject({
      code: "request_failed",
      message: "Web fetch response could not be read"
    })
  })

  it("refuses a redirect chain past ten hops", async () => {
    let requests = 0
    const layer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests++
          return HttpClientResponse.fromWeb(
            request,
            new Response(null, {
              status: 302,
              headers: { location: `/hop-${requests}` }
            })
          )
        })
      )
    )
    const failure = await Effect.runPromise(
      Effect.flip(WebFetch.run({ url: "https://example.test/start" }).pipe(Effect.provide(layer)))
    )
    expect(requests).toBe(11)
    expect(failure).toMatchObject({ code: "request_failed", message: "Web fetch exceeded the redirect limit" })
  })

  it.each(
    [
      ["text", "Article\nHello & goodbye."],
      ["html", "<h1>Article</h1><p>Hello &amp; goodbye.</p>"]
    ] as const
  )("renders HTML as %s", async (format, expected) => {
    const output = await Effect.runPromise(
      WebFetch.run({ url: "https://example.test", format }).pipe(
        Effect.provide(responseLayer("<h1>Article</h1><p>Hello &amp; goodbye.</p>", { "content-type": "text/html" }))
      )
    )
    expect(output.content).toBe(expected)
  })

  it.each(["application/octet-stream", ""])("refuses unsupported content type %j", async (contentType) => {
    const failure = await Effect.runPromise(Effect.flip(
      WebFetch.run({ url: "https://example.test" }).pipe(
        Effect.provide(responseLayer(null, contentType === "" ? {} : { "content-type": contentType }))
      )
    ))
    expect(failure).toMatchObject({ code: "unsupported_content_type" })
  })

  it("accepts JSON and rejects an oversized Content-Length before reading the body", async () => {
    const accepted = await Effect.runPromise(
      WebFetch.run({ url: "https://example.test/data" }).pipe(
        Effect.provide(responseLayer("{\"ok\":true}", { "content-type": "application/json" }))
      )
    )
    expect(accepted.content).toBe("{\"ok\":true}")
    const failure = await Effect.runPromise(Effect.flip(
      WebFetch.run({ url: "https://example.test/large" }).pipe(
        Effect.provide(responseLayer("small", {
          "content-type": "text/plain",
          "content-length": String(5 * 1024 * 1024 + 1)
        }))
      )
    ))
    expect(failure).toMatchObject({ code: "response_too_large" })
  })

  it("declares bounded HTTP retrieval with all supported render formats", () => {
    expect(WebFetch.capabilities).toEqual(["net:get:*"])
    expect(toText("<h1>Article</h1><script>ignored()</script><p>Hello &amp; goodbye.</p>")).toBe(
      "Article\nHello & goodbye."
    )
    expect(toMarkdown("<h1>Article</h1><p>Hello <strong>world</strong>.</p>")).toBe("# Article\n\nHello **world**.")
  })

  it("describes every model-facing input and output field", () => {
    const input = Schema.toJsonSchemaDocument(WebFetch.Input).schema as {
      readonly properties: Readonly<Record<string, { readonly description?: string }>>
    }
    const output = Schema.toJsonSchemaDocument(WebFetch.Output).schema as {
      readonly properties: Readonly<Record<string, { readonly description?: string }>>
    }

    expect(Object.values(input.properties).every((field) => JSON.stringify(field).includes("\"description\""))).toBe(
      true
    )
    expect(Object.values(output.properties).every((field) => JSON.stringify(field).includes("\"description\""))).toBe(
      true
    )
  })

  it("fetches a recorded HTML response through the kernel client", async () => {
    const html = readFileSync(new URL("./fixtures/webfetch/article.html", import.meta.url), "utf8")
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const output = await Effect.runPromise(
      WebFetch.run({ url: "https://example.test/article", format: "markdown" }).pipe(
        Effect.provide(responseLayer(html, { "content-type": "text/html" })),
        Effect.provideService(Tracer.Tracer, tracer)
      )
    )
    expect(output).toMatchObject({
      url: "https://example.test/article",
      status: 200,
      contentType: "text/html",
      content: "# Article\n\nHello **world**."
    })
    expect(spans.some((span) => span.name === "WebFetch.run")).toBe(true)
  })

  it("leaves malformed and non-scalar numeric entities unchanged", async () => {
    const entities = "&#x110000; &#99999999999; &#55296; &#;"
    const output = await Effect.runPromise(
      WebFetch.run({ url: "https://example.test/entities", format: "text" }).pipe(
        Effect.provide(responseLayer(`<p>${entities}</p>`, { "content-type": "text/html" }))
      )
    )

    expect(output.content).toBe(entities)
  })

  it.each([
    ["empty", ""],
    ["malformed", "http://[::1"]
  ])("returns a typed failure for an %s redirect location", async (_kind, location) => {
    const failure = await Effect.runPromise(
      Effect.flip(
        WebFetch.run({ url: "https://example.test/redirect" }).pipe(
          Effect.provide(responseLayer("", { location }, 302))
        )
      )
    )

    expect(failure).toMatchObject({ code: "invalid_input", path: location })
  })

  it.each([
    ["file", "file:///etc/passwd"],
    ["data", "data:text/plain,hello"],
    ["ftp", "ftp://example.test/file"],
    ["protocol-relative", "//example.test/file"],
    ["malformed", "http://[::1"],
    ["userinfo", "https://user:pass@example.test/private"]
  ])("rejects %s URLs before dispatch", async (_kind, url) => {
    const failure = await Effect.runPromise(
      Effect.flip(
        WebFetch.run({ url }).pipe(Effect.provide(responseLayer("unexpected", { "content-type": "text/plain" })))
      )
    )

    expect(failure).toMatchObject({ code: "invalid_input", path: url })
  })

  it.each([
    ["http", "http://example.test/resource"],
    ["https", "https://example.test/resource"],
    ["IPv6", "http://[2606:4700:4700::1111]/resource"]
  ])("fetches ordinary %s URLs", async (_kind, url) => {
    const output = await Effect.runPromise(
      WebFetch.run({ url }).pipe(Effect.provide(responseLayer("ok", { "content-type": "text/plain" })))
    )

    expect(output.content).toBe("ok")
  })

  it("keeps the 60 KB head of a 1 MiB response and discloses the cut", async () => {
    const body = "x".repeat(1024 * 1024)
    const output = await Effect.runPromise(
      WebFetch.run({ url: "https://example.test/big", format: "text" }).pipe(
        Effect.provide(responseLayer(body, { "content-type": "text/plain" }))
      )
    )

    expect(output.content).toBe("x".repeat(60_000))
    expect(output.truncated).toBe(true)
    expect(output.notice).toBe("Showing 60000 of 1048576 bytes; output was truncated.")
  })

  it("caps the rendered page, not the raw HTML", async () => {
    const html = `<script>${"x".repeat(70_000)}</script><p>Hello</p>`
    const output = await Effect.runPromise(
      WebFetch.run({ url: "https://example.test/scripted" }).pipe(
        Effect.provide(responseLayer(html, { "content-type": "text/html" }))
      )
    )

    expect(output).toMatchObject({ content: "Hello", truncated: false })
    expect(output).not.toHaveProperty("notice")
  })

  it("reports an untruncated body without a notice", async () => {
    const output = await Effect.runPromise(
      WebFetch.run({ url: "https://example.test/small" }).pipe(
        Effect.provide(responseLayer("ok", { "content-type": "text/plain" }))
      )
    )

    expect(output).toMatchObject({ content: "ok", truncated: false })
    expect(output).not.toHaveProperty("notice")
  })

  it("stops streaming once a response exceeds the byte cap", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        WebFetch.run({ url: "https://example.test/large" }).pipe(
          Effect.provide(responseLayer("x".repeat(5 * 1024 * 1024 + 1), { "content-type": "text/plain" }))
        )
      )
    )
    expect(failure).toMatchObject({
      code: "response_too_large"
    })
  })
})

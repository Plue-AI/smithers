import * as Credential from "@smthrs/control/Credential"
import * as HttpClient from "@smthrs/kernel/HttpClient"
import { Cause, Effect, Exit, Fiber, Layer, Option, Redacted, Schema, Stream, Tracer } from "effect"
import { TestClock } from "effect/testing"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as ExaWebSearch from "../src/ExaWebSearch.ts"
import * as WebSearch from "../src/WebSearch.ts"

const reference = { id: "exa", name: "Exa" }

const credentials = (failure?: "get" | "resolve"): Credential.Credential => {
  const unavailable = Credential.makeNoop()
  return Credential.Credential.of({
    list: () => Effect.succeed([reference]),
    get: () => failure === "get" ? unavailable.get(reference.id) : Effect.succeed(reference),
    create: () => Effect.succeed(reference),
    resolve: () =>
      failure === "resolve"
        ? unavailable.resolve(reference)
        : Effect.succeed(Redacted.make("recorded-secret")),
    rotate: () => Effect.succeed(reference),
    revoke: () => Effect.void
  })
}

const responseClient = (
  body: BodyInit,
  options: { readonly status?: number; readonly headers?: Readonly<Record<string, string>> } = {}
) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request)
      return HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          status: options.status ?? 200,
          headers: options.headers ?? { "content-type": "application/json" }
        })
      )
    })
  )
  return { http, requests }
}

const providerLayer = (
  http: HttpClient.HttpClient,
  credential: Credential.Credential = credentials()
) =>
  ExaWebSearch.layer("exa").pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(Credential.Credential, credential),
        Layer.succeed(HttpClient.HttpClient, http)
      )
    )
  )

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => {
  if (Exit.isSuccess(exit)) return undefined
  return exit.cause.reasons.find(Cause.isFailReason)?.error
}

const jsonBody = (request: HttpClientRequest.HttpClientRequest | undefined): Readonly<Record<string, unknown>> => {
  if (request?.body._tag !== "Uint8Array") return {}
  return JSON.parse(new TextDecoder().decode(request.body.body)) as Readonly<Record<string, unknown>>
}

describe("WebSearch", () => {
  it("uses a named provider span and keeps credentials outside flow input", async () => {
    const provider = WebSearch.make({
      search: () => Effect.succeed({ results: [{ title: "Result", url: "https://example.com", snippet: "Recorded" }] })
    })
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const output = await Effect.runPromise(
      WebSearch.run({ query: "recorded" }).pipe(
        Effect.provide(Layer.succeed(WebSearch.WebSearch, provider)),
        Effect.provideService(Tracer.Tracer, tracer)
      )
    )

    expect(output.results).toEqual([{ title: "Result", url: "https://example.com", snippet: "Recorded" }])
    expect(Object.keys(WebSearch.Input.fields)).not.toContain("credential")
    expect(spans.some((span) => span.name === "WebSearch.run")).toBe(true)
  })

  it("describes every model-facing input and result field", () => {
    const input = Schema.toJsonSchemaDocument(WebSearch.Input).schema as {
      readonly properties: Readonly<Record<string, { readonly description?: string }>>
    }
    const result = Schema.toJsonSchemaDocument(WebSearch.Result).schema as {
      readonly properties: Readonly<Record<string, { readonly description?: string }>>
    }

    expect(Object.values(input.properties).every((field) => JSON.stringify(field).includes("\"description\""))).toBe(
      true
    )
    expect(Object.values(result.properties).every((field) => JSON.stringify(field).includes("\"description\""))).toBe(
      true
    )
  })

  it("fails with the stable missing-provider error", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(WebSearch.run({ query: "missing" }).pipe(Effect.provide(WebSearch.layerNoop)))
    )
    expect(failureOf(exit)).toMatchObject({ code: "provider_unavailable" })
  })

  it("normalizes a recorded Exa response using a named credential", async () => {
    const body = readFileSync(new URL("./fixtures/websearch/exa-success.json", import.meta.url), "utf8")
    const client = responseClient(body)
    const output = await Effect.runPromise(
      WebSearch.run({ query: "recorded", numResults: 1 }).pipe(
        Effect.provide(providerLayer(client.http))
      )
    )

    expect(output.results).toEqual([{
      title: "Recorded result",
      url: "https://example.com/recorded",
      snippet: "Recorded fixture result.",
      publishedAt: "2026-01-01T00:00:00.000Z"
    }])
    expect(client.requests).toHaveLength(1)
    expect(client.requests[0]?.url).toBe("https://api.exa.ai/search")
    expect(client.requests[0]?.headers.authorization).toBe("Bearer recorded-secret")
  })

  it("distinguishes an empty successful result set from provider failures", async () => {
    const empty = responseClient(JSON.stringify({ results: [] }))
    const output = await Effect.runPromise(
      WebSearch.run({ query: "none" }).pipe(Effect.provide(providerLayer(empty.http)))
    )
    expect(output.results).toEqual([])

    const cases = [
      { status: 401, headers: {}, code: "provider_unavailable" },
      { status: 429, headers: { "retry-after": "17" }, code: "rate_limited" },
      { status: 500, headers: {}, code: "provider_unavailable" }
    ] as const
    for (const current of cases) {
      const client = responseClient(JSON.stringify({ message: "provider error" }), {
        status: current.status,
        headers: { "content-type": "application/json", ...current.headers }
      })
      const exit = await Effect.runPromise(
        Effect.exit(WebSearch.run({ query: "failure" }).pipe(Effect.provide(providerLayer(client.http))))
      )
      expect(failureOf(exit)).toMatchObject({ code: current.code })
    }
  })

  // A CDN, a proxy, or a provider pacing a healthy caller can attach
  // `Retry-After` to a 200. Reading the header without the status threw the
  // decoded results away as a `timeout`, which is a refusal the provider never
  // made.
  it("keeps a successful response whose headers carry Retry-After", async () => {
    const client = responseClient(
      JSON.stringify({ results: [{ url: "https://example.com/paced", title: "Paced", text: "Body" }] }),
      { status: 200, headers: { "content-type": "application/json", "retry-after": "17" } }
    )
    const output = await Effect.runPromise(
      WebSearch.run({ query: "paced" }).pipe(Effect.provide(providerLayer(client.http)))
    )

    expect(output.results).toEqual([{
      title: "Paced",
      url: "https://example.com/paced",
      snippet: "Body"
    }])
  })

  it("still reports a refusal that carries Retry-After as throttling", async () => {
    for (const status of [429, 503] as const) {
      const client = responseClient(JSON.stringify({ message: "slow down" }), {
        status,
        headers: { "content-type": "application/json", "retry-after": "17" }
      })
      const exit = await Effect.runPromise(
        Effect.exit(WebSearch.run({ query: "throttled" }).pipe(Effect.provide(providerLayer(client.http))))
      )
      expect(failureOf(exit), String(status)).toMatchObject({
        code: "rate_limited",
        message: "Exa search was throttled; retry after 17 seconds"
      })
    }
  })

  it.each(
    [
      [undefined, "Exa search was throttled"],
      ["invalid", "Exa search was throttled"],
      ["0", "Exa search was throttled; retry after 0 seconds"],
      ["Thu, 08 Jan 2026 00:00:17 GMT", "Exa search was throttled; retry after 17 seconds"]
    ] as const
  )("reports 429 Retry-After %s as rate_limited", async (retryAfter, message) => {
    const client = responseClient("slow down", {
      status: 429,
      headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter }
    })
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        yield* TestClock.setTime(Date.parse("2026-01-08T00:00:00.000Z"))
        return yield* Effect.exit(WebSearch.run({ query: "paced" }).pipe(Effect.provide(providerLayer(client.http))))
      }).pipe(Effect.provide(TestClock.layer()))
    )
    expect(failureOf(exit)).toMatchObject({ code: "rate_limited", message })
  })

  it("fails typed on non-JSON and schema-invalid success bodies", async () => {
    for (const body of ["not json", JSON.stringify({})]) {
      const client = responseClient(body)
      const exit = await Effect.runPromise(
        Effect.exit(WebSearch.run({ query: "invalid" }).pipe(Effect.provide(providerLayer(client.http))))
      )
      expect(failureOf(exit)).toMatchObject({ code: "request_failed" })
    }
  })

  it.each(["get", "resolve"] as const)("maps credential %s failures to provider_unavailable", async (operation) => {
    const client = responseClient(JSON.stringify({ results: [] }))
    const exit = await Effect.runPromise(
      Effect.exit(
        WebSearch.run({ query: "credential" }).pipe(
          Effect.provide(providerLayer(client.http, credentials(operation)))
        )
      )
    )

    expect(failureOf(exit)).toMatchObject({ code: "provider_unavailable" })
    expect(client.requests).toHaveLength(0)
  })

  it("uses the test clock for freshness and clamps direct calls to 20 results", async () => {
    const results = Array.from({ length: 25 }, (_, index) => ({
      title: `Result ${index}`,
      url: `https://example.test/${index}`,
      text: `Snippet ${index}`
    }))
    const client = responseClient(JSON.stringify({ results }))
    const output = await Effect.runPromise(
      Effect.gen(function*() {
        yield* TestClock.setTime(Date.parse("2026-01-08T00:00:00.000Z"))
        return yield* WebSearch.run({ query: "fresh", freshness: "week", numResults: 50 }).pipe(
          Effect.provide(providerLayer(client.http))
        )
      }).pipe(Effect.provide(TestClock.layer()))
    )
    const body = jsonBody(client.requests[0])

    expect(output.results).toHaveLength(20)
    expect(body.numResults).toBe(20)
    expect(body.startPublishedDate).toBe("2026-01-01T00:00:00.000Z")
  })

  it.each(["execute", "body"] as const)("times out while awaiting the provider %s phase", async (phase) => {
    const http = phase === "execute"
      ? HttpClient.make(() => Effect.never)
      : HttpClient.make((request) => {
        const response = HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } })
        )
        return Effect.succeed(
          new Proxy(response, {
            get(target, property, receiver) {
              return property === "stream" ? Stream.never : Reflect.get(target, property, receiver)
            }
          })
        )
      })
    const settled = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.exit(
          WebSearch.run({ query: "timeout" }).pipe(Effect.provide(providerLayer(http)))
        ).pipe(
          Effect.timeoutOption("31 seconds"),
          Effect.forkChild
        )
        yield* Effect.yieldNow
        yield* TestClock.adjust("31 seconds")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))
    )

    expect(Option.isSome(settled)).toBe(true)
    if (Option.isSome(settled)) {
      expect(failureOf(settled.value)).toMatchObject({ code: "timeout" })
    }
  })
})

import * as Credential from "@smthrs/control/Credential"
import * as HttpClient from "@smthrs/kernel/HttpClient"
import { Effect, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as ExaWebSearch from "../src/ExaWebSearch.ts"
import * as WebSearch from "../src/WebSearch.ts"

const setup = (body: unknown, status = 200) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const reference = { id: "test-exa", name: "Test Exa" }
  const credential = Credential.Credential.of({
    ...Credential.makeNoop(),
    get: (id) =>
      Effect.sync(() => {
        expect(id).toBe("test-exa")
        return reference
      }),
    resolve: (value) =>
      Effect.sync(() => {
        expect(value).toBe(reference)
        return Redacted.make("dummy-private-key")
      })
  })
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request)
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" }
        })
      )
    })
  )
  return {
    requests,
    layer: ExaWebSearch.layer("test-exa").pipe(Layer.provide(Layer.merge(
      Layer.succeed(Credential.Credential, credential),
      Layer.succeed(HttpClient.HttpClient, http)
    )))
  }
}
const requestBody = (request: HttpClientRequest.HttpClientRequest | undefined): unknown => {
  if (request?.body._tag !== "Uint8Array") throw new Error("Expected encoded Exa JSON request")
  return JSON.parse(new TextDecoder().decode(request.body.body))
}

describe("Exa provider request and response boundaries", () => {
  for (
    const [freshness, date] of [
      [undefined, undefined],
      ["day", "2026-01-07T00:00:00.000Z"],
      ["week", "2026-01-01T00:00:00.000Z"],
      ["month", "2025-12-08T00:00:00.000Z"],
      ["year", "2025-01-08T00:00:00.000Z"]
    ] as const
  ) {
    it.each([[undefined, 8], [1, 1], [20, 20]] as const)(
      `uses freshness=${freshness} and result limit=%s with ordered truncation`,
      async (numResults, count) => {
        const hits = Array.from({ length: 21 }, (_, index) => ({ url: `https://example.invalid/${index}` }))
        const client = setup({ results: hits })
        const result = await Effect.runPromise(
          Effect.gen(function*() {
            yield* TestClock.setTime(Date.parse("2026-01-08T00:00:00.000Z"))
            return yield* WebSearch.run({
              query: "widgets",
              ...(freshness === undefined ? {} : { freshness }),
              ...(numResults === undefined ? {} : { numResults })
            }).pipe(Effect.provide(client.layer))
          }).pipe(Effect.provide(TestClock.layer()))
        )
        expect(client.requests).toHaveLength(1)
        expect(requestBody(client.requests[0])).toEqual({
          query: "widgets",
          numResults: count,
          ...(date === undefined ? {} : { startPublishedDate: date })
        })
        expect(result.results).toEqual(hits.slice(0, count).map(({ url }) => ({ title: url, url, snippet: "" })))
      }
    )
  }

  it("preserves explicit empty title/text and publication while bounding snippets at 2000 characters", async () => {
    const client = setup({
      results: [
        { url: "https://example.invalid/empty", title: "", text: "", publishedDate: "2026-01-01" },
        { url: "https://example.invalid/at", title: "At", text: "a".repeat(2000) },
        { url: "https://example.invalid/over", text: "b".repeat(2001) }
      ]
    })
    const result = await Effect.runPromise(WebSearch.run({ query: "bounds" }).pipe(Effect.provide(client.layer)))
    expect(result).toEqual({
      results: [
        { title: "", url: "https://example.invalid/empty", snippet: "", publishedAt: "2026-01-01" },
        { title: "At", url: "https://example.invalid/at", snippet: "a".repeat(2000) },
        { title: "https://example.invalid/over", url: "https://example.invalid/over", snippet: "b".repeat(2000) }
      ]
    })
  })

  it.each(
    [
      [300, "request_failed", "Exa search returned 300"],
      [400, "request_failed", "Exa search returned 400"],
      [404, "request_failed", "Exa search returned 404"],
      [403, "provider_unavailable", "Exa search authentication was rejected"]
    ] as const
  )("maps status %s without leaking response or credential details", async (status, code, message) => {
    const client = setup({ secret: "dummy-private-key", detail: "untrusted-provider-detail" }, status)
    const error = await Effect.runPromise(
      Effect.flip(WebSearch.run({ query: "errors" }).pipe(Effect.provide(client.layer)))
    )
    expect(error).toMatchObject({ code, message })
    expect(String(error)).not.toContain("dummy-private-key")
    expect(String(error)).not.toContain("untrusted-provider-detail")
    expect(client.requests).toHaveLength(1)
  })
})

import * as Credential from "@smthrs/control/Credential"
import * as HttpClient from "@smthrs/kernel/HttpClient"
import { Effect, Layer, Redacted } from "effect"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { expect, it } from "vitest"
import * as ExaWebSearch from "../src/ExaWebSearch.ts"
import * as WebSearch from "../src/WebSearch.ts"

it("maps a transport failure without retrying or leaking details and allows a subsequent search", async () => {
  const reference = { id: "test-exa", name: "Test Exa" }
  const credential = Credential.Credential.of({
    ...Credential.makeNoop(),
    get: () => Effect.succeed(reference),
    resolve: () => Effect.succeed(Redacted.make("dummy-private-key"))
  })
  let requests = 0
  const http = HttpClient.make((request) =>
    Effect.suspend(() => {
      requests++
      if (requests === 1) {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error("private transport detail: dummy-private-key")
            })
          })
        )
      }
      return Effect.succeed(HttpClientResponse.fromWeb(
        request,
        Response.json({ results: [{ title: "Recovered", url: "https://example.invalid/result", text: "Found" }] })
      ))
    })
  )
  const layer = ExaWebSearch.layer("test-exa").pipe(Layer.provide(Layer.merge(
    Layer.succeed(Credential.Credential, credential),
    Layer.succeed(HttpClient.HttpClient, http)
  )))
  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const failure = yield* Effect.flip(WebSearch.run({ query: "first" }))
      expect(requests).toBe(1)
      const recovered = yield* WebSearch.run({ query: "second" })
      return { failure, recovered }
    }).pipe(Effect.provide(layer))
  )
  expect(result.failure).toMatchObject({ code: "request_failed", message: "Exa search request failed" })
  expect(String(result.failure)).not.toContain("dummy-private-key")
  expect(String(result.failure)).not.toContain("private transport detail")
  expect(result.recovered).toEqual({
    results: [{ title: "Recovered", url: "https://example.invalid/result", snippet: "Found" }]
  })
  expect(requests).toBe(2)
})

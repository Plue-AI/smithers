import * as Credential from "@smthrs/control/Credential"
import * as HttpClient from "@smthrs/kernel/HttpClient"
import { Effect, Layer, Redacted } from "effect"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { expect, it } from "vitest"
import * as ExaWebSearch from "../src/ExaWebSearch.ts"
import * as WebSearch from "../src/WebSearch.ts"

it("maps an actual response-body stream read failure without leaking provider or credential details", async () => {
  const reference = { id: "test-exa", name: "Test Exa" }
  const credential = Credential.Credential.of({
    ...Credential.makeNoop(),
    get: () => Effect.succeed(reference),
    resolve: () => Effect.succeed(Redacted.make("dummy-private-key"))
  })
  let reads = 0
  let requests = 0
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests++
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              reads++
              controller.error(new Error("private provider detail: dummy-private-key"))
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    })
  )
  const layer = ExaWebSearch.layer("test-exa").pipe(Layer.provide(Layer.merge(
    Layer.succeed(Credential.Credential, credential),
    Layer.succeed(HttpClient.HttpClient, http)
  )))
  const error = await Effect.runPromise(Effect.flip(WebSearch.run({ query: "read-error" }).pipe(Effect.provide(layer))))
  expect(error).toMatchObject({ code: "request_failed", message: "Exa search response was invalid" })
  expect(requests).toBe(1)
  expect(reads).toBe(1)
  expect(String(error)).not.toContain("dummy-private-key")
  expect(String(error)).not.toContain("private provider detail")
})

it("refuses a response body over the 5 MiB limit without buffering the rest", async () => {
  const reference = { id: "test-exa", name: "Test Exa" }
  const credential = Credential.Credential.of({
    ...Credential.makeNoop(),
    get: () => Effect.succeed(reference),
    resolve: () => Effect.succeed(Redacted.make("dummy-private-key"))
  })
  let pulls = 0
  const chunk = new Uint8Array(1024 * 1024).fill(0x20)
  const http = HttpClient.make((request) =>
    Effect.sync(() =>
      HttpClientResponse.fromWeb(
        request,
        new Response(
          // An endless body: a hostile endpoint picks its size.
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls++
              controller.enqueue(chunk)
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    )
  )
  const layer = ExaWebSearch.layer("test-exa").pipe(Layer.provide(Layer.merge(
    Layer.succeed(Credential.Credential, credential),
    Layer.succeed(HttpClient.HttpClient, http)
  )))
  const error = await Effect.runPromise(Effect.flip(WebSearch.run({ query: "huge" }).pipe(Effect.provide(layer))))
  expect(error).toMatchObject({ code: "response_too_large" })
  expect(pulls).toBeLessThan(16)
})

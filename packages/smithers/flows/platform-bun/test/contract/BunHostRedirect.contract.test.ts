/**
 * Redirect fail-closed contract for BunHost's HttpClient.
 *
 * Both the Node coverage lane and the Bun compatibility lane run this suite.
 * Each lane exercises its runtime's native fetch implementation.
 * `redirect: "manual"` is the whole subject, so the assertion is that the
 * second origin is never reached.
 */
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import * as BunHost from "../../src/BunHost.ts"

const listen = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once("error", onError)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError)
      resolve((server.address() as AddressInfo).port)
    })
  })

const close = (server: Server): Promise<void> => {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error))
  })
}

let destinationHits = 0
let destinationPort = 0
let originPort = 0
const destination = createServer((_request, response) => {
  destinationHits += 1
  response.writeHead(200, { "content-type": "text/plain" })
  response.end("redirect destination")
})
const origin = createServer((_request, response) => {
  response.writeHead(302, {
    location: `http://127.0.0.1:${destinationPort}/must-not-be-hit`
  })
  response.end()
})

beforeAll(async () => {
  destination.unref()
  origin.unref()
  destinationPort = await listen(destination)
  originPort = await listen(origin)
})

afterAll(async () => {
  await Promise.all([close(origin), close(destination)])
})

const fetchRedirect = Effect.gen(function*() {
  const client = yield* HttpClient
  const response = yield* client.execute(
    HttpClientRequest.get(`http://127.0.0.1:${originPort}/redirect`)
  )
  yield* response.text
  return { location: response.headers.location, status: response.status }
})

describe("BunHost redirect contract", () => {
  it.effect("does not follow a 302 redirect to a second origin", () =>
    Effect.gen(function*() {
      destinationHits = 0
      const response = yield* fetchRedirect.pipe(Effect.provide(BunHost.layer))

      expect(response).toEqual({
        location: `http://127.0.0.1:${destinationPort}/must-not-be-hit`,
        status: 302
      })
      expect(destinationHits).toBe(0)
    }))

  it.effect("the standalone HttpClient layer does not follow a redirect either", () =>
    Effect.gen(function*() {
      destinationHits = 0
      const response = yield* fetchRedirect.pipe(Effect.provide(BunHost.layerHttpClient))

      expect(response).toEqual({
        location: `http://127.0.0.1:${destinationPort}/must-not-be-hit`,
        status: 302
      })
      expect(destinationHits).toBe(0)
    }))

  it("re-exports no HttpClient module that follows redirects by default", () => {
    // `@effect/platform-bun/BunHttpClient.layer` follows redirects; handing it
    // out beside the bundle made the unsafe client the one-import path.
    expect(Object.keys(BunHost)).not.toContain("BunHttpClient")
  })
})

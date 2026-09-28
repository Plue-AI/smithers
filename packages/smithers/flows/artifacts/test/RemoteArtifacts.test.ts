/**
 * The dumb-HTTP CAS protocol: `GET`/`PUT`/`HEAD /cas/{digest}` and
 * `POST /cas/findMissing`, mirroring
 * `com.google.devtools.build.lib.remote.http.HttpCacheClient`.
 */
import { describe, expect, it } from "@effect/vitest"
import { syncCrypto } from "@smthrs/crypto"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import { TestClock } from "effect/testing"
import * as Tracer from "effect/Tracer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as ArtifactStore from "../src/ArtifactStore.ts"
import * as RemoteArtifacts from "../src/RemoteArtifacts.ts"
import { bytes, sha256, text, withCrypto } from "./Crypto.ts"

const artifact = "a shared artifact"
const digest = sha256(bytes(artifact))

interface Call {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
}

/** Records every request and answers it from a caller-supplied responder. */
const stubClient = (
  responder: (call: Call) => Response | Promise<Response>
) => {
  const calls: Array<Call> = []
  const client = HttpClient.make((request, url) =>
    Effect.promise(async () => {
      const body = request.body._tag === "Uint8Array" ? text(request.body.body)! : ""
      const call: Call = {
        method: request.method,
        url: url.toString(),
        headers: { ...request.headers } as Record<string, string>,
        body
      }
      calls.push(call)
      return HttpClientResponse.fromWeb(request, await responder(call))
    })
  )
  return { calls, layer: Layer.succeed(HttpClient.HttpClient)(client) }
}

const remote = (
  responder: (call: Call) => Response | Promise<Response>,
  options?: Omit<RemoteArtifacts.Options, "endpoint"> & { readonly endpoint?: string }
) => {
  const stub = stubClient(responder)
  return {
    calls: stub.calls,
    store: Effect.provide(
      RemoteArtifacts.make({ endpoint: options?.endpoint ?? "https://cache.example.com/", ...options }),
      stub.layer
    )
  }
}

const errorOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  return (reason as { readonly error: unknown }).error
}

describe("construction", () => {
  it.effect.each([NaN, Infinity, -1, 1.5])(
    "refuses invalid maxDownloadBytes %s",
    (maxDownloadBytes) =>
      Effect.gen(function*() {
        const tier = remote(() => new Response(null, { status: 200 }), { maxDownloadBytes })
        const exit = yield* tier.store.pipe(Effect.exit)
        expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("invalid_configuration")
        expect(tier.calls).toEqual([])
      })
  )

  it.effect.each(["not a duration", "Infinity", "0 millis", "-1 millis"])(
    "refuses invalid downloadTimeout %s",
    (downloadTimeout) =>
      Effect.gen(function*() {
        const tier = remote(() => new Response(null, { status: 200 }), {
          downloadTimeout: downloadTimeout as never
        })
        const exit = yield* tier.store.pipe(Effect.exit)
        expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("invalid_configuration")
        expect(tier.calls).toEqual([])
      })
  )

  it.effect.each(["uploadTimeout", "requestTimeout"] as const)(
    "refuses an invalid %s as permanent configuration",
    (name) =>
      Effect.gen(function*() {
        const tier = remote(() => new Response(null, { status: 200 }), { [name]: "0 millis" })
        const exit = yield* tier.store.pipe(Effect.exit)
        expect(errorOf(exit)).toMatchObject({
          code: "invalid_configuration",
          message: `invalid remote artifact option: ${name}`
        })
        expect(tier.calls).toEqual([])
      })
  )

  it.effect("never retains endpoint credentials in a rejected configuration", () =>
    Effect.gen(function*() {
      const secret = "supersecret-never-log"
      for (
        const endpoint of [
          `https://user:${secret}@cache.example.com`,
          `https://cache.example.com?token=${secret}`,
          `https://cache.example.com#${secret}`,
          `not-a-url-${secret}`
        ]
      ) {
        const exit = yield* remote(() => new Response(null), { endpoint }).store.pipe(Effect.exit)
        const failure = errorOf(exit) as ArtifactStore.ArtifactStoreError
        expect(failure.code).toBe("invalid_configuration")
        expect(failure.message).not.toContain(secret)
        expect(failure.cause).toBeUndefined()
        expect(JSON.stringify(failure)).not.toContain(secret)
      }
    }))

  it.effect("normalizes hostile option access and non-string headers without retaining values", () =>
    Effect.gen(function*() {
      const stub = stubClient(() => new Response(null))
      const hostile = { endpoint: "https://cache.example.com" } as RemoteArtifacts.Options
      Object.defineProperty(hostile, "headers", {
        get() {
          throw new Error("secret getter value")
        }
      })
      const getterExit = yield* Effect.provide(RemoteArtifacts.make(hostile), stub.layer).pipe(Effect.exit)
      expect(errorOf(getterExit)).toMatchObject({
        code: "invalid_configuration",
        message: "invalid remote artifact option: options"
      })

      const headerExit = yield* remote(() => new Response(null), {
        headers: { authorization: 42 } as never
      }).store.pipe(Effect.exit)
      expect(errorOf(headerExit)).toMatchObject({ code: "invalid_configuration" })
    }))

  it.effect("rejects non-string endpoints and throwing duration inputs as configuration", () =>
    Effect.gen(function*() {
      const endpointExit = yield* remote(() => new Response(null), { endpoint: 42 as never }).store.pipe(Effect.exit)
      expect(errorOf(endpointExit)).toMatchObject({ code: "invalid_configuration" })
      const durationExit = yield* remote(() => new Response(null), {
        requestTimeout: Symbol("invalid") as never
      }).store.pipe(Effect.exit)
      expect(errorOf(durationExit)).toMatchObject({ code: "invalid_configuration" })
    }))

  it.effect.each([0, -1, 1.5, 256 * 1024 + 1])(
    "refuses invalid maxFindMissingResponseBytes %s",
    (maxFindMissingResponseBytes) =>
      Effect.gen(function*() {
        const exit = yield* remote(() => new Response(null), { maxFindMissingResponseBytes }).store.pipe(Effect.exit)
        expect(errorOf(exit)).toMatchObject({ code: "invalid_configuration" })
      })
  )
})

describe("HTTP exchange lifetime and tracing", () => {
  it.effect.each(["success", "status", "transport"] as const)(
    "redacts custom credentials in completed HTTP spans on %s",
    (mode) =>
      Effect.gen(function*() {
        const spans: Array<Tracer.NativeSpan> = []
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options)
            spans.push(span)
            return span
          }
        })
        const client = HttpClient.make((request) =>
          mode === "transport"
            ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request })
              })
            )
            : Effect.succeed(HttpClientResponse.fromWeb(
              request,
              new Response(null, {
                status: mode === "status" ? 503 : 200
              })
            ))
        ).pipe(HttpClient.mapRequest(HttpClientRequest.setHeaders({
          "x-host-secret": "host-secret-value",
          "x-public": "public-value"
        })))
        const hostRules = [...(yield* Headers.CurrentRedactedNames), /^x-host-/]
        const exit = yield* Effect.gen(function*() {
          const store = yield* RemoteArtifacts.make({
            endpoint: "https://cache.example.com",
            headers: { "X-Auth-Token": "custom-secret-value", authorization: "Bearer secret-value" }
          })
          const result = yield* store.has(digest).pipe(Effect.exit)
          expect(yield* Headers.CurrentRedactedNames).toEqual(hostRules)
          return result
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(Headers.CurrentRedactedNames, hostRules),
          Effect.provideService(Tracer.Tracer, tracer)
        )
        expect(exit._tag).toBe(mode === "success" ? "Success" : "Failure")
        const httpSpans = spans.filter((span) => span.name === "http.client HEAD")
        expect(httpSpans).toHaveLength(1)
        for (const span of httpSpans) {
          expect(span.status._tag).toBe("Ended")
          expect(span.attributes.get("http.request.header.x-auth-token")).toBe("<redacted>")
          expect(span.attributes.get("http.request.header.authorization")).toBe("<redacted>")
          expect(span.attributes.get("http.request.header.x-host-secret")).toBe("<redacted>")
          expect(span.attributes.get("http.request.header.x-public")).toBe("public-value")
        }
        expect(JSON.stringify(spans.map((span) => [...span.attributes]))).not.toContain("secret-value")
      })
  )

  it.effect.each(["oversize", "status", "missing", "upload", "upload-status", "has", "batch"] as const)(
    "aborts unused %s responses without draining their bodies",
    (mode) =>
      Effect.gen(function*() {
        let cancelled = false
        let pulls = 0
        let signal: AbortSignal | undefined
        const response = new Response(
          new ReadableStream({
            pull() {
              pulls++
            },
            cancel() {
              cancelled = true
            }
          }, { highWaterMark: 0 }),
          {
            status: mode === "status" || mode === "upload-status" || mode === "batch"
              ? 503
              : mode === "missing"
              ? 404
              : 200,
            headers: mode === "oversize" ? { "content-length": "999999" } : {}
          }
        )
        const fetch: typeof globalThis.fetch = async (_input, init) => {
          signal = init?.signal ?? undefined
          signal?.addEventListener("abort", () => {
            void response.body?.cancel()
          })
          return response
        }
        const exit = yield* withCrypto(
          Effect.gen(function*() {
            const store = yield* RemoteArtifacts.make({ endpoint: "https://cache.example.com", maxDownloadBytes: 8 })
            return yield* (mode === "upload" || mode === "upload-status"
              ? store.put(bytes(artifact))
              : mode === "has" ?
              store.has(digest)
              : mode === "batch" ?
              store.findMissing([digest])
              : store.get(digest))
          }).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, fetch),
            Effect.exit
          )
        )
        expect(exit._tag).toBe(mode === "upload" || mode === "has" ? "Success" : "Failure")
        expect(pulls).toBe(0)
        expect(signal?.aborted).toBe(true)
        expect(cancelled).toBe(true)
      })
  )
})

describe("uploads", () => {
  it.effect.each([
    "http://cache.example.com",
    "https://user:secret@cache.example.com",
    "https://cache.example.com?tenant=one",
    "https://cache.example.com#fragment",
    "http://cache.localhost:8080",
    "not a URL"
  ])("refuses unsafe endpoint %s before sending credentials", (endpoint) =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 200 }), {
        endpoint,
        headers: { authorization: "Bearer secret" }
      })
      const exit = yield* tier.store.pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(tier.calls).toEqual([])
    }))

  it.effect.each(["http://127.0.0.1:8080", "http://localhost:8080/cache", "http://[::1]:8080"])(
    "accepts plain HTTP to literal loopback %s",
    (endpoint) =>
      Effect.gen(function*() {
        const tier = remote(() => new Response(null, { status: 404 }), { endpoint })
        const store = yield* tier.store
        expect(yield* store.has(digest)).toBe(false)
        expect(tier.calls).toHaveLength(1)
      })
  )

  it.effect.each([
    { authorization: "Bearer a\r\nx-injected: 1" },
    { "bad name": "value" },
    { "x-long": "v".repeat(16 * 1024 + 1) }
  ])("refuses an unsendable header at construction", (headers) =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 200 }), { headers })
      const failure = errorOf(yield* tier.store.pipe(Effect.exit)) as ArtifactStore.ArtifactStoreError
      expect(failure.code).toBe("invalid_configuration")
      expect(tier.calls).toEqual([])
    }))

  it.effect("PUTs the bytes to /cas/{digest} and returns the measured address", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 201 }))
      const published = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(artifact))))
      expect(published).toBe(digest)
      expect(tier.calls[0]!.method).toBe("PUT")
      // The trailing slash on the configured endpoint is ignored.
      expect(tier.calls[0]!.url).toBe(`https://cache.example.com/cas/${digest}`)
      expect(tier.calls[0]!.body).toBe(artifact)
    }))

  it.effect("snapshots upload bytes before an asynchronous digest host yields", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const crypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (algorithm, snapshot) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(syncCrypto.digest(algorithm, snapshot))
          )
      })
      const tier = remote(() => new Response(null, { status: 201 }))
      const input = bytes(artifact)
      const running = yield* Effect.flatMap(tier.store, (store) => store.put(input)).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(entered)
      input.fill(0)
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(running)).toBe(digest)
      expect(tier.calls[0]!.body).toBe(artifact)
    }))

  it.effect("sends the configured credential headers", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 200 }), { headers: { authorization: "Bearer secret" } })
      yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(artifact))))
      expect(tier.calls[0]!.headers["authorization"]).toBe("Bearer secret")
    }))

  it.effect("keeps its own content headers when a deployment configures the same names", () =>
    Effect.gen(function*() {
      // Caller headers are applied first and the protocol's own last. The other
      // order is silently destructive: a configured `content-range` would ride
      // on every chunk, the tier would stop seeing per-chunk ranges, answer
      // 2xx, and the client would read that as a tier ignoring `Content-Range`
      // and re-send the whole blob forever, with no diagnostic anywhere.
      const tier = remote(() => new Response(null, { status: 200 }), {
        headers: {
          authorization: "Bearer secret",
          "content-range": "bytes 0-0/1",
          "content-type": "text/plain"
        }
      })
      yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(artifact))))
      const upload = tier.calls[0]!
      expect(upload.headers["authorization"]).toBe("Bearer secret")
      expect(upload.headers["content-type"]).toBe("application/octet-stream")
      expect(upload.headers["content-range"]).toBeUndefined()
    }))

  it.effect("drops configured protocol headers from bodyless requests and whole fallback PUTs", () =>
    Effect.gen(function*() {
      const tier = remote((call) => {
        if (call.method === "GET") return new Response(artifact)
        if (call.method === "HEAD") return new Response(null, { status: 404 })
        if (call.method === "POST") return new Response(JSON.stringify({ missing: [] }))
        return new Response(null, { status: call.headers["content-range"] === undefined ? 201 : 400 })
      }, {
        chunkBytes: 4,
        headers: {
          "Content-Range": "bytes 0-0/1",
          "Content-Length": "1",
          "Content-Type": "text/plain"
        }
      })
      const store = yield* tier.store
      yield* withCrypto(store.put(bytes(artifact)))
      yield* withCrypto(store.get(digest))
      yield* store.has(digest)
      yield* store.findMissing([digest])
      const uploads = tier.calls.filter((call) => call.method === "PUT")
      expect(uploads.map((call) => call.headers["content-range"])).toEqual([
        `bytes */${bytes(artifact).byteLength}`,
        undefined
      ])
      expect(uploads[1]!.headers["content-length"]).toBe(String(bytes(artifact).byteLength))
      for (const call of tier.calls.filter((call) => call.method !== "PUT")) {
        expect(call.headers["content-range"]).toBeUndefined()
        if (call.method !== "POST") {
          expect(call.headers["content-length"]).toBeUndefined()
          expect(call.headers["content-type"]).toBeUndefined()
        }
      }
    }))

  it.effect("never lets a configured content-length describe a body it does not measure", () =>
    Effect.gen(function*() {
      // `content-length` is the one protocol header a body carries rather than
      // a header the request sets, so applying caller headers first does not
      // displace it. A stale configured length would describe a body the client
      // never sent, and a tier that honors it stores a truncated blob under a
      // correct address, which only a later read discovers as corruption.
      const tier = remote(() => new Response(null, { status: 200 }), {
        headers: { "content-length": "1" }
      })
      yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(artifact))))
      const upload = tier.calls[0]!
      expect(upload.body).toBe(artifact)
      expect(upload.headers["content-length"]).toBe(String(bytes(artifact).byteLength))
    }))

  it.effect("fails on a non-2xx answer", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 500 }))
      const exit = yield* withCrypto(
        Effect.flatMap(tier.store, (store) => store.put(bytes(artifact))).pipe(Effect.exit)
      )
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
    }))

  it.effect("fails when the transport itself refuses", () =>
    Effect.gen(function*() {
      const client = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: new Error("ECONNREFUSED") })
          })
        )
      )
      const store = Effect.provide(
        RemoteArtifacts.make({ endpoint: "https://cache.example.com" }),
        Layer.succeed(HttpClient.HttpClient)(client)
      )
      const exit = yield* withCrypto(Effect.flatMap(store, (tier) => tier.put(bytes(artifact))).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
    }))

  it.effect("bounds an upload whose transport never answers", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Promise<Response>(() => {}), { uploadTimeout: "50 millis" })
      const running = yield* withCrypto(
        Effect.flatMap(tier.store, (store) => store.put(bytes(artifact))).pipe(
          Effect.exit,
          Effect.forkChild({ startImmediately: true })
        )
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust("50 millis")
      expect(errorOf(yield* Fiber.join(running))).toMatchObject({ code: "transport_failed" })
    }))
})

/**
 * A blob past `chunkBytes` travels as a sequence of `Content-Range` PUTs, so a
 * transfer that dies partway does not start over and a proxy that caps request
 * bodies does not cap the artifact size.
 */
describe("chunked uploads", () => {
  const large = "0123456789"
  const largeDigest = sha256(bytes(large))
  /** The `Content-Range` of every ranged or whole-blob `PUT`, in order. */
  const ranges = (calls: ReadonlyArray<Call>) =>
    calls.filter((call) => call.method === "PUT").map((call) => call.headers["content-range"])

  /**
   * Answers the two `HEAD` probes the chunked path makes, so each test below
   * is about the ranged sequence between them: the tier holds nothing until
   * the sequence has delivered the last byte, and the whole blob afterwards.
   */
  const withHeads = (responder: (call: Call) => Response): (call: Call) => Response => {
    let delivered = 0
    return (call) => {
      if (call.method === "HEAD") {
        return delivered < large.length
          ? new Response(null, { status: 404 })
          : new Response(null, { status: 200, headers: { "content-length": String(large.length) } })
      }
      const chunk = /^bytes \d+-(\d+)\/\d+$/.exec(call.headers["content-range"] ?? "")
      if (chunk !== null) delivered = Math.max(delivered, Number(chunk[1]) + 1)
      return responder(call)
    }
  }

  it.effect.each([0, -1, 1.5, NaN])("refuses invalid chunkBytes %s", (chunkBytes) =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 200 }), { chunkBytes })
      const exit = yield* tier.store.pipe(Effect.exit)
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("invalid_configuration")
      expect(tier.calls).toEqual([])
    }))

  it.effect("sends one whole-blob PUT when the bytes fit in a chunk", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 201 }), { chunkBytes: 64 })
      yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(large))))
      expect(tier.calls.length).toBe(1)
      expect(tier.calls[0]!.headers["content-range"]).toBeUndefined()
      expect(tier.calls[0]!.body).toBe(large)
    }))

  it.effect("probes, then sends sequential ranges", () =>
    Effect.gen(function*() {
      const tier = remote(
        withHeads((call) =>
          call.headers["content-range"] === "bytes 8-9/10"
            ? new Response(null, { status: 201 })
            : new Response(null, { status: 308 })
        ),
        { chunkBytes: 4 }
      )
      const published = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(large))))
      expect(published).toBe(largeDigest)
      expect(ranges(tier.calls)).toEqual(["bytes */10", "bytes 0-3/10", "bytes 4-7/10", "bytes 8-9/10"])
      expect(tier.calls.filter((call) => call.method === "PUT").map((call) => call.body)).toEqual([
        "",
        "0123",
        "4567",
        "89"
      ])
      // One `HEAD` before the transfer and one after it: the tier is asked
      // what it holds, and asked again to confirm what it took.
      expect(tier.calls.filter((call) => call.method === "HEAD").length).toBe(2)
    }))

  it.effect("sends nothing when the tier already holds the whole blob", () =>
    Effect.gen(function*() {
      const tier = remote(
        () => new Response(null, { status: 200, headers: { "content-length": "10" } }),
        { chunkBytes: 4 }
      )
      const published = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(large))))
      expect(published).toBe(largeDigest)
      expect(tier.calls.map((call) => call.method)).toEqual(["HEAD"])
    }))

  it.effect("resumes after the prefix the server already holds", () =>
    Effect.gen(function*() {
      // The server took chunk 1 during an earlier, interrupted transfer, so it
      // answers the probe with the prefix it kept. The retry must continue at
      // chunk 2 rather than re-send bytes the tier already has.
      const tier = remote(
        withHeads((call) =>
          call.headers["content-range"] === "bytes */10"
            ? new Response(null, { status: 308, headers: { range: "bytes=0-3" } })
            : call.headers["content-range"] === "bytes 4-7/10"
            ? new Response(null, { status: 308 })
            : new Response(null, { status: 201 })
        ),
        { chunkBytes: 4 }
      )
      yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(large))))
      expect(ranges(tier.calls)).toEqual(["bytes */10", "bytes 4-7/10", "bytes 8-9/10"])
    }))

  it.effect("skips ahead when a chunk answer reports a longer prefix", () =>
    Effect.gen(function*() {
      const tier = remote(
        withHeads((call) =>
          call.headers["content-range"] === "bytes */10"
            ? new Response(null, { status: 308 })
            : call.headers["content-range"] === "bytes 0-3/10"
            ? new Response(null, { status: 308, headers: { range: "bytes=0-7" } })
            : new Response(null, { status: 201 })
        ),
        { chunkBytes: 4 }
      )
      yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(large))))
      expect(ranges(tier.calls)).toEqual(["bytes */10", "bytes 0-3/10", "bytes 8-9/10"])
    }))

  it.effect("sends the blob whole when the probe itself answers 2xx", () =>
    Effect.gen(function*() {
      // A tier that ignores `Content-Range` stores the probe's empty body and
      // answers `201`. Read as a completed transfer, that publishes a digest
      // over zero bytes, so it is read as the refusal it is.
      const tier = remote(withHeads(() => new Response(null, { status: 201 })), { chunkBytes: 4 })
      const published = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(large))))
      expect(published).toBe(largeDigest)
      expect(ranges(tier.calls)).toEqual(["bytes */10", undefined])
      expect(tier.calls.filter((call) => call.method === "PUT")[1]!.body).toBe(large)
    }))

  it.effect("sends the blob whole when a chunk the tier still owes bytes after answers 2xx", () =>
    Effect.gen(function*() {
      const tier = remote(
        withHeads((call) =>
          call.headers["content-range"] === "bytes */10"
            ? new Response(null, { status: 308 })
            : new Response(null, { status: 201 })
        ),
        { chunkBytes: 4 }
      )
      const published = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(large))))
      expect(published).toBe(largeDigest)
      expect(ranges(tier.calls)).toEqual(["bytes */10", "bytes 0-3/10", undefined])
    }))

  it.effect("sends the blob whole when the closing HEAD reports a shorter blob", () =>
    Effect.gen(function*() {
      // Every answer in the sequence is correct and the last one is `2xx`, but
      // the tier kept four bytes of ten. The stored length is what decides.
      const tier = remote((call) =>
        call.method === "HEAD"
          ? new Response(null, { status: 200, headers: { "content-length": "4" } })
          : call.headers["content-range"] === undefined || call.headers["content-range"] === "bytes 8-9/10"
          ? new Response(null, { status: 201 })
          : new Response(null, { status: 308 }), { chunkBytes: 4 })
      const published = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(large))))
      expect(published).toBe(largeDigest)
      expect(ranges(tier.calls).at(-1)).toBeUndefined()
      expect(tier.calls.filter((call) => call.method === "PUT").at(-1)!.body).toBe(large)
    }))

  it.effect("sends the blob whole when the closing HEAD reports no length at all", () =>
    Effect.gen(function*() {
      const tier = remote((call) =>
        call.method === "HEAD"
          ? new Response(null, { status: 204 })
          : call.headers["content-range"] === undefined || call.headers["content-range"] === "bytes 8-9/10"
          ? new Response(null, { status: 201 })
          : new Response(null, { status: 308 }), { chunkBytes: 4 })
      expect(yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(large))))).toBe(largeDigest)
      expect(tier.calls.filter((call) => call.method === "PUT").at(-1)!.body).toBe(large)
    }))

  it.effect("starts at zero when the probe finds nothing stored", () =>
    Effect.gen(function*() {
      const tier = remote(
        withHeads((call) =>
          call.headers["content-range"] === "bytes */10"
            ? new Response(null, { status: 404 })
            : call.headers["content-range"] === "bytes 8-9/10"
            ? new Response(null, { status: 201 })
            : new Response(null, { status: 308 })
        ),
        { chunkBytes: 4 }
      )
      yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(large))))
      expect(ranges(tier.calls)).toEqual(["bytes */10", "bytes 0-3/10", "bytes 4-7/10", "bytes 8-9/10"])
    }))

  // `411` and `416` refuse the body's framing; `400` is RFC 9110 section
  // 14.5's answer from a resource that does not support partial PUT, and it
  // is what this repository's own hosted and self-hosted cache services send.
  it.effect.each([400, 411, 416])("falls back to a whole-blob PUT on %s", (status) =>
    Effect.gen(function*() {
      const tier = remote(
        withHeads((call) =>
          call.headers["content-range"] === undefined
            ? new Response(null, { status: 201 })
            : new Response(null, { status })
        ),
        { chunkBytes: 4 }
      )
      const published = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(large))))
      expect(published).toBe(largeDigest)
      expect(ranges(tier.calls)).toEqual(["bytes */10", undefined])
      expect(tier.calls.filter((call) => call.method === "PUT")[1]!.body).toBe(large)
    }))

  it.effect.each([400, 411, 416])(
    "falls back when a chunk, not the probe, is refused with %s",
    (status) =>
      Effect.gen(function*() {
        const tier = remote(
          withHeads((call) =>
            call.headers["content-range"] === "bytes */10"
              ? new Response(null, { status: 308 })
              : call.headers["content-range"] === undefined
              ? new Response(null, { status: 201 })
              : new Response(null, { status })
          ),
          { chunkBytes: 4 }
        )
        yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(large))))
        expect(ranges(tier.calls)).toEqual(["bytes */10", "bytes 0-3/10", undefined])
      })
  )

  it.effect("computes each chunk's range even when one is configured for every request", () =>
    Effect.gen(function*() {
      // The protocol's `content-range` is applied after the caller's headers,
      // so a deployment that configures the same name cannot silently turn the
      // resumable path into a permanent whole-blob path.
      const tier = remote(withHeads(() => new Response(null, { status: 308 })), {
        chunkBytes: 4,
        headers: { "content-range": "bytes 0-0/1" }
      })
      const published = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(large))))
      expect(published).toBe(largeDigest)
      expect(ranges(tier.calls)).toEqual(["bytes */10", "bytes 0-3/10", "bytes 4-7/10", "bytes 8-9/10"])
    }))

  it.effect("does not resume from a prefix past the safe integer range", () =>
    Effect.gen(function*() {
      // `Number("9".repeat(19)) + 1` silently loses precision, so a hostile or
      // broken tier must not be able to move the offset with it. An unusable
      // prefix leaves the offset where the chunk put it, and the transfer still
      // terminates.
      const tier = remote(
        withHeads(() => new Response(null, { status: 308, headers: { range: `bytes=0-${"9".repeat(19)}` } })),
        { chunkBytes: 4 }
      )
      const published = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(large))))
      expect(published).toBe(largeDigest)
      expect(ranges(tier.calls)).toEqual(["bytes */10", "bytes 0-3/10", "bytes 4-7/10", "bytes 8-9/10"])
    }))

  it.effect("completes when the last chunk is acknowledged with 308", () =>
    Effect.gen(function*() {
      // A tier that answers every chunk "keep going" has still taken every
      // byte once the offset reaches the total; the transfer ends there rather
      // than waiting for a 2xx that will never come.
      const tier = remote(withHeads(() => new Response(null, { status: 308 })), { chunkBytes: 4 })
      const published = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(large))))
      expect(published).toBe(largeDigest)
      expect(ranges(tier.calls)).toEqual(["bytes */10", "bytes 0-3/10", "bytes 4-7/10", "bytes 8-9/10"])
    }))

  it.effect("ignores a resume header that names no usable prefix", () =>
    Effect.gen(function*() {
      // A prefix that does not start at zero, or that is not a byte range at
      // all, leaves the offset where the chunk put it.
      const tier = remote(
        withHeads((call) =>
          call.headers["content-range"] === "bytes */10"
            ? new Response(null, { status: 308, headers: { range: "bytes=2-5" } })
            : new Response(null, { status: 308, headers: { range: "unknown" } })
        ),
        { chunkBytes: 4 }
      )
      yield* withCrypto(Effect.flatMap(tier.store, (store) => store.put(bytes(large))))
      expect(ranges(tier.calls)).toEqual(["bytes */10", "bytes 0-3/10", "bytes 4-7/10", "bytes 8-9/10"])
    }))

  it.effect("fails when a chunk, not the probe, is refused outright", () =>
    Effect.gen(function*() {
      const tier = remote(
        withHeads((call) =>
          call.headers["content-range"] === "bytes */10"
            ? new Response(null, { status: 308 })
            : new Response(null, { status: 503 })
        ),
        { chunkBytes: 4 }
      )
      const exit = yield* withCrypto(
        Effect.flatMap(tier.store, (store) => store.put(bytes(large))).pipe(Effect.exit)
      )
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
      expect(ranges(tier.calls)).toEqual(["bytes */10", "bytes 0-3/10"])
    }))

  it.effect("fails on any other refusal rather than re-sending the blob", () =>
    Effect.gen(function*() {
      const tier = remote(withHeads(() => new Response(null, { status: 500 })), { chunkBytes: 4 })
      const exit = yield* withCrypto(
        Effect.flatMap(tier.store, (store) => store.put(bytes(large))).pipe(Effect.exit)
      )
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
      expect(ranges(tier.calls)).toEqual(["bytes */10"])
    }))
})

describe("downloads", () => {
  it.effect("GETs /cas/{digest} and verifies the address", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(artifact))
      expect(text(yield* withCrypto(Effect.flatMap(tier.store, (store) => store.get(digest))))).toBe(artifact)
      expect(tier.calls[0]!.method).toBe("GET")
    }))

  it.effect("round-trips a zero-byte artifact", () =>
    Effect.gen(function*() {
      // An empty body is zero bytes, not an absent answer: the digest check is
      // the only arbiter of whether empty content is the requested artifact.
      const empty = sha256(new Uint8Array(0))
      const tier = remote((call) =>
        call.method === "GET" ? new Response(null, { status: 200 }) : new Response(null, { status: 200 })
      )
      const store = yield* tier.store
      expect(yield* withCrypto(store.put(new Uint8Array(0)))).toBe(empty)
      expect((yield* withCrypto(store.get(empty))).byteLength).toBe(0)
    }))

  it.effect("reports a typed miss on 404", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 404 }))
      const exit = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactMissing)._tag).toBe("@smthrs/artifacts/ArtifactMissing")
    }))

  it.effect("refuses content that does not hash to the requested address", () =>
    Effect.gen(function*() {
      // The shared tier is the least trusted store there is: a mis-serving or
      // compromised cache must never be able to substitute content.
      const tier = remote(() => new Response("something else entirely"))
      const exit = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(Effect.exit))
      const failure = errorOf(exit) as ArtifactStore.ArtifactCorruption
      expect(failure._tag).toBe("@smthrs/artifacts/ArtifactCorruption")
      expect(failure.recordedDigest).toBe(digest)
    }))

  it.effect("fails on a non-2xx answer", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 503 }))
      const exit = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
    }))

  it.effect("fails a download that exceeds its deadline instead of waiting forever", () =>
    Effect.gen(function*() {
      // Headers arrive but the body never does. The deadline covers the whole
      // exchange, so the read fails typed instead of parking forever on a tier
      // that stopped answering.
      const tier = remote(
        () => new Response(new ReadableStream({ start() {} })),
        { downloadTimeout: "50 millis" }
      )
      const request = yield* withCrypto(
        Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(
          Effect.exit,
          Effect.forkChild({ startImmediately: true })
        )
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust("50 millis")
      const exit = yield* Fiber.join(request)
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
    }))

  it.effect("refuses a body that exceeds the size bound without buffering it whole", () =>
    Effect.gen(function*() {
      let pulls = 0
      const tier = remote(
        () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                pulls++
                controller.enqueue(new Uint8Array(1024))
              }
            })
          ),
        { maxDownloadBytes: 4096 }
      )
      const exit = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
      // The endless body was abandoned one chunk past the bound, not slurped:
      // the guard runs against the stream, not against a completed buffer.
      expect(pulls).toBeLessThan(64)
    }))

  it.effect("refuses a declared oversize before reading a single body byte", () =>
    Effect.gen(function*() {
      let pulls = 0
      const tier = remote(
        () =>
          new Response(
            // A zero high-water mark keeps the stream from priming its queue at
            // construction, so a pull can only come from an actual body read.
            new ReadableStream(
              {
                pull(controller) {
                  pulls++
                  controller.enqueue(new Uint8Array(8))
                }
              },
              { highWaterMark: 0 }
            ),
            { headers: { "content-length": "1048576" } }
          ),
        { maxDownloadBytes: 1024 }
      )
      const exit = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
      expect(pulls).toBe(0)
    }))

  it.effect("accepts a well-formed Content-Length within the configured bound", () =>
    Effect.gen(function*() {
      const body = bytes(artifact)
      const tier = remote(
        () => new Response(artifact, { headers: { "content-length": String(body.byteLength) } }),
        { maxDownloadBytes: body.byteLength }
      )
      expect(yield* withCrypto(Effect.flatMap(tier.store, (store) => store.get(digest))))
        .toEqual(body)
    }))

  it.effect.each(["not-a-number", "-1", "1.5", "999999999999999999999999"])(
    "refuses malformed Content-Length %s",
    (declared) =>
      Effect.gen(function*() {
        const tier = remote(() => new Response(artifact, { headers: { "content-length": declared } }))
        const exit = yield* withCrypto(
          Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(Effect.exit)
        )
        expect(errorOf(exit)).toMatchObject({ code: "transport_failed" })
      })
  )

  it.effect("treats an empty 2xx body as empty content, refused by the digest check", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 200 }))
      const exit = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(Effect.exit))
      const failure = errorOf(exit) as ArtifactStore.ArtifactCorruption
      expect(failure._tag).toBe("@smthrs/artifacts/ArtifactCorruption")
      expect(failure.measuredDigest).toBe(sha256(bytes("")))
    }))

  it.effect("fails when the response body cannot be read", () =>
    Effect.gen(function*() {
      const tier = remote(() =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("truncated"))
            }
          })
        )
      )
      const exit = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
    }))
})

describe("existence probes", () => {
  it.effect("HEADs /cas/{digest}", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 200 }))
      expect(yield* withCrypto(Effect.flatMap(tier.store, (store) => store.has(digest)))).toBe(true)
      expect(tier.calls[0]!.method).toBe("HEAD")
    }))

  it.effect("answers false on 404", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 404 }))
      expect(yield* withCrypto(Effect.flatMap(tier.store, (store) => store.has(digest)))).toBe(false)
    }))

  it.effect("fails on any other status", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 403 }))
      const exit = yield* withCrypto(Effect.flatMap(tier.store, (store) => store.has(digest)).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
    }))

  it.effect("bounds a probe whose transport never answers", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Promise<Response>(() => {}), { requestTimeout: "50 millis" })
      const running = yield* withCrypto(
        Effect.flatMap(tier.store, (store) => store.has(digest)).pipe(
          Effect.exit,
          Effect.forkChild({ startImmediately: true })
        )
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust("50 millis")
      expect(errorOf(yield* Fiber.join(running))).toMatchObject({ code: "transport_failed" })
    }))
})

describe("the batched probe", () => {
  const other = sha256(bytes("another artifact"))

  it.effect("POSTs /cas/findMissing and returns what the tier reported", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(JSON.stringify({ missing: [other] }), { status: 200 }))
      expect(yield* withCrypto(Effect.flatMap(tier.store, (store) => store.findMissing([digest, other, other]))))
        .toEqual([other])
      expect(tier.calls[0]!.method).toBe("POST")
      expect(tier.calls[0]!.url).toBe("https://cache.example.com/cas/findMissing")
      // Duplicates never reach the wire.
      expect(JSON.parse(tier.calls[0]!.body)).toEqual({ digests: [digest, other] })
    }))

  it.effect("never asks about nothing", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 500 }))
      expect(yield* withCrypto(Effect.flatMap(tier.store, (store) => store.findMissing([])))).toEqual([])
      expect(tier.calls).toEqual([])
    }))

  it.effect("drops digests the caller never asked about", () =>
    Effect.gen(function*() {
      // "The returned set is guaranteed to be a subset of `digests`"
      // (`MissingDigestsFinder`). A server that answered otherwise would make
      // the caller upload bytes it never probed for.
      const tier = remote(() => new Response(JSON.stringify({ missing: [other, "unrequested"] }), { status: 200 }))
      expect(yield* withCrypto(Effect.flatMap(tier.store, (store) => store.findMissing([digest, other]))))
        .toEqual([other])
    }))

  it.effect("deduplicates server answers and restores first-request order", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(JSON.stringify({ missing: [other, other, digest] })))
      expect(yield* withCrypto(Effect.flatMap(tier.store, (store) => store.findMissing([digest, other]))))
        .toEqual([digest, other])
    }))

  it.effect("splits 1,001 unique digests at the protocol's 1,000-entry boundary", () =>
    Effect.gen(function*() {
      const requested = Array.from(
        { length: 1_001 },
        (_, index) => index.toString(16).padStart(64, "0")
      )
      const tier = remote((call) => {
        const parsed = JSON.parse(call.body) as { readonly digests: Array<string> }
        return new Response(JSON.stringify({ missing: parsed.digests }))
      })
      expect(yield* withCrypto(Effect.flatMap(tier.store, (store) => store.findMissing(requested))))
        .toEqual(requested)
      expect(tier.calls.map((call) => (JSON.parse(call.body) as { digests: Array<string> }).digests.length))
        .toEqual([1_000, 1])
    }))

  it.effect("refuses an oversized response before buffering it whole", () =>
    Effect.gen(function*() {
      let pulls = 0
      const tier = remote(
        () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                pulls++
                controller.enqueue(new Uint8Array(16))
              }
            })
          ),
        { maxFindMissingResponseBytes: 32 }
      )
      const exit = yield* withCrypto(
        Effect.flatMap(tier.store, (store) => store.findMissing([digest])).pipe(Effect.exit)
      )
      expect(errorOf(exit)).toMatchObject({ code: "transport_failed" })
      expect(pulls).toBeLessThan(32)
    }))

  it.effect("bounds a stalled response body", () =>
    Effect.gen(function*() {
      const tier = remote(
        () => new Response(new ReadableStream({ start() {} })),
        { requestTimeout: "50 millis" }
      )
      const running = yield* withCrypto(
        Effect.flatMap(tier.store, (store) => store.findMissing([digest])).pipe(
          Effect.exit,
          Effect.forkChild({ startImmediately: true })
        )
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust("50 millis")
      expect(errorOf(yield* Fiber.join(running))).toMatchObject({ code: "transport_failed" })
    }))

  it.effect("fails on a non-2xx answer", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 502 }))
      const exit = yield* withCrypto(
        Effect.flatMap(tier.store, (store) => store.findMissing([digest])).pipe(Effect.exit)
      )
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
    }))

  it.effect("fails on a body that is not JSON", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response("not json at all", { status: 200 }))
      const exit = yield* withCrypto(
        Effect.flatMap(tier.store, (store) => store.findMissing([digest])).pipe(Effect.exit)
      )
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
    }))

  it.effect("fails on JSON that is not a findMissing answer", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(JSON.stringify({ absent: [] }), { status: 200 }))
      const exit = yield* withCrypto(
        Effect.flatMap(tier.store, (store) => store.findMissing([digest])).pipe(Effect.exit)
      )
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
    }))
})

describe("the address guard", () => {
  // A digest reaches a read straight out of a durable row, so it is untrusted
  // input, and here it is interpolated into a URL path. An address carrying a
  // separator or a `..` would point this client at a different resource on the
  // configured endpoint — so it is refused before any request goes out, by the
  // same guard the filesystem tier applies.
  const unusable = ["", "../ac/other-key", "sub/dir", "..", "back\\slash"]
  for (const digest of unusable) {
    it.effect(`refuses ${JSON.stringify(digest)} without a round trip`, () =>
      Effect.gen(function*() {
        const tier = remote(() => new Response(null, { status: 200 }))
        const store = yield* withCrypto(tier.store)
        const refused = (operation: Effect.Effect<unknown, unknown, Crypto.Crypto>) =>
          withCrypto(operation.pipe(Effect.exit)).pipe(
            Effect.map((exit) => (errorOf(exit) as ArtifactStore.ArtifactStoreError).code)
          )
        expect(yield* refused(store.get(digest))).toBe("invalid_digest")
        expect(yield* refused(store.has(digest))).toBe("invalid_digest")
        expect(yield* refused(store.findMissing([digest]))).toBe("invalid_digest")
        expect(tier.calls).toEqual([])
      }))
  }
})

describe("layer", () => {
  it.effect("provides the remote store under the ArtifactStore tag", () =>
    Effect.gen(function*() {
      const stub = stubClient(() => new Response(null, { status: 201 }))
      const published = yield* withCrypto(
        Effect.flatMap(ArtifactStore.ArtifactStore, (store) => store.put(bytes(artifact))).pipe(
          Effect.provide(
            RemoteArtifacts.layer({ endpoint: "https://cache.example.com" }).pipe(Layer.provide(stub.layer))
          )
        )
      )
      expect(published).toBe(digest)
    }))
})

describe("the declared download policy", () => {
  it.effect("defaults to all", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 200 }))
      const store = yield* tier.store
      expect(store.downloadPolicy).toBe("all")
    }))

  it.effect.each(["all", "toplevel", "minimal"] as const)(
    "carries a declared %s",
    (downloadPolicy) =>
      Effect.gen(function*() {
        const tier = remote(() => new Response(null, { status: 200 }), { downloadPolicy })
        const store = yield* tier.store
        expect(store.downloadPolicy).toBe(downloadPolicy)
      })
  )

  it.effect("refuses a policy no seam implements", () =>
    Effect.gen(function*() {
      const tier = remote(() => new Response(null, { status: 200 }), { downloadPolicy: "everything" as never })
      const exit = yield* tier.store.pipe(Effect.exit)
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("invalid_configuration")
      expect(tier.calls).toEqual([])
    }))

  it("exports an immutable closed policy list", () => {
    expect(Object.isFrozen(RemoteArtifacts.downloadPolicies)).toBe(true)
    expect(() => (RemoteArtifacts.downloadPolicies as Array<string>).push("everything")).toThrow()
    expect(RemoteArtifacts.downloadPolicies).toEqual(["all", "toplevel", "minimal"])
  })
})

describe("transport failures", () => {
  it.effect("names the transport reason and errno code, never the request", () =>
    Effect.gen(function*() {
      const client = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              description: "https://user:secret@cache.example.com",
              cause: Object.assign(new TypeError("fetch failed"), {
                cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })
              })
            })
          })
        )
      )
      const store = yield* RemoteArtifacts.make({ endpoint: "https://cache.example.com" }).pipe(
        Effect.provideService(HttpClient.HttpClient, client)
      )
      const failure = errorOf(yield* Effect.exit(store.has(digest))) as ArtifactStore.ArtifactStoreError
      expect(failure.code).toBe("transport_failed")
      expect(failure.message).toMatch(/\(TransportError ENOTFOUND\)$/)
      expect(failure.message).not.toContain("secret")
    }))
})

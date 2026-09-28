/**
 * The dumb-HTTP action-cache protocol: `GET`/`PUT`/`DELETE /ac/{keyDigest}`,
 * mirroring `remote/http/HttpCacheClient.java` in bazelbuild/bazel.
 */
import { describe, expect, it, vi } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { TestClock } from "effect/testing"
import * as Tracer from "effect/Tracer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import * as CacheStore from "../src/CacheStore.ts"
import * as CacheAdmission from "../src/internal/CacheAdmission.ts"
import * as RemoteCacheStore from "../src/RemoteCacheStore.ts"

const entry: CacheStore.CacheEntry = {
  keyDigest: "key-digest",
  result: { ok: true },
  meta: { tier: "sealed" },
  createdAtMs: 7,
  recordedRunId: "run-1",
  recordedEventSeq: 3
}

interface Call {
  readonly signal: AbortSignal
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
}

const stubClient = (responder: (call: Call) => Response) => {
  const calls: Array<Call> = []
  const responses: Array<HttpClientResponse.HttpClientResponse> = []
  const client = HttpClient.make((request, url, signal) =>
    Effect.sync(() => {
      const call: Call = {
        signal,
        method: request.method,
        url: url.toString(),
        headers: { ...request.headers } as Record<string, string>,
        body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
      }
      calls.push(call)
      const response = HttpClientResponse.fromWeb(request, responder(call))
      responses.push(response)
      return response
    })
  )
  return { calls, responses, layer: Layer.succeed(HttpClient.HttpClient)(client) }
}

const tierOf = (responder: (call: Call) => Response, options?: RemoteCacheStore.Options) => {
  const stub = stubClient(responder)
  return {
    calls: stub.calls,
    responses: stub.responses,
    store: Effect.provide(
      RemoteCacheStore.make(options ?? { endpoint: "https://cache.example.com/" }),
      stub.layer
    )
  }
}

const errorOf = (exit: Exit.Exit<unknown, unknown>): CacheStore.CacheStoreError => {
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  return (reason as { readonly error: CacheStore.CacheStoreError }).error
}

describe("lookups", () => {
  it.effect("GETs /ac/{keyDigest} and decodes the entry", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(JSON.stringify(entry), { status: 200 }))
      const found = yield* (Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)))
      expect(Option.getOrUndefined(found)).toEqual(entry)
      expect(tier.calls[0]!.method).toBe("GET")
      expect(tier.calls[0]!.url).toBe("https://cache.example.com/ac/key-digest")
    }))

  it.effect("sends the configured credential headers", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(JSON.stringify(entry), { status: 200 }), {
        endpoint: "https://cache.example.com",
        headers: { authorization: "Bearer secret" }
      })
      yield* (Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)))
      expect(tier.calls[0]!.headers["authorization"]).toBe("Bearer secret")
    }))

  it.effect("snapshots credential headers when the store is constructed", () =>
    Effect.gen(function*() {
      const headers = { authorization: "Bearer original" }
      const tier = tierOf(() => new Response(JSON.stringify(entry), { status: 200 }), {
        endpoint: "https://cache.example.com",
        headers
      })
      const store = yield* tier.store
      headers.authorization = "Bearer changed"
      yield* store.get(entry.keyDigest)
      expect(tier.calls[0]!.headers["authorization"]).toBe("Bearer original")
    }))

  it.effect("redacts configured credential headers only within cache HTTP spans", () =>
    Effect.gen(function*() {
      const spans: Array<Tracer.NativeSpan> = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        }
      })
      const requests: Array<HttpClientRequest.HttpClientRequest> = []
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request)
          return HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: request.method === "PUT" ? 201 : 404 })
          )
        })
      ).pipe(HttpClient.mapRequest(HttpClientRequest.setHeaders({
        authorization: "Bearer default-secret",
        "x-tenant-secret": "caller-secret",
        "x-public": "public-value"
      })))
      const store = yield* RemoteCacheStore.make({
        endpoint: "https://cache.example.com",
        headers: { "X-Cache-Token": "synthetic-cache-secret", "x-cache-key": "second-secret" }
      }).pipe(Effect.provideService(HttpClient.HttpClient, client))
      const names = yield* Headers.CurrentRedactedNames
      yield* Effect.gen(function*() {
        yield* store.get(entry.keyDigest)
        yield* store.put(entry)
        yield* store.evict(entry.keyDigest)
        yield* client.get("https://cache.example.com/control", {
          headers: { "x-cache-token": "public-control" }
        })
      }).pipe(
        Effect.provideService(Headers.CurrentRedactedNames, [...names, /^x-tenant-/]),
        Effect.provideService(Tracer.Tracer, tracer)
      )
      const clientSpans = spans.filter((span) => span.kind === "client")
      expect(clientSpans).toHaveLength(4)
      expect(requests.map((request) => request.method)).toEqual(["GET", "PUT", "DELETE", "GET"])
      for (let index = 0; index < 3; index++) {
        expect(requests[index]!.headers["x-cache-token"]).toBe("synthetic-cache-secret")
        expect(requests[index]!.headers["x-cache-key"]).toBe("second-secret")
        expect(clientSpans[index]!.attributes.get("http.request.header.x-cache-token")).toBe("<redacted>")
        expect(clientSpans[index]!.attributes.get("http.request.header.x-cache-key")).toBe("<redacted>")
      }
      for (const span of clientSpans) {
        expect(span.attributes.get("http.request.header.authorization")).toBe("<redacted>")
        expect(span.attributes.get("http.request.header.x-tenant-secret")).toBe("<redacted>")
        expect(span.attributes.get("http.request.header.x-public")).toBe("public-value")
      }
      expect(clientSpans[3]!.attributes.get("http.request.header.x-cache-token")).toBe("public-control")
      expect(yield* Headers.CurrentRedactedNames).toEqual(names)
    }))

  it.effect("rejects accessor-backed headers without invoking them", () =>
    Effect.gen(function*() {
      let reads = 0
      const headers = Object.defineProperty({}, "authorization", {
        enumerable: true,
        get: () => {
          reads++
          return "Bearer secret"
        }
      }) as Record<string, string>
      const tier = tierOf(() => new Response(JSON.stringify(entry), { status: 200 }), {
        endpoint: "https://cache.example.com",
        headers
      })
      const exit = yield* Effect.exit(tier.store)
      expect(errorOf(exit).code).toBe("invalid_cache")
      expect(reads).toBe(0)
      expect(tier.calls).toEqual([])
    }))

  it.effect("carries the recorded provenance fence as query parameters", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(JSON.stringify(entry), { status: 200 }))
      yield* (
        Effect.flatMap(
          tier.store,
          (store) => store.get(entry.keyDigest, { recordedBy: { runId: "run-1", eventSeq: 3 } })
        )
      )
      expect(tier.calls[0]!.url).toContain("recordedRunId=run-1")
      expect(tier.calls[0]!.url).toContain("recordedEventSeq=3")
    }))

  it.effect("sends the first recordedBy accessor value as lookup provenance", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(JSON.stringify(entry), { status: 200 }))
      let reads = 0
      const options = Object.defineProperty({}, "recordedBy", {
        enumerable: true,
        get: () => {
          reads++
          return reads === 1
            ? { runId: "validated-run", eventSeq: 11 }
            : { runId: "later-run", eventSeq: 12 }
        }
      }) as CacheStore.GetOptions
      yield* Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest, options))

      const url = new URL(tier.calls[0]!.url)
      expect(url.searchParams.get("recordedRunId")).toBe("validated-run")
      expect(url.searchParams.get("recordedEventSeq")).toBe("11")
      expect(reads).toBe(1)
    }))

  it.effect("reports a miss on 404", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 404 }))
      const found = yield* (Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)))
      expect(Option.isNone(found)).toBe(true)
    }))

  it.effect("refuses an empty key without a round trip", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 200 }))
      const exit = yield* (Effect.flatMap(tier.store, (store) => store.get("")).pipe(Effect.exit))
      expect(errorOf(exit).code).toBe("invalid_cache")
      expect(tier.calls).toEqual([])
    }))

  it.effect("refuses every path-escaping or ill-formed key before HTTP", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 204 }))
      const store = yield* tier.store
      const malformed = [
        ".",
        "..",
        "a/b",
        "a%2fb",
        "line\nbreak",
        "\ud800",
        "x".repeat(CacheStore.maximumKeyDigestLength + 1)
      ]
      const exits = yield* Effect.forEach(malformed, (key) =>
        Effect.all([store.get(key), store.evict(key)]).pipe(Effect.exit))
      expect(exits.every(Exit.isFailure)).toBe(true)
      expect(tier.calls).toEqual([])
    }))

  it.effect("enforces maxAgeMs at the exact remote boundary", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(JSON.stringify({ ...entry, createdAtMs: 0 }), { status: 200 }))
      const store = yield* tier.store
      yield* TestClock.adjust("1 second")
      expect(Option.isSome(yield* store.get(entry.keyDigest, { maxAgeMs: 1_000 }))).toBe(true)
      yield* TestClock.adjust("1 millis")
      expect(Option.isNone(yield* store.get(entry.keyDigest, { maxAgeMs: 1_000 }))).toBe(true)
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("rejects every invalid remote age before even a 404 request", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 404 }))
      const store = yield* tier.store
      const invalid = [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]
      const exits = yield* Effect.forEach(invalid, (maxAgeMs) =>
        store.get(entry.keyDigest, { maxAgeMs }).pipe(Effect.exit))
      expect(exits.every(Exit.isFailure)).toBe(true)
      expect(tier.calls).toEqual([])
    }))

  it.effect("fails on a non-2xx answer", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 500 }))
      const exit = yield* (
        Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)).pipe(Effect.exit)
      )
      expect(errorOf(exit).code).toBe("persistence_failed")
    }))

  it.effect("fails when the transport refuses", () =>
    Effect.gen(function*() {
      const client = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: new Error("ECONNREFUSED") })
          })
        )
      )
      const store = Effect.provide(
        RemoteCacheStore.make({ endpoint: "https://cache.example.com" }),
        Layer.succeed(HttpClient.HttpClient)(client)
      )
      const exit = yield* (
        Effect.flatMap(store, (tier) => tier.get(entry.keyDigest)).pipe(Effect.exit)
      )
      expect(errorOf(exit).code).toBe("persistence_failed")
    }))

  it.effect("fails on a body that is not JSON", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response("not json", { status: 200 }))
      const exit = yield* (
        Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)).pipe(Effect.exit)
      )
      expect(errorOf(exit).code).toBe("persistence_failed")
    }))

  it.effect("fails on JSON that is not a cache entry", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(JSON.stringify({ nope: 1 }), { status: 200 }))
      const exit = yield* (
        Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)).pipe(Effect.exit)
      )
      expect(errorOf(exit).code).toBe("decode_failed")
    }))

  it.effect.each([true, false])(
    "accepts the exact UTF-8 byte bound (declared: %s)",
    (declared) =>
      Effect.gen(function*() {
        const candidate = { ...entry, result: { text: "café 😀" } }
        const body = JSON.stringify(candidate)
        const bytes = new TextEncoder().encode(body)
        expect(bytes.byteLength).toBeGreaterThan(body.length)
        const tier = tierOf(
          () => new Response(bytes, { headers: declared ? { "content-length": String(bytes.byteLength) } : {} }),
          { endpoint: "https://cache.example.com", maxResponseBytes: bytes.byteLength }
        )
        const found = yield* Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest))
        expect(Option.getOrThrow(found)).toEqual(candidate)
        expect(tier.calls[0]!.signal.aborted).toBe(true)
      })
  )

  it.effect.each([true, false])(
    "rejects one byte over the UTF-8 byte bound (declared: %s)",
    (declared) =>
      Effect.gen(function*() {
        const bytes = new TextEncoder().encode(JSON.stringify({ ...entry, result: { text: "café 😀" } }))
        const bound = bytes.byteLength - 1
        const tier = tierOf(
          () => new Response(bytes, { headers: declared ? { "content-length": String(bytes.byteLength) } : {} }),
          { endpoint: "https://cache.example.com", maxResponseBytes: bound }
        )
        const exit = yield* Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)).pipe(Effect.exit)
        expect(errorOf(exit).code).toBe("persistence_failed")
        expect(errorOf(exit).message).toBe(
          `the remote cache tier returned ${bytes.byteLength} bytes, past the ${bound}-byte bound`
        )
      })
  )

  it.effect("cancels a multi-chunk body as soon as the byte bound is crossed", () =>
    Effect.gen(function*() {
      const bytes = new TextEncoder().encode(JSON.stringify({ ...entry, result: "café 😀" }))
      // The unread suffix is valid JSON: consuming it would succeed without the guard.
      const chunks = [bytes.slice(0, 10), bytes.slice(10, 20), bytes.slice(20)]
      let pulls = 0
      let cancelled = false
      const tier = tierOf(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                const chunk = chunks[pulls++]
                if (chunk === undefined) controller.close()
                else controller.enqueue(chunk)
              },
              cancel() {
                cancelled = true
              }
            }, { highWaterMark: 0 })
          ),
        { endpoint: "https://cache.example.com", maxResponseBytes: 15 }
      )
      const exit = yield* Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)).pipe(Effect.exit)
      expect(errorOf(exit).code).toBe("persistence_failed")
      expect(errorOf(exit).message).toBe("the remote cache tier returned 20 bytes, past the 15-byte bound")
      expect(pulls).toBe(2)
      expect(cancelled).toBe(true)
      expect(tier.calls[0]!.signal.aborted).toBe(true)
    }))

  it.effect("rejects invalid UTF-8 and a failing response stream", () =>
    Effect.gen(function*() {
      const invalidUtf8 = tierOf(
        () => new Response(new Uint8Array([0xff]), { status: 200 }),
        { endpoint: "https://cache.example.com", maxResponseBytes: 10 }
      )
      const failedStream = tierOf(
        () =>
          new Response(new ReadableStream({ start: (controller) => controller.error(new Error("stream")) }), {
            status: 200
          }),
        { endpoint: "https://cache.example.com", maxResponseBytes: 10 }
      )
      for (const tier of [invalidUtf8, failedStream]) {
        const exit = yield* Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)).pipe(Effect.exit)
        expect(errorOf(exit).code).toBe("persistence_failed")
      }
    }))

  it.effect("times out both a stalled request and a stalled response body", () => {
    const stalledRequest = HttpClient.make(() => Effect.never)
    const stalledBody = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(
        request,
        new Response(new ReadableStream({ start: () => undefined }), { status: 200 })
      ))
    )
    const runTimeout = (client: HttpClient.HttpClient) =>
      Effect.gen(function*() {
        const store = yield* RemoteCacheStore.make({
          endpoint: "https://cache.example.com",
          requestTimeout: "1 millis"
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient)(client)))
        const fiber = yield* store.get(entry.keyDigest).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust("2 millis")
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(TestClock.layer()))

    return Effect.gen(function*() {
      for (const client of [stalledRequest, stalledBody]) {
        const exit = yield* runTimeout(client)
        expect(errorOf(exit).code).toBe("persistence_failed")
      }
    })
  })

  it.effect("spends one deadline across the request and the response body", () =>
    Effect.gen(function*() {
      // Headers arrive after six tenths of the budget and the body never
      // completes. The deadline is the operation's, so the caller is refused at
      // the value it configured rather than at nearly twice it.
      const client = HttpClient.make((request) =>
        Effect.as(
          Effect.sleep("6 millis"),
          HttpClientResponse.fromWeb(
            request,
            new Response(new ReadableStream({ start: () => undefined }), { status: 200 })
          )
        )
      )
      const store = yield* RemoteCacheStore.make({
        endpoint: "https://cache.example.com",
        requestTimeout: "10 millis"
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient)(client)))
      const fiber = yield* store.get(entry.keyDigest).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* TestClock.adjust("10 millis")
      const exit = fiber.pollUnsafe()
      expect(exit === undefined ? "still running" : errorOf(exit).code).toBe("persistence_failed")
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("accepts an entry recorded under different provenance as the tier's head", () =>
    Effect.gen(function*() {
      // A conforming tier answers a fenced lookup with its head when it holds
      // no row for that provenance, exactly as the SQL tier does, and nothing
      // on the wire separates that from a tier that ignored the parameters.
      const head = { ...entry, recordedRunId: "run-9", recordedEventSeq: 41 }
      const tier = tierOf(() => new Response(JSON.stringify(head), { status: 200 }))
      const found = yield* Effect.flatMap(
        tier.store,
        (store) => store.get(entry.keyDigest, { recordedBy: { runId: "run-1", eventSeq: 3 } })
      )
      expect(Option.getOrThrow(found)).toEqual(head)
    }))

  it.effect("refuses an entry recorded under a different key", () =>
    Effect.gen(function*() {
      // A tier that answers a lookup with someone else's entry would hand the
      // caller a result under the wrong key — the one thing content addressing
      // must never allow.
      const tier = tierOf(() => new Response(JSON.stringify({ ...entry, keyDigest: "other" }), { status: 200 }))
      const exit = yield* (
        Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)).pipe(Effect.exit)
      )
      expect(errorOf(exit).code).toBe("decode_failed")
      expect(errorOf(exit).message).toContain("other")
    }))
})

describe("response cleanup", () => {
  it.effect.each(
    [
      ["get", 404],
      ["get", 500],
      ["put", 201],
      ["put", 200],
      ["put", 409],
      ["put", 500],
      ["evict", 200],
      ["evict", 404],
      ["evict", 500]
    ] as const
  )("aborts unread %s HTTP %s responses before returning", ([method, status]) =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(new ReadableStream(), { status }))
      const store = yield* tier.store
      const operation: Effect.Effect<unknown, CacheStore.CacheStoreError> = method === "put"
        ? store.put(entry)
        : store[method](entry.keyDigest)
      const exit = yield* Effect.exit(operation)
      expect(exit._tag).toBe(status === 500 ? "Failure" : "Success")
      expect(tier.calls[0]!.signal.aborted).toBe(true)
      // Keep the underlying response alive so GC cannot supply the cleanup.
      expect(tier.responses).toHaveLength(1)
    }))

  it.effect.each(["11", "unknown", "9007199254740992"])(
    "aborts a response with rejected Content-Length %s before returning",
    (length) =>
      Effect.gen(function*() {
        let pulls = 0
        const tier = tierOf(
          () =>
            new Response(
              new ReadableStream({
                pull: () => {
                  pulls++
                }
              }, { highWaterMark: 0 }),
              {
                headers: { "content-length": length }
              }
            ),
          { endpoint: "https://cache.example.com", maxResponseBytes: 10 }
        )
        const exit = yield* Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)).pipe(Effect.exit)
        expect(errorOf(exit).code).toBe("persistence_failed")
        expect(tier.calls[0]!.signal.aborted).toBe(true)
        expect(pulls).toBe(0)
        expect(tier.responses).toHaveLength(1)
      })
  )

  it.effect("cancels and aborts a stalled body at the operation deadline", () =>
    Effect.gen(function*() {
      let cancelled = false
      const tier = tierOf(
        () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true
              }
            })
          ),
        { endpoint: "https://cache.example.com", requestTimeout: "10 millis" }
      )
      const store = yield* tier.store
      const fiber = yield* store.get(entry.keyDigest).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* TestClock.adjust("10 millis")
      const exit = yield* Fiber.await(fiber)
      expect(errorOf(exit).message).toBe("the remote cache tier did not finish within its configured deadline")
      expect(cancelled).toBe(true)
      expect(tier.calls[0]!.signal.aborted).toBe(true)
      expect(tier.responses).toHaveLength(1)
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("cancels and aborts a response when the caller interrupts", () =>
    Effect.gen(function*() {
      let cancelled = false
      const tier = tierOf(() =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
            }
          })
        )
      )
      const store = yield* tier.store
      const fiber = yield* store.get(entry.keyDigest).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      expect(cancelled).toBe(true)
      expect(tier.calls[0]!.signal.aborted).toBe(true)
      expect(tier.responses).toHaveLength(1)
    }))
})

describe("publications", () => {
  it.effect("PUTs the entry and reports Inserted on 201", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 201 }))
      expect(yield* (Effect.flatMap(tier.store, (store) => store.put(entry))))
        .toEqual({ _tag: "Inserted" })
      expect(tier.calls[0]!.method).toBe("PUT")
      expect(JSON.parse(tier.calls[0]!.body)).toEqual(entry)
      expect(tier.calls[0]!.body).toBe(
        "{\"createdAtMs\":7,\"keyDigest\":\"key-digest\",\"meta\":{\"tier\":\"sealed\"},\"recordedEventSeq\":3,\"recordedRunId\":\"run-1\",\"result\":{\"ok\":true}}"
      )
    }))

  it.effect("reports ExistingSame on any other 2xx", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 200 }))
      expect(yield* (Effect.flatMap(tier.store, (store) => store.put(entry))))
        .toEqual({ _tag: "ExistingSame" })
    }))

  it.effect("reports Conflict on 409", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 409 }))
      expect(yield* (Effect.flatMap(tier.store, (store) => store.put(entry))))
        .toEqual({ _tag: "Conflict" })
    }))

  it.effect("fails on any other status", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 500 }))
      const exit = yield* (Effect.flatMap(tier.store, (store) => store.put(entry)).pipe(Effect.exit))
      expect(errorOf(exit).code).toBe("persistence_failed")
    }))

  it.effect("refuses an entry that violates the persistence contract", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 201 }))
      const exit = yield* (
        Effect.flatMap(tier.store, (store) => store.put({ ...entry, createdAtMs: -1 })).pipe(Effect.exit)
      )
      expect(errorOf(exit).code).toBe("invalid_cache")
      expect(tier.calls).toEqual([])
    }))

  it.effect("refuses a result or meta that has no JSON form, without a request or a defect", () =>
    Effect.gen(function*() {
      const cyclic: Record<string, unknown> = { name: "cycle" }
      cyclic["self"] = cyclic
      const malformed: ReadonlyArray<CacheStore.CacheEntry> = [
        { ...entry, result: undefined },
        { ...entry, result: BigInt(1) },
        { ...entry, result: cyclic },
        { ...entry, meta: undefined },
        { ...entry, meta: BigInt(1) },
        { ...entry, meta: cyclic }
      ]
      const tier = tierOf(() => new Response(null, { status: 201 }))
      const exits = yield* (
        Effect.forEach(
          malformed,
          (candidate) => Effect.flatMap(tier.store, (store) => store.put(candidate)).pipe(Effect.exit)
        )
      )

      // `CacheStore.put` already holds this line; the shared tier is the same
      // poisoning boundary and must not differ. A defect (`Die`) is the specific
      // outcome being ruled out: it escapes the typed error channel entirely.
      expect(exits.map((exit) => (Exit.isFailure(exit) ? exit.cause.reasons[0]!._tag : "Success"))).toEqual(
        malformed.map(() => "Fail")
      )
      expect(exits.map((exit) => errorOf(exit).code)).toEqual(malformed.map(() => "invalid_cache"))
      expect(tier.calls).toEqual([])
    }))

  it.effect("refuses an encoded entry larger than the remote wire bound", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 201 }))
      const oversized = {
        ...entry,
        result: "x".repeat(CacheStore.maximumJsonBytes - 2)
      }
      const exit = yield* Effect.flatMap(tier.store, (store) => store.put(oversized)).pipe(Effect.exit)
      expect(errorOf(exit).code).toBe("invalid_cache")
      expect(tier.calls).toEqual([])
    }))

  it.effect("PUTs back the entry a lookup returned at the combined node boundary", () =>
    Effect.gen(function*() {
      // Each field sits exactly at its own 100,000-node budget (the array
      // root plus 99,999 members), so the whole entry carries 200,005 nodes:
      // past the per-field budget, exactly at the envelope-aware allowance.
      const wide: CacheStore.CacheEntry = {
        ...entry,
        result: Array.from({ length: 99_999 }, () => 0),
        meta: Array.from({ length: 99_999 }, () => 0)
      }
      const tier = tierOf((call) =>
        call.method === "GET"
          ? new Response(JSON.stringify(wide), { status: 200 })
          : new Response(null, { status: 201 })
      )
      const store = yield* tier.store
      const found = yield* store.get(wide.keyDigest)
      expect(Option.getOrUndefined(found)).toEqual(wide)
      expect(yield* store.put(Option.getOrThrow(found))).toEqual({ _tag: "Inserted" })
      expect(JSON.parse(tier.calls[1]!.body)).toEqual(wide)
    }))

  it.effect("PUTs back the entry a lookup returned at the envelope depth boundary", () =>
    Effect.gen(function*() {
      // A field nested to its own depth budget of 128 sits one level deeper
      // inside the entry envelope, at 129.
      let nested: CacheStore.CacheEntry["result"] = 0
      for (let index = 0; index < 128; index++) nested = [nested]
      const deep: CacheStore.CacheEntry = { ...entry, result: nested, meta: nested }
      const tier = tierOf((call) =>
        call.method === "GET"
          ? new Response(JSON.stringify(deep), { status: 200 })
          : new Response(null, { status: 201 })
      )
      const store = yield* tier.store
      const found = yield* store.get(deep.keyDigest)
      expect(Option.getOrUndefined(found)).toEqual(deep)
      expect(yield* store.put(Option.getOrThrow(found))).toEqual({ _tag: "Inserted" })
      expect(JSON.parse(tier.calls[1]!.body)).toEqual(deep)
    }))

  it.effect("still refuses a field past its own node budget, without a request", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 201 }))
      const over = {
        ...entry,
        result: Array.from({ length: 100_000 }, () => 0)
      }
      const exit = yield* Effect.flatMap(tier.store, (store) => store.put(over)).pipe(Effect.exit)
      expect(errorOf(exit).code).toBe("invalid_cache")
      expect(tier.calls).toEqual([])
    }))

  it.effect("canonicalizes each field exactly once: the wire body is the single whole-entry encoding", () =>
    Effect.gen(function*() {
      // `snapshotEntry` has already admitted and frozen `result` and `meta`
      // under the per-field policy, so the only encoding a publication needs
      // is the whole-entry one whose bytes go on the wire. Any extra per-field
      // encoding is repeated work whose string is discarded, measured at
      // 10,000 records as most of the publication's CPU time. The spies sit on
      // the admission module, which is where the tier takes its encoders from.
      const fieldEncodings = vi.spyOn(CacheAdmission, "encodeCanonical")
      const entryEncodings = vi.spyOn(CacheAdmission, "encodeEntryCanonical")
      try {
        const tier = tierOf(() => new Response(null, { status: 201 }))
        expect(yield* Effect.flatMap(tier.store, (store) => store.put(entry))).toEqual({ _tag: "Inserted" })
        expect(fieldEncodings).not.toHaveBeenCalled()
        expect(entryEncodings).toHaveBeenCalledTimes(1)
        const encoding = entryEncodings.mock.results[0]!.value as Effect.Effect<string, CacheStore.CacheStoreError>
        expect(tier.calls[0]!.body).toBe(yield* encoding)
      } finally {
        fieldEncodings.mockRestore()
        entryEncodings.mockRestore()
      }
    }))
})

describe("configuration", () => {
  const rejects = (options: RemoteCacheStore.Options) =>
    Effect.gen(function*() {
      const stub = stubClient(() => new Response(null))
      const exit = yield* Effect.exit(
        RemoteCacheStore.make(options).pipe(Effect.provide(stub.layer))
      )
      expect(errorOf(exit).code).toBe("invalid_cache")
      expect(stub.calls).toEqual([])
    })

  it.effect.each([
    null,
    {},
    { endpoint: 1 },
    { endpoint: "not a url" },
    { endpoint: "http://cache.example.com" },
    { endpoint: "ftp://cache.example.com" },
    { endpoint: "https://user@cache.example.com" },
    { endpoint: "https://cache.example.com?q=1" },
    { endpoint: "https://cache.example.com#fragment" },
    { endpoint: " https://cache.example.com" },
    { endpoint: `https://cache.example.com/${"x".repeat(16 * 1024)}` },
    { endpoint: "https://cache.example.com/\ud800" },
    { endpoint: "https://cache.example.com/\udc00" },
    { endpoint: "https://cache.example.com", unknown: true },
    { endpoint: "https://cache.example.com", requestTimeout: "0 millis" },
    { endpoint: "https://cache.example.com", requestTimeout: Symbol("bad") },
    {
      endpoint: "https://cache.example.com",
      requestTimeout: new Proxy({}, {
        get: () => {
          throw new Error("hostile")
        }
      })
    },
    { endpoint: "https://cache.example.com", maxResponseBytes: 0 },
    { endpoint: "https://cache.example.com", maxResponseBytes: 1.5 },
    { endpoint: "https://cache.example.com", maxResponseBytes: RemoteCacheStore.maximumEntryBytes + 1 },
    { endpoint: "https://cache.example.com", headers: null },
    { endpoint: "https://cache.example.com", headers: new Date() },
    { endpoint: "https://cache.example.com", headers: { "bad header": "value" } },
    { endpoint: "https://cache.example.com", headers: { authorization: "line\nbreak" } },
    { endpoint: "https://cache.example.com", headers: { authorization: 1 } }
  ] as ReadonlyArray<unknown>)(
    "rejects invalid options %# before I/O",
    (options) => rejects(options as RemoteCacheStore.Options)
  )

  it.effect("rejects symbol and accessor option fields", () =>
    Effect.gen(function*() {
      const symbol = { endpoint: "https://cache.example.com", [Symbol("x")]: true }
      let reads = 0
      const accessor = Object.defineProperty({}, "endpoint", {
        enumerable: true,
        get: () => {
          reads++
          return "https://cache.example.com"
        }
      })
      yield* rejects(symbol as RemoteCacheStore.Options)
      yield* rejects(accessor as RemoteCacheStore.Options)
      expect(reads).toBe(0)
    }))

  it.effect("rejects symbol-bearing header records", () =>
    Effect.gen(function*() {
      const headers = Object.defineProperty({}, Symbol("authorization"), {
        value: "Bearer secret",
        enumerable: true
      })
      yield* rejects({ endpoint: "https://cache.example.com", headers } as RemoteCacheStore.Options)
    }))

  it.effect("accepts HTTPS and loopback HTTP roots with path prefixes", () =>
    Effect.gen(function*() {
      for (
        const endpoint of [
          "https://cache.example.com/base/",
          "https://cache.example.com/base/😀",
          // An empty interior segment is a path a server may route on, and
          // `Options.endpoint` promises to ignore a trailing slash and nothing
          // else, so the configured path reaches the wire as written.
          "https://cache.example.com/tenant//namespace",
          "http://127.0.0.1:1234/base",
          "http://api.localhost:1234/base",
          "http://[::1]:1234/base"
        ]
      ) {
        const tier = tierOf(() => new Response(null, { status: 404 }), { endpoint })
        const store = yield* tier.store
        yield* store.get(entry.keyDigest)
        const root = new URL(endpoint).pathname.replace(/\/+$/, "")
        expect(new URL(tier.calls[0]!.url).pathname).toBe(`${root}/ac/key-digest`)
      }
    }))
})

describe("evictions", () => {
  it.effect("DELETEs /ac/{keyDigest}", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 204 }))
      expect(yield* (Effect.flatMap(tier.store, (store) => store.evict(entry.keyDigest)))).toBe(true)
      expect(tier.calls[0]!.method).toBe("DELETE")
      expect(tier.calls[0]!.url).toBe("https://cache.example.com/ac/key-digest")
    }))

  it.effect("carries the provenance fence as query parameters", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 200 }))
      yield* (
        Effect.flatMap(
          tier.store,
          (store) => store.evict(entry.keyDigest, { ifRecordedBy: { runId: "run-1", eventSeq: 3 } })
        )
      )
      expect(tier.calls[0]!.url).toContain("recordedRunId=run-1")
      expect(tier.calls[0]!.url).toContain("recordedEventSeq=3")
    }))

  it.effect("never rereads an accessor-backed eviction fence as unfenced", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 200 }))
      let reads = 0
      const options = Object.defineProperty({}, "ifRecordedBy", {
        enumerable: true,
        get: () => {
          reads++
          return reads === 1 ? { runId: "validated-run", eventSeq: 11 } : undefined
        }
      }) as CacheStore.EvictOptions
      yield* Effect.flatMap(tier.store, (store) => store.evict(entry.keyDigest, options))

      const url = new URL(tier.calls[0]!.url)
      expect(url.searchParams.get("recordedRunId")).toBe("validated-run")
      expect(url.searchParams.get("recordedEventSeq")).toBe("11")
      expect(reads).toBe(1)
    }))

  it.effect("reports false on 404", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 404 }))
      expect(yield* (Effect.flatMap(tier.store, (store) => store.evict(entry.keyDigest)))).toBe(false)
    }))

  it.effect("fails on any other status", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 500 }))
      const exit = yield* (
        Effect.flatMap(tier.store, (store) => store.evict(entry.keyDigest)).pipe(Effect.exit)
      )
      expect(errorOf(exit).code).toBe("persistence_failed")
    }))

  it.effect("refuses an empty key without issuing a DELETE to the /ac/ root", () =>
    Effect.gen(function*() {
      // `get` already refuses an empty key without a round trip; `evict` is the
      // more dangerous half, because a malformed key targets a collection-like
      // endpoint with a destructive verb.
      const tier = tierOf(() => new Response(null, { status: 204 }))
      const exit = yield* (
        Effect.flatMap(tier.store, (store) => store.evict("")).pipe(Effect.exit)
      )
      // The request log is the load-bearing assertion: a `DELETE` to
      // `https://cache.example.com/ac/`, the collection root, is the outcome
      // being ruled out.
      expect(tier.calls).toEqual([])
      expect(Exit.isFailure(exit)).toBe(true)
      expect(errorOf(exit).code).toBe("invalid_cache")
    }))

  it.effect("refuses a malformed provenance fence without issuing a DELETE", () =>
    Effect.gen(function*() {
      // The fence rides to the server as query parameters, so a fence the SQL
      // tier would reject must not become a request either — the two tiers
      // implement one contract.
      const tier = tierOf(() => new Response(null, { status: 204 }))
      const exit = yield* (
        Effect.flatMap(
          tier.store,
          (store) => store.evict(entry.keyDigest, { ifRecordedBy: { runId: "", eventSeq: -1 } })
        ).pipe(Effect.exit)
      )
      expect(tier.calls).toEqual([])
      expect(errorOf(exit).code).toBe("invalid_cache")
    }))
})

describe("retention", () => {
  it.effect("never sweeps the shared tier and issues no request", () =>
    Effect.gen(function*() {
      // Retention on the shared tier belongs to the server: a client that
      // deleted rows there would drop entries other machines still replay
      // from. The sweep therefore reports nothing removed rather than
      // reaching across.
      const tier = tierOf(() => new Response(null, { status: 204 }))
      const swept = yield* Effect.flatMap(tier.store, (store) => store.sweepExpired(1000))
      expect(swept).toBe(0)
      expect(tier.calls).toEqual([])
    }))

  it.effect("still reports a bound no row could satisfy", () =>
    Effect.gen(function*() {
      const tier = tierOf(() => new Response(null, { status: 204 }))
      const exit = yield* Effect.exit(Effect.flatMap(tier.store, (store) => store.sweepExpired(-1)))
      expect(errorOf(exit).code).toBe("invalid_cache")
    }))
})

describe("layer", () => {
  it.effect("provides the remote store under the CacheStore tag", () =>
    Effect.gen(function*() {
      const stub = stubClient(() => new Response(null, { status: 404 }))
      const found = yield* (
        Effect.flatMap(CacheStore.CacheStore, (store) => store.get(entry.keyDigest)).pipe(
          Effect.provide(
            RemoteCacheStore.layer({ endpoint: "https://cache.example.com" }).pipe(Layer.provide(stub.layer))
          )
        )
      )
      expect(Option.isNone(found)).toBe(true)
    }))
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
                cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
              })
            })
          })
        )
      )
      const store = yield* RemoteCacheStore.make({ endpoint: "https://cache.example.com" }).pipe(
        Effect.provideService(HttpClient.HttpClient, client)
      )
      const failure = errorOf(yield* Effect.exit(store.get(entry.keyDigest)))
      expect(failure.message).toBe("the remote cache tier refused a lookup (TransportError ECONNREFUSED)")
      expect(failure.message).not.toContain("secret")
    }))
})

describe("redirects", () => {
  // A hostile or compromised tier answers 307 to another origin. Fetch strips
  // only `authorization` on a cross-origin redirect, so a custom credential
  // header would follow the redirect to the attacker's origin.
  const listen = (handler: (request: IncomingMessage, response: ServerResponse) => void) =>
    Effect.acquireRelease(
      Effect.callback<Server>((resume) => {
        const server = createServer(handler)
        server.listen(0, "127.0.0.1", () => {
          resume(Effect.succeed(server))
        })
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void))
        })
    ).pipe(Effect.map((server) => ({ server, port: (server.address() as AddressInfo).port })))

  it.effect("never follows a redirect, so credential headers never reach another origin", () =>
    Effect.scoped(Effect.gen(function*() {
      const stolen: Array<string | undefined> = []
      const thief = yield* listen((request, response) => {
        stolen.push(request.headers["x-api-key"] as string | undefined)
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify(entry))
      })
      const tier = yield* listen((_request, response) => {
        response.writeHead(307, { location: `http://127.0.0.1:${thief.port}/ac/${entry.keyDigest}` })
        response.end()
      })
      const store = yield* RemoteCacheStore.make({
        endpoint: `http://127.0.0.1:${tier.port}`,
        headers: { "x-api-key": "cache-secret" }
      }).pipe(Effect.provide(FetchHttpClient.layer))
      const lookup = yield* Effect.exit(store.get(entry.keyDigest))
      const publication = yield* Effect.exit(store.put(entry))
      const eviction = yield* Effect.exit(store.evict(entry.keyDigest))
      expect(stolen).toEqual([])
      for (const exit of [lookup, publication, eviction]) {
        expect(errorOf(exit).code).toBe("persistence_failed")
        expect(errorOf(exit).message).toContain("HTTP 307")
      }
    })))

  it.effect("keeps the caller's other fetch options while refusing redirects", () =>
    Effect.gen(function*() {
      const seen: Array<RequestInit | undefined> = []
      const store = yield* RemoteCacheStore.make({ endpoint: "https://cache.example.com" }).pipe(
        Effect.provide(FetchHttpClient.layer)
      )
      yield* store.get(entry.keyDigest).pipe(
        Effect.provideService(
          FetchHttpClient.Fetch,
          ((_url: string, init?: RequestInit) => {
            seen.push(init)
            return Promise.resolve(new Response(null, { status: 404 }))
          }) as typeof globalThis.fetch
        ),
        Effect.provideService(FetchHttpClient.RequestInit, { cache: "no-store", redirect: "follow" })
      )
      expect(seen[0]?.redirect).toBe("manual")
      expect(seen[0]?.cache).toBe("no-store")
    }))
})

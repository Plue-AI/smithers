import { describe, expect, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import * as References from "effect/References"
import { TestClock } from "effect/testing"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as OtlpExporter from "effect/unstable/observability/OtlpExporter"
import { readFileSync } from "node:fs"
import { Otlp, Resource } from "../src/index.ts"
import { boundaryResources, resourceBytes, sdkResourceBytes } from "./fixtures/resources.ts"

interface RecordedRequest {
  readonly url: string
  readonly body: unknown
  readonly headers: globalThis.Headers
}

/** A `fetch` stand-in that records every export request and never networks. */
const recordingFetch = (
  respond: () => Promise<Response> = () => Promise.resolve(new Response("{}", { status: 200 }))
) => {
  const requests: Array<RecordedRequest> = []
  const fetch: typeof globalThis.fetch = (input, init) => {
    const body = typeof init?.body === "string"
      ? init.body
      : new TextDecoder().decode(init?.body as Uint8Array)
    requests.push({
      url: String(input),
      body: JSON.parse(body),
      headers: new globalThis.Headers(init?.headers)
    })
    return respond()
  }
  return { requests, fetch }
}

/** Runs `effect` under the layer with a fresh registry and the recording fetch. */
const runExporting = <A, E>(
  effect: Effect.Effect<A>,
  layer: Layer.Layer<never, E>,
  fetch: typeof globalThis.fetch
) =>
  effect.pipe(
    Effect.provide(layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provideService(Metric.MetricRegistry, new Map())
  )

/** The same export harness under a controllable clock, for retry assertions. */
const runExportingTimed = <A, E, R>(
  effect: Effect.Effect<A, never, R>,
  layer: Layer.Layer<R, E>,
  fetch: typeof globalThis.fetch
) =>
  effect.pipe(
    Effect.provide(layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provideService(Metric.MetricRegistry, new Map()),
    Effect.provide(TestClock.layer())
  )

const resourceAttributes = (request: RecordedRequest): Record<string, unknown> => {
  const body = request.body as {
    readonly resourceMetrics: ReadonlyArray<{
      readonly resource: { readonly attributes: ReadonlyArray<{ key: string; value: { stringValue: string } }> }
    }>
  }
  return Object.fromEntries(
    body.resourceMetrics[0]!.resource.attributes.map((attribute) => [attribute.key, attribute.value.stringValue])
  )
}

describe("Otlp", () => {
  it("keeps defaultServiceVersion equal to the package release version", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { readonly version: string }

    expect(Otlp.defaultServiceVersion).toBe(manifest.version)
  })

  it.effect("exports registered metrics to the collector with flows resource defaults", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      const counter = Metric.counter("observability_test_events")
      yield* runExporting(
        Metric.update(counter, 3),
        Otlp.layerFetch({ baseUrl: "http://collector.invalid:4318" }),
        collector.fetch
      )
      const exports = collector.requests.filter((request) => request.url.endsWith("/v1/metrics"))
      expect(exports.length).toBeGreaterThan(0)
      expect(JSON.stringify(exports[0]!.body)).toContain("observability_test_events")
      const attributes = resourceAttributes(exports[0]!)
      expect(attributes["service.name"]).toBe(Otlp.defaultServiceName)
      expect(attributes["service.version"]).toBe(Otlp.defaultServiceVersion)
    }))

  it.effect("preserves a collector base path for every signal and sends auth in headers", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      yield* runExporting(
        Effect.gen(function*() {
          yield* Effect.void.pipe(Effect.withSpan("base-path-span"))
          yield* Effect.logInfo("base path record")
          yield* Metric.update(Metric.counter("base_path_metric"), 1)
        }),
        Otlp.layerFetch({
          baseUrl: "https://collector.invalid:4318/tenant/9//",
          headers: { authorization: "Bearer synthetic-test-token" }
        }),
        collector.fetch
      )
      expect([...new Set(collector.requests.map((request) => new URL(request.url).pathname))].sort()).toEqual([
        "/tenant/9/v1/logs",
        "/tenant/9/v1/metrics",
        "/tenant/9/v1/traces"
      ])
      for (const request of collector.requests) {
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-test-token")
        expect(new URL(request.url).search).toBe("")
        expect(new URL(request.url).hash).toBe("")
      }
    }))

  it.effect("prefers the caller's service identity and resource attributes", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      yield* runExporting(
        Metric.update(Metric.counter("observability_test_identity"), 1),
        Otlp.layerFetch({
          baseUrl: "http://collector.invalid:4318",
          serviceName: "my-harness",
          serviceVersion: "9.9.9",
          attributes: { "deployment.environment.name": "test" },
          exportInterval: "1 hour",
          shutdownTimeout: "1 second"
        }),
        collector.fetch
      )
      const exports = collector.requests.filter((request) => request.url.endsWith("/v1/metrics"))
      const attributes = resourceAttributes(exports[0]!)
      expect(attributes["service.name"]).toBe("my-harness")
      expect(attributes["service.version"]).toBe("9.9.9")
      expect(attributes["deployment.environment.name"]).toBe("test")
    }))

  it.effect("sends caller headers and a non-empty metric payload through layer directly", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      const directLayer = Otlp.layer({
        baseUrl: "https://collector.invalid:4318",
        serviceName: "direct-http-client",
        headers: {
          authorization: "Bearer test-token",
          "x-tenant": "judge-suite"
        }
      }).pipe(Layer.provide(FetchHttpClient.layer))

      yield* runExporting(
        Metric.update(Metric.counter("observability_direct_metric"), 7),
        directLayer,
        collector.fetch
      )

      const request = collector.requests.find((candidate) => candidate.url.endsWith("/v1/metrics"))
      expect(request).toBeDefined()
      expect(request?.headers.get("authorization")).toBe("Bearer test-token")
      expect(request?.headers.get("x-tenant")).toBe("judge-suite")
      expect(resourceAttributes(request!)["service.name"]).toBe("direct-http-client")
      const body = request?.body as {
        readonly resourceMetrics?: ReadonlyArray<{
          readonly scopeMetrics?: ReadonlyArray<{ readonly metrics?: ReadonlyArray<unknown> }>
        }>
      }
      expect(body.resourceMetrics?.[0]?.scopeMetrics?.[0]?.metrics?.length).toBeGreaterThan(0)
      expect(JSON.stringify(body)).toContain("observability_direct_metric")
    }))

  it.effect.each([
    {
      label: "an HTTP 500",
      respond: () => Promise.resolve(new Response("collector failed", { status: 500 }))
    },
    {
      label: "a rejected fetch",
      respond: () => Promise.reject(new TypeError("network down"))
    }
  ])("degrades on $label without failing the app or leaking a rejection", ({ respond }) =>
    Effect.gen(function*() {
      const collector = recordingFetch(respond)
      const unhandled: Array<unknown> = []
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason)
      }
      process.on("unhandledRejection", onUnhandled)
      try {
        const result = yield* runExportingTimed(
          Effect.gen(function*() {
            yield* Effect.void.pipe(Effect.withSpan("observability_failed_export"))
            // One initial request plus the three transient retries completes by
            // four seconds. The exporter then disables itself for 60 seconds.
            yield* TestClock.adjust("5 seconds")
            yield* Effect.void.pipe(Effect.withSpan("observability_dropped_while_disabled"))
            yield* TestClock.adjust("5 seconds")
            return "application-completed"
          }),
          Otlp.layerFetch({
            baseUrl: "http://collector.invalid:4318",
            exportInterval: "1 second",
            shutdownTimeout: "1 second"
          }),
          collector.fetch
        )
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))

        expect(result).toBe("application-completed")
        expect(unhandled).toEqual([])
        const traceRequests = collector.requests.filter((request) => request.url.endsWith("/v1/traces"))
        expect(traceRequests).toHaveLength(4)
        expect(JSON.stringify(traceRequests[0]?.body)).toContain("observability_failed_export")
        expect(JSON.stringify(traceRequests)).not.toContain("observability_dropped_while_disabled")
      } finally {
        process.off("unhandledRejection", onUnhandled)
      }
    }))

  it.effect("posts every signal below the configured base URL", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      yield* runExporting(
        Effect.log("an exported line"),
        Otlp.layerFetch({ baseUrl: "http://collector.invalid:4318/nested" }),
        collector.fetch
      )
      for (const request of collector.requests) {
        expect(request.url).toMatch(/^http:\/\/collector\.invalid:4318\/nested\/v1\/(logs|metrics|traces)$/)
      }
      expect(collector.requests.some((request) => request.url.endsWith("/v1/logs"))).toBe(true)
    }))

  it.effect("bounds stalled exports, counts lost batches, and aborts requests before scope close", () =>
    Effect.gen(function*() {
      let started = 0
      let active = 0
      let peak = 0
      let aborted = 0
      let healthy = false
      const pending = new Set<() => void>()
      const activeCounts: Array<number> = []
      const stalledFetch: typeof globalThis.fetch = (input, init) => {
        if (healthy || String(input).endsWith("/v1/metrics")) return Promise.resolve(new Response("{}"))
        started++
        active++
        peak = Math.max(peak, active)
        return new Promise((_resolve, reject) => {
          const abort = () => {
            pending.delete(abort)
            active--
            aborted++
            reject(new DOMException("aborted", "AbortError"))
          }
          pending.add(abort)
          if (init?.signal?.aborted) abort()
          else init?.signal?.addEventListener("abort", abort, { once: true })
        })
      }
      const dropped = Metric.counter("flows_observability_otlp_dropped")
      const snapshots = yield* runExportingTimed(
        Effect.gen(function*() {
          for (let batch = 0; batch < 20; batch++) {
            for (let record = 0; record < 1000; record++) {
              if (batch < 10) yield* Effect.logInfo("synthetic record")
              else yield* Effect.void.pipe(Effect.withSpan("synthetic span"))
            }
            yield* TestClock.adjust("1 millis")
            activeCounts.push(active)
          }
          const saturated = { started, peak, dropped: (yield* Metric.value(dropped)).count }
          yield* TestClock.adjust("10 seconds")
          const timedOut = { active, aborted, dropped: (yield* Metric.value(dropped)).count }
          // A timed-out request releases its slot while the layer stays alive.
          for (let record = 0; record < 1000; record++) yield* Effect.logInfo("after timeout")
          yield* TestClock.adjust("1 millis")
          const restarted = started
          yield* TestClock.adjust("10 seconds")
          const reused = { active, aborted }
          // Clean up even with the regression present, so failures report the
          // observed counts instead of hanging in TestClock-backed finalizers.
          healthy = true
          for (const abort of pending) abort()
          yield* TestClock.adjust("5 seconds")
          return { saturated, timedOut, restarted, reused }
        }),
        Otlp.layerFetch({
          baseUrl: "http://collector.invalid:4318",
          exportInterval: "1 hour",
          shutdownTimeout: "10 millis"
        }),
        stalledFetch
      ).pipe(Effect.provide(Logger.layer([])))
      for (const count of activeCounts) expect(count).toBeLessThanOrEqual(4)
      expect(snapshots.saturated).toEqual({ started: 4, peak: 4, dropped: 16 })
      expect(snapshots.timedOut).toEqual({ active: 0, aborted: 4, dropped: 20 })
      expect(snapshots.restarted).toBe(5)
      expect(snapshots.reused).toEqual({ active: 0, aborted: 5 })
      expect(active).toBe(0)
    }))

  it.effect("discards oversized serialized batches with a loss diagnostic", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      const dropped = Metric.counter("flows_observability_otlp_dropped")
      yield* runExportingTimed(
        Effect.gen(function*() {
          yield* Effect.logInfo("x".repeat(1024 * 1024))
          yield* TestClock.adjust("2 seconds")
          expect(collector.requests.filter((request) => request.url.endsWith("/v1/logs"))).toHaveLength(0)
          expect((yield* Metric.value(dropped)).count).toBe(1)
          yield* Effect.logInfo("small batch")
          yield* TestClock.adjust("1 second")
          expect(collector.requests.filter((request) => request.url.endsWith("/v1/logs"))).toHaveLength(1)
        }),
        Otlp.layerFetch({ baseUrl: "http://collector.invalid:4318", exportInterval: "1 second" }),
        collector.fetch
      ).pipe(Effect.provide(Logger.layer([])))
    }))

  it.effect.each(boundaryResources)(
    "exports every signal with a resource at the byte boundary: $serviceName",
    (configuration) =>
      Effect.gen(function*() {
        const collector = recordingFetch()
        expect(sdkResourceBytes(configuration)).toBe(Resource.maximumResourceBytes)
        expect(resourceBytes(configuration)).toBeLessThanOrEqual(Resource.maximumResourceBytes)
        yield* runExporting(
          Effect.gen(function*() {
            yield* Effect.logInfo("small log")
            yield* Effect.void.pipe(Effect.withSpan("small span"))
            yield* Metric.update(Metric.counter("boundary/small_metric"), 1)
          }),
          Otlp.layerFetch({ baseUrl: "http://collector.invalid:4318", ...configuration, exportInterval: "1 hour" }),
          collector.fetch
        ).pipe(
          // Ambient resource data must never enlarge the accepted resource.
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
            OTEL_RESOURCE_ATTRIBUTES: { ambient: "x".repeat(Otlp.maxRequestBytes) }
          })))
        )
        expect(collector.requests.map((request) => request.url.split("/").at(-1)).sort()).toEqual([
          "logs",
          "metrics",
          "traces"
        ])
        for (const request of collector.requests) {
          const bytes = new TextEncoder().encode(JSON.stringify(request.body)).byteLength
          expect(bytes).toBeLessThanOrEqual(Otlp.maxRequestBytes - Otlp.reservedBatchBytes + 4_096)
          expect(JSON.stringify(request.body)).not.toContain("ambient")
        }
      })
  )

  it.effect("reserves enough room for ordinary 1,000-record log and span batches", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      yield* runExportingTimed(
        Effect.gen(function*() {
          for (let i = 0; i < 1_000; i++) yield* Effect.logInfo("ordinary log record")
          yield* TestClock.adjust("1 millis")
          for (let i = 0; i < 1_000; i++) yield* Effect.void.pipe(Effect.withSpan("ordinary span"))
          yield* TestClock.adjust("1 millis")
          expect((yield* Metric.value(Metric.counter("flows_observability_otlp_dropped"))).count).toBe(0)
        }),
        Otlp.layerFetch({
          baseUrl: "http://collector.invalid:4318",
          ...boundaryResources[3]!,
          exportInterval: "1 hour"
        }),
        collector.fetch
      )
      const logs = collector.requests.find((request) => request.url.endsWith("/logs"))!
      const traces = collector.requests.find((request) => request.url.endsWith("/traces"))!
      expect(
        (logs.body as { resourceLogs: Array<{ scopeLogs: Array<{ logRecords: unknown[] }> }> }).resourceLogs[0]!
          .scopeLogs[0]!.logRecords
      ).toHaveLength(1_000)
      expect(
        (traces.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }> }).resourceSpans[0]!
          .scopeSpans[0]!.spans
      ).toHaveLength(1_000)
      for (const request of [logs, traces]) {
        expect(new TextEncoder().encode(JSON.stringify(request.body)).byteLength).toBeLessThan(Otlp.maxRequestBytes)
      }
    }))

  it.effect("warns through the acquisition loggers, rate limits loss and never exports its own diagnostic", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      const warnings: Array<
        {
          level: string
          message: unknown
          annotations: Readonly<Record<string, unknown>>
          spans: ReadonlyArray<readonly [string, number]>
        }
      > = []
      const ambient = Logger.make((options) => {
        if (options.logLevel === "Warn") {
          warnings.push({
            level: options.logLevel,
            message: options.message,
            annotations: options.fiber.getRef(References.CurrentLogAnnotations),
            spans: options.fiber.getRef(References.CurrentLogSpans)
          })
        }
      })
      yield* runExportingTimed(
        Effect.gen(function*() {
          const flusher = yield* OtlpExporter.Flusher
          for (let i = 0; i < 2; i++) {
            yield* Effect.logInfo("PRIVATE_BATCH_VALUE" + "x".repeat(Otlp.maxRequestBytes))
            yield* flusher.flush
          }
          expect(warnings).toHaveLength(1)
          expect((yield* Metric.value(Metric.counter("flows_observability_otlp_dropped"))).count).toBe(2)
          yield* TestClock.adjust("60 seconds")
          yield* Effect.logInfo("x".repeat(Otlp.maxRequestBytes))
          yield* flusher.flush
          expect(warnings).toHaveLength(2)
          expect(warnings.map((warning) => warning.annotations.dropped)).toEqual([1, 3])
          yield* Effect.logInfo("small batch after loss")
          yield* flusher.flush
        }),
        Otlp.layerFetch({ baseUrl: "http://collector.invalid:4318", exportInterval: "1 hour" }).pipe(
          Layer.provideMerge(OtlpExporter.layerFlusher)
        ),
        collector.fetch
      ).pipe(
        Effect.provide(Logger.layer([ambient])),
        Effect.annotateLogs({ private: "PRIVATE_AMBIENT_VALUE" }),
        Effect.withLogSpan("PRIVATE_LOG_SPAN")
      )
      expect(warnings[0]).toMatchObject({
        level: "Warn",
        spans: [],
        message: ["An OTLP export batch was discarded"],
        annotations: { code: "otlp_export_discarded", reason: "oversized", limit: Otlp.maxRequestBytes }
      })
      expect(warnings[0]!.annotations.bytes).toBeGreaterThan(Otlp.maxRequestBytes)
      expect(JSON.stringify(warnings)).not.toContain("PRIVATE_")
      expect(JSON.stringify(warnings).length).toBeLessThan(1_024)
      const logs = collector.requests.filter((request) => request.url.endsWith("/logs"))
      expect(logs).toHaveLength(1)
      expect(JSON.stringify(logs)).toContain("small batch after loss")
      expect(JSON.stringify(logs)).not.toContain("otlp_export_discarded")
      expect(JSON.stringify(logs)).not.toContain("An OTLP export batch was discarded")
    }))

  it.effect("layerNoop provides nothing and exports nothing", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      yield* runExporting(Metric.update(Metric.counter("observability_test_noop"), 1), Otlp.layerNoop, collector.fetch)
      expect(collector.requests).toEqual([])
    }))
})

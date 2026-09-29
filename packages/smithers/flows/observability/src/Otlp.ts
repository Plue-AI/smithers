/**
 * Default OTLP export wiring for flows telemetry.
 *
 * The store packages already open spans through Effect's tracer and update
 * `Metric` counters on their hot paths; what they deliberately do not do is
 * ship an exporter. This module is that exporter: one layer that installs
 * Effect's own OTLP logger, metrics exporter, and tracer
 * (`effect/unstable/observability/Otlp`) against a collector endpoint, with
 * the flows service identity filled in. Nothing beyond `effect` is involved;
 * no OpenTelemetry SDK dependency.
 *
 * Browser support is met by construction rather than by a no-op variant:
 * export happens over Effect's `HttpClient`, and {@link layerFetch} binds the
 * `fetch` implementation the host already has, so no entry point here ever
 * resolves a `node:` built-in. See the
 * {@link https://smithers.sh/docs/reference/api/observability | observability API contract}.
 *
 * @since 0.1.0
 */

import * as Redaction from "@smthrs/journal/Redaction"
import * as Cause from "effect/Cause"
import { Clock } from "effect/Clock"
import * as ConfigProvider from "effect/ConfigProvider"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as References from "effect/References"
import * as Semaphore from "effect/Semaphore"
import * as Tracer from "effect/Tracer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Headers from "effect/unstable/http/Headers"
import type * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as Otlp from "effect/unstable/observability/Otlp"
import * as Endpoint from "./Endpoint.ts"
import * as Resource from "./Resource.ts"

/**
 * The `service.name` resource attribute installed when the caller supplies
 * none: the flows distribution itself. Override it per application with
 * {@link Options.serviceName}.
 *
 * @category resource
 * @since 0.1.0
 */
export const defaultServiceName = "flows"

/**
 * The `service.version` resource attribute installed when the caller supplies
 * none. Mirrors the release version in this package's `package.json`.
 *
 * A published package cannot read its own manifest on every runtime it
 * supports, so the version lives here as a literal.
 * `scripts/set-release-version.mjs` rewrites this declaration with the
 * manifests, and its `--check` mode reports drift, so a release bump cannot
 * leave it behind.
 *
 * @category resource
 * @since 0.1.0
 */
export const defaultServiceVersion = "1.0.0-rc.1"

// The upstream logger and tracer each buffer at most one 1,000-record batch.
// Do not queue at the transport: upstream forks every full batch independently.
const maxBatchSize = 1000
const maxInFlight = 4
/**
 * Maximum encoded export request size, in bytes.
 * @category transport
 * @since 1.0.0-rc.0
 */
export const maxRequestBytes = 1024 * 1024
const requestTimeout = "10 seconds"
const diagnosticIntervalMillis = 60_000
// The envelope around the resource in every request repeats `service.name` as
// the instrumentation scope name: at most 1,024 code units, at most six bytes
// each once JSON-escaped, so under 8 KiB together with the envelope's own keys.
/**
 * Reserved bytes for request wrappers and the escaped instrumentation scope.
 * @category transport
 * @since 1.0.0-rc.0
 */
export const maximumEnvelopeBytes = 8 * 1024

/**
 * Bytes of every export request kept free for the signal batch itself.
 *
 * The transport discards a request over 1 MiB, and the resource rides in every
 * request, so the largest resource `Resource.decode` admits
 * (`Resource.maximumResourceBytes`, 128 KiB) and the envelope that repeats the
 * service name (under 8 KiB) come off the top. The 888 KiB left gives each
 * record of a full 1,000-record logger or tracer batch about 900 bytes, three
 * to four times a bare log record or span, and gives the metrics snapshot room
 * for several thousand series. Every resource the decoder accepts therefore
 * leaves an ordinary batch of any signal exportable; what this reserve does
 * not bound is a single application record or a registry large enough to
 * exceed it on its own.
 *
 * @category transport
 * @since 1.0.0-rc.0
 */
export const reservedBatchBytes = maxRequestBytes - Resource.maximumResourceBytes - maximumEnvelopeBytes

type DiscardReason = "oversized" | "stalled" | "saturated"

const boundedClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const clock = yield* Clock
    // The loggers installed when this transport is acquired. The OTLP logger
    // the same acquisition installs does not exist yet, so a diagnostic pinned
    // to this set cannot enter the exporter it describes, whichever fiber runs
    // the export: the interval and shutdown fibers inherit this set anyway,
    // but a flush requested from application code runs with the application's
    // loggers, which by then include this exporter.
    const ambientLoggers = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.getRef(Logger.CurrentLoggers)))
    const permits = Semaphore.makeUnsafe(maxInFlight)
    // The counter lives with the transport it describes.
    const droppedExports = Metric.counter("flows_observability_otlp_dropped")
    let nextDiagnosticAt = -Infinity
    // A local discard is terminal, so the upstream retry loop must not retain
    // or retry its payload, and the counter records batches, not records. The
    // warning is the diagnostic the counter cannot be: the counter is exported
    // through this same transport and shares every outage with it. One
    // warning per minute keeps a sustained outage from flooding the ambient
    // loggers; the running total in its annotations carries the volume.
    // Replace ambient annotations and log spans to bound the diagnostic itself.
    const discard = (reason: DiscardReason, request: HttpClientRequest.HttpClientRequest, bytes: number) =>
      Metric.update(droppedExports, 1).pipe(
        Effect.andThen(Effect.suspend(() => {
          const now = clock.currentTimeMillisUnsafe()
          if (now < nextDiagnosticAt) return Effect.void
          nextDiagnosticAt = now + diagnosticIntervalMillis
          return Metric.value(droppedExports).pipe(
            Effect.flatMap((dropped) =>
              Effect.logWarning("An OTLP export batch was discarded").pipe(
                Effect.provideService(References.CurrentLogSpans, []),
                Effect.provideService(References.CurrentLogAnnotations, {
                  code: "otlp_export_discarded",
                  reason,
                  bytes,
                  limit: maxRequestBytes,
                  dropped: dropped.count
                })
              )
            ),
            Effect.provideService(Logger.CurrentLoggers, ambientLoggers)
          )
        })),
        Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
      )
    return HttpClient.transform(client, (requestEffect, request) =>
      Effect.suspend(() => {
        // layerJson always supplies a Uint8Array body with a byte length.
        const bytes = (request.body as HttpBody.Uint8Array).contentLength
        if (bytes > maxRequestBytes) return discard("oversized", request, bytes)
        return requestEffect.pipe(
          Effect.timeoutOrElse({ duration: requestTimeout, orElse: () => discard("stalled", request, bytes) }),
          permits.withPermitsIfAvailable(1),
          Effect.flatMap(Option.match({ onNone: () => discard("saturated", request, bytes), onSome: Effect.succeed }))
        )
      }))
  })
)

const loopbackIpv4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/** Whether a decoded endpoint's host never leaves this machine. */
const isLoopback = (endpoint: string): boolean => {
  const hostname = new URL(endpoint).hostname
  return hostname === "localhost" || hostname === "[::1]" || loopbackIpv4.test(hostname)
}

/**
 * Refuses a credential header bound for a plaintext collector off this
 * machine. Anyone on the network path could read the token from every export
 * request, and the exporter would never report it. Loopback `http://` stays
 * allowed for a local collector or sidecar; non-credential headers such as a
 * tenant id stay allowed on any endpoint.
 */
/**
 * Vendor credential headers whose names `Redaction.isSensitiveKey` does not
 * recognize. Honeycomb sends its ingest key as `x-honeycomb-team`.
 */
const vendorCredentialHeaders: ReadonlySet<string> = new Set(["x-honeycomb-team"])

const isCredentialHeader = (name: string): boolean =>
  Redaction.isSensitiveKey(name) || vendorCredentialHeaders.has(name.toLowerCase())

const refusePlaintextCredentials = (
  baseUrl: string,
  headers: Headers.Input | undefined
): Effect.Effect<void, Endpoint.InvalidExporterEndpoint> => {
  if (!baseUrl.toLowerCase().startsWith("http:") || isLoopback(baseUrl)) return Effect.void
  const credential = Object.keys(Headers.fromInput(headers)).some(isCredentialHeader)
  return credential
    ? Effect.fail(
      new Endpoint.InvalidExporterEndpoint({
        code: "invalid_exporter_endpoint",
        path: "baseUrl",
        message:
          "OTLP collector baseUrl must use https:// when headers carry credentials, unless it is a loopback address"
      })
    )
    : Effect.void
}

const redactText = (text: string): string => String(Redaction.redact(text))

/**
 * A span failure rendered with credentials removed. The exporter serializes a
 * failed span's cause into its status message and `exception` events, which
 * would otherwise carry any token an error message quoted to the collector.
 */
const redactedExit = (exit: Exit.Exit<unknown, unknown>): Exit.Exit<unknown, unknown> => {
  if (exit._tag === "Success" || Cause.hasInterruptsOnly(exit.cause)) return exit
  const errors = Cause.prettyErrors(exit.cause, { includeCauseInStack: true }).map((error) => {
    const redacted = new Error(redactText(error.message))
    redacted.name = redactText(error.name)
    // `prettyErrors` always renders a stack.
    redacted.stack = redactText(String(error.stack))
    return redacted
  })
  return Exit.failCause(errors.map(Cause.fail).reduce(Cause.combine, Cause.empty as Cause.Cause<unknown>))
}

/**
 * Wraps the installed tracer so every exported span's failure and string
 * attributes pass through the journal redaction rules first.
 */
const redactedSpans = Layer.effect(Tracer.Tracer)(
  Effect.map(Effect.tracer, (tracer) =>
    Tracer.make({
      ...tracer,
      span(options) {
        const span = tracer.span(options)
        const end = span.end.bind(span)
        const attribute = span.attribute.bind(span)
        span.end = (endTime, exit) => end(endTime, redactedExit(exit))
        span.attribute = (key, value) => attribute(key, typeof value === "string" ? redactText(value) : value)
        return span
      }
    }))
)

/**
 * Configuration for the default OTLP wiring.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * The collector base URL, for example `http://localhost:4318`. Signals are
   * posted below it at `/v1/logs`, `/v1/metrics`, and `/v1/traces`. It must be
   * an absolute `http://` or `https://` URL without credentials, a query,
   * fragment, backslashes, spaces, or controls. A base path is allowed. Invalid
   * values fail acquisition with {@link Endpoint.InvalidExporterEndpoint}.
   * Use {@link Options.headers} for authentication.
   */
  readonly baseUrl: string
  /** Overrides {@link defaultServiceName} as the `service.name` attribute. */
  readonly serviceName?: string | undefined
  /** Overrides {@link defaultServiceVersion} as the `service.version` attribute. */
  readonly serviceVersion?: string | undefined
  /**
   * Additional resource attributes attached to every exported signal, decoded
   * by `Resource.Attributes`. The whole resource must encode to at most
   * `Resource.maximumResourceBytes`; a larger one fails acquisition with
   * {@link Resource.InvalidResourceConfiguration} rather than making every
   * request oversized.
   */
  readonly attributes?: Record<string, unknown> | undefined
  /**
   * Headers sent with every export request, for example vendor auth. A header
   * whose name names a credential (`authorization`, `x-api-key`, anything
   * `Redaction.isSensitiveKey` recognizes, plus `x-honeycomb-team`) requires
   * an `https://` baseUrl unless the host is loopback; otherwise acquisition
   * fails with
   * {@link Endpoint.InvalidExporterEndpoint}.
   */
  readonly headers?: Headers.Input | undefined
  /** Export cadence for all three signals; each signal's Effect default applies when omitted. */
  readonly exportInterval?: Duration.Input | undefined
  /** Upper bound on the shutdown flush when the layer's scope closes. */
  readonly shutdownTimeout?: Duration.Input | undefined
}

/**
 * Creates the OTLP logs, metrics, and traces layer with flows resource
 * defaults, JSON-serialized. Exports share a four-request limit with no waiting
 * queue. Requests larger than 1 MiB or stalled for ten seconds are discarded;
 * `flows_observability_otlp_dropped` counts discarded batches, and at most
 * once a minute a `Warn` record with code `otlp_export_discarded` names the
 * reason, the request size, and the running total through the loggers that
 * were installed when the layer was acquired, never through this exporter.
 *
 * **Details**
 *
 * The layer still requires an `HttpClient`, which is how it stays
 * platform-neutral: a Node host may hand it `@effect/platform-node`'s Undici
 * client (re-exported by `@smthrs/platform-node`), a browser or test
 * hands it something else. Use {@link layerFetch} when the host's global
 * `fetch` is good enough. On Node 26 and every browser it is.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: Options
): Layer.Layer<
  never,
  Resource.InvalidResourceConfiguration | Endpoint.InvalidExporterEndpoint,
  HttpClient.HttpClient
> =>
  Layer.unwrap(
    Effect.map(
      Effect.all([
        Resource.decode({
          serviceName: options.serviceName ?? defaultServiceName,
          serviceVersion: options.serviceVersion ?? defaultServiceVersion,
          ...(options.attributes === undefined ? {} : { attributes: options.attributes })
        }),
        Endpoint.decode(options.baseUrl, "baseUrl").pipe(
          Effect.tap((baseUrl) => refusePlaintextCredentials(baseUrl, options.headers))
        )
      ]),
      ([decoded, baseUrl]) => {
        const resource = Resource.toOpenTelemetryConfiguration(decoded)
        return (
          Otlp.layerJson({
            baseUrl,
            resource: {
              serviceName: resource.serviceName,
              // `serviceVersion` is supplied above before Resource decoding.
              serviceVersion: resource.serviceVersion!,
              ...(resource.attributes === undefined ? {} : { attributes: resource.attributes })
            },
            headers: options.headers,
            maxBatchSize,
            loggerExportInterval: options.exportInterval,
            metricsExportInterval: options.exportInterval,
            tracerExportInterval: options.exportInterval,
            shutdownTimeout: options.shutdownTimeout
          }).pipe(
            Layer.provide(boundedClient),
            // Upstream merges OTEL_RESOURCE_ATTRIBUTES even with explicit
            // options. Keep unvalidated ambient metadata out of every request.
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
            (exporter) => Layer.provideMerge(redactedSpans, exporter)
          )
        )
      }
    )
  )

/**
 * Provides {@link layer} over the host's global `fetch`, the default wiring
 * for a Node host, and browser-safe by construction because it never touches
 * a `node:` built-in.
 *
 * **Example**
 *
 * ```ts
 * import * as Otlp from "@smthrs/observability/Otlp"
 *
 * const Telemetry = Otlp.layerFetch({ baseUrl: "http://localhost:4318" })
 * ```
 *
 * @category layers
 * @since 0.1.0
 */
export const layerFetch = (
  options: Options
): Layer.Layer<never, Resource.InvalidResourceConfiguration | Endpoint.InvalidExporterEndpoint> =>
  layer(options).pipe(Layer.provide(FetchHttpClient.layer))

/**
 * Why an OTLP layer refused to start.
 *
 * @category errors
 * @since 1.0.0
 */
export type LayerError = Resource.InvalidResourceConfiguration | Endpoint.InvalidExporterEndpoint

/**
 * Parses `OTEL_EXPORTER_OTLP_HEADERS`: comma-separated `key=value` pairs whose
 * values are percent-decoded, as the OpenTelemetry exporter specification
 * defines. A pair without `=` or with an empty key is skipped.
 *
 * @category environment
 * @since 1.0.0
 */
export const parseHeaders = (value: string | undefined): Record<string, string> => {
  const headers: Record<string, string> = {}
  for (const pair of (value ?? "").split(",")) {
    const separator = pair.indexOf("=")
    const key = pair.slice(0, separator).trim()
    if (separator < 0 || key === "") continue
    const raw = pair.slice(separator + 1).trim()
    let decoded = raw
    try {
      decoded = decodeURIComponent(raw)
    } catch { /* A malformed escape is kept verbatim. */ }
    headers[key] = decoded
  }
  return headers
}

/**
 * {@link layerFetch} when the environment names a collector, otherwise
 * {@link layerNoop}.
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is the collector base URL and
 * `OTEL_EXPORTER_OTLP_HEADERS` the headers sent with every export. An unset or
 * empty endpoint installs no exporter at all.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  options: Omit<Options, "baseUrl" | "headers"> = {}
): Layer.Layer<never, LayerError> => {
  const endpoint = environment["OTEL_EXPORTER_OTLP_ENDPOINT"]?.trim()
  if (endpoint === undefined || endpoint === "") return layerNoop
  return layerFetch({ ...options, baseUrl: endpoint, headers: parseHeaders(environment["OTEL_EXPORTER_OTLP_HEADERS"]) })
}

/**
 * Exports nothing. The explicit stand-in for hosts with no collector, such as
 * a development shell, a test, or a browser deployment that has not opted in, so
 * wiring code can switch layers rather than branch.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<never> = Layer.empty

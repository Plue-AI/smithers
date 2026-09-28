/**
 * Node-only OTLP/HTTP OpenTelemetry setup.
 *
 * @since 0.1.0
 */

import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import * as ConfigProvider from "effect/ConfigProvider"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Endpoint from "./Endpoint.ts"
import * as Resource from "./Resource.ts"
import type { Configuration as ResourceConfiguration } from "./Resource.ts"

/**
 * Node OTLP/HTTP layer options.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * The collector base URL. It must be an absolute `http:` or `https:` URL
   * without credentials and free of spaces and control characters; anything
   * else fails layer acquisition with
   * {@link Endpoint.InvalidExporterEndpoint}.
   */
  readonly endpoint: string
  readonly resource: ResourceConfiguration
  readonly shutdownTimeout?: Duration.Input | undefined
  readonly exportIntervalMillis?: number | undefined
}

/**
 * Builds a scoped Node OTLP/HTTP layer for all three telemetry signals.
 * Exporter objects are created only when this layer is built.
 * Resource metadata is explicit: ambient OTEL resource configuration cannot
 * enlarge it after validation. The OpenTelemetry exporters still read the
 * standard `OTEL_EXPORTER_OTLP_*` transport variables (headers, timeout,
 * compression, TLS files) from the process environment and send them to the
 * explicit endpoint, which always wins over `OTEL_EXPORTER_OTLP_ENDPOINT`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerOtel = (
  options: Options
): Layer.Layer<never, Resource.InvalidResourceConfiguration | Endpoint.InvalidExporterEndpoint> =>
  Layer.unwrap(
    Effect.map(
      Effect.all([Resource.decode(options.resource), Endpoint.decode(options.endpoint, "endpoint")]),
      ([decoded, endpoint]) =>
        NodeSdk.layer(() => {
          const resource = Resource.toOpenTelemetryConfiguration(decoded)
          const spanProcessor = new BatchSpanProcessor(
            new OTLPTraceExporter({ url: Endpoint.signalUrl(endpoint, "traces") })
          )
          const logRecordProcessor = new BatchLogRecordProcessor({
            exporter: new OTLPLogExporter({ url: Endpoint.signalUrl(endpoint, "logs") })
          })
          const metricReader = options.exportIntervalMillis === undefined
            ? new PeriodicExportingMetricReader({
              exporter: new OTLPMetricExporter({ url: Endpoint.signalUrl(endpoint, "metrics") })
            })
            : new PeriodicExportingMetricReader({
              exporter: new OTLPMetricExporter({ url: Endpoint.signalUrl(endpoint, "metrics") }),
              exportIntervalMillis: options.exportIntervalMillis
            })
          return {
            resource,
            spanProcessor,
            logRecordProcessor,
            metricReader,
            shutdownTimeout: options.shutdownTimeout
          }
        }).pipe(
          // NodeSdk merges Resource.layerFromEnv after our admission check.
          // Isolate that lookup so only the validated explicit resource and
          // the SDK metadata already included in its budget reach exporters.
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))
        )
    )
  )

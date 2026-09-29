/**
 * OTLP export for the `smthrs` process, opted into by the standard
 * OpenTelemetry environment.
 *
 * @since 1.0.0
 */

import * as Otlp from "@smthrs/observability/Otlp"
import type * as Layer from "effect/Layer"
import { packageVersion } from "../Version.ts"

/**
 * Exports traces, logs and metrics to `OTEL_EXPORTER_OTLP_ENDPOINT` with
 * `OTEL_EXPORTER_OTLP_HEADERS`; with no endpoint it installs no exporter.
 *
 * Provide it outside `RedactedLogger.layer`, so the exported log records pass
 * through the same redaction as the terminal's.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  environment: Readonly<Record<string, string | undefined>>
): Layer.Layer<never, Otlp.LayerError> =>
  Otlp.layerEnvironment(environment, { serviceName: "smthrs", serviceVersion: packageVersion })

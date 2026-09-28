---
title: "Wire an OpenTelemetry SDK"
description: "Use NodeOtel, BrowserOtel, or Otel when a collector endpoint is not enough: the Node OTLP/HTTP layer, browser processors you construct, and bridging providers an application already built."
sidebar:
  order: 2
---

[`Otlp`](./export-to-a-collector.md) covers a collector endpoint and nothing
else. Three builders exist for the cases it does not cover: existing
OpenTelemetry instrumentation you must feed, a vendor exporter that is not
OTLP/HTTP JSON, and a provider a framework hands you already constructed.

All three validate `Resource.Configuration`. `NodeOtel` and `BrowserOtel`
construct providers with that resource. `Otel` supplies it to provider factories
and metrics; already-created providers retain their own resource.

## Node: build the SDK for me

`NodeOtel.layerOtel` allocates the whole Node OpenTelemetry SDK: a
`BatchSpanProcessor`, a `BatchLogRecordProcessor`, and a
`PeriodicExportingMetricReader`, each behind its own OTLP/HTTP exporter.

```ts
import * as NodeOtel from "@smthrs/observability/NodeOtel"
import * as Effect from "effect/Effect"

const telemetry = NodeOtel.layerOtel({
  endpoint: "http://localhost:4318",
  resource: { serviceName: "deploy-status", serviceVersion: "2.4.1" },
  exportIntervalMillis: 60_000,
  shutdownTimeout: "10 seconds"
})

const outcome = program.pipe(Effect.provide(telemetry), Effect.scoped)
```

The exporters are created when the scoped layer is built, not when the module
is imported, so holding the builder costs nothing. Closing the scope
force-flushes both batch processors and collects the metric reader once, which
makes release, rather than the interval, the deterministic flush.

The endpoint option is named `endpoint` here and `baseUrl` on `Otlp`; each
refusal names the option it arrived on, so the message points at your own
field.

`NodeOtel` takes no `headers` option. The OpenTelemetry exporters read the
standard `OTEL_EXPORTER_OTLP_HEADERS`, `_TIMEOUT`, `_COMPRESSION`, and TLS
certificate variables from the process environment and send them to your
explicit `endpoint`, which always wins over `OTEL_EXPORTER_OTLP_ENDPOINT`.
Set those variables only for this collector. `Otlp` reads none of them.

Import `NodeOtel` only from code that runs on Node. See
[the layer map](../concepts/layer-map.md) for why it is absent from the root
entry point.

## Browser: bring your own processors

`BrowserOtel.layerOtel` builds the web SDK around processors and readers the
application constructs. That keeps browser exporter policy, and every exporter
package a bundle would have to carry, in the application rather than in this
one.

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import * as BrowserOtel from "@smthrs/observability/BrowserOtel"

const telemetry = BrowserOtel.layerOtel({
  resource: { serviceName: "console-ui" },
  spanProcessor: () =>
    new BatchSpanProcessor(
      new OTLPTraceExporter({ url: "https://otlp.example.com/v1/traces" })
    )
})
```

Every processor field is optional, and a layer with none still builds: it
provides the resource and bridges nothing. Return an array to install several
processors for one signal. Each field is a factory because the layer owns what
it returns: the factory runs once at acquisition, and the web SDK shuts down
every processor and reader when the scope closes.

If all you need in a browser is OTLP delivery, use `Otlp.layerFetch` instead.
It is smaller, needs no SDK, and is browser-safe by construction.

## Bridge providers you control

`Otel.layerOtel` allocates no exporter at all. It takes an OpenTelemetry
`TracerProvider` and `LoggerProvider`, plus a factory that builds the metric
readers, and bridges Effect's tracer, logger, and metrics onto them. Provider
fields also accept synchronous factories. Every factory runs during layer
acquisition, after resource validation, and the provider factories receive the
same resource as the metric producer. Pass it to the SDK constructor to export
all signals with the configured service identity:

```ts
import { LoggerProvider } from "@opentelemetry/sdk-logs"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base"
import * as Otel from "@smthrs/observability/Otel"
import * as Effect from "effect/Effect"

let tracerProvider: BasicTracerProvider | undefined
let loggerProvider: LoggerProvider | undefined
const telemetry = Otel.layerOtel({
  resource: {
    serviceName: "deploy-status",
    serviceVersion: "2.4.1",
    attributes: { region: "us-west" }
  },
  tracerProvider: (resource) =>
    tracerProvider = new BasicTracerProvider({
      resource,
      spanProcessors: [spanProcessor]
    }),
  loggerProvider: (resource) =>
    loggerProvider = new LoggerProvider({
      resource,
      processors: [logRecordProcessor]
    }),
  metricReader: () => new PeriodicExportingMetricReader({ exporter: metricExporter }),
  metricTemporality: "cumulative"
})

try {
  await Effect.runPromise(program.pipe(Effect.provide(telemetry), Effect.scoped))
} finally {
  await Promise.all([tracerProvider?.shutdown(), loggerProvider?.shutdown()])
}
```

Ownership splits between the two kinds of field. Providers are borrowed: the
application owns their flushing and shutdown, including providers returned by
factories, and this layer never shuts one down. Readers are owned: the
`metricReader` factory runs once during acquisition, and closing the scope shuts
down every reader it returned. Build the readers inside the factory rather than
handing over one a longer-lived composition still exports through, which that
shutdown would disable. Construct `spanProcessor` and `logRecordProcessor` with
your exporters and give them to the provider you build.

You can still pass existing providers directly. The layer cannot change the
resource they captured at construction. In that form, the resource option
controls only metrics and tracer instrumentation scope, not log or span resource
attributes. Construct both providers with the intended resource before injection,
or use the factories above to receive the validated resource.

Each of the three is optional and each is bridged only when supplied, so a
composition with a tracer and no meter installs only the tracer bridge. A
`metricReader` factory that returns an empty array registers no reader at all
rather than a misconfigured one.

Two options control merge behavior: `loggerMergeWithExisting` keeps the ambient
Effect loggers alongside the OpenTelemetry logger, and `metricTemporality`
selects the temporality preference the metric bridge reports.

`Otel.layerNoop` is the explicit empty slot for a composition that wants the
option without the wiring.

## Provide only the resource

`Resource.layer` provides the validated OpenTelemetry resource by itself, for a
composition that assembles the rest of the SDK on its own:

```ts
import * as Resource from "@smthrs/observability/Resource"

const resource = Resource.layer({
  serviceName: "deploy-status",
  attributes: { "deployment.environment.name": "production" }
})
```

`Resource.configToAttributes` is the pure projection of the same configuration
into OpenTelemetry attributes, for code that needs the attribute record rather
than a layer. It reads no environment variables: attributes come from your
configuration and the SDK's fixed `telemetry.sdk.name` and
`telemetry.sdk.language` fields, which are included in the admission budget.

## Default OTLP export limits

`Otlp.layer` and `Otlp.layerFetch` share a limit of four active HTTP requests
across logs, traces, and metrics within each layer acquisition. Each request has
a ten-second timeout that interrupts the transport and aborts a stalled fetch.
`shutdownTimeout` separately bounds the final scope flush.

Logs and traces flush at 1,000 records or the export interval. The transport has
no waiting queue: a batch arriving while all four slots are occupied is dropped.
Serialized JSON payloads larger than 1 MiB are also dropped, limiting active
request payloads to 4 MiB. This limit applies after serialization; it does not
bound individual application records, temporary serialization allocations, or
the application's metric registry.

Resource admission caps cumulative encoded metadata at 128 KiB and bounds
arrays at 256 elements. The byte budget includes SDK-added telemetry fields,
reserved even for the default Effect exporter. Both the default exporter and
the Node SDK layer isolate ambient resource configuration after validation.
The default exporter also budgets the request envelope
at 8 KiB and reserves `Otlp.reservedBatchBytes` (888 KiB) for signals: roughly
900 bytes per record
in a 1,000-record log or span batch. Every layer validates these resource limits
before allocating exporters, including injected SDK layers.

The Effect counter `flows_observability_otlp_dropped` increments once per batch
discarded for saturation, payload size, or timeout. Discards are terminal and
are not retried. Read the counter locally
with `Metric.value(Metric.counter("flows_observability_otlp_dropped"))` during an
outage. Its exported value becomes available when the collector recovers.

Because that counter shares the export path, each acquisition also emits at
most one warning every 60 seconds through the ambient loggers captured before
installing the OTLP logger. The warning has code `otlp_export_discarded`, reason
`oversized`, `saturated`, or `stalled`, encoded bytes, request limit, and total
discarded batches. It includes no payload, URL, or inherited annotations and
cannot re-enter this exporter even during an application-triggered flush. Keep
an ambient logger installed if loss diagnostics should remain visible during
an export outage.

Ordinary HTTP and network failures retain Effect's retry policy. These limits
apply to the default `Otlp` layers; SDK processors supplied to the other builders
retain their own export policies.

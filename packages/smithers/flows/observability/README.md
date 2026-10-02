# @smthrs/observability

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://observability.smithers.sh

# `@smthrs/observability`

Send an Effect program's logs, metrics, and traces to an OpenTelemetry collector with one layer.

`Otlp` composes only what `effect` itself ships, so it allocates no OpenTelemetry SDK, never resolves a `node:` built-in, and runs unchanged in Node, Bun, and a browser. Around it the package ships the pieces a host installs beside an exporter: Effect logger layers, a validated `Resource` describing the service, a `JournalLogger` that mirrors a run's log records into a durable journal, the runtime `Metric` handles that cross package boundaries, and `Otel`, which bridges OpenTelemetry providers an application already built.

`NodeOtel` and `BrowserOtel` are deliberately not re-exported from the root. Each binds a host-specific OpenTelemetry SDK: `NodeOtel` reaches `@effect/opentelemetry/NodeSdk` and `@opentelemetry/sdk-trace-node`, which pulls the bare `async_hooks` specifier through `@opentelemetry/context-async-hooks`. Re-exporting it would put a module a browser bundler cannot resolve in the root entry point. Import them by subpath instead: `@smthrs/observability/NodeOtel`.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/).

Node.js 26.4.0 or later. Effect services are identified by module identity, so install the same `effect` release this package is built against.

The default install supports the root, `Otlp`, `Otel`, and `Resource`, with
required `@effect/opentelemetry@4.0.0-rc.115` and `@opentelemetry/api@1.9.1`
peers. It includes no HTTP exporters or trace SDK. Select the optional peers
for the host subpath you import:

```sh
# @smthrs/observability/NodeOtel
pnpm add @opentelemetry/exporter-logs-otlp-http@0.222.0 @opentelemetry/exporter-metrics-otlp-http@0.222.0 @opentelemetry/exporter-trace-otlp-http@0.222.0 @opentelemetry/sdk-trace-base@2.11.0 @opentelemetry/sdk-trace-node@2.11.0
# @smthrs/observability/BrowserOtel
pnpm add @opentelemetry/sdk-trace-base@2.11.0 @opentelemetry/sdk-trace-web@2.11.0
```

## Use

```ts
import * as Otlp from "@smthrs/observability/Otlp"

const Telemetry = Otlp.layerFetch({
  baseUrl: "http://localhost:4318",
  serviceName: "my-service"
})
```

Provide the layer, give it a scope, and every span, log record, and metric series the program already produces posts to the collector. Deleting the provide removes telemetry and changes nothing else.

Resource identity fields and attribute keys are limited to 1,024 UTF-16 code
units, strings to 65,536 code units, and attributes to 256 entries.
Resources are refused during layer acquisition with `InvalidResourceConfiguration`
if arrays exceed 256 elements or the whole OTLP JSON resource exceeds 128 KiB.
The byte budget counts keys, values, wrappers, JSON escaping, and UTF-8, including
service identity and SDK-added `telemetry.sdk.name` and `telemetry.sdk.language`.
These SDK fields are reserved even for the default Effect exporter. Resource
metadata is explicit; both default OTLP and Node SDK layers isolate ambient
resource configuration so it cannot enlarge a resource after validation.
The 1 MiB transport reserves 8 KiB for the request envelope
and 888 KiB (`Otlp.reservedBatchBytes`) for signal batches: about 909 bytes per
record in the upstream 1,000-record log or span batch. Large application records
can still exceed the transport cap.

Discarded batches increment `flows_observability_otlp_dropped` and emit a
`Warn` diagnostic with code `otlp_export_discarded` at most once per minute per
transport through the loggers installed before exporter acquisition. Install
an ambient logger that writes outside OTLP to observe loss independently; an
empty logger set or a minimum level above `Warn` suppresses that diagnostic.
The warning never enters this exporter and includes only the discard reason,
request bytes, byte limit, and running drop count.

## Documentation

Full documentation is at [observability.smithers.sh](https://observability.smithers.sh):

- [Quickstart](https://observability.smithers.sh/quickstart/): export a trace, a log record, and a metric series to a collector you can watch.
- [Installation](https://observability.smithers.sh/installation/): requirements, import forms, and the rule that keeps the root entry point bundling for a browser.
- [The layer map](https://observability.smithers.sh/concepts/layer-map/): which builder to reach for, and what each one costs.
- [API reference](https://observability.smithers.sh/reference/api/): every public export, with validation, backpressure, shutdown, retry, and platform contracts.
- [Troubleshooting](https://observability.smithers.sh/troubleshooting/): the typed refusals this package reports, and the silent cases that are not refusals at all.

## License

MIT

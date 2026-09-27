---
title: "@smthrs/observability"
description: "Send an Effect program's logs, metrics, and traces to an OpenTelemetry collector with one layer, no OpenTelemetry SDK, and a collector endpoint that is validated before anything exports."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/observability/docs/README.md"
---

`@smthrs/observability` sends an Effect program's logs, metrics, and traces to
an OpenTelemetry collector. You add one layer to turn delivery on, and delete
that one line to turn it off; nothing else in the program changes.

## What it solves

An Effect program already produces telemetry without an exporter.
`Effect.withSpan` opens a span on Effect's tracer, `Metric.update` advances a
counter in Effect's metric registry, and `Effect.logInfo` writes a log record.
With nothing installed to deliver them, all three are collected and discarded.

The usual way to deliver them is an OpenTelemetry SDK: several packages, a
provider for each signal, and a bundle a browser build cannot carry. This
package is the smaller answer for the common case. `Otlp` composes only what
`effect` itself ships, so it pulls in no OpenTelemetry SDK, runs unchanged in
Node, Bun, and a browser, and posts all three signals to a collector over the
host's global `fetch`.

Two behaviors matter beyond the delivery itself:

- **A bad endpoint is refused at startup.** Export failure is absorbed by
  design, so an exporter pointed at `collector:4318` or at a URL with a
  trailing newline behaves exactly like a healthy one and delivers nothing
  forever. Endpoints and service identities are decoded when the layer is
  built, and a bad one fails there with a typed error.
- **Log records can also go somewhere durable.** `JournalLogger` mirrors a
  run's log records into a run journal, so an operator reads them back in
  process without standing up a collector at all.

When one layer is not enough, `NodeOtel`, `BrowserOtel`, and `Otel` wire a real
OpenTelemetry SDK, and every builder attaches the same validated service
identity, so `service.name` means the same thing whichever one you pick.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

Node.js 26.4.0 or later. For the import forms and the browser rule, see
[Installation](/installation/).

## Export all three signals

```ts
import * as Otlp from "@smthrs/observability/Otlp"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"

const deployments = Metric.counter("deployments")

const program = Effect.gen(function*() {
  yield* Effect.logInfo("deploying the API")
  yield* Metric.update(deployments, 1)
}).pipe(Effect.withSpan("deploy"))

const telemetry = Otlp.layerFetch({
  baseUrl: "http://localhost:4318",
  serviceName: "deploy-status"
})

await Effect.runPromise(
  program.pipe(Effect.provide(telemetry), Effect.orDie, Effect.scoped)
)
```

The span posts to the collector's `/v1/traces` path, the log record to
`/v1/logs`, and the counter to `/v1/metrics`, all tagged `service.name:
deploy-status`. The exporters batch, so closing the layer's scope is what
flushes them: that is why the program ends in `Effect.scoped`. The
[Quickstart](/quickstart/) runs this against a twelve-line collector
stand-in so you can watch each signal land.

## How this fits with @smthrs/flows

Smithers is a durable flow engine: a flow records each step as it completes, so
a process that dies replays what already finished and resumes at the first step
that did not. [`@smthrs/flows`](https://flows.smithers.sh/reference/api/) is the single npm package that
carries that whole engine, and it re-exports this one as its `Observability`
namespace. A program that already depends on `@smthrs/flows` has these layers
available without adding a dependency:

```ts
import { Observability } from "@smthrs/flows"

const telemetry = Observability.Otlp.layerFetch({
  baseUrl: "http://localhost:4318",
  serviceName: "deploy-status"
})
```

That relationship is also why this package ships more than an exporter. The
engine packages under `@smthrs/flows` instrument themselves: they open spans on
Effect's tracer and update their own metric handles on their hot paths, and
none of them allocates an exporter. Providing one layer from this package turns
delivery on for all of that instrumentation at once. The `JournalLogger` and
`Metric` modules exist for the same reason: a run journal and a shared set of
runtime metric handles are what a durable engine needs and a standalone
exporter does not.

You do not need the engine to use this package. `Otlp`, `Logger`, `Resource`,
`Otel`, `NodeOtel`, and `BrowserOtel` work in any Effect program. Only
`JournalLogger` requires a journal, from [`@smthrs/journal`](https://journal.smithers.sh/reference/api/).

Above `@smthrs/flows` sits [`smithers`](https://cli.smithers.sh/reference/api/), the command-line interface
that runs, resumes, and inspects flows. Start there if you want to run flows
rather than embed the engine in your own program.

## Who uses this package

Host and CLI authors install the exporter, a logger, and, for a control-plane
run, the journal forwarder. Operators read the result: spans and metric series
in a collector, `telemetry.log` rows on a run's journal. Authors of the engine
packages use `Metric` to update a shared runtime handle, and touch nothing else
here.

## The package at a glance

The root entry point exports these namespaces, and each is also importable from
`@smthrs/observability/<Module>`:

| Namespace       | What it is                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `Otlp`          | The default exporter: one layer that posts logs, metrics, and traces to a collector, no SDK involved. |
| `Endpoint`      | The validated collector endpoint every OTLP builder decodes before it exports anything.               |
| `Resource`      | The validated service identity attached to every exported signal.                                     |
| `Logger`        | Effect logger layers: pretty for development, one JSON object per line for production, and silence.   |
| `JournalLogger` | A bounded, drop-on-overflow forwarder that mirrors log records into a run's durable journal.          |
| `Metric`        | The four runtime metric handles the engine packages update, and their exported identifiers.           |
| `Otel`          | The provider-neutral bridge for an OpenTelemetry SDK the application already built.                   |

Two more modules are subpath-only, because each resolves a host-specific
OpenTelemetry SDK:

| Import                              | What it is                                                              |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `@smthrs/observability/NodeOtel`    | Node OTLP/HTTP wiring over the OpenTelemetry SDK. Node only.            |
| `@smthrs/observability/BrowserOtel` | Browser OpenTelemetry wiring over processors and readers you construct. |

Every export, with signatures and failure types, is on the
[API reference](/reference/api/).

## Where to go next

- [Installation](/installation/): requirements, import forms, and which
  packages a real composition adds.
- [Quickstart](/quickstart/): export a trace, a log record, and a metric
  series to a collector you can watch, in about thirty lines.
- Guides: [export to a collector](/guides/export-to-a-collector/),
  [wire an OpenTelemetry SDK](/guides/wire-an-opentelemetry-sdk/),
  [forward logs to the journal](/guides/forward-logs-to-the-journal/),
  [install a logger](/guides/install-a-logger/),
  [read the runtime metrics](/guides/read-runtime-metrics/), and
  [test telemetry without a collector](/guides/testing/).
- Concepts: [instrumentation and export](/concepts/instrumentation-and-export/),
  [the layer map](/concepts/layer-map/), and
  [validation at layer acquisition](/concepts/validated-acquisition/).
- [Troubleshooting](/troubleshooting/): the typed refusals this package
  reports, and the silent cases that are not refusals at all.

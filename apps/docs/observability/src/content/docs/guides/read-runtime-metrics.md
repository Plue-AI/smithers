---
title: "Read the runtime metrics"
description: "The four runtime metric handles this package declares, the exact series names a dashboard binds to, which package advances each one, and how to read a counter in process without an exporter."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/observability/docs/guides/read-runtime-metrics.md"
---

`Metric` declares the runtime signals that cross package boundaries: the
handles a producer updates and a dashboard reads. Every other metric in
Smithers belongs to the package that owns the behavior it measures.

## The six handles

| Handle                       | Series name                                | Kind    | Advances when                                                                                                                                                      |
| ---------------------------- | ------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runThroughput`              | `flows_run_throughput`                     | counter | A run's terminal transition commits in [`@smthrs/run-store`](https://run-store.smithers.sh/reference/api/).                                                                                      |
| `activeSeats`                | `flows_seat_active`                        | gauge   | Held for the lifetime of a production `Agent.run` stream in [`@smthrs/agent`](https://agent.smithers.sh/reference/api/), and released on success, failure, or interruption.                      |
| `quotaParks`                 | `flows_quota_park`                         | counter | A sealed quota decision is first executed, and not when that decision is replayed after a wake or a process restart.                                               |
| `structuredOutputRejections` | `flows_agent_structured_output_rejections` | counter | An agent answer is refused by its declared output schema, in the same session or a fresh one.                                                                      |
| `structuredOutputExhausted`  | `flows_agent_structured_output_exhausted`  | counter | An agent step fails after spending every output correction and its repair.                                                                                         |
| `droppedLogRecords`          | `flows_observability_log_dropped`          | counter | A log record is lost before durable delivery: once per queue overflow, once per journal delivery failure, and once per defect the forwarding worker recovers from. |

`Metric.registry` is the same six as one object, so a host can enumerate them.
The series names are the dashboard contract; treat them as public API.

Step-cache lookup and write counters belong to
[`@smthrs/step-cache`](https://step-cache.smithers.sh/reference/api/), and the store packages keep their own
handles. This package does not duplicate any of them.

## Read a counter in process

A metric handle is readable without an exporter, which makes it a fine
assertion target in a test and a fine health check in a host:

```ts
import * as ObservabilityMetric from "@smthrs/observability/Metric"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"

const dropped = Effect.gen(function*() {
  const value = yield* Metric.value(ObservabilityMetric.droppedLogRecords)
  return value.count
})
```

A counter's value carries `count`; a gauge's carries `value`.

## Read a dimensioned counter through its attribute view

Some packages update a counter through a tagged view rather than the bare
handle. The dispatch counter in [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/) is
the common example: it updates only the series tagged with the outcome, so
reading the bare handle reads the attribute-less series and always sees zero.

```ts
import { EngineStoreMetrics } from "@smthrs/engine-store"

const dispatches = Effect.gen(function*() {
  const value = yield* Metric.value(EngineStoreMetrics.dispatch.Success)
  return value.count
})
```

Read the exported view, not the parent handle, whenever the owning package
exports one.

## Isolate the registry in a test

Effect keeps metric state in a `MetricRegistry` reference with a
process-default value, so counters accumulate across tests in one process.
Provide a fresh map to isolate one run:

```ts
Effect.provideService(Metric.MetricRegistry, new Map())
```

## Where the series go

Every registered series exports with the rest of the telemetry: with
[`Otlp` provided](/guides/export-to-a-collector/), they post to the collector's
`/v1/metrics` path under the `service.name` you configured. With no exporter
installed, they are still collected and still readable in process, and nothing
leaves the machine.

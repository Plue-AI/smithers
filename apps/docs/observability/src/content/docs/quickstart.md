---
title: "Quickstart"
description: "Export a trace, a log record, and a metric series to a collector you can watch, using a thirty-line collector stand-in and one Effect layer."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/observability/docs/quickstart.md"
---

This quickstart exports all three signals from one small program and shows you
what arrived. It needs no Docker, no vendor account, and no OpenTelemetry SDK:
a twelve-line Node server stands in for the collector so you can read the
delivery with your own eyes, and swapping in a real collector is a one-line
change at the end.

## Prerequisites

- Node.js 26.4.0 or later, which runs a `.ts` file directly by stripping its
  types.
- A package whose `package.json` sets `"type": "module"`, with the
  dependencies installed. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

## Start a collector stand-in

An OTLP/HTTP collector is an HTTP server that accepts JSON on three paths.
Create `collector.mjs`:

```js
import { createServer } from "node:http"

createServer((request, response) => {
  const chunks = []
  request.on("data", (chunk) => chunks.push(chunk))
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    console.log(request.url, Object.keys(body).join(" "))
    response.writeHead(200, { "content-type": "application/json" })
    response.end("{}")
  })
}).listen(4318, "127.0.0.1")
```

Run it in its own terminal, and leave it running:

```bash
node collector.mjs
```

## Write the program

Create `quickstart.ts`. The program opens a span, writes a log record, and
advances a counter. None of those three lines mentions telemetry: they are
ordinary Effect, and they are exactly what the Smithers packages already do on
their own hot paths.

```ts
import * as Otlp from "@smthrs/observability/Otlp"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"

const deployments = Metric.counter("quickstart/deployments", {
  description: "Deployments this program recorded"
})

const deploy = Effect.gen(function*() {
  yield* Effect.logInfo("deploying the API")
  yield* Metric.update(deployments, 1)
}).pipe(Effect.withSpan("deploy"))
```

Now add the exporter and run it. `layerFetch` posts over the host's global
`fetch`, so there is nothing else to provide:

```ts
const telemetry = Otlp.layerFetch({
  baseUrl: "http://localhost:4318",
  serviceName: "quickstart",
  serviceVersion: "1.0.0"
})

await Effect.runPromise(
  deploy.pipe(Effect.provide(telemetry), Effect.orDie, Effect.scoped)
)
```

`Effect.orDie` says that an unusable collector endpoint is a startup defect
rather than something this program recovers from. The layer is scoped, so
`Effect.scoped` gives it a lifetime, and closing that scope is what flushes.

## Run it

```bash
node quickstart.ts
```

The collector terminal prints one line per signal. The three arrive in
whatever order the exporters flush:

```text
/v1/traces resourceSpans
/v1/logs resourceLogs
/v1/metrics resourceMetrics
```

If you print a whole body instead of its top-level key, every payload carries
the resource you named: `service.name` is `quickstart` and `service.version` is
`1.0.0`.

## What just happened

One layer installed three of Effect's own OTLP exporters against your base URL.
Each signal posts below it on its own path, so `http://localhost:4318` becomes
`/v1/traces`, `/v1/logs`, and `/v1/metrics`. The exporters batch, so nothing
was delivered while the program ran; closing the layer's scope force-flushed
all three, which is why `Effect.scoped` is where the output comes from.

The program never mentioned a tracer, a meter, or a logger provider. Effect's
own tracer and metric registry were already collecting; the layer is only the
delivery.

## Point it at a real collector

Change one field:

```ts
const telemetry = Otlp.layerFetch({
  baseUrl: "https://otlp.example.com",
  serviceName: "quickstart",
  headers: { authorization: "Bearer YOUR_TOKEN" }
})
```

Replace `YOUR_TOKEN` with the token your vendor issued. The endpoint must be an
absolute `http:` or `https:` URL carrying no credentials; anything else refuses
the layer at acquisition rather than failing silently later. See
[Export to an OTLP collector](/guides/export-to-a-collector/) for the rest
of the options.

## Next steps

- [Export to an OTLP collector](/guides/export-to-a-collector/): service
  identity, authentication headers, export cadence, and what happens when a
  collector is down.
- [Instrumentation and export](/concepts/instrumentation-and-export/): why
  the exporter is one layer and what is already instrumented without it.
- [Forward logs to the run journal](/guides/forward-logs-to-the-journal/):
  the second delivery path, durable and readable in process.

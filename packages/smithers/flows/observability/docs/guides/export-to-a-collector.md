---
title: "Export to an OTLP collector"
description: "Wire Otlp.layerFetch into a running program: the collector endpoint, the service identity, authentication headers, export cadence, the shutdown flush, and what happens when the collector is down."
sidebar:
  order: 1
---

`Otlp` posts logs, metrics, and traces to an OTLP/HTTP collector as JSON. This
guide covers the options you set once at startup and the behavior you should
expect from them afterwards.

## Provide the layer

```ts
import * as Otlp from "@smthrs/observability/Otlp"
import * as Effect from "effect/Effect"

const telemetry = Otlp.layerFetch({
  baseUrl: "http://localhost:4318",
  serviceName: "deploy-status"
})

// `program` is your application effect, unchanged from its non-telemetry form.
const outcome = program.pipe(Effect.provide(telemetry), Effect.scoped)
```

The layer is scoped: give it a lifetime with `Effect.scoped`, or build it as
part of a runtime that owns a scope. Signals post below `baseUrl` at
`/v1/logs`, `/v1/metrics`, and `/v1/traces`, so a base URL with a path prefix
is honored: `http://collector:4318/tenant/9` posts to
`http://collector:4318/tenant/9/v1/traces`.

`Otlp.layer` is the same wiring without the `fetch` binding. Use it when the
host must supply its own HTTP client:

```ts
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import * as Layer from "effect/Layer"

const telemetry = Otlp.layer({ baseUrl: "http://localhost:4318" }).pipe(
  Layer.provide(NodeHost.NodeHttpClient.layerUndici)
)
```

## Name the service

`serviceName` and `serviceVersion` become the `service.name` and
`service.version` resource attributes on every exported signal, and they are
how a collector holding several processes tells them apart. Omitted, they fall
back to `Otlp.defaultServiceName` (`flows`) and `Otlp.defaultServiceVersion`
(this package's release version), which is a reasonable default for a Smithers
CLI process and a poor one for your application.

Add deployment facts as `attributes`:

```ts
const telemetry = Otlp.layerFetch({
  baseUrl: "https://otlp.example.com",
  serviceName: "deploy-status",
  serviceVersion: "2.4.1",
  attributes: {
    "deployment.environment.name": "production",
    "service.instance.id": process.env.HOSTNAME ?? "local"
  }
})
```

Attribute values are strings, finite numbers, booleans, or homogeneous arrays
of those. The full bounds are in
[Validation at layer acquisition](../concepts/validated-acquisition.md).

## Authenticate

`headers` is sent with every export request, which is where a vendor token
goes:

```ts
const telemetry = Otlp.layerFetch({
  baseUrl: "https://otlp.example.com",
  serviceName: "deploy-status",
  headers: { authorization: "Bearer YOUR_TOKEN" }
})
```

Read the token from the environment or your secret store. A credential in the
URL is refused: an endpoint carrying userinfo fails layer acquisition. A
credential header (`authorization`, `x-api-key`, `x-honeycomb-team`, and
similar names) over plaintext `http://` is refused too, unless the collector is
on `localhost`, `127.0.0.0/8`, or `[::1]`. Non-credential headers such as a
tenant id work on any endpoint. The check reads header names only, so use
`https://` for every remote collector.

Fetch redirects are refused, including same-origin redirects. Configure the
collector's final URL. Other HTTP transports must refuse redirects themselves.
For fetch options such as `credentials: "omit"`, provide
`FetchHttpClient.RequestInit` around the whole exporting effect:

```ts
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

const outcome = program.pipe(
  Effect.provide(telemetry),
  Effect.provideService(FetchHttpClient.RequestInit, { credentials: "omit" }),
  Effect.scoped
)
```

Options supplied only to the inner HTTP-client layer are replaced by the
redirect policy. Ambient options are retained except `redirect`, which is
always `"manual"`. Redirect responses fail export through the existing failure
handling below; they never forward credentials or signal bodies.

## Control the cadence and the flush

`exportInterval` sets how often all three signals batch and post. Omitted, each
signal keeps Effect's own default. `shutdownTimeout` bounds the final flush
when the layer's scope closes.

```ts
const telemetry = Otlp.layerFetch({
  baseUrl: "http://localhost:4318",
  serviceName: "deploy-status",
  exportInterval: "10 seconds",
  shutdownTimeout: "5 seconds"
})
```

Closing the scope is the deterministic flush. A short program may deliver
nothing on the interval and everything at shutdown, so read what a collector
received only after the scope has closed.

## Turn export off explicitly

`Otlp.layerNoop` provides nothing and exports nothing. It exists so a host that
has no collector, or a browser build that has not opted in, switches layers
rather than branching around a missing provide:

```ts
const telemetry = collectorUrl === undefined
  ? Otlp.layerNoop
  : Otlp.layerFetch({ baseUrl: collectorUrl, serviceName: "deploy-status" })
```

## What happens when the collector is down

Export failure never fails your program, and it never surfaces as a rejected
promise. Effect's exporter retries a transient failure three times, honoring a
`retry-after` response header when one is present, then disables that exporter
for 60 seconds and logs a `Debug` record saying so. Spans and records produced
inside that window are dropped, and delivery resumes afterwards.

Two consequences worth planning for:

- A dead collector is invisible at `Info`. Run at `Debug` while you are
  bringing an exporter up, or watch the collector side.
- A configuration mistake and a collector outage look the same after
  acquisition. That is why the endpoint is decoded before any exporter exists;
  see [Troubleshooting](../troubleshooting.md) when nothing arrives.

## Next steps

- [Test telemetry without a collector](./testing.md): assert on what would have
  been posted.
- [Wire an OpenTelemetry SDK](./wire-an-opentelemetry-sdk.md): when a collector
  endpoint is not enough.
- [Read the runtime metrics](./read-runtime-metrics.md): what the exported
  series mean.

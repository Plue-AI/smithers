---
title: "Installation"
description: "Install @smthrs/observability, its runtime requirements and Effect version, its import forms, and the rule that keeps the root entry point bundling for a browser."
sidebar:
  order: 1
---

## Install the package

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/apps/site/docs/installation.mdx).

The package requires Node.js 26.4.0 or later and ships as both ESM and
CommonJS with TypeScript declarations.

## Pin the same Effect release

Effect services are identified by module identity, so a composition that
resolves two copies of `effect` splits its context and a provided layer stops
satisfying a requirement. Pin `effect` at exactly `4.0.0-rc.115`.

`Otlp` is written entirely against `effect`, including its HTTP client and its
`effect/unstable/observability/Otlp` exporters. The required peers
`@effect/opentelemetry@4.0.0-rc.115` and `@opentelemetry/api@1.9.1`, plus
the logs and metrics dependencies, support
the root `Otel` and `Resource` modules. They install with ordinary peer-aware
package managers. The default install includes no HTTP exporters or trace SDK.

`NodeOtel` selects the optional Node trace SDK and three HTTP exporters:

```bash
pnpm add @opentelemetry/exporter-logs-otlp-http@0.222.0 @opentelemetry/exporter-metrics-otlp-http@0.222.0 @opentelemetry/exporter-trace-otlp-http@0.222.0 @opentelemetry/sdk-trace-base@2.11.0 @opentelemetry/sdk-trace-node@2.11.0
```

`BrowserOtel` selects the optional browser trace SDK instead:

```bash
pnpm add @opentelemetry/sdk-trace-base@2.11.0 @opentelemetry/sdk-trace-web@2.11.0
```

The browser adapter accepts the exporters you supply; those HTTP exporter
packages are not prerequisites for constructing its layer.

## Import forms

The root entry point re-exports seven modules as namespaces:

```ts
import { Endpoint, JournalLogger, Logger, Metric, Otel, Otlp, Resource } from "@smthrs/observability"
```

Each is also importable from its own subpath, which is the form the
[API reference](./api.md) uses:

```ts
import * as JournalLogger from "@smthrs/observability/JournalLogger"
import * as Otlp from "@smthrs/observability/Otlp"
```

`@smthrs/observability/package.json` is exported.

## The two subpath-only modules

`NodeOtel` and `BrowserOtel` are not re-exported from the root, and importing
them by subpath is the only way to reach them:

```ts
import * as BrowserOtel from "@smthrs/observability/BrowserOtel"
import * as NodeOtel from "@smthrs/observability/NodeOtel"
```

`NodeOtel` resolves Node-only host modules: `@effect/opentelemetry/NodeSdk` and
`@opentelemetry/sdk-trace-node`, which reaches the bare `async_hooks` specifier
through `@opentelemetry/context-async-hooks`. Re-exporting it from the root
would put a module a browser bundler cannot resolve in the entry point, and
break the browser bundle the root guarantees. Nothing the root entry point
reaches resolves a `node:` built-in, so it bundles for a browser as it is.

Import `NodeOtel` only from code that runs on Node, and `BrowserOtel` only from
code that runs in a browser. `Otlp` is safe in both, because it exports over
Effect's `HttpClient` and never touches a `node:` built-in.

## What a real composition adds

The exporter alone needs nothing else. Two features have a dependency:

- `Otlp.layer` requires an Effect `HttpClient` from
  `effect/unstable/http/HttpClient`. `Otlp.layerFetch` supplies the host's
  global `fetch` and is the usual choice; a Node host that wants Undici instead
  provides `NodeHttpClient.layerUndici`, re-exported by
  [`@smthrs/platform-node`](/api/platform-node) as `NodeHost.NodeHttpClient`.
- `JournalLogger.layerJournalForwarding` requires a `Journal.Journal` service
  from [`@smthrs/journal`](/api/journal). A durable engine composition already
  provides one.

## Next step

Export your first trace, log record, and metric series in the
[Quickstart](./quickstart.md).

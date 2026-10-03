---
title: "Installation"
description: "Install @smthrs/agent, its runtime requirements, its import forms, and the packages a runnable composition adds."
sidebar:
  order: 1
---

## Install the package

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

The package requires Node.js 26.4.0 or later and ships as both ESM and CommonJS
with TypeScript declarations. Its runtime dependencies, including
[`effect`](https://effect.website) and the `@smthrs/*` packages the agent
composes, install with it.

The agent library selects no browser or Node host adapter. A host composition
declares the platform package it uses; importing the agent does not install
`@smthrs/platform-browser` or its browser filesystem implementation.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Agent, AgentAction, Budget, QuotaPolicy, Seat, SeatResolver } from "@smthrs/agent"
```

Each module is also importable from its own subpath, which is the form the API
reference uses in its examples:

```ts
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Seat from "@smthrs/agent/Seat"
```

Two subpath forms are not public: `@smthrs/agent/internal/*` and
`@smthrs/agent/*/index`. Both are blocked in the package's export map.
`@smthrs/agent/package.json` is exported.

## What a runnable composition adds

The package contains no Node bindings and no platform layer: the QuickJS
sandbox is the browser single-file build, so the same composition runs in Node
and in a browser. A composition that executes a flow adds the durable engine
and the authoring packages, plus a platform crypto service.

- [`@smthrs/engine`](/api/engine) provides the durable engine a run executes
  on. Its `FlowEngine.layerMemory` is the in-memory reference engine used in
  the [Quickstart](./quickstart.md).
- [`@smthrs/flow`](/api/flow) provides the flow and action authoring model.
- [`@smthrs/model`](/api/model) provides the provider-neutral model contract a
  seat streams from.
- [`@smthrs/registry`](/api/registry) provides the flow registry a run is shown
  and its calls resolve against.

A control-plane host adds [`@smthrs/control`](/api/control) and a journal from
[`@smthrs/journal`](/api/journal). The CLI composition in
[`@smthrs/cli`](/api/cli) wires all of this for the `smthrs` commands.

## Next step

Run a typed model-backed step with a scripted model in the
[Quickstart](./quickstart.md).

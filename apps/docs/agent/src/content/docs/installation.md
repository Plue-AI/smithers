---
title: "Installation"
description: "Install @smthrs/agent, its runtime requirements, its import forms, and the packages a runnable composition adds."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/docs/installation.md"
---

## Install the package

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

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

- [`@smthrs/engine`](https://engine.smithers.sh/reference/api/) provides the durable engine a run executes
  on. Its `FlowEngine.layerMemory` is the in-memory reference engine used in
  the [Quickstart](/quickstart/).
- [`@smthrs/flow`](https://flow.smithers.sh/reference/api/) provides the flow and action authoring model.
- [`@smthrs/model`](https://model.smithers.sh/reference/api/) provides the provider-neutral model contract a
  seat streams from.
- [`@smthrs/registry`](https://registry.smithers.sh/reference/api/) provides the flow registry a run is shown
  and its calls resolve against.

A control-plane host adds [`@smthrs/control`](https://control.smithers.sh/reference/api/) and a journal from
[`@smthrs/journal`](https://journal.smithers.sh/reference/api/). The CLI composition in
[`@smthrs/cli`](https://cli.smithers.sh/reference/api/) wires all of this for the `smthrs` commands.

## Next step

Run a typed model-backed step with a scripted model in the
[Quickstart](/quickstart/).

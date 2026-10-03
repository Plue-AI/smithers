---
title: "Installation"
description: "Install @smthrs/engine, the packages it needs beside it, the Crypto service every engine requires, and the subpaths the exports map resolves."
sidebar:
  order: 1
---

## Install

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

`@smthrs/flow` is a runtime dependency of this package and also the package you
author against: `Flow`, `Action`, `DurableDeferred`, `DurableClock`, and
`RetryPolicy` are all declared there. Install it explicitly so your own imports
resolve.

`effect` is the peer everything is built on. This release pins
`effect@4.0.0-rc.115`; install the same version, because two copies of `effect`
in one process split the service context and a flow authored against one
instance is not runnable by an engine holding the other.

Node 26.4.0 or later is required.

## What a real composition adds

The engine alone runs nothing. A program that executes a flow provides four
things, and the type checker names each one it is missing:

| Requirement                  | Where it comes from                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `FlowRuntime.FlowRuntime`    | `FlowEngine.layerMemory` here, or `EngineStore.layer` from [`@smthrs/engine-store`](/api/engine-store) for durability. |
| The flow's registration      | `Interpreter.layer(flow)` from `@smthrs/flow`, once per flow you execute.                                              |
| Each action's implementation | `action.toLayer(...)`, collected by `Action.layerImplementations`.                                                     |
| `Crypto.Crypto`              | A platform crypto layer, such as `NodeCrypto.layer` from `@effect/platform-node`.                                      |

The `Crypto` requirement is not optional and it is not only a durability
concern. Every action dispatch is recorded under a derived step identity, and
deriving it is a SHA-256, so the in-memory engine needs a crypto service too. A
browser program provides its own; a Node program provides
`@effect/platform-node`:

```bash
pnpm add @effect/platform-node@4.0.0-rc.115 @effect/platform-node-shared@4.0.0-rc.115
```

`@effect/platform-node` supplies the runtime `Crypto` service used by every
action dispatch, so install it in your application's `dependencies`.

## Compensable actions

An action declared `tier: "compensable"` also requires
`FlowEngine.SnapshotBoundary` in context. This package declares the service and
ships no implementation, because snapshotting a workspace is a host concern.
`@smthrs/engine-store` supplies one backed by a Jujutsu repository. See
[Run a compensable action](./guides/compensable-actions.md).

## Import forms

The exports map resolves four subpaths and nothing deeper:

| Import                           | Source                               |
| -------------------------------- | ------------------------------------ |
| `@smthrs/engine`                 | `src/index.ts`, the three namespaces |
| `@smthrs/engine/FlowEngine`      | `src/FlowEngine/index.ts`            |
| `@smthrs/engine/FlowProxy`       | `src/FlowProxy.ts`                   |
| `@smthrs/engine/FlowProxyServer` | `src/FlowProxyServer.ts`             |

`./FlowEngine/*`, `./internal/*`, and `./*/index` are `null` in the map, so
`@smthrs/engine/FlowEngine/make` does not resolve. Both forms below are the
same value:

```ts
import { FlowEngine } from "@smthrs/engine"
import * as FlowEngineDirect from "@smthrs/engine/FlowEngine"

const sameLayer = FlowEngine.layerMemory === FlowEngineDirect.layerMemory
```

The package publishes ESM and CommonJS builds along with its TypeScript source,
so a consumer can step into the runtime it is debugging.

## Next

[Quickstart](./quickstart.md) assembles all four requirements into one runnable
program.

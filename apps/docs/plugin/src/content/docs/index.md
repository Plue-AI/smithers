---
title: "@smthrs/plugin"
description: "A typed, bounded plugin kernel for Effect programs: Vite-style hooks and ordering, a config waterfall, and a resolution boundary that copies every value a caller hands it."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/plugin/docs/README.md"
---

`@smthrs/plugin` lets a TypeScript program accept plugins written by other
people. You name the extension points your program offers, a plugin author
hands you a plain record of handlers, and the kernel turns that list into an
ordered, immutable catalog you dispatch against.

It is Vite's plugin model, typed end to end and bounded at every edge: a plugin
is a plain record, a hook is an ordinary [Effect](https://effect.website),
ordering follows Vite's rules exactly, and no value a caller passes in survives
as a live reference into dispatch.

## What it solves

An extensible program has to answer five questions before its first plugin
runs: which plugins are selected, what order their handlers run in, what a
handler may return, what a failing handler does to the caller, and whether a
plugin can change any of that after startup. This package answers all five, and
refuses the input that would leave one of them undecided:

- **Selection** is the `apply` field: a host target, or a predicate over the
  configuration.
- **Order** is Vite's rule kept verbatim. `enforce` sorts the plugin list once,
  and a per-hook `order` re-partitions it for a single hook.
- **Result and failure** come from the hook's kind. `sequential`, `parallel`,
  `first`, and `waterfall` each promise something different, and the kind is
  checked in the type system and again against the host's runtime catalog.
- **Change after startup** is not possible. Resolution copies every plugin
  record, hook object, and configuration value it accepts, so dispatch never
  reads memory a caller still holds.

Reach for it when you are the host: you have a composition, you want other
people's code inside it at named points, and you would rather refuse a
malformed plugin at startup with an error code and a value path than debug it
in production.

## The hook catalog is yours

The kernel owns one catalog of its own, the two-step config lifecycle (`config`
and `configResolved`). Every other hook belongs to a host. You declare your
hooks with TypeScript module augmentation, hand the kernel the matching runtime
catalog, and dispatch that catalog and nothing else. The `FlowsHooks` interface
is open for augmentation and closed for dispatch, so another host augmenting
the same interface still dispatches only the hooks it supplied.

A plugin author writes a record with a `name` and some `hooks`. There is no base
class, no registration call, and no inheritance.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

Node.js 26.4.0 or later is required. For the runtime requirements, the import
forms, and the subpaths the export map blocks, see
[Installation](/installation/).

## The shortest real example

A plugin contributes a configuration namespace, and a second hook reads the
resolved result back:

```ts
import { type FlowsPlugin, Kernel } from "@smthrs/plugin"
import { Effect } from "effect"

const feature: FlowsPlugin = {
  name: "flows-plugin-feature",
  hooks: {
    config: () => Effect.succeed({ feature: { enabled: true } }),
    configResolved: (config) => Effect.log(`feature enabled: ${config["feature"] !== undefined}`)
  }
}

const kernel = await Effect.runPromise(Kernel.make([feature]))
```

`Kernel.make` gives you four things:

- `kernel.config` is the frozen, deeply copied configuration every plugin
  agreed on.
- `kernel.plugins` dispatches hooks.
- `kernel.layer` is every plugin's Effect services merged in resolved order.
- `kernel.observerErrors` holds the failures that `configResolved` observers
  reported without failing startup.

## Where this sits in Smithers

This package is the mechanism, not a host: on its own it dispatches only the
config lifecycle. The shipped host is [`@smthrs/agent`](https://agent.smithers.sh/reference/api/), the
Smithers agent loop, which augments `FlowsHooks` with three waterfall hooks of
its own (`cellRegistry`, `cellFlows`, and `cellModelRequest`), passes the
matching runtime catalog with `target: "harness"`, and dispatches them around
each frame of an agent cell. If you want to extend the Smithers agent rather
than build a host of your own, read that package first: its hooks are the ones
your plugin declares, and this package explains what those hooks promise.

Both sit under the `smthrs` command line, [`@smthrs/cli`](https://cli.smithers.sh/reference/api/), which runs
and inspects the durable flows a Smithers installation is made of. Start there
for the whole picture.

The kernel depends on [`@smthrs/flow`](https://flow.smithers.sh/reference/api/) for the
`Action.CacheEnvironment` schema used to
[declare a cache identity](/guides/cache-identity/), and
[`@smthrs/canonical`](https://canonical.smithers.sh/reference/api/) for immutable catalog maps.

## What this package does not do

The kernel is not an engine lifecycle registry. Retry, storage, concurrency,
cache, wait, journal, and ownership policy stay on the Effect service or
constructor option that applies them. Configuration refuses the root keys
`engine`, `retry`, `store`, and `plugins` so that a configuration file cannot
imply otherwise.

## Where to go next

- [Installation](/installation/) for the runtime requirements, the import
  forms, and the subpaths that are not public.
- [Quickstart](/quickstart/) to build a host with its own hook, run it, and
  read a typed result.
- [Hook kinds](/concepts/hook-kinds/) for what each of the four dispatch
  shapes promises.
- [Resolution](/concepts/resolution/) for how a plugin list becomes an
  ordered, immutable catalog.
- [Configuration](/concepts/configuration/) for the config waterfall and the
  JSON boundary it enforces.
- [API reference](/reference/api/) for every export, with signatures and limits.
- [Troubleshooting](/troubleshooting/) for each `PluginError` code, what
  causes it, and what to change.

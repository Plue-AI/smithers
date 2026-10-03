---
title: "Quickstart"
description: "Build a host with a hook of its own: declare the catalog, write two plugins, run the kernel, and dispatch the hook to a typed result."
sidebar:
  order: 2
---

This quickstart builds a small host end to end. The host offers plugins one
extension point of its own, a `tools` waterfall, alongside the kernel's config
lifecycle. By the end you will have run the kernel, read a frozen configuration,
and dispatched a hook whose result is typed by the declaration you wrote.

The example uses two files: `host.ts` declares the hook catalog, and `main.ts`
defines the plugins and runs the host. There are no services to provide.

## Prerequisites

- Node.js 26.4.0 or later.
- A TypeScript project with the package installed. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

## Declare the host's hook catalog

A host declares its hooks twice: once in the type system, so plugin authors get
completion and excess-key errors, and once as a runtime catalog, so the kernel
can refuse a hook name nobody dispatches.

Create `host.ts`:

```ts
import { engineHooks, type WaterfallHook } from "@smthrs/plugin"
import type * as Effect from "effect/Effect"

declare module "@smthrs/plugin" {
  interface FlowsHooks {
    /** Contributes or rewrites the tool names the host offers. */
    readonly tools: WaterfallHook<
      (tools: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string> | void>
    >
  }
}

/** The runtime catalog: the kernel's two config hooks plus this host's one. */
export const hooks = Object.freeze(
  {
    ...engineHooks,
    tools: "waterfall"
  } as const
)
```

The two declarations must agree. The interface says what compiles; the runtime
catalog says what dispatches. `WaterfallHook` in the interface and
`"waterfall"` in the catalog are the same claim, written for the two audiences.

## Write two plugins

Add all remaining TypeScript snippets to `main.ts` in order, starting with the
complete import block and the first plugin.

A plugin is a record. This one contributes a configuration namespace and two
tools.

Create `main.ts` beside `host.ts`:

```ts
import { type FlowsHooks, Kernel, make } from "@smthrs/plugin"
import * as Effect from "effect/Effect"
import { hooks } from "./host.ts"

const editor = make<FlowsHooks>({
  name: "flows-plugin-editor",
  hooks: {
    config: () => Effect.succeed({ editor: { readOnly: false } }),
    tools: (tools) => Effect.succeed([...tools, "read", "write"])
  }
})
```

`make` is an identity function that pins the literal to `FlowsPlugin<H>`. Pass
the hook interface explicitly, as above: it is what types the `tools` parameter
as `ReadonlyArray<string>` and what makes a misspelled hook key fail at the
definition site instead of at startup.

The second plugin runs first, because it is declared `enforce: "pre"`, and it
reads what the host resolved rather than adding to it:

```ts
const audit = make<FlowsHooks>({
  name: "flows-plugin-audit",
  enforce: "pre",
  hooks: {
    configResolved: (config) => Effect.log(`resolved namespaces: ${Object.keys(config).join(", ")}`)
  }
})
```

## Run the kernel

`Kernel.make` takes the plugin list, the pre-resolution configuration, and the
host's options. It resolves the list, runs the config waterfall, freezes the
result, notifies the observers, and merges the plugin layers:

```ts
const kernel = await Effect.runPromise(
  Kernel.make([editor, audit], { host: { name: "quickstart" } }, { target: "harness", hooks })
)

console.log(kernel.config)
// { host: { name: "quickstart" }, editor: { readOnly: false } }
```

`target` names which kind of host you are, and it is what a plugin's
`apply: "engine" | "harness"` selector is compared against. It defaults to
`"engine"`, meaning the Smithers durable engine, so pass `"harness"` for any
other host, including this one.

## Dispatch the hook

`kernel.plugins` is the dispatcher. A waterfall needs one more argument than the
other kinds, the merge function that folds each handler's answer into the value
the next handler sees:

```ts
const tools = await Effect.runPromise(
  kernel.plugins.waterfall("tools", [] as ReadonlyArray<string>, (_previous, next) => next)
)

console.log(tools) // ["read", "write"]
```

The literal `"tools"` is checked against the hook interface: a name that is not
a waterfall in `FlowsHooks` does not compile, and `tools` is typed as the
handler's argument type, not as `unknown`.

## What you just built

- A hook catalog only your host dispatches. Another host augmenting the same
  interface still dispatches only the catalog it supplied.
- A plugin list resolved once into a frozen catalog. Mutating `editor` after
  this point changes nothing about dispatch.
- A configuration every plugin agreed on, deeply copied and frozen before the
  first plugin saw it.

## Next steps

- [Hook kinds](./concepts/hook-kinds.md) for what `sequential`, `parallel`,
  `first`, and `waterfall` each promise.
- [Control the order handlers run in](./guides/order-handlers.md) for `enforce`
  and the per-hook `order`.
- [Contribute services from a plugin](./guides/contribute-services.md) to add a
  `layer` to the plugin above.

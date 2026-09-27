---
title: "Grant authority to MCP tools"
description: "Why every projected tool declares every host action, what the cell boundary does with that declaration, and how a host narrows it to the authority it actually grants this server."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/mcp/docs/guides/grant-authority-to-mcp-tools.md"
---

A projected source is not yet callable. The declaration `McpFlows` puts on every
tool is the widest one the vocabulary can express, and a host has to decide what
it actually grants this server before a cell can use it.

## What the adapter declares

`McpFlows.capabilities` is one exact `namespace:operation:resource` string per
host action, at resource `**`:

```ts
;[
  "fs:read:**",
  "fs:write:**",
  "net:get:**",
  "net:post:**",
  "model:call:**",
  "memory:read:**",
  "memory:write:**",
  "proc:spawn:**",
  "jj:status:**",
  "jj:diff:**",
  "jj:snapshot:**",
  "jj:restore:**",
  "jj:workspace-add:**",
  "jj:workspace-forget:**",
  "jj:root:**",
  "jj:revert:**",
  "jj:op-restore:**"
]
```

The list is derived from `Capability.Action.literals` and frozen, so a new
action in [`@smthrs/capability`](https://capability.smithers.sh/reference/api/) is included automatically
rather than silently omitted.

This is the honest declaration, not a convenience. An MCP tool is opaque code
the adapter does not control, so "everything the vocabulary can name" is what it
can truthfully say it might do.

## Why it is not a wildcard

The cell boundary reads each declared capability with `Capability.parse`, which
accepts exactly three colon-separated components and answers nothing for
anything else. A declaration it cannot parse counts as unauthorized.

So a bare `"*"` does not mean "everything". It parses as nothing, and every MCP
tool carrying it is refused with `capability_refused` before it runs, under
every envelope including an unrestricted one. Enumerating the actions is what
makes the declaration readable to the boundary at all.

## Narrow it where the trust decision is made

What a given server may do depends on which server you connected and why, which
is a host decision, not an adapter one. Re-declare the source's flows under the
capabilities you grant:

```ts
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Descriptor from "@smthrs/registry/Descriptor"
import { Effect } from "effect"

/** Re-declares a source's flows under the capabilities this host grants them. */
export const granting = (
  source: FlowBinding.Source,
  capabilities: ReadonlyArray<string>
): FlowBinding.Source => ({
  name: source.name,
  bindings: () =>
    Effect.map(source.bindings(), (bindings) =>
      bindings.map((binding) => ({
        descriptor: new Descriptor.FlowDescriptor({ ...binding.descriptor, capabilities }),
        run: binding.run
      })))
})
```

Then grant exactly the authority this server needs, and put the same string in
the run's envelope:

```ts
const grant = `proc:spawn:mcp/${serverName}`

const source = granting(McpFlows.mcp(client), [grant])
const envelope = [
  new Capability.CapabilityPattern({ action: "proc:spawn", resource: `mcp/${serverName}` })
]
```

Narrowing the declaration is better than widening the envelope. An envelope of
`*:*` grants the whole run everything; this grants exactly the tools of exactly
this server. A runnable version of this composition is in the Smithers
repository, at
[`examples/src/22-mcp-tools.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/22-mcp-tools.ts).

## What a refusal looks like

Under an envelope that does not cover the declaration, the boundary refuses
before dispatch, and nothing reaches the server. Under a read-only envelope of
`fs:read:**`, a cell calling a projected tool gets `capability_refused` naming
`fs:write:**`, the first declared capability the envelope does not cover.

That refusal is the boundary's, not the adapter's: the tool never ran, and no
process was contacted.

## The effect envelope

Every projected flow also declares `McpFlows.effects`:

```ts
{ reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" }
```

`onConflict: "serialize"` means two MCP calls in one run do not overlap.
`tier: "irreversible"` means the engine treats a call as unreplayable, and is
also why an abandoned call is cancelled rather than left in flight. Both are
conservative for the same reason the capability list is.

## Next

- [A remote tool as a flow](/concepts/tools-as-flows/): the rest of what a
  binding declares.
- [Handle a failed tool call](/guides/handle-a-failed-tool-call/).

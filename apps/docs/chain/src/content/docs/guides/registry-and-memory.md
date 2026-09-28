---
title: "Project the registry and bind memory"
description: "Project repository-discovered flows into the catalog with RegistryCatalog, and bind remember/recall with MemoryEntries."
sidebar:
  order: 6
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/chain/docs/guides/registry-and-memory.md"
---

Two namespaces compose the catalog with the wider world: `RegistryCatalog`
projects the [@smthrs/registry](https://registry.smithers.sh/reference/api/) flow registry into entries,
and `MemoryEntries` binds the [@smthrs/memory](https://memory.smithers.sh/reference/api/) package's
`remember` and `recall` flows as two entries.

## Project the registry

`RegistryCatalog.layer` renders the registry's descriptors as catalog entries
at layer construction. Projection, not fusion: the registry stays the owner
of discovery, naming, warnings, and lazy bodies.

```ts
import { RegistryCatalog } from "@smthrs/chain"
import { Effect, Layer } from "effect"

const catalog = RegistryCatalog.layer({
  implementations: new Map([
    ["build", (payload) => Effect.succeed({ ok: true })]
  ]),
  prompt: (rendered, descriptor) => runSubAgentSeat(rendered, descriptor),
  visible: (descriptor) => descriptor.name.startsWith("repo/")
}).pipe(Layer.provide(registryLayer))
```

Only CALLABLE descriptors are projected, so the model's catalog never
discloses a call that is guaranteed to refuse:

- A module-bodied flow needs a host `Implementation` in
  `Options.implementations`. Binding an implementation for a name the
  registry does not know is a host configuration defect and dies at
  construction.
- A markdown-bodied flow needs `Options.prompt`, a `PromptRunner` that
  executes the rendered prompt (the seam a sub-agent seat fills). Without
  one, markdown flows are not projected at all. The payload is `{ args: string }`
  or a bare string.

`Options.visible` filters which descriptors project (default: the registry's
own `visible()`), and `Options.entries` appends host extras. Precedence when
names collide: registry projection, then host extras, then the system
entries, later wins, so `sys/now` and `sys/random` can never be shadowed.

Each projected entry pins `RegistryCatalog.declarationDigest`, re-exported
from `@smthrs/registry`, which owns `FlowDescriptor`. It is the canonical
digest of the descriptor's full declaration: every top-level field except
`provenance.pack`, with `capabilities` sorted. Redeclaring a flow on any of
those axes changes what every call key pins. A
markdown call also re-checks the digest at call time: a refreshed registry
carrying a different declaration under the same name fails the call with a
`CallError` telling you to rebuild the catalog, so the journaled entry digest
never lies about what actually ran.

## Bind memory

`MemoryEntries.layer(policy)` mounts a whole catalog of the two memory
entries, composed with the system entries; `MemoryEntries.make(policy)`
returns just the entries, for composing with your own:

```ts
import { MemoryEntries } from "@smthrs/chain"
import { Layer } from "effect"

const policy = { banks: ["worldview"], maxTokens: 2000, retain: "on-complete" } as const
const catalog = MemoryEntries.layer(policy).pipe(Layer.provide(memoryServices))
```

The policy is the `WithMemory.Policy` from [@smthrs/memory](https://memory.smithers.sh/reference/api/),
and it is the authority on banks. A script is model-authored, so a bank in
its payload that the policy does not name fails with cause
`invalid_namespace` before the store runs; an empty bank means the policy's
own. Each remembered fact records the chain, link, and call ordinal that
wrote it as provenance.

The layer needs `MemoryStore.MemoryStore` and `Recall.Recall` from
[@smthrs/memory](https://memory.smithers.sh/reference/api/); exactly those two services are captured, so
call-time provisions of anything else are never shadowed. The entries ship
under the memory package's own names (`remember` and `recall`), descriptions,
and input/output schemas. Payloads and results are held to those schemas: a
malformed payload fails with cause `invalid_input` quoting the actual parse
failure, a result outside the output contract fails with `invalid_output`,
and a store failure carries the memory package's stable error code as the
call's `cause`.

Each entry's digest is `MemoryEntries.contractDigest` over the shipped
contract, so a memory-package upgrade that changes the contract re-keys every
call that names it instead of replaying stale results.

One composition rule: hosts that also mount the memory flows through the
registry must bind them there OR here, not both. A catalog holding two
`remember` declarations discloses one and runs the other, and journals
written under the registry's digest refuse to resume against this door's
digest.

For what the digests guard on resume, see
[Keyed replay](/concepts/keyed-replay/). For entry anatomy, see
[Write catalog entries](/guides/catalog-entries/).

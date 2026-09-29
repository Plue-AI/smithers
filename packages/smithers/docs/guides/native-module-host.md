---
title: "Native module hosts"
description: "Run registered project modules through the existing control executor."
---

A discovered module delegates to a host-registered `@smthrs/flow` flow.
`Executable.Catalog` supplies that mapping. The control executor validates the
approved descriptor digest and delegate before accepting the launch, and
validates them again when its body resumes. A module needs no model seat.
Prompt flows retain the existing agent path.

## Host configuration

The optional final `modules` argument is an extension of the existing
`NodeControl.layerExecutor`, `layerControl`, and `layer` APIs.
`NodeControl.ModuleRegistration` names its layer type. It supplies the existing
`Executable.Catalog`; it does not introduce a registry service or gateway RPC.

```ts
import * as NodeControl from "@smthrs/cli/NodeControl"
import { Interpreter } from "@smthrs/flow"
import * as Executable from "@smthrs/registry/Executable"
import { Layer } from "effect"
import { Implement, implementationLayer } from "./implementation.ts"

const modules: NodeControl.ModuleRegistration = Executable.layer({
  delegates: [Implement]
}).pipe(
  Layer.provideMerge(Interpreter.layer(Implement)),
  Layer.provideMerge(implementationLayer),
  Layer.orDie
)

const host = NodeControl.layer({ root: "/workspace/repository" }, modules)
```

The host builds registrations after the native engine has opened and migrated
its existing database. Registration receives guarded filesystem and process
services. A supplied catalog must contain an executable with the exact
approved descriptor identity. An absent catalog leaves module launches pending;
a configured catalog that refuses a module produces a typed launch refusal.

The module runs as one ordinary child of the existing `agent/run` execution.
Its execution ID derives from the control run and approved descriptor digest.
This is engine invocation identity, independent of repository change identity.
Native child edges, action outcomes, waits, and cancellation remain owned by
the existing flow engine. The control executor keeps its current settlement,
approval, resume, and cancellation behavior.

## Authority after restart

A child may resume on a scheduler fiber or in a new process. A launch-time
Effect context therefore cannot establish its lasting permission ceiling.
The private `ModuleAuthority` registration wrapper follows persisted parent
edges and trampoline predecessors to the owning control run on every handler
entry. It verifies the native `agent/run` wrapper's recorded run/plan identity,
requires one active owner and its approved plan, and revalidates the catalog,
descriptor identity and pinned source body before each handler runs. Missing,
ambiguous, or excessively deep ancestry refuses execution. Caller-supplied IDs
and payload fields do not establish ownership.

Module layer construction receives only the selected memory services from the
host memory context. A typed `Effect.context` capture still contains every
ambient service; forwarding that whole context would replace the approved
registration runtime with the raw engine. Exported round interpreters and
detached children therefore register through the same authority wrapper.
Source identity checks run in the captured host context: reading the approved
module for verification does not require granting filesystem access to its
actions. The handler still executes under the approved capability ceiling.

Each handler intersects its capabilities with the approved envelope. Concurrent
descendants **in one executor** share one existing `Budget` service, retained with Effect `RcMap`
while in use. Accounting attributes usage to the control ancestor and qualifies
step identities by native execution, so identical local step names in siblings
cannot collapse their costs. Reacquisition recovers the existing journal's
usage. This adds no table, alternate receipt ledger, or durable cache.

Only the executor service leaves native runtime composition. Its engine journal
and run store must not shadow the control journal and run store. The control
graph is materialized before native registration to avoid memoizing a shared
layer constructor against the wrong database.

`AgentSession` can consume an optional existing `Executable.Catalog` service in
other host compositions. Such compositions must restore approved authority at
every independently resumed native handler; the Node host supplies that policy.

## Limits

The configured host must have one active executor per workspace. `Budget` is
not a distributed reservation service: two processes running different
children could each reserve the same allowance. The cloud workspace service
therefore holds a guest OS lock for the host's whole lifetime, before runtime
startup. The lock is deployment configuration, not a core Node/Bun dependency.
A host enabling these registrations elsewhere must enforce the same constraint.
This does not make the forecast allowance a hard provider billing cap.

Descriptor/source validation follows the existing registry identity contract;
it does not hash arbitrary imported host delegate code transitively. Deployments
must keep their registered implementation build pinned for active runs.

Registration is trusted deployment configuration. The gateway cannot upload
arbitrary executable registrations. Catalog discovery alone does not provide
an implementation for a named delegate, and a successful flow result does not
prove an external deployment or check passed. Those require actual recorded
receipts from their owning actions.

The native runtime's final registration receives the native execution journal. ModuleAuthority intentionally records root budget usage there; AgentSession control transitions use the separate captured control journal. Shared root budget accumulators have host-scoped ownership, without an arbitrary root-count cap. Authority validation wraps registered execution outside the action retry ladder: a refusal settles as a failure instead of being silently retried as an action.

Detached module children remain under their approved active root and share its
budget. Source edits require the host's configured catalog refresh or a restart;
stale descriptor/delegate digests refuse adoption until the matching executable
is registered. Observing commands leave parked module roots untouched.

The shared private native composition selects existing Node or Bun adapters, including their own SQLite drivers and HTTP servers. See [native host composition](../../NATIVE-CONTROL.md) for platform and lifetime boundaries.

Native ModuleRegistration also receives the existing AgentAction.Host service. The composition builds it from the same guarded filesystem/shell/memory sources, registry and finite cell limits used by AgentSession. A recipe can therefore register an AgentAction layer without constructing another tool stack. Existing registrations that do not consume Host remain valid.

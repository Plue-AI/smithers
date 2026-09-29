---
name: smithers-flow-registry
description: Change flow discovery, SKILL.md/flow.mdx registration, workflow packs, or executable catalog refresh.
---

# Flow registry

Read [the registry README](../../../packages/smithers/agent/registry/README.md) and [filesystem router README](../../../packages/smithers/agent/fs/README.md) before changing discovery or command projection. A flow directory has one entry file: `flow.ts`, `flow.mdx`, or `SKILL.md`; the descriptor records source and digest without importing its body. Registry `list` and `warnings` read one metadata snapshot. Do not execute a discovered flow to answer a catalog listing.

Executable registration is a separate boundary that loads the selected body, resolves its delegate, and supplies runtime layers. A TypeScript module may export `layer` beside its default flow; build its action implementations once in the scoped host context, retain named load refusals for unavailable services, and provide the built context to both flow registrations. The host owns the action table: modules export `Declared.toLayer` / `AgentAction.layer` directly, without providing `Action.layerImplementations`. Preserve warning receipts for refusals and the refresh path for edited entries. A host must provide services required by delegate success/error codecs even when the catalog erases their static requirements. Pack entries retain provenance and path confinement; verify name precedence, stale descriptors, and an edit during refresh in tests.

`@smthrs/fs` command listing is metadata-only, but its first Incur help/OpenAPI/MCP projection imports visible modules to publish input schemas. Keep that distinction explicit when claiming a discovery path runs no user code.

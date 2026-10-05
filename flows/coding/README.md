# Coding progression

This repository recipe expresses the coding policy as ordinary `Flow.make`,
`Action.make`, and Effect layers. The existing flows runtime stores the plan,
action outcomes, child execution relationships, and replay state through its
injected database. There is no coding database, queue, lease, or event store.

`native.ts` is the private Effect adapter to the Plue-owned program installed by
the existing sandbox head-reporter provisioning. The host merges `nativeActions`
into its current action table and provides
`nativeLayer({ repositoryPath: executionRoot })` through its existing injected
`ChildProcessSpawner`. Both Node and Bun run that composition. The TypeScript
file contains no JJ command implementation, HTTP credential, or native receipt
store. A host without the installed adapter fails clearly when it calls it.

The new **internal** `NativeCoding` Effect service exposes `read(changeIds?, historyLimit?)` and
`apply(operation)`; ordinary `ReadNative` and `ApplyNative` actions record those
requests/results in the existing flow. For example, after reading an exact
resolved revision in a recorded planning step:

```ts
ApplyNative.call({
  operation: {
    operation: "create",
    requestId: requestIdFor(executionId, "create/database"),
    expectedOperationId: parent.operationId,
    target: parent,
    description: "✨ feat(database): add the schema"
  }
})
```

`requestIdFor` derives a stable invocation UUID from the existing execution ID
and action key. It never identifies an atom. On an unknown outcome, replay the
**original** request, including its exact parent and operation IDs; rereading
`@` to manufacture a new request could duplicate an already committed mutation.
Plue reconstructs native receipts at their historical operation view even after
later edits. A conflicted revision has native `treeTerms`, no `treeId`, and must
not pass fast acceptance. `unchanged` is not a durable mutation receipt.

Local accepted results carry `provenance: "pending"`: the existing head reporter
asynchronously projects native operation metadata into Plue's `jj_operations`.
This service cannot assert that the cloud acknowledged it or that all rewritten
descendants were published. The publisher exports only `@`; after an older edit
the workflow must explicitly `edit` back to its known mythical tip. The installed
identity names the effective workspace execution principal. The initiating user
of a shared run remains separately attributed by the control journal, and is not
overridden by arbitrary flow input.

`ImplementPlan` predicts one linear sequence of product Changes. A Change groups
native JJ changes; an atom's `changeId` is the JJ ID and remains stable when its
commit is rewritten. A planned new atom has `changeId: null` until JJ creates it.
`Revision` records JJ change, commit, tree, operation, and parent commit IDs.
The product Change's `id` is a grouping label, not another identity for an atom.

A Change carries every required check the repository has, which may be one or
none. Fast receipts gate
the next implementation. Slow checks run alongside subsequent Changes. Required
delivery checks are deferred to the later vibing/landing workflow. Implementation
evidence must form a single parent chain from the exact supplied parent, retain
existing atom identities, and end at the reported head. Check receipts identify
the target, JJ commit/tree and measured input digest; a receipt for a previous
revision cannot unlock progression. A late finding names its owning Change and
the actual reviewed commit, so a downstream discovery can request an earlier fix.

`Check.flow` and `Change.implementation` name the host's existing registered
project flows. Those flows perform the actual native JJ and build operations and
return the schemas in `schema.ts`. Plans pin `flowDigest` and
`implementationDigest` from the registry's existing `Descriptor.executionDigest`
before execution. The catalog refuses a changed definition, and replanning starts
a new execution. Reopening a completed execution shows its original planned
definition and receipts; it does not silently substitute current code.

`Receipt.inputDigest` must equal `checkInputDigest(implementation, check)`, the
existing canonical SHA-256 digest of the exact delegated inputs including the
pinned definition. A native build's additional artifact/environment evidence
belongs in `evidence`; this fingerprint alone is not proof that a test ran.
The catalog adapter derives child execution
identity from the full payload and the registry's verified executable digest.
The ordinary runtime attaches the ambient parent and recovers completed children
after restart. It refuses unavailable or unverified project flows.

## Host composition

The private [`coding/request`](request.md) entry accepts a prompt, gathers
current source and native history, prepares a plan, admits its observed source,
and performs bounded owner correction. A separate `coding/prototype` entry
produces a disposable [source prototype](poc.md) without implementation or
landing. A real fix does not require a prototype first.

The [`coding/dispatch`](dispatch.md) entry runs exactly one agent turn: a
prompt, a bounded session window, the seat role and model for that request,
and the assistant messages the turn produced. It is registered
unconditionally and, unlike `coding/request`, needs no memory and no check
table.

`planning.ts` provides `PreparePlan`: bounded source gathering, request review,
optional durable clarification, a model draft, and source verification before
binding the existing `Plan` schema. See [planning.md](planning.md) for context
shapes, native-history windows and deployment authority.

`PrepareRequest` plans; it never generates the wiki. A stack request carries
the stack's published wiki pages, and any other request with the operator's
`planning.wiki: true` reads the host's own verified snapshot when one exists.
Only pages whose inputs still hash to the source are used, ranked by the
existing keyword scorer; without them planning proceeds on source and history.
The stack service refreshes the wiki with `coding/wiki` after every fold; see
[planning-wiki.md](planning-wiki.md). Ordinary native JJ history remains part
of every coding plan.

`registration.ts` is private repository configuration, not a new package API.
Provide the host's existing executable catalog to `registration` and pass the
registration to the host runtime. The discovered `flow.ts` IS the flow: it
default-exports `coding/ImplementPlan`, which takes `{ plan }` and needs no
delegate registration. The native flow is also directly callable from another
registered flow:

```ts
import { ImplementPlan } from "./workflow.ts"

// Inside an Effect scope with the deployment's runtime and action layers.
const result = yield* ImplementPlan.execute({ plan })
```

The recipe and catalog adapter import no Node or Bun APIs. Deployments inject
their platform through `@smthrs/flows/Runtime`, `NodeRuntime`, or `BunRuntime`.
The test file also uses Node's test runner, assertion helpers, and fixture APIs.
Do not introduce a Node sidecar as a requirement for a Bun desktop host.

## Current boundary

`implementation/flow.ts` supplies the concrete native implementation, discovered
as `coding/implementation` and default-exporting `coding/ImplementAtoms`. Merge
`atomFlows`, `atomOperations`, `nativeActions`, and `EditAtom.layer` into the
host's existing action table; `atoms.ts` holds the actions they carry. The host supplies its
ordinary `AgentAction.Host`, guarded filesystem tools, seat resolver (the
`coding/implement` role), budget and native adapter. No model transport or
runtime is constructed in this recipe.

Each atom journals its exact prepared native request before applying it, enters
the native change, runs the agent, snapshots finished edits, and applies the
planned message. Existing atoms are edited in place; JJ restacks their native
descendants. The edit report is an explicit graph dependency of snapshot
preparation. The head reporter may capture completed file writes before that
snapshot without changing ownership. A changed parent, conflicted tree, or
different working-copy identity refuses acceptance. Reads/writes in the agent
report are explanatory observations, not a security boundary or test evidence.

Native reads and mutations retry lock contention, unknown responses and the
installed guest's transient subprocess-failure envelope twice with
the exact original request before recording a terminal failure. Request IDs
include the product Change, ordinal and phase, so multiple inlined Changes do
not collide. Revision conflicts refuse acceptance and require replanning; they
never refresh an expected revision silently. These are private recipe contracts.
An oversized response is terminal because replay would return the same oversized
receipt. Inline implementations require a known atom list; a parent revision can
be an upstream planned value and is resolved through the graph before mapping.

A real JJ/SQLite test creates two atoms with actual file writes, reopens and
replays the run without editing again, amends the older atom, verifies the later
atom retains its JJ ID with a new parent/commit and correct files, and refuses
an incorrectly parented edit. It also recovers a lost acknowledgement after a
real mutation, retries lock contention, implements two inlined Changes without
ID collisions, and refuses to retry a revision conflict. The agent in this test is scripted; a live model
and complete production host still require the configured composition.

`ImplementPlan` remains a single implementation pass. Its result is `validated`
or `changes-requested`. The higher-level [CorrectPlan](correction.md) workflow
selects the earliest owning Change, preserves its native atom IDs, edits and
restacks through JJ, and reruns checks for the invalidated suffix within a
bounded round limit. Missing or stale evidence cannot count as validation.
History cleanup, marking work vibed, appending to main and shipment still need
subsequent ordinary workflow stages. A receipt schema alone does not prove that
an arbitrary delegate performed a real test: deployment adapters must measure
their native results rather than trust agent assertions.

Ten integration tests exercise a real native flows runtime with SQLite and JJ
fixtures: fast failure, stale receipt, wrong parent, earlier-owner feedback,
overlapping slow review, preflight refusal, and registered child replay across a
host restart. Review regressions also reject changed executable definitions,
different check inputs, inconsistent complete revision fields, and atom identities
reused by nonadjacent Changes. Implementation/check fixtures are scripted; these tests establish
graph and durability behavior, not live coding capability.

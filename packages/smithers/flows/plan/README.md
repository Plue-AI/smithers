# @smthrs/plan

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://plan.smithers.sh

The persisted plan: a keyed action graph, its append-only store, its diff, and
the step-key compiler that gives every node its identity.

`@smthrs/plan` turns a description of work into one durable value. It compiles
declared steps into a graph in which every node carries a content key derived
from what that node declares, records that graph in a SQLite store that only
ever grows, and compares two graphs to say exactly what changed. It runs
nothing itself: it performs no I/O beyond the database, and driving a compiled
plan is a scheduler's job, such as
[`@smthrs/engine-store`](https://engine-store.smithers.sh)'s `PlanScheduler`.

Reach for it when you are building a scheduler, a cache, or an approval flow
over declared work and you need step identity, declared file effects, and an
auditable history as values you can hold, hash, and store.

## Install

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

Compiling asks Effect for its `Crypto` service, which a platform package
supplies:

```bash
pnpm add @effect/platform-node@4.0.0-rc.115 @effect/platform-node-shared@4.0.0-rc.115
```

Node.js 26.4.0 or later, and `effect` 4.0.0-rc.115 as a peer. Recording a plan
is [`@smthrs/plan-store`](https://plan-store.smithers.sh), which owns the SQL
and brings [`@smthrs/database`](https://database.smithers.sh) with it.

## Compile a plan

Two steps, where the second consumes the first's result and reads the file the
first writes:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as KeyMaterial from "@smthrs/plan/KeyMaterial"
import * as Plan from "@smthrs/plan/Plan"
import * as Effect from "effect/Effect"

/** Everything hashed about one node. `sealed` is work whose result may be reused across runs. */
const sealed = (body: unknown, inputs: ReadonlyArray<KeyMaterial.InputRef> = []): KeyMaterial.KeyMaterial => ({
  version: KeyMaterial.version,
  kind: "sealed",
  body,
  inputs,
  layers: [],
  capabilities: []
})

const drafts: ReadonlyArray<Plan.NodeDraft> = [
  {
    id: "run-tests",
    material: sealed({ action: "run-tests" }, [{ _tag: "Ref", from: "read-pr", path: [] }]),
    effects: { reads: ["pr.json"], writes: ["report.json"], boundaryMode: "hard" }
  },
  {
    id: "read-pr",
    material: sealed({ action: "read-pr", pr: 4821 }),
    effects: { reads: [], writes: ["pr.json"], boundaryMode: "hard" }
  }
]

const plan = await Effect.runPromise(
  Plan.compile({ planId: "review-4821", flow: "example/Review", nodes: drafts }).pipe(
    Effect.provide(NodeCrypto.layer),
    Effect.orDie
  )
)

console.log(plan.digest)
for (const node of plan.nodes) console.log(node.id, node.key, node.dependsOn)
```

The digests on your machine match these, because a plan is a pure function of
its declarations. Compiling reads no file, no clock, and no network:

```text
key1_61edccc875ff69b798e0c3874d167f65ff0a250b9fe67d27558b854fa2832302
read-pr key1_6353326ab2a03804d6acfe916debc4f04f09f9deb8f0e93c1ebea3cdd983db18 []
run-tests key1_e58229e3be2f6abf6f818baf8577fe7045edba6f5e88097b633898478da93985 [ 'read-pr' ]
```

The drafts went in out of order and came back topologically sorted.
`run-tests` names `read-pr` once, in its key material, and that single
declaration became both the hashed dependency and the graph edge, so an edge
and a key can never disagree about what a node consumes. Change `pr: 4821` to
another number and both keys move; rename `read-pr` to `fetch-pr` and neither
does.

Recording that plan is
[`@smthrs/plan-store`](https://plan-store.smithers.sh), whose
[quickstart](https://plan-store.smithers.sh/quickstart/) builds the whole
composition against an in-memory database.

## What is in here

| Module            | Role                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `Node`            | The pure, pipeable authoring AST: `succeed`, `all`, `map`, `andThen`, `branch`, `catch`, `priority` |
| `Planned`         | The strict placeholder a body sees where a step result will be, and the reference it records        |
| `GraphBuildError` | The refusals a plan-time build raises instead of producing a wrong plan                             |
| `FileSet`         | The static filesystem declaration vocabulary: patterns, globs, tree artifacts, filegroups, overlap  |
| `KeyMaterial`     | What a planner declares about a node: body, tagged input references, layers, capabilities, effects  |
| `StepKey`         | The compiler that turns material plus resolved dependency digests into a `@smthrs/keys` `Key`       |
| `Plan`            | `compile`, `append`, the node/edge/conflict schemas, and the digest an approval binds to            |
| `PlanDiff`        | A comparison of two plans as a value: added, removed, re-keyed with attribution, unchanged          |
| `Placement`       | Where a node runs: the four directives, their host-selection detail, and the annotation key         |

Every module is its own entry point, so
`import * as Plan from "@smthrs/plan/Plan"` keeps a bundle to what you reach
for. The root entry re-exports all of them as namespaces.

## The four rules this package exists to keep

**Planning demands nothing.** A `Node` carries Effect's requirement channel,
`R`, and carries it as a phantom: no combinator here reads it, and the AST, the
graph, the key material, and every digest are identical whatever it says.
Building a plan therefore asks for no service at all. What fills the channel is
a call to something whose code lives elsewhere, an action, so a plan's type
states which implementations running it will need, and the place that runs it
is where the compiler asks for them. Each combinator unions its parts: `all`
over its members, `map` and `andThen` along the chain, `branch` over BOTH arms
and `catch` over its failure arm, because both arms of a decision are topology
the plan carries and a run has to be able to take either.

**Planning performs no I/O.** Nothing here reads a file, a clock, or a network.
A node's declared `effects` carry read and write _paths_, never digests, since
measuring them is the scheduler's run-time job.

**Invalidation is re-keying.** A node's key is a function of what it consumes,
so an edited declaration re-keys that node and its dependent cone and nothing
else. There is deliberately **no reverse-dependency index and no invalidating
node visitor**: content addressing subsumes both.

**A plan grows; it is never rewritten.** `append` adds a pre-keyed subgraph at
the next generation. Recorded nodes keep their id, key, edges, and generation
byte for byte, and the SQL raises rather than letting a caller update or delete
one. Re-ordering after a reconciliation happens by re-keying _future_ steps.
Appending to a plan that was never recorded, or over a skipped generation, is a
`constraint` refusal, because the alternative is node rows for a plan that does
not exist and that the append-only triggers then forbid removing.

## Conflict annotations

Declared write sets make overlap detectable at plan time. `compile` annotates
both members of every overlapping pair that no dependency path already orders:
`serialize` is the default and gives the later writer an ordering edge that is
deliberately not key material, so a serialized node keeps its cache hit; `lane`
gives both writers lane annotations and no edge; `fail` refuses the compile,
for flows that promise disjointness. Each annotation also carries the runtime
strategy, `delay-rebase` or `stop-merge`, and both strategies are folded into
the plan digest a human approves.

A node that reads a path another node writes is not a conflict but a missing
edge: `compile` puts the reader behind its producer by growing `dependsOn`, and
fails with `cycle` when no edge set can satisfy both that and the declared
order.

[Declared effects and conflicts](https://plan.smithers.sh/concepts/effects-and-conflicts/)
covers both passes in full.

## When it refuses

`Plan.compile` and `Plan.append` fail with a `PlanError` carrying one of seven
stable codes: `cycle`, `unknown_dependency`, `duplicate_node`,
`overlap_forbidden`, `invalid_effects`, `invalid_node`, and `graph_too_large`.
`Plan.verify`, which every store read and write runs, adds an eighth,
`invalid_plan`: the plan decoded but its generations, approval digest, keys,
effects, or ordering do not match its content. A plan-time build refuses
through `GraphBuildError`, whose closed code set names the site and the fix;
`unstable_callback` in that set is raised by `@smthrs/flow` when a stable build
meets a callback without a `Node.capture` declaration. Persistence has its own
refusals, all of them
[`@smthrs/plan-store`](https://plan-store.smithers.sh)'s.

[Troubleshooting](https://plan.smithers.sh/troubleshooting/) lists every code
with the change that clears it.

## Paths, payloads, and immutability

Declared paths are workspace-relative and compared in one spelling:
`FileSet.canonical` rewrites every separator to `/` and normalizes to Unicode
NFC, and `FileSet.workspaceRelative` refuses absolute paths, drive letters,
`..` and `.` segments, empty segments, the C0 control range, and DEL.

A node payload is stored as its inert JSON mirror, so a data-valued `toJSON` is
honoured while an accessor or an unsupported prototype fails with
`invalid_payload` rather than executing author code or collapsing distinct
values onto `{}`. That mirror is identity material: it is hashed into the step
key and persisted verbatim as plaintext in `node_json` and in the approval card,
and this package never redacts it. Keep credentials out of payloads. A secret
belongs in a layer, a capability, or the environment, resolved at dispatch. `Node.succeed(input)` returns `Node<Succeed<typeof input>>`:
the success type describes that projection. Dates become `string | null`, URLs
become strings, and callable object members disappear. Planned references
resolve to their result types. Reconstruct domain objects explicitly in
`Node.map` when needed. A compiled plan is deep-frozen: mutating the draft objects
you passed in cannot change the plan, its keys, or its digest.

`Plan.maximumPlanNodes` bounds compilation. The conflict and
reader-after-writer passes compare node pairs, so a plan above that bound is
refused with `graph_too_large` before any pair is compared.

## Browser support

Browser-safe: the package resolves no `node:` built-in and binds no database,
so compiling, diffing, and building node graphs all work in a browser.
Persistence is a separate package, which is where a platform choice enters.

## Links

- [Documentation](https://plan.smithers.sh)
- [API reference](https://plan.smithers.sh/reference/api/)
- [`@smthrs/plan-store`](https://plan-store.smithers.sh), the append-only store
  a compiled plan is recorded in
- [`@smthrs/flows`](https://flows.smithers.sh), the whole engine as a single
  dependency, which re-exports this package as its `Plan` namespace
- [License: MIT](./LICENSE)

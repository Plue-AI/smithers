---
title: "Troubleshooting"
description: "Every refusal @smthrs/plan raises, what causes it, and what to change: build errors, compile errors, and key material errors."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/plan/docs/troubleshooting.md"
---

Every failure this package reports is typed and carries a code. Find the code
and read the matching section. The full error schemas are in the
[API reference](/reference/api/).

Three error types, from three layers:

| Type               | Raised by                                      |
| ------------------ | ---------------------------------------------- |
| `GraphBuildError`  | Building a node graph, before there is a plan. |
| `PlanError`        | `Plan.compile` and `Plan.append`.              |
| `KeyMaterialError` | The step-key compiler.                         |

Persistence raises a fourth, `PlanStoreError`, from
[`@smthrs/plan-store`](https://plan-store.smithers.sh/reference/api/); its
[troubleshooting page](https://plan-store.smithers.sh/troubleshooting/) covers
every code.

## GraphBuildError

Thrown, not failed, because the author reading it is mid-body. Each one names
the site through `node` plus the recorded property `path`, and states the fix in
`message`.

### planned_value_computed

**What happened.** A body computed on a step result. The message names the
value and the operation:

```text
Planned value read-pr.count was computed at plan time by Symbol.toPrimitive.
Use Node.map to compute, Node.branch to decide, or pass the value into a payload.
```

Template interpolation, `String(value)`, arithmetic through a coercion,
`JSON.stringify` of a payload holding one, calling it, `in`, and enumerating it
all land here.

**What to change.** Do the computation where it belongs. `Node.map` transforms a
result, `Node.branch` decides on one, and passing the value into a payload field
or reading a field off it stays a reference.

`Boolean(value)` and `value === other` cannot be refused, because JavaScript
exposes no trap for them. They reveal only proxy truthiness or identity and
never the planned result, so a decision written that way is silently wrong. Use
`Node.branch`.

### invalid_all_member

**What happened.** `Node.all` received something that is not a node at the named
member.

**What to change.** Pass a node. An object that merely carries `Node.TypeId` is
not one: the marker is a public string, and every combinator reads `ast` as
trusted topology, so a lookalike is refused exactly like any other non-node.

### invalid_join

**What happened.** `Node.race`, `Node.any`, or `Node.quorum` received a non-node
member, no members, or a quorum count outside 1 to its member count. `node` names
the member, or the combinator for a count.

**What to change.** Pass at least one node, and a whole-number quorum its members
can reach.

### invalid_continuation

**What happened.** A branch arm, a catch arm, or a direct `andThen`
continuation did not return a node. `node` says which: `branch/subject/then`,
`catch/subject`, or `andThen/next`.

**What to change.** Return a node from the arm. An arm that has nothing to do
returns `Node.succeed(value)`.

### invalid_priority

**What happened.** `Node.priority` received a value that is not a safe integer.

**What to change.** Pass a safe integer. No ordering could compare anything
else.

### invalid_payload

**What happened.** A payload member cannot be captured as inert JSON without
running author code or losing identity: an accessor, or a prototype with no
`toJSON`. The message names the path:

```text
Plan payload at $.config.timeout is an accessor
```

**What to change.** Pass data. Read the accessor yourself and put the value in
the payload, or give the object a `toJSON` that returns data.

### cyclic_payload

**What happened.** A payload member has a `toJSON` that returns its own
receiver. It once collapsed to an empty object, which keyed two different values
identically.

**What to change.** Return data from `toJSON`, not the object itself.

### The codes this package does not raise

`GraphBuildErrorCode` also carries `recursion_requires_boundary`,
`placement_requires_boundary`, `graph_too_deep`, `duplicate_node`,
`payload_too_deep`, `unstable_callback`, `effect_outside_envelope`,
`effect_mode_widening`, `effect_tier_widening`, and
`capability_outside_grant`. Those come from
[`@smthrs/flow`](https://flow.smithers.sh/reference/api/)'s graph walk, which shares this vocabulary.

Six more come from [`@smthrs/core`](https://core.smithers.sh/reference/api/)'s graph builder, which raises
this error rather than a second class of its own: `write_conflict` for two work
nodes overlapping under `onConflict: "fail"`, where `node` names the first of
the pair and `Graph.conflicts` carries both; `missing_key_material` for a node
that reached key compilation without any; `dependency_cycle` for a dependency
set that cannot be ordered, where `node` names a node in the cycle;
`plan_too_large` for a node, edge, conflict, or effect-path limit crossed, where
`node` names the node whose admission crossed it; `payload_too_large` for one
plan value with more members than the bound, where `path` names the offending
value path; and `invalid_node` for a malformed node AST. All six are fatal.

The code set is closed so a caller can switch on it across all three packages.

The last four are the effect-authority refusals. `Effects` above defines the
rule: a declaration may narrow the envelope enclosing it and never widen it.

```text
Flow "build/write-dist" at "root.flow" declares a path its caller's effect
envelope does not cover: etc/hosts.
```

`effect_outside_envelope` names the escaping paths, `effect_mode_widening`
means an `expected` declaration sits inside a `hermetic` envelope, and
`effect_tier_widening` means a tier rose where it may only narrow. All three
are fatal: widen the caller's declared effects, or narrow the callee's.

`capability_outside_grant` is the one advisory code. The call still runs, with
the capability dropped, so declare it on the caller or stop requiring it on the
callee.

`unstable_callback` deserves its own note because the fix lives in your flow
body. `Graph.build` with `callbackIdentity: "stable"` refuses a callback whose
identity is process-local:

```text
Callback run at "review" has process-local identity and cannot enter a stable graph.
```

Wrap the callback in `Node.capture` and declare every semantic capture,
including the version of any imported implementation, so it keys by content
instead of by process.

## PlanError

Failed, not thrown: `compile` and `append` return an Effect.

### cycle

**What happened.** Either material dependencies close a cycle:

```text
Plan cycle through node run-tests
```

or a reader-after-writer edge contradicts an inferred ordering:

```text
Plan cycle: node lint reads dist/bundle.js, which node bundle produces, so lint must
follow bundle, but bundle already depends on lint through bundle -> report -> lint
```

**What to change.** For the first, break the dependency loop in the declarations.
For the second, inspect the inferred producer and `serialize` edges. If the
reader needs the new output, put the producer first or separate unrelated
overlapping writes. If it intentionally reads the earlier version, express that
sequence with a `Ref` or `Pending` dependency path from the writer to the reader.
Explicit read-before-write sequencing is valid; declaration order alone is not
an explicit version choice. Two unordered nodes that each need the other's new
output still form a cycle and must be split into stages.

### unknown_dependency

**What happened.** A `Ref` or `Pending` names a node that is neither in the
drafts nor already in the plan.

**What to change.** Check the `from` spelling against the node ids in the same
compile. On an `append`, remember that the reference may name a node from an
earlier generation, which is legal, but not one that was never recorded.

### duplicate_node

**What happened.** A draft reuses an id the plan already holds.

**What to change.** Rename one of them. A node id is durable dispatch identity,
so two nodes may never share one.

### overlap_forbidden

**What happened.** Two nodes that both asked for the `fail` verdict genuinely
write overlapping paths, and no dependency path orders them:

```text
Nodes bundle and minify both write dist/bundle.js
```

**What to change.** `fail` is the verdict for a flow that promises disjointness,
so the declaration is the thing that broke the promise. Narrow one write set,
add a dependency that orders the pair, or change `conflictStrategy` to
`serialize` if serializing is acceptable after all.

### invalid_effects

**What happened.** One path is declared as both a write and a removal.

**What to change.** Pick one. A removal mutates the world exactly as a write
does, and both plan passes fold the two together, so the pair is a contradiction
rather than a refinement.

### invalid_node

**What happened.** The broadest code, covering everything a draft can get
wrong: an empty plan id, flow, or node id; a priority that is not a safe
integer; a `kind`, `conflictStrategy`, or `runtimeStrategy` outside its literal
set; key material or an effect declaration this release cannot decode, which
includes a path that is not workspace-relative; and a material payload holding
an accessor or an unsupported prototype.

The message names the node and, for a payload, the path:

```text
Node run-tests has invalid material payload at $.config.timeout
```

**What to change.** Read the message. Every case names the exact field. For a
path refusal, [Declare the files a node touches](/guides/declare-file-effects/)
lists the forms `workspaceRelative` rejects and why each one is a correctness
hole rather than a style rule.

### graph_too_large

**What happened.** The plan would hold more than `Plan.maximumPlanNodes` nodes,
which is 10,000, or effect analysis exceeded 250,000 candidate pairs or
10,000,000 work units.

```text
A plan may contain at most 10000 nodes, received 12000
```

**What to change.** Split the work across flow boundaries. The node ceiling is checked
before effect analysis. A separate work budget bounds dense conflicts and
reachability updates, and applies across generations during verification.

### invalid_plan

**What happened.** `Plan.verify` decoded a plan whose content does not hold
together. Every [`@smthrs/plan-store`](https://plan-store.smithers.sh/reference/api/) read and write runs it,
so this surfaces from `record`, `append`, and `get`, never from `compile`:

```text
Plan approval digest does not match its compiled content
Plan nodes do not match their compiled keys, effects, ordering, or generations
Node run-tests has an invalid or out-of-order generation
```

**What to change.** Pass the value `Plan.compile` or `Plan.append` returned.
A plan that fails here was assembled by hand, mutated after compiling, or
edited in the database. The store raises a `PlanStoreError` of the same name for
its own preconditions.

## KeyMaterialError

### non_content_material

**What happened.** `StepKey.fromKeyMaterial` or `StepKey.dispatchIdentity` was
asked for a key on material whose `kind` is `compensable` or `irreversible`.

**What to change.** Only `sealed` work gets a cross-run content key. Use
`StepKey.planIdentity` when compiling any tier's declaration, and
`StepKey.ordinal` when dispatching the other tiers: it mints a run-local key.
Do not change an action to `sealed` merely to make it plannable.

### missing_dependency

**What happened.** A `Ref` or `Pending` resolved to nothing usable: no entry for
`from`, an entry that is not an own data property, or a digest that is not a
string. On the dispatch path, a missing settled result.

**What to change.** Supply every dependency the material names. A `Ref` naming
`toString` or `constructor` lands here on purpose, because a prototype-named
dependency would otherwise resolve to an inherited function and collide.

If you see this from a scheduler, a dependent dispatched before its dependency
settled. The halt rule is what guarantees it cannot: a dependent of failed or
skipped work never dispatches.

### invalid_environment

**What happened.** An `EnvironmentIdentity` that is neither properly declared
nor properly run-scoped:

```text
Undeclared environment identity requires a non-empty runScope
Declared environment identity must not include runScope
Environment identity requires a boolean declared field
```

**What to change.** `declared: true` carries no `runScope`. `declared: false`
carries a non-empty one, which pins the key to a single run so a step whose
environment is unknown never serves a cross-run hit.

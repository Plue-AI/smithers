---
title: "Dependencies"
description: "How importing a target from another PACKAGE.ts file becomes a dependency edge, and how edges reach key material, planning, and execution order."
---

Examples importing `buildAndCheckPackage` use the [local helper defined here](../reference/targets/standard-package.md). Create that file in your repository before using those examples.

A dependency edge is a direct import between `PACKAGE.ts` files. There are no label
strings in target attributes.

```ts
// packages/app/PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"
import { Package as flow } from "../flow/PACKAGE.ts"
import { buildAndCheckPackage } from "./package-targets.ts"

const { lib, test, lint } = buildAndCheckPackage({
  deps: [flow.lib],
  cwd: "packages/app"
})

export const Package = S.Package({ targets: { lib, test, lint } })
```

`//packages/app:lib` now depends on `//packages/flow:lib`.

## How an edge is recorded

The edge is not the import. The edge is the target value ending up inside the
attrs of another target call.

`Target.make` walks the decoded attrs recursively, through arrays and plain
objects, at any depth, with a visited set for cycles. Every value that passes
`Target.isTarget` becomes a dependency; every value that passes
`Input.isDeclared` becomes an input; recursion stops at both.

Two consequences:

- The `deps` attribute is a convention, not a mechanism. Every catalog target
  declares `deps: Schema.Array(Target.Target)` as the conventional place, but a
  target value anywhere in the attrs is an edge.
- Importing a target and not using it declares nothing. The import is what makes
  the module load; the attrs placement is what makes the edge.

## Attrs edges and key material

A dependency reaches key material twice.

- The target's key material lists its dependencies as `{label, key}` pairs.
- Inside the canonicalized attrs, every target reference is replaced by
  `{_tag: "Target", key: <dependency key>}`.

A dependency whose key changes therefore re-keys its dependents, transitively.
An attrs value referencing a target that was not planned as a dependency fails
with `attrs reference a target that was not planned as a dependency`.

## Transitive planning

Planning starts from the targets a pattern selects and whose kinds match the
verb. From each, it walks dependencies depth-first.

- Dependencies are planned regardless of their kinds. A `build` run plans a
  `run`-kind dependency and executes it.
- Each target is planned once. The traversal memoizes on the target value.
- The plan lists dependencies before dependents.
- A cycle fails with `target dependency cycle reaches <label>`.
- Edges are deduplicated on the `from\0to` pair.

Because dependencies are planned before their dependents, a dependency's key is
always available when its dependent's key is computed.

## Execution order

The executor drains the plan's dependency-first list with at most `--jobs`
targets in flight. A target becomes ready when every dependency that is also in
the plan has settled.

Failure is contained. A target whose dependency did not succeed reports
`skipped` with `dependency <label> did not succeed`, and marks itself not-green
so its own dependents skip too. Every target outside that cone still runs.

## Package-level convention

The conventional shape is one `lib` target per package, imported by dependent
packages:

```ts
import { Smithers as S } from "@smthrs/targets"
import { Package as flow } from "../flow/PACKAGE.ts"
import { Package as plan } from "../plan/PACKAGE.ts"
import { buildAndCheckPackage } from "./package-targets.ts"

const { lib, test, lint } = buildAndCheckPackage({
  deps: [plan.lib, flow.lib],
  cwd: "packages/app"
})

export const Package = S.Package({ targets: { lib, test, lint } })
```

`buildAndCheckPackage` threads those deps into the emitted targets: `lib` gets them
directly, `check` and `test` get `[lib, ...deps]`, and `lint`, `fmt`, and
`docs` get `[]` because checking one package's sources does not require another
package to be built.

## Synthesized packages declare no edges

Default-target synthesis passes one static `attrs` value to every matching
directory. That value is fixed at declaration time, so when it carries
`deps: []` a synthesized package has no dependency edges, even when its
`package.json` names workspace siblings.

How a synthesized package should infer its edges, for example from the
`package.json` dependencies on workspace siblings, is an open design question.
Write a real `PACKAGE.ts` for a package that needs edges.

## Ordering inside one target

Dependency edges order targets. Inside one target, ordering comes from the plan
nodes the target body records.

Two keyless exec steps dispatched at once are refused by the engine with
`ConcurrentKeylessDispatch`. Targets that chain exec steps therefore pass the first
step's planned result into the second payload's `after` field, which makes the
ordering a material dependency the engine settles before dispatch.

`captureOutputs` does exactly this, and `DepsLint` does it when it writes a
generated knip config before running knip. See
[Writing target definitions](../extending/writing-targets.md).

## Next

- [Labels](labels.md)
- [Caching](../workspace/caching.md)
- [Default targets](../extending/default-rules.md)

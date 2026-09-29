---
title: "Migration units"
description: "A unit is one checkpoint, one model-backed rewrite, and one verification. This is why the migration is cut that way, what order the units run in, and how files are assigned to them."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/migrate/docs/concepts/units.md"
---

A **unit** is the migration's unit of recovery: one checkpoint, one
model-backed rewrite, and one verification, over one declared set of files.
Keeping a unit small is what makes a failure survivable. When a unit fails, the
tool restores its checkpoint, records it as `failed` with the reason, and runs
the next one. A project never ends up half rewritten with no way back.

`Units.plan` partitions a scan into units. `apply` then executes one child flow
execution per unit, in plan order.

## The four kinds, in a fixed order

| Order | Kind                 | What it does                                                                                          |
| ----- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| 1     | `dependencies`       | Adds the 1.0 packages and `effect` to every manifest that declares a 0.x package, and installs.       |
| 2     | `workflow:<name>`    | Rewrites one workflow file, with the components, libraries, and prompts it owns.                      |
| 3     | `integration:<name>` | Rewrites one integration seam.                                                                        |
| 4     | `project`            | Removes the 0.x packages, the 0.x JSX settings, the preload, the agent pool, and the old CLI scripts. |

Project cleanup removes `jsx` and `jsxImportSource` only when the import
source identifies a retired Smithers runtime. React and other JSX settings
are preserved and accepted by final verification.

The order is not a preference. The new packages go in first so every later unit
can import them, and the old packages come out last, once nothing depends on
them any more. A `dependencies` unit is planned for every manifest that
declares a 0.x package: the root one, a workspace member, `.smithers/package.json`,
and any manifest sitting beside a workflow file.

Because the removal is the last unit's job, do not remove the 0.x packages
yourself first. The scanners decide whether a dependency is old by reading the
manifests, so a manifest you have already emptied is one they can no longer
read correctly.

## What counts as a workflow

A file gets a workflow unit when it is a `.jsx` or `.tsx` sitting directly in
`.smithers/workflows/`, an `examples/*.{jsx,tsx}`, or any `.jsx` or `.tsx` that
carries a JSX pragma or calls `createSmithers`, `runWorkflow`, or `smithers`.
Two rules narrow that, and both exist because a pack is mostly not workflows:

- A `.jsx` or `.tsx` nested inside a pack directory under
  `.smithers/workflows/` also has to `export default` a factory call or carry a
  `// smithers-source:` header. A real pack holds thirteen function components
  beside the one `workflow.tsx` that default-exports the factory, and planning
  the components as flows would give it fourteen flows and one real one.
- A file that renders no JSX has to `export default` a rendered workflow. A
  `.ts` beside a workflow is a schema, a config, or a helper far more often
  than it is a workflow.

Whether a file renders JSX is read off its syntax tree, not its text, so a
migrated flow whose JSDoc mentions the element it replaced is not mistaken for
one.

Each workflow file carries an `api`: `smthrs`, `smithers-orchestrator`,
`foreign`, `flows`, or `unknown`. A `foreign` or `unknown` file contributes no
constructs and raises `unknown-authoring-api`, because guessing at another
framework's semantics is how a migration corrupts a project. A file already on
Smithers 1.0 raises `already-migrated` and gets no unit at all: running the
tool twice has to be safe, and a second run must recognize its own output
rather than hand it back to the model and write the result to a second path.

## Dotenv integration sources

A `.env*` file with a `SMITHERS_*` name can belong to an integration unit.
Its source block in `UnitBrief`, the model prompt, and the replayable capture
contains only sorted, unique `SMITHERS_*` assignment names with `[REDACTED]`
values. Unrelated keys, all values, and comments are omitted. This applies to
nested dotenv files, initial captures, repair captures, and checkpoint fallbacks.
The block's line numbers refer to the inventory, not the original file.

The agent leaves dotenv files unchanged and reports required environment
migrations as unresolved for the operator. Redaction markers are never
replacement values. Original bytes remain in the local checkpoint for
verification and restoration.

## How shared files are assigned

A component, a library module, or an MDX prompt often belongs to more than one
workflow. Each one attaches to the **first** workflow unit that imports it,
transitively, up to eight levels of relative imports. After that it is claimed,
so no file is migrated twice and no file is migrated by a unit that does not
know what it is for.

Reaching the old facade is transitive too. A pack calls `createSmithers` in one
module and imports the bindings everywhere else, so a component that names no
old package is still 0.x source and is still inventoried as one.

## How workflow units are ordered

`Units.orderWorkflows` runs a depth-first topological walk over the
workflow-to-workflow relative imports, started at the lexically first workflow.
A workflow that another one imports is migrated before its importer, and two
independent workflows always come out in the same order.

A cycle has no dependency order, so the tool breaks it at the lexically first
workflow in the cycle and records a note naming every file in it. That note
becomes an unresolved entry in the report: the order was a choice the tool had
to make for itself, and you are told so rather than left to discover it.

## Unit ids and flow names

A unit id is `dependencies`, `project`, `workflow:<flow name>`, or
`integration:<name>`. The flow name keeps the workflow's position:
`.smithers/workflows/pipelines/ci-fast.tsx` becomes the flow name
`pipelines/ci-fast` and lands at `flows/pipelines/ci-fast/flow.ts`.

`--unit <id,...>` runs only the named units. An id no unit is planned for fails
the run with `unsupported-project` and lists the ids that are planned, rather
than filtering every unit away and reporting a successful migration that did
nothing.

Two units that would share one id also fail the run, because everything
downstream keys units by that id and one would overwrite the other.

Each unit writes its outcome to
`<reportDir>/units/<readable id>-<16 hex of sha256(id)>.json`, so two ids that
read alike, such as `workflow:a/b` and `workflow:a-b`, never share a file. The
final report reads one artifact per planned unit and records a unit with no
artifact as `failed`, so an apply that lost a unit exits 1 rather than 0.

## What one unit may write

A unit declares its sources and its targets, and those are the only paths it
may write. Every other path in the project is off limits, and the enforcement
is not the prompt's: the checkpoint digests the whole tree before the unit
starts, and the diff afterwards is compared against the unit's declared file
set. The one exception is the lockfile at the project root, because an install
rewrites it and a migration that adds packages makes it do exactly that.

[Checkpoints and confinement](/concepts/checkpoints/) covers what that check
compares, what a failed unit restores, and what the rewrite is prevented from
even reading.

---
title: "Querying"
description: "The two verbs that inspect the graph without running anything: query lists targets and evaluates deps(), and graph renders the dependency graph."
---

Two verbs inspect the graph without running anything: `query` lists targets and
evaluates `deps()`, and `graph` renders the dependency graph.

## Listing targets

Pass a label or a pattern.

```sh
smithers-build query //...
smithers-build query //packages/...
smithers-build query //packages/greeter:lib
smithers-build query :lib
```

The result carries the query string and one entry per target with its label, its
target, and the verbs the target participates in.

```text
query: //packages/greeter
targets:
  - label: //packages/greeter:lib
    target: TsBuild
    kinds: [build]
```

Only the `PACKAGE.ts` modules the pattern selects are evaluated. `//packages/...`
loads every `PACKAGE.ts` under `packages/`; `//packages/greeter:lib` loads one.

An exact label selects one target, so listing a package prints its default
target, not everything it exports:

```sh
smithers-build query //packages/greeter      # the default target only
smithers-build query //packages/greeter/...  # every target in the subtree
```

See [Labels](../concepts/labels.md).

## deps()

`deps(label)` reports the transitive dependency closure of one target.

```sh
smithers-build query 'deps(//packages/app:lib)'
```

```text
query: deps(//packages/app:lib)
root: //packages/app:lib
dependencies:
  - //packages/greeter:lib
  - //packages/core:lib
edges:
  - from: //packages/core:lib
    to: //packages/greeter:lib
  - from: //packages/greeter:lib
    to: //packages/app:lib
```

`dependencies` is the plan's target list with the root removed. `edges` are the
direct dependency edges the planner recorded, with `from` the dependency and `to`
the dependent.

`deps()` requires an expression that resolves to exactly one root. A recursive
pattern fails with `deps() requires one exact or default target`. Quote the
expression so the shell does not interpret the parentheses.

## rdeps()

`rdeps(label)` is the reverse: every labeled target whose dependency closure
reaches the one named. It is the question ownership asks when a package
claims changes to what it depends on.

```sh
smithers-build query 'rdeps(//lib:srcs)'
```

```text
//lib:srcs is depended on by 2 targets
  //app:build
  //data:build
```

Build system only. The JSON form is `{query, root, dependents}`.

## owners()

`owners(label)` reports the owners of the package holding the label, each with
its reasons, the agent policy for the package directory, and the packages it
depends on.

```sh
smithers-build query 'owners(//lib:srcs)'
```

```text
//lib agents: human-approve
  libby                     approve  direct
  team:platform             approve  inherited from //
```

Build system only. For the owners of individual paths, and for a diff, use
the [owners command](../reference/cli.md#owners). See
[Ownership](../concepts/ownership.md).

## Graphs

`graph` plans the pattern under a verb-neutral selection: every target the
pattern matches, regardless of its kinds.

```sh
smithers-build graph //packages/app:lib
```

```text
//packages/app:lib (TsBuild)
└─ //packages/greeter:lib (TsBuild)
   └─ //packages/core:lib (TsBuild)
```

The tree renders each root and recurses into its dependencies. A label the plan
does not contain is marked `[external]`. A label already printed under this root
is marked `[seen]` and not expanded again, so a diamond prints once per path
without looping.

`--mermaid` renders a Mermaid `flowchart LR` instead:

```sh
smithers-build graph //packages/... --mermaid
```

```text
flowchart LR
  n_2f2f...["//packages/core:lib\nTsBuild"]
  n_2f2f...["//packages/greeter:lib\nTsBuild"]
  n_2f2f... --> n_2f2f...
```

Each node carries the label and the target id separated by a literal `\n`, which
Mermaid renders as a line break. Node ids are the hex encoding of the label, so
they are stable and safe in Mermaid. A double quote inside a label is escaped as
`&quot;`.

The command's structured result also carries `roots`, a flat `targets` list of
`{label, target}`, the `edges`, and `warnings`.

## Patterns

| Pattern        | Selects                                                 |
| -------------- | ------------------------------------------------------- |
| `//pkg:target` | One `Package.targets` key                               |
| `//pkg`        | The package's default target                            |
| `//pkg/...`    | Every target in the subtree, including synthesized ones |
| `//...`        | Every target in the workspace                           |
| `:target`      | A `Package.targets` key in the current package          |

Recursive patterns also include targets synthesized by default targets for
directories without a `PACKAGE.ts`. See
[Workspace structure](structure.md#default-target-synthesis).

## Output format

Both verbs return structured data. The CLI prints TOON by default and accepts
`--json`, `--format yaml`, `--format md`, and `--format jsonl`. Use `--json` when
piping into `jq`:

```sh
smithers-build query //... --json | jq -r '.targets[].label'
```

## Next

- [Labels](../concepts/labels.md)
- [Dependencies](../concepts/dependencies.md)
- [CLI reference](../reference/cli.md)

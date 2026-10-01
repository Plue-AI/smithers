---
title: "Select the targets a command runs"
description: "Turn an intent into an argv: which verb selects which targets, how the label grammar narrows a selection, and what --jobs and --plan change."
sidebar:
  order: 1
---

A `smithers-build` invocation is a verb plus a pattern. The verb decides which
kind of target participates; the pattern decides which packages are in scope.
Getting both right is the whole skill.

## Pick the verb

| You want                                         | Verb                        |
| ------------------------------------------------ | --------------------------- |
| Compile or generate artifacts                    | `build`                     |
| Run test suites                                  | `test`                      |
| Run linters and drift checks                     | `lint`                      |
| Check documentation or run page writers          | `docs`                      |
| CI-safe targets from all four, over one graph    | `ci`                        |
| Run a generator, publish, agent task, or commit  | `run`                       |
| Run model reviews                                | `review`                    |
| Run one label whose kind you do not want to name | `target`, or the bare label |

A target participates in a verb when its rule declares that kind. A generator
target participates in both `build` and `lint`, and the two forms differ: the
`lint` form checks for drift and the `build` form writes. The `ci` merge gives
the lint view priority regardless of plan order. `--write` on `target` selects
the writing form.

`Docs.Page` writers run a model CLI with its host executable and credentials,
and write the declared page after their gates pass, without `--write`.
Explicit `docs` selections, including wildcards, can run these writers.
`Docs.Check` checks freshness without a model; `docs --write` refreshes its
stamp from the existing page and inputs instead of checking it. It does not
regenerate the page or enable page writers. `ci` excludes attended `Docs.Page`
writers from its selection. See the [command reference](../cli.md#docs) for
options and examples.

If you select a target under a verb it does not support, the command reports
the unsupported rule rather than returning a false green.

## Narrow with the label grammar

```bash
# ordinary test targets in the workspace
pnpm exec smithers-build test '//...'

# ordinary test targets under one subtree
pnpm exec smithers-build test '//packages/...'

# one named target in every package of a subtree
pnpm exec smithers-build test '//packages/...:faults'

# one package's default target
pnpm exec smithers-build test '//packages/api'

# one exact target
pnpm exec smithers-build test '//packages/api:test'

# a target in the package holding the working directory
pnpm exec smithers-build test ':test'
```

Quote the pattern. `//...` and `:test` are not shell metacharacters today, but
`//pkg/...:name` reads badly unquoted and a glob-expanding shell can surprise
you.

`//pkg/...:name` is the form worth remembering. It runs one shared target key
across every package that declares it, so a matrix is a property of the
packages rather than of a central list. A package that does not declare the
key is simply not selected.

Fault suites declare `exclusive: true`, and so may `NodeTest` and
`Shell.Test` targets; this repository marks its browser and end-to-end tiers
that way. `index --format json` marks each such row `"exclusive": true`.
Wildcard `test` and `ci` selections omit exclusive targets, including suites
exported under another name. An exact label or a named recursive pattern such
as `//packages/...:faults` includes them. To include all tiers in one invocation:

```bash
pnpm exec smithers-build test '//packages/...' --include-exclusive
```

An ordinary target that depends on an exclusive target makes a wildcard plan
refuse with a diagnostic naming `--include-exclusive`. The planner preserves
required dependencies instead of silently dropping them.

## Check the selection before running it

`query` lists pattern matches without filtering by verb or exclusive tier,
and skips target bodies while evaluating trusted declarations:

```bash
pnpm exec smithers-build query '//packages/...:faults'
```

`--plan` goes one step further and shows what running that selection would do,
while skipping target bodies:

```bash
pnpm exec smithers-build test '//packages/...' --plan
pnpm exec smithers-build ci '//packages/...' --plan
pnpm exec smithers-build test '//packages/...:faults' --plan
```

Use `query` when you are unsure the pattern matches. Use `--plan` to inspect
keys and see which targets the cache already covers. Planning evaluates trusted
declarations and may run tool probes or resolve and build declared environments.
See [Planning requirements](./inspect-a-workspace.md#see-what-a-run-would-do)
for required tools and possible host and cache writes.

## Bound the concurrency

`--jobs, -j <n>` caps concurrent targets; the default is the host's available
parallelism. The executor drains ready ordinary targets first, then gives each
exclusive target a window with no other target running. Dependencies retain
their ordering, so an exclusive prerequisite can run before its ordinary
consumer. This holds even when `--jobs` is greater than one:

```bash
pnpm exec smithers-build test '//packages/...:faults' --jobs 1
```

Isolation covers one invocation. Separate CLI invocations still need separate
machines or external coordination. Fault configs must also keep Vitest's
`fileParallelism: false` so cases within one target remain serial.

## Skip the cache for one run

`--no-cache` bypasses cache reads for that invocation and still publishes what
it produces. Reach for it when you suspect a stale result rather than when you
want a clean tree; a stale result is a key bug, and
[Caching](../concepts/caching.md) explains what a key covers.

## Run one label without naming a verb

```bash
pnpm exec smithers-build '//packages/api:lint'
```

A first argument starting with `//` or `:` is rewritten to `target <label>`,
which runs the label under the verb its rule implies. This is the shortest
form for a single target, and the only way to run a `review` target without
naming the verb.

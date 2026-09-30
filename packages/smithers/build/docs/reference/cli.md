---
title: "CLI reference"
description: "Every smithers-build command, argument, option, output shape, and exit code."
---

```text
smithers-build <command> [args] [options]
```

`smithers-build` is built with [incur](https://github.com/wevm/incur). Every command
returns a structured result on standard output. Option names are the kebab-case
form of their schema key, so `cacheDir` is `--cache-dir`. A boolean option that
defaults to true is turned off with its `--no-` form. A positional argument no
command argument consumes fails with `UNEXPECTED_ARGUMENT`. This page is the reference
form; for the behavior behind each command, see the
[`@smthrs/build-cli` documentation](/pkg/build-cli/cli).

Commands: [`cache`](#cache), [`show`](#show), [`targets`](#targets),
[`info`](#show), [`explain`](#show), [`affected`](#affected),
[`clean`](#clean), [`watch`](#watch), [`install`](#install),
[`create-app`](#create-app), [`build`](#build), [`test`](#test),
[`lint`](#lint), [`docs`](#docs), [`review`](#review), [`run`](#run),
[`target`](#target), [`git-hooks`](#git-hooks), [`ci`](#ci),
[`query`](#query), [`owners`](#owners), and [`graph`](#graph). An argv whose
first token starts with `//` or `:` is rewritten to `target <label>`, the
bare-label form.

## Common options

Every command except `create-app` accepts these.

| Option        | Alias | Type   | Default                       | Description                                                                                                           |
| ------------- | ----- | ------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--workspace` | `-w`  | string | the process working directory | Workspace root containing `PACKAGE.ts` files                                                                          |
| `--cache-dir` |       | string | unset                         | Workspace-relative cache directory. Overrides the root declaration; `install` requires the result to remain `.flows`. |

`affected`, `clean`, `watch`, `build`, `test`, `lint`, `docs`, `review`, `run`,
`target`, and `ci` also accept:

| Option                   | Alias | Type        | Default                    | Description                                                                            |
| ------------------------ | ----- | ----------- | -------------------------- | -------------------------------------------------------------------------------------- |
| `--plan`                 |       | boolean     | `false`                    | Print the inert plan instead of executing                                              |
| `--jobs`                 | `-j`  | integer ≥ 1 | host available parallelism | Maximum concurrent targets                                                             |
| `--cache` / `--no-cache` |       | boolean     | `true`                     | Consult the result cache before running. `--no-cache` bypasses reads and still writes. |

incur supplies its own globals on every command, including `--help`,
`--version`, `--json`, `--format <toon\|json\|yaml\|md\|jsonl>`,
`--filter-output <keys>`, `--full-output`, `--schema`, `--llms`, and the
`--token-count`, `--token-limit`, and `--token-offset` trio. Run
`smithers-build <command> --help` for the full list. Output is TOON by default.

`--ui <auto|tty|stream|plain>` is the one global `smithers-build` adds: it selects the
human renderer on standard error, live on a terminal and bare lines under a
pipe, and never touches the envelope. [Terminal output](cli-output.md) has the
selection rules and what each renderer draws.

## Startup sequence

Every command does the same three things before its own work.

1. Resolve the workspace root from `--workspace`.
2. Resolve the cache directory: `--cache-dir`, then the root `PACKAGE.ts` `Workspace`
   declaration, then `.flows`. Resolving the declaration evaluates the root
   `PACKAGE.ts` if one exists.
3. If the declaration sets `gitignored: true`, ensure the root `.gitignore`
   carries an entry for the resolved directory.

`install` stops there. The others then open the workspace index, which lists
discoverable files.

---

## cache

Inspects or removes local action-result entries. It never removes durable runs,
artifacts, store data, or cache directories.

```sh
smithers-build cache status
smithers-build cache prune --older-than-days 30 --dry-run
smithers-build cache prune --older-than-days 30 --yes
smithers-build cache clear --yes
```

`status` reports the cache path, entry count, bytes, and configured remote
endpoint without reading credentials. `prune` selects entries older than 30
days by default; `clear` selects every entry. A mutation requires `--yes`.
`--dry-run` reports the candidates without deleting them. Removal is
irreversible and fails closed if an entry, shard, or path changes while the
command is running.

Failures use `cache_status_failed`, `cache_prune_failed`, or
`cache_clear_failed`.

---

## show

Provides detailed, non-executing inspection commands.

```sh
smithers-build show target //packages/api:lib --verb build
smithers-build show workspace
smithers-build explain //packages/api:lib
smithers-build info
```

`show target` reports a target's rule, kinds, owners, dependencies, inputs,
outputs, effective mode, planned cache key, and local cache state. Its optional
`--verb` is one of `build`, `test`, `lint`, `docs`, `review`, or `run`.
`explain` returns the same target report. `show workspace` reports the resolved
workspace, toolchains, runtime, package manager, sandboxes, cache endpoint, and
host. `info` returns the same workspace report. None probes the remote cache or
executes a target.

Failures use `show_target_failed`, `explain_failed`, `show_workspace_failed`,
or `info_failed`.

---

## targets

Lists available targets, their rules, kinds, summaries, and any child-workspace
refusal. Its optional pattern defaults to `//...`.

```sh
smithers-build targets
smithers-build targets //packages/...
```

Failure code: `targets_failed`.

---

## affected

Selects targets reached by changed files and reverse dependencies, then runs
the requested verb. Repository-wide and unknown inputs conservatively select
the graph.

```sh
smithers-build affected test //packages/... --base main
smithers-build affected ci //apps/... //packages/... --files package.json --list
```

The first argument is `build`, `test`, `lint`, `docs`, `review`, `run`, or
`ci`; the patterns select their union and default to `//...`. `--base` defaults to `HEAD`, while
`--head` selects a committed comparison endpoint. Without `--head`, the
working tree and untracked files are included. Repeatable `--files` bypasses
Git discovery. `--list` reports roots and reasons without executing them.

Failure code: `affected_failed`.

---

## clean

Executes only declared `Clean` targets under the union of optional patterns,
which default to `//...`. It fails instead of doing nothing when the selection
has no `Clean` target.

```sh
smithers-build clean //packages/api/... //packages/web/...
```

Failure code: `clean_failed`.

---

## watch

Replans and reruns a verb in a fresh process when workspace inputs change,
while ignoring `.git`, `node_modules`, the cache, and declared outputs.

```sh
smithers-build watch test //packages/api/... --debounce-ms 200
smithers-build watch build //packages/api:lib --once
```

The first argument and optional patterns match [`affected`](#affected).
Watch rescans the workspace every second, so an edit the file-system notifier
drops still starts a cycle.
`--debounce-ms` defaults to 200 and has a minimum of 20. `--once` runs one
cycle and exits. Watch is deliberately unavailable over MCP. A failing
one-shot cycle uses `watch_cycle_failed`; setup and watcher failures use
`watch_failed`.

---

## install

Plans and executes the `Install` flow under the pnpm package-manager layer. It
takes no label.

```sh
smithers-build install
smithers-build install --workspace /path/to/workspace
```

Options: the [common options](#common-options) only.

The package-manager service is anchored to the canonical workspace root; the
process-wide working directory is never changed. The execution id is derived
from the workspace path.

The store boundary is fixed at `.flows/store/pnpm`. A `--cache-dir` value or
root `Workspace` declaration other than `.flows` makes install fail rather than
declare one path and write another.

Result:

| Field       | Description                                            |
| ----------- | ------------------------------------------------------ |
| `workspace` | The resolved absolute workspace path                   |
| `manager`   | Always `"pnpm"`                                        |
| `plan`      | The round-one plan nodes as `{id, kind, dependencies}` |
| `result`    | The `LinkManifest`: `{store, manifest, linked}`        |

Failure: error code `install_failed`, exit code 1.

See [Install](../concepts/install.md).

---

## create-app

Scaffolds a Smithers app from a `@smthrs/create-app` template. It is the one
command that takes neither `--workspace` nor `--cache-dir`.

```sh
smithers-build create-app my-app
```

| Argument | Description                                        |
| -------- | -------------------------------------------------- |
| `dir`    | Directory to create; its name becomes the app name |

| Option       | Alias | Type   | Default   | Description   |
| ------------ | ----- | ------ | --------- | ------------- |
| `--template` | `-t`  | string | `default` | Template name |

Failure: error code `create_app_failed`, exit code 1.

---

## build

Executes the build targets one or more patterns select.

```sh
smithers-build build //...
smithers-build build //packages/greeter:lib
smithers-build build //packages/greeter/... //packages/api/...
smithers-build build //packages/... --jobs 4
smithers-build build //... --plan
```

| Argument      | Description                                    |
| ------------- | ---------------------------------------------- |
| `patterns...` | One or more Bazel labels or recursive patterns |

Several patterns run their union in one plan: a target two patterns select runs
once, and every pattern must select on its own terms, so a named label that does
not declare the verb fails the whole invocation. The result's `pattern` field
is the patterns joined by spaces.

Options: the [common options](#common-options) plus the execution options.

Selects targets whose definition declares the `build` kind, plans their transitive
dependency closure, and executes it.

Result with `--plan`: a [plan](#plan-shape). Otherwise a
[summary](#summary-shape).

Failures:

| Condition                   | Code             | Exit |
| --------------------------- | ---------------- | ---- |
| Planning or workspace error | `build_failed`   | 1    |
| At least one target failed  | `targets_failed` | 1    |

The `targets_failed` message reads `<n> of <m> targets failed`, with
`(<k> skipped)` appended when anything was skipped.

---

## test

Identical to [`build`](#build) except that it selects targets whose definition declares
the `test` kind.

```sh
smithers-build test //packages/...
smithers-build test //packages/greeter:test
```

Failure codes: `test_failed` for planning errors, `targets_failed` for failed
targets. Exit code 1 for both.

---

## lint

Identical to [`build`](#build) except that it selects targets whose definition declares
the `lint` kind.

```sh
smithers-build lint //...
smithers-build lint :lint
```

In addition to the common execution options, `lint` accepts `--fix`, which
applies agent lint fixes inside the declared `fixes` write set.

Failure codes: `lint_failed` for planning errors, `targets_failed` for failed
targets. Exit code 1 for both.

---

## docs

Identical to [`build`](#build) except that it selects targets whose definition
declares the `docs` kind. Documentation targets also run under [`ci`](#ci),
whose merged graph plans them alongside lint, build, and test.

```sh
smithers-build docs //...
smithers-build docs //packages/core:docs --plan
```

Failure codes: `docs_failed` for planning errors, `targets_failed` for failed
targets. Exit code 1 for both.

---

## review

Identical to [`build`](#build) except that it selects targets whose definition
declares the `review` kind: the model-assisted reviews (`LlmLint`).

```sh
smithers-build review //...
smithers-build review //packages/core:reviewChangedFiles
```

The aggregate [`ci`](#ci) leaves `review` alone, and so does every other verb: a
review target is selected by this command and by nothing else. A review expands
its `changes` git diff at PLAN time, so a checkout without the base revision (a
shallow pull-request checkout, say) fails the whole plan rather than one target; and it spawns a model CLI an unattended runner has neither the binary
nor a credential for. The rule declares `verbGate: ["review"]` as well, so a
review reached through a dependency edge under another verb is refused rather
than silently planned.

A target whose engine CLI is not installed is reported SKIPPED, with a notice
naming the executable, and a skipped target leaves the run green. A host with
no model CLI cannot say whether the diff is clean.

Failure codes: `review_failed` for planning errors, `targets_failed` for failed
targets. Exit code 1 for both.

---

## run

Executes operational targets whose definition declares the `run` kind. These targets
may deliberately mutate source files, delete generated paths, hold a watch
process open, or request an externally gated release action, so `run` is never
folded into `ci`.

```sh
smithers-build run //:clean
smithers-build run //:newPackage --name @scope/widget
smithers-build run //packages/app:dev --no-cache
```

In addition to the common execution options, `run` accepts:

| Option      | Alias | Type     | Default | Description                                                                         |
| ----------- | ----- | -------- | ------- | ----------------------------------------------------------------------------------- |
| `--name`    | `-n`  | string   | unset   | Per-invocation package name consumed by `NewPackage` only                           |
| `--message` | `-m`  | string   | unset   | Commit message for a `Git.Commit` target; wins over the declared message            |
| `--sweep`   |       | boolean  | `false` | Let a `Git.Commit` target with no declared path scope commit the whole working tree |
| `--input`   | `-i`  | string[] | unset   | Payload input for agent targets as `name=value`; repeatable                         |

Failure codes: `run_failed` for planning errors, `targets_failed` for failed
targets. Exit code 1 for both. A target requiring the intentionally absent
irreversible-exec layer reports a target failure with `unresolved_action`.

---

## target

Executes build-system labels under the verb each definition implies. This is
the bare-label form. An argv whose first token starts with `//` or `:` is rewritten
to `target <labels...>`, so `smithers-build //packages/greeter:lint` is the same
invocation. It requires a `WORKSPACE.ts` workspace and refuses a `PACKAGE.ts`
workspace.

```sh
smithers-build target //packages/greeter:lint
smithers-build //packages/greeter:lint
```

| Argument    | Description                     |
| ----------- | ------------------------------- |
| `labels...` | One or more build-system labels |

In addition to the common execution options, `target` accepts:

| Option      | Alias | Type     | Default | Description                                                                         |
| ----------- | ----- | -------- | ------- | ----------------------------------------------------------------------------------- |
| `--write`   |       | boolean  | `false` | Apply `Diff`, `Generate`, and `CiGen` targets instead of checking drift             |
| `--fix`     |       | boolean  | `false` | Apply agent lint fixes inside the declared `fixes` write set                        |
| `--message` | `-m`  | string   | unset   | Commit message for a `Git.Commit` target; wins over the declared message            |
| `--sweep`   |       | boolean  | `false` | Let a `Git.Commit` target with no declared path scope commit the whole working tree |
| `--input`   | `-i`  | string[] | unset   | Payload input for agent targets as `name=value`; repeatable                         |

Failure codes: `target_failed` for planning errors, `targets_failed` for failed
targets. Exit code 1 for both.

For `WORKSPACE.ts` discovery and the verbs the build system supports, see the
[`@smthrs/build-cli` documentation](https://github.com/smithersai/smithers/tree/main/packages/smithers/build/build-cli).

---

## git-hooks

Checks the `WORKSPACE.ts` `gitHooks` scripts against `.git/hooks`, or installs
them with `--write`.

```sh
smithers-build git-hooks
smithers-build git-hooks --write
```

| Option    | Alias | Type    | Default | Description                                         |
| --------- | ----- | ------- | ------- | --------------------------------------------------- |
| `--write` |       | boolean | `false` | Install the rendered hook scripts into `.git/hooks` |

Plus the [common options](#common-options).

Failures:

| Condition                   | Code               | Exit |
| --------------------------- | ------------------ | ---- |
| Planning or workspace error | `git_hooks_failed` | 1    |
| Check mode found drift      | `git_hooks_drift`  | 1    |

The drift message names each offending file with its status and suggests
`--write`.

---

## owners

Resolves the owners, their reasons, and the agent policy for workspace paths,
or for the paths a diff touches. Build system only; a PACKAGE.ts workspace has
no owners declarations. Never executes.

```sh
smithers-build owners src/Apps/Artwork/index.tsx data/schema.graphql
smithers-build owners --diff origin/main
smithers-build owners --diff HEAD --format json
```

| Argument | Description                                               |
| -------- | --------------------------------------------------------- |
| `paths`  | Zero or more workspace-relative paths; omit with `--diff` |

| Option   | Alias | Type   | Default | Description                                                                 |
| -------- | ----- | ------ | ------- | --------------------------------------------------------------------------- |
| `--diff` | `-d`  | string |         | Also resolve every path changed since this git base, like `S.gitDiff(base)` |

Plus the [common options](#common-options).

Returns:

| Field                 | Description                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `touched_paths`       | One `{path, package, owners, agent_policy, packages}` per path; `owners` are `{login \| team, role, reasons}` |
| `required_approvers`  | Every owner with the `approve` role, deduplicated and sorted                                                  |
| `suggested_reviewers` | Every owner with only the `review` role                                                                       |

Failure: error code `owners_failed`, exit code 1, for a workspace without
`WORKSPACE.ts`, an unknown team, a path outside the workspace, or no paths
at all. See [Ownership](../concepts/ownership.md).

---

## ci

Plans `lint`, `build`, `test`, and `docs` over the patterns' union and executes the
merged graph once. `run` and `review` are excluded: a run target may mutate the
tree or hold a process open, and a review target expands a git diff at plan time
and then calls a model, neither of which an unattended pipeline can do. See
[`review`](#review) for the second half.

```sh
smithers-build ci //...
smithers-build ci //packages/... --plan
```

Options: the [common options](#common-options) plus the execution options.

The command plans lint first, then build, test, and docs. Merging deduplicates roots,
targets, and edges on label; first occurrence wins while dependency-first order
is preserved. A target selected by two verbs runs once. Lint-first ordering
makes a generator's non-mutating check form win over its build/write form.

An exact label that does not participate in one of the four kinds is tolerated
as long as it participates in another. Any other planning error propagates. If no
kind produced a plan, the first refusal is raised, or
`no targets selected by <pattern>`.

Result with `--plan`: `{verb: "ci", pattern, roots, targets, edges, warnings}`.
Otherwise a [summary](#summary-shape) with `verb: "ci"`.

Failure codes: `ci_failed` for planning errors, `targets_failed` for failed
targets. Exit code 1 for both.

---

## query

Lists labels or evaluates `deps(label)`, `rdeps(label)`, or `owners(label)`.
Never executes.

```sh
smithers-build query //...
smithers-build query //packages/greeter:lib
smithers-build query 'deps(//packages/app:lib)'
smithers-build query 'rdeps(//packages/greeter:lib)'
smithers-build query 'owners(//packages/greeter:lib)'
```

| Argument | Description                                                           |
| -------- | --------------------------------------------------------------------- |
| `expr`   | A label, a pattern, `deps(label)`, `rdeps(label)`, or `owners(label)` |

Options: the [common options](#common-options) only.

A bare label or pattern returns:

| Field     | Description                                      |
| --------- | ------------------------------------------------ |
| `query`   | The expression as given                          |
| `targets` | One `{label, target, kinds}` per selected target |

`deps(label)` returns:

| Field          | Description                                |
| -------------- | ------------------------------------------ |
| `query`        | The expression as given                    |
| `root`         | The single root label                      |
| `dependencies` | Every label in the closure except the root |
| `edges`        | `{from, to}` pairs, `from` the dependency  |

`deps()` requires exactly one root. A recursive pattern fails with
`deps() requires one exact or default target`.

`rdeps(label)` returns `{query, root, dependents}`: every labeled target
whose dependency closure reaches the root. `owners(label)` returns
`{query, package, owners, agentPolicy, upstream}` for the package holding
the label: its resolved owners with reasons, the policy for its directory,
and the packages it depends on. Both are build system only and take one
exact or default target.

Failure: error code `query_failed`, exit code 1.

---

## graph

Prints the target graph without executing it.

```sh
smithers-build graph //packages/app:lib
smithers-build graph //packages/... --mermaid
```

| Argument  | Description                        |
| --------- | ---------------------------------- |
| `pattern` | A Bazel label or recursive pattern |

| Option      | Alias | Type    | Default | Description                           |
| ----------- | ----- | ------- | ------- | ------------------------------------- |
| `--mermaid` | `-m`  | boolean | `false` | Render Mermaid instead of a text tree |

Plus the [common options](#common-options).

Planning uses the `graph` verb, which filters nothing by kind: every target the
pattern matches becomes a root.

Result:

| Field      | Description                              |
| ---------- | ---------------------------------------- |
| `pattern`  | The pattern as given                     |
| `format`   | `"mermaid"` or `"text"`                  |
| `graph`    | The rendered graph string                |
| `roots`    | The root labels                          |
| `targets`  | One `{label, target}` per planned target |
| `edges`    | `{from, to}` pairs                       |
| `warnings` | Planner warnings; currently always empty |

The text renderer marks a label the plan does not contain as `[external]`, and a
label already expanded under the current root as `[seen]`.

Failure: error code `graph_failed`, exit code 1.

---

## Plan shape

`--plan` prints the planner's output.

| Field      | Description                                                                 |
| ---------- | --------------------------------------------------------------------------- |
| `verb`     | `build`, `test`, `lint`, `docs`, `review`, `run`, `graph`, `query`, or `ci` |
| `pattern`  | The pattern as given                                                        |
| `roots`    | The selected target labels                                                  |
| `targets`  | Planned targets, dependencies before dependents                             |
| `edges`    | `{from, to}` pairs                                                          |
| `warnings` | Currently always empty                                                      |

Each planned target:

| Field            | Description                                              |
| ---------------- | -------------------------------------------------------- |
| `label`          | The target's label                                       |
| `target`         | The target id                                            |
| `kinds`          | The verbs the target participates in                     |
| `attrs`          | The verb-effective attrs the executor passes to the flow |
| `dependencies`   | Direct dependency labels                                 |
| `declaredInputs` | One `{declaration, files, digest}` per declared input    |
| `cacheable`      | Whether a green result is stored                         |
| `cacheLookup`    | Always `"not-wired"`; the planner consults no cache      |
| `wouldRun`       | Always `true`                                            |
| `keyMaterial`    | `{body, inputs, layers, capabilities}`                   |
| `keyPreview`     | The sha256 content key                                   |

`cacheLookup` and `wouldRun` are stale relative to the executor, which performs
the real lookup. See [Caching](../workspace/caching.md).

`attrs`, `declaredInputs`, `cacheable`, and therefore `keyPreview` are resolved
per verb. A target that maps one verb to a different form of its attrs has a
different key under each verb. `graph` and `query` use the declared form. See
[Verb-effective attrs](../concepts/targets.md#verb-effective-attrs).

## Summary shape

An executed verb returns:

| Field        | Description                          |
| ------------ | ------------------------------------ |
| `verb`       | The verb that ran                    |
| `pattern`    | The pattern as given                 |
| `jobs`       | The concurrency actually used        |
| `durationMs` | Wall-clock duration of the run       |
| `counts`     | `{hit, ran, failed, skipped}`        |
| `ok`         | False when any target failed         |
| `results`    | One report per target, in plan order |

Each report:

| Field        | Description                          |
| ------------ | ------------------------------------ |
| `label`      | The target's label                   |
| `target`     | The target id                        |
| `status`     | `hit`, `ran`, `failed`, or `skipped` |
| `durationMs` | Time spent on this target            |
| `key`        | The content key                      |
| `error`      | Present on `failed` and `skipped`    |

| Status    | Meaning                                              |
| --------- | ---------------------------------------------------- |
| `hit`     | Answered from the result cache; the tool did not run |
| `ran`     | Executed and succeeded                               |
| `failed`  | Executed and failed                                  |
| `skipped` | Never ran because a dependency did not succeed       |

## Progress output

One status line per settled target goes to standard error, followed by a summary
line:

```text
//packages/greeter:lib  hit  2ms
//packages/app:lib  ran  3.1s
//packages/app:test  failed  0.4s  {"_tag":"smithers-build/ExecError", ...}
//packages/app:lib  skipped  0ms  dependency //packages/app:test did not succeed
4 targets: 1 hit, 1 ran, 1 failed, 1 skipped (3.6s)
```

Each field is separated by two spaces; the columns are not padded. Durations
under one second print in milliseconds. A cache write that fails prints
`smthrs: could not store <label> in the cache: <reason>` and does not fail the
run.

## Environment variables

| Variable               | Effect                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `SMITHERS_CACHE_URL`   | Optional endpoint override for the declared `RemoteCache`. HTTPS is required except for loopback HTTP. |
| `SMITHERS_CACHE_TOKEN` | Default bearer-token variable for the HTTP cache. A declaration may name another variable.             |

The process entry point reads both, captures them, and clears them from its own
environment, so a spawned tool never inherits either.

## Exit codes

| Code | Meaning            |
| ---- | ------------------ |
| 0    | Success            |
| 1    | Any reported error |

## Programmatic API

The `@smthrs/build-cli` package exports the pieces the verbs are built from.

| Export                                | Kind      | Purpose                                                                                                                         |
| ------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `cli`                                 | value     | The configured incur CLI. `main.ts` calls `cli.serve()`.                                                                        |
| `runInstall(workspaceRoot, options?)` | function  | Plans and executes the `Install` flow under pnpm. Options carry cache directory, sensitive environment names, and cancellation. |
| `Workspace`                           | namespace | `Workspace.make`, `resolveConfig`, `ensureGitignored`, `discoverable`, and the workspace index type.                            |
| `Planner`                             | namespace | `Planner.make(workspace, verb, pattern)`, `keyOf`, and the `Plan`, `PlannedTarget`, `KeyMaterial`, and `Edge` types.            |
| `Query`                               | namespace | `Query.run(workspace, expression)` and the `Listing` and `Dependencies` result types.                                           |
| `Label`                               | namespace | `Label.parse`, `Label.format`, `Label.currentPackage`, and the `Pattern` type.                                                  |

`Executor`, `Cache`, `GraphOutput`, and `engine` are internal to the package and
reachable only by subpath import.

```ts
import { Planner, Workspace } from "@smthrs/build-cli"

const workspace = await Workspace.Workspace.make("/path/to/workspace")
const plan = await Planner.make(workspace, "build", "//...")
```

## Next

- [Running targets](../workspace/running-targets.md)
- [Querying](../workspace/querying.md)
- [Workspace reference](config.md)

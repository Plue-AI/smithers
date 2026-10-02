---
title: "Commands"
description: "Every smithers-build command, argument, option, exit code, and error code, plus the global flags incur adds and the environment variables the CLI reads."
---

```text
smithers-build <command> [arguments] [options]
```

`makeCli` registers 24 commands, including the alias for `git-hooks` and grouped
`cache` and `show` surfaces. `normalizeArgv` adds another spelling: an argv
whose first token starts with `//` or `:` is rewritten to `target <label>`, so
`smithers-build //packages/api:lint` runs the bare-label form.

Every command refuses a positional argument it does not consume with the
`UNEXPECTED_ARGUMENT` error, before it reads the workspace.

Option names are the kebab-case form of their schema key, so `cacheDir` is
`--cache-dir`. A boolean option that defaults to true is turned off with its
`--no-` form, so `--cache` becomes `--no-cache`.

## Workspace options

Every command takes these.

| Option        | Alias | Type   | Default                | Meaning                                                         |
| ------------- | ----- | ------ | ---------------------- | --------------------------------------------------------------- |
| `--workspace` | `-w`  | string | the working directory  | A directory inside the workspace. Discovery walks up from it.   |
| `--cache-dir` |       | string | the declared directory | Workspace-relative cache directory, overriding the declaration. |

`--cache-dir` must be relative, non-empty, and free of `..` segments; anything
else fails the command. Precedence is the flag, then the `S.Cache({ directory })`
in the workspace declaration, then `.flows`. See
[Caching](./concepts/caching.md).

## Execution options

`affected`, `clean`, `watch`, `build`, `test`, `lint`, `docs`, `run`,
`target`, and `ci` add these to the workspace options.

| Option                   | Alias | Type       | Default          | Meaning                                                           |
| ------------------------ | ----- | ---------- | ---------------- | ----------------------------------------------------------------- |
| `--plan`                 |       | boolean    | `false`          | Print the plan and skip target bodies.                            |
| `--verbose`              |       | boolean    | `false`          | Show plain progress for agents and pipe consumers.                |
| `--jobs`                 | `-j`  | integer 1+ | host parallelism | Maximum concurrent targets.                                       |
| `--include-exclusive`    |       | boolean    | `false`          | Include exclusive targets in wildcard `ci` and `test` selections. |
| `--cache` / `--no-cache` |       | boolean    | `true`           | Consult the cache before running. `--no-cache` still publishes.   |
| `--known-red`            |       | path       | none             | JSON list of reviewed failures; unmatched failures fail.          |

Exclusive targets run alone after ready ordinary work drains, regardless of
`--jobs`. Dependencies keep their ordering. Explicit labels, including
`//packages/...:faults`, select exclusive targets without an opt-in flag.
Wildcards also omit targets whose `hosts` excludes the host; naming one
there refuses the plan.
`--plan` applies the same selection rules and skips target bodies. It still
evaluates trusted declarations, reads the workspace, and may run tool probes
or resolve and build declared environments. See
[Planning requirements](./guides/inspect-a-workspace.md#see-what-a-run-would-do)
for required tools and possible host and cache writes.

### Known-red targets

`--known-red <file>` names a JSON list of targets that already fail, each with
an owner, a reason, the issue that tracks the fix, a last day, and a
`failureDigest` of the reviewed diagnostic. The command still runs and reports
those targets. It exits nonzero when a failure does not match the listed digest,
when a listed target fails after its `expires` day, or when a target outside the list
is skipped because a dependency failed: an entry excuses its own failure, not
the consumers it kept from running. Paths resolve from `--workspace`.

```json
{
  "entries": [
    {
      "label": "//packages/example:test",
      "platforms": ["win32"],
      "owner": "will",
      "reason": "path separators in snapshot names",
      "issue": "https://github.com/smithersai/smithers/issues/1",
      "expires": "2026-10-09",
      "failureDigest": "sha256:253379cf8835d1a7559d89ddee8faa65e06dd0aa69c08f640385716e3cbd9ffd"
    }
  ]
}
```

Run with `--known-red` (an empty list works) and copy the digest from
`observed failure: //target sha256:...` after reviewing the diagnostic. These
hashes come from the original error before output redaction. Do not hash a
redacted log. Alternatively use `KnownRed.fingerprint(result.error)` from
`packages/smithers/build/build-cli/src/KnownRed.ts` on unredacted execution data.
The example above hashes `snapshot path mismatch`. Digests must be `sha256:`
plus 64 lowercase hex digits; missing digests and wildcards are rejected.
Missing or blank diagnostics never match. Several reviewed digests may name
the same target. Listed skipped dependents retain label-based excusal because
they have no failure diagnostic of their own.

Normalization v1 strips ANSI controls, converts CRLF to LF, and replaces UTC
ISO timestamps at the start of log lines with `<timestamp>`. It also normalizes
Effect log timestamps and Vitest's `Start at`, `Duration`, per-result durations,
and worker timing hints. Test names, statuses, counts and all stdout/stderr
failure content remain significant. It replaces
Smithers temporary roots (`smthrs-` or `flows-` names ending in six random
alphanumeric characters under `/tmp`, macOS `/var/folders/.../T`, or Windows
`Users/.../AppData/Local/Temp`) with `<tmp>/<name>-<id>`, preserving the remaining
path with `/` separators. JSON string values are normalized independently.
Other paths, dates, diagnostic timings, exit codes, filenames, assertions and additional
errors remain significant. Matching is exact, never a substring or pattern.

The Windows migration pins six complete diagnostics from
[CI run 36275726412](https://github.com/smithersai/smithers/actions/runs/36275726412).
Thirteen label-only exceptions with redacted or truncated diagnostics were
removed. Their repairs remain tracked in
[#1974](https://github.com/smithersai/smithers/issues/1974); restoring an exception
requires a complete reviewed diagnostic. Changes outside the documented
normalization, including reordered output or appearing/disappearing slow-test
lines, count as newly red until reviewed.

`platforms` is optional and matches Node's `process.platform`. Each finding
prints one line to standard error: `known red`, `newly red`, `not run`,
`observed failure` (for known and new failures), `expired entry`, or `green again, remove from`. Delete an entry in the change that fixes its
target.

## Global options

`--audience <auto|human|agent>` selects the consumer experience; `auto` detects
verified harness markers and terminal capabilities. `SMITHERS_AUDIENCE` supplies
the environment override. Humans receive progress eagerly; agents receive
concise Incur results and useful next commands, with progress silent by default.

`--silent` suppresses progress, not results or failures. The public CLI retains
`--quiet` on commands that previously supported it; it is not a global target
option. Execution commands accept `--verbose` to enable plain progress for agents.
`--ui <auto|tty|stream|plain>` chooses the target-progress style within the
audience policy: it does not override silence or alter result encoding.
See [Output and renderers](./concepts/output.md).

The CLI is built on [incur](https://github.com/wevm/incur), which supplies the
rest on every command: `--help`, `--version`, `--json`,
`--format <toon|json|yaml|md|jsonl>`, `--filter-output`, `--full-output`,
`--schema`, `--llms`, and the `--token-count`, `--token-limit`, and
`--token-offset` trio. Output is TOON by default. Run
`smithers-build <command> --help` for the list a given version serves.

## Execution commands

Each takes one or more patterns and workspace options. Commands other than
`review` also accept the execution options. Several patterns run their union
in one plan.

| Command  | Argument        | Own options                                                                                                       |
| -------- | --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `build`  | `<patterns...>` |                                                                                                                   |
| `test`   | `<patterns...>` |                                                                                                                   |
| `lint`   | `<patterns...>` | `--fix`                                                                                                           |
| `docs`   | `<patterns...>` | `--write`                                                                                                         |
| `review` | `<patterns...>` | `--policy-revision` (required), `--revision`, `--plan`, `--required`, `--findings-store`, `--credential-receiver` |
| `ci`     | `<patterns...>` |                                                                                                                   |
| `run`    | `<patterns...>` | `--name, -n`, `--message, -m`, `--sweep`, `--input, -i`                                                           |
| `target` | `<labels...>`   | `--write`, `--fix`, `--message, -m`, `--sweep`, `--input, -i`                                                     |

### build, test, lint

Execute the targets a pattern selects under that kind. A target participates
in a verb when its rule declares that kind, so `lint` over a package selects
its linters and its drift checks and nothing else. A verb that cannot execute
a selected target reports the unsupported rule rather than returning a false
green.

```bash
pnpm exec smithers-build test '//packages/...'
pnpm exec smithers-build lint '//packages/api:lint'
```

`--fix` lets an agent lint target write inside its declared `fixes` write set.
Without it the target checks and reports.

### docs

Executes documentation parity checks, `Docs.Check` freshness checks, and
`Docs.Page` writers selected by the pattern.

`Docs.Page` runs the declared model CLI and needs its executable and
credentials on the host. It writes the declared output page after its gates
accept the candidate, without `--write`. An explicit `docs` invocation,
including a wildcard pattern, can therefore invoke a model and rewrite pages.
Use `--plan` to inspect the selection without executing it.

`Docs.Check` checks page and input freshness against a recorded stamp without
invoking a model. `docs --write` refreshes the selected `Docs.Check` stamps
from the existing pages and current inputs; it does not regenerate those pages.
A missing page must be generated before it can be stamped. This flag does not
control `Docs.Page` writes. `ci` excludes attended `Docs.Page` writers from its
selection and checks freshness without refreshing stamps.

```bash
pnpm exec smithers-build docs '//:page'
pnpm exec smithers-build docs '//:pageCheck'
pnpm exec smithers-build docs '//:pageCheck' --write
```

### review

Reviews committed source with policy read as data from an approved commit.
The command never imports candidate `PACKAGE.ts`, `WORKSPACE.ts`, or policy modules.

```sh
smithers-build review '//...' --policy-revision <approved-commit-sha> --revision <candidate-commit-sha>
```

`--policy-revision` is required and accepts only a full commit SHA. The approved
commit must contain a generated `.smithers/target-index.json` with review policy.
`--revision` defaults to `HEAD`; dirty files are excluded. `--plan` shows selected
files, policy labels, and pinned revisions without inference. Proposed declaration
and index policy changes receive separate reviews and never replace approved policy.

`--required` fails every selected review, policy reviews included, that selects
no files or cannot run, instead of passing it. `--findings-store` names the
absolute private directory that keeps review runs and findings; it defaults to
`smithers/review-findings` in the repository's Git directory, which is never
committed. The command prints each finding's disclosable summary; the findings
themselves stay in the store.

`--credential-receiver` names an absolute executable that receives each review's
credential discoveries before inference: the reviewed revision and each
discovery's file, line and credential name as JSON on stdin, never a value. The
receiver runs without arguments in the workspace root with the command's
environment, and its output is discarded. A nonzero exit fails that review. The
Review credentials guide describes the document.

Both engines use tool-free provider requests. Claude requires `ANTHROPIC_API_KEY`;
Codex requires `OPENAI_API_KEY`. Missing credentials and incomplete reviews fail.
Run an installed, approved CLI from a trusted host; executing the candidate's CLI
or installing its dependencies would cross the trust boundary before review starts.

### ci

Plans `lint`, `build`, `test`, and `docs` over one merged graph and executes
it once, so a target two verbs select runs a single time.

```bash
pnpm exec smithers-build ci '//packages/...'
```

Plans merge in that order. Views with the same label and `keyPreview` are
deduplicated. When keys differ, the lint view takes priority regardless of
plan order; conflicting non-lint views are rejected. A generator selected by
both `build` and `lint` therefore uses its non-mutating lint form.

The merge retains planned services and key-only dependencies for lookup.
Services are acquired by their consumers after readiness succeeds and released
when those consumers finish; they are not scheduled as ordinary CI targets.
The same rule applies to `affected ci` selections.

`review` requires an explicitly approved policy revision and provider credentials
on a trusted host. `run` can mutate the tree. Neither is part of the aggregate;
ask for either by name.

If a verb has no targets under the pattern, `ci` continues with the rest. If
none of the four has any, the command fails with the first refusal.

### run

Executes run targets: generators in their writing form, publishes, agent
tasks, and commits.

```bash
pnpm exec smithers-build run '//:changelog'
pnpm exec smithers-build run '//packages/api:publish'
```

`--name` supplies a package name to scaffold targets. The three invocation
flags below apply here and to `target`.

### target

Executes one label under the verb its rule flavour implies, and is what a bare
label resolves to:

```bash
pnpm exec smithers-build target '//packages/api:lint'
pnpm exec smithers-build '//packages/api:lint'
```

It is the one way to run a `review` target without naming the verb, and the
one way to reach a target whose kind you would otherwise have to remember.

`--write` applies `Diff`, `Generate`, and `CiGen` targets instead of checking
them for drift.

### The invocation flags

`run` and `target` take three flags that change what an outward or agent
target does.

- `--message, -m <text>` overrides the declared commit message of a
  `Git.Commit` target.
- `--sweep` lets a `Git.Commit` target with no declared path scope commit the
  whole working tree. Without it, such a target refuses with
  `unrelated_changes` and names the paths the commit does not own.
- `--input, -i name=value` is repeatable and becomes an agent target's
  payload. A value without `=`, or a name repeated, fails the command.

## Workspace commands

These take the workspace options and execute no targets.

| Command     | Argument    | Own options     |
| ----------- | ----------- | --------------- |
| `install`   |             |                 |
| `query`     | `<expr>`    |                 |
| `index`     | `<pattern>` |                 |
| `graph`     | `<pattern>` | `--mermaid, -m` |
| `owners`    | `[paths…]`  | `--diff, -d`    |
| `git-hooks` |             | `--write`       |

### install

Plans and executes the install flow the root `PACKAGE.ts` declares, under the
runtime and package manager the workspace declaration names. It takes no
label.

```bash
pnpm exec smithers-build install
pnpm exec smithers-build install --workspace /path/to/checkout
```

The root package must declare exactly one `Install` target. Zero or more than
one fails the command before anything runs.

### query

Lists labels, or evaluates one of three functions.

```bash
pnpm exec smithers-build query '//packages/...'
pnpm exec smithers-build query 'deps(//packages/api:lib)'
pnpm exec smithers-build query 'rdeps(//packages/api:lib)'
pnpm exec smithers-build query 'owners(//packages/api:lib)'
```

A label or pattern lists each selected target with its rule, its kinds, and
the one-line summary its declaration carries. `deps(<label>)` prints the
transitive closure below a target with its edges, `rdeps(<label>)` prints
every target that depends on it, and `owners(<label>)` prints the owners,
their roles and reasons, the package's agent policy, and its upstream
packages. All three functions need a single exact or default target and refuse
a pattern that resolves to several.

A `Repo.Target` row that a child workspace could not answer for carries a
`refusal`, rendered for a person and carried in the envelope.

### index

Lists every target a pattern selects as its declaration states it.

```bash
pnpm exec smithers-build index '//...'
pnpm exec smithers-build index '//packages/api/...' --format json
```

Each row carries the label, the declaring package and target name, the rule,
the kinds, the summary and featured flag, the generator mode when the rule
declares one, `"exclusive": true` when the target is in the exclusive tier
that wildcard `test` and `ci` selections omit, whether the target is cacheable, the declared inputs as `kind`
records (`file`, `glob`, `pnpm-workspace`, `git-diff`) with their paths
resolved from the declaring package, the workspace-relative paths the
target writes, its labeled dependencies, and the PACKAGE.ts that declared it.
A row carries no cache key, no content digest, no line number, and no host
fact, so the same declarations index the same way on every machine. For a
person the listing is aligned `LABEL`, `RULE`, and `KINDS` columns with the
outputs after an arrow and a star on a featured row. The root `//:targetIndex`
target (`Smithers.TargetIndex`) commits the same rows as
`.smithers/target-index.json`: `target //:targetIndex --write` writes the
file and `lint '//:targetIndex'` fails on drift.

### graph

Prints the target graph a pattern selects without executing it.

```bash
pnpm exec smithers-build graph '//packages/...'
pnpm exec smithers-build graph '//packages/...' --mermaid > graph.mmd
```

`--mermaid` renders a Mermaid flowchart instead of a text tree. Mermaid is
meant for a file or a renderer, so that form is always returned as data and
never drawn to the terminal.

### owners

Resolves owners, reasons, and the agent policy for workspace paths, or for
every path a diff touches.

```bash
pnpm exec smithers-build owners packages/api/src/server.ts
pnpm exec smithers-build owners --diff main
```

`--diff <base>` adds every path changed since that git base, the same set
`S.gitDiff(base)` expands. The command needs at least one path, from the
argument list or from `--diff`.

### git-hooks

`gitHooks` remains an alias for `git-hooks`.

Renders the hook scripts the workspace declaration binds and compares them
byte for byte against the directory returned by `git rev-parse --git-path hooks`.
This supports linked worktrees and relative or absolute `core.hooksPath` settings.
A `core.hooksPath` outside the workspace root and the repository's git directory
is refused with `hooks_path_outside_repository`, because that directory is
shared with other repositories. An existing hook that smthrs did not generate is
copied to `<hook>.bak` before `--write` replaces it.
Both checking and installation resolve symlinks before checking containment,
including existing parents of directories that have not been created yet.
A repository-local symlink cannot authorize an external hooks directory.
If Git is unavailable, the command falls back to `.git/hooks` under the workspace
root; that fallback requires a `.git` directory.

```bash
pnpm exec smithers-build git-hooks
pnpm exec smithers-build git-hooks --write
```

Drift is a red exit that names each drifting file and its status, like every
other generated file. `--write` installs the rendered scripts and reports what
it wrote.

## Inspection and maintenance

These commands inspect the workspace or operate on explicitly bounded local
state.

| Command          | Arguments              | Own options                               |
| ---------------- | ---------------------- | ----------------------------------------- |
| `cache status`   |                        |                                           |
| `cache prune`    |                        | `--older-than-days`, `--dry-run`, `--yes` |
| `cache clear`    |                        | `--dry-run`, `--yes`                      |
| `show target`    | `<label>`              | `--verb`                                  |
| `show workspace` |                        |                                           |
| `targets`        | `[pattern]`            |                                           |
| `info`           |                        |                                           |
| `explain`        | `<label>`              | `--verb`                                  |
| `affected`       | `<verb> [patterns...]` | `--base`, `--head`, `--files`, `--list`   |
| `clean`          | `[patterns...]`        |                                           |
| `watch`          | `<verb> [patterns...]` | `--debounce-ms`, `--once`                 |

`cache status` reports the local action-result count and size plus the remote
endpoint without exposing credentials. `cache prune` selects entries older
than 30 days by default; `cache clear` selects all entries. Deletion requires
`--yes`, while `--dry-run` writes nothing. Only individual local action-result
files are removed; durable runs, artifacts, stores, and directories remain.
Deletion is irreversible and fails closed if a path changes mid-operation.

`show target` reports the rule, kinds, dependencies, owners, inputs, outputs,
planned key, and local cache state for one target. `explain` returns the same
report. `show workspace` and `info` report resolved workspace and host
configuration. These commands do not execute targets or probe the remote
cache. `targets` lists the available target surface and defaults to `//...`.

`affected` accepts `build`, `test`, `lint`, `docs`, `run`, or `ci`.
It compares `--base` (default `HEAD`) with `--head`, or with the working tree
and untracked files when `--head` is absent. Repeatable `--files` bypasses Git
discovery, and `--list` explains the selection without executing it. Unknown
or ambient inputs conservatively select the graph. Any change selects every
uncacheable target and its dependents, because only a cache key declares
complete inputs.

`--list` adds `reasonDetails` beside each target's changed-path `reasons`.
Each detail names the file and selection mechanism; target-local causes also
name the culprit's label and rule and a shortest `dependencyPath` from the
selected root to that culprit. Ambient inputs include their declaration, such
as a `PnpmWorkspace` tag and path. Private `__private_` labels are local to this
list and may differ from a later plan's labels. `conservative` describes only
the global/unknown-file fallback; ambient and uncacheable causes can select
every target while it remains `false`. Incomplete input contracts retain the
any-change fallback; these diagnostics neither enable caching nor narrow it.

Each Git invocation has a 60-second deadline and a 16 MiB limit on each output
stream. Cancellation interrupts discovery as well as target execution. A Git
timeout, invalid output, or nonzero exit fails `affected`; it never becomes an
empty changed-file list. Embedded callers can pass `signal` and `timeoutMs`
to `Affected.changedPaths` and inspect its typed `AffectedGitError`.

`affected`, `clean`, and `watch` select the union of their patterns, which
default to `//...`. `clean` executes only declared `Clean` targets and refuses
an empty selection.
`watch` runs the selected verb in fresh child processes, cancels stale work,
and replans after a change. It ignores `.git`, `node_modules`, cache state, and
declared outputs. It also rescans the workspace every second, so an edit the
file-system notifier drops still starts a cycle. `--debounce-ms` defaults to
200 with a minimum of 20; `--once` performs one cycle. Watch is deliberately unavailable through MCP.

On POSIX, stopping a cycle sends SIGTERM to its process group, escalates to
SIGKILL after five seconds if any member survives, and waits for the group to
disappear before reporting completion or starting a replacement. A leader that
exits early does not cancel escalation. If the group remains five seconds after
SIGKILL or signalling fails, watch reports a cleanup failure and stops. This
also cleans up descendants left by a completed cycle. These command-scoped
processes have no durable flow host identity or process journal; recovery after
the watch parent itself is killed is outside this contract. Windows uses the
Node spawner's process-tree termination and does not provide the POSIX group
absence check.

## Exit codes

The CLI exits `0` or `1`. There is no third code.

| Code | When                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------- |
| `0`  | The command completed: every executed target settled green, or the command only read the workspace. |
| `1`  | A target failed, a command refused, argument parsing failed, or a signal interrupted the run.       |

A red run exits 1 whether the failure is reported as a structured error on
standard output or as rendered text on standard error. When a human renderer
has already explained what failed, only the exit code remains to record, so
the envelope's error block is not printed twice.

A refused command prints the refusal's own sentence. A failure the CLI did not
design prints `Something went wrong on our side. Not your fault.`; add
`--verbose` on an execution command to append its raw message.

`SIGINT` and `SIGTERM` abort every running target and set the exit code to 1,
whatever the command was about to report. The second interrupt stops the
process at once. See [The invocation pipeline](./concepts/invocation.md).

## Error codes

A structured failure carries a code alongside its message.

| Code                                                                                                                     | Meaning                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `targets_failed`                                                                                                         | An executed graph went red. The message counts failures and skips. |
| `build_failed`, `test_failed`, `lint_failed`, `docs_failed`, `review_failed`, `run_failed`, `ci_failed`, `target_failed` | The command threw before or during execution.                      |
| `install_failed`                                                                                                         | Install planning or execution failed.                              |
| `create_app_failed`                                                                                                      | The scaffold refused or failed.                                    |
| `query_failed`, `index_failed`, `graph_failed`, `owners_failed`                                                          | The workspace could not be read, or the expression was rejected.   |
| `git_hooks_failed`                                                                                                       | Rendering or installing the hooks failed.                          |
| `git_hooks_drift`                                                                                                        | Checked hooks differ from the declaration.                         |
| `UNEXPECTED_ARGUMENT`                                                                                                    | A positional argument that no command argument consumes.           |

## Environment

| Variable                                | Read by                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `SMITHERS_CACHE_URL`                    | Overrides the declared remote-cache endpoint for this process.                      |
| `SMITHERS_CACHE_TOKEN`                  | The default remote-cache credential.                                                |
| `SMITHERS_CACHE_NAMESPACE`              | The trust domain results publish into. Unset means the trusted domain.              |
| `SMITHERS_CLOUD_API_URL`                | Overrides the Smithers Cloud API base that zero-config cache discovery reads.       |
| `SMITHERS_CLOUD_HOSTS`                  | Extra comma-separated hosts whose git remotes identify a Smithers Cloud repository. |
| `SMITHERS_NPM_CREDENTIAL_HOSTS`         | Registry hosts a project `.npmrc` may bind credentials to, comma-separated.         |
| `SMTHRS_UI`                             | The renderer, when `--ui` is `auto`.                                                |
| `SMTHRS_SHARD`                          | `<index>/<total>` selecting one shard of a sharded target.                          |
| `SMTHRS_AGENT_FAKE`                     | A script file that replaces the real agent CLI, for deterministic tests.            |
| `SMTHRS_AGENT_TIMEOUT_MS`               | The agent session timeout.                                                          |
| `SMTHRS_DEBUG_KEYS`                     | A file every node's key material is appended to, for cache-key forensics.           |
| `NO_COLOR`, `TERM`, `CI`, `FORCE_COLOR` | Renderer selection under `--ui auto`.                                               |

`SMITHERS_CACHE_URL` and `SMITHERS_CACHE_TOKEN` are read once by the process
entry point and deleted from the environment before any declaration module
evaluates, so no workspace file can read them. Both names, and every name a
workspace marks sensitive, are also stripped from the environment of every
spawned tool, in both phases. Planning strips them once, before it captures the
host environment, so the tools it consults over workspace-controlled input
never see them either: `forge config`, `go version`, `go env`, `go list`, `nix
develop`, `docker info`, `docker buildx ls`, and each declared executable's
version probe. Execution also withholds these names from `Git.Commit` git
commands and hooks, and from both `Memory.Retain` ref resolution and the
`smithers memory` subprocess.

Git commit commands and both memory subprocesses have a 60-second deadline.
Plan-time `go list` has a 60-second deadline; fallback `nix develop` tool
resolution has a five-minute deadline. Each receives the run's abort signal.
Git commands disable terminal credential prompts and interactive editors.

## Runtime

The package requires Node 26.4.0 or later. `src/main.js` installs the Effect
module resolution hook and boots the programmatic `tsx` loader that ships as a
CLI dependency, which then loads the CLI's own modules and the workspace's
`WORKSPACE.ts` and `PACKAGE.ts` declarations. See
[Installation](./installation.md).

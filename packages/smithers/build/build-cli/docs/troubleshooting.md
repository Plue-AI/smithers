---
title: "Troubleshooting"
description: "The refusals smithers-build reports, what each one means, and what to change: discovery failures, empty selections, cache misses you did not expect, sandbox refusals, and commit and scaffold refusals."
---

Every entry below is a message the CLI actually prints. Match the symptom, not
the guess.

## The workspace is not found

**`not a workspace; create .smithers/WORKSPACE.ts`**

No ancestor of `--workspace` (default: the working directory) holds
`.smithers/WORKSPACE.ts` or a root `WORKSPACE.ts`.

Check that the file is named exactly that. Discovery compares against the
directory listing, so `Workspace.ts` is not found even where the filesystem
would open it, and a symlinked declaration is rejected outright. Pass
`--workspace <dir>` explicitly when running from outside the tree.

**`current directory is outside workspace: <dir>`**

A `:name` label needs a working directory inside the workspace to resolve
against. Use an absolute `//pkg:name` label, or `cd` into the tree.

**`nested workspace <path> is not declared`**

The walk found a nested checkout carrying its own workspace declaration. Add
it to the root declaration as an opaque child repository, exactly as the
message spells out:

```ts
repos: { "child-name": S.LocalRepository("path/to/child") }
```

**`discovery exceeds its depth limit of 256`** (or its directory or entry
limit)

The walk hit a hard ceiling and refused rather than truncating. Something is
almost certainly wrong with the tree: a symlink loop the walk followed, or a
generated directory that should be under the cache directory or
`node_modules`.

## Nothing was selected

**`no targets selected by <pattern> for the <verb> verb`**

The pattern matched nothing that participates in that verb. Two different
faults produce it.

First, check the pattern itself:

```bash
pnpm exec smithers-build query '<pattern>'
```

If `query` lists nothing, the fault is in discovery or in the pattern. If
`query` lists rows whose `kinds` do not include the verb, the targets exist
but do not participate. Run `target` on one of them to use the verb its rule
implies.

**`target <label> is gated to <kinds> and cannot be included in the <verb> verb`**

The target declares which verbs may reach it, and this is not one of them.

**`target dependency cycle reaches <label>`**

Two declaration modules import each other, or a `deps` chain closes. The
message names where the cycle was detected; `query 'deps(<label>)'` shows the
chain.

## A package failed to load

**`declaration_dependency_mismatch: <package> resolves to ...`**

A declaration or a relative helper selects a different physical runtime
package from the CLI. The message includes both manifest paths. Install the
matching workspace dependencies, remove a linked package's private runtime
copies, and invoke the CLI installed in that workspace. Two copies at the
same version can still have different schema sentinels and continuation tables.

**`declaration_dependency_unresolved: cannot resolve <package> ...`**

The dependency check could not complete. The message names the underlying
filesystem or package-resolution error in parentheses, and the refusal carries
it as its cause. Install the workspace dependencies.
See [Declaration loading](./concepts/declaration-loading.md).

**`two targets carry one label: <label>`** and
**`two labels collide case-insensitively: <a> and <b>`**

Two keys of one `S.Package({ targets })` produce the same label. The
case-insensitive form is the one that only fails on some machines, so it is
checked everywhere.

**`a target was declared by <path>, a case variant of the discovered <path>`**

A case-mismatched import evaluated a second instance of a declaration module.
Fix the import's spelling to match the file on disk.

**`Package key <key> fails the target grammar`** and
**`Package key <key> does not hold a target`**

A key of the `targets` object is not a usable target name, or its value is not
a target. Every value must come from an `S.*` rule call.

**`<label> reaches a <rule> target through its data attr`**

`data` means materialize a producer's files. It may not execute `Run` or
`Serve` targets. Move the dependency to `deps`.

## A run did not hit the cache

The cache is keyed, not timestamped, so an unexpected run means the key moved.

Compare the key previews between the two runs:

```bash
pnpm exec smithers-build test '//pkg:test' --plan --format json
```

Or capture full key material:

```bash
SMTHRS_DEBUG_KEYS=/tmp/keys.jsonl pnpm exec smithers-build test '//pkg:test'
```

The usual causes, in the order they turn up:

| Cause                                                | Where it shows                  |
| ---------------------------------------------------- | ------------------------------- |
| A different Node version, platform, or architecture  | `inputs.ambient`                |
| A changed lockfile                                   | `inputs.ambient.lockfile`       |
| An edited executor or rule                           | `inputs.ambient.implementation` |
| An input glob that matches a file you did not expect | `inputs.declared`               |
| A dependency that itself re-keyed                    | `inputs.dependencies`           |

Execution keys hash declared environment values and resolved executable identities.
Inherited `HOME`, `TMPDIR`, `TEMP`, and `TMP` do not affect the key; other inherited
allowlisted names contribute presence only. Declare an environment value in `env`
when outputs depend on it, and name tools with `bin`/`using` so their resolved
binary bytes participate in the key.

The implementation fingerprint is deliberate: editing the executor re-keys
every target, so a rule fix is never served a result the old rule produced.

A sandboxed target is a separate case. A result produced outside an enforced
confinement is evidence for this machine only and never reaches the shared
cache tier, so it will not hit on another host.

## A sandbox refused the target

**The run refuses a target that declares `sandbox`, and `--plan` reports the
refusal beside the declaration.**

The target asked for confinement and the host has no mechanism. The platform
picks bubblewrap on Linux (`bwrap` on `PATH`), seatbelt on macOS
(`/usr/bin/sandbox-exec`), and refuses elsewhere: Windows has no user-level
process sandbox, and Docker needs an image only the workspace can name.

Install the mechanism, or declare one with
`S.Sandboxes({ default: S.Sandbox.Docker({ image }) })`. The guard has no
partial mode: a confinement claim it cannot keep is not made.

**Linux refuses `{ network: "loopback" }`.**

Bubblewrap cannot expose only the host loopback interface. Sharing it requires
sharing the host network namespace, which also grants egress, so the executor
fails closed instead. Declare `{ network: true }` only if full network access
is acceptable. A target with `services` must make one of these network choices
explicit, or declare `sandbox: "none"` to opt out of confinement; listing a service does not silently open the network.

## A target wrote outside its write set

**The node fails and the change is reverted.**

That is the guard working. The target mutated a path its declaration does not
cover. Add the path to the declared write set, or stop writing it.

The failure ends with `the reverted bytes are kept at <cache directory>/reverted/…`.
That directory holds whatever the revert removed, at the same relative paths.

**The reverted path is one you edited yourself while the target ran.**

The guard cannot tell your edit from the tool's when the tool could write that
path, such as a file beside a declared output at the workspace root, or any
path when the target runs with `sandbox: "none"`. Copy your edit back from the
quarantine directory the failure names. Changes outside the tool's writable
directories are never judged, so an edit elsewhere in the tree is left alone.

**A change is reported `not restored`.**

The write landed inside a nested repository, a directory git does not enter.
The census never held its contents, so removing the change would destroy data.
Clean it up by hand.

**The target refuses before it runs, naming a gitignored path or a portal.**

The gitignored census could not hold the tree whole: it crossed the 50,000
entry or 1 GiB ceiling, or held a path it could not read. An escaping symlink
portal over its entry cap refuses the same way. Usually this means a large
generated tree belongs under the cache directory or `node_modules` rather than
loose in the workspace. A regenerable repository-local tool cache can also be
listed in `S.Cache({ directory: ".flows", hostDirectories: [".backend-go-modcache"] })`.
Its ignored contents then remain in place as host state outside rollback;
tracked files and other ignored data remain guarded. Never declare a directory
containing unique local data.

For evaluation journals and grading receipts, follow
[Preserve evaluation evidence](./guides/preserve-evaluation-evidence.md).

## A commit refused

**`unrelated_changes`**

A `Git.Commit` target with no declared path scope found changes in the working
tree that the commit does not own, or staged paths outside its scope. The
message names them.

Commit or stash the unrelated work, or pass `--sweep` to let the target commit
the whole working tree deliberately.

**`gates_failed`**

A gate was red against the tree the commit would record. The gates run in a
scratch copy that holds the staged tree, so an unstaged or untracked edit
outside the scope is not what they see. If a gate passes locally and fails
here, the fix it relies on is probably outside the `changes` scope: widen the
scope or commit that file first. A gate rule that cannot run against a scratch
tree reports that it cannot be executed against a candidate tree.

**`candidate_changed`**

The index changed after the gates judged the candidate, or a `pre-commit` hook
restaged a path, so the commit would have recorded a tree nobody gated. HEAD
is left where it was. Stop the concurrent writer or the restaging hook and run
the target again.

## A review was skipped rather than run

**`smthrs: skipped <label>: the <executable> CLI is not installed on this
host, so the review did not run`**

The review target selected an engine executable this machine does not have. A
skip leaves the run green, because `ok` counts failures alone, and the skip
still appears in the report under its own glyph.

This is the honest report, not a bug: a machine with no `codex` on `PATH`
cannot say whether the change is clean, and reporting "unclean" would be a red
gate no commit could turn green. Install the engine CLI, or accept the skip.

## An input flag was rejected

**`--input expects name=value, received "x"`** and
**`--input names "x" twice`**

`--input` is repeatable and each entry must carry an `=`. A repeated name is
refused rather than silently taking the last value.

## The install verb failed

**`the root PACKAGE.ts declares no Install target`** or
**`... declares more than one Install target`**

The `install` verb runs exactly one `Install` target from the root package.

**`install requires cacheDirectory ".flows"`**

This is the programmatic `runInstall`, whose store boundary is fixed at
`.flows/store`. Drop the `--cache-dir` override for the install path.

## Git hooks report drift

**`git hooks drift (run with --write to install): pre-commit=stale`**

The scripts in the directory returned by `git rev-parse --git-path hooks`
do not match what the workspace declaration renders.
`smithers-build git-hooks --write` installs the rendered scripts.

## The scaffold refused

See [Scaffold an app](./guides/scaffold-an-app.md) for the `create-app`
refusals and the package versions copied into a new app.

## Progress output looks wrong

Under `--ui auto` the renderer is chosen from the environment. Force one to
find out which layer is deciding:

```bash
pnpm exec smithers-build test '//...' --ui plain
```

`SMTHRS_UI` overrides `auto` the same way. An explicit `--format` also forces
`plain`, because a program is reading. The full resolution order is in
[Output and renderers](./concepts/output.md).

## A run will not stop

The first `SIGINT` or `SIGTERM` aborts every running target, reverts write
sets, cleans up scratch, and stops services gracefully, then exits 1. That
unwind takes as long as the slowest graceful stop.

The second interrupt stops the process at once, with none of that cleanup.
Prefer waiting for the first one.

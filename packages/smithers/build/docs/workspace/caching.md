---
title: "Caching"
description: "How a target's content key is built, what the result cache stores, when a lookup is admitted, and what re-keys a target."
---

Every target gets a content key. The executor looks the key up before running a
cacheable target and stores the result after a green run.

## The content key

The planner builds four fields of key material for each target, encodes them
deterministically, and takes the sha256 of the encoding.

| Field          | Contents                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `body`         | The target's flow tag, target id, schema identity, declared output roots, and `EXECUTION_FORMAT`                       |
| `inputs`       | The ambient identity, the canonicalized attrs, the expanded declared inputs, and the dependency labels with their keys |
| `layers`       | A catalog-declared layer identity list                                                                                 |
| `capabilities` | A catalog-declared capability list                                                                                     |

### The encoding is injective

Key material is encoded into a type-tagged, length-delimited byte string, and
the sha256 of that string is the key. Object keys sort by UTF-16 code unit, so
equal material hashes identically on every host.

Every form carries a distinct tag, so no two values of different types can
collide: `null`, `undefined`, `true`, `false`, a finite number (with `-0`
distinct from `0`), a string, an array, and a plain object are all encoded
differently, and every variable-length form carries its own length so a string
cannot be made to look like a nested structure.

The encoding fails closed. A cycle, a non-finite number, a bigint, a symbol, a
function, an accessor property, a symbol-keyed or non-enumerable own property, a
sparse array, and any object whose prototype is neither `Object.prototype` nor
null all raise a `KeyMaterialError` and fail the plan. This replaced a
`JSON.stringify` of a canonical form that mapped `undefined` to a sentinel
string, `NaN` and `Infinity` to `null`, and a revisited object to `"<cycle>"`.
A legitimate attr value could also produce each of those, so two different
targets could share one key.

Two substitutions happen inside `inputs.attrs` before hashing:

- A target reference becomes `{_tag: "Target", key: <dependency key>}`. A
  dependency's key change therefore re-keys its dependents, transitively.
- A declared input becomes `{_tag: "File" | "Glob" | "GitDiff", digest: <digest>}`.
  The pattern text and path never reach the key directly; only the content
  digest does.

`layers` and `capabilities` are hand-maintained tables in the planner:

| Target             | `layers`                   | `capabilities`                      |
| ------------------ | -------------------------- | ----------------------------------- |
| `PnpmWorkspace`    | `["package-manager:pnpm"]` | `fs:read`, `fs:write`, `proc:spawn` |
| `LlmLint`          | `["model:<model attr>"]`   | `git:diff`, `model:call`            |
| `Clean`            | `[]`                       | `fs:delete`                         |
| `Dev`, `ToolBuild` | `[]`                       | `proc:spawn`                        |
| Everything else    | `[]`                       | `fs:read`, `proc:spawn`             |

Under a declared [Nix environment](../concepts/environments.md) every target
whose capabilities include `proc:spawn` also carries `nix:<store hash>`: the
32-character hash of the closure its tools resolve from. The hash comes from
the resolved store path, not from the flake's text, so two flakes that
evaluate to one closure share keys and one flake evaluated by two nixpkgs
pins does not.

Deriving both lists from the real flow graph and its resolved layers, instead of
maintaining them by hand, is an open design question.

### Executable and environment identity

`PACKAGE.ts` execution keys the selected executable's resolved path and content
SHA-256, as well as each declared tool reference's resolution and executable
bytes. Changing the bytes behind a fixed version string causes a miss.
Workspace-local executable paths stay relative; host installations retain their
absolute paths.

The same allowlisted child environment used for execution supplies inherited
values such as `PATH`, `CI`, and SDK selection, with declared `env` and Nix
overrides applied. Its values enter key diagnostics as a digest. Unrelated
parent variables and withheld cache credentials do not enter it. Changes to
host `PATH` can therefore prevent cache sharing between checkouts. Dynamically
selected subprocesses and libraries still need declared tool/input dependencies.

### Implementation identity

The ambient `implementation` field is a digest of the loaded, shipped source
trees: the CLI, target catalog, build runtime, execution libraries, and pinned
runtime dependencies. Logical root names, relative file names, and file bytes
enter the digest; absolute paths never do. Two checkouts of the same sources at
different locations therefore agree on the key and can share a cache.

`Target.Metadata.implementationDigest` is not persistent key material. It
includes process-local entropy for any callback not declared with
`Node.capture`, because JavaScript cannot inspect an ordinary closure's captured
values. It distinguishes target implementations within one process, but would
force every target to miss in the next process.

The ambient fingerprint covers the complete shipped implementation rather than
only the declared callback: helpers, action layer implementations, and the
executor's own admission logic all re-key every target when any source byte
changes. There is no salt to remember to bump. `EXECUTION_FORMAT` remains for
deliberate semantic breaks.

## What re-keys a target

- Editing any file a declared `file()` or `glob()` matches.
- Adding or removing a file a `glob()` matches. The glob expands to a sorted file
  list, and the list plus per-file digests are hashed.
- Changing the content of the diff a `gitDiff()` names. The digest is the sha256
  of the `git diff --binary <base>...HEAD` patch text.
- Changing any attribute value, including `cwd`, a boolean flag, or a tool
  choice.
- Any change to a transitive dependency's key.
- For `LlmLint`, changing the `model` attribute, which also changes `layers`.
- Any change to the bytes of the shipped `cli/src`, `targets/src`, or `src`
  sources, through the ambient implementation fingerprint.
- Under a declared Nix environment, any change to the closure: an edit to the
  flake, its lock, or the expression file that changes the store path.

Two things deliberately do not re-key a target: the workspace's absolute path,
and the resolved cache directory name. See
[Configuration](configuration.md#why-the-directory-is-not-key-material).

## Cacheability

A target is **non-cacheable by default**. `Target.make` takes an explicit `cache`
boolean or a function of decoded attrs. This fails safe for custom targets and for
catalog targets that invoke an external tool whose complete toolchain identity is
not yet key material.

| Target                                        | Cacheable                                                        |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `DocsParity`, `Filegroup`, `PackageJsonCheck` | Always; each is a bounded in-process check over declared content |
| `GithubCiGen`                                 | In `check` mode; never in `write` mode                           |
| `ToolBuild`, `NodeTest`                       | Only when the declaration sets `cache: true`                     |
| Rules the executor runs natively              | As their rule policy says; `Shell.Test` caches in `execute` mode |
| Every other catalog target                    | Never                                                            |

Mutation, long-lived processes, model calls, and external publication are never
cached. External compiler, test, and lint targets remain non-cacheable by
default: the executable the target spawns is key material, but a program can
still read files its declaration does not name, and an unconfined run cannot
prove it did not. `cache: true` on a `NodeTest` is the declaration's assertion
that `srcs` and `deps` cover everything it reads.

A declared [Nix environment](../concepts/environments.md) enters keys through
the tool environment, but does not by itself make these targets cacheable.

A result produced without enforced confinement is stored in the local tier
only; it never publishes to a remote cache.

### Native tool contract evidence (#1871)

TsBuild, Typecheck, Vitest, EsLint, and Dprint run through the action-backed
executor. Their planner now fingerprints the declared manager and runtime
bytes, including interpreter chains, and records the tool environment even
without a native argv. Missing or unreadable declared executables refuse the
plan. Vitest uses the same runtime override selection as execution.

Default caching remains blocked on complete installed-tool and output contracts:

- Identify the actual cwd-selected compiler, test runner, lint tool, dprint
  native binary, and plugin bytes, not only the manager shim or version.
- Restore TsBuild outputs from the artifact cache in a fresh checkout.
- Declare and restore Typecheck build/incremental and Vitest coverage outputs,
  or keep those modes non-cacheable. Keep formatter and lint fix modes
  non-cacheable.
- Prove cold-run execution and unchanged second-run hits for all five through
  `ci`, plus binary, lockfile, config, source, environment, and dependency
  invalidation; prove missing tools, failed checks, and undeclared reads never
  produce reusable successes. Retain Linux enforced-sandbox evidence before
  shared publication, and prove Affected still selects all incomplete contracts.

`build-cli/test/CatalogToolIdentity.test.ts` specifies unchanged and documentation
key stability, launcher and interpreter replacement with unchanged versions,
config and lockfile invalidation, missing-interpreter refusal, and the retained
non-cacheable defaults. Its POSIX shebang fixtures skip Windows; Windows wrapper
identity still requires separate evidence. These tests require host CI execution; authoring them
is not evidence of a passing test or cache hits.

## Keys vary by verb

The planner resolves a target's attrs, declared inputs, declared outputs, and
cacheability through `Metadata.forKind(verb)` for `build`, `test`, `lint`,
`run`, and `docs`, and uses the declared form for `graph` and `query`.

A target that maps one verb to a different form of its attrs therefore has a
different content key under each verb. The generator targets do exactly this: under
`lint` they run their drift-check form, which declares the output file as an
input and is cacheable, and under `build` they run their write form, which
declares no output input and is not cacheable.

Dependencies never vary by verb. See
[Verb-effective attrs](../concepts/targets.md#verb-effective-attrs).

## The result cache

The executor opens the cache once per run and closes it afterwards.

Local entries live under `<cacheDirectory>/cache/<first two characters>/<key>.json`.
A key that is not already a safe single path segment is replaced by its sha256, so
a key can never escape the cache directory.

A stored entry holds the key, the target, the label, `exitOk`, the target's success
value, and an ISO timestamp. A success value that cannot be recorded faithfully
is not stored at all; see [Storage](#storage).

### Publication is atomic

The entry is written to a sibling temporary file and renamed onto the entry path,
following Bazel's `DiskCacheClient.saveFile`:

- The temporary file is created with exclusive create under a name unique to the
  write, so two writers of one key can never share it and a stale temporary file
  left by a crashed process is never adopted.
- The bytes are flushed to the device and the file is closed before the rename.
  The operating system is free to reorder a write and a rename, so without the
  flush a crash can leave a renamed but empty entry.
- A failed close never publishes as success, and the containing directory's
  fsync is real I/O: on POSIX only the narrow codes that mean the filesystem
  does not implement directory sync are tolerated, while permission, open, and
  unknown errors fail the write. Windows has no portable directory descriptor
  through Node and skips the barrier deliberately.
- Temporary removal is attempted on every failure. If it fails, the diagnostic
  retains the primary error code and reports cleanup as a secondary cause;
  cleanup failure after an otherwise-complete concurrent publication is also
  reported rather than silently leaking one file per writer.
- On POSIX the rename replaces the destination atomically, and the directory
  entry is flushed afterwards. Windows refuses a rename onto a destination another
  process holds open; because entries are content addressed, an existing
  destination that decodes for the key is accepted as the same publication rather
  than reported as a failure.

A reader therefore sees either no entry or a whole entry, never a partial one.

### The cache directory stays inside the workspace

`cacheDirectory` is validated lexically when it is declared: it must be
relative, non-empty, and free of `..`. That is not enough on its own, because
the directory it names can be a symbolic link to somewhere else entirely. Every
ancestor is therefore resolved when the cache is opened, again after the
directory is created, and again before an entry is written, and a cache
directory that leaves the workspace fails the command before anything is
created out there. `Exec` applies the same check before it substitutes the
cache-directory token into a tool's argv.

The unavoidable limit: Node exposes no portable descriptor-relative open, so an
ancestor directory replaced by an outside-pointing link between a check and a
later write is not detected. What is closed is the durable case: a workspace
whose cache directory is a link.

### Reads are bounded and untrusted

An entry file may have been written by another workspace, hydrated from a
shared remote, restored from a backup, or hand edited, so the read defends
itself:

- `lstat` refuses a symbolic link, FIFO, device, socket, or directory before
  anything is opened. The open adds `O_NOFOLLOW` and `O_NONBLOCK` where the
  platform provides them, and the descriptor is `fstat`-checked to be the same
  regular file. A concurrent publish loses that identity check and is retried.
- An entry larger than 16 MiB is a miss, checked on the descriptor before a
  byte is read.
- A remote body is capped at 1 MiB (the server's action-entry limit), by exact
  `Content-Length` when declared and by accumulated bytes and chunk count while
  a chunked or streaming body is read. Local entries retain the 16 MiB ceiling.

Every request to the remote (the fetch, its whole body, and the parse) runs
inside one deadline that is a real race against a timer, not only an
`AbortSignal`. A `fetch` that ignores the signal, or a body that never
completes, degrades the store to local-only instead of hanging the run.

### Admission

An entry answers for a target only when all of the following hold:

- It decodes, and it names the requested key.
- It names this target's definition and this target's label. Key equality alone is
  not identity: a store shared between workspaces, or a hostile remote, can
  file another action's result under a forged key.
- `exitOk` is true. A stored red result is never replayed.
- Its output manifest matches the target's declared outputs exactly and
  measurement still agrees with it, when the target declares outputs.
- The target's declared inputs still match the snapshot the plan measured,
  checked before the lookup and again after the outputs are measured.

Anything else is a miss, and the target executes.

### Declared outputs are exact

A target declares its output tree, a `cwd` and an ordered list of paths, as
target metadata. `ToolBuild`, `TsBuild`, and `DtsBuild` all do. The declaration is
never read back out of attrs or out of a cache entry, so neither an untrusted
entry nor a producing implementation gets to choose which paths are verified.

Both a fresh success and a cache admission require a top-level manifest whose
entries match the declaration one for one, in declaration order, with a
non-negative safe-integer `fileCount` and a lowercase 64-character hex
`contentDigest`. An omission, an extra, a reorder, a duplicate, a forged path, a
malformed count or digest, and a missing manifest are all refused. Every
declared path is then re-measured.

The two outcomes differ by side: a cache entry that fails this is a miss, and a
fresh success that fails it is a **target failure**. A producing implementation
that returns success without its manifest has proved nothing about its outputs,
so it fails rather than caching green. A target that declares no outputs is not
required to carry a manifest, and an `outputs` member on such a target's result is
never used to decide what gets measured.

The declaration itself is validated where the target is written and again at
execution: an absolute path, a `..`, the declaring directory itself, anything
under `.flows` or `.git`, two paths that resolve to the same output, and a path
already covered by another are all refused. See
[ToolBuild](../reference/targets/tool-build.md) for the full list and the reason
each one exists.

### Measurement is bounded and race-checked

Measuring an output is what makes a manifest evidence, so it defends itself the
way an entry read does:

- File contents stream through one fixed buffer. An artifact of any size costs a
  fixed amount of heap, and a large output no longer forces a whole-file
  allocation.
- Every file is opened with `O_NOFOLLOW` and `O_NONBLOCK` where the platform has
  them, and the descriptor is `fstat`-checked to be a regular file with the
  identity its parent listing observed. A symbolic link, FIFO, or device swapped
  in after the listing is refused, and a FIFO cannot block the open.
- The file is `fstat`-checked again after its last byte. A file appended to,
  truncated, or replaced while it was being read fails the output rather than
  contributing a digest of something that no longer exists.
- Every traversed directory is re-checked against the canonical workspace root
  and against the identity its parent observed, before and after its entries are
  read. A directory renamed mid-capture fails the output rather than publishing
  a manifest assembled from two trees.
- The tree's metadata is capped on file count, nesting depth, per-path bytes,
  and total path bytes, and passing a cap fails the whole output. There is never
  a truncated manifest.

The unavoidable limit is the same one the cache directory has: Node exposes no
portable descriptor-relative open, so the window between the last check and the
syscall it guards stays open for an intermediate directory. `O_NOFOLLOW` and the
descriptor's own `fstat` close it for the file being hashed. This is not race
freedom; it is every check a portable Node API can make.

### Inputs are revalidated, not assumed

The planner measures a target's declared inputs once. Everything after that (the
key a hit is admitted under, the key a result is published under) is only sound
while that measurement still holds, so it is taken again: before the
lookup and execution, after output validation on the hit path, and after a
successful execution. Paths and per-file digests are compared, not only how many
files matched.

A changed or unreadable snapshot is an ordinary target failure: the target
reports `failed`, its dependents report `skipped`, nothing is published, and
every other target still runs. It used to be a warning line followed by a green
`ran`.

The unavoidable limit: a file can always change between the last comparison and
the syscall that acts on it. No portable filesystem API hands out a token for a
version of a tree. What this closes is the whole plan-to-execution window, which
is seconds or minutes wide in a real run.

### Storage

- A lookup runs only when the target is cacheable and `--no-cache` was not passed.
- A hit reports `hit`, skips the run, and does not re-execute the tool.
- A green run of a cacheable target stores its result. A failure to store prints
  one warning line and does not fail the run.
- A result produced outside an enforced confinement is stored in the local tier
  only. Publishing to the remote tier needs a confined run; see
  [Hermeticity](../concepts/actions-and-boundaries.md#hermeticity).
- `--no-cache` bypasses reads and still writes.

Only a result that round trips through JSON without type loss is stored: null,
booleans, finite numbers, strings, plain objects, and dense arrays of the same. A
cycle, a nested `undefined`, `NaN`, `Infinity`, a bigint, a function, a symbol, a
`Date`, a `Map`, and a class instance all leave the target green and skip
publication with a diagnostic. A top-level `undefined` is the one accepted
non-JSON value: it is what a target whose success schema is `Void` returns, and an
explicit tagged envelope records it without confusing it with `null`. Storing
an unserializable result as `null` and replaying it later was the bug this
replaced.

A cache hit replays the recorded success value only. It does not restore output
files. Build targets that produce files record digests of what they produced, not
the files themselves. A hit is only reported when those digests still measure
correctly, so a target whose `dist` directory was deleted re-executes.

## Planning versus caching

The planner computes the key but consults no cache. `--plan` output still reports
`cacheLookup: "not-wired"` and `wouldRun: true` for every target. Those two
fields are stale relative to the executor, which performs the real lookup at
execution time.

## Next

- [Remote caching](remote-caching.md)
- [Inputs](../concepts/inputs.md)
- [Actions and boundaries](../concepts/actions-and-boundaries.md)

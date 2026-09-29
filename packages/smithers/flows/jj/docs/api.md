---
title: "API reference"
description: "Every export of @smthrs/jj and its subpaths: the Jj contract, the JjError vocabulary, the Node, Bun, and browser layers, the binary resolver, and the WASI preview 1 shim."
---

One program, three layers. The body never changes; the import at the top decides
which adapter runs it.

```ts
// Node
import { Jj } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const jj = yield* Jj
  return yield* jj.snapshot("before the step")
}).pipe(Effect.provide(NodeJj.layer))
```

```ts
// Bun
import { Jj } from "@smthrs/jj"
import * as BunJj from "@smthrs/jj/bun/BunJj"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const jj = yield* Jj
  return yield* jj.snapshot("before the step")
}).pipe(Effect.provide(BunJj.layer))
```

```ts
// Browser
import { Jj } from "@smthrs/jj"
import * as BrowserJj from "@smthrs/jj/browser/BrowserJj"
import * as Effect from "effect/Effect"

const makeProgram = (options: BrowserJj.BrowserJjOptions) =>
  Effect.gen(function*() {
    const jj = yield* Jj
    return yield* jj.snapshot("before the step")
  }).pipe(Effect.provide(BrowserJj.layer(options)))
```

The package root holds the contract, its error, and the no-op layer only, so it
bundles for the browser. Implementations live under `/node`, `/bun`, and
`/browser`. The package shares its `effect` peer with the host and depends on
`@smthrs/capability` (its error channel names
`Permission.PermissionError`); [`@smthrs/kernel`](/api/kernel) depends on it,
because `Jj` is one of the tags in the closed host list.

## @smthrs/jj

The root entry point re-exports every member of `Jj.ts` flat.

### The Jj service

`Jj` is deliberately small: only the operations that make a step reversible.
`snapshot`, `restore`, `diff`, `workspaceAdd`, `workspaceForget`, and `status`
are required of every backend. `root`, `revert`, and `opRestore` are optional
on the type, so a hand-written test double may leave them out.

| Member                                | Signature                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `snapshot(message?)`                  | `(message?: string) => Effect<Snapshot, JjFailure>`                                             |
| `restore(revision)`                   | `(revision: Revision) => Effect<void, JjFailure>`                                               |
| `diff(from, to)`                      | `(from: Revision, to: Revision) => Effect<string, JjFailure>`                                   |
| `workspaceAdd(name, path, revision?)` | `(name: string, path: string, revision?: Revision) => Effect<void, JjFailure \| PlatformError>` |
| `workspaceForget(name)`               | `(name: string) => Effect<void, JjFailure>`                                                     |
| `status()`                            | `() => Effect<string, JjFailure>`                                                               |
| `root(from)` (optional)               | `(from: string) => Effect<string, JjFailure \| PlatformError>`                                  |
| `revert(revision)` (optional)         | `(revision: Revision) => Effect<{ readonly reverted: ReadonlyArray<string> }, JjFailure>`       |
| `opRestore(operationId)` (optional)   | `(operationId: OperationId) => Effect<void, JjFailure>`                                         |

`snapshot` captures the working copy and returns `{ commitId, changeId,
operationId? }`. Restore to `commitId`: it is content addressed, and jj
resolves it even after later edits rewrite the working copy and hide it.
`changeId` is for display; a later rewrite such as `jj squash` moves it to a
different tree. `operationId` is the jj operation that recorded the capture;
Node and Bun report it, the browser layer does not.

`restore` puts the working copy back to `revision`, replacing the tree rather
than merging into it. `diff` is a git-format unified diff between two
revisions. `workspaceAdd` adds a named workspace rooted at `path`, one lane per
parallel agent; with `revision` its new change holds that revision's tree on the
revision's parents. `workspaceForget` drops
a named workspace without touching the commits made in it or the directory on
disk. `status` returns the working copy's status as jj prints it.

`root` answers `jj root` for the directory containing `from`, which is correct
for colocated repositories and secondary workspaces that a walk up looking for
`.jj` would get wrong. `revert` applies the reverse of one change and reports
the paths it touched.

`restore` and `revert` exist because one cannot express the other. `restore`
discards everything committed after the recorded point. `revert` undoes one
change and keeps the rest, which is what an operator means by "undo that
attempt".

`opRestore` runs `jj op restore`: the whole repository view returns to the
operation, so bookmark moves, rebases, `describe`, and `abandon` made after it
are undone along with the tree. Node and Bun restore `--what=repo`, so what jj
knows about remotes is kept, and refuse with `conflict` when any other
workspace was added or moved after the operation, because the restore would
reset or drop it. It accepts only a hex operation id, and an id jj does not
know fails `invalid_ref`.

`PlatformError` is in two error channels because the guarded implementation
canonicalizes a path against the workspace root before it asks for a
capability, and resolving a path is a filesystem operation that can itself fail.

Every layer this package ships defines the optional members anyway, and
answers `not_installed` in the error channel where the backend cannot perform
them. **Feature detection is by error code, never by property absence**:
`"revert" in jj` is true for `makeNoop`, for `BrowserJj.make`, and for
`BrowserJj.layerUnsupported` alike, so a caller that needs to know asks and
reads the code it gets back. An absent capability is a capability with an
answer.

The optional operations are capability-checked like every other one:
`jj:root` is `sealed`, and `jj:revert` and `jj:op-restore` are `compensable`.

### Service construction

| Export                 | Signature                               | Meaning                                                                                                             |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Jj`                   | `Context.Service<Jj, Jj>`               | The service key. The tag string is `"@smthrs/jj/Jj"` and is durable identity.                                       |
| `make(impl)`           | `(impl: Jj) => Jj`                      | Brands an implementation as the service, so a new backend is checked where it is written.                           |
| `makeNoop(overrides)`  | `(overrides: Partial<Jj>) => Jj`        | A stub whose every unoverridden method fails `not_installed`, naming the method called.                             |
| `layerNoop(overrides)` | `(overrides: Partial<Jj>) => Layer<Jj>` | `makeNoop` as a layer.                                                                                              |
| `ChangeId`             | `type ChangeId = string`                | A moving display pointer for a change; use the snapshot's immutable `commitId` to restore recorded workspace state. |

### Failures

| Export                | Signature                                                                                                                          | Meaning                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `JjErrorCode`         | `Schema.Literals<["not_installed", "conflict", "invalid_ref", "snapshot_refused", "unsupported_version", "unknown"]>` and the type | The closed reason vocabulary.                                                                                            |
| `JjError`             | `class JjError` with `_tag` `"@smthrs/jj/JjError"`                                                                                 | A jj failure, shaped after `effect/PlatformError`.                                                                       |
| `jjError(options)`    | `(options: { code: JjErrorCode; module?: string; method: string; description?: string; command?: string }) => JjError`             | Composes the human message from the code, the failing `module.method`, and the description. `module` defaults to `"Jj"`. |
| `isJjError(error)`    | `(error: unknown) => error is JjError`                                                                                             | Tells "jj said no" from "the capability kernel said no" without matching `_tag` by hand.                                 |
| `JjFailure`           | `type JjFailure = JjError \| Permission.PermissionError`                                                                           | Everything a `Jj` operation can fail with.                                                                               |
| `JjErrorCause`        | `Schema.Struct<{ name?: string; code?: string; message: string }>` and the type                                                    | The plain-data projection of an underlying host failure.                                                                 |
| `jjErrorCause(cause)` | `(cause: unknown) => JjErrorCause`                                                                                                 | Projects an arbitrary host failure onto that shape, truncating each field to fit.                                        |
| `causeMessageLimit`   | `1024`                                                                                                                             | How many characters each string in a `JjErrorCause` keeps.                                                               |

`JjError` carries a stable `code`, the `module` and `method` that failed, a
human `message`, the `command` that produced it, and an optional `cause`.

The codes are a stable public contract: callers branch on them, step keys
digest them, and user interfaces map them to remediation, so a code is added
and never repurposed. `not_installed` means no usable jj on this host,
`conflict` that the repository refused because the operation would conflict,
`invalid_ref` that the change id or revision does not resolve, `snapshot_refused`
that jj skipped files, `unsupported_version` that the CLI does not meet the
minimum, and `unknown` everything else. Node and Bun produce the two CLI-specific
codes; both adapters agree on their shared failures, and
[test/LayerParity.test.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/jj/test/LayerParity.test.ts)
drives one table of inputs through both and asserts they agree.

`cause` is a projection, not the host failure itself. `JjError` round-trips
through the journal, and an `Error` serializes to `{}` because its `message` and
`stack` are not enumerable, so the underlying failure is copied onto the three
fields of `JjErrorCause` (`name`, `code`, `message`) at construction. The schema
bounds every field by `causeMessageLimit`. The `JjError` constructor and the
journal decoder reject an over-length field; `jjErrorCause` is the supported
projection and truncates each field to fit.

## Implementations

Implementations are **not** root exports. The root is the portable contract and
bundles for the browser; each implementation is imported from its own subpath.

### @smthrs/jj/node/NodeJj

`NodeJj` shells out to the `jj` CLI with argv arrays and never a shell string.
It ships four layers, and they differ along two axes.

| Export                           | Signature                                                             | Process ownership | Repository      |
| -------------------------------- | --------------------------------------------------------------------- | ----------------- | --------------- |
| `layer`                          | `Layer<Jj, JjError>`                                                  | Its own child     | The process cwd |
| `layerAt(repositoryRoot)`        | `(repositoryRoot: string) => Layer<Jj, JjError>`                      | Its own child     | Bound, absolute |
| `layerSpawner`                   | `Layer<Jj, JjError, ChildProcessSpawner>`                             | The host spawner  | The process cwd |
| `layerSpawnerAt(repositoryRoot)` | `(repositoryRoot: string) => Layer<Jj, JjError, ChildProcessSpawner>` | The host spawner  | Bound, absolute |

Who owns the child process: `layer` spawns through `node:child_process`
directly, because a host must be able to checkpoint work where a spawner is
unavailable, sandboxed, or gated behind a `proc:spawn` grant the user has not
given. `layerSpawner` spawns through Effect's `ChildProcessSpawner`, so whatever
decorates that service decorates jj too: the child lands in a recorded process
group, in `@smthrs/kernel`'s `ProcessLedger`, and within reach of the reaper
that sweeps a crashed incarnation. `@smthrs/platform-node`'s contained host
bundle uses that one. Both share one command vocabulary and one classification,
so routing jj through a spawner changes nothing a caller can observe.

Which repository: `layerAt` and `layerSpawnerAt` bind jj to one absolute
repository root, so a later change to `process.cwd()` cannot redirect snapshots,
restores, or diffs into another checkout. A relative `path` handed to
`workspaceAdd` then resolves against that root rather than the caller's working
directory, so pass absolute lane paths. `root(from)` is exempt from the binding
by design, because its argument names the directory jj must run in. A relative
root is a wiring mistake and throws a `TypeError` at construction.

Node and Bun `snapshot` capture without closing a change: `jj op log -n1 -T id`
snapshots the working copy and names the operation, and `jj log --at-op` reads
`@` at exactly that operation. Nothing is committed, described, or opened, so a
compensable attempt leaves no change of its own in the log, and the message is
not written to the repository. The browser's frozen WASM ABI still closes the
current change and replaces its description when a message is supplied.

Repository state operations are fenced as a unit. `snapshot`, `restore`, and
`diff` share one single-permit semaphore per repository inside a process and an
exclusive `.jj/smithers.lock` owner directory across processes. The snapshot's
CLI calls therefore cannot interleave with another state operation. A caller
records lock owners as `hostname-pid-random` and reclaims only an owner on the
same host whose process is dead. Permission-denied probes count as alive;
foreign-host and legacy owner markers require operator cleanup.

Snapshot messages are opaque strings on both browser and CLI layers, including
empty strings, leading `-`, quotes, and newlines. Node and Bun never pass them
to jj; workspace names and paths use `--name=` and `--` so option-like values
are not interpreted as CLI flags.

Node and Bun require **jj 0.39.0 or newer**, pinned by the exported
`NodeJj.minimumVersion` constant. Before exposing `Jj`, all CLI layers await a
`jj --version` probe through the same runner used for operations. The probe
uses the absolute host executable selected at layer construction and does not
require the repository directory. Bound layers can be built before runtime
storage creates that directory; operations still require a valid working directory.
Probe results are shared per absolute path and runner for the process lifetime.
Each host spawner has its own probe cache. Restart the process after replacing a
binary at the same path. Operations keep using the verified path even if the
host or spawner PATH changes. An older or unrecognized version fails construction with `JjError.code = "unsupported_version"`
and the required minimum; a missing binary fails construction with `not_installed`.
All four CLI layers therefore have `JjError` in their layer error channel.

Node and Bun repository commands (except `root`) disable jj's default new-file size limit with
`--config snapshot.max-new-file-size=0`, so new artifacts larger than 1 MiB are
included. Any command that still warns `Refused to snapshot some files` fails
with `JjError.code = "snapshot_refused"`, even when jj exits successfully.

Every Node and Bun command passes `--color=never`, so a user config that sets
`ui.color = "always"` cannot put ANSI escapes into change ids, diffs, or roots.

Every Node and Bun command also passes `--config signing.behavior=drop`,
`--config fsmonitor.backend=none`, and `--config
signing.backends.<gpg|gpgsm|ssh>.program=/dev/null`, so no config file can
make jj start a signing, verification, or fsmonitor program. `--config`
outranks every config file. A commit these layers rewrite, such as a
snapshotted `@`, comes out unsigned.

Anything running in the checkout can write `.jj/`. When `.jj/repo/config-id`
or `.jj/workspace-config-id` is missing, jj imports `.jj/repo/config.toml` or
`.jj/workspace-config.toml` into its trusted config store on the next command.
The Node and Bun layers refuse to run while either file is waiting to be
imported, because a planted file could redefine `commit_id(x)` or the
templates `snapshot` reads. `snapshot` fails `unknown` if the values jj prints
are not a commit id, change id, and operation id.

A revision passed to `restore`, `diff`, `revert`, or `workspaceAdd` must be `@`,
`@-`, a hex commit id, or a reverse-hex change id; any other string fails
`invalid_ref` before jj is spawned. The Node and Bun layers look an id up as
`exactly(commit_id(id), 1)` or `exactly(change_id(id), 1)`, so a bookmark or
tag named after a recorded commit id cannot redirect a restore. Aliases already
in jj's trusted config store are the operator's and still apply.

One invocation buffers at most 64 MiB of each output stream, counted in bytes as
they arrive rather than in decoded characters, and past the ceiling the child is
killed and the operation fails `unknown`. The `command` recorded on a failure is
the argv rendered back as a typed line, capped at 512 characters. Both layers
apply both bounds.

A spawn that never produced a process is still a `JjError`.
`node:child_process` throws rather than emitting an `error` event for most
failures, so the adapter guards the construction, and it probes the working
directory before blaming the binary: a bound layer pointed at a directory that
is gone reports the directory rather than claiming jj is not installed.

### @smthrs/jj/bun/BunJj

Bun implements the same child-process API, so `BunJj` re-exports all four Node
layers rather than shipping a second implementation. Sharing the adapter is what
keeps the two runtimes from drifting.

| Export           | Same object as          |
| ---------------- | ----------------------- |
| `layer`          | `NodeJj.layer`          |
| `layerAt`        | `NodeJj.layerAt`        |
| `layerSpawner`   | `NodeJj.layerSpawner`   |
| `layerSpawnerAt` | `NodeJj.layerSpawnerAt` |

### @smthrs/jj/node/resolveJjBinary

Decides which file `jj` is, and explains the answer.

| Export                            | Signature                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveJjBinary(options?)`       | `(options?: Options) => Resolved`                                                                                                                                         |
| `describe(resolved)`              | `(resolved: Resolved) => string`                                                                                                                                          |
| `overrideVariables`               | `ReadonlyArray<string>`, currently `["SMITHERS_JJ_PATH"]`                                                                                                                 |
| `isExecutable(file, options?)`    | `(file: string, options?: { platform?: NodeJS.Platform; access?: (file: string, mode: number) => void }) => boolean`                                                      |
| `permissionHint(file, platform?)` | `(file: string, platform?: NodeJS.Platform) => string`                                                                                                                    |
| `shellQuote(value)`               | `(value: string) => string`                                                                                                                                               |
| `Source`                          | `type Source = "env" \| "path"`                                                                                                                                           |
| `Resolved`                        | `interface { path: string; source: Source; executable: boolean; hint?: string; variable?: string; ignored?: { variable: string; path: string } }`                         |
| `Options`                         | `interface { environment?: Record<string, string \| undefined>; platform?: NodeJS.Platform; exists?: (file: string) => boolean; executable?: (file: string) => boolean }` |

`SMITHERS_JJ_PATH` names the binary the adapter spawns. An override that names
an existing file stays authoritative even when it cannot be executed, so a
broken explicit path is reported instead of a different binary being quietly
substituted. An override that names nothing falls through to `PATH`, and the
fall-through is reported in `describe()`, and the Node and Bun layers log a
warning annotated with the variable and path when they are built. Existing overrides and executable
PATH candidates resolve to absolute host paths. Relative paths resolve against
the host cwd at layer construction. Preflight and operations use the same path
through the same runner, including when the host spawner changes PATH.
`smthrs doctor` prints `describe()`.

`resolveJjBinary` always returns a command: when jj is genuinely absent it
answers the bare name `jj` with `executable: false` and a hint, which keeps
the typed `not_installed` failure while giving `doctor` something specific
to print. `NodeJj` never spawns this unresolved fallback. The package vendors no
`jj` binaries and downloads none, so there is no bundled-package branch to fall
back to.

Every probe in `Options` is injectable, so a test pins the resolution order
without staging a filesystem. `isExecutable` checks the execute bit on POSIX and
mere existence on Windows; it is a probe and never a `chmod`. `permissionHint`
adds the macOS quarantine tip only on darwin, and quotes the path with
`shellQuote`, because the hint is remediation an operator pastes into a shell.

### @smthrs/jj/browser/BrowserJj

jj is a native binary, but jj-lib compiles to `wasm32-wasip1`.
`BrowserJj.layer({ fs, wasm })` runs the `flows_jj.wasm` reactor shipped at this
package's `wasm/flows_jj.wasm` over an injected virtual filesystem, through the
hand-written WASI preview 1 shim in this package. The mount and the compiled
module are arguments rather than dependencies, so the library never picks a
storage backend for its host, and persistence stays the page's concern.

| Export                 | Signature                                                 |
| ---------------------- | --------------------------------------------------------- |
| `make(options)`        | `(options: BrowserJjOptions) => Jj`                       |
| `layer(options)`       | `(options: BrowserJjOptions) => Layer<Jj>`                |
| `makeScoped(options)`  | `(options: BrowserJjOptions) => Effect<Jj, never, Scope>` |
| `layerScoped(options)` | `(options: BrowserJjOptions) => Layer<Jj>`                |
| `layerUnsupported`     | `Layer<Jj>`                                               |
| `BrowserJjOptions`     | `interface` (below)                                       |

| `BrowserJjOptions` field | Type                                 | Meaning                                                            |
| ------------------------ | ------------------------------------ | ------------------------------------------------------------------ |
| `wasm`                   | `WebAssembly.Module \| BufferSource` | The reactor, precompiled or as raw bytes. The layer never fetches. |
| `fs`                     | `SyncFsLike`                         | The synchronous filesystem the repository lives on.                |
| `root`                   | `string`, default `"/"`              | The workspace root inside that namespace.                          |
| `onStdout`               | `(text: string) => void`             | Receives jj-lib's stdout. Unset drops it.                          |
| `onStderr`               | `(text: string) => void`             | Receives jj-lib's stderr, where Rust panics arrive.                |

`root`, `fs`, `onStdout`, and `onStderr` are read once, when `make` is called.
`wasm` is read once too, but later, at the first operation, which is what lets a
page hand over bytes it is still loading. Raw bytes are copied at that read, so
the executable authority cannot be swapped between a failed operation and a
retry. Instantiation is lazy, and every operation runs under a single-permit
semaphore, because the wasm instance is single-threaded mutable state.

A reactor that traps (a Rust panic, `proc_exit`, a response outside memory) is
discarded: the shim closes every host descriptor the guest still held, and the
next operation instantiates a fresh reactor. `layerScoped` and `makeScoped`
close the live reactor the same way when their scope closes, after which every
operation fails with `unknown`. `layer` and `make` have no end of life beyond a
trap; the live reactor's descriptors last as long as the page.

`BrowserJj.layerUnsupported` is the layer for a host that ships no module. Every
operation reports `not_installed`, the same code the Node adapter reports for a
missing binary, so a caller needs no browser-specific branch. The command each
failure names is the one `NodeJj` would have run.

Three places where the browser backend answers differently from the CLI, each
because the frozen wasm ABI has no operation or field for it:

- `revert` is defined and always fails `not_installed`, with the message "jj is
  not available in the browser". The ABI has no revert operation. The method
  stays present so feature detection never depends on an optional property
  disappearing: ask, and read the code you get back.
- `workspaceAdd` with a revision is two calls, an add followed by a restore
  rooted at the new lane. The whole sequence runs uninterruptibly. If the pin
  fails, the adapter attempts a `workspaceForget` and reports the pin failure
  against `workspaceAdd`. A successful rollback frees the lane name but leaves
  the lane directory on disk, which is what `workspaceForget` does everywhere.
  If the rollback itself fails, the lane can stay registered. The caller still
  receives the pin failure, which is the one it can act on. Only a single ABI
  operation can make the pair atomic; the CLI adapter's single command needs no
  rollback.
- `root(from)` answers the configured slice root, and fails when `from` is not
  inside it rather than answering for an unrelated tree.

Every other divergence, including initialization and real symlink rejection,
is in [Run jj in a browser tab](./guides/run-jj-in-a-browser.md#where-the-wasm-backend-answers-differently).

### @smthrs/jj/browser/WasiPreview1

The syscall layer under the wasm build of jj, public because it is testable
without any wasm module: `make` returns plain functions over memory, a
filesystem, and a file-descriptor table.

| Export                | Signature                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `make(options)`       | `(options: WasiPreview1Options) => WasiPreview1`                                                                           |
| `Errno`               | A frozen record of WASI preview 1 errno names to numbers.                                                                  |
| `WasiExitError`       | Tagged error `@smthrs/jj/WasiExitError` with `readonly exitCode: number`, the unsigned `proc_exit` code                    |
| `WasiPreview1Options` | `interface { fs: SyncFsLike; root?: string; onStdout?: (text: string) => void; onStderr?: (text: string) => void }`        |
| `WasiPreview1`        | `interface { imports: Record<string, (...args: Array<any>) => number>; initialize: (memory: WebAssembly.Memory) => void }` |

Instantiate the module with `{ wasi_snapshot_preview1: shim.imports }`, then
call `initialize(memory)` before the module's `_initialize` runs, because
`_initialize` may already issue syscalls. One preopen is exposed: fd 3 names
`"/"`, mapped to `root` in the slice.

`Errno` is exported so tests assert numbers against spec names rather than magic
literals. `WasiExitError` is what a `proc_exit` from a reactor module becomes: a
thrown error that traps the calling export, which `BrowserJj` reports as a
failed operation.

The `root` option maps the guest namespace to one slice only when the host
excludes concurrent namespace mutation during each WASI syscall or the backend
independently confines every read and mutation. This includes replacement of
`root` and its host ancestors by native processes, other workers, or reentrant
backend callbacks. `SyncFsLike` uses separate string-path checks and operations;
the shim is not a security sandbox for `node:fs` under concurrent mutation and
does not detect or reject concurrent writers. Synchronous guest execution alone
does not satisfy the namespace-ownership requirement.

With that requirement satisfied, `..` of the namespace root is the root.
Symlinks resolve in namespace coordinates: absolute targets are re-rooted at
the preopen, and relative targets resolve against the link's directory.
Traversed ancestors must exist and be directories after expansion, including
components consumed by `..`. `/file/../victim` returns `ENOTDIR` when `file` is a
regular file; `/missing/../victim` returns `ENOENT`. A chain that exceeds the hop
budget returns `ELOOP`. No-follow rejects stable final symlinks with `ELOOP`.

Honest divergences from a kernel WASI host, documented rather than hidden:

- `fd_sync` and `fd_datasync` only validate the descriptor and report success.
  The slice has no flush operation and provides no durability barrier. After
  operations that must survive a reload, await the host mount's `sync` as
  described in [Durability is the mount's job](./guides/run-jj-in-a-browser.md#durability-is-the-mounts-job).
- `poll_oneoff` reports every subscription complete immediately: clock waits
  become yields, and a synchronous filesystem is always ready.
- `path_link` is `notsup`: the slice has no `linkSync`, and the jj code paths
  this package exercises never hard-link.
- `path_filestat_set_times` always follows symlinks, because the slice has no
  `lutimesSync`.
- `fd_readdir` lists the directory once per enumeration. A call at cookie zero
  takes a snapshot on the descriptor, later pages index it by cookie, and the
  snapshot is released when a page past the end yields nothing or the
  descriptor closes. Entries added or removed during an enumeration appear on
  the next cookie-zero enumeration.
- A directory file descriptor names a path, not an inode. Renaming the directory
  a descriptor was opened on makes the descriptor follow the name, where POSIX
  would keep naming the moved directory. Remembering the host path at open time
  would be worse than a divergence: a symlink left at the old name would then be
  followed out of the preopen.
- `sock_*` and `proc_raise` are `notsup`; there are no sockets or signals in a
  tab.

### @smthrs/jj/browser/WasiFs

Names the synchronous filesystem shape the shim runs over, and imports nothing,
so the browser bundle decides which backend is mounted.

| Export           | Meaning                                                                                                                                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SyncFsLike`     | The filesystem surface: `openSync`, `closeSync`, `readSync`, `writeSync`, `fstatSync`, `ftruncateSync`, `futimesSync`, `statSync`, `lstatSync`, `mkdirSync`, `readdirSync`, `renameSync`, `unlinkSync`, `rmdirSync`, `readlinkSync`, `symlinkSync`, `utimesSync`. |
| `SyncStatsLike`  | The `Stats` subset the shim reads: `size`, `atimeMs`, `mtimeMs`, `ctimeMs`, optional `ino`, and the three `is*` predicates.                                                                                                                                       |
| `SyncDirentLike` | The `Dirent` subset `fd_readdir` needs: `name` and the three `is*` predicates.                                                                                                                                                                                    |

Both ZenFS's sync API and Node's `node:fs` satisfy the shape structurally. Two
deliberate consequences: `openSync` takes Node string flags (`"r"`, `"r+"`,
`"w"`, `"wx"`) rather than numeric `O_*` constants, which are platform specific
and live on a module this slice refuses to import; and errors must be thrown
with a Node-style string `code` property (`"ENOENT"`, `"EEXIST"`, `"ENOTDIR"`),
which the shim maps onto WASI errno values.

The slice has no flush operation such as `fsyncSync`, so `fd_sync` and
`fd_datasync` provide no durability barrier. Synchronous completion does not
establish persistence. The host must await its mount's `sync` after operations
that must survive a reload; see [Durability is the mount's job](./guides/run-jj-in-a-browser.md#durability-is-the-mounts-job).

`ftruncateSync` is the sole truncation member. It and `futimesSync` are required because
the descriptor-addressed WASI calls must follow the open file even after a
rename, which is the shape of jj's tempfile-persist path.

## Durable identity

The tag key `@smthrs/jj/Jj` and the error `_tag` `@smthrs/jj/JjError` are
durable identity: step keys digest the resolved service set, and `JjError`
round-trips through the journal, so renaming either invalidates recorded runs.
[test/index.test.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/jj/test/index.test.ts)
pins both. See [Content addressing](/docs/concepts/content-addressing/).

## Which entry points bundle for a browser

| Entry point                       | Bundles for a browser                  |
| --------------------------------- | -------------------------------------- |
| `@smthrs/jj`                      | Yes. Contract, error, and no-op layer. |
| `@smthrs/jj/browser/BrowserJj`    | Yes.                                   |
| `@smthrs/jj/browser/WasiPreview1` | Yes.                                   |
| `@smthrs/jj/browser/WasiFs`       | Yes. Types only, and imports nothing.  |
| `@smthrs/jj/node/NodeJj`          | No. Imports `node:child_process`.      |
| `@smthrs/jj/node/resolveJjBinary` | No. Imports `node:fs` and `node:path`. |
| `@smthrs/jj/bun/BunJj`            | No. Re-exports the Node adapter.       |

Those answers are executed rather than asserted. Every entry point in the table
is bundled for a browser target and the result is required to match the column:
`@smthrs/jj` and `@smthrs/jj/browser/BrowserJj` must bundle, while
`@smthrs/jj/node/NodeJj` and `@smthrs/jj/bun/BunJj` must still fail, and fail
only because `node:child_process` is unresolvable. A Node dependency can
therefore neither creep into the contract nor silently disappear from the
adapters. Import the contract anywhere and pick the implementation per platform,
the same way `effect` keeps `@effect/platform-node` out of `effect`.

## Reading next

[`@smthrs/kernel`](/api/kernel) owns the closed service list and decorates `Jj`
with capability checks, and [`@smthrs/time-travel`](/api/time-travel) uses it for
workspace snapshot and restore. See also
[Capabilities and the host kernel](/docs/concepts/kernel/) and
[Time travel](/docs/concepts/time-travel/).

BrowserJj status, diff, and restore refuse missing repositories with typed
`unknown` failures and never initialize them. Snapshot explicitly invokes the
wasm `init` operation if the repository is absent.
The published package includes a generated Rust dependency inventory in
`THIRD_PARTY_NOTICES.md`. Maintainers regenerate it from the locked wasm Cargo
graph with `node scripts/generate-third-party-notices.mjs`; Rust CI runs the
script with `--check` to reject attribution drift.

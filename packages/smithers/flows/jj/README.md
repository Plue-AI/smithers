# @smthrs/jj

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://jj.smithers.sh

Jujutsu version control as a portable Effect host service. Nine operations
behind one service tag: snapshot the working copy, restore it, diff two
revisions, add and forget a workspace, read status, find the repository root,
revert one change, and restore a whole operation.

One program written against that service runs against the
[jj](https://jj-vcs.github.io) command line on Node and Bun, or against jj-lib
compiled to WebAssembly in a browser tab. Behind a service rather than an
ad-hoc `spawn`, the repository is explicit, failures are a closed set of six
codes, and a test swaps the layer instead of the code.

## Availability

`@smthrs/jj` is not on npm at 1.0.0-rc.0. Its source lives in the
[smithers repository](https://github.com/smithersai/smithers), and the
[installation page](https://jj.smithers.sh/installation/) covers how to depend
on it from a checkout, the `effect` version it pins, and the wasm asset a
browser layer needs.

`NodeJj` and `BunJj` spawn the `jj` executable, which this package does not
vendor. Install it once with `brew install jj` or
`cargo install --locked jj-cli`. With no usable jj, every operation fails with
the `not_installed` code and a message naming the fix, rather than throwing.

## Snapshot a working copy and put it back

```ts
import { Jj } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const jj = yield* Jj

  // `snapshot` captures the working copy without closing a change; the
  // commit id names exactly that tree.
  const { commitId } = yield* jj.snapshot("before the risky step")

  // ... do the work a step would do ...

  const patch = yield* jj.diff(commitId, "@")
  yield* jj.restore(commitId)
  return patch
}).pipe(Effect.provide(NodeJj.layerAt("/srv/checkouts/main")))

Effect.runPromise(program)
```

On Node and Bun, `snapshot(message)` captures the working copy without closing,
describing, or opening a change, so the user's log gains no commit per
snapshot. It returns `{ commitId, changeId, operationId }`: `commitId` is the
durable handle to store and restore, `changeId` is the display name and moves
with rewrites, and `operationId` is the jj operation that recorded the capture.
`opRestore(operationId)` runs `jj op restore`, which also undoes bookmark
moves, rebases, `describe`, and `abandon` made after it. The message is not
written to the repository.
`layerAt` binds jj to one absolute repository root, so a later change to
`process.cwd()` cannot redirect a restore into another checkout.

## Entry points

The root is platform-neutral and browser-bundleable: the contract, its error,
and the no-op layer only. Every implementation lives under an explicit subpath,
the way `effect` keeps `@effect/platform-node` out of `effect`, so importing the
contract never resolves a `node:` built-in.

| Import                            | Platform                                                    |
| --------------------------------- | ----------------------------------------------------------- |
| `@smthrs/jj`                      | Any. Contract only, and it bundles for the browser.         |
| `@smthrs/jj/node/NodeJj`          | Node, through `node:child_process`.                         |
| `@smthrs/jj/bun/BunJj`            | Bun, re-exporting the Node adapter.                         |
| `@smthrs/jj/node/resolveJjBinary` | Node. Which `jj` file this host spawns, and why.            |
| `@smthrs/jj/browser/BrowserJj`    | Browser. jj-lib compiled to wasm over a virtual filesystem. |
| `@smthrs/jj/browser/WasiPreview1` | Browser. The WASI preview 1 shim that module runs on.       |
| `@smthrs/jj/browser/WasiFs`       | Browser. The synchronous filesystem surface the shim needs. |

`NodeJj` and `BunJj` each ship four layers: `layer` and `layerAt` spawn their
own child, `layerSpawner` and `layerSpawnerAt` route the same commands through
Effect's `ChildProcessSpawner`, so a contained host contains jj too. All four
share one command vocabulary, one error classification, and one 64 MiB output
ceiling.

`SMITHERS_JJ_PATH` names the `jj` binary the Node and Bun layers spawn. An
override that names an existing file stays authoritative even when it cannot be
executed, so a broken explicit path is reported rather than a different binary
being quietly substituted.

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

Node and Bun snapshots disable jj's default new-file size limit with
`--config snapshot.max-new-file-size=0`, so new artifacts larger than 1 MiB are
included. Any command that still warns `Refused to snapshot some files` fails
with `JjError.code = "snapshot_refused"`, even when jj exits successfully.

Every Node and Bun command also passes `--config signing.behavior=keep` and
`--config fsmonitor.backend=none`. Anything running in the checkout can write
`.jj/`, and jj migrates a planted `.jj/repo/config.toml` into its secure
config once `.jj/repo/config-id` is gone, so a signing program or fsmonitor
backend named there would otherwise run with the host's privileges on the next
snapshot. `--config` outranks every config file.

A revision passed to `restore`, `diff`, `revert`, or `workspaceAdd` must be `@`,
`@-`, a hex commit id, or a reverse-hex change id; any other string fails
`invalid_ref` before jj is spawned. The Node and Bun layers look an id up as
`exactly(commit_id(id), 1)` or `exactly(change_id(id), 1)`, so a bookmark or
tag named after a recorded commit id cannot redirect a restore.

One invocation buffers at most **64 MiB of each output stream**, counted in
bytes as they arrive rather than in decoded characters. jj is not an attacker,
but the engine outlives any one command, so a child that never stops printing is
killed and the operation fails with `unknown` rather than filling a buffer
nobody will read. Both Node layers apply the same ceiling, since routing jj
through the host's spawner must not change what a caller observes.

`snapshot`, `restore`, and `diff` are serialized per repository. Fibers share a
single-permit semaphore, while separate Node or Bun processes coordinate through
an exclusive `.jj/smithers.lock` owner directory. A later caller reclaims a lock whose
owner process has exited, so a killed host does not strand the repository.

## Failures are six codes

Every operation fails with a `JjError` carrying a stable `code`, the `module`
and `method` that failed, the `command` that produced it, and a plain-data
`cause`. `not_installed` means no usable jj on this host, `conflict` that the
repository refused, `invalid_ref` that a revision does not resolve,
`snapshot_refused` that jj skipped files while capturing the working copy, and
`unknown` everything else jj reported. Nothing escapes as an untyped throw, and
the codes survive a journal round trip, so a recorded run keeps its meaning.

Two of those codes also fail a CLI layer before it hands out `Jj` at all, so a
composition sees them from the layer rather than from a call: `not_installed`
when the version probe finds no usable binary, and `unsupported_version` when
the binary it found is older than `NodeJj.minimumVersion` or prints a version
this package cannot parse. `unsupported_version` never reaches an operation.

**Feature detection is by error code, never by property absence.** A backend
that cannot perform an operation keeps the method and answers `not_installed`,
so `"revert" in jj` tells a caller nothing and the code that comes back tells
it everything.

## In a browser tab

A tab cannot spawn `jj`. It can run jj-lib itself, compiled to `wasm32-wasip1`
and shipped in this package as `wasm/flows_jj.wasm`. The page owns the
filesystem mount and the wasm bytes, so both arrive as arguments and the
library never fetches.

```ts
import { Jj } from "@smthrs/jj"
import * as BrowserJj from "@smthrs/jj/browser/BrowserJj"
import { configureSingle, fs } from "@zenfs/core"
import { IndexedDB } from "@zenfs/dom"
import * as Effect from "effect/Effect"

await configureSingle({ backend: IndexedDB })
const wasm = await WebAssembly.compileStreaming(fetch(wasmUrl))

const program = Effect.gen(function*() {
  const jj = yield* Jj
  return yield* jj.snapshot("before the step")
}).pipe(Effect.provide(BrowserJj.layer({ fs, wasm, root: "/repo" })))
```

Seven of the nine operations work there, with real change ids and a real
operation log. `revert` and `opRestore` have no operation in the compiled
module and report `not_installed`; its snapshot still closes a change and
reports no operation id. The backend also diverges from the command line in ways worth
reading before you assume parity: repositories use jj's Simple backend with no
git interop, only `snapshot` creates a missing repository while `status`,
`diff`, and `restore` refuse one with `unknown` and write nothing, real
symlinks are rejected before snapshotting, and durability belongs to the mount
rather than to this layer. All of them are listed in
[Run jj in a browser tab](https://jj.smithers.sh/guides/run-jj-in-a-browser/).

## More

- [Installation](https://jj.smithers.sh/installation/)
- [Quickstart](https://jj.smithers.sh/quickstart/)
- [API reference](https://jj.smithers.sh/reference/api/)
- [Troubleshooting](https://jj.smithers.sh/troubleshooting/)
- [`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/), which owns the
  closed host service list this contract is one slot of.

## License

The shipped Rust dependency inventory in `THIRD_PARTY_NOTICES.md` is generated
from the locked Cargo graph for `wasm32-wasip1`. After a dependency change, run
`node scripts/generate-third-party-notices.mjs` from the repository root;
`--check` detects drift and runs in Rust CI. The template under `scripts/` keeps
the attribution prose and license text; new license groups require review.
MIT. See [LICENSE](./LICENSE).

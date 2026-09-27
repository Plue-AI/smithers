# @smthrs/platform-browser

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://platform-browser.smithers.sh

Two Effect platform services a browser tab otherwise cannot have: `FileSystem`,
over a virtual filesystem the page mounts, and `ChildProcessSpawner`, over a
bash interpreter that runs inside the page. Code written against Effect's
service tags runs in a tab without changing a line.

Effect's own browser platform package covers HTTP, sockets, workers, key-value
storage, and crypto. It ships neither of these, because a tab has no `node:fs`
and cannot fork. A tab can serve both, given a virtual filesystem such as ZenFS
over IndexedDB and an in-page interpreter such as just-bash. This package is
that adapter pair. Neither backend is a dependency here: each arrives as a
function argument, so the page chooses what is mounted and your bundle carries
no vendor code this package picked for you.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

`effect` is a peer dependency pinned at exactly `4.0.0-rc.115`. The services
these adapters implement live in Effect 4, so Effect 3 does not satisfy it, and
two copies of `effect` in one program are two sets of service tags.

The backends are yours to install and to wire together:

```sh
npm install @zenfs/core @zenfs/dom just-bash
```

## Example

```ts
import { BrowserServices } from "@smthrs/platform-browser"
import { configureSingle, fs } from "@zenfs/core"
import { IndexedDB } from "@zenfs/dom"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Bash } from "just-bash"

await configureSingle({ backend: IndexedDB })

// Two views of one volume: the interpreter's, and the promises API the adapter reads.
const layer = BrowserServices.layer({ bash: new Bash({ fs }), fs: fs.promises })

const program = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner

  yield* fileSystem.makeDirectory("/workspace", { recursive: true })
  yield* fileSystem.writeFileString("/workspace/notes.txt", "one\ntwo\nthree\n")

  return yield* spawner.string(
    ChildProcess.make("wc", ["-l", "notes.txt"], { cwd: "/workspace" })
  )
})

console.log(await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.orDie)))
```

The program names nothing from this package. It asks for `FileSystem` and
`ChildProcessSpawner`, so the same code runs under `@smthrs/platform-node` or
`@smthrs/platform-bun` unchanged.

## Modules

| Module                       | What it provides                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `BrowserFileSystem`          | `make` and `layer` over a ZenFS-shaped promises API, plus the `ZenFsPromisesLike` slice that API has to satisfy. |
| `BrowserChildProcessSpawner` | `make` and `layer` over a just-bash interpreter, plus the `JustBashLike` slice, whose one member is `exec`.      |
| `BrowserServices`            | `layer({ bash, fs })`: the spawner, the filesystem, and `Path`, mirroring `NodeServices.layer`.                  |
| `BrowserHost`                | `layer({ bash, fs, jj })`: the closed Host bundle, adding the wasm-backed `Jj` and Effect's fetch `HttpClient`.  |

Three properties are worth knowing before you compose them.

`bash`, `fs`, and `jj.fs` must be views of one mount. Nothing raises when they
are not, because each object is valid on its own; the command simply reads a
file the write never reached. The layer signatures make the pairing an explicit
decision at the one place a caller can still get it right.

`BrowserFileSystem.layer` is an assertion about `fs`. It carries
`@smthrs/kernel`'s whole-filesystem isolation attestation, which says the
promises object cannot name a path outside its own volume, and which lets the
guarded surface resolve paths directly. A mounted ZenFS volume satisfies that
when the workspace occupies the whole mount, so the layer refuses any
`workspaceRoot` other than `/`; a host-backed `node:fs/promises` does not.
`BrowserFileSystem.make` builds the same service with no such claim.

`BrowserHost`'s HTTP slot is Effect's fetch client configured with
`RequestInit { redirect: "manual" }`, so a redirect comes back to you and the
second origin is never contacted on its own. There is no Smithers wrapper around
`fetch`. `Crypto` is not one of the five Host tags, so a page that hashes
artifacts adds `BrowserCrypto.layer` from `@effect/platform-browser`.

## What a tab cannot do

Both adapters state their limits rather than faking them, so a program meets
each one as a typed failure at the call, not as a wrong answer later:

- **Output is buffered.** The interpreter runs to completion, so `stdout` and
  `stderr` each emit one chunk after it finishes and `all` is one then the
  other. A stdin `Stream` is rejected at spawn.
- **There is no process table.** `pid` is a per-layer counter, `killSignal` is
  ignored, `forceKillAfter` and piped commands are rejected, and interruption,
  timeouts, and `kill` abort the interpreter through its `AbortSignal` and are
  reported on the handle as a `PlatformError`.
- **One command runs at a time**, behind a permit held until the interpreter's
  promise settles, so two runs never mutate the mount at once.
- **A promises-shaped volume has no symlink creation, writable handles, or
  watcher**, so `chmod`, `chown`, `copy`, `copyFile`, `glob`, `link`, `symlink`,
  `readLink`, `open`, `sink`, `truncate`, `watch`, and the `makeTemp*` family
  fail with a `PermissionDenied` `PlatformError` naming the method.
  `rename` and `utimes` are served when the backend supplies them; otherwise
  they fail with the same refusal. `NotFound` is reserved for a path the backend
  reports absent. Copy by reading and writing, and append with
  `writeFile({ flag: "a" })`.
- **A tab has no working directory**, so `cwd` and a relative path given to
  `realPath` resolve against the volume root. Pass absolute virtual paths.
- **Durability belongs to the page.** ZenFS acknowledges a write before it
  reaches IndexedDB or OPFS, so call the mount's `sync()` after writes that must
  survive a reload.

What is served honours its options rather than dropping them: `makeDirectory`
forwards `mode`, `writeFile` forwards `flag` and `mode`, `access` answers from
the reported mode bits, `stream` honours its bounds and refuses fractional ones,
and `realPath` canonicalizes through the backend's own `realpath` when it has
one. Without `realpath`, `realPath` fails with a `PermissionDenied` `PlatformError`;
there is no fallback. The full statement is at https://platform-browser.smithers.sh/contract/,
each option and backend error tag is tabled at
https://platform-browser.smithers.sh/reference/api/, and every refusal with its
fix is at https://platform-browser.smithers.sh/troubleshooting/.

## Runtimes

Every entry point bundles for a browser, `BrowserHost` included: no published
module resolves a `node:` built-in, so no bundler asks for a polyfill it cannot
supply. The package ships as ESM and CommonJS with TypeScript declarations, and
its `engines` field asks for Node.js 26.4.0 or later, which is the toolchain
that installs and builds it rather than a runtime the code needs.

A tab runs the memory engine and the capability kernel over these adapters. The
durable engine does not run there: its `SqlClient` uses `node:sqlite`, and
`NodeRuntime` is Node-only.

Because both backend slices are structural, a test satisfies them without either
vendor package: Node's own `node:fs/promises` satisfies `ZenFsPromisesLike`, and
`JustBashLike` is one function. See
https://platform-browser.smithers.sh/testing/.

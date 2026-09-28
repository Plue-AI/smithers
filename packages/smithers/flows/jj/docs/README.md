---
title: "@smthrs/jj"
description: "Jujutsu version control as an Effect service: snapshot a working copy, restore it, diff two revisions, and open a workspace lane, through the jj CLI on Node and Bun or through jj-lib compiled to WebAssembly in a browser tab."
---

`@smthrs/jj` gives you nine version-control operations as an
[Effect](https://effect.website) service: snapshot the working copy, restore
it, diff two revisions, add and forget a workspace, read status, find the
repository root, revert one change, and restore a whole operation. One program written against that
service runs against the [Jujutsu](https://jj-vcs.github.io) command line on
Node and Bun, or against jj-lib compiled to WebAssembly in a browser tab.

## The problem it solves

Any program that runs code on someone else's checkout eventually needs to put
that checkout back: an agent that edits files and has to undo a bad attempt, a
build step you want to be able to rewind, a tool that forks one repository into
several parallel working copies. The usual answer is `spawn("jj", [...])` at
the call site, and it costs you four things at once. You cannot tell which
repository was touched, because the child inherits whatever `process.cwd()`
happens to be. You cannot substitute a fake in a test without a real binary and
a real repository. You cannot tell "jj refused" from "jj is not installed",
because both arrive as a nonzero exit code and some text. And the same code
cannot run anywhere a `jj` binary does not exist.

Behind a service, each of those becomes a decision the composition makes once:

- **The repository is explicit.** `NodeJj.layerAt(root)` pins one absolute
  repository root, so a `chdir` in unrelated code cannot redirect a restore
  into another checkout.
- **Failures are a closed set of six codes.** `not_installed`, `conflict`,
  `invalid_ref`, `snapshot_refused`, `unsupported_version`, and `unknown`, each
  carrying the command that produced it and a plain-data cause you can store and
  replay. Nothing escapes as an untyped throw, and the last two can fail a CLI
  layer as it is built rather than an operation.
- **Tests swap the layer, not the code.** `layerNoop({ ... })` stubs every
  operation, and the ones you did not stub fail by name instead of silently
  succeeding.
- **The same program runs in a tab.** `BrowserJj.layer({ fs, wasm })` runs the
  real jj-lib over a synchronous filesystem you mount, with real change ids and
  a real operation log. Seven of the nine operations work there; `revert` and
  `opRestore` are not in the compiled module and say so when you call them.

The contract stays small on purpose. There is no `commit`, no `push`, and no
`log`, because every backend owes an answer for every operation, including one
compiled to WebAssembly.

## Availability

`@smthrs/jj` is not on npm at 1.0.0-rc.0. Its source lives in the
[smithers repository](https://github.com/smithersai/smithers), and
[Installation](./installation.md) covers how to depend on it from a checkout,
the `effect` version it pins, and the wasm asset a browser layer needs.

`NodeJj` and `BunJj` spawn the `jj` executable, which this package does not
vendor. Install it once with `brew install jj` or
`cargo install --locked jj-cli`. With no usable jj, every operation fails with
the `not_installed` code and a message naming the fix, rather than throwing.

## Snapshot a working copy and put it back

```ts
import { Jj } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as Effect from "effect/Effect"
import { writeFileSync } from "node:fs"

const repository = "/srv/checkouts/main"

const reversible = Effect.gen(function*() {
  const jj = yield* Jj

  // Capture the current working-copy tree without closing its change.
  // Keep the commit id: the change id can move when the change is rewritten.
  const { commitId } = yield* jj.snapshot("before the risky step")

  // Do the work a step would do.
  yield* Effect.sync(() => writeFileSync(`${repository}/note.txt`, "attempt\n"))

  // Read what changed, then put the working copy back the way it was.
  const patch = yield* jj.diff(commitId, "@")
  yield* jj.restore(commitId)

  return patch
}).pipe(Effect.provide(NodeJj.layerAt(repository)))
```

`commitId` names the recorded tree across process restarts. Store it for later
diffs and restores; `changeId` is a moving display pointer. Native Node and Bun
snapshots do not describe or open changes. The browser backend still differs
until browser snapshot parity is implemented (#1976).

## How this fits with @smthrs/flows

This package is one piece of the Smithers durable flow engine, whose whole
surface is re-exported by [`@smthrs/flows`](/api/flows). If you already depend
on that barrel, this service is its `Jj` namespace and you do not need to
install anything else:

```ts
import { Jj } from "@smthrs/flows"

const tag = Jj.Jj
const stub = Jj.layerNoop({})
```

The barrel re-exports this package's root entry point only, which is the
contract and the no-op layer. A layer that actually runs jj is chosen by the
program, not by the library, so import `@smthrs/jj/node/NodeJj`,
`@smthrs/jj/bun/BunJj`, or `@smthrs/jj/browser/BrowserJj` directly, the same
way you pick a platform bundle.

Depend on `@smthrs/jj` on its own when version control is all you want from the
engine. It adds one package, [`@smthrs/capability`](/api/capability), on top of
the `effect` peer the whole engine shares, and neither pulls in a process
spawner or an HTTP client.

Within that engine, `@smthrs/jj` is where the snapshots come from.
[`@smthrs/time-travel`](/api/time-travel) forks a run by adding a workspace and
rewinds it by restoring a recorded change id, and
[`@smthrs/kernel`](/api/kernel) decorates this same service tag so every
operation asks for a capability grant such as `jj:snapshot` before it runs.
`@smthrs/flows` is in turn the library behind the `smithers` command line tool,
[`@smthrs/cli`](/api/cli), which is what snapshots a working copy around each
step of a run you start from a terminal.

## Where to go next

- [Installation](./installation.md): runtime requirements, installing jj
  itself, the import forms, and the wasm asset a browser layer needs.
- [Quickstart](./quickstart.md): snapshot a real repository, diff two
  snapshots, and restore the working copy, in one file.
- [Version control as a capability](./concepts/version-control-as-a-capability.md):
  why the contract holds these nine operations and no others, and the grants
  the kernel checks.
- [How a jj failure is reported](./concepts/failures.md): the six codes, how
  each backend classifies onto them, and why a cause is plain data.
- [Snapshot a working copy and put it back](./guides/snapshot-and-restore.md):
  what `restore` does to uncommitted edits, and when to reach for `revert`
  instead.
- [Give each parallel agent its own workspace lane](./guides/workspace-lanes.md):
  `workspaceAdd`, pinned revisions, and what a forget leaves behind.
- [Bind jj to a repository and contain its child process](./guides/bind-and-contain.md):
  which of the four Node and Bun layers to provide.
- [Choose which jj binary runs](./guides/choose-the-jj-binary.md):
  `SMITHERS_JJ_PATH`, the resolution order, and reading the answer back.
- [Run jj in a browser tab](./guides/run-jj-in-a-browser.md): composing
  `BrowserJj`, keeping the mount durable, and where the WebAssembly backend
  answers differently.
- [Test code that depends on Jj](./guides/testing.md): stubs, partial
  implementations, and when a test needs a real binary.
- [API reference](./api.md): every export of the root entry point and of each
  implementation subpath.
- [Troubleshooting](./troubleshooting.md): every failure this package reports,
  grouped by code.

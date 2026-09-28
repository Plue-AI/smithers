---
title: "Actions and boundaries"
description: "How a target body records action calls, what the sealed, compensable, and irreversible tiers mean, and how a declared confinement is enforced."
---

A target body records plan nodes. The nodes that touch the world are **action
calls**. An action is a declaration: a payload schema, a success schema, an error
schema, a tier, and an effects annotation. Its implementation attaches separately
as a layer.

## Tiers

| Tier           | Meaning                                                                    |
| -------------- | -------------------------------------------------------------------------- |
| `sealed`       | Content-keyable; shared reuse also requires cache admission.               |
| `compensable`  | Requires compensation on retry.                                            |
| `irreversible` | Run-local recorded execution; never retried blindly or shared across runs. |

`Plan.compile` accepts all tiers through `StepKey.planIdentity`. Only sealed
material can become a cross-run content key; other tiers use run-local
execution identities. A completed attempt can replay without executing again.

Install link is `irreversible`: ignored `node_modules` files are outside normal
workspace snapshots, so a compensable declaration would promise a rollback the
runtime cannot perform. It has no automatic retry contract. Release targets
use the separately provided `ExecIrreversible` for publication effects.

## Boundary modes

An action's effects annotation declares what it reads, what it writes, and its
boundary mode.

| Mode       | Meaning                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------- |
| `hard`     | The declared read and write set is the complete set.                                        |
| `expected` | The declared set is what the action expects; an observed deviation is recorded, not failed. |

`ActionPersistence` admits a result to the cross-run cache only when the tier is
`sealed` **and** the boundary mode is `hard`, with the required evidence. Either
a non-sealed tier or an `expected` boundary prevents shared-cache admission.

## The install boundaries

| Action                              | Tier           | Boundary   | Reads                                                                                                                                                                                  | Writes                                                                                                     | Cache-admissible |
| ----------------------------------- | -------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| `smithers-build/install/measure`    | `sealed`       | `expected` | `.npmrc`; `bun.lock`; `pnpm-lock.yaml`; `.pnpmfile.mjs`; `.pnpmfile.cjs`; `pnpm-workspace.yaml`                                                                                        | none                                                                                                       | No               |
| `smithers-build/install/fetch/pnpm` | `sealed`       | `expected` | `pnpm-lock.yaml`; `.npmrc`; `.pnpmfile.mjs`; `.pnpmfile.cjs`; `pnpm-workspace.yaml`                                                                                                    | `TreeArtifact` at `.flows/store/pnpm`; `Glob`: `**/node_modules/.pnpm/**`, `**/node_modules/.modules.yaml` | No               |
| `smithers-build/install/link`       | `irreversible` | `expected` | `.npmrc`; `bun.lock`; `pnpm-lock.yaml`; `.pnpmfile.mjs`; `.pnpmfile.cjs`; `pnpm-workspace.yaml`; `package.json`; `Glob`: `**/package.json` (exclude `**/node_modules/**`, `.flows/**`) | `Glob`: `**/node_modules`, `**/node_modules/**`                                                            | No               |

Measure reports content: the lockfile digest, the credential-free project
`.npmrc` digest, and the pnpm hook and workspace manifest digests when present.
Manager version and host platform belong to the `PackageManager` and `Runtime`
services. Measure uses an `expected` boundary and remeasures each run, so a
cross-run cache cannot substitute another checkout's measurement.

Fetch is shaped as the potentially shareable half, but it is not shared today.
The absolute-root package-manager process can open the lockfile and configuration
after the parent verifies them, and the current observer cannot freeze those
paths or prove there were no undeclared effects. Its `expected` boundary prevents
shared-cache admission. Only pnpm installs; a Bun manager is refused when it is configured.

Link declares writes to root and nested `node_modules` trees for conflict
ordering. Its `irreversible` tier prevents shared-cache admission regardless of
boundary mode; a non-sealed write declaration does not publish file artifacts.
The tree contains links into a host-local store, and ignored dependency trees
are outside normal workspace snapshots, so Link cannot promise rollback.
A completed attempt can replay within its run; a new run reconciles the tree
again. An uncertain interrupted attempt requires operator reconciliation.

## The shared exec action

Catalog targets do not declare their own actions. They call one shared action,
`smithers-build/exec`, declared `sealed`.

```ts
Payload = {
  cwd: string                        // resolved against the workspace root
  argv: NonEmptyArray<string>        // argv[0] is the executable
  env: Record<string, string>        // merged over process.env, default {}
  expectedExitCodes: Array<number>   // default [0]
  after?: unknown                    // an upstream planned result, for ordering
}

Result = { exitCode: number, stdout: string, stderr: string, durationMs: number }
```

`ExecLive` implements it with `node:child_process.spawn`. Never through a shell.
Killing the fiber kills the child. `stdout` and `stderr` are truncated to 200 KiB;
an `ExecError`'s `stderr` carries the last 8 KiB, or the spawn error message when
nothing ran and `exitCode` is `-1`.

Each stream is decoded by its own streaming UTF-8 decoder, so a code point whose
bytes land in two pipe chunks decodes once and correctly. Decoding each chunk on
its own made captured output depend on where the kernel happened to break the
pipe, which made one command's result differ between runs and from its own cache
entry. Both bounds are counted in UTF-16 code units, and neither the head nor the
tail is ever cut between the halves of an astral code point.

The run settles exactly once. A failed spawn emits `error` and then `close`, a
pipe can fail alongside either, and only the first of them answers; the rest are
dropped with the listeners. A tool the kernel killed is always a failure, and the
signal is named in the diagnostic rather than flattened into `exitCode` `-1`. A
pipe that fails mid-run fails the target instead of reporting the truncated text
it managed to capture.

The child is spawned detached, so interrupting the fiber signals its whole
process group and takes its children with it. Windows has no process groups: the
fallback there terminates the child alone, and a grandchild it started outlives
the kill. No Node API changes that.

`after` carries no data to the spawn. It exists so an upstream step is a material
dependency the engine settles first. Without it, two keyless exec steps dispatch
at once and the engine refuses with `ConcurrentKeylessDispatch`.

## The other actions

| Action group                                    | Tier           | Provided by the CLI executor |
| ----------------------------------------------- | -------------- | ---------------------------- |
| `exec`, `capture-outputs`, `filegroup`          | `sealed`       | Yes                          |
| `write-file`, `check-file`, `sync-package-json` | `sealed`       | Yes                          |
| `check-workflow`, `check-docs`, `llm-review`    | `sealed`       | Yes                          |
| `scaffold-package`, `not-implemented`           | `sealed`       | Yes                          |
| `smithers-build/install/measure`, `fetch/*`     | `sealed`       | Yes, under pnpm              |
| `smithers-build/install/link`                   | `irreversible` | Yes, under pnpm              |
| `smithers-build/exec-irreversible`              | `irreversible` | Yes                          |

The ordinary implementations are re-exported from the `@smthrs/targets` package
root. The CLI also supplies `ExecIrreversibleLive` from the Changesets module.
`NpmPublish` and `JsrPublish` use it with a `run` verb gate and a resolved
`dryRun` attribute that defaults to `true`. Setting `dryRun: false` allows real
publication; the irreversible tier does not itself prevent execution.

An action call with no implementation in scope is a wiring error, not a runtime
contingency. The interpreter refuses with `unresolved_action` before it runs
anything. See [Running targets](../workspace/running-targets.md#what-executes).

## Host state never reaches a payload

The resolved cache directory is host state: it names where one machine keeps
replayable files, so two checkouts that configured it differently must still
agree on every key.

`DepsLint` needs to write a generated knip config into that directory. It emits
the constant token `{smthrs:cache-directory}` in its argv at plan time.
`ExecLive` validates the host directory and substitutes it into every argument
immediately before spawn. The real path therefore never enters an action payload
or a step key.

## Hermeticity

Every tool run goes through one sandbox module, `ExecSandbox`, and every
declared confinement is enforced or the target fails closed. Nothing logs
"unenforced" and carries on.

A target declares a policy in its `sandbox` attr: `{}` for the default
confinement, `{ network: "loopback" }`, `{ network: true }`, or the `"none"`
opt-out. The workspace declaration's `sandboxes` option names the mechanisms
those policies resolve to. Without a declared mechanism, the host selects its
native mechanism. `S.Sandbox.None()` also disables confinement.

Under confinement a tool may read its declared read set and nothing else under
the workspace: the target's expanded declared inputs, the outputs of every
transitive dependency, the `node_modules` trees above its working directory,
and the cache directory's scratch and fetch store. It may write its declared
outputs, its declared `changes`, and the cache directory with the result cache
itself re-closed, plus a private temporary directory and home. A declared
output file opens the directory it lives in, because a file cannot be bound
before it exists and a tool that writes by rename needs the directory. The
network is closed unless the policy opens it.

| Host    | Mechanism                                                                                                                                                                                                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux   | bubblewrap. An empty root exposes enumerated runtime paths and declared grants. A tmpfs covers the workspace, the declared set is bound on top, the root and workspace are remounted read-only, and the network namespace is unshared. A `loopback` request is refused because bubblewrap cannot expose host loopback without granting the full host network. |
| macOS   | seatbelt. Host reads are denied except enumerated runtime paths, declared reads and writes, private tmp, and explicit external-read grants. Writes and network access are denied except what the policy opens.                                                                                                                                                |
| Docker  | `docker run` with a read-only root, the declared set mounted at its host paths, and `--network none`. Declared with `S.Sandboxes({ default: S.Sandbox.Docker({ image }) })`; the image supplies the toolchain. The only mechanism on Windows.                                                                                                                 |
| Windows | Nothing native. A confined target without a Docker declaration fails closed.                                                                                                                                                                                                                                                                                  |

Native confinement restricts host reads as well as workspace access. It is not
blanket host-file isolation: enumerated runtime paths remain exposed, and
explicit external-read grants can expose paths outside the workspace, including
the destinations of declared symlinks. Known home credentials are denied even
under broad runtime grants unless explicitly granted. Docker exposes declared
host mounts and supplies its toolchain from the image.

The mechanism is selected per host: bubblewrap on Linux, seatbelt on macOS,
Docker where declared. A Linux host without `bwrap`, a Windows host without
a Docker declaration, or a declared mechanism missing from `PATH` fails the
target with `sandbox_unenforceable` and a message naming what is missing.
`--plan` reports the answer as `sandboxEnforced`.

A target declaring `services` must also declare `{ network: "loopback" }` or
`{ network: true }`; service dependencies never widen a policy implicitly.
Since Linux refuses loopback-only access, a cross-platform service consumer
must explicitly opt into the full network.

An undeclared workspace read is missing or refused, and an undeclared write
fails at the kernel. Native host reads outside the admitted runtime and explicit
grants are also refused; redirecting `HOME` alone would not enforce that boundary.

For denied operations, the witness is the tool's own error text; the failure carries the paths that text names and
which side of the boundary each fell on:

```text
/bin/sh: note.txt: Operation not permitted
sandbox: note.txt is outside the declared write set
sandbox: seatbelt, network none, 3 read path(s), 2 write path(s)
```

The workspace tree is what the content key covers. Host toolchain identity
belongs to the `nix:<hash>` layer of a declared
[Nix environment](environments.md); runtime read grants do not make those paths
workspace inputs.

A `PACKAGE.ts` file is not sandboxed, and it is not meant to be. It is
executable TypeScript evaluated in the CLI process: it can import any host
module, read any file you can read, and spawn any process. Evaluating a
workspace is exactly as trusted as running that repository's own code. The CLI
does not empty `process.env` around the evaluation, because a module that wants
the environment can read it another way and emptying a process-global would
corrupt any concurrent caller. What the CLI does guarantee is narrower and
real: token values never enter a declaration, a target key, or a stored cache
entry, and the child-process environment is where the credential is withheld.

A result produced outside an enforced confinement stays in the local cache
tier. Only a confined run publishes to the shared tier; see
[Remote caching](../workspace/remote-caching.md#the-current-engine-boundary).

## Next

- [Install](install.md)
- [Writing target definitions](../extending/writing-targets.md)
- [Remote caching](../workspace/remote-caching.md)

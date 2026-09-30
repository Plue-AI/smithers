# @smthrs/targets

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

**Documentation:** https://smithers.sh/docs/reference/api/targets/

`@smthrs/targets` defines the pure authoring surface used by `PACKAGE.ts` files.
Target calls perform no filesystem reads and start no processes. They return
opaque `Target` declarations with planner metadata. Execute them through the
package executor in `@smthrs/build-cli`. A host-owned Flow can explicitly lower
an action-backed declaration with `Target.plan(target)`.

The package exports one named namespace, `Smithers`, the way `effect` exports
`Effect`. A `PACKAGE.ts` file imports it once and reaches the whole catalog
through it, so the import line never changes as a workspace grows. Library code
that consumes this package imports the module it needs directly instead, as
`@smthrs/targets/Target`.

Catalog rules reach execution by one of two routes, and the difference matters
when you trace a failure:

| Route            | What runs                                                             |
| ---------------- | --------------------------------------------------------------------- |
| Flow body        | The declaration's own plan, through the shared `Exec` action.         |
| Package executor | `@smthrs/build-cli`'s `PackageExec` dispatches natively by rule name. |

Which route a given rule takes is a property of its declaration, not of its
namespace: `Shell.Run` plans an exec and `Shell.Serve` does not, and both live
in `Shell`. [`docs/rules.md`](./docs/rules.md) lists the route of every rule in
the catalog. Read it there rather than from a list written by hand here, which
is how this paragraph used to be wrong about ten rules at once.

A package-only rule lowers to `Target.notImplemented`, so executing that plan
under a bare Flow runtime fails with `smithers-build/NotImplemented`. Execute
these targets through the package executor.

A workspace declares its toolchain once and passes it to everything that runs a
tool. `Smithers.Runtime.Node` and `.Bun` declare a runtime;
`Smithers.PackageManager.Pnpm` and `.BunPackages` declare a package manager
over one. `Runtime` and `PackageManager` are each both the
namespace their constructors live under and the type those constructors return.
Both belong to the workspace, so they are declared once in `WORKSPACE.ts` and
never in a `PACKAGE.ts`. A tool-running target names them in `workspaceAttrs`
and leaves the attrs optional; the planner fills them from the workspace
declaration before it keys and runs the node, and the rule asks
`Smithers.PackageManager.exec` for its argv. Nothing in the catalog spells
`pnpm` or `node` into an argv of its own, and switching either is one edit to
`WORKSPACE.ts`.

```ts
import { Smithers as S } from "@smthrs/targets"

// WORKSPACE.ts
const runtime = S.Runtime.Node({ version: ">=26.4.0" })
export const Workspace = S.Workspace("example", {
  repository: "git+https://example.invalid/repo.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager: S.PackageManager.Pnpm({ version: "11.21.0", runtime }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
})
```

```ts
import { Smithers } from "@smthrs/targets"
import { packageTargets } from "./package-targets.ts"

// PACKAGE.ts: no manager, no runtime.
export const Package = Smithers.Package({
  targets: packageTargets({ cwd: "packages/example" })
})
```

A declaration overrides the interpreter one target runs under by naming a
`runtime`, never by restating a package manager: `Smithers.Vitest({ runtime:
Smithers.Runtime.Bun({ version: ">=1.4.0" }), ... })` runs that suite through
`bun x` while every other target keeps the workspace manager.

`Smithers.Secret("NAME")` declares an inert source without reading it. A child
target binds that source to exact origins with
`Smithers.HttpSecret(source, ["https://api.example.com"])`; the source alone is
not egress authority. The child receives an unguessable placeholder. The
loopback proxy resolves it once, only after an authorized destination is known,
and removes an exact value echoed in the bounded response. A mismatched origin
is denied before any upstream connection. The proxy cannot read an HTTPS
`CONNECT` tunnel, so it refuses one to a declared audience and passes others
through. A tool reaches an HTTPS audience through
`Smithers.SecretOrigin("https://api.example.com")` in its argv or env: at spawn
the token becomes a loopback origin that forwards to the audience over TLS and
substitutes the placeholder. The plan refuses a target whose HTTPS audience no
token names. Key material records the source, audience, and token, never the
value or the loopback port.

`Smithers.Workspace(name, options)` is the workspace declaration a `WORKSPACE.ts`
file exports. It validates and performs no I/O. The name comes first and must be
a portable identifier; `options` carries `repository` and `cache` plus the
optional `runtime`, `packageManager`, `nodeModules`, `toolchains`, `flags`,
`host`, `memory`, `sandboxes`, `agents`, `gitHooks`, and `repos`. The cache
directory lives on the cache declaration: `Smithers.Cache({ directory: ".flows" })`
defaults to `.flows` and must name a single workspace-relative directory. The
CLI resolves that against `--cache-dir` and passes the result explicitly to
`Input` glob expansion. `DepsLint` uses a constant plan-time token that the exec
layer replaces with the resolved directory immediately before spawn. The
resolved directory is host state and never reaches target attrs, a cache key, or
a content digest.

`Smithers.RemoteCache.make({ endpoint, token })` is the matching inert declaration for
the HTTP result cache. The endpoint must use HTTPS. `token` is a `Secret`
declaration and defaults to `Smithers.Secret("SMITHERS_CACHE_TOKEN")`; the bearer token
value is never a declaration field or key input.

The catalog includes declaration-only APIs in this RC. `Npm.Publish`,
`Changesets.Publish`, `Github.Release`, `Github.Pages`, `Git.Pr`, `Github.Pr`,
and `Npm.Downstream` are deferred past 1.0 ([#3163](https://github.com/smithersai/smithers/issues/3163), [#3164](https://github.com/smithersai/smithers/issues/3164), [#3165](https://github.com/smithersai/smithers/issues/3165),
[#3166](https://github.com/smithersai/smithers/issues/3166)): the package executor's plan always refuses them.
See [the catalog](./docs/rules.md) before selecting a publication target.

## Presentation

A declaration may say how its target reads to a person, beside the attrs:
`summary` is one line shown under the label in a listing or the app, and
`featured: true` marks the target as one of the repository's essentials. Both
ride the declaration itself, so the prose lives with the target it describes;
the label is never declared, it is the package path and export name. Neither
reaches the schema, the plan, or the cache key: annotating a target changes
nothing about what it runs. `smithers-build query --format json` carries them
as `summary` and `featured` on each row.

```ts
const test = S.Vitest({
  summary: "The aggregate barrel's vitest suite, coverage gates enforced.",
  featured: true
})
```

## Rust and Cargo

A Cargo workspace has no Node runtime, no package manager, and no installed
modules tree. `Smithers.Workspace` therefore takes a `toolchains` layer list,
and the JavaScript trio is required only for a workspace that declares no
layer. `Smithers.Rust.Toolchain` is that layer, in the two forms design
partners actually pin with:

```ts
// A repository whose CI pins the channel by hand.
const rust = S.Rust.Toolchain({ workspace: S.file("//Cargo.toml"), channel: "1.91" })

// A repository with a checked-in pin file, and a committed lockfile.
const pinned = S.Rust.Toolchain({
  toolchain: S.file("//rust-toolchain.toml"),
  lockfile: S.file("//Cargo.lock")
})

export const Workspace = S.Workspace("aomi-sdk", {
  repository: "git+https://github.com/aomi-labs/aomi-sdk.git",
  cache: S.Cache({ directory: ".flows" }),
  toolchains: [rust],
  host: S.Host({ bins: ["cargo"] })
})
```

`toolchain` is a declared file input. Its content digest, not only its path, is
key material, so changing the channel in `rust-toolchain.toml` re-keys the Cargo
targets that use it.

The declared channel is selected, not hoped for: every cargo run carries it as
`RUSTUP_TOOLCHAIN`, so a host without the pin fails at the start of the run
naming the channel instead of mid-compile on a rustc the crates refuse.

`Smithers.Cargo` holds the build-system rules. Each names its crates with
exactly one selector — `workspace: true`, `package: "<name>"`, or
`crates: <set>`:

```ts
const fetch = S.Cargo.Fetch({
  workspace: S.file("//Cargo.toml"),
  outFiles: ["//Cargo.lock"],
  outDirs: ["//.cargo-home"],
  sandbox: { network: true }
})

const clippy = S.Cargo.Clippy({
  workspace: true,
  lib: true,
  denyWarnings: true,
  locked: true,
  offline: true,
  data: [srcs, fetch]
})
```

`Cargo.Fetch` is the one network-enabled cargo target: the lockfile and the
vendored registry are its declared deliverables, its first `outDirs` entry
becomes the `CARGO_HOME` every dependent reads, and a dependent keys on that
cargo home plus the lockfile content it delivered rather than on the fetch
declaration. That is the
`node_modules` rule applied to Cargo: a dynamic install and static dependents
that run `--locked --offline` against what it produced. A fetch may name a
crate set instead of one manifest (`S.Cargo.Fetch({ crates })`), which is what
a repository whose crates are excluded from the root workspace needs: each of
those crates is its own lockfile domain, and one workspace manifest cannot
deliver what they resolve against. It may also name neither, which is the bare
`cargo fetch` over the workspace it runs from; naming both is a declaration
error, because they say two different things about what is locked.

`offline: true` reaches the child processes a cargo run spawns, not only the
run itself: the `--offline` flag speaks for one cargo, and a test that shells
out to a nested cargo — trybuild's compile-fail suites are the common case —
would otherwise reach for the registry and fail against the sandbox. The
planner sets `CARGO_NET_OFFLINE` alongside the flag so the declaration's
statement holds all the way down.

A crate that builds C — anything with a `-sys` dependency — spawns the host
`cc` from inside the sandbox. The exec boundary inherits `SDKROOT` and
`DEVELOPER_DIR` alongside `PATH` for exactly that reason: on macOS a toolchain
clang reached through `PATH` takes its sysroot from `SDKROOT` and looks nowhere
else, so withholding it would fail the build on a missing `stdlib.h` rather
than on anything the declaration said.

`Cargo.Fmt` checks by default and applies under `--write`/`--fix`, confined to
its declared `changes` write set. It is the one cargo rule with no
`locked`/`offline` attrs, because rustfmt never resolves a dependency.

`Cargo.AppSet` is a crate set computed from manifest globs and filtered by
`[package.metadata]`. It is a value, not a run, and `Smithers.Files.difference`
subtracts one set from another exactly as it does for file sets:

```ts
const allApps = S.Cargo.AppSet({ manifests: S.glob(["*/Cargo.toml"]) })
const skipped = S.Cargo.AppSet({ manifests: S.glob(["*/Cargo.toml"]), metadata: { aomi: { skip: true } } })
const compile = S.Cargo.Build({ crates: S.Files.difference(allApps, skipped), lib: true, locked: true })
```

The planner expands the set at plan time, keys the consuming target on the
manifests it found and their contents, and renders one cargo command per
selected crate.

`Cargo.Clippy` and `Cargo.Test` construct targets with exactly one crate
selector: `workspace: true`, `package: "<name>"`, or `crates: <set>`.

```ts
const lintWorkspace = S.Cargo.Clippy({ workspace: true })
const testPackage = S.Cargo.Test({ package: "aomi-sdk" })
const lintApps = S.Cargo.Clippy({ crates: allApps })
```

`Cargo.Fmt` constructs a formatting target with an attrs object. It accepts
at most one of `workspace: true` or `crates: <set>`; omitting both uses the
current workspace.

`S.Rust.Pinned`, the pin a generated CI job installs, follows the same content
rule: `pin` defaults to `S.file("//rust-toolchain.toml")`, and Cargo targets
digest it without callers also listing it in `srcs`.

A build target may be a tool edge. `S.Shell.Build({ bin: sdk.buildCli })` and
`S.Generate({ bin: sdk.buildCli })` spawn the one binary that build declares
(`bins: ["aomi-build"]` under the default profile is `target/debug/aomi-build`),
and the build becomes an ordinary dependency, so the generator is built before
its consumer runs and the generator's identity keys everything it produced. It
takes no `runtimeArgs`: those are flags for the JavaScript runtime a built
binary is not, and a declaration that passes them is refused rather than run
with a different argv.

## Contributing to the documentation

The pages in `docs/reference/` feed the main site's
[@smthrs/targets API reference](https://smithers.sh/docs/reference/api/targets/)
and target-rule reference. `apps/site/scripts/ingest-reference.mjs` writes
their cached copies under `apps/site/src/content/docs/docs/reference/`, and
CI checks that they match. There is no `@smithers/docs-targets` workspace.
Edit the colocated page, then run these commands from the repository root:

```bash
pnpm --filter @smthrs/targets exec dprint fmt 'docs/**/*.md' README.md
node apps/site/scripts/ingest-reference.mjs
node apps/site/scripts/generate-llms.mjs
pnpm --filter @smithers/site run build
```

`apps/site/prompts/reference-style.md` is the reference-page contract.
Keep the source page's `area` and any `slug` fields, which select its route;
the ingest script uses them to choose the generated path and adds the site's
navigation fields.

`docs/rules.md` is hand maintained. No gate compares it to `src/`, so adding a
rule, changing its `kinds`, or making it cacheable is also an edit to that
table. `docs/reference/targets.md`, `docs/reference/filegroup.md`, and
`docs/reference/agent-diff.md` are written by the `referenceDocs`,
`referenceFilegroupDocs`, and `referenceAgentDiffDocs` targets in
[`PACKAGE.ts`](./PACKAGE.ts); a hand edit to one of them survives only until
that target runs again.

See [`packages/smithers/build/API-REVIEW.md`](../API-REVIEW.md) for the review
order and current API questions.

Generated CI concurrency groups use the pull request number, or the ref for
other events. A pushed branch keeps one run in flight and its newest commit
pending; each push replaces the pending run. Superseded PR runs cancel by
default. Set `cancelInProgress: false` to disable cancellation.

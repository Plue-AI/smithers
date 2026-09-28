# @smthrs/build

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

**Documentation:** https://smithers.sh/docs/reference/api/build/

`@smthrs/build` expresses dependency installation as a keyed flow, and holds a
host to the interpreter and package manager the workspace declared. It is one
of the three packages that make up smithers build, a Bazel-style build
orchestrator for TypeScript workspaces: `PACKAGE.ts` modules declare targets,
a `WORKSPACE.ts` module declares the toolchain once, and imports between
declaration files form dependency edges.

The complete user documentation lives in [`docs/`](docs/README.md). It covers
workspace authoring, every CLI verb, the target catalog, caching, and the
install flow.

## Current execution model

The CLI discovers and digests declared inputs before execution, computes a
content key, runs dependency-first with bounded parallelism, and keeps going
outside a failed target's dependent cone. Successful cacheable results are
stored as bounded JSON under `<cacheDirectory>/cache`; a configured HTTPS
remote adds a read-through `/ac` tier.

Target tools run through `ExecSandbox`: bubblewrap on Linux, seatbelt on macOS,
or Docker where declared. Confinement scopes workspace reads and writes to
admitted paths and closes networking unless the policy opens it; a host that
cannot enforce the policy fails the target closed. `sandbox: "none"` or
`S.Sandbox.None()` disables confinement. Native host reads are restricted but
include enumerated runtime paths and explicit external-read grants, including
declared symlink destinations. Known home credentials are denied unless
explicitly granted; this is not blanket host-file isolation. Docker exposes
declared host mounts and uses the image's toolchain. See
[Actions and boundaries](docs/concepts/actions-and-boundaries.md#hermeticity).

Effects declarations also supply analysis and cache metadata. The executor
revalidates declared inputs before cache admission and after execution, and
verifies declared outputs before reporting or caching success. The install
actions below retain `expected` boundaries and are not admitted to the shared
engine cache.

## Dependency installation

Installation is one round of three actions:

1. `measure` records the content an install is keyed on: the lockfile digest,
   the credential-free project `.npmrc` digest, and the pnpm hook and workspace
   manifest digests when present. The manager version and the
   host platform are not content; they come from the `PackageManager` and
   `Runtime` services, which hold the host to what the workspace declared.
2. A manager-specific `fetch` populates `.flows/store/<manager>`. The manager
   is a plan-time declaration from PACKAGE.ts, so the body selects exactly one
   fetch without a second round.
3. `link` reconciles `node_modules` from that store.

All three actions currently use an `expected` filesystem boundary. None is
admitted to a cross-run engine cache: the absolute-root package-manager process
cannot freeze its lockfile and `.npmrc` across the child's own opens, and the
linked tree is host-local. `link` always runs; manager metadata cannot prove
that every installed package file is still present and intact.

Only pnpm has a live implementation. It runs:

```text
pnpm fetch --frozen-lockfile --ignore-scripts --reporter=append-only \
  <hooks> --store-dir <workspace>/.flows/store/pnpm

pnpm install --offline --frozen-lockfile --ignore-scripts \
  --reporter=append-only <hooks> --store-dir <workspace>/.flows/store/pnpm
```

`<hooks>` is `--pnpmfile <workspace>/<hook file> --global-pnpmfile=`, where the
hook file is `.pnpmfile.mjs`, else `.pnpmfile.cjs`, and `--ignore-pnpmfile` when
neither exists.

Bun installs are unsupported. The `Install` target, the planner, `runInstall`,
and the install Flow payload refuse a Bun manager at configuration time with
`code: "unsupported"`, and `smthrs init` no longer writes a Bun workspace.
The Bun layer remains for targets that run tools under Bun.

Run the supported flow with:

```sh
smithers-build install --workspace /path/to/workspace
```

The install store is fixed at `.flows/store/pnpm`, so `install` requires the
default `.flows` cache-directory configuration. Other CLI verbs may use a
custom workspace-relative cache directory.

A workspace-local store is not shared with any other checkout: each clone and
worktree downloads and unpacks the whole dependency set and keeps its own copy,
so size a CI install cache for one full store per checkout. A composition that
drives `PackageManager` directly can pass `storeDirectory`, an absolute host
path outside the project root, and get pnpm's shared store back; the install
Flow refuses such a service because its fetch write declaration names the
workspace-relative tree.

## Cache directory

The workspace declaration says where target results and target scratch files
live:

```ts
// .smithers/WORKSPACE.ts
import { Smithers as S } from "@smthrs/targets"

export const Workspace = S.Workspace("demo", {
  repository: "git+https://example.invalid/demo.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager,
  nodeModules
})
```

Precedence is `--cache-dir`, then the declaration, then `.flows`. The value is
bounded, control-free, workspace-relative text; absolute paths, parent
traversal, oversized segments, and malformed Unicode are refused.

The resolved directory is host state and never enters a target key. Discovery
and globs exclude it, as well as the fixed `.flows/store` install tree.

## Remote result cache

Declare an endpoint without embedding a credential:

```ts
// .smithers/WORKSPACE.ts
const remote = S.RemoteCache.make({ endpoint: "https://build.smithers.sh" })

export const Workspace = S.Workspace("demo", {
  repository: "git+https://example.invalid/demo.git",
  cache: S.Cache({ directory: ".flows", remote }),
  runtime,
  packageManager,
  nodeModules
})
```

`tokenEnv` defaults to `SMITHERS_CACHE_TOKEN`. A deployment that separates
reading from publishing declares the split form instead, and the two values
arrive through `SMITHERS_CACHE_READ_TOKEN` and `SMITHERS_CACHE_WRITE_TOKEN`:

```ts
const remote = S.RemoteCache.make({
  endpoint: "https://build.smithers.sh",
  read: S.Secret("SMITHERS_CACHE_READ_TOKEN"),
  write: S.Secret("SMITHERS_CACHE_WRITE_TOKEN")
})
```

A bearer value must arrive through an environment variable and never enters a
declaration file, a target key, or a stored entry. `SMITHERS_CACHE_URL` can override
the declared HTTPS endpoint for one process. See
[remote caching](docs/workspace/remote-caching.md) for which job gets which
credential, and `infra/CACHE-TRUST.md` for the trust model the split exists to
enforce.

A local hit avoids HTTP. A remote hit hydrates the local cache. Remote failures
warn once and degrade to local-only; a first-writer conflict warns without
failing the run. Bodies, keys, JSON structure, timeouts, and stream chunk counts
are bounded, and corrupt or misfiled entries are misses rather than results.

Both deployments, the hosted Cloudflare Worker under `infra/` and the
self-hosted container under `terraform/`, serve the same routes, the same
bounds, and the same read/write credential split. They are two implementations
of it rather than one shared one, so a change to either belongs in both:

- `/ac/{keyDigest}` for action-cache documents;
- `/cas/{sha256}` for content-addressed artifacts;
- `/cas/findMissing` for batched artifact probes;
- public `/healthz` readiness checks that reveal no cache state.

The smithers-build CLI currently uses `/ac` directly for target success values. It
does not compose the Smithers engine's remote step-cache and artifact layers.
See [remote caching](docs/workspace/remote-caching.md) for that distinction.

## Development

Use Node.js 26.4 or newer. The repository's supported gates are:

From the Smithers repository root, run `pnpm check`, `pnpm lint`, `pnpm test`,
`pnpm circular`, and `pnpm browser`. To work on only these packages, use pnpm's
`--filter` option with `@smthrs/build`, `@smthrs/targets`, or
`@smthrs/build-cli`.

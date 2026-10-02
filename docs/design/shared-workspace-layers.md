# Shared workspace bases: prepare once, fork many

> [!CAUTION]
> **Future planned feature. Do not implement.** Will deferred this design on
> 2026-10-01. Agents must not plan or build any part of it. Tracking issue
> #3382 carries the `do-not-implement` label; only Will lifts it.

Status: future planned feature, do not implement (Will, 2026-10-01). Line references are `main` at bfb9b44374.
Scope: storing each byte once across agent workspaces that share a base
(source, installed dependencies, build outputs), and starting them fast.
Non-goals: a general content-addressed layer library; forking a running VM
from a memory snapshot; virtio-fs DAX; an FSKit filesystem; KSM; lazy fetch on
first read; Windows; cross-tenant deduplication; replacing git or jj.
Tracking: #3382 (do not implement). Cloud fleet changes (small guest disks, CPU overcommit, warm
pool) are specified in the private deployment repository.
Review: Codex Astra, three rounds; rev 3 approved with changes, applied here.

## 1. Problem

Every workspace holds its own copy of the world, even though agents mostly
work from the same base and change a handful of files.

```
host disk
├── ws-a/  source + node_modules + build outputs
├── ws-b/  source + node_modules + build outputs   ← identical bytes again
└── ws-c/  source + node_modules + build outputs   ← and again
```

Receipts (macOS, APFS, 2026-10-01):

| Item | Value | Command or source |
| --- | --- | --- |
| Tracked source | 15,877 files, 285 MB | `jj file list \| wc -l`; sum of `stat -f %z` |
| Root `node_modules` | 847,693 entries | `find node_modules -xdev \| wc -l` |
| Host pnpm store | 2,439 MB | `du -sm ~/Library/pnpm/store/v11` |
| Local jj workspaces | 20 at 21:30Z, 11 at 23:49Z | `jj --ignore-working-copy workspace list \| wc -l` |
| Shims embedding the checkout path | 14 of 14 in `node_modules/.bin` | `grep -l "$PWD" node_modules/.bin/*` |
| Cloud workspace startup | 151–164 s to running | Measured 2026-10-01 |
| Cloud workspace disk | 32 GiB reserved per workspace | Deployment repository |

Entry counts show where files are, not physical bytes; Phase 0 measures
physical allocation.

## 2. Requirements

Every requirement is M or smaller.

| # | Requirement | Size | Target |
| --- | --- | --- | --- |
| R1 | Prepare once: toolchain, installed dependencies, and build outputs built once per base | M | One install per base, not per workspace |
| R2 | Boot or fork workspaces from the prepared base | M | Idle workspace adds ≤ 10 MB physical |
| R3 | Ordinary build-cache hits stop copying files | S | A no-change cache-hit build writes no output bytes |
| R7 | Laptop and Cloud exchange only jj commits and prepared images by digest | S | No new transfer protocol; no laptop disk mounted remotely |
| R8 | macOS host workspaces clone a prepared source and output tree; dependencies are prepared per destination | M | Blocks shared across host workspaces |

R4 to R6 (small guest disks, CPU overcommit, warm pool) live in the
deployment repository.

Cut as L or larger, or out of scope: a general layer library, running-VM
fork, virtio-fs DAX, FSKit, KSM (cannot be limited to one tenant without
tenant-dedicated workers), live migration, live disk growth, a host pnpm
store through the install flow (its write boundary requires the workspace
store, `build/src/Install.ts:407-421`), and moving coding checks or Cloud CI
onto prepared bases (different executors and paths).

## 3. Current state

| Piece | Shares | Duplicates | Evidence |
| --- | --- | --- | --- |
| Build cache (`/ac`, `/cas`) | Cached results across machines | Blob store inside each checkout; ordinary build-cache hits copy each file into the output root | `PackageTree.ts:1595`, `:2154`; `PackageRunner.ts:736-755` |
| `node_modules` target | Nothing | `cache: false`; the install always reconciles | `targets/src/Install.ts:130`; `build/src/Install.ts:121-130` |
| pnpm store | Nothing by default | Workspace-local store (`.flows/store`): each clone downloads and unpacks every dependency | `build/src/PackageManager.ts:204-220` |
| Local microVM layers | Toolchain and pnpm store as APFS-cloned VM disks, recipe-keyed | Each workspace links its own `node_modules` | `microsandbox/layers.go:245-259`, `:1092-1095` |
| Microsandbox images | Identical OCI layers, stored once per host as read-only EROFS | Anything outside identical layers | [Microsandbox v0.6.15 image cache](https://github.com/superradcompany/microsandbox/blob/v0.6.15/crates/image/lib/cache/store.rs#L49-L62) |

Integration facts:

- The local runtime's workspace path is `/workspace`
  (`microsandbox/runtime.go:46-47`); the Cloud path differs.
- Checkout runs `git clone ... .` into an empty directory
  (`services/workspace_repository.go:180-189`); another path deletes the
  checkout before cloning (`workspace_provisioning.go:2050-2070`).
- `treeMatchesManifest` is called only by the `Materialize` rule
  (`PackageRunner.ts:2189-2212`); ordinary hits go through `restoreManifests`.

## 4. Plan

```
 Phase 0  baseline: measure today's failures      (disposable, one command)
    ▼
 Phase 1  prepared bases + integration fixes
 Phase 2  ordinary cache hits stop copying
    ▼
 Gate     rerun Phase 0 on the fixed paths; pass before capacity work
    ▼
 Phase 3  capacity (deployment repository)
 Phase 4  macOS host workspaces
```

### Phase 0: baseline

Riskiest assumption: a real workspace can initialize and run an ordinary
no-change build on a prepared shared tree while its writable layer stays
small. Today's clone and restore paths are expected to fail this; Phase 0
records exactly where.

```
 prepared lower tree (checkout + node_modules + outputs, warm cache)
          │                         │
   overlay view A (upper A)   overlay view B (upper B)    ← at the real runtime path
```

overlayfs appears only in this disposable experiment. Measure upper file count
and allocated bytes after:

1. The actual non-root workspace initialization.
2. One ordinary cache-hit build (not only the `Materialize` rule).
3. A one-file change and rebuild.
4. A deletion, and a package-script change with the lockfile held constant.

Record: initialization rejecting or replacing the prepared checkout;
dependencies or outputs copying up in proportion to tree size; the
constant-lockfile change reusing stale dependencies; artifacts differing from
a plain build; any change to view B or the lower tree. Then repeat in two
Microsandbox guests from one prepared image and measure host-wide physical
growth.

**Gate:** after Phases 1 and 2, rerun Phase 0. Pass means initialization and a
no-change cache-hit build each add ≤ 10 MB to the upper, artifacts match a
plain build, and view B is unchanged. A failure points to a path to fix; it
does not by itself reject prepared bases.

### Phase 1: prepared bases (R1, R2)

Prepared bases extend the repository environment image (#3062). There is one
image system:

```
 environment image (.smithers/environment.nix) → + installed dependencies → + build outputs → + checkout at C

 guest A ┐
 guest B ┼─ prepared base (shared) + private writable layer
 guest C ┘
```

- Adopt a prepared checkout instead of cloning: private `.git`/`.jj`
  metadata, the pinned revision, and a readiness receipt only after the
  prepared dependency identity is verified.
- The local microVM dependency layer holds the installed tree, so workspaces
  stop linking their own `node_modules`.
- Main is the prewarm target, not the only reusable state: any revision
  resolves its own complete keys and builds on a miss.

### Phase 2: ordinary cache hits stop copying (R3)

- Materialize cached outputs with reflinks (`COPYFILE_FICLONE`, `FICLONE`);
  fall back to copying where the filesystem lacks reflinks, and report it.
- Move the blob store out of each checkout into one store per host, scoped per
  repository.
- When an output root already matches its manifest for the exact action key,
  skip restoration on every ordinary cache-hit path, not only `Materialize`.
- Keep today's metadata normalization (modes `0755`/`0644`). Producers that
  depend on other metadata (timestamps, xattrs, ACLs) are refused by name.

### Phase 4: macOS host workspaces (R8)

Clone a prepared, fully merged source and output tree into each workspace with
`clonefile(2)`. Blocks are shared; each workspace still pays one inode per
file, and diffs need a scan. Installed trees are path-bound, so each
destination gets its own prepared dependency tree.

## 5. Rules for prepared bases

**Keys.** A key is a complete recipe for the requested revision: immutable
input trees (lockfile, every `package.json`, `.npmrc`, pnpmfile, patches,
lifecycle-script sources), pinned toolchain and base image, configuration, and
allowed network destinations. Producers own their recipes; arbitrary commands
are not cached until a producer contract covers them. This is the cache
contract rule in `AGENTS.md`: incomplete identities stay fail-closed.

**Paths.** Prepared trees are path-bound by default and are built at the path
they run at. Relocatability is an explicit producer guarantee backed by a
relocation test with the original path inaccessible; a path scan may reject an
artifact but never grants portability.

**Trust.** Workloads cannot write prepared bases or the host blob store. Image
references, blob stores, existence checks, and GC are scoped per tenant and
repository. Publishing a key→result mapping requires an authorized builder;
digests prove bytes, not provenance. Prepared bases contain no credentials,
tokens, or user state.

**Publication.** Write blobs, then the manifest or image, flush, then publish
the index last with a conditional write. A second, different result for one
deterministic key is recorded as a reproducibility conflict, never
last-writer-wins.

**Garbage collection.** Pins are durable records (owner, workspace,
heartbeat) written under the GC lock before a base is resolved or booted, and
released after confirmed shutdown. On restart, the collector reconciles pins
against running and stopped guests before deleting anything. Stopped
workspaces, checkpoints, retained images, builders, and uploads are roots.
Deletion goes through a tombstone phase with a recheck.

**VCS attachment.** Each workspace has private mutable `.git`/`.jj` state and
shared immutable objects. jj snapshots still scan unless a filesystem monitor
is integrated.

## 6. main and jj stacks

```
 workspace descriptor (pinned): revision, tree, base image digest, path contract

 rebase:  jj rebase in repository state
            → new workspace: fresh writable layer from the result tree on the new base
            → old workspace kept until handoff succeeds
 never:   a new base slid under an existing writable layer
```

Main is prewarmed because most work branches from it. A stack revision that
many agents reuse can be promoted to a prepared base on demand.

## 7. Laptop and Cloud (R7)

- Changes travel as jj commits through the existing git remote, including
  their reachable objects.
- Prepared bases travel as OCI images pulled by digest; a laptop and a worker
  share a base only when platform and path match.
- No laptop disk is mounted into the Cloud: a local disk answers a lookup in
  microseconds, a laptop round trip takes tens of milliseconds, and a sleeping
  laptop would freeze every agent.

## 8. Validation

A lifecycle suite runs at the gate: launch, cache-hit build, one-file edit and
build, deletion and rename, rebase, stop and resume, GC.

| Measure | Why |
| --- | --- |
| Host-wide physical growth, not per-workspace `du` | `du` double-counts shared extents |
| Inode growth | APFS clones pay per file |
| Upper bytes and files per step | Catches copy-up from setup and cache restores |
| Output manifests vs a plain build | Catches stale or different artifacts |
| Claim-to-ready and cold boot latency | R2 |
| Two source revisions, two install keys | Catches wrong reuse |
| Competing builders, GC during boot, process death | Publication and GC rules |

## 9. Alternatives considered

| Option | Why not first |
| --- | --- |
| A new file CAS and union filesystem | L; prepared bases test the cheaper path |
| git worktree + shared pnpm store | Hardlink mode shares inodes and reflink mode shares blocks, but each workspace still installs and builds |
| Yarn Plug'n'Play | JavaScript-only; some packages need a real `node_modules` |
| EdenFS (Meta) | Virtualizes tracked files only; generated trees land in its local overlay |
| VFS for Git / Scalar | Windows-only virtualization in maintenance mode / Git performance tooling; neither shares generated trees |
| CitC / ObjFS-style lazy FUSE | Solves trees too large for one host; not released; bb-clientd is the closest open equivalent |
| Mounting a laptop disk into the Cloud | Latency and availability |
| composefs | The right Linux tool if a file-level layer library is ever admitted |

## 10. Open questions

1. Where exactly does Phase 0 fail today?
2. Is a prepared image or a prepared stopped guest the better base, by claim
   latency and host-wide bytes?
3. How long does `clonefile(2)` take for 847,693 entries on APFS?
4. Who outside Smithers pays for this today? No external user is named yet.

## 11. Docs to update

Each changes in the same change that ships its phase. The `node_modules`
target stays uncached and the host pnpm store is cut, so the Install docs do
not change.

| Phase | Docs |
| --- | --- |
| Now | `apps/app/docs/WORKBENCH-UX.md:38-43` cites a deployment spec that does not exist |
| 1 | `packages/backend/microsandbox/README.md:60-84`; `distribution/README.md:142`, `:157`; `packages/backend/docs/workspace-creation.md:19-24`, `:48-53`; `packages/backend/docs/host-recovery.md:76-77`, `:105-107`; `docs/api/openapi/repositories.yaml:13840-13842` and `_root.yaml:249-252` (then the `openapiBundle` and `openapiClients` targets); `docs/mvp/PRODUCT.md:282`, `:285`; `docs/mvp/ENGINEERING.md:307-308`; `apps/app/docs/WORKBENCH-UX.md:66-67`; `apps/app/docs/decisions/0002-citc-sandbox-kinds.md:5-10`; `packages/smithers/docs/guides/cloud-sandbox.md:33-47`; `apps/site/src/content/docs/docs/learn/boxes.mdx:101-106`, `guides/cloud-ci.mdx:11-19` |
| 2 | `packages/smithers/build/build-cli/docs/concepts/caching.md:12-25`, `:113-150`; `packages/smithers/build/docs/workspace/caching.md:127-148`, `:170-185`, `:402-416`; `packages/smithers/build/docs/workspace/configuration.md:50-81`; `packages/smithers/build/docs/reference/config.md:90-100`; `packages/smithers/build/docs/reference/cli.md:35`, `:206-207`; `packages/smithers/build/docs/concepts/actions-and-boundaries.md:43-66`; `packages/smithers/build/DESIGN.md:160-180`; `apps/site/src/content/docs/docs/concepts/target-caching.mdx:46`, `guides/artifacts-cache.mdx:143` |
| 4 | `docs/flow-builder/engineering.md:838-846` |

Package docs go through `pnpm docs:sync`, `pnpm docs:check`, and
`smthrs docs //<package dir>:docs`.

## Sources

- [CitC and Piper, CACM 2016](https://cacm.acm.org/research/why-google-stores-billions-of-lines-of-code-in-a-single-repository/)
- [Software Engineering at Google, ch. 18](https://abseil.io/resources/swe-book/html/ch18.html): ObjFS
- [OCI layer whiteouts](https://github.com/opencontainers/image-spec/blob/main/layer.md#whiteouts)
- [overlayfs kernel docs](https://docs.kernel.org/filesystems/overlayfs.html)
- [KSM kernel docs](https://docs.kernel.org/admin-guide/mm/ksm.html)
- [composefs](https://github.com/composefs/composefs/blob/main/README.md)
- [clonefile(2)](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/clonefile.2)
- [jj filesystem monitor](https://docs.jj-vcs.dev/latest/config/#filesystem-monitor)
- [EdenFS overview](https://github.com/facebook/sapling/blob/main/eden/fs/docs/Overview.md)
- [The Story of Scalar](https://github.blog/open-source/git/the-story-of-scalar/)
- [Together Code Sandbox](https://docs.together.ai/docs/together-code-sandbox)

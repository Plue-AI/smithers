---
title: "Target execution"
description: "What the executor guarantees while a target runs: write-set confinement and exact rollback, the sandbox boundary, supervised services, and the ceilings every untrusted read holds to."
sidebar:
  order: 5
---

The planner decides what runs. The executor decides what a running target is
allowed to touch, and puts the tree back when it oversteps.

The [rule contract architecture](./rule-contracts.md) maps the shared services
and the family planners and executors that use them.

## Write-set confinement

A target that mutates the tree declares what it may write. Every such run is
wrapped: the tracked tree, the gitignored tree, and every escaping symlink are
measured before the body runs and again after. Any change whose resolved
location falls outside the declared write set is reverted, and the node fails.

Rollback is exact for tracked and gitignored paths alike. A failed body has
every change it made reverted, in set or not, because a partial write from a
tool that then errored is not a state anyone asked for. An out-of-set write to
a path that already existed gets its prior bytes, mode, or link target back,
never a deletion: the gitignored census holds every ignored file's bytes in a
stash before the body runs, and a tree it cannot hold whole refuses the target
before it runs at all.

A workspace without its own `.git`, such as a `jj workspace add` checkout, has
no tracked tree git can list. There the gitignored census covers the whole
tree, so every file outside host state is held in the stash, counted against
the same ceilings, and restored from it.

### Another writer during a guarded run

The census covers the whole tree, so it also sees what an editor, an agent, or
a second build process changed while the body ran. The guard judges only the
changes the body could have made:

- A confined tool can write only where its sandbox binds the tree writable: the
  directories of its declared outputs and write set, and the parent directory
  of each declared output file. A change anywhere else was made by someone
  else, and the guard neither reverts nor reports it.
- An in-process body (an agent candidate, `Github.CiGen`) writes paths it names
  before it writes them, so only those paths are judged.
- A tool that runs unconfined (`sandbox: "none"`, or a host with no mechanism)
  could have written anywhere, so every change is judged.

A revert never destroys bytes. Before it restores or removes a path, the guard
copies what stands there into `<cache directory>/reverted/<target>-<time>/`,
at the same relative path, and the failure names that directory:

```text
wrote outside its declared write-set (reverted): lib/user.ts; the reverted bytes are kept at .flows/reverted/fmt-2026-09-24T17-01-02-003Z-9f2a1c
```

The residual case is a foreign change inside a directory the tool may write,
for example a sibling of a declared output file at the workspace root. It is
reverted and the target fails, and the edit is recoverable from the quarantine.
Nothing removes a quarantine: `cache clear` removes action results only, so
delete `reverted/` by hand once you have what you need.

Dirty-file and escaping-symlink snapshots retain full file permission bits.
Rollback restores those bits with the bytes, including private modes such as
`0600` and `0640`; permission-only changes also count as writes. If either
snapshot acquisition fails, it removes its partial stash and reports the
original acquisition error.

### What the census costs

The census costs what a body can change, not what the tree holds. It asks git
only for the paths matching an ignore pattern (`--ignored=matching`) and walks
each matched directory itself by `lstat`, never entering `node_modules` at any
depth, version-control internals, the cache directory, or a nested repository.

One stash serves every guarded body in a run. A census copies only the files
whose `lstat` identity moved since the stash last held them and drops the ones
that vanished, so an unchanged ignored file costs one `lstat` per body and a
run's first census is the only one that copies the whole ignored tree. Each
snapshot reports its own accounting: entries, bytes, files copied, files
reused.

On the Smithers repository the census fell from 23,149 entries and 880 MiB,
15,000 entries and 672 MiB of them under nested `node_modules` directories, to
8,150 entries and 208 MiB, well under the 50,000-entry and 1 GiB ceilings. A
warm census takes under a second where the old one took 20 to 30 seconds.

### The two things confinement cannot do

A directory git does not enter, a nested repository, cannot be restored. A
write into one is reported as `not restored` and left exactly as the tool left
it, because removing it would destroy contents the stash never held.

Git cannot see a write that lands through an in-workspace symlink whose real
target leaves the workspace, so those portals are measured directly, before
and after. A portal the census cannot measure, over the entry cap or
unreadable, refuses the target. The guard has no partial mode: a confinement
claim it cannot keep is not made.

## Sandboxing

A target may declare `sandbox: { network: false }`,
`sandbox: { network: "loopback" }`, or `sandbox: { network: true }`. A
workspace may name the mechanism with
`S.Sandboxes({ default: S.Sandbox.Docker({ image }) })`.

`sandbox: "none"` disables confinement entirely and keeps host network access.
The internal network posture `"none"` instead means no network; on a target,
spell that policy `sandbox: { network: false }` (also the default).

With no mechanism declared the platform picks one: bubblewrap on Linux
(`bwrap` on `PATH`), seatbelt on macOS (`/usr/bin/sandbox-exec`), and a
refusal elsewhere, because Windows has no user-level process sandbox and
Docker needs an image only the workspace can name.

A confined request with no mechanism available fails closed. The run refuses
the target, and `--plan` reports the refusal beside the declaration. A result
produced outside an enforced confinement is evidence for this machine only and
never reaches the shared cache tier.

Loopback-only networking is supported by seatbelt on macOS. Bubblewrap cannot
expose the host loopback interface without also sharing the host's full network
namespace, so Linux refuses `{ network: "loopback" }` with a typed sandbox
limitation. Use `{ network: true }` only when full network access is intended.

### What a sandbox admits

Inside the workspace, each mechanism limits reads to the admitted read set
and writes to the admitted write set. The read set includes keyed inputs
plus the paths a rule discovers for itself:

- the target's expanded declared inputs, the declared outputs of every
  transitive dependency, and a `Filegroup` dependency's files;
- the `node_modules` trees above the working directory, and the cache
  directory's scratch and fetch store;
- what a rule plans over, such as a `Go.*` rule's `go.mod`, `go.sum`, and the
  compiler inputs `go list` reports, because that rule names its work with
  import patterns rather than `S.file` declarations;
- what the package manager opens before it runs anything: the manifest, the
  lockfile, and the workspace file, when a rule drives `pnpm`;
- where a declared read really lives when the path reaches it through a link
  that leaves the workspace, such as a scratch tree's `node_modules`, which
  bubblewrap and Docker bind read-only because their `/tmp` is private;
- a git submodule's local source repository, when its `.gitmodules` url is an
  absolute path or a `file://` url. The path must be a git repository (it holds
  `.git`, or `HEAD` and `objects`) and must not be the filesystem root, the
  home directory, or an ancestor of it; otherwise the target is refused.

The write set is the declared outputs, the declared `changes`, the clean
targets, and what a tool writes on its own account: a cargo crate's `target`
directory, a `Foundry.Build` or `Foundry.Test` rule's `out` and `cache_path`
as `forge config` resolves them, and `.git` for a submodule checkout.

Native confinement does **not** isolate reads outside the workspace. Linux
binds the host root read-only before hiding the workspace and `/tmp`; macOS
denies reads only under the workspace. Other host files remain readable,
including the real home's `.ssh`, `.aws`, and `SMITHERS_HOME` when they are
outside the hidden roots. A private `HOME` and temporary directory redirect
writes; they do not hide those original paths or make native builds hermetic.
`COREPACK_HOME` also remains readable because package-manager shims need it.

This supports host-installed tools, libraries, SDKs, and package-manager stores
whose complete read dependencies are not declared today. Use the Docker
mechanism with an image containing the toolchain when host-file read isolation
is required; only its declared host mounts are exposed. Explicit read mounts
and symlinks into host stores still expose the files they admit.

Cache keys carry the platform and architecture, the resolved executable path
and SHA-256 of its bytes, and the identities and bytes of declared tool
references. Replacing a compiler without changing its version string therefore
invalidates its cached build. Workspace-local executable paths remain relative;
host tool installations retain their resolved absolute paths.

The child environment key hashes declared `env` overrides and resolved Nix
environment variables by value. Inherited `HOME`, `TMPDIR`, `TEMP`, and `TMP`
are excluded; other inherited allowlisted names, including `PATH`, `CI`, and
SDK selection, contribute presence only. Declare output-affecting values in
`env` so changes to those values invalidate the cache. The environment enters
diagnostics as a digest; withheld cache credentials and unrelated parent
variables are excluded.

A changed inherited `PATH` alone does not invalidate a key when it resolves
the same executable identities. Executable fingerprinting covers changes to
the resolved paths and bytes, including the leading literal program in a
command-form build. Tools selected dynamically inside shell scripts must
still be declared as tool dependencies; this does not infer an arbitrary
program's subprocess or library dependencies.

## Services

A target may depend on services the executor starts, refcounts across
consumers, and stops through a declared contract.

A target with `services` must explicitly declare `sandbox: { network:
"loopback" }` or `sandbox: { network: true }`. Merely declaring a service never
widens the consumer's network policy. Because Linux cannot enforce host
loopback-only access, a cross-platform service consumer normally declares
`network: true`; that is an explicit full-egress opt-in.

Readiness is a port, an HTTP URL, or an exec probe. Health repeats the
readiness probe on an interval, and a declared number of consecutive misses
(three by default) marks the service unhealthy. Stopping sends a declared
signal (`SIGTERM` by default) and waits a declared grace period (5 seconds by
default) before `SIGKILL`.

An interrupt or health failure waits for the consumer body and its write-set
restoration before releasing the tree permit or deleting the shared stash.

Every probe and hook runs in the service's own working directory under the
same resolved environment the service process was given. Docker services
publish their declared ports on `127.0.0.1` only. Each shared service lifetime
gets a unique name: an invocation-scoped prefix plus a fresh acquisition nonce.
The supervisor captures the ID returned by `docker create --rm` and registers
its removal before closing the create client's process scope. If that client's
cleanup fails, removal still runs and the cleanup defect is preserved, including
any additional removal-client cleanup defect. It then starts and attaches to
that ID. Readiness, initialization, and cleanup also address that ID.
Delayed cleanup cannot delete a replacement, even within the same
command, and consumers holding a live service still share it by refcount.
`DockerExec.containerName(label, cwd, invocationId)` returns the stable prefix;
`serviceSpec` requires the caller's fresh command invocation ID. Its Docker
argv contains creation options, and its exec readiness/init contain container
commands; the supervisor adds the operation and resource ID at acquisition.
Preparation never deletes an existing container. When creation answers with no
readable ID, cleanup falls back to the unique name that acquisition minted,
which no other lifetime ever uses; a daemon that finishes that creation after
the bound expires can still outlive the removal. A container left by a
hard-killed command may require manual cleanup; a later command cannot assume
it is abandoned. A service captures a
bounded tail of its output, which is what a failure reports.

Services live at most as long as the command's scope, and the supervisor holds
an orphan backstop on the process signals. That backstop is why the process
entry registers persistent signal listeners rather than one-shot ones; see
[The invocation pipeline](./invocation.md).

## Resource ceilings

Each boundary that reads something it did not produce holds an explicit limit,
and crossing one fails the target rather than exhausting the host.

| Boundary                  | Limits                                                               |
| ------------------------- | -------------------------------------------------------------------- |
| Captured output trees     | Depth, entry count, path bytes, per-file bytes, total bytes.         |
| Escaping-symlink portals  | Entry count.                                                         |
| The gitignored census     | Entry count while walking, and bytes held in the stash.              |
| `S.Fetch` response bodies | Byte count and a request deadline, independent of any caller signal. |
| `S.Fetch` redirects       | Ten hops; each stays on `http(s)` and never leaves `https`.          |
| Agent prompts and data    | Byte count per file and per prompt.                                  |
| Rendered failure text     | UTF-16 code units.                                                   |

Two details are worth knowing. A rendered fetch URL is stripped of userinfo,
query, and fragment before it appears anywhere; the full value stays in the
failure's cause. An agent prompt's data files are read through a descriptor
proven to resolve inside the workspace, so an in-workspace symlink cannot pull
a host file into a model prompt.

---
title: "Caching"
description: "The cache directory, what a content key covers, the content-addressed store and its guarantees, and the read-through remote cache with its credentials and trust domains."
sidebar:
  order: 4
---

A cached target does not run. Everything below is about deciding when that is
safe.

## The cache directory

Every workspace command takes `--cache-dir`, a workspace-relative directory
holding the result cache, the content-addressed artifact store, and rule
scratch files. `create-app` is the exception: it scaffolds a directory and
reads no workspace.

Precedence is the flag, then the `S.Cache({ directory })` of the workspace
declaration, then `.flows`. An empty value, an absolute path, and any `..`
segment fail the command.

Keep the directory out of version control. Nothing in it is an input to
anything: discovery never lists a path inside it, so its contents cannot feed
input discovery or a digest, and the directory's name never enters a key.

## What a key covers

A target's content key is a sha256 over four fields, and a change to any of
them is a different target as far as the cache is concerned.

**`body`** is the target's persistent identity: its rule, its flow tag, its
schema identity, the verb-effective mode, the working directory, its declared
output roots, and two format salts that let an executor change semantics
without serving stale results.

**`inputs`** is everything the run depends on:

- `attrs`, canonicalized so a target reference becomes that dependency's key
  and a declared input becomes a content digest;
- the expanded declared inputs and their file digests;
- the dependency rows, so a dependency's result is part of the dependent's
  identity;
- `ambient`: the host's Node version, platform, and architecture, the
  lockfile digest, and the implementation fingerprint.

**`layers`** carries the resolved environment, such as a Nix closure hash.

**`capabilities`** carries what the target was allowed to do.

The implementation fingerprint is worth calling out: it digests the bytes of
the executor and rule implementations that will run the plan. Editing the
executor therefore re-keys every target, which is why a rule fix is never
served a result the old rule produced. A rule implementation's function
identity is deliberately absent from the key, because closure identity carries
per-process entropy and could never answer a cross-process hit.

`--plan` prints a preview of this material per target, and `SMTHRS_DEBUG_KEYS`
names a file every node's key material is appended to when a hit you expected
did not happen.

Go test and fuzz keys include compiler inputs from dependencies imported only
by internal or external test files, including local replacement modules.
Workspace files in that closure also enter the sandbox read set.

## Executable identity

The package executor includes the resolved path and SHA-256 content digest of
host executables in cache keys. Replacing a tool at the same path with the
same version string causes a miss on the next invocation. Symlinks are
followed to their targets. Executables inside the workspace use relative
paths so a checkout can move without changing its keys.

This covers `Host.bin`, `NodeModule.Bin` entry points, runtime and package
manager executables and their launchers, Bun, resolved Nix/Mise tools, Go and
Cargo executables, Cargo plugins, and the shell and leading literal program
of a `Shell.Build` command. Shebang
scripts also include their interpreter's path and bytes, including the PATH
lookup in `#!/usr/bin/env node` and `#!/usr/bin/env -S node ...`. Unsupported
`env` option or quoting forms refuse planning instead of guessing. Commands
computed by shell expressions or launched later by a script need declared
tool dependencies; the executor does not trace arbitrary subprocesses.

Go identities include the selected `GOROOT/bin` executables and `GOTOOLDIR`
tools, so a stable launcher cannot hide a changed compiler. Rust identities
include the declared rustup executable and the installed Cargo, rustc,
Clippy, and rustfmt components selected by the declared toolchain. Target
environment overrides participate in Go and Rust toolchain selection. Native
libraries and runtime data are installation dependencies, not executable
files traced by this contract.

`NodeModule(package)` is an installed dependency reference. Its manifest
version and the workspace's full lockfile digest identify the installation;
there is no per-package lockfile slice in this executor. The contract assumes
installed package contents match the lockfile, including its integrity and
patch records. Local edits to module source or transitive files are not
independently hashed by this reference. Declare editable sources as file or
closure inputs. `NodeModule.Bin` additionally hashes the actual executable
entry point.

A target used as `bin` contributes its producer key and the produced
executable's content identity after the producer has settled. Its plan key
is a preview: a missing output on a cold checkout is not a missing host tool.
Consumers and their dependents use the settled key at execution time.

Executable byte memoization belongs to one plan and is never persisted.
Execution checks the observed files before consulting the cache and again
before storing a successful result. A change since planning refuses the
operation and asks for a new invocation. These checks do not lock host files
or provide an atomic filesystem snapshot: tools and their installations
must remain stable while a subprocess runs. A change and restoration wholly
between checks cannot be detected.

## The content-addressed store

A target's declared `outDir` trees and `outFile` files are captured into
`<cache-dir>/cas`, keyed by the sha256 of their bytes.

`Go.ModDownload` captures its output directory through a temporary tar archive
under `<cache-dir>/tmp`. Capture removes the archive on success and failure.
Markdown code-block checks remove their per-key scratch tree after each run;
cache hits reuse the result without recreating that tree.

A blob is never trusted by name. An existing one is re-verified against its
digest and rewritten from the freshly produced file, so a rebuild heals a
tampered store instead of leaving it poisoned for every later run.

Restoring is bounded on both ends. A manifest read back from the cache is
untrusted input, so every path it names is confined to the node's declared
outputs before anything is written, and every blob is verified before the tree
is materialized. Publication stages the whole tree in a temporary sibling,
then moves the previous tree aside and renames the staged tree into place.
These are two separate renames with a brief absence window at the output path.
Readers that require continuous visibility must coordinate with publishers.
If the publication rename fails, restoration of the previous tree is attempted;
if restoration also fails, the error identifies the preserved backup.

Staging trees and backups include a hash of the canonical destination path.
A per-output filesystem lock protects recovery and publication across processes;
a competing publisher fails immediately and may retry after the owner finishes.
A process crash can leave this lock behind. Remove the named
`.smthrs-lock-<destination>` directory only after confirming no publisher still
owns it, then retry. If the output is absent, recovery restores only its uniquely
owned backup. Legacy `.smthrs-old-<stamp>` backups without destination ownership
and multiple matching backups require operator recovery and are never guessed.
Single-file restoration removes copied temporary files after copy, chmod, or
rename failures when cleanup is possible, preserving the original error.

The capture walk holds declared ceilings on depth, entry count, path bytes,
per-file bytes, and total bytes. A tree that crosses one aborts the capture
before anything reaches the store, naming the path and the limit.

## The remote cache

A workspace may declare a shared cache as the `remote` field of its cache
declaration:

```ts
import { Smithers as S } from "@smthrs/targets"

export const Workspace = S.Workspace("demo", {
  cache: S.Cache({
    directory: ".flows",
    remote: S.RemoteCache.make({
      endpoint: "https://cache.example.com",
      read: S.Secret("SMITHERS_CACHE_READ_TOKEN"),
      write: S.Secret("SMITHERS_CACHE_WRITE_TOKEN")
    })
  })
  // the rest of the declaration
})
```

`make` accepts exactly `endpoint`, `token`, `read`, `write`, and
`publicReadToken`, and refuses any other own property. `token` and `read` name
the same slot and are mutually exclusive: one credential for both directions,
or a read credential plus a `write` one. Omitting both defaults the read
credential to `SMITHERS_CACHE_TOKEN`. An endpoint must be an absolute HTTPS
URL with no userinfo, query, or fragment.

`publicReadToken` is a committed literal that can only read the one
repository's cache. It is exclusive with `token` and `read`: reads use the
literal and `write` names the publishing credential. This is the same posture
as a read-only access token in other build caches, which is why it may live in
the repository.

### The transport

The CLI reads through HTTP `/ac`. A local hit avoids the network, a remote hit
hydrates the local entry, and a put publishes to both tiers.

- A remote failure warns once and disables the remote for the rest of the
  process, so a flaky cache slows a build instead of failing it.
- A `409` conflict warns and keeps the first published result.
- A publication the credential may not perform stops publication only. An
  untrusted job is meant to read everything and publish nothing.

### Overrides and trust domains

`SMITHERS_CACHE_URL` overrides the declared endpoint for one process. It does
not change which credentials the workspace declared, so a split read and write
pair survives an override.

`SMITHERS_CACHE_NAMESPACE` names the trust domain this process publishes into.
Set, results are published under `<namespace>/<key>`; unset means the trusted
domain, which is what a post-merge build has. Which domain a job belongs to is
a property of the job rather than of the workspace it builds, which is why it
comes from the environment and not from a declaration.

A result produced outside an enforced sandbox is evidence for this machine
only and never reaches the shared tier. This includes agent verdicts: with
`sandbox: "none"`, repeated runs can reuse a local verdict, but the verdict is
never published to the remote cache. See
[Target execution](./execution.md).

### Credentials

Token values are read from the named environment variable only at the moment
an outbound request is built. They are never held in a serializable field,
never part of any key, and stripped from the environment of every spawned
tool. The process entry point additionally captures and deletes
`SMITHERS_CACHE_URL` and `SMITHERS_CACHE_TOKEN` before any declaration
evaluates.

For the walkthrough, see
[Share results through a remote cache](../guides/share-a-remote-cache.md).

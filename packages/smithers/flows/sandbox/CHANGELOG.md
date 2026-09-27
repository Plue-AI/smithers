# @smthrs/sandbox

## [Unreleased]

### Added

- `MicrosandboxSandbox.make` takes `networkPolicy` (for example deny-by-default egress with a domain allowlist) and
  `rootDiskMib`; `captureSnapshot`, `hasSnapshot`, and `pruneSnapshots` capture a prepared machine's disk and manage
  the named snapshots machines boot from. The `Sdk` slice gains `rootDisk`, `network`, a handle's `stop` and
  `snapshot`, and `Snapshot.get`/`list`/`remove`.
- `pruneSnapshots` takes names to retain; `removeSnapshot` removes one snapshot.
- Snapshots are named `<family>.<member>` by `snapshotName`, and `snapshotFamily` reads the family back.
  `captureSnapshot` takes `family` and `member` in place of `name` and returns the name it wrote;
  `pruneSnapshots` takes the family and matches it exactly, so one family's prune can no longer remove
  another family's snapshots whose names merely started with the same text.

### Changed

- **Breaking for custom `MicrosandboxSandbox.Sdk` implementations.** The
  injected slice now matches the streaming and lifecycle surface of
  `microsandbox` 0.6: command handles expose `recv()`, `signal(number)`, and
  `kill()` in place of a collected result; machines and handles are removed
  with `destroy({ timeoutMs, force? })` in place of `stop()`; handles expose
  `configJson`, `refresh()`, and `modify()`; `Sandbox.listWith` lists machines
  by label with cursor paging; and `defaultBackendKind()` and
  `setDefaultBackend()` are required. Callers passing the real `microsandbox`
  module are unaffected.
- `MicrosandboxSandbox` sessions stream command output as the guest writes it,
  return from `spawn` once the command has started, and declare `kill`.
  Closing a spawn's scope before the exit, as an interrupted caller does,
  sends `SIGTERM` to the command and every process it started, then `SIGKILL`
  after a two-second grace, inside the five-second teardown bound.
- The descendant kill scripts shared by `ContainerSandbox`,
  `KubernetesSandbox`, `AwsSandbox`, and `MicrosandboxSandbox` stop the whole
  collected process set, signal it, and continue it. Signalling children
  before their parent let a shell parent woken by a child's death run its next
  statement before its own signal landed; on a single-vCPU microVM an
  interrupted `sleep 2; printf survived > file` wrote the file in 7 of 16
  runs, and in none of 16 after this change. A signal that itself stops or
  continues is delivered without the freeze.

### Added

- `MicrosandboxSandbox.reap` takes `retain`, which keeps a dead holder's
  machine by the labels its configuration records, such as a sticky workspace
  a resuming run will reattach.

- `MicrosandboxSandbox` machines carry the ownership labels
  `smithers.provider`, `smithers.owner`, and `smithers.holder`, exported as
  `providerLabel`, `providerName`, `ownerLabel`, and `holderLabel`, with the
  `owner` and `holder` options naming the installation and live holder;
  reattaching a machine relabels it to the new holder. `reap({ sdk, owner,
  isAlive })` removes one owner's machines whose holder is no longer alive,
  re-reading each before removal so a reattached machine survives.
- `MicrosandboxSandbox` refuses to provision unless the SDK's default backend
  is local, and refuses a machine that reports another backend, so ambient
  `MSB_*` configuration cannot move guest work off the host. `backend: "any"`
  opts out.
- `SandboxConformance.check` accepts `provides.interrupt` and
  `provides.ephemeral` claims and `isolation.hostSentinel` and
  `isolation.egressProbe` claims, checked by `interrupts-a-running-command`,
  `releases-ephemeral-state`, `hides-host-paths`, and `refuses-egress`.

### Fixed

- A `MicrosandboxSandbox` command the guest could not start (a missing program
  or working directory) left its streams and `exitCode` pending forever: the
  SDK reports that failure as an `undefined` event, which the provider read as
  an event kind and died on. It now fails with `spawn_error`, and an
  equivalent failure while warming a Nix environment fails the acquire with
  `unavailable`.
- A `MicrosandboxSandbox` removal whose graceful stop fails is retried with
  `force: true` before it is reported, on release and in `reap`.
- A `MicrosandboxSandbox` command whose machine goes away fails its streams
  and `exitCode` with `unavailable` at once instead of waiting for an exit that
  will never be reported.
- `MicrosandboxSandbox` sessions now supply `files`, the native `stat`,
  exclusive creation (`wx`), modes, `chmod`, and `chown` that
  `ContainerSandbox` sessions already had, through the same guest commands.
  Without them the std `write`, `edit`, and `apply_patch` tools, which replace
  a file through an exclusive sibling that keeps the file's mode, failed in a
  microVM with "Could not write". The image needs GNU or BusyBox `stat`,
  `mktemp`, and `ln -T`.

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added `Sandbox`, the provisioned-machine contract: `Provider.acquire` turns a
  session key into one held `Session` with byte-typed file transfer beside the
  same spawn, and three projections derive from it. `commandProvider` projects
  a session onto `RemoteChildProcessSpawner.Provider`, `fileSystem` serves
  Effect's `FileSystem` from a session through native operations and POSIX `sh`
  probes, and `layerHost` holds one machine for a layer's lifetime and provides
  `ChildProcessSpawner`, `FileSystem`, `Path`, and `SandboxHealth` from it.
  `TestSession` is the scripted double.
- Added `SandboxConformance`, the session-level suite, alongside the
  spawner-level `ProviderConformance`. It states the session contract as
  behavior: byte round-trips, absence, parent creation, the default workdir and
  a relative `cwd`, environment and standard-input delivery, standard error,
  reacquisition, and two cross-surface checks that a session serving files from
  anywhere but the machine its processes run on cannot pass. Both suites bound
  every check with `checkTimeout` on the platform timer, so a provider that
  never answers is convicted rather than hanging the suite under a frozen test
  clock.
- Added nine machine providers behind that one contract: `DirectorySandbox`,
  `ContainerSandbox`, `KubernetesSandbox`, `JustBashSandbox`,
  `MicrosandboxSandbox`, `VercelSandbox`, `DaytonaSandbox`, `AwsSandbox`, and
  `CloudflareSandbox`. Each is one `make` returning a `Sandbox.Provider`; the
  vendor surface it drives is a constructor argument, so adding a backend costs
  this package no dependency and no host access. Every provider's options type
  is exported and nameable.
- Added `RemoteOptions.stdin` and `Provider.stdin`. A provider that declares
  the flag receives a command's standard input collected whole and bounded at
  16 MiB; a provider that does not gets the command refused instead of losing
  its input. `ProviderConformance` holds a declaring provider to actually
  delivering the bytes.
- Added `not_found` to `ProviderErrorCode`, so an absent guest path stays
  distinguishable from a broken session at the one seam whose job is to keep
  them apart.
- Added `SandboxSupervision`, a spawner that holds one provider session, probes
  it on an interval, and retires it after `tolerance` consecutive unhealthy
  verdicts, failing everything running in it so a retry policy can land the
  work on a fresh session.
- Added package-owned, authored documentation in `docs/`: API reference,
  concepts, guides, installation, troubleshooting, and limits.

### Fixed

- `sessionSlug`, which every provider derives its machine's name from, now
  carries a 64-bit digest of the whole session key instead of one 32-bit
  multiplicative hash. The old digest's tail was linear, so two keys sharing
  the readable prefix collided whenever their remaining characters satisfied
  one modular sum, and two sessions that collided shared one machine and tore
  it down under each other. The exact output is pinned by golden vectors,
  because changing it orphans anything running under the old names.
- Standard input is counted as it arrives rather than after the producer
  finishes, so an endless or oversized producer is stopped at the bound instead
  of allocating without limit, and the staged input file lives in a
  session-private directory under an unguessable name and is removed by a
  finalizer of the spawn's scope rather than by a `rm` a killed shell never
  reaches.
- `Sandbox.fileSystem` lists with `ls -1A` rather than a bare `ls -A`, which
  columnizes on a pseudo-terminal transport, and installs a session's native
  overrides through the workdir resolver rather than beside it, so an override
  receives the rooted path the constructor promises it.
- `ContainerSandbox`, `KubernetesSandbox`, and `AwsSandbox` apply a caller's
  environment with `env(1)` in front of an absolute shell, instead of a bare
  `sh` a caller's `PATH` override could break or an `export` that aborts on a
  name the session contract accepts.
- Closing a `DirectorySandbox` spawn's scope now signals the whole process tree
  the command started, and a kill that arrives before a guest wrapper has
  recorded its pid leaves a cancellation marker the wrapper honors, so a
  cancellation cannot outrun the command it meant to stop.
- `AwsSandbox` adopts a crash-left task that is still `PENDING`, stops
  duplicates under one key before provisioning, and validates
  `ExecTransport.chunkBytes`, which as the increment of the write loop would
  otherwise spin forever on `0` or silently truncate a file on `NaN`.
- The signal a closing process scope sends is bounded at five seconds.
  Finalizers run uninterruptibly, so a provider whose `kill` never answered
  wedged the fiber closing the scope, and cancellation, layer teardown, and
  `ProviderConformance`'s own deadline with it: losing the check's race closed
  the scope, whose finalizer sent the same signal again. The provider's release
  finalizer sends it once more when it tears the session down, so the bound
  costs a courtesy rather than the guarantee.
- `SandboxSupervision` no longer caches a session that never opened, so a
  provider without `ping` opens a fresh one on the next command instead of
  replaying the first open failure for the life of the layer. Retirement fails
  the in-flight commands and closes the provider scope uninterruptibly before
  reporting, so a reporter that defects or never returns cannot strand a
  waiter, leak the machine, or hold the permit every later command needs.
- `SandboxHealth.probe` no longer logs a failed ping's `ProviderError` as the
  log record's cause. Adapters attach raw vendor errors to `cause`, which can
  quote credentials, request headers, proxies, or response bodies, and the
  standard formatters render that object whole, so any host that raised its
  minimum log level to `Debug` disclosed it; an attached object whose
  properties throw also defected the probe inside the formatter. The record now
  carries only the provider `code` and the `message`, and both the record and
  the `Unhealthy` verdict bound that message at 512 characters with control
  characters collapsed. A host that wants the raw failure taps
  `PingProvider.ping` with `Effect.tapError` and redacts it itself.

### Changed

- `RemoteSandbox` is now `RemoteChildProcessSpawner`, at
  `@smthrs/sandbox/RemoteChildProcessSpawner`. It was always a remote
  implementation of Effect's `ChildProcessSpawner`; it is now named like one,
  next to `NodeChildProcessSpawner`, `BunChildProcessSpawner`, and
  `BrowserChildProcessSpawner`. The identity strings follow the module path:
  the provider tag key is now
  `@smthrs/sandbox/RemoteChildProcessSpawner/Provider` and `ProviderError`'s
  `_tag` is `@smthrs/sandbox/RemoteChildProcessSpawner/ProviderError`. This
  contradicts the "every schema `_tag` is unchanged" note below on purpose: the
  package is pre-release, and a durable id that lies about where its module
  lives is worse than a break nobody has recorded runs against yet. The test
  double follows the module: `TestSandbox` / `TestSandboxProvider` /
  `TestSandboxState` are `TestRemote` / `TestRemoteProvider` /
  `TestRemoteState`. `SandboxHealth` and the package name are unchanged.
- `RemoteChildProcessSpawner`'s divergences from a local spawner — no stdin, no
  signals, no process identity, no pipeline routing between processes, no extra
  file descriptors, no custom shell or detached process — are now stated in the
  module header the way `BrowserChildProcessSpawner` states its own, rather than
  living only in the rejection messages. The header also names the two
  divergences that cannot be reported as a failure at all: `extendEnv` is
  ignored, because the remote session's ambient environment never crosses the
  seam, and `isRunning` turns `false` when a caller observes `exitCode` rather
  than when the remote process ends. `PlatformError.module` is
  `"ChildProcess"`, matching the sibling spawners.
- `RemoteChildProcessSpawner` now adapts a provider onto Effect's
  `ChildProcessSpawner` rather than the deleted `Shell` service. A provider
  hands back a started remote process in the same three pieces a child process
  has — `stdout`, `stderr`, `exitCode` — and `layer` (formerly `layerShell`)
  normalizes provider failures onto `PlatformError`. A remote process ends by
  closing its scope. Standard input and signals were declared unsupported here
  and are supported at rc.0: a provider that declares `stdin` receives the
  bytes and a provider that declares `kill` is asked to deliver the signal,
  while a provider that declares neither still gets the honest refusal rather
  than a silent drop.
- `RemoteChildProcessSpawner.layer` now applies output options and sinks,
  and rejects additional file descriptors, `stdin: "inherit"`, custom shell
  paths, detached processes, and non-default pipeline routing with
  `BadArgument` instead of changing or dropping their semantics. Command
  supplied stdin is rejected the same way for a provider that does not declare
  `stdin`.
- `ProviderError` carries its own closed `ProviderErrorCode` set (`aborted`,
  `timeout`, `unavailable`, `not_found`, `spawn_error`, `unknown`) instead of
  borrowing the shell's.
- The package now depends on `@smthrs/kernel` — for `CommandLine.render` alone —
  instead of `@smthrs/host`.
- Split remote execution and sandbox health into focused model, service,
  adapter, probe, and layer files without changing public imports.

### Added

- Split remote execution and `SandboxHealth` out of `@smthrs/host` into their
  own package. Every schema `_tag` was unchanged by that move: they are durable
  identity, not source location. The rename above is the one deliberate
  exception, taken while the package is pre-release.

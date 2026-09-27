# @smthrs/kernel

## [Unreleased]

### Added

- `FileSystem.confined(fileSystem, root)` returns a filesystem view whose every
  path operation is one descriptor-relative, no-follow request against `root`,
  pinned by canonical path and `device:inode` identity, without a grant check.
  Engine machinery uses it so its own writes cannot be redirected by a symlink
  swap. It refuses a plain path-based host with `PermissionDenied`, returns an
  isolated volume or the guarded `FileSystem.layer` service for the same root
  as it is, and refuses operations that are not one atomic request.
  `isConfinable` and `requireConfinable` check a host at composition time.
- `@smthrs/kernel/Rooted` binds unguarded `FileSystem`, `Path` and
  `ChildProcessSpawner` services to one root directory. `Rooted.spawner` keeps
  a contained spawner's containment mark. It replaces the TUI's private copy.

### Changed

- `ChildProcessSpawner.layer` and `Path.layer` now require `Workspace`. A
  command with no or a relative `cwd` runs in `Workspace.root`, and relative
  paths resolve there, instead of in `process.cwd()`. The grant check sees the
  resolved directory.

### Fixed

- `HttpClient.layer` forces `RequestInit { redirect: "manual" }` below its
  guard, so composing it over a plain `FetchHttpClient.layer`, which follows
  redirects by default, can no longer fetch a redirect target without a grant
  check.
- `JournalGrantStore` no longer tells an operator to compact a full policy
  journal. Replay never reads a checkpoint, so compaction broke every later
  construction; the message now says to start a new `policyRunId`.
- The internal `@slop` review markers no longer ship in the published
  declarations. Every export they marked already carries its prose.

## [1.0.0-rc.0] - 2026-08-31

### Changed

- **`HttpTransport` is gone; network access is Effect's own `HttpClient`**
  (maintainer directive, 2026-08-10). `@smthrs/kernel/HttpTransport` — the
  raw one-hop port — is deleted, and `HttpClient` is now middleware over
  `effect/unstable/http`'s `HttpClient` tag rather than a kernel-owned service
  projected off that port. The kernel declares no HTTP interface, no HTTP tag,
  and no `executeModel` method: it re-exports Effect's tag and `make`, and adds
  `layer`, a `TransportError`-reporting `makeNoop` / `layerNoop` stub, and the
  `toHttpClientError` / `fromHttpClientError` projection.
  - A `model:call` check is requested with the new `ModelCall` context
    reference, set by `HttpClient.withModelCall(modelId)` around the request,
    in place of the removed `executeModel` method.
  - Permission failures now ride in `HttpClientError`, the channel Effect's tag
    fixes: reason `TransportError`, `description` the one-line rendering, and
    `cause` the structured `PermissionRequired` / `PermissionDenied` /
    `GrantStoreError`. `HttpClient.fromHttpClientError` reads it back.
  - **Redirects.** The old port existed so a redirect could not bypass
    enforcement. The invariant is preserved with Effect alone: host bundles
    provide a client that never follows a redirect on its own (fetch with
    `RequestInit { redirect: "manual" }`, Undici with no redirect interceptor),
    and the decorator composes Effect's own `HttpClient.followRedirects`
    _above_ the guard, so each hop re-enters the guarded `postprocess` and is
    authorized independently.
  - `HostServices` slot 5 is now Effect's `HttpClient` tag and its
    `HostServiceIds` entry changes from `@smthrs/kernel/HttpTransport` to
    `effect/HttpClient`. **This changes step-key identity**: every cached step
    that named the network slot is invalidated, which is the intent.

- **One tag per protected service** (maintainer directive, 2026-08-10).
  Enforcement is now middleware over the service's _own_ tag —
  `Layer.effect(Tag, Effect.gen(function*() { const raw = yield* Tag; … }))`
  composed over the platform layer with `Layer.provide` — instead of a widened
  redeclaration of the interface behind a second tag plus an
  `as unknown as` cast to force the guarded implementation back onto the raw
  one. Those widened service-interface casts are gone; narrow casts remain for
  the atomic filesystem extension, process and journal identities, and
  validated immutable snapshots.
  - `FileSystem` and `ChildProcessSpawner` no longer export a kernel
    interface, tag, `make`, `makeNoop`, or `layerNoop` for the service itself;
    Effect's are the ones to use. `FileSystem` keeps `canonicalResource` and
    `layer`; `ChildProcessSpawner` keeps `layer` plus a `NotFound`-reporting
    `makeNoop` / `layerNoop` stub, and re-exports Effect's tag and `make`.
  - `Jj` no longer redeclares `@smthrs/jj`'s interface. It re-exports that
    package's tag, `make`, `makeNoop`, and `layerNoop`, and adds `layer`.
  - `HostServices` collapses to one closed list: `ProtectedHostService` and
    `ProtectedHostServiceTags` are gone. `HostServiceIds` is unchanged — the
    service identities did not change, only the plumbing.
- Permission failures on Effect-owned services are projected into the native
  `PlatformError` channel by the new `Permission.toPlatformError`: the reason
  is the normalized `PermissionDenied` system-error tag, `description` is the
  one-line rendering of the failure, and `cause` carries the structured
  `PermissionRequired` / `PermissionDenied` / `GrantStoreError`.
  `Permission.fromPlatformError` reads it back, so the attended surface and
  unattended reporting lose nothing.
- `Capability` and `Permission` moved to the new leaf package
  `@smthrs/capability` and are re-exported from the root barrel unchanged;
  only the deep imports move (`@smthrs/kernel/Capability` →
  `@smthrs/capability/Capability`, same for `Permission`). The split exists
  so `@smthrs/jj` can
  declare the permission failures its guarded interface adds without depending
  on the kernel that already depends on it. Every schema id is frozen and
  unchanged (`@smthrs/kernel/Capability`, `@smthrs/kernel/PermissionDenied`, …)
  because they round-trip through the grant journal.
- Attended suspension on a `Deferred`, unattended fail-fast, and terminal
  denial keep their existing `GrantStore` behavior.
- **HTTP capability resources now make non-`https` schemes explicit.** GET and
  HEAD use `net:get` and every other method uses `net:post`. An `https:` URL
  uses its lowercased host as the resource; every other scheme uses
  `<scheme>//<lowercased host>`. `model:call` follows the same rule before
  appending `/<model id>`, so a grant for an HTTPS host no longer admits a
  cleartext downgrade.
- **The 1,024-envelope ceiling now covers the construction envelope.**
  `GrantStore.make` refuses a new construction envelope, rather than persisting
  it, once the replayed signatures already fill the ceiling — the bound
  `grantEnvelope` has always applied at reply time. A durable history can
  therefore never outgrow what a later construction will replay.
  `JournalGrantStore` reports an already-grown history with a message naming
  the policy run and both signature counts, the way it already reports an
  oversized replayed rule set, instead of the bare
  `envelopeSignatures exceed 1024 entries`.

### Added

- Added `ContainedSpawner`, process middleware that applies the
  `SIGTERM`-then-`SIGKILL` deadline to every command and records each child in
  `ProcessLedger` until its spawn scope closes.
- Added `ProcessLedger` with durable and in-memory layers, the
  `SpawnedEventType`, `ExitedEventType`, `ReapedEventType`, and
  `SkippedEventType` wire constants, and replay of process records abandoned
  by a dead host incarnation.
- Added the atomic-host filesystem extension:
  `withAtomicFileSystem` installs a descriptor-relative, no-follow executor,
  `withIsolatedFileSystem` attests a whole isolated browser or test volume, and
  guarded filesystem operations fail closed when a host declares neither.
- Added `canonicalEnvelopePatterns` and `envelopeSignature` so envelope
  approvals have one deduplicated, order-independent durable identity.
- Added `CommandLine`, which renders an `effect/unstable/process` `Command` back
  to a POSIX command line. One renderer, two callers: the `proc:spawn`
  capability resource and the interpreter or remote sandbox that executes the
  line, so a grant and the thing it authorizes cannot drift apart. `shell: true`
  keeps shell syntax verbatim, while a custom shell path is named explicitly in
  the rendered invocation and therefore in the permission resource.
- Added `ChildProcessSpawner`, the permission decorator over Effect's own
  spawner. The check is suspended inside `spawn`, so building a `Command` or a
  stream neither asks permission nor starts a process; the derived helpers
  (`exitCode`, `string`, `lines`, `stream*`) are rebuilt from the guarded
  `spawn` so none can route around it; and `layer` double-publishes onto
  Effect's tag, so a `Command` run as a plain `Effect` is checked too.
- Absorbed the dissolved `@smthrs/host`: `HostError`, the
  closed `HostServices` list, the shared contract suite (now
  `@smthrs/kernel/test/contract`), and the deterministic `TestHost` bundle
  (`@smthrs/kernel/test/TestHost`, Node-only) live here.

### Fixed

- A spawn whose ledger record fails is now signalled and removed from
  `ProcessLedger.live` before the failed spawn returns.
- `withIsolatedFileSystem` refuses a filesystem that already carries a
  descriptor-relative executor instead of silently replacing it with a
  path-delegating one.
- Replayed remembered rules are deduplicated, and a policy journal past the
  1,024-rule ceiling now fails with the policy run id and the configured,
  replayed, and total rule counts.
- Made capability sets, grant inputs/results, Host request descriptions, and
  byte buffers immutable snapshots rather than aliases to caller-owned state.
- Added finite GrantStore policy, envelope, pending-request, metadata, event,
  and identity limits with field-specific typed failures.
- Added complete Host conformance matrices, observable child liveness, exact
  refused-operation codes, and clean packed-consumer coverage for the public
  test contract.

### Removed

- Removed the `Pty` decorator, and with it the `flows/host/Pty` slot from the
  closed list, `PtyError` from `HostError`, and the `@smthrs/pty` package from
  the workspace. The contract had no production consumer and its Node
  implementation was piped stdio, not a pseudo-terminal. Interactive-terminal
  support belongs to a higher-level harness extension, not the closed Host
  surface — see D13 in `docs/pages/design-decisions.md` and
  `docs/specs/Concepts/No Pty In Core.md`.
- Removed the `Shell` decorator and the raw `Shell` port. Process execution is
  `effect/unstable/process`; the closed list's third slot now holds Effect's own
  tag and its id is `effect/process/ChildProcessSpawner`. That id change is
  deliberate and invalidates cached steps that ran a command: the service
  really is different, so the step really is different.
- Removed `ShellError`, `ShellErrorCode`, and `shellError` from `HostError`. A
  spawn fails with `PlatformError`, like the rest of `effect`'s platform
  surface.

## [0.1.0] - 2026-08-05

### Added

- Added the effect-aware capability model, monotone attenuation, journaled grant store, and mandatory decoration of the original Host and Effect service tags.
- Added tier-preserving grant validation, canonical filesystem confinement, single-hop HTTP transport enforcement, browser-bundle coverage, and dual ESM/CJS package artifacts.

### Fixed

- Switched Host integration to its current public service subpaths and made the browser root entrypoint Node-free.
- Corrected configured-policy last-match-wins evaluation, journaled one-call grants, and resumed every pending waiter covered by run grants.
- Added plan-digest-bound run and remembered envelopes, same-run grant replay, trusted journal envelope validation, and duplicate-free resume.
- Preserved grant-store lifecycle failures in the typed stable-code channel and emitted identity-safe non-bundled CJS modules.

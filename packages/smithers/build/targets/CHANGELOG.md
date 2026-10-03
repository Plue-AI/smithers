# @smthrs/targets

The package is private and versioned at `0.1.0`; every `@since` tag in `src/`
reads `0.1.0` for that reason. Entries below are the unreleased changes on top
of it.

## [Unreleased]

### Added

- Added `LlmLint.CredentialDelivery`, the schema of the document a review host
  writes to a private credential rotation receiver: the reviewed revision and
  each discovery's file, line and name, with no other fields (plue#730).
- Added `issueViews` to `Smithers.Factory` and its projection: saved issue
  views (`id`, `title`, optional `state` and `labels`) that the app, TUI, CLI
  and API list and apply to a repository's issue list (#2269).
- `GithubCiGen` accepts optional `concurrency: "ref" | "commit"`; `commit`
  groups drift checks by commit without cancelling earlier runs (#2484).

- Added `reviewerAgents` to `Smithers.Github.Policy` and its projection.
  Only the named agent accounts' LGTMs count toward a protected bookmark's
  required agent LGTM.
- Added `agentIssueSources` to `Smithers.Github.Policy` and its projection.
  An issue an agent source (`run`, `linear`, `trial`) files starts
  credentialed work without a maintainer's trigger label only when its source
  is listed.
- Added `Input.listOutputFiles` for bounded, confined output inventories without
  source ignore or package-boundary filters.
- Added the `SecurityReview` macro (`@smthrs/targets/SecurityReview`, also
  `Smithers.SecurityReview`): declared security checks become a `security`
  review of changed files and a manual `securityAudit` of every included file.
- Added `Target.Options.manual` and the resolved `Target.Metadata.manual`. A
  manual target is skipped by bare wildcards and selected by label or named
  subtree pattern. Code that builds a `Metadata` object by hand must now set
  `manual`.
- Added `scope` (`changed` by default, or `all`) and `manual` (false by
  default) to the `LlmLint` attrs.

- Added `Target.guard`, so a rule that refuses something its schema cannot
  express keeps its `id`, `attrs` schema, and `kinds` instead of erasing them
  behind a hand-written `Target.AnyTarget` wrapper. Every catalog rule now
  exports one shape.
- Added `Input.rootRelative`, the single renderer for a workspace-rooted `//`
  path under a target's own `cwd`, replacing four copies of a helper that
  resolved such a path against the wrong directory whenever `cwd` was not the
  workspace root.
- Added closed failure codes to `Exec.ExecError` (`invalid_payload`,
  `spawn_failed`, `timed_out`, `signaled`, `stream_failed`,
  `secret_proxy_failed`, `exit_status`) and promoted the terminating signal to
  its own field.
- Added a `reason` code to `GeneratedFile.DriftError` (`missing`, `drifted`,
  `unreadable`), so a permissions failure or a symbolic link standing where a
  generated file belongs no longer reads as "regenerate this file".
- Added `packages/targets/docs/` and `scripts/docs.mjs`, which generates the
  catalog inventory from the `Target.make` declarations in `src/`, plus the
  `docsPages` target that writes and drift-checks it.
- Added `CiToolchain.Postgres({ release: "18" })` and the `postgres` toolchain
  field, so a generated job puts the PostgreSQL server binaries on `PATH`: PGDG
  on Linux, Homebrew on macOS, and the image's own server on Windows when it is
  at least `postgresFloor` (17).
- Added `GithubCiGen`'s `cacheWriteEnvironment`, the GitHub deployment
  environment every cache-publishing job names. It is required with
  `cacheWriteTokenSecret`, so a workflow that declared only the secret now
  fails to generate until it names the environment.
- Added `protectedPaths` to `Github.Policy`: paths, beyond the built-in trust
  roots, that a change started from an outsider's issue never touches. The
  decoded `GithubPolicy` now always carries `protectedPaths` (default `[]`),
  so a hand-built `GithubPolicy` value must add the field; policies made with
  `Github.Policy(...)` and `FACTORY.ts` declarations need no change.

### Fixed

- A bubblewrap-confined target that execs a package manager installed outside
  every grant (pnpm under `pnpm/action-setup`) no longer dies with
  `bwrap: execvp pnpm`: the program is resolved on the tool `PATH`, run by its
  real file, and its package directory is bound read-only (#3140).
- The secret-destination proxy path now seeds its request boundary with the
  resolved URL, its origin, and its request target, so an upstream that echoes
  the request back cannot hand the credential to the child.
- A secret containing a space or a character above U+00FF is percent-encoded
  into the request target, and a request target or header the HTTP client
  refuses answers 502 naming the declaration instead of raising an uncaught
  exception that ended the whole build process.
- `Cargo.manifestFacts` refuses `__proto__`, `constructor`, and `prototype` as
  metadata table keys and builds every parsed table with a null prototype, so a
  manifest under `vendor/` can no longer mutate `Object.prototype`.
  `Cargo.metadataMatches` matches own properties only and is depth bounded.
- `Cargo.Clippy` and `Cargo.Test` refuse a build-system key passed without a
  crate selector instead of silently dropping it and constructing the BUILD-era
  check with invented defaults.
- Target attrs are snapshotted before the schema reads them, so a `Proxy` is
  refused before it springs a trap and an accessor is refused rather than
  invoked twice. The decoded attrs, the metadata record, and every collection it
  exposes are frozen.
- `Target.collect` rejects a non-data property instead of silently abandoning
  every remaining key, which used to drop declared inputs from key material.
- `VitestCoverage` declares and captures its report directory, so a zero-exit
  run that wrote no report fails instead of reporting success.
- `Docker.Build` and `Docker.Bake` derive collision-resistant output paths, so
  two image builds in one package no longer name one output.
- `DepsLint` names its generated Knip configuration with a full SHA-256, ending
  a real 32-bit collision between two ordinary ignore lists.
- `PackageManager.dlx` spawns the declared Bun `executable` rather than a
  hard-coded `bunx`.
- `Generate` check mode restores file type, permissions, and symlink targets,
  and opens the restore target `O_NOFOLLOW`, so a generator that substitutes a
  symbolic link for a declared output can no longer redirect the restore onto a
  file outside the declared tree.
- `CiToolchain` validates an executable path with its own shape, which refuses
  glob metacharacters and a leading dash, and `GithubCiGen` shell-quotes it in
  the workflow it generates.
- `Dev` refuses a `readyWhen` marker rather than accepting one, keying on it,
  and never observing it.
- `Agent.targetIdentity` no longer digests `implementationDigest`, which carried
  per-process entropy and made the agent verdict cache unable to hit across
  processes.
- `Workspace` reports a caller who passed the options object first as its own
  failure, and bounds a rejected name before rendering it.
- `Outward`'s module documentation no longer promises an environment check its
  own `refuse` states it does not perform; `Invocation.environment` is optional
  and documented as never read.

### Changed

- Bun suites can opt into `--isolate` with `testSuite(paths, { isolate: true })`
  for files that mutate process globals; defaults and Node argv stay unchanged.
  This temporary option costs about 3× wall time and is removed after #3696
  lands and no callers remain.

- The `check` script typechecks with `--noEmit` instead of emitting an
  undeclared `dist` tree, and the manifest no longer carries a `publishConfig`
  export map describing a distribution no target produces.

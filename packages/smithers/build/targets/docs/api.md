---
title: "API reference"
description: "The module surface of @smthrs/targets: how a target is constructed, what a declaration may say about inputs, outputs, and secrets, and which module owns which contract."
---

This page is the tour of the module surface: what each layer is for, and which
module owns which contract. For the export-by-export listing, with signatures
and defaults read from source, see
[the `@smthrs/targets` package reference](./reference/targets.md).

`@smthrs/targets` is the authoring surface a `PACKAGE.ts` or `WORKSPACE.ts`
file writes against. Nothing here reads the filesystem or starts a process. A
target call validates its attrs, records its declared inputs and dependencies,
and returns an opaque `Target` declaration with planner metadata. The package executor in
[`@smthrs/build-cli`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build/build-cli)
executes targets. A host-owned Flow can explicitly lower an action-backed
declaration with `Target.plan(target)`.

## Construction

`Target.make(id, options)` is the one constructor. It returns a `Definition`:
callable with attrs, and carrying `id`, the `attrs` schema, and the `kinds` it
participates in. Every catalog rule is a `Definition`, including the ones that
refuse something the schema cannot express; those are wrapped with
`Target.guard`, which runs the refusal first and keeps the definition's shape.

`success` and `error` schemas constrain the implementation node's result and
failure types. A mismatched implementation is a type error. When a schema is
omitted, that channel is inferred from the implementation and accepts unknown
values at runtime; supply schemas when results need runtime validation.
`Target.plan` preserves those channels and the node's service requirements.
`Shell.Build`, `Shell.Test`, `Shell.Run`, and `Shell.Diff` declare `Exec.Result`
and `Exec.ExecError`. `ToolRun` uses the same schemas; `ToolBuild` declares
`ToolBuild.Outputs` and `ToolBuild.BuildError` because it captures output files.
Catalog stubs infer a `never` success and `Target.NotImplemented` failure.

A declaration is read exactly once, as data. The author's object is snapshotted
before the schema sees it: a `Proxy` is refused, an accessor is refused by name,
and a value carrying a prototype of its own is refused before the schema decodes
it. Attrs therefore hold primitives, plain objects, and plain arrays. Two handles
are the exceptions, kept by identity rather than copied: a target, and a
dependency selector. A `Date`, a `Map`, or a class instance is refused even when
the rule's schema would accept an unknown value, so encode such a value as plain
data. Nesting is bounded by `Target.maximumAttrsDepth` members deep and
`Target.maximumAttrsMembers` members in total. Everything the target then owns is
frozen, so `Target.metadata(target)` and each `forKind` view cannot be edited
after the checks that validated them.

`Target.metadata` is the planner's view: the rule id, the schema identity, the
decoded attrs, the declared inputs, the dependency targets and selectors, the
declared output tree, and the verbs. `implementationDigest` is also there. It
hashes the source text of every callback the declaration passes in, so two
processes evaluating one definition agree on it; a callback built with
`Node.capture` folds in its captured values as well. It is not a complete
implementation identity: an ordinary closure hides the values it closes over,
and helpers the callback calls are never hashed. Key a cache on the ambient
source fingerprint instead, which is what the package executor and the agent
verdict cache do.

## Declared inputs and outputs

`Input` declares what a target reads: `file`, `glob`, `gitDiff`, and
`pnpmWorkspace`. `Input.resolvePath` resolves one declaration against its
package directory, and `Input.rootRelative` renders a workspace-rooted `//`
path for a child running under a target's own `cwd`. A rule that renders a
declared path into argv uses the second one; stripping the `//` alone resolves
the path against the wrong directory whenever `cwd` is not the workspace root.

`EsLint`, `BiomeCheck`, and `Dprint` render configuration paths this way. For
example, `//eslint.config.js` becomes `../../eslint.config.js` under
`cwd: "packages/foo"`. ESLint also renders source files and glob patterns.
Biome renders source files and each glob's static directory prefix;
`//**/*.ts` selects the workspace root. Paths without `//` remain relative to
`cwd`. Declared inputs retain their original paths for keying.

`DeclaredOutputs` is the complete tree a target promises one execution
produces. It is target metadata, not something read back out of an action
payload: an untrusted cache entry never chooses which paths are verified.
`ToolBuild.captureOutputs` digests them, and a tool that exits zero without
producing a declared output fails the target.

## Execution boundaries

`Exec` is the sealed action every tool run goes through. Its failures carry a
closed `code` (`invalid_payload`, `spawn_failed`, `timed_out`, `signaled`,
`stream_failed`, `secret_proxy_failed`, `exit_status`) and, for a signalled
child, the `signal` itself, so a caller decides what to do without parsing
stderr. Timeout errors retain the bounded stderr tail followed by the timeout
explanation.

`Exec.Payload.timeoutMs` defaults to 600,000 ms and accepts integer deadlines
from 1 through 86,400,000 ms. Set it to `"unbounded"` for a process whose lifetime
is governed by interruption. `Dev` plans this unbounded policy; ordinary exec
calls retain the bounded default. Both policies kill the process group on
interruption. A clean process exit completes the action.

Sandbox scratch cleanup covers preparation, execution, and interruption,
including failures while creating declared write directories or wrapping argv.
Docker wrappers return a unique `containerName` and pass it as `--name`.
`Exec.run` registers `docker rm --force <name>` before starting the client,
including failed or interrupted startup. Removal runs after client shutdown and
before scratch deletion on success, timeout, or interruption. The removal attempt
has a five-second timeout and preserves the original exec result if Docker is
unavailable or the container was already removed by `--rm`.

`Exec.cacheDirectoryToken` in argv resolves to the absolute host cache directory
immediately before spawn, after workspace confinement checks. Its path is
independent of the child `cwd`. Append cache filenames directly to the token;
do not prepend a relative path from the working directory. `DepsLint` uses
this token for both writing its generated knip config and passing `--config`.

`SecretProxy.upstreamTimeoutMs` bounds each proxy-owned upstream HTTP request
with a two-minute elapsed deadline from sending the request through receiving
its complete response body, plus a socket idle timer of the same duration.
The same deadline bounds a CONNECT tunnel waiting for its destination to
complete the TCP handshake; a destination that never answers settles the
child with HTTP 502 instead of holding it until the operating system gives
up. Timeouts and truncated responses discard buffered bytes and settle the
child with HTTP 502, or close its response if headers were already sent.
Transport failures include a redacted error code when available; timeout
failures say `timed out`. Raw upstream error messages are never returned.

`ExecSandbox` anchors write grants at the canonical workspace root. A write
with a symbolic link in any component below that root is refused, including
internal and dangling links and missing outputs below linked ancestors. File
outputs are checked before granting their parent directory. `Exec` revalidates
grants before creating output directories; each sandbox renderer revalidates
before emitting its mounts or profile. The workspace must remain stable until
the operating system consumes those paths.

Native sandbox reads start from an allowlist: declared inputs (including their
resolved symlink targets), declared write directories, private temporary
storage, and enumerated system and runtime paths. Linux uses an empty
bubblewrap root; macOS denies host file reads before adding grants. Both
supply a private `HOME`. Credential locations in the real home (`.aws`, `.ssh`,
`.gnupg`, `.azure`, `.kube`, `.docker`, `.config/gcloud`, `.config/gh`, `.npmrc`,
`.netrc`, `.git-credentials`) are masked under broader grants. Explicit
`externalReads` can admit individual host files, including credentials.

The runtime set includes `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/nix/store`,
`/opt/homebrew`, macOS system libraries, dyld caches and developer tools, and
specific loader, TLS, DNS and timezone configuration files. Resolved Node/Bun
executables, their sibling `lib/node_modules`, and the default Corepack binary
cache are readable when present. Other host toolchains, caches and configuration
require `externalReads`; changing `PATH`, `COREPACK_HOME` or another environment
variable does not grant filesystem access.

`SafeFs` is the confined filesystem seam: no-follow reads, bounded sizes, and
one meaning for absent. Directory listings recheck workspace confinement and
device/inode identity after enumeration, refusing entries if the directory was
replaced. `GeneratedFile` writes and drift-checks a generated
file; its `DriftError` carries a `reason` of `missing`, `drifted`, or
`unreadable`, because only the first two are answered by regenerating.

`Secret` declares which environment variable holds a value and which origins may
receive it. `SecretProxy` is the execution half: it mints the placeholder a
child receives and substitutes the real value at the transport boundary, never
in argv or env. A value written into a request target is percent-encoded, and
every value the boundary resolved, plus a brokered destination URL, its origin,
and its request target, is rewritten back out of the response before the child
sees it.

`Outward` is the shared refusal gate for the five rules that push bytes to
somebody else's machine. It reads declarations only: a required credential the
declaration never names is refused here, and a variable that is declared but
unset is refused later, at the transport boundary. No outward rule has a
transport yet, so the package planner refuses each one before this gate runs.

## Workspace toolchains

Authors normally use `Runtime.Node`, `Runtime.Bun`, and `PackageManager.Pnpm`.
The package executor resolves manifest declarations before filling omitted
target attrs, and preserves explicit target overrides. `Runtime.Node({ manifest })`
reads `engines.node`; `PackageManager.Pnpm({ manifest, lockfile })` reads
`packageManager: "pnpm@<version>"`. An explicit manager `version` overrides that
field while the manifest is still parsed and digested. Requirements use exact
versions or a single comparator; unsupported compound ranges and tags refuse.

`Runtime.ResolvedNodeRuntime`, `Runtime.ResolvedBunRuntime`,
`PackageManager.ResolvedPnpmPackageManager`, and
`PackageManager.ResolvedBunPackageManager` are tagged schemas and types for the
resolver's output. They carry `name`, `version`, and `executable`; manager values
also carry their `runtime`. The `Runtime.Runtime` and
`PackageManager.PackageManager` unions admit these values alongside the classic
records. `Runtime.VersionRequirement` bounds printable requirement text; the
resolver and execution services validate the supported version grammar.

Action-backed targets verify their declared tools before executing the body.
Native `Runtime.bin` references and `PackageManager.bin` references with a
resolved Node/Bun toolchain select and verify the declared executable. This
does not change the existing Yarn lowering limit or
force arbitrary custom package-manager launchers to use a particular shebang
interpreter.

`Runtime.npx(spec)` is a command reference for a `Shell` or `Generate` `bin`:
Node runs npm's resolved JavaScript one-shot launcher with the selected interpreter;
Bun runs `x --bun`. Both forward the spec and user arguments. It cannot be used
as a path argument or a path-only tool binding. The Node route keys the selected
runtime, launcher bytes, and its bounded `--version` probe through that same
runtime. A changed reported implementation version invalidates cached results
even when the launcher bytes stay the same. See the
[runtime reference](./reference/targets.md#smithersruntime) for flags, keying,
and launcher constraints.

## Composition

`Compose` holds the rules that are about other rules: `Generate` (check by
default, `--write` applies, and check mode restores the declared write set
including file type and permissions), `Suite`, `Alias`, `Materialize`, and
`Files.Test`. `PackageDefaults` applies a function you provide to matching
package directories. Keep shared package conventions in your repository.

`Compose.checkGenerator` and `Compose.GenerateCheckLive` back up declared outputs
outside the workspace before running the generator. Copies use eight workers,
64 KiB buffers, a 256 MiB per-file ceiling, and a 1 GiB aggregate ceiling.
`snapshotLimits.fileBytes` and `snapshotLimits.totalBytes` accept non-negative
integers up to those ceilings. Exceeding a ceiling fails before the generator
runs. Text drift previews are limited to 64 KiB per file; larger files still
compare their full contents by digest.

Rollback repairs declared directories replaced by files or symlinks before
restoring descendants. It never follows a substituted symlink. Successful
restoration removes the scratch tree, including after generator failure or
cancellation. Failed restoration retains it and reports its absolute path in
the error. The retained `files/` tree contains original regular-file bytes;
`manifest.json` records workspace paths, file types, permissions, and link
targets for recovery. Undeclared ancestors remain outside the repair contract.

`BunSuite` runs a Vitest suite under Bun with coverage disabled. `FaultSuite`
runs a separate fault-test suite. Both accept file and configuration overrides;
your Vitest configuration controls test scheduling.

Use `LlmLint` with explicit instructions, files, model, and failure threshold.
Keep repository review rubrics and documentation paths in your own configuration.

`LlmLint.scope` selects what a review reads: `changed` (the default) reads the
included files that differ from `changes.base`, and `all` reads every included
file. `LlmLint.manual` keeps a review out of bare wildcard selections; a label or
a named pattern such as `//pkg/...:name` still selects it.
[`SecurityReview`](./guides/security-review.md) builds both modes from one
declaration of a package's security checks.

`LlmLint.context` accepts workspace-relative reference globs, with an optional
`//` prefix. Execution expands them across nested `PACKAGE.ts` boundaries and
reads them into every batch, whether or not they changed. Workspace confinement,
ignore rules, and symlink rejection still apply. A nonempty context declaration
that matches no files fails with a `read` diagnostic; individual unmatched globs
are allowed when another glob supplies context. Use `context: []` for a review
without references. Context is limited to 512 files, 1 MiB per file, and 2 MiB
in total. Select specific reference pages or sections instead of an entire
documentation site.

The emitted Vitest target carries `exclusive: true`, so wildcard `ci` and
`test` selections omit it regardless of its exported key. Select the matrix
explicitly with `smithers-build test '//packages/...:faults' --jobs 1`, or opt
a wildcard into all tiers with `--include-exclusive`. The executor drains ready
ordinary work first and runs each exclusive target alone, even with a larger
`--jobs` value. Dependencies keep their ordering. This isolates targets within
one invocation; independent invocations still need separate machines or external
coordination. A wildcard whose ordinary target depends on an exclusive target
refuses with an opt-in diagnostic instead of silently adding the fault suite.

- [Catalog rules](./rules.md), the inventory of every rule with its verbs,
  caching, and route.
- [Filegroup](./reference/filegroup.md) and
  [Agent.Diff](./reference/agent-diff.md), two rules documented in full.

## Cargo tool edges

`Cargo.Build({ bins: ["tool"] })` can supply the `bin` of a `Shell.Run` target.
The executable is under `target/debug/` by default. An explicit Cargo `target`
places it under `target/<target>/debug/`; `profile: "release"` uses `release/`,
`profile: "test"` also uses `debug/`, `profile: "bench"` uses `release/`, other
profile names use their own directory, and Windows targets add `.exe`.

## Shell selector migration

Shell text is declared with `Shell.Test({ shell: "node --version" })`. For direct
argv execution, use `Shell.Test({ bin: Smithers.Runtime.bin, args: ["--version"] })`.
The old `command` selector is removed. Select exactly one of `shell`, `bin`,
`script`, or `bun`. Shell text and Bun templates reject `args` and `runtimeArgs`;
`using` belongs only to Bun templates, and scripts reject `runtimeArgs`. These
combinations are checked by the declaration schemas and constructor types.

Targets are opaque declarations. Execute them through the package executor, or
explicitly lower an action-backed declaration with `Target.plan(target)` inside
a host-owned Flow. Package-only catalog rules lower to a typed refusal there.

Shell execution accepts `timeout` as an integer followed by `ms`, `s`, `m`, or
`h`. `Target.plan(Shell.Test({ shell: "true", timeout: "30s" }))` records
`timeoutMs: 30000` in the exec payload. Omitting `timeout` uses
`Shell.packageExecTimeoutMs` (30 minutes), matching the package executor.

---
title: "API reference"
description: "Every module and every public export of @smthrs/std: the flow modules, the six injectable services, their implementations, the search contract, the registries, and the error type."
sidebar:
  order: 1
---

The package exports 32 modules. Each is reachable from the root entry point as a
namespace and from its own subpath:

```ts
import { Read } from "@smthrs/std"
import * as Read from "@smthrs/std/Read"
```

`@smthrs/std/internal/*` and `@smthrs/std/<Module>/index` are not public.

Host child processes receive only `PATH`, `HOME`, `USER`, `LANG`, `LC_*`,
`TERM`, `TMPDIR`, and `SHELL` from the Smithers process, plus names explicitly
declared by the caller. Credential-shaped ambient names are withheld; an
explicit declaration is applied last and therefore opts that name in.

For the input and output fields of each flow, see the
[Flow reference](./reference/flows.md). This page is the module and export
surface.

## Example

```ts
import { NodeServices } from "@effect/platform-node"
import * as Read from "@smthrs/std/Read"

const page = await Effect.runPromise(
  Effect.provide(Read.run({ path: "./README.md", limit: 20 }), NodeServices.layer)
)
console.log(page.content, page.totalLines, page.truncated)
```

## The flow modules

Seventeen modules declare a flow. Every one of them exports the same names:

| Export         | Type                                     | Meaning                                  |
| -------------- | ---------------------------------------- | ---------------------------------------- |
| `name`         | string literal                           | The registry name.                       |
| `description`  | string                                   | The one line the model sees.             |
| `Input`        | `Schema` and the decoded type            | The input schema.                        |
| `Output`       | `Schema` and the decoded type            | The output schema.                       |
| `effects`      | `Effects.Declaration`                    | The declared envelope, before any input. |
| `effectsFor`   | `(input) => Effects.Declaration`         | The envelope narrowed to one input.      |
| `capabilities` | `ReadonlyArray<string>`                  | `action:resource` strings.               |
| `flow`         | `Flow`                                   | The declaration, built by `Flow.make`.   |
| `run`          | `(input) => Effect<Output, StdError, R>` | The handler.                             |

The modules are `ApplyPatch`, `Bash`, `Edit`, `Explore`, `Fetch`, `Glob`,
`Grep`, `HttpPost`, `Ls`, `Lsp`, `Read`, `ShellCommand`, `TestRun`,
`UpdatePlan`, `WebFetch`, `WebSearch`, and `Write`.

Some of them export more than the common nine:

| Module         | Additional exports                                                                          |
| -------------- | ------------------------------------------------------------------------------------------- |
| `Bash`         | `DEFAULT_TIMEOUT_MS`                                                                        |
| `Explore`      | `make(options: { model?: string })`, and no `run`                                           |
| `Grep`         | `ContextLine`, `Symbol`, `Match` schemas                                                    |
| `Read`         | `MAX_READ_FILE_BYTES`, the 64 MiB bound past which `read` refuses a file                    |
| `ShellCommand` | `DEFAULT_TIMEOUT_MS`, `MAX_CAPTURE_BYTES`, `DEFAULT_MAX_OUTPUT_TOKENS`, `TIMEOUT_EXIT_CODE` |
| `TestRun`      | `scratchDirectory`, `DEFAULT_TIMEOUT_MS`, `MAX_CAPTURE_BYTES`, `Outcome`                    |
| `UpdatePlan`   | `StepStatus`, `Plan`                                                                        |
| `WebSearch`    | the `WebSearch` service, `make`, `makeNoop`, `layerNoop`                                    |

## Manifest

The whole library keyed by registry name. Every registry is frozen.

| Export       | Type                                 | Meaning                                    |
| ------------ | ------------------------------------ | ------------------------------------------ |
| `flows`      | record of name to declaration        | All 17 declarations.                       |
| `handlers`   | record of name to handler            | The 16 that have one; `explore` is absent. |
| `effectsFor` | record of name to narrowing function | All 17, including `explore`.               |
| `names`      | readonly tuple of 17 names           | Registry order.                            |
| `readOnly`   | readonly tuple of 8 names            | The read-only projection.                  |

```ts
import * as Manifest from "@smthrs/std/Manifest"

Manifest.names // ["read", "write", "edit", "ls", "glob", "grep", "bash", ...]
Manifest.readOnly // ["read", "ls", "glob", "grep", "fetch", "explore", "webfetch", "lsp"]
```

## StdError

The single typed failure every handler uses.

| Export     | Type                                    | Meaning                                                                                 |
| ---------- | --------------------------------------- | --------------------------------------------------------------------------------------- |
| `Code`     | `Schema.Literals` and the matching type | The closed list of failure codes.                                                       |
| `StdError` | `Schema.TaggedError` class              | `{ code, message, path?, method?, rpcError?, stderr? }`, tagged `@smthrs/std/StdError`. |

```ts
import * as StdError from "@smthrs/std/StdError"

const failure = new StdError.StdError({
  code: "not_found",
  message: "File not found: /workspace/missing.ts",
  path: "/workspace/missing.ts"
})
```

The codes are listed in the [Flow reference](./reference/flows.md#failures).

Every service key, error tag, and class identifier in this package is
`@smthrs/std/<Name>`, so `Effect.catchTag("@smthrs/std/StdError", ...)` catches
every handler failure.

## Probe

Telling an invalid probe from a failing check. A non-zero exit is a runner's
verdict about the code it ran, not about the command it was handed.

| Export             | Type                                                                                         | Meaning                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `key`              | `"invalidProbe"`                                                                             | The reserved output key a flow reports one under.                                           |
| `Reason`           | `Schema.Literals` and the matching type                                                      | `unknown-command`, `unknown-test`, `unknown-path`, `unknown-module`, `unknown-environment`. |
| `InvalidProbe`     | `Schema.Struct` and the matching type                                                        | `{ reason, evidence, message }`.                                                            |
| `Attribution`      | `{ to, executed?, invalidProbe? }`                                                           | What one result was attributed to: the tree, or one of the five.                            |
| `CONFIDENCE_FLOOR` | `0.7`                                                                                        | The confidence an attribution needs before it outranks the tree.                            |
| `MAX_OUTPUT_BYTES` | `32768`                                                                                      | The most output bytes one judgment carries, newest kept.                                    |
| `posix`            | `(exitCode: number) => InvalidProbe \| undefined`                                            | Reads the shell's own refusal, 126 and 127, from the exit code alone.                       |
| `probeAttribution` | `Classifier` `probe/attribution`                                                             | The classifier `classify` asks: `attribution` choice, `executed` boolean.                   |
| `classify`         | `(result: { command, exitCode, output }) => Effect<Attribution, ClassifierError, Evaluator>` | Attributes one command result, with Jev.                                                    |
| `unjudged`         | `(error: ClassifierError) => StdError`                                                       | The standard-flow failure a judge that did not answer is.                                   |

```ts
import * as Probe from "@smthrs/std/Probe"

Probe.posix(127)
// { reason: "unknown-command", evidence: "the command exited 127", message: "..." }

const attribution = yield * Probe.classify({ command: "pytest tests/x.py::nope", exitCode: 4, output })
// { to: "unknown-test", executed: false, invalidProbe: { reason: "unknown-test", ... } }
```

The attribution is Jev's: `classify` asks `probeAttribution`, the exported
`probe/attribution` declaration, through the `Evaluator` service of
[`@smthrs/model`](/api/model), so a host needs a bound evaluator on a
subscription seat. Two things are still decided without it, because an exit code is a
fact rather than prose: a zero exit is never classified, and 126 and 127 are
the shell's own refusal to start the command. An answer below
`CONFIDENCE_FLOOR` is the tree's failure, which leaves a genuine reproduction
intact. There is no third path: when the judge does not answer, `unjudged`
turns its failure into the caller's typed failure rather than a guess.

## Search

The implementation seam behind `grep` and `glob`.

| Export        | Type                                | Meaning                                                                      |
| ------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| `Search`      | interface and `Context.Service` tag | `{ grep, glob }`.                                                            |
| `make`        | `(service: Search) => Search`       | Builds a peer from its two operations.                                       |
| `makeNoop`    | `() => Search`                      | Fails both calls with `provider_unavailable`.                                |
| `layerNoop`   | `Layer<Search>`                     | Provides `makeNoop`.                                                         |
| `GrepInput`   | interface                           | Normalized grep input, with every option resolved.                           |
| `GrepOutput`  | interface                           | `matches`, `files`, `filesSearched`, `skippedBinary`, `truncated`, `notice`. |
| `GrepLine`    | interface                           | One row a peer produces before grouping: `file`, `line`, `text`, `kind`.     |
| `GrepMatch`   | interface                           | One hit with its `before`, `after`, and `symbol`.                            |
| `ContextLine` | interface                           | `line`, `text`.                                                              |
| `Symbol`      | interface                           | `kind`, `name`, `startLine`, `endLine`.                                      |
| `GlobInput`   | interface                           | `pattern`, `root`, `hidden`, `limit`.                                        |
| `GlobOutput`  | interface                           | `paths`, `total`, `truncated`, `notice`.                                     |

Both operations return `Effect<_, StdError>` with no requirement, so a peer
resolves its own services when it is built.

## PortableSearch

The in-process peer. Walks the injected `FileSystem`, so it needs no external
binary and is browser-safe.

| Export  | Type                                                       |
| ------- | ---------------------------------------------------------- |
| `make`  | `(services: Context<FileSystem \| Path>) => Search.Search` |
| `layer` | `Layer<Search.Search, never, FileSystem \| Path>`          |

## NativeSearch

The peer that drives the `rg` executable through the permission-aware spawner.

| Export              | Type                                                                                                                              | Meaning                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `MAX_CAPTURE_BYTES` | `67_108_864`                                                                                                                      | Bytes captured from either `rg` stream before the call is refused. |
| `make`              | `(services: Context<FileSystem \| Path \| ChildProcessSpawner>, environment?: Readonly<Record<string, string>>) => Search.Search` |                                                                    |
| `layer`             | `Layer<Search.Search, never, FileSystem \| Path \| ChildProcessSpawner>`                                                          |                                                                    |

An overflow is `command_failed` rather than a truncation, because a partial
ripgrep stream could make this peer disagree with the portable one. A failure to
start `rg` is `provider_unavailable`. The default layer uses the host environment
allowlist. `make` accepts explicit environment declarations as its second
argument; those names override the allowlist.

## SearchContract

The validation and matching rules both peers build on, exported so a third peer
cannot drift on what a pattern means.

| Export                | Type                                                                                  | Meaning                                          |
| --------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `validatePattern`     | `(pattern: string, fixedStrings: boolean) => StdError \| undefined`                   | Checks Smithers Ripgrep ASCII v1.                |
| `validateGlob`        | `(glob: string) => StdError \| undefined`                                             | Checks the glob grammar.                         |
| `canonicalGlob`       | `(glob: string) => string`                                                            | The one spelling both peers match against.       |
| `matchesGlob`         | `(pattern: string, relative: string, basename: string) => boolean`                    | One glob against one candidate.                  |
| `includedByGlobs`     | `(globs: ReadonlyArray<string>, relative: string, basename: string) => boolean`       | Ordered include and exclude.                     |
| `expression`          | `(pattern: string, fixedStrings: boolean, insensitive: boolean) => RegExp`            | Compiles a validated pattern.                    |
| `unsatisfiableNotice` | `(options: { fileSystem, path, root, globs, hidden }) => Effect<string \| undefined>` | Explains globs no file under the root can match. |
| `isContractRejection` | `(error: StdError) => boolean`                                                        | Whether this contract wrote the rejection.       |

## SearchConformance

A differential kit that reports where two `Search` peers disagree.

| Export          | Type                                                                           | Meaning                                                                        |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `GeneratedFile` | interface                                                                      | `path` relative to the tree root, and `content`.                               |
| `Plan`          | interface                                                                      | `seed`, `root`, `files`, `grep`, `glob`.                                       |
| `Divergence`    | interface                                                                      | `call`, `input`, `subject`, `reference`.                                       |
| `plan`          | `(options: { seed, root, files?, calls? }) => Plan`                            | Builds a reproducible tree and call batch. Defaults are 12 files and 12 calls. |
| `materialize`   | `(plan: Plan) => Effect<void, never, FileSystem \| Path>`                      | Writes the tree.                                                               |
| `compare`       | `(options: { plan, subject, reference }) => Effect<ReadonlyArray<Divergence>>` | Runs every call through both peers.                                            |
| `report`        | `(divergences: ReadonlyArray<Divergence>) => string`                           | Renders them as a failing run's output.                                        |

## Container

The host's route into a named container, as an injected transport. Nothing here
spawns: it only decides an argv, which `bash` then spawns through the same
permission-aware spawner as everything else.

| Export         | Type                                                   | Meaning                                                                    |
| -------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `Container`    | interface and `Context.Service` tag                    | `{ exec: (request: Request) => Effect<Plan, StdError> }`.                  |
| `Request`      | interface                                              | `container`, `file`, `args`, `cwd?`, `env?`, `stdin`.                      |
| `Plan`         | interface                                              | `file`, `args`, `env?`: argv and environment overrides for the host spawn. |
| `make`         | `(service: Container) => Container`                    |                                                                            |
| `unavailable`  | `(container: string) => StdError`                      | The refusal a host with no route answers with.                             |
| `makeNoop`     | `() => Container`                                      | Fails every request with `unavailable`.                                    |
| `layerNoop`    | `Layer<Container>`                                     |                                                                            |
| `makeCommand`  | `(options?: { program?: string }) => Container`        | A `docker exec` compatible CLI. Defaults to `docker`.                      |
| `layerCommand` | `(options?: { program?: string }) => Layer<Container>` |                                                                            |

`makeCommand` attaches `-i` only when the payload arrives on standard input,
because a container CLI holding stdin open for a command that never reads it
makes that command hang. A container name that is empty or starts with `-` is
`invalid_input`, and so is an environment name that is not a POSIX shell name.
A requested variable never reaches the host transport process under its own
name, so `PATH`, `LD_PRELOAD`, or `DOCKER_HOST` cannot choose what runs on the
host: `Plan.env` carries each value as `SMITHERS_CONTAINER_ENV_KEY`, argv
carries only `-e SMITHERS_CONTAINER_ENV_KEY`, and an `sh -c` inside the
container renames it to `KEY` before `exec`ing the program. Custom transports
return any host process environment overrides in `Plan.env`.

## TreeFingerprint

The identity of one directory tree, measured where the tree is. The host's
workspace walk cannot see a container's filesystem, so `bash` runs this
script through the container transport before and after a containerised
command and reports whether the two answers differ under the reserved
`mutated` key. The harness reads `true` as a measured write, the way it reads
`invalidProbe` as a measured refusal.

| Export                  | Type                                                | Meaning                                                                                                                                        |
| ----------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`                   | `"mutated"`                                         | The reserved output key a flow reports a measured write under.                                                                                 |
| `defaultPrune`          | `ReadonlyArray<string>`                             | Directory names never descended into: every name the search walk skips, including both scratch checkout directories, plus `venv` and `target`. |
| `defaultIgnoreSuffixes` | `ReadonlyArray<string>`                             | Name suffixes left out, compiled output above all.                                                                                             |
| `maxPaths`              | `50000`                                             | The bound past which a listing is a prefix and reports `complete: false`.                                                                      |
| `Measurement`           | interface                                           | `{ digest, paths, complete }`.                                                                                                                 |
| `script`                | `(options?: { prune?, ignoreSuffixes? }) => string` | The POSIX shell script: sorted `find` + `stat -c` listing, `cksum`, count.                                                                     |
| `parse`                 | `(stdout: string) => Measurement \| undefined`      | Reads one measurement; anything malformed is unmeasured, never unchanged.                                                                      |
| `moved`                 | `(before?, after?) => boolean \| undefined`         | `true`/`false` from two complete measurements; `undefined` from anything less.                                                                 |

Identity, not content: size and mtime per file, so a rewrite that restores
both is invisible, exactly as it is to the host walk. Every tool the script
needs is POSIX or busybox; a container without one exits non-zero and `bash`
reports no `mutated` at all.

## TestRunner

How the project under test runs its suite, declared once by the host.

| Export        | Type                                    | Meaning                                                                     |
| ------------- | --------------------------------------- | --------------------------------------------------------------------------- |
| `captureBase` | `"refs/flows/capture-base"`             | The default ref naming the pristine tree.                                   |
| `Runner`      | interface                               | `command`, `cwd?`, `root?`, `container?`, `env?`, `baseRef?`, `timeoutMs?`. |
| `TestRunner`  | interface and `Context.Service` tag     | `{ declared: Effect<Runner, StdError> }`.                                   |
| `make`        | `(runner: Runner) => TestRunner`        |                                                                             |
| `makeNoop`    | `() => TestRunner`                      | Declares that this host knows of no runner.                                 |
| `layer`       | `(runner: Runner) => Layer<TestRunner>` |                                                                             |
| `layerNoop`   | `Layer<TestRunner>`                     |                                                                             |

## Checkpoints

Pinned trees, and the scratch checkouts a call runs against.

| Export             | Type                                                                       | Meaning                                                          |
| ------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `Checkpoints`      | interface and `Context.Service` tag                                        | `{ capture, materialize }`.                                      |
| `Snapshot`         | `Schema.Class`                                                             | `{ id, ref }`, identified as `@smthrs/std/Checkpoints/Snapshot`. |
| `Materialized`     | interface                                                                  | `id`, `host`, `guest`, `root`, `guestRoot`.                      |
| `baseId`           | `"base"`                                                                   | The id naming the tree the run opened on.                        |
| `scratchDirectory` | `".flows-checkpoints"`                                                     | Where a checkpoint is materialized, relative to the root.        |
| `configSection`    | `"flows-checkpoint"`                                                       | The git-config section minted checkpoints are recorded under.    |
| `make`             | `(service: Checkpoints) => Checkpoints`                                    |                                                                  |
| `unavailable`      | `(id: string) => StdError`                                                 | The refusal a host that pins nothing answers with.               |
| `makeNoop`         | `() => Checkpoints`                                                        | Fails both calls with `unavailable`.                             |
| `layerNoop`        | `Layer<Checkpoints>`                                                       |                                                                  |
| `GitOptions`       | interface                                                                  | `root`, `cwd?`, `baseRef?`.                                      |
| `makeGit`          | `(options: GitOptions) => Effect<Checkpoints, never, ChildProcessSpawner>` |                                                                  |
| `layerGit`         | `(options: GitOptions) => Layer<Checkpoints, never, ChildProcessSpawner>`  |                                                                  |
| `Relocation`       | tagged union                                                               | `Relocated`, `UnsupportedFlow`, `AbsolutePath`, `OutsideTree`.   |
| `relocate`         | `(flow: string, input: Json, materialized: Materialized) => Relocation`    | Rewrites one call's input onto a checkpoint.                     |

`capture(id)` returns a `Snapshot`. `materialize(id, use)` is scoped: it hands
the tree to `use` and removes the checkout however that effect ends. Host git
never runs with the workspace's `.git` as its `GIT_DIR`: it records and checks
out through a temporary shadow repository that shares only the workspace's
objects, with host config files switched off. A hook, `core.fsmonitor` command,
filter driver or `info/attributes` entry written into the workspace's `.git`
therefore does not run on the host. The workspace is still read for refs, its
index, its config file (as a file) and a few `core.*` hashing settings. A
checkout gets its own standalone `.git`, so a container can run git in it.

Two data-write residuals remain, neither of which runs a program. First, host
writes into agent-writable paths (new objects, the checkpoint's config entry,
the checkout directory) follow a symlink the agent races into place. The
directories and `.git` files a materialize prepares are created exclusively,
but the `git read-tree --reset -u` that then writes the checkpoint's files is
not: an agent that swaps the checkout directory, or a parent of it, for a
symlink between those two steps can have read-tree overwrite existing files in
the symlink's target with the checkpoint's contents. Second, the repository is
whatever `git rev-parse --git-common-dir` names: a `.git` gitfile
(`gitdir: <path>`) or an `objects/info/alternates` entry can point it at
another git directory on the host. Captures then write objects and the config
entry into that directory, a checkpoint id edited in `.git/config` can name a
commit from it, and read-tree resolves object ids across the alternate store,
so a materialize can write another host repository's files into the checkout.
Both residuals apply whenever the agent can write the workspace, including its
`.git` through a container bind mount; creating `.git` in the harness does not
help, because the agent can rewrite it afterwards. The only mitigation is a
`.git` and checkout path the agent cannot write, such as a read-only mount of
`.git`, or running captures and checkouts against a git directory the harness
keeps outside the mount.

## Relocate

What can be pointed at a checkpoint, and what cannot.

| Export       | Type                                                                    | Meaning                                                        |
| ------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| `Relocation` | tagged union                                                            | `Relocated`, `UnsupportedFlow`, `AbsolutePath`, `OutsideTree`. |
| `relocate`   | `(flow: string, input: Json, materialized: Materialized) => Relocation` | Rewrites one call's input onto a checkpoint.                   |

`relocate` knows the field each supported flow names a location in: `cwd` for
`bash`, `path` for `read` and `ls`, `root` for `grep` and `glob`. Every other
flow answers `UnsupportedFlow`. Both names are re-exported from `Checkpoints`,
which is how the harness reaches them.

## LanguageServer

The code-intelligence seam.

| Export           | Type                                          | Meaning                                                             |
| ---------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| `Position`       | interface                                     | `path`, `line`, `character`, in the protocol's 0-based coordinates. |
| `LanguageServer` | interface and `Context.Service` tag           | Ten methods, each returning `Effect<unknown, StdError>`.            |
| `make`           | `(service: LanguageServer) => LanguageServer` |                                                                     |
| `makeNoop`       | `() => LanguageServer`                        | Answers `unsupported` for every request.                            |
| `layerNoop`      | `Layer<LanguageServer>`                       |                                                                     |

The methods are `hover`, `definition`, `references`, `implementation`,
`documentSymbols`, `workspaceSymbols`, `prepareCallHierarchy`,
`callHierarchyIncoming`, `callHierarchyOutgoing`, and `diagnostics`.

## NodeLanguageServer

A host LSP client over the permission-checked process spawner, speaking framed
JSON-RPC on ordinary stdio pipes.

| Export                 | Type                                                                                 | Meaning                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `Config`               | interface                                                                            | `command`, `args?`, `cwd`, `environment?`, `initializationOptions?`, `timeoutMs?`. |
| `MAX_QUEUED_FRAMES`    | `256`                                                                                | Frames buffered for the server's standard input.                                   |
| `MAX_PENDING_REQUESTS` | `512`                                                                                | Concurrent in-flight requests.                                                     |
| `make`                 | `(config: Config) => Effect<LanguageServer, StdError, ChildProcessSpawner \| Scope>` |                                                                                    |
| `layer`                | `(config: Config) => Layer<LanguageServer, StdError, ChildProcessSpawner>`           |                                                                                    |

`make` sends `initialize` with `cwd` as the root URI and then `initialized`, so
the service is ready when it resolves. `timeoutMs` defaults to 30,000 and bounds
every request and every write. A frame body may be 8 MiB and its headers 8 KiB.
The child receives the host environment allowlist plus `Config.environment`.
`initializationOptions` is sent on `initialize` unchanged.

The server runs on the host as the host user. `make` fails with
`permission_denied`, before spawning, when the program it would execute lies
under `cwd`: a relative or absolute command there, a bare name found through a
`PATH` entry there, or a workspace symlink to a host binary. An argument, or
the value after `=` in one, that names an existing file under `cwd` is refused
the same way. A launcher is refused outright, because its arguments are code or
package names the file check cannot see: a shell (`sh -c`, `bash`, `zsh`),
`env`, a package runner (`npx`, `pnpm`, `npm`, `yarn`, `bunx`, `bun x`,
`deno`), or `node` and `bun` given inline code or a preload (`-e`, `--eval`,
`-p`, `-r`, `--require`, `--import`, `--loader`). Name the server's own host
binary, or an interpreter and a host script file. What the server loads after it starts is not checked: by default
typescript-language-server runs the workspace's `node_modules/typescript`,
tsserver with `--allowLocalPluginLoads` loads `tsconfig` plugins from the
project, and rust-analyzer runs build scripts and proc macros. Pin those to
host copies through `initializationOptions` or the server's own flags (for
typescript-language-server, `{ tsserver: { path: "<host>/tsserver.js" } }`),
or run the server in a sandbox.
Request failures include `method`. JSON-RPC refusals retain `rpcError` with the
server's numeric `code`, `message`, and optional `data`, bounded by the 8 MiB
frame limit. Failures attach the latest stderr tail when present, capturing at
most 64 KiB. On stdout closure or process exit, draining stderr gets a bounded
100 ms grace before pending requests fail.

## ExaWebSearch

A `WebSearch` provider backed by the Exa API.

| Export  | Type                                                                                    |
| ------- | --------------------------------------------------------------------------------------- |
| `layer` | `(credentialId: string) => Layer<WebSearch.WebSearch, never, Credential \| HttpClient>` |

The key is read from the named credential through
[`@smthrs/control`](/api/control) rather than from the environment. See
[Reach the network](./guides/reach-the-network.md#search-the-web) for the status
mapping.

## Runtime notes

The root entry point is Node-only: it re-exports `NodeLanguageServer`, which
imports `node:url`. The four browser-safe subpaths are `@smthrs/std/Grep`,
`@smthrs/std/Glob`, `@smthrs/std/Search`, and `@smthrs/std/PortableSearch`.
Nothing any of the four imports reaches a Node built-in.

The model behind this surface has its own pages:

- [Limits are disclosed, never silent](./concepts/limits-and-disclosure.md) for
  every cap and how it is reported.
- [Effects and capabilities](./concepts/effects-and-capabilities.md) for the
  declared envelopes, the narrowing, and why hermetic mode is a pre-check rather
  than a sandbox.

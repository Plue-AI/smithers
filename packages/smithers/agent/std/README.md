# @smthrs/std

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://std.smithers.sh

The standard flows tool library for filesystem, search, HTTP, shell, language-server, and Jev judgment work. Each callable tool is an ordinary `@smthrs/core` flow declaration with explicit capabilities and effects, plus an injectable handler where execution is host-owned.

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/std/<Module>`.

| Module               | Public exports                                                                                                                                                                                          | Description                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `ApplyPatch`         | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`, `activity`, `presentation`, `paths`                                                                   | Declares and applies a V4A patch.                                              |
| `Bash`               | `name`, `description`, `DEFAULT_TIMEOUT_MS`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`, `outsideContainer`, `sealed`, `presentation`                                    | Declares and runs bounded shell commands.                                      |
| `Checkpoints`        | `baseId`, `scratchDirectory`, `configSection`, `Snapshot`, `Materialized`, `Checkpoints`, `make`, `unavailable`, `makeNoop`, `layerNoop`, `GitOptions`, `makeGit`, `layerGit`, `Relocation`, `relocate` | Pins a working tree as a git checkpoint and materializes it again.             |
| `Container`          | `Request`, `Plan`, `Container`, `make`, `unavailable`, `makeNoop`, `layerNoop`, `makeCommand`, `layerCommand`                                                                                           | Routes a command into a named container.                                       |
| `Edit`               | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`, `activity`, `presentation`                                                                            | Declares and applies exact text replacements.                                  |
| `ExaWebSearch`       | `layer`                                                                                                                                                                                                 | Provides WebSearch through the Exa API and kernel HTTP client.                 |
| `Explore`            | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `make`, `flow`                                                                                                       | Declares a dynamic exploration flow composed from other standard flows.        |
| `Fetch`              | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`                                                                                                        | Declares and runs raw HTTP GET requests.                                       |
| `Glob`               | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`, `activity`, `presentation`                                                                            | Declares and runs filesystem glob searches.                                    |
| `Grep`               | `name`, `description`, `Input`, `ContextLine`, `Symbol`, `Match`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`, `activity`, `presentation`                                          | Declares and runs text searches over files.                                    |
| `HttpPost`           | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`                                                                                                        | Declares and runs HTTP POST requests.                                          |
| `LanguageServer`     | `Position`, `LanguageServer`, `make`, `makeNoop`, `layerNoop`                                                                                                                                           | Defines the language-server query service.                                     |
| `Ls`                 | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`, `activity`, `presentation`                                                                            | Declares and runs directory listings.                                          |
| `Lsp`                | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`                                                                                                        | Declares and runs ten language-server queries, from hover to diagnostics.      |
| `Manifest`           | `flows`, `handlers`, `effectsFor`, `names`, `readOnly`                                                                                                                                                  | Exposes frozen flow, handler, and narrowing registries plus the read-only set. |
| `NativeSearch`       | `MAX_CAPTURE_BYTES`, `make`, `layer`                                                                                                                                                                    | Implements Search through the ripgrep binary.                                  |
| `NodeLanguageServer` | `Config`, `MAX_QUEUED_FRAMES`, `MAX_PENDING_REQUESTS`, `make`, `makeLazy`, `layer`, `layerLazy`                                                                                                         | Implements LanguageServer with Node child processes, routed by extension.      |
| `PortableSearch`     | `make`, `layer`                                                                                                                                                                                         | Implements Search by walking the kernel filesystem in process.                 |
| `Probe`              | `key`, `Reason`, `InvalidProbe`, `Attribution`, `CONFIDENCE_FLOOR`, `MAX_OUTPUT_BYTES`, `posix`, `probeAttribution`, `classify`, `unjudged`                                                             | Attributes a non-zero exit to the command or to the tree, with Jev.            |
| `Read`               | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`, `activity`, `presentation`, `MAX_READ_FILE_BYTES`                                                     | Declares and runs bounded file reads.                                          |
| `Relocate`           | `Relocation`, `relocate`                                                                                                                                                                                | Rewrites a call's input so the call runs against a materialized checkpoint.    |
| `Search`             | `GrepInput`, `GrepLine`, `ContextLine`, `Symbol`, `GrepMatch`, `GrepOutput`, `GlobInput`, `GlobOutput`, `Search`, `make`, `makeNoop`, `layerNoop`                                                       | Defines the search service both peers implement.                               |
| `SearchConformance`  | `GeneratedFile`, `Plan`, `Divergence`, `plan`, `materialize`, `compare`, `report`                                                                                                                       | Generates a tree and calls, then reports where two Search peers disagree.      |
| `SearchContract`     | `validatePattern`, `validateGlob`, `canonicalGlob`, `matchesGlob`, `includedByGlobs`, `expression`, `unsatisfiableNotice`, `isContractRejection`                                                        | The shared matcher an external Search peer must build on.                      |
| `ShellCommand`       | `name`, `description`, `DEFAULT_TIMEOUT_MS`, `MAX_CAPTURE_BYTES`, `DEFAULT_MAX_OUTPUT_TOKENS`, `TIMEOUT_EXIT_CODE`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`           | Declares and runs a Codex-shaped shell command.                                |
| `StdError`           | `Code`, `StdError`                                                                                                                                                                                      | Defines typed standard-tool failures.                                          |
| `TestRun`            | `name`, `description`, `scratchDirectory`, `DEFAULT_TIMEOUT_MS`, `MAX_CAPTURE_BYTES`, `Input`, `Outcome`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`, `activity`, `presentation`  | Runs the declared test suite and reads its report.                             |
| `TreeFingerprint`    | `key`, `defaultPrune`, `defaultIgnoreSuffixes`, `maxPaths`, `Measurement`, `script`, `parse`, `moved`                                                                                                   | Measures a container's working directory so `bash` can report a write there.   |
| `TestRunner`         | `captureBase`, `Runner`, `TestRunner`, `make`, `makeNoop`, `layer`, `layerNoop`                                                                                                                         | Declares how the project under test runs its suite.                            |
| `UpdatePlan`         | `name`, `description`, `StepStatus`, `Plan`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`                                                                                  | Acknowledges a Codex plan update.                                              |
| `WebFetch`           | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`                                                                                                        | Declares and runs normalized web-page fetches.                                 |
| `WebSearch`          | `name`, `description`, `Input`, `Result`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `WebSearch`, `make`, `makeNoop`, `layerNoop`, `run`                                                | Declares web search and its injectable provider service.                       |
| `Write`              | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`, `activity`, `presentation`                                                                            | Declares and runs file writes.                                                 |

```ts
import { Read } from "@smthrs/std"
import { Effect } from "effect"

const program = Read.run({ path: "/workspace/notes.md" }).pipe(
  Effect.map((result) => result.content)
)
// Provide the kernel FileSystem and Path layers in the host.
```

`Read.content` preserves source-line bytes, including trailing `\r` in CRLF files, and omits the page's final `\n`. Copy it unchanged into an edit anchor and retain the `\r` bytes in replacement text to keep CRLF endings.

`Manifest.flows` is the declaration registry, `Manifest.handlers` contains directly executable handlers, `Manifest.effectsFor` narrows a declaration for one decoded input, and `Manifest.readOnly` is the canonical read-only projection. `@smthrs/std/package.json` is also exported; `internal/*` and nested `*/index` subpaths are blocked.

The root entry point is Node-only: `NodeLanguageServer` pulls in `node:url`. The four subpaths `@smthrs/std/Grep`, `@smthrs/std/Glob`, `@smthrs/std/Search` and `@smthrs/std/PortableSearch` are browser-safe, because nothing any of them imports reaches a Node built-in.

## Child process environment

Commands started by `bash`, `shell_command`, `test`, and the package's internal
process helpers do not inherit the full Smithers process environment. They
receive only `PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, and
`SHELL`, plus variables the caller explicitly declares. Credential-shaped
ambient names such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GH_TOKEN` are
withheld; an explicitly declared name is intentional and is delivered even
when its name looks sensitive.

## Limits

Every limit is a display budget disclosed to the caller, never a silent cut. A capped result says so in its own output: `truncated`, `<stream>Truncated`, or a `notice` line naming what was shown and what there was. Rows named by prose are fixed in the package and not exported; the rest are the constants named.

| Limit                                     | Value       | Applies to                                                      |
| ----------------------------------------- | ----------- | --------------------------------------------------------------- |
| Default `read` page                       | 2,000 lines | one `read` call with no `limit`                                 |
| Displayed line                            | 2,000       | one displayed line; a clipped line is not an edit anchor        |
| Entries per page                          | 1,000       | one `ls` or `glob` page                                         |
| Matches per call                          | 200         | one `grep` call                                                 |
| Rendered text payload                     | 60,000      | one rendered text payload (`fetch`, `http-post`, `webfetch`)    |
| Shell stream capture                      | 30,000      | each captured shell stream                                      |
| `Bash.DEFAULT_TIMEOUT_MS`                 | 600,000     | one `bash` call with no `timeoutMs`                             |
| `TestRun.DEFAULT_TIMEOUT_MS`              | 600,000     | one `test` call with no `timeoutMs`                             |
| `TestRun.MAX_CAPTURE_BYTES`               | 8,000,000   | the runner output one `test` call holds in memory               |
| `ShellCommand.DEFAULT_TIMEOUT_MS`         | 10,000      | one `shell_command` call with no `timeout_ms`                   |
| `ShellCommand.MAX_CAPTURE_BYTES`          | 8,000,000   | the command output one `shell_command` call holds in memory     |
| `NativeSearch.MAX_CAPTURE_BYTES`          | 64 MiB      | one `rg` invocation's captured output, refused past the cap     |
| HTTP response bytes                       | 5 MiB       | `fetch`, `http-post` and `webfetch`, refused past the cap       |
| `fetch` / `http-post` timeout             | 30 s        | total request and body budget; `timeout` seconds, capped at 120 |
| `webfetch` request timeout                | 120 s cap   | the request and the body read                                   |
| Language-server frame                     | 8 MiB       | one JSON-RPC frame, with an 8 KiB header bound                  |
| `NodeLanguageServer.MAX_QUEUED_FRAMES`    | 256         | frames buffered for one language server's stdin                 |
| `NodeLanguageServer.MAX_PENDING_REQUESTS` | 512         | concurrent in-flight JSON-RPC requests to one server            |

Shell capture is bounded where it is read rather than after: a command that prints gigabytes costs the bound, not the whole of what it printed, and the `<stream>DroppedBytes` fields count what the process actually produced. Every caller-supplied command (`bash`, `test`, `shell_command`) passes a bound. The internal `git` plumbing calls behind `Checkpoints` and `TestRun`'s baseline do not, because a listing read for its content is useless with its head missing. Those fields and the `<stream>Truncated` flags beside them are a wire convention: [`@smthrs/harness`](https://harness.smithers.sh) reads them to refuse a later write of those exact bytes, so check the flag before writing captured output anywhere.

## Failures

Handlers keep ordinary outcomes in the success channel: a non-zero exit code, an empty match set and a 500 response are all values. `StdError` is reserved for failures a model must see as failures, and its `code` is a closed, stable list carried with the offending `path` where one exists.

| Code                       | Meaning                                                       |
| -------------------------- | ------------------------------------------------------------- |
| `not_found`                | The named path or ref does not exist.                         |
| `not_a_file`               | A file operation was aimed at something that is not a file.   |
| `not_a_directory`          | A directory operation was aimed at something that is not one. |
| `is_directory`             | A read was aimed at a directory.                              |
| `binary_file`              | The bytes hold a NUL or are not valid UTF-8.                  |
| `offset_out_of_range`      | The requested page or line span is past the end.              |
| `invalid_pattern`          | The search pattern does not compile.                          |
| `invalid_input`            | The input is self-contradictory or names an unusable value.   |
| `no_match`                 | The edit anchor or patch context is not in the file.          |
| `not_modified`             | The write would leave the file exactly as it was.             |
| `permission_denied`        | The host or the capability kernel refused access to the path. |
| `outside_declared_reads`   | A hermetic path token is outside the declared read set.       |
| `outside_declared_writes`  | A hermetic path token is outside the declared write set.      |
| `command_failed`           | The process could not start, or a host operation failed.      |
| `request_failed`           | The HTTP or language-server request failed.                   |
| `timeout`                  | The call exceeded its wall-clock budget.                      |
| `rate_limited`             | Provider rate limit reached; back off before retrying.        |
| `provider_unavailable`     | No host bound the service this flow needs, or it refused.     |
| `unsupported`              | The service does not implement this query.                    |
| `unsupported_content_type` | The response is not a type this flow renders.                 |
| `response_too_large`       | The response or file exceeded the byte cap before decoding.   |

Six services are injected, and a flow whose service a host has not bound gets a `makeNoop` refusal rather than a silent success: `Search` for `grep` and `glob`, `Container` for a containerised `bash` or `test`, `TestRunner` for `test`, `Checkpoints` for agent-side pinning, `WebSearch` for `websearch`, and `LanguageServer` for `lsp`. Refusing loudly is the contract, because a flow that appears to work while doing nothing costs a model the frames it takes to notice.

`NativeSearch` and `PortableSearch` are two implementations of one contract. `SearchContract` exports the matcher both build on, so an external peer binding its own `Search` cannot drift on what a pattern means. `SearchConformance` is how a peer proves it: it generates a tree and a batch of calls from a seed, runs them through two implementations, and reports every answer that differs. It found two drifts between the peers shipped here, one in how `maxCount` interacts with context lines and one in how `ignoreCase` and `smartCase` combine.

## Hermetic mode is a pre-check, not a sandbox

`Bash` retains `mode: "hermetic"` as effect-contract vocabulary, but the handler is not an operating-system sandbox. It performs a fail-closed lexical pre-check of the explicit path tokens in the command against `reads` and `writes`, resolving every token and every declaration to a canonical absolute path before comparing, and treating each physical line of a script as its own command. The host spawner runs the command under its configured confinement. Shell expansion, subprocess access, and paths computed at runtime are not observed, so the check bounds what a caller declared it would do rather than what the process can do. The CLI and native flow hosts supply OS confinement from the grants in force. The lexical check alone cannot prove hermetic execution.

## Documentation

The full documentation is at [std.smithers.sh](https://std.smithers.sh):

- [Quickstart](https://std.smithers.sh/quickstart/): search a tree and read the definition a hit sits in.
- [Flows and handlers](https://std.smithers.sh/concepts/flows-and-handlers/): the model behind the two halves.
- [The search contract](https://std.smithers.sh/concepts/search-contract/): Smithers Ripgrep Subset v1 and its two peers.
- [Flow reference](https://std.smithers.sh/reference/flows/): every flow's input and output fields.
- [API reference](https://std.smithers.sh/reference/api/): every module and every public export.
- [Troubleshooting](https://std.smithers.sh/troubleshooting/): the failures this package produces and what to change.

---
title: "Flow reference"
description: "Every callable flow in @smthrs/std: its registry name, input and output fields, declared effects, the services its handler needs, and the failure codes it produces."
sidebar:
  order: 2
---

Seventeen flows are declared, and sixteen of them have a handler. Each section
names the module that exports the flow, the registry name a model calls it by,
the fields of `Input` and `Output`, and the failures the handler produces.

Every flow module exports `name`, `description`, `Input`, `Output`, `effects`,
`effectsFor`, `capabilities`, and `flow`, plus `run` where there is a handler.
For what those mean, see
[Flows and handlers](../concepts/flows-and-handlers.md); for the declared tiers
and capabilities in one table, see
[Effects and capabilities](../concepts/effects-and-capabilities.md).

| Registry name   | Module         | Handler requirement                                       |
| --------------- | -------------- | --------------------------------------------------------- |
| `read`          | `Read`         | `FileSystem`                                              |
| `write`         | `Write`        | `FileSystem`, `Path`                                      |
| `edit`          | `Edit`         | `FileSystem`                                              |
| `ls`            | `Ls`           | `FileSystem`, `Path`                                      |
| `glob`          | `Glob`         | `Search`                                                  |
| `grep`          | `Grep`         | `Search`                                                  |
| `bash`          | `Bash`         | `ChildProcessSpawner`, `Path`, optional `Container`       |
| `test`          | `TestRun`      | `ChildProcessSpawner`, `TestRunner`, optional `Container` |
| `shell_command` | `ShellCommand` | `ChildProcessSpawner`                                     |
| `apply_patch`   | `ApplyPatch`   | `FileSystem`, `Path`                                      |
| `update_plan`   | `UpdatePlan`   | none                                                      |
| `fetch`         | `Fetch`        | `HttpClient`, `GrantStore`                                |
| `http-post`     | `HttpPost`     | `HttpClient`, `GrantStore`                                |
| `explore`       | `Explore`      | no handler                                                |
| `webfetch`      | `WebFetch`     | `HttpClient`, `GrantStore`                                |
| `websearch`     | `WebSearch`    | `WebSearch`                                               |
| `lsp`           | `Lsp`          | `LanguageServer`                                          |

## read

Reads a text file by 1-based offset and limit.

| Input    | Type                | Meaning                                     |
| -------- | ------------------- | ------------------------------------------- |
| `path`   | string              | Path of the text file to read.              |
| `offset` | integer, at least 1 | First line to return. Defaults to 1.        |
| `limit`  | integer, at least 1 | Maximum lines to return. Defaults to 2,000. |

| Output       | Type             | Meaning                                    |
| ------------ | ---------------- | ------------------------------------------ |
| `content`    | string           | Raw page text, never line-number prefixed. |
| `startLine`  | number           | First returned 1-based line number.        |
| `endLine`    | number           | Last returned 1-based line number.         |
| `totalLines` | number           | Total source lines.                        |
| `truncated`  | boolean          | Whether displayed output was cut.          |
| `notice`     | string, optional | The truncation disclosure.                 |

Fails with `not_found`, `permission_denied`, `is_directory`, `binary_file` (a
NUL byte or invalid UTF-8), `offset_out_of_range`, or `response_too_large` for a
file over 64 MiB (`Read.MAX_READ_FILE_BYTES`), which it refuses before loading.
For a missing relative path, `not_found` names the nearest directory that exists
and its entries, closest name first:

```text
File not found: apps/tui/src/commands.ts. apps/tui/src holds: complete.ts, app.tsx.
```

An absolute path, or one that climbs out with `..`, gets no listing.

## write

Writes UTF-8 text to a path, replacing any existing file. Parent directories are
created, and the file's mode is preserved.

| Input     | Type   | Meaning                       |
| --------- | ------ | ----------------------------- |
| `path`    | string | Path of the file to write.    |
| `content` | string | Complete UTF-8 file contents. |

| Output         | Type    | Meaning                                    |
| -------------- | ------- | ------------------------------------------ |
| `path`         | string  | Path that was written.                     |
| `bytesWritten` | number  | UTF-8 bytes written.                       |
| `created`      | boolean | Whether the file did not previously exist. |

Fails with `command_failed` when the path is a directory, when the parent cannot
be created, when the write fails, or when the mode could not be restored after a
successful write.

## edit

Replaces text anchored by exact bytes or by a prior hit's line range.

| Input        | Type                          | Meaning                                  |
| ------------ | ----------------------------- | ---------------------------------------- |
| `path`       | string                        | Path of the file to edit.                |
| `oldString`  | string, optional              | Exact text to replace, byte for byte.    |
| `startLine`  | integer, at least 1, optional | First 1-based line to replace.           |
| `endLine`    | integer, at least 1, optional | Last 1-based line to replace, inclusive. |
| `expect`     | string, optional              | What those lines currently hold.         |
| `newString`  | string                        | Replacement text.                        |
| `replaceAll` | boolean, optional             | Replace every occurrence instead of one. |

| Output         | Type   | Meaning                                                                  |
| -------------- | ------ | ------------------------------------------------------------------------ |
| `path`         | string | Path that was edited.                                                    |
| `replacements` | number | Occurrences replaced.                                                    |
| `startLine`    | number | First 1-based line of the returned hunk.                                 |
| `endLine`      | number | Last 1-based line of the returned hunk.                                  |
| `hunk`         | string | The edited region as it now stands, plus two lines of context each side. |

Fails with `invalid_input` for a contradictory anchor or a non-unique
`oldString`, `no_match` for an anchor that is not in the file or an `expect`
that does not hold, `offset_out_of_range` for a line range past the end,
`not_found`, `binary_file`, or `command_failed`.

## ls

Lists a directory with directories first, a trailing `/` on directory names, and
locale-independent UTF-16 code-unit ordering.

| Input    | Type                | Meaning                               |
| -------- | ------------------- | ------------------------------------- |
| `path`   | string              | Directory path to list.               |
| `offset` | integer, at least 1 | First entry to return. Defaults to 1. |
| `limit`  | integer, at least 1 | Maximum entries, capped at 1,000.     |

| Output      | Type                      | Meaning                              |
| ----------- | ------------------------- | ------------------------------------ |
| `entries`   | array of `{ name, kind }` | `kind` is `"file"` or `"directory"`. |
| `total`     | number                    | Total entries before paging.         |
| `truncated` | boolean                   | Whether more entries remain.         |
| `notice`    | string, optional          | The truncation disclosure.           |

An entry whose stat fails is reported as a plain file rather than failing the
listing, so one dangling symlink does not cost the whole directory. Fails with
`not_found`, `not_a_directory`, or `offset_out_of_range`.

## glob

Finds files through the Smithers Ripgrep Subset v1 contract, corresponding to
`rg --files -g`.

| Input      | Type                          | Meaning                                                   |
| ---------- | ----------------------------- | --------------------------------------------------------- |
| `pattern`  | non-empty string              | Ripgrep `-g` pattern, matched relative to `root`.         |
| `root`     | string, optional              | Search root. Defaults to `/`. Pass the project directory. |
| `hidden`   | boolean, optional             | Include dot files. Defaults to false.                     |
| `noIgnore` | `true`, optional              | Only true is accepted; ignore files are never consulted.  |
| `limit`    | integer, at least 0, optional | Maximum paths, capped at 1,000.                           |

| Output      | Type             | Meaning                                         |
| ----------- | ---------------- | ----------------------------------------------- |
| `paths`     | array of string  | Matching paths, path sorted.                    |
| `total`     | number           | Matches before the limit.                       |
| `truncated` | boolean          | Whether the limit bit.                          |
| `notice`    | string, optional | Truncation, or why a pattern was unsatisfiable. |

Fails with `invalid_input` for `noIgnore: false`, `invalid_pattern` for an
unsupported glob, `not_found` for a missing root, `command_failed` when the
root exists but the host cannot inspect it (the message carries the host's
own reason), or a peer failure (`command_failed`, `provider_unavailable`,
`request_failed`).

## grep

Searches file contents through the same contract. Results are match-centric:
`limit` counts matches, and each match carries the context that belongs to it.

| Input              | Type                          | Meaning                                                 |
| ------------------ | ----------------------------- | ------------------------------------------------------- |
| `pattern`          | string                        | A Smithers Ripgrep ASCII v1 expression.                 |
| `root`             | string, optional              | Search root the globs are relative to. Defaults to `/`. |
| `fixedStrings`     | boolean, optional             | Ripgrep `-F`. Search a literal.                         |
| `ignoreCase`       | boolean, optional             | Ripgrep `-i`.                                           |
| `smartCase`        | boolean, optional             | Ripgrep `-S`.                                           |
| `globs`            | array of string, optional     | Ordered `-g` patterns; `!` marks an exclusion.          |
| `beforeContext`    | integer, at least 0, optional | Ripgrep `-B`.                                           |
| `afterContext`     | integer, at least 0, optional | Ripgrep `-A`.                                           |
| `context`          | integer, at least 0, optional | Ripgrep `-C`. Not combinable with `-A` or `-B`.         |
| `maxCount`         | integer, at least 1, optional | Ripgrep `--max-count`, per file.                        |
| `filesWithMatches` | boolean, optional             | Ripgrep `--files-with-matches`.                         |
| `hidden`           | boolean, optional             | Ripgrep `--hidden`.                                     |
| `symbols`          | boolean, optional             | Report the enclosing definition. Defaults to true.      |
| `noIgnore`         | `true`, optional              | Only true is accepted.                                  |
| `limit`            | integer, at least 0, optional | Global match budget, capped at 200.                     |

| Output             | Type              | Meaning                                               |
| ------------------ | ----------------- | ----------------------------------------------------- |
| `matches`          | array of `Match`  | Each hit with its own context and optional symbol.    |
| `files`            | array of string   | File names, which is what `filesWithMatches` fills.   |
| `filesSearched`    | number            | Files the globs admitted, including binaries.         |
| `skippedBinary`    | number            | Files skipped for holding a NUL byte.                 |
| `truncated`        | boolean           | Whether the budget bit.                               |
| `retriedAsLiteral` | boolean, optional | Present when these results came from a literal retry. |
| `notice`           | string, optional  | Truncation, the retry, or an unsatisfiable glob.      |

Three schemas are exported alongside `Output`:

| Schema             | Fields                                              |
| ------------------ | --------------------------------------------------- |
| `Grep.ContextLine` | `line`, `text`                                      |
| `Grep.Symbol`      | `kind`, `name`, `startLine`, `endLine`              |
| `Grep.Match`       | `file`, `line`, `text`, `before`, `after`, `symbol` |

Fails with `invalid_input` for a refused option combination, `invalid_pattern`
for an unsupported expression, `not_found` for a missing root, `command_failed`
when the root exists but the host cannot inspect it, or a peer failure.

## bash

Runs a shell command line, or a script delivered to an interpreter as data.
`Input` is a union on `mode`. An omitted `mode` decodes as `"unhermetic"`, the
envelope `bash` declares for every call.

| Input         | Type                           | Meaning                                                                                      |
| ------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `mode`        | `"hermetic"` or `"unhermetic"` | Whether the call declares an envelope. Optional.                                             |
| `command`     | string, optional               | Shell command line. Give this or `script`.                                                   |
| `script`      | string, optional               | Program text delivered on standard input.                                                    |
| `interpreter` | string, optional               | Program that reads `script`. Defaults to `bash`.                                             |
| `args`        | array of string, optional      | Arguments passed to the script as data.                                                      |
| `stdin`       | string, optional               | Text written to the command's standard input.                                                |
| `container`   | string, optional               | Run inside this container. Requires `unhermetic`.                                            |
| `reads`       | array of non-empty string      | Paths the command may read. Hermetic mode only.                                              |
| `writes`      | array of non-empty string      | Paths the command may write. Hermetic mode only.                                             |
| `cwd`         | string, optional               | Working directory; use `{ at: ctx.base }` as the third `ctx.call` argument for a checkpoint. |
| `env`         | record of string, optional     | Environment variables.                                                                       |
| `timeoutMs`   | number, optional               | Numeric wall-clock milliseconds. Defaults to 600,000.                                        |

| Output                                     | Type                           | Meaning                                                                            |
| ------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------- |
| `exitCode`                                 | number                         | The command's exit code, including non-zero.                                       |
| `stdout`, `stderr`                         | string                         | Captured streams, tail kept when truncated.                                        |
| `stdoutTruncated`, `stderrTruncated`       | boolean                        | Whether that stream is a fragment.                                                 |
| `stdoutDroppedBytes`, `stderrDroppedBytes` | number                         | Bytes omitted from the start.                                                      |
| `invalidProbe`                             | `Probe.InvalidProbe`, optional | Reserved for independently confirmed launch failures; not inferred from exit code. |

`Bash.Input` and `Bash.Output` are also exported as TypeScript types alongside
the schemas. Fails with `invalid_input`, `outside_declared_reads`,
`outside_declared_writes`, `provider_unavailable` (a container with no
transport), `outside_container`, `timeout`, or `command_failed`.

`Bash.sealed(container)` is `Bash.run` sealed to one container: a call naming
any other container, or none, fails with `outside_container` before anything
is spawned. A host that must stay out of the cell's reach binds it
(`StandardFlows.shell(services, transport, { sealedTo })`).

## test

Runs the declared test runner and returns a reading rather than a log.

| Input       | Type                                | Meaning                                                         |
| ----------- | ----------------------------------- | --------------------------------------------------------------- |
| `selection` | array of string, optional           | Test ids or paths, passed as arguments. All tests when omitted. |
| `against`   | `"workspace"` or `"base"`, optional | `base` also runs the pristine base commit.                      |
| `timeoutMs` | number, optional                    | Wall-clock timeout for the run.                                 |

`Output` is `Outcome` plus the attribution fields. `TestRun.Outcome` is exported
separately, because the base run carries the same shape:

| Outcome            | Type                           | Meaning                                                           |
| ------------------ | ------------------------------ | ----------------------------------------------------------------- |
| `command`          | string                         | The logical invocation, without container transport arguments.    |
| `exitCode`         | number                         | The runner's exit code.                                           |
| `passed`           | number                         | Tests reported passing. Zero when `parsed` is false.              |
| `failed`           | array of string                | Ids reported failing or erroring.                                 |
| `parsed`           | boolean                        | Whether the complete report could be read.                        |
| `tail`             | string                         | The end of the runner's combined output.                          |
| `tailTruncated`    | boolean                        | Whether `tail` is a fragment.                                     |
| `tailDroppedBytes` | number                         | Bytes omitted from the start of `tail`.                           |
| `invalidProbe`     | `Probe.InvalidProbe`, optional | Present when the exit code describes the command, as Jev read it. |

| Output adds   | Type                                        | Meaning                                    |
| ------------- | ------------------------------------------- | ------------------------------------------ |
| `base`        | `Outcome` plus `ref` and `commit`, optional | The baseline run.                          |
| `introduced`  | array of string, optional                   | Failing here and not on the base tree.     |
| `preexisting` | array of string, optional                   | Failing on both trees.                     |
| `fixed`       | array of string, optional                   | Failing on the base tree and passing here. |

Attribution is omitted unless both reports parsed. `invalidProbe` is Jev's
answer, asked through the `Evaluator` service, so the flow also needs an
evaluator on a subscription seat; a judge that does not answer
fails the call rather than leaving the run unjudged. Fails with
`provider_unavailable` when no runner is declared, a container transport is
missing, or the judge is unreachable or refuses, `request_failed` when the
judge answers something unusable, `invalid_input` when `against: "base"` finds
no repository directory, `not_found` when the base ref does not resolve,
`timeout`, or `command_failed`.

## shell_command

A clone of the Codex CLI tool of the same name.

| Input        | Type             | Meaning                                   |
| ------------ | ---------------- | ----------------------------------------- |
| `command`    | string           | Shell script to run in the default shell. |
| `workdir`    | string, optional | Working directory.                        |
| `timeout_ms` | number, optional | Maximum runtime. Defaults to 10,000.      |

| Output     | Type   | Meaning                                                                             |
| ---------- | ------ | ----------------------------------------------------------------------------------- |
| `output`   | string | Codex-formatted result: exit code, wall time, and possibly middle-truncated output. |
| `exitCode` | number | Exit code; 124 when the command timed out.                                          |

A timeout is a successful value, not a failure. Fails with `command_failed` when
the process could not start.

## apply_patch

A clone of the Codex CLI freeform patch tool: the V4A grammar
(`*** Begin Patch`, `*** Add File:`, `*** Update File:`, `*** Delete File:`,
`*** End Patch`), the context-matching applier, and Codex's summary text.

| Input   | Type   | Meaning                                         |
| ------- | ------ | ----------------------------------------------- |
| `input` | string | The entire contents of the apply_patch command. |

| Output     | Type            | Meaning                                     |
| ---------- | --------------- | ------------------------------------------- |
| `output`   | string          | Codex-style summary with A, M, and D lines. |
| `added`    | array of string | Paths created by the patch.                 |
| `modified` | array of string | Paths updated by the patch.                 |
| `deleted`  | array of string | Paths deleted by the patch.                 |

A patch naming one path in two sections is refused whole rather than applied by
halves. Fails with `invalid_input` for a parse or preflight failure, `not_found`,
`binary_file`, or `no_match` when a hunk's context is not in the file.

`ApplyPatch.paths(patch)` returns every path a patch writes, a move's
destination included, read by the same parser `run` uses. It returns
`undefined` for a patch `run` would refuse, so a host asking permission for
the call asks for everything the flow declares instead.

## update_plan

Acknowledges a plan update. Pure: it touches nothing, and the harness observes
plan updates through the journal.

| Input         | Type                        | Meaning                                      |
| ------------- | --------------------------- | -------------------------------------------- |
| `explanation` | string, optional            | Why the plan changed.                        |
| `plan`        | array of `{ step, status }` | The steps. At most one may be `in_progress`. |

`UpdatePlan.StepStatus` is `"pending"`, `"in_progress"`, or `"completed"`.
`UpdatePlan.Plan` is the array schema carrying the single-in-progress check, so
a plan naming two running steps is a decode failure at the `plan` path rather
than a silent acknowledgement. The handler checks the same rule again, because
a host calling it directly never decodes.

| Output   | Type   | Meaning                  |
| -------- | ------ | ------------------------ |
| `output` | string | Always `"Plan updated"`. |

Fails with `invalid_input`.

## HTTP destination permissions

`fetch`, `http-post`, and `webfetch` resolve every destination before sending,
including redirect destinations, after checking the ordinary request grant. Loopback, private, link-local, shared,
multicast, and reserved addresses require a `net:private` grant. Mixed public
and private DNS answers also require it. Resolution failure refuses the request.

The grant resource is the normalized URL origin, including the scheme and any
non-default port, for example `net:private:http://127.0.0.1:8080`. It supplements
the ordinary `net:get` or `net:post` permission; those grants alone never allow
private destinations. Wildcard action grants (`net:*` or `*`) do not grant
private access; wildcard denies still apply. An authority ceiling must also
permit the private capability.

Without a grant, the tools return `permission_denied` before transport. The
host must expose its `GrantStore` to every web tool, alongside `HttpClient`. DNS checks,
grant waits, redirects, and body reads share the request deadline. Model
transports are unaffected.

Web tools require a host that enforces connection pinning, such as
`EgressHttpClient.layer(process.env)` from `@smthrs/platform-node`, which both
Node and Bun host bundles install. Other transports return `unsupported`
unless they implement the kernel's destination-pinning contract. Preflight
DNS validation alone does not prevent DNS rebinding.

Every redirect resolves and authorizes its destination again. A request uses
only its approved address snapshot, with no shared connection pool. HTTP Host
and TLS hostname verification retain the requested hostname. Proxy selection
uses that hostname and `NO_PROXY`; proxy CONNECT names the approved IP even
for HTTP. A proxy that refuses IP tunnels fails closed. Model requests do not
set the web destination policy and keep their ordinary host transport.

## fetch

| Input     | Type                            | Meaning                                                                  |
| --------- | ------------------------------- | ------------------------------------------------------------------------ |
| `url`     | string                          | Absolute `http` or `https` URL.                                          |
| `headers` | record of string, optional      | Additional request headers.                                              |
| `timeout` | finite number above 0, optional | Total request and body budget in seconds. Defaults to 30, capped at 120. |

| Output      | Type             | Meaning                                        |
| ----------- | ---------------- | ---------------------------------------------- |
| `status`    | number           | HTTP status, including error statuses.         |
| `body`      | string           | Response body as text, capped at 60,000 bytes. |
| `truncated` | boolean          | Whether the body exceeded the display budget.  |
| `notice`    | string, optional | The truncation disclosure.                     |

Fails with `invalid_input` for a URL that is not `http` or `https` or that
carries user information or for an invalid timeout, `request_failed`,
`response_too_large` past 5 MiB, or `timeout` when the total request and body
budget expires. Interruption aborts the request and closes the body reader.

## http-post

| Input         | Type                            | Meaning                                                                  |
| ------------- | ------------------------------- | ------------------------------------------------------------------------ |
| `url`         | string                          | Absolute `http` or `https` URL.                                          |
| `body`        | string                          | Request body, sent verbatim.                                             |
| `contentType` | string, optional                | Defaults to `application/json`.                                          |
| `headers`     | record of string, optional      | Additional request headers.                                              |
| `timeout`     | finite number above 0, optional | Total request and body budget in seconds. Defaults to 30, capped at 120. |

`Output` and the failures match `fetch`. This flow is declared `irreversible`,
because the remote side may already have acted.

## explore

A declaration with no handler: a dynamic flow composed from `read`, `ls`,
`glob`, and `grep`, whose prompt is its own description.

| Input    | Type   | Meaning                                |
| -------- | ------ | -------------------------------------- |
| `prompt` | string | The workspace question to investigate. |

| Output     | Type   | Meaning                                              |
| ---------- | ------ | ---------------------------------------------------- |
| `findings` | string | Evidence-backed findings with `file:line` citations. |

`Explore.make({ model })` builds the declaration pinned to a model;
`Explore.flow` is the same declaration with model selection left to the host.
`Explore.capabilities` is the sorted union of the capabilities of the four flows
it composes.

## webfetch

| Input     | Type                                          | Meaning                                                  |
| --------- | --------------------------------------------- | -------------------------------------------------------- |
| `url`     | string                                        | Absolute `http` or `https` URL without user information. |
| `format`  | `"text"`, `"markdown"`, or `"html"`, optional | Defaults to `markdown`.                                  |
| `timeout` | number above 0, optional                      | Seconds, defaults to 30, capped at 120.                  |

| Output        | Type             | Meaning                                                        |
| ------------- | ---------------- | -------------------------------------------------------------- |
| `url`         | string           | Final URL after redirects.                                     |
| `status`      | integer          | HTTP status, including error statuses.                         |
| `contentType` | string           | The `Content-Type` header, or an empty string.                 |
| `content`     | string           | Body rendered in the requested format, capped at 60,000 bytes. |
| `truncated`   | boolean          | Whether the rendered body exceeded the display budget.         |
| `notice`      | string, optional | The truncation disclosure.                                     |

Follows up to 10 redirects, dropping `authorization` and `cookie` when the
origin changes. Fails with `invalid_input`, `timeout`,
`unsupported_content_type` for a body that is not text, JSON, or XML,
`response_too_large` past 5 MiB, or `request_failed`, including when the
redirect limit is exceeded.

## websearch

| Input        | Type                                                | Meaning                          |
| ------------ | --------------------------------------------------- | -------------------------------- |
| `query`      | non-empty string                                    | The search query.                |
| `numResults` | integer 1 through 20, optional                      | Defaults to 8.                   |
| `freshness`  | `"day"`, `"week"`, `"month"`, or `"year"`, optional | Age limit for published results. |

| Output    | Type                        | Meaning                                            |
| --------- | --------------------------- | -------------------------------------------------- |
| `results` | array of `WebSearch.Result` | `title`, `url`, `snippet`, optional `publishedAt`. |

The failures are the provider's. `ExaWebSearch` maps a 429 or a refusal carrying
`Retry-After` to `rate_limited`, a 401 or 403 to `provider_unavailable`, a 5xx to
`provider_unavailable`, and any other non-2xx to `request_failed`. A host with no
provider bound fails with `provider_unavailable`. Throttling messages include
the retry delay in seconds when `Retry-After` supplies a valid delay or date.
`timeout` is reserved for an elapsed request or response body budget.

## lsp

| Input       | Type                          | Meaning                                                               |
| ----------- | ----------------------------- | --------------------------------------------------------------------- |
| `operation` | one of ten literals           | The query to run.                                                     |
| `path`      | string, optional              | Absolute path. Required by every operation except `workspaceSymbols`. |
| `line`      | integer, at least 1, optional | 1-based line, as `read` and `grep` report it.                         |
| `character` | integer, at least 1, optional | 1-based character offset within the line.                             |
| `query`     | string, optional              | Symbol text. `workspaceSymbols` only.                                 |

The operations are `hover`, `definition`, `references`, `implementation`,
`documentSymbols`, `workspaceSymbols`, `prepareCallHierarchy`,
`callHierarchyIncoming`, `callHierarchyOutgoing`, and `diagnostics`.

| Output   | Type    | Meaning                                         |
| -------- | ------- | ----------------------------------------------- |
| `result` | unknown | The server's answer, in the server's own shape. |

Fails with `invalid_input` for a missing or non-absolute path or a missing
position, and with whatever the bound `LanguageServer` reports: `unsupported`
from the refusal implementation, or `timeout`, `request_failed`, and
`command_failed` from `NodeLanguageServer`.

## Failures

`StdError` is the one error type every handler uses, with a `code` from a closed
list and the offending `path` where one exists. Ordinary outcomes stay in the
success channel: a non-zero exit code, an empty match set, and an HTTP 500 are
all values.

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
| `outside_container`        | A sealed `bash` was asked to run outside its one container.   |

The list is closed and stable, and it is the vocabulary a host binding its own
handler or its own `Search` peer answers in, `not_a_file` and `not_modified`
included: both are available to a handler that needs them, and the handlers
shipped here have no occasion to raise either.

For what to do about each one, see [Troubleshooting](../troubleshooting.md).

Pinned web requests support HTTP and HTTPS proxies only. Other proxy schemes
fail closed. The transport sets Host from the URL and discards caller-supplied
proxy authorization and connection framing headers.

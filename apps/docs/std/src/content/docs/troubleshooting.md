---
title: "Troubleshooting"
description: "The failures @smthrs/std actually produces, what causes each one, and what to change: unbound services, unsatisfiable globs, refused anchors, hermetic pre-check rejections, and missing baselines."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/std/docs/troubleshooting.md"
---

Every failure here is a `StdError` with a `code` and a message. Find the code or
the message and read the matching section. The full code list is in the
[Flow reference](/reference/flows/#failures).

## provider_unavailable: No search implementation is configured

**What happened.** `grep` or `glob` ran with `Search.layerNoop` bound, or with no
`Search` layer at all in a composition that defaulted to the refusal.

**What to change.** Bind a peer:
`PortableSearch.layer` for in-process search with no external binary, or
`NativeSearch.layer` when `rg` is on the path. See
[Bind the standard flows into a host](/guides/bind-the-standard-flows/).

## A glob matches nothing, and the notice says why

**What happened.** A positive glob that no file under the root can match. The
most common cause is an absolute pattern: `/workspace/tests/**` against a root
of `/workspace` is read as the root-relative path `workspace/tests/**`.

**What to change.** Read `notice`. It names the reason, and where a leading path
duplicates the root, the root-relative pattern you probably meant. The other
reasons it reports are a directory that does not exist, a directory that is
never descended into (`.git`, `node_modules`, the checkpoint and test-baseline
scratch checkouts, and other caches or worktrees), and a hidden path
with `hidden` left false.

## A search found nothing, and the result says retriedAsLiteral

**What happened.** The pattern contained regex metacharacters, matched nothing as
a regular expression, and matched something when re-run literally. The results
you are holding came from the literal reading.

**What to change.** Nothing is broken, but the answer is not the one you asked
for. If you meant a literal, pass `fixedStrings: true` so the intent is in the
call. If you meant a regular expression, the metacharacters are not doing what
you think they are.

## invalid_input: Invalid ripgrep options

**What happened.** One of the option combinations v1 refuses rather than guesses
at: `ignoreCase` with `smartCase`, `context` with `beforeContext` or
`afterContext`, or `maxCount` below 1. A `noIgnore` that is not `true` is
refused the same way when it reaches `run` without being decoded first.

**What to change.** The message names the constraint. Ignore files and file-type
registries are outside the contract entirely: `noIgnore` accepts only `true`,
there is no `types` field, and no option enables either.

## invalid_pattern: Unsupported ripgrep pattern

**What happened.** The pattern is outside Smithers Ripgrep ASCII v1. The message
names the construct: lookaround and special groups, backreferences and shorthand
classes such as `\d`, nested or empty character classes, class set operations,
non-ASCII characters, a pattern above 4,096 bytes, or a repetition count above
1,000. For a pattern that does not parse, it names the character and its column
and the escape that makes it literal:

```text
Unsupported ripgrep pattern "Rule({": "{" at column 6 is not a repetition count; write \{ for a literal brace
```

The standard `grep` and `glob` flows pass these messages to the cell verbatim.
A peer's own `invalid_pattern` text, such as `rg` stderr, stays private.

**What to change.** Rewrite the pattern inside the subset, or set
`fixedStrings: true` to search the text literally. The subset is the
intersection of Rust's regex crate and JavaScript's `RegExp`, so that both peers
compile it the same way.

## no_match: oldString does not occur in the file

**What happened.** The `edit` anchor is not in the file byte for byte. There is
no fuzzy apply, because a match that is not your bytes is an edit nobody
inspected.

**What to change.** Read the message. When any line of the anchor occurs in the
file, the message carries that region's **actual** raw bytes and its line range,
so you can re-anchor without re-reading. When no line of it occurs, the message
says so: this is the wrong file, or the region is not what you remember.

A `read` page is raw text with no line-number gutter for exactly this reason: a
line copied out of one is an anchor as it stands.

## invalid_input: oldString occurs N times

**What happened.** The anchor is not unique, and `edit` refuses rather than
silently changing the first occurrence.

**What to change.** The message lists every line the anchor sits on. Widen the
anchor with surrounding context, anchor by `startLine` and `endLine` instead, or
pass `replaceAll: true` if you mean all of them.

## no_match: lines do not hold expect

**What happened.** A line-range anchor whose `expect` does not match what those
lines currently hold. The file moved under the line numbers you anchored on.

**What to change.** Re-read the file and anchor again. The message prints what
the lines actually hold, raw.

## is_directory, binary_file, offset_out_of_range

**What happened.** `read` was aimed at a directory, at a file holding a NUL byte
or invalid UTF-8, or past the end of the file.

**What to change.** Use `ls` for a directory. Binary files are not readable
through this flow at all. For the offset, note that reading an empty file
returns an empty page rather than failing, so `offset_out_of_range` means a real
overshoot.

## permission_denied: Permission denied

**What happened.** The host refused the path, or the capability kernel did: a
symlink that escapes the workspace, a hard-linked file, or a missing grant. The
file exists; searching for it elsewhere will not help.

**What to change.** Grant the capability the call needs, or fix the path's
permissions on the host.

## response_too_large on read

**What happened.** The file is larger than 64 MiB. `read` decodes the whole
file to count its lines, so it refuses before loading one that large.

**What to change.** Search the file with `grep`, or print the line range you
need with `bash`.

## outside_declared_reads or outside_declared_writes

**What happened.** A hermetic `bash` call named an explicit path token that is
not covered by its own `reads` or `writes`. The message names the resolved path.

**What to change.** Add the path or its glob to the declaration, or drop to
`mode: "unhermetic"` if the command's paths cannot be declared up front. The
check is lexical and fail-closed: it reads the tokens in the command line, not
what the process will actually touch.

## invalid_input: a hermetic call that names a container

**What happened.** `mode: "hermetic"` together with `container`. A container has
its own filesystem, so host paths in `reads` and `writes` cannot describe it.

**What to change.** Use `mode: "unhermetic"` for a containerised command.

The same rule refuses a hermetic `script` whose `interpreter` is not a shell:
the pre-check reads shell text, and Python is not shell text. Run it
unhermetically, or express it as shell.

## provider_unavailable: this host has no container transport

**What happened.** A call named a `container` and no `Container` service was
bound, or `Container.layerNoop` was.

**What to change.** Bind `Container.layerCommand()` for the `docker` or `podman`
CLI, or drop the `container` field and run the command on the host.

## provider_unavailable: no test runner is declared

**What happened.** `test` ran with `TestRunner.layerNoop` bound.

**What to change.** Bind `TestRunner.layer({ command, cwd })` with this
repository's own invocation. Until then, run the suite through `bash` with the
command the project's documentation gives, which is what the refusal message
says.

## not_found: no pristine base to compare against

**What happened.** `against: "base"` could not resolve a base commit. Either the
declared `baseRef` does not resolve, or neither `refs/flows/capture-base` nor
`HEAD` does.

**What to change.** A declared ref that does not resolve is an error rather than
a fallback, because a baseline against the wrong tree answers the attribution
question wrong. Fix the ref, or run `against: "workspace"`.

## invalid_input: the declared runner names no repository directory

**What happened.** `against: "base"` needs somewhere to check the base tree out,
and the runner declared neither `root` nor `cwd`.

**What to change.** Add `root` (the host path of the git repository) to the
`TestRunner.Runner` declaration. When the runner runs in a container, `cwd` is
the container's view of the same directory and `root` is the host's.

## A test run passes before and after a fix, or fails identically

**What happened.** Check `invalidProbe` on the result. A command that names a
test, a file, a module, an environment, or a program that does not exist never
reaches any code and still exits non-zero, so the exit code reads the same
before and after a correct fix.

**What to change.** `reason` says which kind of name failed to resolve, and
`evidence` says what the attribution rests on: the shell's own exit code, or
Jev's reading of the output and how sure it was. Repair the names and run it
again before drawing any conclusion. An empty `invalidProbe` on a `test` result
is an answer too, because the flow fails rather than reporting a run no judge
attributed.

## command_failed: rg exceeded the capture cap

**What happened.** One `rg` invocation produced more than
`NativeSearch.MAX_CAPTURE_BYTES` on a stream. The native peer refuses partial
output rather than returning an answer that could differ from the portable peer.

**What to change.** Narrow the search: pass a `root`, add globs, or lower
`limit`. A refusal to start `rg` at all is `provider_unavailable` instead.

## unsupported_content_type, response_too_large, timeout on webfetch

**What happened.** In order: a response that is not `text/*` and carries neither
`json` nor `xml`; a body above 5 MiB, checked against `content-length` first and
then while reading; or the request or body read exceeding `timeout`.

**What to change.** `webfetch` renders text, not binaries. `timeout` is in
seconds, defaults to 30, and is capped at 120, so a value above that is silently
lowered rather than honoured. For a raw body without HTML rendering, use `fetch`.

## unsupported: language server support is unavailable

**What happened.** `lsp` ran with `LanguageServer.layerNoop` bound.

**What to change.** Bind `NodeLanguageServer.layer({ command, cwd })` with a
server that speaks LSP on stdio, or implement the ten-method service yourself.

Two other `lsp` failures are input errors: `A normalized absolute path is
required` means `path` was missing or relative for an operation that needs one,
and `1-based line and character are required` means a position operation was
missing its coordinates. Both are `invalid_input`. A `path` the guarded
filesystem denies fails with `permission_denied`.

## permission_denied: Language server program is inside the workspace

**What happened.** `NodeLanguageServer.make` resolved `command` to a file under
`cwd` (a `./` path, a `PATH` entry such as `node_modules/.bin`, or a symlink
there), an argument named a file under `cwd`, or `command` was a launcher
(`sh -c`, `env`, `npx`, `pnpm exec`, `yarn`, `bunx`, or `node`/`bun` with `-e`,
`-p`, `-r`, `--require`, `--import` or `--loader`) whose arguments choose what
runs. The server would have run workspace-written code on the host.

**What to change.** Install the server outside the workspace and pass its
absolute path, not a launcher. For typescript-language-server, also pin
`initializationOptions: { tsserver: { path } }` to a host copy.

## A write of captured output replaced a file with a log tail

**What happened.** A truncated `stdout`, `stderr`, or `tail` was written to a
file. Those fields are fragments: the capture keeps the tail of what the process
printed, not the whole of it.

**What to change.** Check `stdoutTruncated`, `stderrTruncated`, or
`tailTruncated` before writing captured output anywhere.
[`@smthrs/harness`](https://harness.smithers.sh/reference/api/) reads the same flags and refuses the write for
you when it is the host running these tools.

## A browser bundle pulls in node:url

**What happened.** Importing `@smthrs/std` from a browser bundle. The root entry
point re-exports `NodeLanguageServer`, which imports `node:url`.

**What to change.** Import the browser-safe subpaths directly:
`@smthrs/std/Grep`, `@smthrs/std/Glob`, `@smthrs/std/Search`, and
`@smthrs/std/PortableSearch`.

## invalid_input: at most one step can be in_progress

**What happened.** An `update_plan` call whose plan names two running steps. The
rule is enforced at decode time by the `Plan` schema and again in the handler,
because a host that calls the handler directly never decodes.

**What to change.** Mark one step `in_progress` and leave the rest `pending` or
`completed`.

## invalid_input: a patch names one file twice

**What happened.** An `apply_patch` input with two sections for the same path.
Every update hunk is derived from the file as it is on disk, so the second
section would start from an original the first has already replaced, and the
summary would report two modifications where one write survived.

**What to change.** Put several `@@` chunks inside one section, which is the
shape the parser already accepts.

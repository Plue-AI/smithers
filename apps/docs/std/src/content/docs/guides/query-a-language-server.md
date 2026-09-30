---
title: "Query a language server"
description: "Run the ten LSP operations through the lsp flow, spawn a server with NodeLanguageServer, and understand the 1-based coordinates and the pass-through result."
sidebar:
  order: 8
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/std/docs/guides/query-a-language-server.md"
---

`lsp` is one flow with ten operations. It answers the questions a text search
cannot: where a symbol is defined, who calls it, what type it has.

## Spawn a server

`NodeLanguageServer` speaks framed JSON-RPC over ordinary stdio pipes, spawned
through [`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/)'s `ChildProcessSpawner`. No terminal is
involved.

```ts
import * as NodeLanguageServer from "@smthrs/std/NodeLanguageServer"

const server = NodeLanguageServer.layer({
  command: "typescript-language-server",
  args: ["--stdio"],
  cwd: "/workspace",
  environment: { NODE_ENV: "development" },
  timeoutMs: 30_000
})
```

The layer sends `initialize` with `cwd` as the root URI and then `initialized`,
so the service is ready when it resolves. `timeoutMs` defaults to 30 seconds and
bounds every request as well as every write to the server's standard input.
The child inherits only `PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `TERM`, `TMPDIR`,
and `SHELL`, with credential-shaped names withheld. Declare other names through
`environment`; explicit values override the allowlist.

### Keep the server's code out of the workspace

The server runs on the host as the host user, so a program the workspace
supplies would let files an agent wrote choose what the host executes. The
layer fails with `permission_denied`, before spawning, when:

- `command` resolves to a file under `cwd`, directly, through a `PATH` entry
  such as `node_modules/.bin`, or through a symlink planted there;
- an argument, or the value after `=` in one, names an existing file under
  `cwd`;
- `command` is a launcher whose arguments choose what runs: a shell
  (`sh -c ...`), `env`, a package runner (`npx`, `pnpm exec`, `npm`, `yarn`,
  `bunx`, `bun x`, `deno`), or `node` or `bun` given inline code or a preload
  (`-e`, `-p`, `-r`, `--require`, `--import`, `--loader`). `npx` and
  `pnpm exec` resolve the workspace's `node_modules/.bin` first, and inline
  code resolves bare requires from `cwd`. Name the server's own host binary,
  or an interpreter and a host script file, instead.

The layer cannot see what the server loads after it starts. By default
typescript-language-server runs the workspace's own `node_modules/typescript`;
tsserver started with `--allowLocalPluginLoads` loads `tsconfig` plugins from
the project; rust-analyzer runs build scripts and proc macros. Pin those to
host copies, or run the server in a sandbox:

```ts
const server = NodeLanguageServer.layer({
  command: "/opt/lsp/node_modules/.bin/typescript-language-server",
  args: ["--stdio"],
  cwd: "/workspace",
  initializationOptions: { tsserver: { path: "/opt/lsp/node_modules/typescript/lib/tsserver.js" } }
})
```

`initializationOptions` is sent on `initialize` unchanged. With `tsserver.path`
outside the workspace and local plugin loads left off, tsserver probes for
plugins only beside its own install.

A host with no server binds `LanguageServer.layerNoop`, and every operation
fails with `unsupported`.

### One server per language

Pass several configs and each file goes to the server whose `extensions`
include its extension. A config without `extensions` takes every file no other
server claims; a file nobody claims fails with `unsupported`.
`workspaceSymbols` asks every server and concatenates the answers.

`NodeLanguageServer.layerLazy` takes the same configs but starts each server on
the first request for one of its files, so a host can bind servers a run may
never need. The workspace checks above still run when the layer is built. A
server starts with the services and permissions of the code that built the
layer, not those of the request that first needs it. A server that fails to
start fails that request and every later one for its files. `refresh` and
`close` never start a server.

```ts
const servers = NodeLanguageServer.layer([
  { command: "typescript-language-server", args: ["--stdio"], cwd: "/workspace", extensions: [".ts", ".tsx"] },
  { command: "pyright-langserver", args: ["--stdio"], cwd: "/workspace", extensions: [".py"] }
])
```

## Edits reach the server

With a `LanguageServer` bound, `edit`, `write` and `apply_patch` send each file
they write to its server: `textDocument/didOpen` the first time, then
`textDocument/didChange` with the full text. A file `apply_patch` deletes or
moves away gets `textDocument/didClose`. `edit` then returns `errors`, the
error-severity diagnostics in the file after the edit (at most 20, 1-based
positions). `errors` is absent when no server is bound or it did not answer;
the edit itself never fails because of the server.

`bash` does not know which files a command changed, so after a command on the
host it calls `refresh`: the client re-reads every file it has open, sends the
text of each that changed, and closes each that is gone. A command run in a
container leaves the host's files alone and refreshes nothing.

`diagnostics` pulls `textDocument/diagnostic`. A server that answers
`MethodNotFound` is read from its `textDocument/publishDiagnostics`
notifications instead: the client opens the file if it is not open yet and waits
up to `settleMs` (5 seconds by default) for a publish for the latest synced
text, then fails with `timeout`. After a publish it keeps waiting while later
ones arrive less than `quietMs` (300 ms by default) apart, within `settleMs`, and
answers with the last. Either way the answer is a report,
`{ kind: "full", items }`.

A publish that carries no version counts for the text synced before it arrived.
Before each sync the client sends a `$/` request, which the specification has
every server refuse at once, so a report the server wrote earlier (such as the
empty one typescript-language-server publishes when a file closes) reaches the
client first and never counts for the new text. A server that does not answer
within a second is not asked again.

### typescript-language-server

typescript-language-server 6 has no pull diagnostics, publishes without
versions, and publishes nothing for a change that leaves a file with no
problems, so such a change always waits the full `settleMs` and fails with
`timeout`. On the first open of a file it publishes syntax errors before
semantic ones. Pick `settleMs` and `quietMs` from a measurement on your host:

```sh
node scripts/lsp-settle-bench.ts <typescript-language-server> <tsserver.js> <workspace> <iterations> <settleMs> <quietMs> <file>...
```

## Run a query

```ts
import * as Lsp from "@smthrs/std/Lsp"

const definition = Lsp.run({
  operation: "definition",
  path: "/workspace/src/widen.ts",
  line: 12,
  character: 17
})
// definition.result is the server's own answer, passed through unchanged
```

| Operation               | What it takes               |
| ----------------------- | --------------------------- |
| `hover`                 | `path`, `line`, `character` |
| `definition`            | `path`, `line`, `character` |
| `references`            | `path`, `line`, `character` |
| `implementation`        | `path`, `line`, `character` |
| `prepareCallHierarchy`  | `path`, `line`, `character` |
| `callHierarchyIncoming` | `path`, `line`, `character` |
| `callHierarchyOutgoing` | `path`, `line`, `character` |
| `documentSymbols`       | `path`                      |
| `diagnostics`           | `path`                      |
| `workspaceSymbols`      | `query`                     |

`line` and `character` are **1-based**, which is how `read` and `grep` report
them, so a hit from a search is a position you can pass straight in. The flow
converts to the protocol's 0-based coordinates for you.

`path` must be a normalized absolute path. A relative path, or a missing one for
any operation except `workspaceSymbols`, fails with `invalid_input`, as does a
position operation missing `line` or `character`. The server reads the file
itself, so the flow first reads `path` through the bound `FileSystem`: a path the
guarded filesystem denies fails with `permission_denied` before the server sees
it.

`references` includes the declaration. The two call-hierarchy directions run
`prepareCallHierarchy` first and return an empty array when the server prepares
no item, so a position that is not a callable is an empty answer rather than a
failure.

## The result is not a schema

`Output` is `{ result: unknown }`. The server's answer is passed through in the
server's own shape, because LSP responses vary by server and by version, and
narrowing them here would be a second, staler schema. Decode it on the caller's
side against what the server you bound actually returns.

## Bounds a server cannot exceed

The client refuses a malformed or oversized stream rather than growing without
limit:

| Bound                                     | Value                                               |
| ----------------------------------------- | --------------------------------------------------- |
| One JSON-RPC frame body                   | 8 MiB                                               |
| One frame's headers                       | 8 KiB                                               |
| `NodeLanguageServer.MAX_QUEUED_FRAMES`    | 256 frames buffered for the server's standard input |
| `NodeLanguageServer.MAX_PENDING_REQUESTS` | 512 concurrent in-flight requests                   |

Every queued write uses the request timeout, so a server that stops reading
produces a typed `timeout` rather than an unbounded queue or a new hang. Process
exit or a closed stdout fails every pending request after at most 100 ms for
stderr to finish draining.

Request errors include the protocol `method`. A server refusal keeps its numeric
code, message, and optional data in `StdError.rpcError`; the response frame limit
bounds that data. The main error message also includes the server message.
`StdError.stderr`, when present, contains the latest stderr tail, captured from
at most 64 KiB. Initialization failures and exits retain this diagnostic context.

## Bring your own server

`LanguageServer` is an ordinary service interface: ten query methods, each
taking a `Position` (`path`, `line`, `character`) or a string, plus
`sync(path, text)` and `close(path)`. A host with its own client, in-process
index, or remote service implements those twelve methods and
binds them with `LanguageServer.make`. Nothing above the service knows which one
answered.

One detail to implement against: a `Position` reaching the service is already
**0-based**. The 1-based to 0-based conversion happens in the flow, so the
service speaks the protocol's own coordinates.

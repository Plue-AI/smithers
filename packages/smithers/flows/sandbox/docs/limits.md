---
title: "Limits"
description: "What @smthrs/sandbox bounds and what it buffers whole, per operation and per provider, and which providers keep a command's output byte exact."
---

Two things here are bounded and the rest is sized by the host's heap. A caller
placing an agent's file tools on a machine should know which is which.

| Path                                    | Bound                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a command's standard input              | 16 MiB, refused above it. The count runs as the bytes arrive, so an oversized or endless producer is stopped at the bound rather than after it finishes                                                                                                                                                                                                                                                                                                                   |
| the signal a closing scope sends        | 5 seconds, or however long it takes the command's exit to be observed, whichever comes first. A finalizer cannot be interrupted, so a provider whose `kill` never answers would hold the closing fiber open forever; the provider's own teardown sends it again. `string` and `lines` close the scope when the output ends rather than when the exit lands, so the exit observation is what keeps a command that already finished from costing its caller the whole bound |
| `Session.readFile`, `Session.writeFile` | none. A file crosses whole, in memory, on every provider                                                                                                                                                                                                                                                                                                                                                                                                                  |
| a command's `stdout` and `stderr`       | none. `RemoteChildProcessSpawner` and the probe helpers collect a command's output whole                                                                                                                                                                                                                                                                                                                                                                                  |
| `Sandbox.fileSystem.readDirectory`      | none, and a listing is materialized twice: once as probe output and once as the parsed entries                                                                                                                                                                                                                                                                                                                                                                            |
| `AwsSandbox` command output             | none, and buffered whole by construction: the Session Manager channel carries one session's output as a single stream that is parsed after it ends                                                                                                                                                                                                                                                                                                                        |
| `AwsSandbox` file writes                | require `ExecTransport.streamingSpawner`; one streaming session per `chunkBytes` bytes (default 3072, enforced range 1 through 65536 before base64). Payload travels on stdin. A 64 MiB write at the default needs roughly 22,000 sequential sessions                                                                                                                                                                                                                     |

Command output is byte-exact through `DirectorySandbox`, `ContainerSandbox`,
`KubernetesSandbox`, and `MicrosandboxSandbox`. It is not through
`JustBashSandbox`, `VercelSandbox`, `DaytonaSandbox`, or `CloudflareSandbox`, whose vendor
APIs report a command's output as a string: what those providers stream is that
string re-encoded as UTF-8, so a command writing a tarball or a compiled binary
to stdout comes back changed. `AwsSandbox` reframes output through a
pseudo-terminal, which normalizes line endings and interleaves standard error.
File transfer is byte-exact on all nine when the required transport is supplied, so a caller that needs bytes out of a
command has it write a file and reads that back with `readFile`.

`JustBashSandbox` serializes commands across every session on one provider.
Interrupting or timing out `spawn` stops waiting for its result. A command
already executing continues inside the interpreter and holds the permit until
its promise settles; a command cancelled while queued never starts. If the
interpreter never settles, subsequent spawns remain queued but their callers
can still cancel or time out. Cancellation does not deliver a signal or roll
back command effects. Keep the session scope open until execution finishes if
the command needs its workspace; closing the scope removes that workspace.

Derived `Sandbox.fileSystem.writeFile` and `writeFileString` support only
replacement: an omitted `flag` or `flag: "w"`, with no `mode`. All other flags
(including `"a"` and `"wx"`) and all explicit modes fail with a typed
`PlatformError` reason `BadArgument` before session access, leaving existing
content unchanged and absent paths uncreated. `Session.writeFile` provides no
atomic append, exclusive creation, or creation permission operation. Native
write overrides in `Session.files` receive the options unchanged and may
support these operations.

## Read next

- [Resource limits](./concepts/isolation.md#resource-limits): the neutral
  `limits: { cpus, memoryMib, timeoutSecs }` machine ceilings each provider
  enforces or refuses.
- [How a remote command differs from a local one](./concepts/remote-commands.md):
  why standard input crosses whole rather than as a pipe.

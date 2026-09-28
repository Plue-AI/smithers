---
title: "The two provider seams"
description: "Why this package has two provider contracts, what each one obliges an adapter to do, and which surfaces derive from each."
sidebar:
  order: 1
---

A backend joins this package by implementing one of two contracts. Which one
it can implement is decided by what its transport can do.

## RemoteChildProcessSpawner.Provider: a command transport

The narrow seam assumes the machine already exists and carries commands to it:

```ts
interface Provider {
  readonly session: string
  readonly open: (session: string) => Effect.Effect<void, ProviderError, Scope>
  readonly spawn: (
    command: string,
    options: RemoteOptions
  ) => Effect.Effect<RemoteProcess, ProviderError, Scope>
  readonly kill?: (process: RemoteProcess, signal: Signal) => Effect.Effect<void, ProviderError>
  readonly ping?: Effect.Effect<void, ProviderError>
  readonly stdin?: true
}
```

`spawn` receives one already rendered command line and answers with the three
pieces a child process has: `stdout`, `stderr`, and `exitCode`. That is enough
to satisfy Effect's `ChildProcessSpawner`, which is what
`RemoteChildProcessSpawner.layer` produces from it, and it is not enough to
place work, because there is no filesystem.

The command reaches the provider as the string `CommandLine.render` produces.
[`@smthrs/kernel`](/api/kernel) checks `proc:spawn` against
`CommandLine.resource`, which starts from that string and adds a `sh -c`
wrapper for a shell line holding control syntax, an `env <NAME>… -- ` prefix
for overridden environment names, and a `cwd <path> -- ` prefix for a
directory outside the workspace.

## Sandbox.Provider: a machine lifecycle

The wide seam owns provisioning:

```ts
interface Provider {
  readonly acquire: (session: string) => Effect.Effect<Session, ProviderError, Scope>
}
```

`acquire` creates or reattaches one machine and hands back a `Session`: the
same `spawn`, plus `readFile` and `writeFile` in bytes, plus a `workdir`, plus
the optional `kill` and `ping`, plus `files` for native filesystem operations
an adapter can serve better than a shell probe.

What a machine _is_ (an image, a memory limit, a network policy) belongs to
provider construction, not to `acquire`. A caller that needs two differently
shaped machines holds two providers.

Session obligations are stated in the type and enforced by
[`SandboxConformance`](../guides/prove-a-provider.md):

- `spawn` with no `cwd` runs in `workdir`; a relative `cwd` is taken under it.
- `spawn` delivers `options.stdin` as the command's complete standard input.
- `spawn` refuses an environment name a POSIX shell would drop.
- `writeFile` creates missing parent directories.
- `readFile` of an absent path fails with code `not_found`.
- File contents cross as bytes and round-trip unchanged.
- A declared `kill` ends the command and everything it started.

## What derives from which

Nothing in the table below is asked of an adapter. Each row is computed from
one of the two contracts.

| Surface                           | Built from               | What it gives you                                                                   |
| --------------------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `RemoteChildProcessSpawner.layer` | the narrow seam          | Effect's `ChildProcessSpawner`.                                                     |
| `SandboxHealth.make`              | the narrow seam's `ping` | a deadline-bounded liveness verdict.                                                |
| `SandboxSupervision.layer`        | the narrow seam's `ping` | a spawner that retires a dead session.                                              |
| `ProviderConformance.check`       | the narrow seam          | the narrow contract as behavior.                                                    |
| `Sandbox.fileSystem`              | a `Session`              | Effect's `FileSystem`, natively where `files` says so and by POSIX probe elsewhere. |
| `Sandbox.layerHost`               | a `Session`              | `ChildProcessSpawner`, `FileSystem`, `Path`, and `SandboxHealth` from one machine.  |
| `Sandbox.commandProvider`         | a `Sandbox.Provider`     | the narrow seam, so every row above composes with a lifecycle provider.             |
| `SandboxConformance.check`        | a `Sandbox.Provider`     | the wide contract as behavior, delegating the spawn half through `commandProvider`. |

The projection is the reason the package has one implementation of each
derived surface rather than two. A lifecycle provider is supervised, probed,
and conformance-checked by the code written for transports, with the
capability declaration bridging the one difference between them.

## Why kill and ping are optional and stdin is not

`kill` and `ping` are optional because a transport that can only post a command
line has neither. A provider that implements them buys two things it cannot
otherwise have: one command can be stopped without tearing down the session
that runs it, and the session's liveness can be supervised. A provider that
omits them keeps the narrower contract, and the adapter refuses `kill` with a
`BadArgument` `PlatformError` rather than pretending to have delivered a
signal.

`stdin` is different in kind. On the narrow seam it is a declaration: a
provider that sets `stdin: true` receives the command's input collected whole,
and a provider that leaves it unset causes an input-fed command to be refused
at spawn time. Refusal is the point, because the alternative is a script fed
on standard input that silently runs as an empty one.

On the wide seam, delivering standard input is an obligation of every session,
not a capability a session may lack. A transport with no input channel stages
the bytes as a file in the workspace and redirects the command from it. That
is why `Sandbox.commandProvider` sets `stdin: true` unconditionally, and why
`SandboxConformance` checks input delivery on every provider.

## The failure vocabulary

Providers report one closed set of codes, and a provider may add SDK detail to
`ProviderError.cause` but cannot invent a new host-visible failure kind:

| Code          | Means                                                    |
| ------------- | -------------------------------------------------------- |
| `aborted`     | the session ended without reporting the command's status |
| `timeout`     | the operation outlived its own bound                     |
| `unavailable` | the session or the backend is broken or missing          |
| `not_found`   | the named path holds nothing                             |
| `spawn_error` | the command could not be started as asked                |
| `unknown`     | anything else                                            |

One shared table normalizes each code onto the `PlatformError` reason that
already means it: `timeout` becomes `TimedOut`, `unavailable` and `not_found`
become `NotFound`, and everything else becomes `Unknown`. A caller that needs
the distinction between "absent" and "broken" reads the `ProviderError` back
off `PlatformError.cause`.

`Sandbox.fileSystem` is the one deliberate exception: there `unavailable`
stays `Unknown`, because a filesystem's `NotFound` is load bearing (`exists`
turns it into `false`) and a broken session must not read as an absent path.

## Read next

- [Sessions and their keys](./sessions.md): what `acquire` promises about
  identity, reattachment, and teardown.
- [How a remote command differs from a local one](./remote-commands.md): the
  divergences the adapter declares rather than hides.
- [Write a provider](../guides/write-a-provider.md): implementing either seam.

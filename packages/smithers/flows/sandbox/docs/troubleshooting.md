---
title: "Troubleshooting"
description: "The refusals and failures @smthrs/sandbox reports, what each one means, and what to change: stdin, signals, environment names, retirement, and conformance violations."
---

Most failures here are a refusal, not a fault: the seam declines to pretend it
did something it cannot do. Find the message and read the matching section. The
full error shapes are in the [API reference](./api.md).

## "DirectorySandbox requires a contained ChildProcessSpawner with a platform lifecycle"

**What happened.** The supplied spawner is raw or wraps only a kill deadline.
Acquisition failed with `unavailable` before creating a workspace or starting a
command.

**What to change.** Supply `NodeHost.layerContained()` or
`BunHost.layerContained()` with a `ProcessLedger`, as in the
[quickstart](./quickstart.md). A smaller Node or Bun host can use
`ProcessReaper.layerSpawner()` with the same ledger. Custom platform authors can
supply `ContainedSpawner.layer(options, lifecycle)`. Put the permission decorator
above containment so it checks the original command before preparation.

## "this remote session cannot supply stdin to a command"

**What happened.** A command fed standard input to a provider that does not
declare `stdin: true`, so the adapter refused it with a `BadArgument`
`PlatformError` before starting anything.

**What to change.** Use a `Sandbox.Provider`, where delivering standard input
is an obligation of every session and a transport with no input channel stages
the bytes as a workspace file. If you are writing the provider and it can
deliver input, declare `stdin: true` and read `RemoteOptions.stdin`. The
sibling refusal, "a remote session feeds standard input to the first command of
a pipeline only", means a later stage of a pipeline named input; a later stage
reads its predecessor.

## "a remote session cannot inherit this process's standard input"

**What happened.** A command set `stdin: "inherit"`. A local spawner hands the
child this process's own standard input; a remote command would read EOF
instead.

**What to change.** Pass the bytes explicitly, or use `"pipe"`, `"ignore"`, or
`"overlapped"`, all three of which mean the command reads no input.

## "the standard input ... exceeds 16777216 bytes"

**What happened.** A command fed more than 16 MiB on standard input. The count
runs as the bytes arrive, so an oversized or endless producer is stopped at the
bound rather than after it finishes.

**What to change.** Write the payload to a file with `Session.writeFile` and
have the command read it, which is what the refusal says.

## "remote sessions end `<command>` by closing its scope, not by signal"

**What happened.** `kill` was called on a provider that declares none.

**What to change.** Close the command's scope, which ends it. To stop one
command without tearing down the session, use a provider that declares `kill`:
`DirectorySandbox`, `ContainerSandbox`, `KubernetesSandbox`, or `AwsSandbox`.

## "a remote session cannot ..." for descriptors, shells, and routing

**What happened.** The command configured additional file descriptors, named a
shell path, set `detached: true`, or used non-default pipeline routing (`from`
or `to`). None survives a rendered command line reaching a remote shell.

**What to change.** Remove the option. A pipeline still works: it renders into
one line the remote shell parses.

## "the environment cannot carry `<name>`"

**What happened.** A spawn's environment held a name that is not a shell
identifier, and the seam refused it with `spawn_error`.

**What to change.** Rename the variable to match
`[A-Za-z_][A-Za-z0-9_]*`. The refusal is deliberate: every provider runs the
command through a shell, and a shell rebuilds its environment from those names
when it starts, so `a-b` is dropped by dash and kept by bash. A silent drop
would be invisible to the host and land only on the platform the machines
actually run.

## "the sandbox session is not open, so it cannot spawn a command"

**What happened.** A provider projected with `Sandbox.commandProvider` was used
before `open` ran, or after its scope closed.

**What to change.** Keep the work inside the scope that opened the session.
Under `SandboxSupervision` the session opens on the first command, so this
means a command escaped the layer's scope.

## "the acquired sandbox session does not provide kill, though the provider declared it"

**What happened.** `commandProvider` was given `provides: { kill: true }` or
`{ ping: true }`, and the acquired session has no such method.

**What to change.** Declare only what your sessions actually have. The
declaration exists because the narrow seam decides capabilities statically,
before any session is acquired.

## "sandbox session `<key>` was retired"

**What happened.** `SandboxSupervision` saw `tolerance` consecutive unhealthy
verdicts and retired the session. Everything running in it failed with a
`NotFound` `PlatformError`, which is the same reason a session that refused to
open produces, because both tell a retry policy to try again somewhere else.

**What to change.** Nothing, if a retry is in place: the next command opens a
fresh session. If healthy machines are being retired, raise `tolerance` or
`deadline`, since a probe can lose a race with a loaded machine. If the machine
really is dying, the `SandboxUnhealthy` event carries the reason and the probe's
message.

## Health is always `Healthy` and never notices a dead machine

**What happened.** The session declares no `ping`, so
`SandboxHealth.make` returned the noop service, which always answers
`Healthy`.

**What to change.** Understand the verdict as "nothing is watching this
machine" rather than "the machine is alive". Supervision built on such a
provider never fires. A provider that wants to be supervised implements `ping`.

## A command's output came back changed

**What happened.** The provider is one whose vendor API reports output as a
string. `JustBashSandbox`, `VercelSandbox`, `DaytonaSandbox`, and
`CloudflareSandbox` re-encode that string as UTF-8, so a tarball or a compiled binary written to stdout comes
back altered. `AwsSandbox` reframes output through a pseudo-terminal, which
normalizes line endings and interleaves standard error.

**What to change.** Have the command write a file and read it back with
`readFile`. File transfer is byte exact on all ten providers. The table is on
[Limits](./limits.md).

## Standard error arrived merged into standard output

**What happened.** `DaytonaSandbox` reports one `result` string with no
separate stderr field on the wire, and `AwsSandbox` interleaves both streams
through its pseudo-terminal.

**What to change.** Nothing, on those backends. Redirect explicitly in the
command if you need the streams apart, or choose a provider that keeps them
separate.

## `stat` reports mode 0 and no timestamps

**What happened.** The operation was served by `Sandbox.fileSystem`'s POSIX
probe rather than natively. The probe reports exact file size, and the portable
shell cannot name mode, times, or ownership.

**What to change.** Use size, or have the provider serve `stat` natively
through `Session.files`. A related probe limit: operations with no meaningful remote form (a watch, an open handle, a temporary
directory) answer with the platform's own refusal.

## `isRunning` turned false too early, or `extendEnv` did nothing

**What happened.** Both are divergences the error channel cannot report.
`isRunning` answers from what this side has observed: the adapter observes
the provider's exit in a scoped fiber forked at spawn and memoizes the
result, so liveness turns `false` when that observation lands, which can lag
the remote process by a scheduler tick. Await `exitCode` when the code
itself matters. The remote session's ambient environment never crosses the
seam, so only `env` overrides travel and `extendEnv: false` cannot clear an
environment this side never held.

**What to change.** Do not treat `isRunning` as a liveness question about the
guest; use `SandboxHealth` for that. Pass the environment you want explicitly,
and request deletion of an inherited variable by setting it to `undefined`.
`DirectorySandbox` removes it before spawning. Container, Kubernetes, AWS,
Cloudflare, Vercel, and Daytona apply guest `env -u`; AWS requires its streaming
transport. Cloudflare (both execution modes), Vercel, and Daytona require
`/usr/bin/env` and `/bin/sh` in the guest and apply removals before assignments.
Microsandbox applies the same guest removal before its configured shell, inside
`nix develop` when configured. Deletion requires an absolute configured shell path, otherwise `spawn_error`.
JustBash refuses deletion with `spawn_error` before executing the command.
See [Remote commands](./concepts/remote-commands.md#environment-names-are-checked-before-the-command-runs).

## "just-bash: environment deletion is unsupported"

**What happened.** An `env` entry was `undefined`. The injected interpreter
interface merges string values and cannot remove an inherited value, so the
provider refused with `ProviderError` code `spawn_error` before `exec`.

**What to change.** Use a provider that supports deletion. Omit the entry only
when retaining the inherited value is intended.

## "deletes-inherited-environment-or-refuses"

**What happened.** Conformance could not observe guest `HOME` before deletion,
or the deletion request neither removed it nor failed with a typed spawn refusal.

**What to change.** Provision the test guest with `HOME` set, preserve
`undefined` overrides, and apply deletion inside the guest before running the
command. A test that only removes a command default does not prove deletion of
an inherited guest value.

## Two runs fought over one machine

**What happened.** Two live holders acquired the same session key. They were
served the same machine, and the first scope to close tore it down under the
other.

**What to change.** Give concurrent work distinct keys. Reuse a key only to
resume, which is the case reattachment exists for. See
[Sessions and their keys](./concepts/sessions.md).

## "cannot ... : no command transport was supplied"

**What happened.** `AwsSandbox` was constructed without `exec`. The session
still provisions and tears down tasks, but the ECS API alone carries no command
output, so `spawn`, `readFile`, and `writeFile` refuse with `unavailable`.

**What to change.** Pass `exec: { spawner }`, and install the `aws` CLI and
`session-manager-plugin` on the machine running the provider. File writes and
spawns with stdin or environment overrides also require `exec.streamingSpawner`.
That adapter must deliver stdin byte-exactly without echo or argv encoding;
a normal CLI spawner is insufficient. Without it, these operations fail with
`unavailable` before transfer. See [AwsSandbox](./api.md#awssandbox).

## "microsandbox: image and snapshot are exclusive; name one"

**What happened.** `MicrosandboxSandbox.make` received both. The refusal
happens before any vendor call.

**What to change.** Name one. With an `environment` and no `image`, the microVM
boots `nixos/nix`.

## "the check did not finish within N milliseconds"

**What happened.** A conformance check outlived `CheckOptions.checkTimeout`
(10 seconds by default), measured on the platform timer rather than the
ambient `Clock`.

**What to change.** Find what does not answer. A common cause is a provider
that declares `stdin: true` and drops the input, which leaves the `cat` fixture
waiting forever. Raise `checkTimeout` only for a backend that genuinely
provisions a slow machine per check.

## "the command was still running after the signal"

**What happened.** The provider's `kill` returned success and left the command
running. That satisfies the type and leaks a process inside the sandbox for
every cancelled action, so the check waits `Commands.stopsWithin` and reports
it.

**What to change.** Signal the process itself, not the local client. The
bundled container providers record each command's guest pid in a
session-private pidfile and signal descendants before the root.

## "the command's work was still running after its handle reported it stopped"

**What happened.** The `survivor` fixture found the signalled command's work
alive after its wrapper exited. A shell that dies while its child lives on
satisfies every observation the process handle allows, and this check is the
second look.

**What to change.** Walk descendants and signal children before the root, and
make sure the wrapper does not exit ahead of its own child.

---
title: "Sessions and their keys"
description: "What a session key claims, how a machine's name is derived from it, what reattachment recovers after a crash, and why closing the scope is the only way a session ends."
sidebar:
  order: 2
---

`Provider.acquire(key)` turns a session key into a held machine. The key is the
only thing a caller says about which machine it wants, so what the key means is
worth being exact about.

## The key is an exclusive claim

Two live holders of one key are served the same machine, and the first of them
to close its scope tears that machine down under the other. Give concurrent
work distinct keys. Reuse a key to resume, which is the case reattachment
exists for.

Nothing in the package enforces this. It cannot: the providers reach different
backends, and several of them find a machine by asking the vendor for a name.
Treat the key the way you would treat a lock file.

## The key becomes the machine's name

Every bundled provider derives its machine's name from the key the same way:
the key's leading name-safe characters, bounded at 40, for the operator reading
a container or process list, plus a 64-bit digest of the whole key.

The digest is what keeps `a/b` and `a-b` on separate machines, and what keeps
two keys that merely start alike apart. It is two independent multiplicative
hashes concatenated, not one, because a single 32-bit hash with a linear tail
collides as soon as two keys sharing a truncated prefix satisfy one modular
sum. That is a bound, not a proof: this is a checksum and not a cryptographic
digest, and the honest claim is 64 bits over the whole key rather than
collision proof.

The slug is durable machine identity. It becomes every provider's container
name, Pod name, sandbox name, Durable Object id, ECS `startedBy` tag, and
scratch directory, so changing how it is computed orphans whatever is running
under the old names.

## Reattachment is per provider, and it is not persistence

A key lets an implementation deterministically name and find a machine a
previous acquire left behind. That is what makes a crash-interrupted run resume
on the machine it was using. What survives depends on the backend and on what
the finalizer does:

| Provider              | Reattach on the same key                                        | What a normal release leaves                                         |
| --------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| `DirectorySandbox`    | the recursive create finds a crash-left directory and its files | nothing; the directory is removed                                    |
| `ContainerSandbox`    | a refused create whose name `container inspect` finds           | nothing; `rm --force` ends the container                             |
| `KubernetesSandbox`   | an `AlreadyExists` Pod sealed under the same `reattachKey`      | nothing; the Pod is force deleted                                    |
| `MicrosandboxSandbox` | `sandboxAlreadyExists` connects or restarts                     | nothing for `ephemeral`; a `sticky` machine stays running on purpose |
| `VercelSandbox`       | `getOrCreate` with `persistent` and `resume`                    | the persistent sandbox, stopped                                      |
| `DaytonaSandbox`      | `get(name)` before `create`                                     | nothing; teardown deletes the sandbox                                |
| `AwsSandbox`          | `ListTasks` by the `startedBy` tag adopts a leftover            | nothing; `StopTask` runs on the scope                                |
| `CloudflareSandbox`   | the Durable Object id is derived from the key                   | nothing; the object is destroyed                                     |
| `JustBashSandbox`     | not applicable, the session is in process                       | nothing; the directory is removed                                    |

Read the middle column as crash recovery, not as storage. Only
`MicrosandboxSandbox` with `persistence: "sticky"` and `VercelSandbox` are
designed to be there after a clean release, and only the first is running.

To keep what a body changed in a checkout, capture it before release:
`Sandbox.run` returns it as `Work`, which an action journals and
`SandboxMerge.apply` lands on the host. See
[Return work from a sandbox](../guides/return-work-from-a-sandbox.md).

## The scope is the lifetime

Acquisition registers teardown as a finalizer of the acquiring scope. Closing
that scope is the only lifecycle end exposed to the caller: no `destroy` method
to forget, and no `AbortSignal` threaded through the call graph. Interrupting
an execution closes the scope and therefore runs the provider's cancellation
finalizer. Container, Kubernetes, Vercel, Daytona, Cloudflare, and AWS provider
cleanup operations each have a five-second wall-clock bound. A timeout logs a
Warn naming the resource and requests cancellation without waiting for the
transport to finish. Scope closure can therefore finish while a remote resource
still needs operator cleanup.

The same rule holds one level down. `Session.spawn` is scoped, so a spawn's
scope is the process's lifetime. When a provider declares `kill`, the adapter
signals a still-running command as that scope closes, ahead of the provider's
own release, and leaves alone a process it has already seen exit.

## Generations, when a session is reopened

`Sandbox.commandProvider` and `SandboxSupervision` reopen sessions:
supervision retires an unhealthy one and lets the next command open a fresh
generation. The held session is cleared only by its own finalizer's identity
check, so a stale generation closing late cannot null out the session a newer
open installed.

`commandProvider` resolves the held session when each `spawn`, `kill`, or `ping`
effect runs. Effects can be composed before `open` runs. Reusing an effect
after reopening uses the current generation; running it with no open session
fails with `unavailable`.

`Sandbox.layerHost` does not reopen sessions. It holds one session for the
layer's lifetime and reports a dead machine as a failure. Retiring and
reopening is right for a transport, where a command is the whole unit of work,
and wrong for a placed body, which has been writing to this machine: swapping
it mid-action would discard those writes and hand the body an empty tree that
still looks like its workspace. Re-provisioning belongs to whoever retries the
action, and the retry acquires the key again.

## Standard input is staged inside the session

Most vendor execution APIs take a command line and nothing else, so a session
with no input channel satisfies its "spawn delivers stdin" obligation by
writing the bytes into the workspace and redirecting the command from the file.
The command runs verbatim inside a subshell with its own exit status. Newlines
separate it from the subshell delimiters, preserving trailing shell comments
and heredoc terminators on the final line.

Two properties of that staging are guarantees, and one commonly assumed
property is not:

- The name is unguessable, drawn from Web Crypto, under a session-private
  `.smthrs-stdin` directory in the workspace. A per-session counter was not
  unguessable: it reset on every acquire, so a reattached machine started again
  at the first name and could read the previous incarnation's input, which is
  where a caller puts a script, a patch, or a credential blob.
- Removal is a finalizer of the spawn's scope, registered before the first byte
  is written, so removal is attempted even after a killed or interrupted
  command or a partial write. No provider writes a file atomically. The finalizer
  checks the guest removal status, including AWS's exit sentinel, and logs a Warn
  on failure. Removal has a five-second wall-clock bound; a failure or timeout
  can leave staged bytes on the machine and requires operator cleanup.
- The file's mode is the machine's umask, like any other file the session
  writes. The staging file is created through `Session.writeFile`, and the
  session contract has no mode.

## Read next

- [What a sandbox does and does not prevent](./isolation.md).
- [Return work from a sandbox](../guides/return-work-from-a-sandbox.md).
- [Supervise a session](../guides/supervise-a-session.md): probing a session
  and retiring a dead one.

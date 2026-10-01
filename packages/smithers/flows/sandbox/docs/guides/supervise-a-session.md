---
title: "Supervise a session"
description: "Probe a sandbox for liveness with SandboxHealth, and use SandboxSupervision so a session that dies fails its commands instead of leaving them waiting forever."
sidebar:
  order: 5
---

A dead sandbox is silent. Its streams stop producing and its exit codes never
arrive, so under the plain adapter an action waits forever. This guide covers
the two pieces that fix that: a probe that reports a verdict, and a supervisor
that acts on one.

## Probe for a verdict

```ts
import { SandboxHealth } from "@smthrs/sandbox"

const health = SandboxHealth.make(provider, { deadline: "10 seconds" })
const state = yield* health.check
```

`probe` never fails. A failed ping becomes
`Unhealthy({ component: "sandbox", reason: "ping_failed" })` and a ping that
outlives the deadline (5 seconds by default) becomes
`Unhealthy({ reason: "unresponsive" })`. That distinction is the point: it is
what separates "sandbox dead" from "slow command", because the probe answers
within the deadline either way.

`component` is always `"sandbox"`, so "the engine is alive and the sandbox is
dead" is an explicit diagnosis rather than something inferred from a generic
provider error.

Two constructors cover the cases, each with a layer form:

| Constructor                                           | Use when                     |
| ----------------------------------------------------- | ---------------------------- |
| `make(provider, options)`, `layer(provider, options)` | you hold a provider to probe |
| `makeNoop()`, `layerNoop`                             | there is no sandbox to watch |

`ping` is optional on a provider, so `make` answers with the noop service for a
provider that has none. Read a `Healthy` verdict from it narrowly: it says
nothing is watching the machine, not that the machine is alive. A provider that
wants to be supervised implements `ping`.

## What the probe will not log

A failed ping is logged at debug level as the provider's `code` and its
`message`, bounded at 512 characters with control characters collapsed to
spaces, and the verdict carries that same bounded message.

The `ProviderError` and its `cause` never reach a logger from the probe.
Adapters attach raw vendor errors to `cause`, and those can quote credentials,
request headers, proxies, or response bodies; rendering an arbitrary object can
also throw or run without bound. A host that wants the raw failure taps the
ping it hands in with `Effect.tapError` and applies its own redaction.

## Supervise a transport

`SandboxSupervision.layer` accepts a `RemoteChildProcessSpawner.Provider`.
For a lifecycle provider, use `Sandbox.commandProvider` to acquire the session
and expose its command, ping, and kill operations. Declare only capabilities
that the acquired session supports; container sessions support both below.

```ts
import { ContainerSandbox, Sandbox, SandboxSupervision } from "@smthrs/sandbox"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

// Supply the host spawner that runs the container CLI.
declare const hostSpawner: ChildProcessSpawner["Service"]

const provider = ContainerSandbox.make({ spawner: hostSpawner, image: "node:22" })
const session = "run:01J..."
const commandProvider = Sandbox.commandProvider(provider, {
  session,
  provides: { ping: true, kill: true }
})
const spawner = SandboxSupervision.layer(commandProvider, {
  interval: "10 seconds",
  tolerance: 2
})
```

Use it in place of `RemoteChildProcessSpawner.layer` when the provider can be
pinged. It holds a single session, probes it on `interval`, and retires it
after `tolerance` consecutive unhealthy verdicts (default 1; one healthy answer
resets the count). Raise `tolerance` to ride out a probe that lost a race with
a loaded machine.

Retiring fails everything running in the session with a `NotFound`
`PlatformError`, the same reason a session that refused to open produces,
because both say the same thing to a retry policy: try again somewhere else. It
then closes the session scope so the provider's finalizer runs, and lets the
next command open a fresh session.

Two properties are worth relying on:

- **The session opens on the first command, not while the layer builds.** A
  host that never spawns anything does not pay for a sandbox, and a provider
  that is down fails the action that needed it rather than the composition
  root. An open that fails leaves the cell empty, so the next command opens a
  fresh generation instead of replaying the first failure.
- **A provider without `ping` is never probed.** Wrapping one in supervision
  costs nothing and changes nothing.

## Report a retirement somewhere useful

```ts
const supervised = SandboxSupervision.layer(commandProvider, {
  interval: "10 seconds",
  reporter: {
    unhealthy: (event) => recordSandboxDeath(event)
  }
})
```

`SandboxUnhealthy` carries the session key, the reason, the probe's message,
and how many consecutive unhealthy probes reached the verdict. It is a schema
class rather than a log line because a control plane records it: a run that
failed because its sandbox died reads very differently from a run that failed
on its own, and only this event tells them apart. The default reporter logs a
warning.

Retirement fails pending operations and output consumers, including output
still pending after process exit, then closes the provider scope. These steps
run uninterruptibly under the spawn permit. The permit is released before the
reporter is forked in the supervisor's scope, so reporting delays neither new
commands nor the heartbeat. Reporter failures are logged at Warn. An
interruptible reporter still pending after 30 seconds is interrupted on the
platform timer. A provider release failure is logged at Warn with the session
key; the retirement is still reported and later sessions are still probed.

## Do not supervise a placed body

`Sandbox.layerHost` deliberately has no equivalent. Retiring and reopening is
right for a transport, where a command is the whole unit of work, and wrong for
a body that has been writing to the machine. See
[Place a flow body on a machine](./place-a-flow-body-on-a-machine.md).

## Read next

- [Troubleshooting](../troubleshooting.md): what an unhealthy verdict and a
  retirement look like from the caller's side.

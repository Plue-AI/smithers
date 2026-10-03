---
title: "API reference"
description: "Every public export of @smthrs/sandbox: the two provider seams, the derived host surfaces, health and supervision, both conformance suites, and all ten bundled machine providers."
---

`@smthrs/sandbox` adapts a provider a caller hands it onto Effect's host
services. The smallest composition adapts a spawn-only provider onto
`ChildProcessSpawner`:

```ts
import { RemoteChildProcessSpawner } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const provider = RemoteChildProcessSpawner.TestRemote.make({
  scripts: { "echo hi": { stdout: "hi" } }
})

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("echo", ["hi"]))
}).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
```

The package depends on `@smthrs/kernel`, for `CommandLine` rendering and quoting alone, and on no other Smithers package: a sandbox is one way to satisfy Effect's `ChildProcessSpawner`, not a new host interface a caller has to learn. It bundles for the browser because host access arrives through a provider or through injected host services.

## Entry points

Every namespace is also its own subpath, and `./internal/*` is null mapped.

| Import                                      | Source                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@smthrs/sandbox`                           | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sandbox/src/index.ts)                                    |
| `@smthrs/sandbox/RemoteChildProcessSpawner` | [src/RemoteChildProcessSpawner/](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/sandbox/src/RemoteChildProcessSpawner) |
| `@smthrs/sandbox/ProviderConformance`       | [src/ProviderConformance/](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/sandbox/src/ProviderConformance)             |
| `@smthrs/sandbox/Sandbox`                   | [src/Sandbox/](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/sandbox/src/Sandbox)                                     |
| `@smthrs/sandbox/SandboxConformance`        | [src/SandboxConformance/](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/sandbox/src/SandboxConformance)               |
| `@smthrs/sandbox/SandboxMerge`              | [src/SandboxMerge/](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/sandbox/src/SandboxMerge)                           |
| `@smthrs/sandbox/DirectorySandbox`          | [src/DirectorySandbox/](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/sandbox/src/DirectorySandbox)                   |
| `@smthrs/sandbox/CommandSandbox`            | [src/CommandSandbox/](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/sandbox/src/CommandSandbox)                       |
| `@smthrs/sandbox/ContainerSandbox`          | [src/ContainerSandbox/](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/sandbox/src/ContainerSandbox)                   |
| `@smthrs/sandbox/KubernetesSandbox`         | [src/KubernetesSandbox/](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/sandbox/src/KubernetesSandbox)                 |
| `@smthrs/sandbox/JustBashSandbox`           | [src/JustBashSandbox/](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/sandbox/src/JustBashSandbox)                     |
| `@smthrs/sandbox/MicrosandboxSandbox`       | [src/MicrosandboxSandbox/](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/sandbox/src/MicrosandboxSandbox)             |
| `@smthrs/sandbox/VercelSandbox`             | [src/VercelSandbox/](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/sandbox/src/VercelSandbox)                         |
| `@smthrs/sandbox/DaytonaSandbox`            | [src/DaytonaSandbox/](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/sandbox/src/DaytonaSandbox)                       |
| `@smthrs/sandbox/AwsSandbox`                | [src/AwsSandbox/](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/sandbox/src/AwsSandbox)                               |
| `@smthrs/sandbox/CloudflareSandbox`         | [src/CloudflareSandbox/](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/sandbox/src/CloudflareSandbox)                 |
| `@smthrs/sandbox/SandboxHealth`             | [src/SandboxHealth/](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/sandbox/src/SandboxHealth)                         |
| `@smthrs/sandbox/SandboxSupervision`        | [src/SandboxSupervision/](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/sandbox/src/SandboxSupervision)               |

## RemoteChildProcessSpawner

Provider acquisition is tied to the layer scope: interrupting an execution or a stream consumer closes that scope and therefore runs the finalizer installed by `Provider.open`. No `AbortSignal` crosses this seam.

The fault registry classifies provider `unavailable` and `timeout` failures as
`infra`; `spawn_error`, `not_found`, `unknown` and `aborted` are `bug`. A nested
registered cause retains its own classification. Repeat-safe actions without a
declared retry policy use the engine's bounded transient infrastructure policy.

A provider may add SDK details to `ProviderError.cause`, but it cannot create new host-visible failure kinds. The code set is closed, and one shared table normalizes each code onto the `PlatformError` reason that already means it: `timeout` becomes `TimedOut`, `unavailable` and `not_found` become `NotFound`, everything else becomes `Unknown`, under the `ChildProcess` module the sibling spawners name. `not_found` and `unavailable` stay apart in the provider vocabulary, where "absent" and "broken" are different facts; they say the same thing to a caller of a spawner, which is to try somewhere else, and a caller that needs the distinction reads the `ProviderError` back off `PlatformError.cause`. `Sandbox.fileSystem` is the one deliberate exception: there `unavailable` stays `Unknown`, because a filesystem's `NotFound` is load bearing (`exists` turns it into `false`) and a broken session must not read as an absent path.

`Provider.kill` and `Provider.ping` are optional, because a transport that can only post a command line has neither. A provider that implements them buys two things it cannot otherwise have: one command can be stopped without tearing down the session that runs it, and the session's liveness can be supervised. When `kill` is present the adapter maps `ChildProcessHandle.kill` onto it and signals a still-running command when its scope closes, ahead of the provider's own release finalizer; a process this side has already seen exit is left alone. When `kill` is absent the adapter refuses with a `BadArgument` `PlatformError` rather than pretending to have delivered a signal.

The command reaches the provider as the string `CommandLine.render` produces. `@smthrs/kernel`'s `proc:spawn` check is written against `CommandLine.resource`, which starts from that string and adds a `sh -c` wrapper for a shell line holding control syntax, an `env <NAME>… --` prefix for overridden environment names, and a `cwd <path> --` prefix for a directory outside the workspace. The two strings match only when none of those apply.

Unsupported semantics are declared rather than dropped. Each of these fails with a `BadArgument` `PlatformError` before the provider is asked to start anything:

| Refused                                                           | Why                                                                                                        |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| a stdin stream for a provider that does not declare `stdin: true` | the bytes would be silently lost                                                                           |
| a stdin stream on any stage of a pipeline but the first           | a later stage reads its predecessor                                                                        |
| `stdin: "inherit"`                                                | a local spawner hands the child this process's own standard input; a remote command would read EOF instead |
| additional file descriptors                                       | nothing carries them across                                                                                |
| a shell path, or `detached: true`                                 | the local host's vocabulary                                                                                |
| non-default pipeline routing (`from`, `to`)                       | the rendered line reaches the remote shell, not this adapter                                               |
| `kill` on a provider that declares none                           | no signal can be delivered                                                                                 |

`stdin: "pipe"`, `"ignore"`, and `"overlapped"` are accepted and all three mean the command reads no input, which is what they mean locally. A provider that declares `stdin: true` receives the command's input as one complete byte blob in `RemoteOptions.stdin`, never as a live pipe: collection is bounded at 16 MiB and the count runs as the bytes arrive, so an endless producer is refused at the bound rather than after it finishes. The handle's own `stdin` sink always fails, because there is no interactive channel either way. Output `pipe`, `ignore`, and `inherit` options and output sinks are applied by the adapter.

:::caution[Two divergences the error channel cannot report]
`extendEnv` is ignored, because the remote session's ambient environment never crosses the seam and `extendEnv: false` cannot clear an environment this side never held. `isRunning` answers from what this side has observed: the adapter forks a scoped observer of the provider's exit at spawn and memoizes it, so liveness turns `false` when that observation lands, which can lag the remote process by a scheduler tick but does not depend on a caller reading `exitCode`.
:::

The code set belongs to this seam, because a remote session goes wrong in ways a local spawn has no vocabulary for. Like the health reasons below, the codes are a stable public contract: a new kind of failure gets a new code rather than repurposing an existing one.

## SandboxHealth

`SandboxHealth` answers one question about a session that is already open: is the machine still there? It is a verdict vocabulary plus a probe, not a supervisor, so nothing here runs on a cadence. `SandboxSupervision` below is what probes on an interval and acts on the answer.

`probe` never fails: a failed ping becomes `Unhealthy(reason: "ping_failed")`, and a ping that outlives the deadline (5 seconds by default) becomes `Unhealthy(reason: "unresponsive")`. That is what distinguishes "sandbox dead" from "slow command": the probe answers within the deadline either way. `Unhealthy.component` is `"sandbox"`, so an "engine alive, sandbox dead" diagnosis is explicit rather than inferred from a generic provider error.

A failed ping is logged at debug level as the provider's `code` and its `message`, and the verdict carries that same message, bounded at 512 characters with control characters collapsed to spaces. The probe never logs the `ProviderError` object or its `cause`. Bundled SDK adapters keep raw vendor exception text in `cause` and use controlled ping failure messages. Cause omission is not message redaction: a custom provider must keep credentials and other sensitive data out of `ProviderError.message`, since both Debug logging and the verdict expose it. A host that wants the raw failure taps the ping it hands in (`Effect.tapError` on `PingProvider.ping`) and applies its own redaction.

Reasons, like the host error codes, are a stable public contract: never repurpose one, add one.

## SandboxSupervision

`SandboxHealth` reports a verdict; supervision is what acts on one. It holds a single provider session, probes it on `interval`, and retires it after `tolerance` consecutive unhealthy verdicts (default 1; one healthy answer resets the count). Retiring fails every pending operation and output consumer in the session with a `NotFound` `PlatformError`, the same reason a session that refused to open produces, because both say the same thing to a retry policy. Output consumers remain guarded after process exit until their own streams finish. Retirement then closes the session scope so the provider's finalizer runs, and lets the next command open a fresh session. That failure is the point: under the plain adapter a session that dies leaves its commands waiting forever, because a dead session is silent.

Retirement fails pending consumers and closes the provider scope uninterruptibly while holding the spawn permit. It then releases the permit and forks the reporter in the supervisor's scope, so a slow reporter delays neither new commands nor the heartbeat. Reporter failures are logged at Warn, and an interruptible reporter still pending after 30 seconds is interrupted on the platform timer. A provider release failure is logged at Warn with the session key; the retirement is still reported and probing continues for later sessions.

The session opens on the first command, not while the layer builds: a host that never spawns anything must not pay for a sandbox, and a provider that is down must fail the action that needed it rather than the composition root. An open that fails leaves the cell empty and closes its own scope, so the next command opens a fresh generation instead of replaying the first failure. A provider without `ping` is never probed, so wrapping one in supervision costs nothing and changes nothing.

```ts
import { SandboxSupervision } from "@smthrs/sandbox"

const spawner = SandboxSupervision.layer(provider, { interval: "10 seconds", tolerance: 2 })
```

## ProviderConformance

The contract a spawn-only provider must satisfy is stated as behavior, so your adapter can run the statement against the backend it actually talks to:

```ts
import { ProviderConformance } from "@smthrs/sandbox"

const violations = yield* ProviderConformance.check(provider, {
  writes: "sh -c 'printf hello'",
  output: "hello",
  fails: "sh -c 'exit 3'",
  failureCode: 3,
  runs: "sh -c 'sleep 60'",
  shell: true
})
```

`Commands.shell` defaults to `false`. Set it to `true` when the fixture strings are shell lines; the suite then renders them verbatim instead of POSIX quoting each whole string as one program token. `SandboxConformance.posixCommands` sets it for its POSIX fixtures.

The checklist:

| Check                       | What the provider must do                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writes-its-output`         | `writes` puts exactly `output` on stdout and exits 0                                                                                                  |
| `reports-a-nonzero-exit`    | `fails` reports `failureCode` as an exit code, not as a failure                                                                                       |
| `delivers-standard-input`   | a provider that declares `stdin: true` hands the bytes to the command, proven by running `Commands.copiesStdin` (default `cat`) and reading them back |
| `answers-a-ping`            | a declared `ping` answers while the session is open                                                                                                   |
| `signals-a-running-command` | a declared `kill` stops a live process                                                                                                                |

The stdin check exists because the declaration is what makes the adapter hand the bytes over. A suite that took `stdin: true` at its word would pass an adapter that sets the flag and then ignores `RemoteOptions.stdin`, which is exactly the silent input loss the flag was added to close.

The kill check watches the process, not the call. A `kill` that returns success and leaves the command running satisfies the type and leaks a process inside the sandbox for every cancelled action, so the check waits for `runs` to stop and reports `the command was still running after the signal` when it does not. How it stopped is not the subject: a provider that reports a signalled process as a failed `exitCode` is as conforming as one that reports a status. `Commands.stopsWithin` bounds the wait, defaulting to `ProviderConformance.defaultStopsWithin` (5 seconds). The handle is only the wrapper, though, and a shell that dies while its child lives on satisfies every observation the handle allows, so a fixture may also name `Commands.survivor`: a command that exits zero while the signalled command's work is still alive. It runs in the same session after the exit is observed, and a zero exit is the violation `the command's work was still running after its handle reported it stopped`.

Every check runs under `CheckOptions.checkTimeout` (10 seconds by default), measured on the platform timer rather than the ambient `Clock`, and covering session acquisition and stream consumption as well as the call itself. A provider that never answers is convicted with a named violation instead of hanging the suite, and it is convicted under a frozen test clock too.

The checks run through `RemoteChildProcessSpawner.layer`, because a provider that satisfies the interface but not the adapter is of no use to a caller, and each check gets a fresh session so a check that leaves one unusable cannot decide the next. The optional capabilities are checked only when the provider declares them: an absent `ping`, `kill`, or `stdin` is a documented absence, not a defect.

## Sandbox

`Session` is a machine contract, not just a command transport. Its file operations and spawned commands must see the same tree.

| Obligation        | Required behavior                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| default directory | `spawn(command, {})` runs in `Session.workdir`                                                                                                  |
| relative cwd      | a relative `cwd` is taken under `workdir`, never under the transport's own directory                                                            |
| standard input    | `spawn` delivers `options.stdin` bytes as the command's complete input; a transport with no input channel stages a workspace file and redirects |
| parent creation   | `writeFile` creates missing parent directories                                                                                                  |
| absence           | `readFile` fails with `ProviderError.code === "not_found"` when the path is absent                                                              |
| contents          | file contents cross as bytes and round-trip unchanged                                                                                           |
| optional control  | `ping` keeps the spawner-level meaning; a declared `kill` ends the command and everything it started, not only the shell that wrapped it        |

```ts
import { Sandbox } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"

const useMachine = Effect.scoped(
  Effect.gen(function*() {
    const session = yield* provider.acquire("run:01J...")
    yield* session.writeFile(`${session.workdir}/src/input.bin`, bytes)
    const process = yield* session.spawn("test -f src/input.bin", {})
    return yield* process.exitCode
  })
)
```

`Provider.acquire(key)` is scoped. Ephemeral providers register machine teardown as a scope finalizer. Retained providers advertise `retained: true`, leave the machine running, supply attach-only `attach(identity)`, and end it through explicit idempotent `destroy(identity)`. A missing or uncertain machine is never provisioned by `attach`. The stable key names crash-left machines; image, memory, and network policy belong to provider construction.

`Sandbox.job(provider, { command, files, capture, jobDirectory? })` adapts a retained provider to start, status, collect, and cancel. `JobHandle` and `JobResult` are its durable schemas. Collect requires a shared durable Effect `KeyValueStore` and stores output plus `Work` before destroying the machine. See [retained jobs](./guides/retained-jobs.md) for process fencing, replay, cleanup, and executed host-death evidence.

Vercel, Daytona, Cloudflare, AWS, and Microsandbox tolerate teardown failures and log Warn records containing only the adapter's provider name, operation, and error code. Error messages and SDK causes are omitted. For teardown diagnostics, explicitly instrument the injected SDK's release method and redact captured errors before emitting a record.

`ContainerSandbox`, `KubernetesSandbox`, and `AwsSandbox` stamp a SHA-256 fingerprint of the provider, full session key, and requested machine configuration in `smithers.dev/sandbox-fingerprint` labels or tags. Reattachment requires matching metadata; missing, malformed, or mismatched inspection data fails with `unavailable` before starting, executing in, or deleting the candidate. This also applies before replacing terminal Pods or stopping duplicate ECS tasks. Leftovers created before fingerprinting must be removed explicitly before that key can be acquired again. Container image, workdir, and network mode and the Pod image and explicit service account are also checked against inspection output. With no `createArgs`, reattachment rejects host-networked or privileged Pods and host bind mounts in containers or hostPath volumes in Pods. The fingerprint includes all `createArgs`, environment, network, and role options; it is a configuration identity check, not attestation against an administrator who can rewrite provider metadata.

Every bundled provider derives its machine's name from the session key the same way: the key's leading name-safe characters, for the operator reading a container or process list, plus a 64-bit digest of the whole key. The digest is what keeps `a/b` and `a-b` on separate machines, and what keeps two keys that merely start alike apart. It is a checksum and not a cryptographic one, so 64 bits over the whole key is the claim rather than "collision proof", and because the slug IS durable machine identity, changing it orphans whatever is running under the old names.

Standard input for a transport with no input channel is staged under a session private directory in the workspace, `.smthrs-stdin`, under an unguessable name, and its removal is a finalizer of the spawn's scope rather than a `rm` appended to the command. The finalizer is registered before the first byte is written, so a write that fails partway still has its partial file taken away: no provider writes a file atomically, and `AwsSandbox` sends one remote round trip per `ExecTransport.chunkBytes` bytes. A killed or interrupted command therefore does not leave the caller's script, patch, or credential blob on the machine, and a reattached session cannot read a previous incarnation's staging file by guessing its name. What is guaranteed is the unguessable name and the scope-bound removal: the staging file is created through the session's own `writeFile`, so its mode is the machine's umask like any other file the session writes.

`commandProvider(provider, options)` projects the lifecycle back onto the spawn-only provider. Existing `RemoteChildProcessSpawner` adapters, `SandboxHealth.make`, `SandboxSupervision`, and `ProviderConformance` then compose unchanged. `options.provides` declares `kill` and `ping` before acquisition, because the projected provider must expose those capabilities statically; `stdin` is not among them, because delivering it is an obligation of every session rather than a capability a session may lack. A supervision retire-and-reopen cycle acquires a new generation; an older generation's late finalizer cannot clear the newer held session.

`fileSystem(session)` uses `Session.readFile` and `Session.writeFile` for byte transfer. It derives `exists`, `stat`, `makeDirectory`, `readDirectory`, `remove`, `rename`, `realPath`, and `readLink` with POSIX `sh` probes. Entries in `session.files` override the derived operations one by one, and an override is installed through the workdir resolver rather than beside it, so a native operation receives the rooted path without re-implementing the rule. Both arguments are rooted where both are paths the machine must reach (`rename`, `copyFile`, `link`); `symlink` is the exception, because its first argument is the text stored inside the link and POSIX resolves a relative one against the link's own directory, so rooting it would move where the link pointed. Other `FileSystem` operations retain `makeNoop`'s explicit refusal rather than simulating watches, open handles, or temporary directories.

The probe surface is intentionally honest. `stat` reports exact file size, but mode is `0` and times and ownership are absent. Directory listings are NUL framed through `find -print0`, so a filename may hold a newline, and no pseudo-terminal transport can columnize them. Probes require the named POSIX utilities on the machine.

```ts
const machineHost = Sandbox.layerHost(provider, {
  session: "run:01J...",
  health: { deadline: "10 seconds" }
})
```

`layerHost` acquires one session for the layer scope and derives `ChildProcessSpawner`, `FileSystem`, and `Path` from it. This layer context is what a caller hands to an agent's standard filesystem and shell tools to place both on the same machine. When the provider supplies isolation, the machine boundary, not a path guard, denies ambient host access. Closing the layer scope runs provider teardown.

The layer also serves `SandboxHealth`, built with `SandboxHealth.make` over the held session, so a caller can ask whether the machine is still there. `options.health` is the probe's `ProbeOptions`; its `deadline` defaults to 5 seconds. A session without `ping` yields the noop probe, which always answers `Healthy`. That is not a claim the machine is alive; it says nothing is watching it.

What `layerHost` deliberately does not do is what `SandboxSupervision` does for the spawn-only seam: retire an unhealthy session and open a fresh one behind the caller's back. That is right for a transport, where a command is the whole unit of work, and wrong here, because the body holding these services has been writing to this machine. Swapping it mid-action would silently discard those writes and hand the body an empty tree that still looks like its workspace. A dead machine surfaces as a failure instead, and re-provisioning belongs to whoever retries the action, which acquires the session key again.

```ts
const children = Sandbox.fanOut(session, { count: 16 }) // Effect<ReadonlyArray<Session>, ProviderError, Scope>
```

`fanOut(session, { count, concurrency? })` forks `count` children, 1 to `maxFanOut` (128), from a session that declares `fork`. Each run is a new batch: it forks one base from the session, then every child from that base, so the children share one starting tree while the session keeps changing. Children are keyed `<session id>/<batch>/child-<n>`, start without the session's credentials, and are released with the base when the acquiring scope closes, so a fan-out inside the parent's scope never outlives the parent. A count outside the bound throws a `RangeError`; a machine without `fork` fails with `unavailable`; one failed fork fails the fan-out, and machines already forked are released with the scope. `DirectorySandbox` forks by copying the session directory without vendor sign-ins (`.claude/.credentials.json`, `.claude.json`, `.codex/auth.json`, `.config/anthropic`); `TestSession` forks its in-memory tree and leaves behind the paths named in `credentials`.

### Return work from a session

```ts
const { result, work } = yield * Sandbox.run(provider, { session: "issue:42" }, agent)
```

`run(provider, options, body)` acquires one session, runs `body` with the session's `Host` services (`ChildProcessSpawner`, `FileSystem`, `Path`, `SandboxHealth`), captures the checkout, and releases the session. It answers `{ result, work }` and fails with the body's error, `ProviderError`, or `CaptureError`. A body that fails captures no work.

| Option     | Default           | Meaning                                                                      |
| ---------- | ----------------- | ---------------------------------------------------------------------------- |
| `session`  | required          | the session key                                                              |
| `base`     | `HEAD`            | the git revision the work is measured from, resolved right after acquisition |
| `checkout` | `Session.workdir` | the guest path of the git work tree; it must be the work tree's top          |
| `health`   | 5-second deadline | the `SandboxHealth` probe options, as for `layerHost`                        |

The base is resolved after the provider hands over the session, so a provider that refreshes its checkout during acquisition is measured from the commit it refreshed to. In a jj-colocated checkout `HEAD` is the parent of the working-copy change, never a change made in the guest. The capture runs inside the scope that holds the machine, before teardown.

`Work` is `Changed { session, base, patch }` or `Unchanged { session, base }`, both `Schema.TaggedClass`. `base` is a full commit id. `patch` is `git diff --cached --binary --full-index --find-renames` from `base` to the checkout's final tree, computed through a private copy of the index: committed and uncommitted edits, untracked files, deletions, renames, mode changes, and binary contents are all included, and `.gitignore`d files are not. The checkout's index and history are not changed. The guest needs `git`.

`Sandboxed(resultSchema)` is `Schema.Struct({ result: resultSchema, work: Work })`. Use it as an action's success so the journal records the work with the result.

`resolveBase(session, { checkout?, revision? })` and `capture(session, { checkout?, base })` are the two halves `run` composes, for a caller that holds its own session. Call `capture` while the session is still held.

| `CaptureError.reason` | Cause                                                                     |
| --------------------- | ------------------------------------------------------------------------- |
| `not_a_repository`    | the checkout is not the top of a git work tree, or the guest has no `git` |
| `base_unresolved`     | the base revision names no commit in the checkout                         |
| `capture_failed`      | `git` failed while diffing                                                |

`hostContext(session, { health? })` builds the `Host` context `layerHost` provides from a session the caller already holds; it requires a `Scope`. `layerHost` and `run` both use it.

## SandboxMerge

```ts
import { SandboxMerge } from "@smthrs/sandbox"

const outcome = yield* SandboxMerge.apply(work, {
  repository: "/srv/repo",
  onto: "main",
  message: "Fix #42"
})
```

`apply(work, options)` lands a session's `Work` in a host jj repository as one jj change on `onto`. The patch is applied to its own base, then the change is rebased onto `onto`, so jj merges whatever `onto` gained since the base. It requires `ChildProcessSpawner` and `FileSystem`, and `jj` and `git` on the host's `PATH`.

| `ApplyOptions` | Default                  | Meaning                                                                     |
| -------------- | ------------------------ | --------------------------------------------------------------------------- |
| `repository`   | required                 | the host jj repository's root directory                                     |
| `onto`         | required                 | a jj revision naming one commit, the change's parent                        |
| `message`      | required                 | the change's description                                                    |
| `key`          | session, base, and patch | what makes two applications the same; the change id derives from it         |
| `fetch`        | `[]`                     | arguments to `jj git fetch` when the base is missing; `false` never fetches |
| `strategy`     | `recordConflicts`        | what a conflict means                                                       |

`Outcome` is `Merged { change, commit, onto }`, `Conflicted { change, commit, onto, paths }`, or the work's own `Unchanged`, which applies as nothing. `change` is the jj change id; `commit` and `onto` are commit ids. A `Conflicted` change exists and records jj conflicts in `paths`, as `jj rebase` would.

`apply` is idempotent per key: applying a key again answers the existing change's outcome. It never reads or writes a working copy (`jj --ignore-working-copy`). The commit is built with git plumbing through a private index in the repository's git store and imported through a temporary `smithers-sandbox/<change>` bookmark, deleted after the rebase. An apply interrupted between import and rebase finishes on the next call.

Host import and rebase share the Node/Bun jj workspace and store fences. Their
default 120-second deadline bounds acquisition of both fences only. Commands
and confirmed shared Git `index.lock` retries run beyond that deadline once
the fences are acquired. Missing-base fetches run before acquisition, with base
presence checked again inside the fences. Cancellation and acquisition timeout
preserve captured work and any pending imported change for the next call. An active Git lock is never removed; permanent VCS failures, private
index errors and source conflicts retain their existing behavior.

Conflict strategies run after the import/rebase fence is released, so a
resolver can use ordinary fenced jj operations without nested acquisition.
The acquisition deadline does not bound a custom resolver's effects.

`MergeError.cause` optionally retains the original failure. Fence errors keep
the full `JjError`, including its code and nested `lock_timeout` cause. Host
adapter loading is lazy and shared through one memoized, typed loader.

| `MergeError.reason`   | Cause                                                                     |
| --------------------- | ------------------------------------------------------------------------- |
| `base_not_found`      | the work's base is not in the repository, even after the configured fetch |
| `onto_unresolved`     | `onto` does not name exactly one commit                                   |
| `patch_rejected`      | the patch does not apply to its own base                                  |
| `conflict`            | `failOnConflict` met a conflict; `paths` names it                         |
| `resolution_rejected` | a resolver's answer still has conflicts or does not descend from `onto`   |
| `vcs_failed`          | `jj`, `git`, fence acquisition or host adapter loading failed             |

A `Strategy<E, R>` has one method, `onConflict(conflicted, repository)`, answering `Merged`, `Conflicted`, or a failure. `apply` lands the change before calling it.

| Strategy                | On conflict                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `recordConflicts`       | answers `Conflicted`; the default                                                                                                          |
| `failOnConflict`        | abandons the change and fails with `conflict`; the work stays in the journal                                                               |
| `resolveWith(resolver)` | the resolver answers `{ change }`; it must name one commit descending from `onto` with no conflicts on the way, else `resolution_rejected` |

`Repository` is what a strategy receives: `path`, the repository root, and `jj(args)`, which runs `jj -R <path> --ignore-working-copy` and answers standard output or fails with `vcs_failed`.

See [Return work from a sandbox](./guides/return-work-from-a-sandbox.md) for the two steps as flow actions.

## SandboxConformance

Conformance fixture scripts that exit unsuccessfully report a typed
`ProviderError` with code `unknown` and the exit status and stderr in its message.

```ts
import { SandboxConformance } from "@smthrs/sandbox"

const violations = yield* SandboxConformance.check(provider, {
  provides: { kill: true, ping: true }
})
```

Each check acquires a fresh session. The file checks verify binary, empty, and 64 KiB byte round-trips, `not_found`, parent creation, the default workdir and a relative `cwd`, environment delivery, standard input delivery (verified through `readFile`, so a pseudo-terminal transport is not penalized for its output), standard error arriving on one of the two streams, and a working release-then-reacquire cycle. Two checks deliberately cross surfaces: `files-reach-processes` writes through `writeFile` and measures the file with `wc -c` in a process, and `processes-reach-files` has a process produce a file that `readFile` must return, so a session serving files from anywhere but the machine its processes run on cannot pass. The suite then projects the provider through `Sandbox.commandProvider` and delegates spawn, exit, stdin, ping, and process-stop checks to `ProviderConformance`, whose kill check also runs the fixture's `survivor` probe: after a kill, a command that can still be found running on the machine is a violation even though its wrapper exited. Assert that the returned array is empty.

`CheckOptions.work` adds `captures-its-work` and `captures-no-work`, which run `resolveBase` and `capture` in the guest against a `WorkSeed`: a `git bundle` and the commit id `base` whose tree holds `workSeedFiles`. The guest needs `git`; the suite runs no host `git`.

`CheckOptions.checkTimeout` bounds every check, its own and the delegated suite's alike, on the platform timer. The default fixture is `uniquePosixCommands`, whose sleep duration is this process's own, so two suites running side by side on one host cannot mistake each other's fixture for a survivor. That uniqueness is drawn from Web Crypto and never from a process id, because this module is part of a browser-bundleable package and a free `process` identifier survives a bundle to throw in a browser.

## Providers

One row per bundled provider. Every cell is read from the provider's source and its tests. "Byte-exact command output" is about a command's own `stdout` and `stderr`; file transfer is byte-exact on all ten.

| Provider              | What a machine is                                                                 | How the vendor surface arrives                                                          | Reattaches an existing machine on the same session key                                                                        | Declares `kill`                                                      | Byte-exact command output                            | Proven against                                                                     |
| --------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `DirectorySandbox`    | one host directory under `root`                                                   | injected services: the host `FileSystem` and `ChildProcessSpawner`                      | yes, the recursive `makeDirectory` leaves a crash-left directory and its files in place                                       | yes, the host handle's signal                                        | yes                                                  | host directories and processes                                                     |
| `CommandSandbox`      | whatever an argv prefix reaches; the provider does not own its lifecycle          | injected spawner running the prefix, such as `ssh` with a workspace's arguments         | not applicable, the machine outlives the session; acquire wipes only the session's own pidfile directory                      | yes, a pidfile plus a `/proc` descendant walk                        | yes                                                  | host processes, and `ssh localhost` when it answers                                |
| `ContainerSandbox`    | one container from `image`, held on `sleep infinity`                              | injected spawner running a Docker-compatible CLI                                        | yes, a refused create whose name `container inspect` finds is reattached                                                      | yes, a pidfile plus a `/proc` descendant walk                        | yes                                                  | a real Docker daemon                                                               |
| `KubernetesSandbox`   | one Pod from `image`, held on `sleep infinity`                                    | injected spawner running `kubectl`                                                      | with `reattachKey`, a sealed `AlreadyExists` Pod is reattached                                                                | yes, the same pidfile script over `kubectl exec`                     | yes                                                  | a real Kubernetes cluster (OrbStack)                                               |
| `JustBashSandbox`     | one directory in a shared virtual filesystem; commands are interpreted in-process | injected interpreter slice (`JustBashLike`) and `FileSystem`                            | not applicable, in-process                                                                                                    | no                                                                   | no, `exec` reports output as strings                 | none, fake only                                                                    |
| `MicrosandboxSandbox` | one local microVM from an image or a snapshot                                     | injected SDK slice (`Sdk`)                                                              | yes, `sandboxAlreadyExists` connects to or restarts it; `persistence: "sticky"` keeps it running for that purpose             | yes, an in-guest descendant walk plus the SDK's process-group signal | yes, the SDK's byte-typed output, streamed           | a real Microsandbox microVM                                                        |
| `VercelSandbox`       | one named persistent Vercel sandbox                                               | injected SDK slice (`Sdk`) plus caller-supplied credentials                             | yes, `getOrCreate` with `persistent: true` and `resume: true`                                                                 | no                                                                   | no, `runCommand` reports output as strings           | none, fake only                                                                    |
| `DaytonaSandbox`      | one named Daytona sandbox                                                         | injected SDK slice: a configured `Daytona` client                                       | yes, `get(name)` first, `create` on a 404, `start` when attached                                                              | no                                                                   | no, `executeCommand` reports one `result` string     | none, fake only                                                                    |
| `AwsSandbox`          | one Fargate task from `RunTask`                                                   | injected SDK slice for the lifecycle, the AWS CLI over an injected spawner for commands | yes, `ListTasks` by the `startedBy` tag adopts a leftover that is RUNNING or still PENDING, and stops any duplicate beside it | yes, a pidfile plus the descendant walk through a second session     | no, the Session Manager channel is a pseudo-terminal | none live; the fake reproduces the Session Manager framing over a real local shell |
| `CloudflareSandbox`   | one Sandbox Durable Object behind a Worker binding                                | caller-supplied binding, through an injected `getSandbox` slice                         | yes, the Durable Object id is derived from the key, so the same object answers                                                | no                                                                   | no, the SDK reports output as strings                | none, fake only                                                                    |

### DirectorySandbox

```ts
import { DirectorySandbox } from "@smthrs/sandbox"

const provider = DirectorySandbox.make({
  fs,
  spawner,
  root: "/var/tmp/smithers"
})
```

`acquire` first requires `ContainedSpawner.isContained(spawner)`: a raw spawner or a wrapper with only a kill deadline fails with `unavailable` before any directory or command is created. Use `NodeHost.layerContained()` or `BunHost.layerContained()` with a `ProcessLedger`; a custom host must supply a real platform lifecycle. The filesystem and spawner remain injected values, so this package has no production platform dependency.

Acquisition creates the deterministic scratch directory, commands run there by default, and native host file operations serve it. Explicit `kill` and every spawn-scope finalizer delegate to the contained handle's `kill({ killSignal })`, including after the target's exit was observed. Cleanup failure fails scope release. The provider never signals a numeric handle pid itself: on POSIX that pid names the supervisor, while the exit code belongs to the target.

The supplied POSIX lifecycle cleans up the owned process group even after a natural target exit, including a background child that keeps output open. Explicit stopping while the target is still alive also attempts to stop descendants that escaped into another process group. That extra ancestry sweep uses revalidated positive PIDs and is best effort; automatic cleanup after natural exit does not promise to recover deliberately escaped sessions. Closing the session removes its scratch directory after process cleanup.

Each child receives only the host's `PATH`, `HOME`, `USER`, `LANG`, `LC_*`,
`TERM`, `TMPDIR`, and `SHELL`, plus names explicitly declared in the spawn's
`env`. Undeclared provider keys, tokens, and other ambient variables are
withheld. An explicitly declared name is delivered even when it looks
credential-bearing.

This is a trusted local workspace backend, **not a security boundary**. A spawned process is not confined to the scratch directory and can address whatever its host credentials permit. Use it for local composition, tests, or CI placement where the body is trusted.

### CommandSandbox

```ts
import { CommandSandbox } from "@smthrs/sandbox"

const box = CommandSandbox.make({
  spawner,
  prefix: ["ssh", "-o", "BatchMode=yes", "developer@box.example"],
  workdir: "/home/developer/workspace"
})
```

The machine is whatever `prefix` reaches, and every guest argv follows it: `[]` is this machine, `["ssh", ...]` a remote host, `["docker", "exec", "-i", name]` a running container. A prefix whose program is `ssh` joins the guest argv into one quoted command line, because `ssh` hands its arguments to the remote login shell as one string; set `joinsArguments` for another transport that does the same. `prefix` may be an effect, asked again for every command, so a transport whose credential expires, such as a Smithers Cloud workspace SSH grant, stays fresh; its `ProviderError` is the command's failure.

Shell programs cross the transport as a single base64 line on stdin, read by a short `/bin/sh` bootstrap before the environment envelope and original command input. Script size therefore does not expand local transport argv. The kernel still authorizes the complete transport command, including every prefix argument; an oversized or denied prefix remains refused. A CommandSandbox grant authorizes this transport, including its ability to receive guest shell programs on stdin; it does not authorize individual guest programs. The guest needs `base64`, and prefixes must forward stdin. Guest shell programs still obey the guest operating system's per-argument size limit.

The provider does not create or remove the machine. `acquire` prepares `workdir` and a pidfile directory private to the session key, so several sessions can share one machine, and closing the scope signals only that session's unfinished commands. File bytes cross the prefix as base64 text, commands run under the guest's absolute `/bin/sh`, and signals use the same pidfile and `/proc` walk as `ContainerSandbox`. An unreachable machine fails `acquire` or the command with `unavailable`. A transport can outlive its machine: a Smithers Cloud gateway keeps an SSH channel open after the workspace behind it stopped, so the exit never arrives. Every command therefore runs beside a `heartbeat` (default 15 seconds) that reads the machine's boot id; a probe that fails, answers another boot, or takes twice the heartbeat ends the command with `unavailable`. Heartbeat deadlines cover the probe response; process-scope cleanup after a completed response does not count as a failed probe. Closing the scope removes the session's pidfile directory, and failures never carry the prefix's argv, which may hold a credential.

### ContainerSandbox

```ts
import { ContainerSandbox } from "@smthrs/sandbox"

const provider = ContainerSandbox.make({
  spawner,
  image: "node:22"
})
```

The default CLI is `docker`; set `program: "podman"` for Podman or name a compatible wrapper. Network access is disabled by default with `--network none`; `network: "none"` says so explicitly, `network: "open"` is the engine's `bridge` network, and setting `network` to another engine mode is an explicit egress opt-in. An allowlist `network: { allow }` throws at `make`: an engine network mode is not a host firewall. `acquire` deterministically names the container, runs `create` then `start`, and reattaches when that name already exists: a refused create is followed by `container inspect`, and the returned configuration and ownership fingerprint must match before reattachment. Commands, reads, and writes all travel through `exec` to the same guest workdir. The scope finalizer runs `rm --force`, ending the container and everything still inside it. A nonzero removal exit logs the resource name and exit code without CLI stderr. A CLI failure without an exit code logs the resource name. Teardown still finishes within five seconds.

Creation environment values travel through `--env-file /dev/stdin`. The host must expose `/dev/stdin`; values containing CR, LF, or NUL fail with `spawn_error` before creation because the CLI env-file format cannot represent them. Per-command environment operands travel as a base64 line on exec stdin, followed by the command's original stdin bytes. The guest shell reads that line before starting the command. The guest image needs `base64` as well as `sh` and `env`. Environment values are absent from local CLI argv.

The exec's own shell is named absolutely and a caller's environment travels as an `env(1)` prefix on the inner shell, never as `--env` on the exec and never through `export`. Both rules exist for the same reason: the engine resolves an exec's argv through the exec environment's `PATH`, so a caller's `PATH` override would otherwise break the wrapper before the command ran, and `export` refuses a name the session contract accepts (`a-b=1`) and would abort the whole line. Every shell the provider starts for itself is absolute for that same reason, workspace preparation, file reads and writes, and signal delivery included, since `options.env` is applied to the whole container. A spawn value of `undefined` deletes the variable with `env -u` rather than merely omitting it, so a name the container was created with is genuinely gone from the command's environment; every `-u` precedes every assignment, because `env` stops reading options at its first operand.

Killing the local `docker exec` client does not reliably signal the guest process. Each spawned command therefore writes its guest pid to a session-private pidfile. `kill` starts a second guest command that plants a cancellation marker first and only then waits for, reads, and signals the recorded pid, walking descendants through `/proc` and signalling children before the root. The marker comes first because the wrapper writes its pid before it reads the marker: a wrapper with no pid on disk has not reached the marker check yet and must see it, and a wrapper that has passed the check has left a pid to signal. Reading the pid first left a window in which the wrapper started the command between the empty read and the marker being written, and the kill reported success anyway. Acquisition wipes the pidfile directory before reuse, so reattachment cannot target stale pids.

### KubernetesSandbox

```ts
import { KubernetesSandbox } from "@smthrs/sandbox"

const provider = KubernetesSandbox.make({
  spawner,
  image: "node:22",
  context: "orbstack",
  namespace: "smithers-runs",
  serviceAccount: "runner",
  resources: {
    requests: { cpu: "250m", memory: "512Mi" },
    limits: { cpu: "2", memory: "2Gi" }
  }
})
```

`acquire` derives the Pod name from the session key (prefix `smthrs-sbx-`, lowercased, bounded to 63 characters with the key's digest kept), runs `kubectl run` with `--restart Never` and `sleep infinity`, inspects an `AlreadyExists` Pod, refuses it untouched when its configuration or fingerprint differs, reattaches it only when it is live and carries a valid `reattachKey` seal, and otherwise deletes and replaces it, waits for the `Ready` condition with a 300 second timeout, and prepares the workdir and a session-private pidfile directory. Options `kubectl run` has no flag for (`serviceAccount`, `nodeSelector`, `resources`) travel as a strategic-merge `--overrides` document; `context`, `namespace`, and `kubeconfig` prefix every invocation. The scope finalizer runs `kubectl delete pod --force --grace-period=0`, and a Pod that was created but never became Ready or could not prepare its workspace is deleted the same way. A nonzero deletion exit logs the Pod name and exit code without CLI stderr. A CLI failure without an exit code logs the Pod name. Teardown still finishes within five seconds.

Reattaching a Pod across processes needs `reattachKey`, an operator secret kept the same across restarts. After creating a Pod the provider reads its server-assigned `metadata.uid` and labels it `smithers.dev/sandbox-seal` with `s1-` and the first 60 hex digits of HMAC-SHA256(`reattachKey`, fingerprint NUL uid), which needs `pods/patch` in the namespace. The fingerprint alone is a hash of configuration anyone who knows the flow can compute, so without the seal a principal with `pods/create` but not `pods/exec` could pre-create a Pod under the session's name, fingerprint, and image with its own command and receive the session's commands, stdin, and environment. Binding the uid means a seal copied off an earlier Pod does not validate a new one under the same name. Without `reattachKey`, or when a leftover's seal is missing or wrong (including one created before sealing, or one a crash left between creation and sealing), the leftover is deleted and a fresh Pod created, so its files are lost; a replacement that loses a race for the name fails with `unavailable` rather than adopting the new holder. A principal that can delete and recreate Pods in the namespace, or exec into them, is outside this check.

When creation environment values are supplied, `kubectl run --dry-run=client -o json` renders the Pod, then `kubectl create -f -` receives the manifest with those values on stdin. Per-command environment operands use a base64 line on exec stdin before the command's stdin bytes. Neither path puts environment values in local CLI argv.

Commands run through `kubectl exec` under an absolute `/bin/sh`, in the requested `cwd`, with the caller's environment applied by `env(1)` in front of a second absolute `/bin/sh`; a spawn value of `undefined` deletes a Pod-wide variable with `env -u` rather than leaving it in place, and every `-u` precedes every assignment because `env` stops reading options at its first operand. The provider's own preparation, read, write, and signal shells are absolute too, since `options.env` reaches the whole Pod and a `PATH` override would otherwise disable them. Files travel through the same channel as base64: a read runs guest `base64`, a write pipes base64 into `base64 -d` on the exec's stdin after `mkdir -p` of the parent, so file contents cross the text boundary and remain byte exact. `kill` is the `ContainerSandbox` design, a pidfile per command, the same cancellation marker, and a second exec that signals descendants before the recorded pid. `ping` is `kubectl exec <pod> -- true`.

Isolation is the cluster's, not the provider's: the image, the service account, and the namespace's policies decide what a Pod can reach, and the provider only forwards the shaping options above. The image must carry `sh`, `env`, and `base64`. The Ready timeout is fixed. The real-backend suite runs against the `orbstack` context and skips wherever `kubectl cluster-info` does not answer there.

### JustBashSandbox

```ts
import { JustBashSandbox } from "@smthrs/sandbox"

const provider = JustBashSandbox.make({
  bash: interpreter, // a just-bash instance mounted over the same tree as `fs`
  fs,
  root: "/workspace"
})
```

`acquire` creates `root/<slug>` through the injected `FileSystem` and removes it, recursively, when the scope closes. Commands go to `bash.exec` with the session workdir as `cwd` (a relative spawn `cwd` is rooted under it), the defined entries of the spawn environment, and any spawn `stdin` rendered as a latin1 string under `stdinKind: "bytes"`, the byte representation the interpreter documents; reads, writes, and the native `files` operations (`exists`, `stat`, `readDirectory`, `makeDirectory`, `remove`, `rename`, `realPath`, `readLink`) go to the injected `FileSystem`. The caller must mount the interpreter and that service on the same tree: in a browser this normally means just-bash and `BrowserFileSystem` both view the same ZenFS volume. `ping` always succeeds. There is no machine to reattach; a same-key acquire recreates the directory with a recursive `makeDirectory`, which leaves whatever the mounted tree already holds in place.

This provider is a workspace boundary, **not a security boundary**. An interpreted command can address anything its shared virtual filesystem permits. Runs are serialized behind one permit, because just-bash has one mutable filesystem view. A successful spawn completes before it returns, stdout and stderr each replay at most one UTF-8 encoded chunk, and `isRunning` is already `false` by the time a caller can observe the adapted handle. There is no signal delivery, no separately spawned process pipeline, and no incremental output, so sessions omit `kill` and the conformance kill check is skipped for them. The suite runs the interpreter as a real shell over the same real directory the injected `FileSystem` serves, and the slice is proven assignable from a real just-bash 3.2.0 `Bash` instance, with a negative control against the old shape.

Cancelling or timing out `spawn` stops waiting. An executing command retains the shared permit until its promise settles; a cancelled queued command never starts. A hung interpreter leaves later commands queued, but callers can still cancel. Cancellation neither signals the interpreter nor rolls back its effects, and closing the session scope removes the workspace even while a command is running. See [Limits](./limits.md) for cancellation and binary output handling.

### MicrosandboxSandbox

```ts
import { MicrosandboxSandbox } from "@smthrs/sandbox"
import * as Microsandbox from "microsandbox"

const provider = MicrosandboxSandbox.make({
  sdk: Microsandbox,
  image: "oven/bun:1",
  persistence: "sticky",
  cpus: 2,
  memoryMib: 2048,
  idleTimeoutSecs: 600,
  network: "none"
})
```

`Sdk` is the structural slice of the `microsandbox` module the provider drives, and the real module is assignable to it: `Sandbox.builder(name)` with its fluent options and `create()`, `Sandbox.get(name)` returning a lifecycle handle (`status`, `configJson`, `connect`, `start`, `startDetached`, `refresh`, `modify`, `destroy`), `Sandbox.listWith(configure)` with `label` and `cursor` paging, `defaultBackendKind()`, and `setDefaultBackend("local")`. A booted machine exposes `name`, `backendKind`, `fs()`, `execStreamWith(program, configure)`, and `destroy({ timeoutMs, force? })`; a command handle exposes `recv()`, `signal(number)`, and `kill()`.

The machine name is `smthrs-msb-<slug>`. `acquire` configures the builder and calls `create`; when the SDK answers `sandboxAlreadyExists` it fetches the handle, records the current ownership labels as a next-start modification, and connects when the machine is running or starts it (detached, for sticky sessions) when it is stopped. Machine creation is registered as a scoped resource before guest setup, so a microVM that boots but cannot prepare its workspace is removed. `ephemeral` persistence, the default, removes the machine when the scope closes; `sticky` deliberately leaves it running so the next acquire of the same session key can reconnect, and only removes a sticky machine it created but could not prepare. Removal is `destroy({ timeoutMs: 3000 })`, a graceful stop; when that fails for any reason but the machine being gone, a second `destroy({ timeoutMs: 3000, force: true })` follows, and the whole teardown is bounded at five seconds. Writes use the SDK's byte-safe `fs().write` and reads its byte-typed `fs().read`; standard input rides the exec builder's own `stdinBytes` channel. `ping` reads `/etc/hostname`.

Commands run through `execStreamWith(shell, ["-c", command])` with the workdir applied per execution, because Microsandbox validates a builder workdir before the selected image has booted. `spawn` returns once the SDK has started the command, and one fiber scoped to the spawn drains the handle's `recv()` events: `started` records the guest pid, `stdout` and `stderr` chunks reach the streams as the guest writes them, and `exited` ends both streams and settles `exitCode`. A stream that ends without `exited`, or a `recv` that rejects, means the machine went away, and both streams and `exitCode` fail with `unavailable` at once. A guest that cannot start the command at all (a missing program or working directory, which the SDK hands back as an `undefined` event) fails them with `spawn_error`.

`kill(process, signal)` signals the command and everything it started. A second guest command walks the process tree below the recorded pid (`pgrep -P`, or `/proc` where there is none), stops the whole collected set, delivers the signal, and continues it, so no shell in the tree runs its next statement between one `kill(2)` and the next; the walk reaches descendants that left the command's process group with `setsid` while their parent is alive. The SDK's `signal(number)` then reaches the command's process group, which covers a guest without the walk's tools and a command whose pid is not known yet. Delivery succeeds when either did, and a command seen to exit is never signalled again. Closing a spawn's scope before its exit was observed, as an interrupted caller does, sends `SIGTERM` the same way, waits two seconds for the exit, and sends `SIGKILL` to whatever ignored it, all inside the five-second teardown bound. A start that the caller abandoned while the SDK was still starting it is killed when its handle arrives.

`image` and `snapshot` are exclusive; naming both fails with `unavailable` before any vendor call. A removed machine is gone with its files. With the default `backend: "local"`, `acquire` refuses before provisioning unless `sdk.defaultBackendKind()` is `local`, and refuses again when the opened machine reports another `backendKind`, so an ambient `MSB_BACKEND`, `MSB_API_KEY`, or `MSB_PROFILE` cannot move guest work off the host; a composition that must stay local also calls `sdk.setDefaultBackend("local")` once at startup. `backend: "any"` accepts the hosted backend. `cpus`, `maxCpus`, `memoryMib`, `maxMemoryMib`, `maxDurationSecs`, `idleTimeoutSecs`, `security`, and `pullPolicy` go to the builder as named. The provider registers no guest scripts: the pinned runtime rewrites them in the guest-writable `/.msb` share by path and follows guest links there. `network: "none"`, and a machine that names neither `network` nor `networkPolicy`, calls `disableNetwork()`: the vendor's own default reaches the public internet, so the provider closes it. `network: "open"` leaves that vendor default. `network: { allow }` goes to `network(b => b.policy(...))` as deny-by-default ingress and egress with egress allowed only to each listed host, whose domain rules also admit the DNS queries for exactly those names; an empty list sends no rules, so DNS is denied too. A `*.` entry becomes a domain-suffix rule, which the vendor also matches against the apex, so a deny rule for the apex precedes the suffix rules unless another entry admits the apex. `networkPolicy` (a `NetworkPolicy`: per-direction defaults and ordered rules in the vendor's shape) goes to the same builder call for rules the neutral option cannot say; naming both throws at `make`. Every machine carries a `smithers.network` label recording its network. An acquire refuses to reattach a machine whose label differs or is missing (one booted under the vendor's open default), before relabelling or connecting; bringing back a sticky machine whose guest stopped answering refuses the same way, and `captureSnapshot` refuses to start a stopped machine that records no network. `rootDiskMib` sets the root disk of an image boot; a snapshot boot keeps the disk it captured.

Snapshots are named `<family>.<member>` (`snapshotName(family, member)`, separator `snapshotSeparator`): the family is the preparation a snapshot repeats, the member tells its captures apart and never contains the separator, so `snapshotFamily(name)` places every name in exactly one family. `captureSnapshot({ sdk, machine, family, member, secrets, stopTimeoutMs? })` scrubs a machine of credentials, runs `sync` in the guest so files written just before the capture reach the disk whole (a failing `sync` refuses the capture before the stop), stops it, captures its root disk as that snapshot, removes the machine whether or not the capture succeeded, and returns the name; a family and member that cannot name a snapshot fail with `unavailable` before any vendor call and leave the machine. `hasSnapshot(sdk, name)` answers whether one exists (a `SnapshotNotFound` answer is `false`; any other failure is `unavailable`). `pruneSnapshots(sdk, family, keep, retain?)` removes that family's snapshots beyond the `keep` newest, except those named in `retain`, and returns their names; a family whose name extends another's is never touched by the other's prune. `removeSnapshot(sdk, name)` removes one; one already gone is not an error. A machine booted from a snapshot does not depend on it afterwards, so pruning never disturbs a running machine.

A snapshot is restored into every later machine, so capture keeps credentials off it. `secrets` lists every credential value the machine was handed while it was prepared; pass `[]` when preparation ran without credentials. Before capture, a stopped machine is started, the credential-only files of `/root` and every `/home/*` are removed (`.git-credentials`, `.netrc`, `.pypirc`, `.config/gh/hosts.yml`, `.cargo/credentials.toml`, `.aws/credentials`, `.config/gcloud/application_default_credentials.json`, `.config/gcloud/credentials.db`, `.config/gcloud/access_tokens.db`, `.claude/.credentials.json`, `.codex/auth.json`, `.gemini/oauth_creds.json`, `.config/github-copilot/hosts.json`, `.config/github-copilot/apps.json`, `.local/share/opencode/auth.json`), and the disk outside `/proc`, `/sys`, and `/dev` is searched for each secret's longest line, so a PEM key is found by its body and not by its armor. The search includes `/run` and all root entry names, including names beginning with one or more dots. Each line is searched raw, as base64 and base64url at every byte alignment, percent-encoded, and JSON-escaped. A secret found anywhere, such as a token in a clone's remote URL, `.npmrc`, or Docker's `config.json`, fails the capture with `unavailable` naming the files and never the value. A secret whose longest line is under 8 bytes fails before any guest call. The removal touches only `/root` and `/home/*`, so a volume mounted at a home path loses those files too. The search does not find a secret split across lines, compressed, encrypted, or in any other encoding. Prefer preparing without credentials and handing them to machines at run time, after the restore.

Every machine carries three ownership labels beside any `labels` the caller passes, and the provider's own values win: `smithers.provider` (`providerLabel`) is always `microsandbox` (`providerName`), `smithers.owner` (`ownerLabel`) is `owner` (default `smithers`), and `smithers.holder` (`holderLabel`) is `holder` (default a random token per `make` call). `reap({ sdk, owner, isAlive, retain?, stopTimeoutMs? })` lists that owner's machines by the provider and owner labels, page by page, asks `isAlive` about each one's holder, and removes those whose holder is dead the same graceful-then-forced way, whatever their persistence, except those `retain` keeps by the labels their configuration records (a sticky machine a resuming run will reattach). Just before each removal the machine is read again, and one whose holder label changed since the listing (a live holder reattached it) or that disappeared is skipped. Machines of other owners, machines without a readable holder label, and machines this package did not create are never touched. Every candidate is attempted; the effect resolves with the removed machines, or fails with `unavailable` naming those that could not be removed after the others were. Reattachment relabels a machine to the new holder as a next-start modification, so a host reaps at startup, before it acquires.

```ts
const orphans = yield * MicrosandboxSandbox.reap({
  sdk: Microsandbox,
  owner: "my-installation",
  isAlive: (holder) => Effect.succeed(holder === currentHolder)
})
```

The real-backend suite runs where the `microsandbox` binary answers `--version` and the host can boot a microVM, and names its skip otherwise. It runs the conformance suite with `kill`, `interrupt`, and `ephemeral` claimed, interrupts a command whose `setsid` descendant must not write afterwards, interrupts ten freshly booted single-vCPU commands whose shells must not run their next statement, keeps two concurrent machines' files apart, reaps a sticky machine whose holder is dead while keeping one whose holder lives, fails an unstartable command with `spawn_error`, and fails a running command with `unavailable` within ten seconds of its machine being destroyed from outside.

`environment` plants the workspace's Nix environment in the microVM and runs every command under it:

```ts
const provider = MicrosandboxSandbox.make({
  sdk: Microsandbox,
  persistence: "sticky",
  environment: { flake: flakeText, lock: lockText, attr: "ci" }
})
```

The flake and lock are text because this package reads no host files: whoever composes the provider reads them, from a checkout, a fixture, or wherever else the environment is declared. With an environment and no `image` the microVM boots `nixos/nix`. `acquire` writes the files to `<workdir>/.smithers/nix` (or `directory`), runs `nix develop path:<directory>[#attr] --command true` once so the closure is realised before the session is handed out, and then runs each command as `nix develop … --command <shell> -c <command>`. A flake that does not evaluate fails the acquire with `unavailable`, carrying `nix develop`'s exit code and stderr, and the booted machine is stopped. Boot stays fast through the store: a `sticky` session keeps the realised closure across acquires, and a `snapshot` taken after the warm boots with it already realised.

### VercelSandbox

```ts
import { VercelSandbox } from "@smthrs/sandbox"
import * as vercel from "@vercel/sandbox"

const provider = VercelSandbox.make({
  sdk: vercel,
  token,
  teamId,
  projectId,
  timeoutMs: 30 * 60_000,
  maxDurationMs: 60 * 60_000,
  runtime: "node22"
})
```

The machine name is `smthrs-<slug>`, lowercased. `acquire` calls `Sandbox.getOrCreate` with `persistent: true` and `resume: true`, so a name that already exists is resumed with its filesystem, and the scope finalizer calls `stop()`, which leaves the persistent sandbox in place for the next acquire. Credentials resolve in a fixed order: an explicit `oidcToken` or `VERCEL_OIDC_TOKEN` wins; otherwise `token`, `teamId`, and `projectId` are sent together or not at all; the environment consulted is `options.env`, never `process.env`. Vercel limits the timeout accepted by one create request to five minutes, so longer requested lifetimes create at that ceiling and then call `extendTimeout` with only the remaining duration, because that API extends by its argument rather than setting an absolute target. Commands run through `runCommand` as `sh -c` and never `sh -lc`: a login shell sources profile scripts, and anything those print lands ahead of the command's own standard output, which callers parse as data. `commandEnv` sits under the per-spawn environment. A read drains `readFile`'s stream, string or bytes, into one buffer, and `null` is `not_found`; a write runs `mkdir -p` for the parent and calls `writeFiles`.

`network: "none"` sends `networkPolicy: "deny-all"` and `network: { allow }` sends `networkPolicy: { allow }`, Vercel's egress firewall. `getOrCreate` applies a policy only when it creates, so `acquire` also calls `update({ networkPolicy })` before its first guest command; a resumed sandbox never runs under an older policy. `network: "open"` sends `networkPolicy: "allow-all"`, which also lifts a resumed sandbox's earlier policy. Omitting `network` is `network: "none"`, including the update of a resumed sandbox: Vercel's full internet access needs an explicit `"open"`. A malformed policy throws at `make`.

`timeoutMs` must be a positive finite number, `maxDurationMs` is a caller-owned cap checked before any vendor request, and `workdir` must be absolute; each refusal is a `spawn_error` raised before anything is acquired. Output arrives after the command finishes, so there is no streaming and no `kill`; `runCommand` has no input channel, so standard input is staged as a workspace file and redirected. There is no real-backend suite; the provider is proven against a fake that keeps the vendor API shapes and runs every command through a real shell against real files.

### DaytonaSandbox

```ts
import { DaytonaSandbox } from "@smthrs/sandbox"

const provider = DaytonaSandbox.make({
  sdk: daytona, // a configured `new Daytona(...)` client
  workdir: "/home/daytona/workspace",
  startTimeoutSeconds: 120
})
```

The machine name is `smthrs-<slug>`, lowercased. `acquire` calls `get(name)` first; a 404 creates a sandbox with that name, and an existing one is started with `startTimeoutSeconds`. Creation or attachment is registered as a scoped resource before start and workspace preparation, so any later failure still runs the blocking delete finalizer, `delete(sandbox, deleteTimeoutSeconds, true)`. The workdir is `options.workdir` or the sandbox's own `getWorkDir()`, and either must be absolute. Commands run through `process.executeCommand(command, cwd, env)`. Daytona's byte-native download and stream-upload operations serve file transfer: `downloadFile` for reads, with `FILE_NOT_FOUND` mapped to `not_found`, and `uploadFileStream` for writes.

`network: "none"` and an empty allowlist create the sandbox with `networkBlockAll: true`; `network: { allow }` creates it with `domainAllowList` set to the hosts joined by commas. The runner enforces both as iptables rules. An attached sandbox keeps the network it was created with, so `acquire` calls `updateNetworkSettings` with the same fields after `start` and before any guest command; a refused update fails with `unavailable` and deletes the sandbox. `network: "open"` sends `networkBlockAll: false`, the same way. Omitting `network` is `network: "none"`, so `networkBlockAll: true` is sent on create and after reattach: Daytona's own network needs an explicit `"open"`. A malformed policy throws at `make`.

Teardown deletes the sandbox, so nothing survives a normal release; only a crash-left sandbox is found again by name. `executeCommand` returns one `result` string with no stderr field on the wire, so a command's standard error arrives merged into standard output rather than separately, and output arrives after the command finishes; there is no streaming and no `kill`, and standard input is staged as a workspace file and redirected. There is no real-backend suite; the provider is proven against a fake that keeps the documented API and error shapes (unverified live) and runs every command through a real shell against real files.

### AwsSandbox

```ts
import { ECS } from "@aws-sdk/client-ecs"
import { AwsSandbox } from "@smthrs/sandbox"

const provider = AwsSandbox.make({
  sdk: new ECS({ region: "us-west-2" }),
  exec: { spawner },
  region: "us-west-2",
  cluster: "smithers",
  subnets: ["subnet-0abc"],
  securityGroups: ["sg-0abc"],
  image: "ghcr.io/acme/runner:1",
  taskRoleArn: "arn:aws:iam::123456789012:role/runner-task",
  executionRoleArn: "arn:aws:iam::123456789012:role/runner-exec"
})
```

`acquire` first looks for the machine a previous acquire of the same key left running: one `ListTasks` call with the `startedBy` tag derived from the key and no desired-status filter. AWS requires `startedBy` to be the only filter and documents that a PENDING desired-status filter returns nothing. Omitting `desiredStatus` uses the RUNNING default, which still returns a provisioning task whose desired status is RUNNING while its `lastStatus` is PENDING. This is how a host that died between `RunTask` and its finalizer recovers the not-yet-ready task instead of stranding it. `DescribeTasks` requests `include: ["TAGS"]` and verifies every candidate before adoption or cleanup. Reattaching an externally supplied `taskDefinition` requires an explicit revision (for example `family:7` or a revision-qualified ARN) matching the described task definition; an unversioned family may still create a fresh task. The lowest verified ARN is adopted and waited for if it is not ready; verified duplicates under that key are stopped before provisioning, so a key never accumulates machines. Otherwise it calls `RunTask` with `enableExecuteCommand: true`, `launchType: "FARGATE"`, and that `startedBy`, polls `DescribeTasks` with exponential backoff (capped at 10 seconds, `maxPollAttempts` default 60) until the task is `RUNNING` and its agent is, and registers `StopTask` on the scope; an adopted task is released the same way, so closing the scope always leaves nothing behind. A task that reaches `STOPPED` first fails with `unavailable`; an exhausted poll budget fails with `timeout`. Supplying an image reuses an adopted task’s definition without registering a revision. Recovery lists ACTIVE definitions in the generated family with `ListTaskDefinitions` (including all pages), deregisters stale revisions, and deregisters the adopted revision after stopping the task. The injected SDK and IAM policy must allow `ListTaskDefinitions` for image recovery. A fresh task registers a minimal Fargate task definition and deregisters it after the task finalizer runs: family `smthrs-<startedBy>`, `sleep infinity`, `initProcessEnabled`, `cpu` 256 and `memory` 512 by default, container `sandbox`. `env` reaches the task as container overrides, which needs a `container` name or an image-generated definition. Supplying `taskDefinition` and `env` without `container` fails acquisition with `spawn_error` before any SDK request. A spawn's own environment is applied by `env(1)` in front of an absolute `/bin/sh` rather than by `export`, which refuses a name the session contract accepts. An undefined spawn value uses portable `env -u` to delete the inherited task variable. `ping` describes the task again and requires the same readiness.

Commands, reads, and writes travel through `ExecTransport`: `aws ecs execute-command --interactive`, driven through the injected spawner, because ECS Exec is two halves and the ECS API implements only one. `ExecuteCommand` opens an SSM session and returns its metadata; the data channel that carries output and status is the Session Manager protocol, which the AWS CLI speaks by delegating to `session-manager-plugin`. The session is a pseudo-terminal, so standard error arrives interleaved on standard output and line endings are normalized; the plugin exits zero whatever the remote command did, so every command is wrapped to print its own status line under a random 128-bit per-command nonce, only the first such line counts (a detached child printing another after the command ends cannot change its status; a process already running in the task can read the nonce off the wrapper's command line and print a status first, so the framing is not a boundary against guest code that outlives an earlier command), and a session that ends without one is `aborted`, never a success. Reads come back as guest `base64` and writes go in as base64 slices bounded by `chunkBytes` (default 3072 bytes before encoding), so file contents are byte-exact despite the terminal. `chunkBytes` is validated when the session is acquired and must be a whole number from 1 through 65536 bytes; an invalid value is refused with `spawn_error` naming that range. Each slice travels on `ExecTransport.streamingSpawner` stdin. The range bounds per-session buffering; payload bytes never enter `--command`. Standard input is staged as a workspace file and redirected. `kill` records each command's guest pid in a session-private pidfile and signals it and its descendants through a second session; closing a spawn's scope does the same for a command not yet seen to end.

File writes, spawns with stdin, and spawns with a nonempty environment require `exec.streamingSpawner`. This optional adapter receives the AWS CLI command descriptor, including routing flags and `options.stdin`. It must deliver stdin byte-exactly to the guest, close it at EOF, keep it out of local argv, and disable input echo. Output uses the existing status framing. A normal AWS CLI spawner does not satisfy this contract. Without the adapter these operations fail with `ProviderError` code `unavailable` before transfer; commands without input and file reads still use `exec.spawner`. Environment operands use a base64 line on streaming stdin, and command stdin is staged through the streaming file-write path.

Without an `exec` transport the session still provisions and tears down tasks but refuses `spawn`, `readFile`, and `writeFile` with `unavailable`, naming the missing transport, and the conformance suite records every obligation it cannot meet; with both CLI and streaming adapters it passes the suite in full. Honest limits: the host running the provider needs the `aws` CLI and `session-manager-plugin` installed; a command's standard error cannot be separated from its output; and no live cluster is driven by the package's own suite, so the transport is proven against a fake that reproduces the plugin's banner, footer, carriage returns, and zero exit over a real local shell.

### CloudflareSandbox

```ts
import { getSandbox } from "@cloudflare/sandbox"
import { CloudflareSandbox } from "@smthrs/sandbox"

const provider = CloudflareSandbox.make({
  sdk: { getSandbox },
  binding: env.SANDBOX,
  execution: "exec",
  sleepAfter: "10m"
})
```

The Worker binding is the credential and the infrastructure handle. `acquire` resolves the Durable Object whose id is the session slug, with `enableDefaultSession: false` so the SDK's implicit shell session is never opened, forwards `keepAlive` and `sleepAfter` only when set, registers `destroy()` on the scope, and creates the workdir. In `exec` mode a command is `sandbox.exec` and its completed result; in `process` mode it is `startProcess`, then `waitForExit`, then `getLogs`; a process that reports no exit status on either surface fails with `spawn_error` rather than being given one. File payloads use the SDK's base64 encoding and the text is read from the result's `content` field, which preserves arbitrary bytes without importing host modules. `FILE_NOT_FOUND` is `not_found`. `ping` runs `exec("true")` in the workdir.

This provider does not create infrastructure. The Durable Object namespace, its container image, and the Worker that holds the binding are deployed by the caller, and the binding is the credential; there is nothing to configure here beyond it. Output arrives after the command completes in both modes, so there is no streaming and no `kill`; the exec options carry no input channel at 0.12.9, so standard input is staged as a workspace file and redirected. The finalizer destroys the object, so a normal release discards its files; only a crash-left object is found again by id. There is no real-backend suite; both execution modes are proven against a fake binding that runs every command through a real shell against real files.

## Limits

Two operations here are bounded and the rest is sized by the host's heap.
[Limits](./limits.md) states which is which, per operation and per provider,
and names the providers whose command output is not byte exact.

## Browser support

`@smthrs/sandbox` bundles as a browser entry point. The probe only runs the effect a provider hands it, and host access stays behind the provider layer. No module reads a host global; the conformance fixture's per-process uniqueness comes from Web Crypto rather than a process id, because a free `process` identifier survives bundling and throws in a browser.

## Reading next

Task-shaped walkthroughs of everything above:
[place a flow body on a machine](./guides/place-a-flow-body-on-a-machine.md),
[return work from a sandbox](./guides/return-work-from-a-sandbox.md),
[run commands through a transport](./guides/run-commands-through-a-transport.md),
[choose a provider](./guides/choose-a-provider.md),
[supervise a session](./guides/supervise-a-session.md),
[write a provider](./guides/write-a-provider.md),
[prove a provider](./guides/prove-a-provider.md), and
[test against a scripted machine](./guides/testing.md). The model behind them
is in [the two provider seams](./concepts/seams.md),
[sessions and their keys](./concepts/sessions.md),
[what a sandbox does and does not prevent](./concepts/isolation.md), and
[how a remote command differs from a local one](./concepts/remote-commands.md).

[`@smthrs/kernel`](/api/kernel) renders the command line a provider receives, and its `proc:spawn` capability check is written against that same string. [`@smthrs/run-store`](/api/run-store) tracks whether a run's engine is still alive, which is a different question from whether its sandbox is. See also [Capabilities and the host kernel](/docs/concepts/kernel/) and [Retries and interruption](/docs/concepts/retries/).

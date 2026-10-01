---
title: "Prove a provider"
description: "Run SandboxConformance or ProviderConformance against your adapter, supply the command fixture each suite needs, and read a violation."
sidebar:
  order: 7
---

Both suites state a contract as behavior and report every check that did not
hold. Run the one that matches your seam in your own test suite and assert the
returned array is empty.

They exist so that what the prose here promises a caller is also something an
adapter has to produce. A suite runs through the real adapter layer against the
backend it actually talks to, so passing it is evidence rather than a claim.

## Prove a lifecycle provider

```ts
import { SandboxConformance } from "@smthrs/sandbox"

const violations = yield* SandboxConformance.check(provider, {
  provides: { kill: true, ping: true }
})
```

Every check acquires a fresh session, so a check that leaves one unusable
cannot decide the next. The checks are:

| Check                                  | What the session must do                               |
| -------------------------------------- | ------------------------------------------------------ |
| `round-trips-binary-bytes`             | return exactly the bytes that were written             |
| `round-trips-an-empty-file`            | the same for zero bytes                                |
| `round-trips-a-large-file`             | the same for 64 KiB of every byte value                |
| `reports-an-absent-file`               | fail a missing path with `not_found`                   |
| `creates-parent-directories`           | write into a path whose parents do not exist           |
| `runs-in-its-workdir`                  | run a command with no `cwd` in `workdir`               |
| `roots-a-relative-cwd`                 | take a relative `cwd` under `workdir`                  |
| `delivers-the-environment`             | give the command the environment it was passed         |
| `refuses-an-unusable-environment-name` | fail rather than deliver a name a shell drops          |
| `delivers-standard-input`              | give the command its complete input                    |
| `delivers-standard-error`              | put a command's error output on one of the two streams |
| `files-reach-processes`                | let a process measure a file written with `writeFile`  |
| `processes-reach-files`                | let `readFile` return a file a process produced        |
| `reacquires-its-session`               | serve a working session after release and reacquire    |

`files-reach-processes` and `processes-reach-files` cross surfaces on
purpose. A session serving files from anywhere but the machine its processes
run on would pass every file check and every process check separately.

## Prove the work contract

Pass `work` to also check that `Sandbox.run`'s capture works on your machine.
The guest needs `git`. The suite runs no host `git`, so you supply the
repository: commit `SandboxConformance.workSeedFiles` with your own `git`,
bundle the commit, and pass the bundle's bytes and the commit id:

```ts
const violations = yield * SandboxConformance.check(provider, {
  work: { bundle, base }
})
```

| Check               | What the session must do                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `captures-its-work` | capture `Changed` work from `base` whose patch reproduces the final tree, with a rename kept as a rename |
| `captures-no-work`  | capture `Unchanged` work at `base` when nothing was edited                                               |

`captures-its-work` makes one edit of every kind in a checkout below the
workdir: a commit in the guest, an uncommitted change, an untracked file,
binary contents, a rename, a deletion, and a mode change. The guest's own `git`
then applies the patch to `base` and compares the trees.

## Delegated spawn checks

The suite then projects the provider through `Sandbox.commandProvider` and
delegates the spawn, exit, stdin, ping, and process-stop checks to
`ProviderConformance`, so a session provider is held to everything a transport
is.

## Prove a spawn-only provider

The narrow suite cannot invent its fixture commands: a provider that reaches a
container knows `sh -c 'echo hi'`, and one that posts to a language runner
knows something else entirely. You supply them, and the suite states what each
has to do:

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

| Check                       | What the provider must do                                         |
| --------------------------- | ----------------------------------------------------------------- |
| `writes-its-output`         | put exactly `output` on stdout and exit 0                         |
| `reports-a-nonzero-exit`    | report `failureCode` as an exit code, not as a failure            |
| `delivers-standard-input`   | hand the bytes to `copiesStdin` (default `cat`) so they come back |
| `answers-a-ping`            | answer a declared `ping` while the session is open                |
| `signals-a-running-command` | stop `runs` with a declared `kill`                                |

Set `shell: true` when your fixtures are shell lines. A rendered single token
is POSIX quoted whole, so `printf 'hi'` would otherwise reach a shell-running
session as one garbled word. `SandboxConformance` sets it for its own POSIX
fixtures.

Optional capabilities are checked only when the provider declares them. An
absent `ping`, `kill`, or `stdin` is a documented absence, not a defect. A
provider that does declare one is held to it, `stdin` included: the flag is
what makes the adapter hand the bytes over, so a suite that took it at its word
would pass an adapter that sets the flag and then ignores
`RemoteOptions.stdin`.

## The kill check watches the machine, not the call

A `kill` that returns success and leaves the command running satisfies the type
and leaks a process inside the sandbox for every cancelled action. The check
therefore waits `Commands.stopsWithin` (default 5 seconds), measured on the
platform timer even under a frozen test clock, for `runs` to stop. It reports
`the command was still running after the signal` when it does not.
How it stopped is not the subject: a provider that reports a signalled process
as a failed exit code is as conforming as one that reports a status.

The handle is only the wrapper, though, and a shell that dies while its child
lives on satisfies every observation the handle allows. Name a
`Commands.survivor` for the second look: a command that exits zero while the
signalled command's work is still alive, and non-zero once it is gone. It runs
in the same session after the exit is observed, and a zero exit is the
violation `the command's work was still running after its handle reported it
stopped`. A command line that cannot match itself, such as
`pgrep -f 'sleep 360[7]'`, is the usual shape.

## Nothing hangs the suite

Every check runs under `CheckOptions.checkTimeout`, 10 seconds by default,
measured on the platform timer rather than the ambient `Clock`, and covering
session acquisition, stream consumption, and release as well as the call
itself. A provider that never answers is convicted with a named violation instead of
hanging your test run, and it is convicted under a frozen test clock too, which
is what `it.effect` gives you.

The deadline bounds observation of a detached check. On timeout or caller
cancellation the runner requests interruption and tracks cleanup in detached
fibers without waiting for it. An uninterruptible acquisition or release may
remain pending after the violation is returned; the deadline cannot force a
backend to release resources. The release-and-reacquire check uses the same
runner and one deadline for both acquisitions and releases.

For slow machine provisioning, set `checkTimeout` explicitly. Size the test
budget for the complete sequential suite, including every check that may time
out. The default is below the bundled provider test budgets so a stuck kill
can produce its named violation before the test runner expires.

`SandboxConformance`'s default fixture is `uniquePosixCommands()`, whose sleep
duration is unique to the running process, so two suites running side by side
on one host cannot mistake each other's fixture for a survivor.

## Read a violation

```ts
import { ProviderConformance } from "@smthrs/sandbox"

expect(ProviderConformance.format(violations)).toBe("provider conforms")
```

A `Violation` names the check as a stable kebab-case id, what the contract
requires, and what your provider did instead. `format` renders an array as one
message, which is enough to fix an adapter without reading this package's
source.

## Read next

- [Test against a scripted machine](./testing.md): the doubles to build your
  own unit tests on.
- [Write a provider](./write-a-provider.md): the obligations behind each check.

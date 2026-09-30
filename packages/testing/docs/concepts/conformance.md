---
title: "Conformance suites"
description: "What a conformance case is in this package, why the core registry is frozen, how the host suite treats an unsupported capability as a declared outcome, and what conformance does not cover."
sidebar:
  order: 4
---

A conformance case is a value, not a test. It has a `name` and a `run`, and it
knows nothing about the runner that will register it:

```ts
interface ConformanceCase {
  readonly name: string
  readonly run: (engine: EngineSubject) => Effect.Effect<void, ConformanceViolation | EngineSubjectError>
}
```

That shape is what lets one case list run under vitest here, under another
runner in a consumer's repository, and inside a CI script that registers
nothing at all.

## The core suite is a frozen registry

`Conformance.coreSuite()` returns the mandatory black-box suite every
`EngineSubject` must pass: identity, interruption, replay, and race. The
returned array is a frozen copy, and each case record is frozen too.

That is defensive on purpose. `ReadonlyArray` and `readonly` are erased at
runtime, and losing a mandatory pin is the worst failure a conformance registry
has. Handing back the registry's own array would let a consumer splice a pin
out, and every later call in the process would return the shortened list.
Freezing the array alone leaves the same hole one level down: shared case
records mean that assigning to a returned case's `run` replaces a mandatory
pin's assertion for every later caller.

`coreSuite` is the only entry point to this list. A second name returning the
same cases would read as a superset that does not exist.

`coreSuite({ filter })` narrows the list for a subject that can only answer
part of it, and the filtered array is frozen as well.

## The host suite is parameterized by a declaration

`HostSuite.hostSuite(bundle, profile)` runs one shared suite against a complete
Host bundle. The profile is a closed list, and **every** capability in it must
be declared. Omission is not an admission mechanism.

A capability the host does not implement is a declared outcome, not an
accident:

```ts
import type { HostSuite } from "@smthrs/testing"
import * as ChildProcess from "effect/unstable/process/ChildProcess"

const profile: HostSuite.HostProfile = {
  fileSystem: { supported: true },
  path: { supported: true },
  shell: { supported: true, interruptCommand: ChildProcess.make("host-suite-pending") },
  jj: { supported: false, code: "not_installed" },
  httpTransport: { supported: false, code: "TransportError" },
  clock: { supported: true },
  random: { supported: true }
}
```

The profile states the stable code the operation raises, the suite asserts that
code, and a wrong code is reported through the typed `expectedCode` and
`actualCode` fields rather than encoded into a message. HTTP additionally
requires an explicit probe request when it is supported, so the shared suite
never invents a live network call.

Three details keep the suite honest about the things a layer type cannot express:

- **Clock and randomness are `Context.Reference`s** with ambient defaults, so
  they cannot appear in a bundle's output type. The suite enforces them
  behaviorally instead, running those cases over a poisoned base, so a bundle
  that supplies neither fails loudly rather than silently using the Effect
  defaults.
- **The suite owns its scratch directory** and writes its probe file inside.
  Nonrecursive directory creation atomically refuses an existing path,
  including a dangling symlink, on every platform. A collision reports
  `FileSystem/scratchPath` without removal. With no path declared it builds a
  randomized absolute path under `/tmp` from the bundle's own
  `Path` and `Random`, because a relative name would resolve against the
  caller's working directory and a fixed one would make two suites in a single
  directory race on one scratch path. Removal is registered only after
  directory creation succeeds and runs even when the file write fails.
- **Cleanup acquires a Host process handle.** A supported shell declares an
  `interruptCommand` that stays running until cancelled. The suite checks
  `isRunning` before interrupting its scoped consumer, then checks it is false
  after interruption completes. A shell declared unsupported is checked for
  its refusal code; that outcome does not certify resource cleanup.

## What conformance does not cover

The applied suites in this package bind `FlowEngine.layerMemory`, which keeps
every execution, action, and journal entry in process memory. Nothing there
survives a restart, so "replay" in those runs means the runtime replaying a
recorded result inside one process.

Durability is a different question, answered by a different binding.
`FlowEngineLike.layerOver` takes any `Layer<FlowRuntime>`, and the durable one
is `EngineStore.layer({ owner, journalSource })` from
[`@smthrs/engine-store`](/api/engine-store). `@smthrs/testing` does not depend
on that package, so you install it and pass the layer yourself. Supplying the
layer is the whole connection.

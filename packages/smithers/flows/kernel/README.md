# @smthrs/kernel

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://kernel.smithers.sh

A capability kernel for [Effect](https://effect.website) hosts. It puts a
permission check in front of every side effect a program can reach: the five
service tags a host provides, `FileSystem`, `Path`, `ChildProcessSpawner`,
`HttpClient`, and `Jj`, are decorated in place, so each operation is named as a
capability, checked against a grant store, and refused with a typed error when
nobody authorized it.

Decorating in place is the point. A protected second service only guards the
callers who agreed to use it, and the first dependency that reaches for the
ordinary `FileSystem` tag walks straight past it. Once this layer is composed,
the guarded implementation is what the tag resolves to, so there is no
unguarded one left to reach for. Code that calls `fs.readFileString` is checked
without ever mentioning permission.

## Install

`@smthrs/kernel` is not on npm at 1.0.0-rc.0. Its source lives in the
[smithers repository](https://github.com/smithersai/smithers), and the
[installation page](https://kernel.smithers.sh/installation/) covers how to
depend on it from a checkout, the import forms, and the two test helpers.

It needs Node.js 26.4.0 or later and `effect` 4.0.0-rc.115. It carries no
platform implementations of its own, so a composition that reaches a real
machine also adds a bundle such as
[`@smthrs/platform-node`](https://platform-node.smithers.sh).

## Refuse an operation nobody authorized

This program composes the kernel over the deterministic host from
`@smthrs/testing/TestHost`. Add `"@smthrs/testing": "workspace:*"` to the
consuming package's devDependencies before running it. The policy allows reads
under the workspace and says nothing about writes:

```ts
import { Capability, GrantStore, HostServices, Permission, Workspace } from "@smthrs/kernel"
import * as TestHost from "@smthrs/testing/TestHost"
import { Effect, FileSystem, Layer } from "effect"

const rules = [
  new Permission.Rule({
    effect: "allow",
    pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
  })
]

const guarded = HostServices.layer.pipe(
  Layer.provide(Layer.orDie(GrantStore.layer({ attended: false, rules }))),
  Layer.provideMerge(TestHost.layer({ files: { "/workspace/README.md": "# hello" } })),
  Layer.provide(Workspace.layer("/workspace"))
)

/** Ordinary Effect code. Nothing here knows a kernel exists. */
const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const readme = yield* fs.readFileString("/workspace/README.md")
  yield* fs.writeFileString("/workspace/out.txt", readme)
})

Effect.runPromise(program.pipe(Effect.provide(guarded), Effect.scoped))
```

The read returns `"# hello"`. The write never reaches the filesystem. Effect
fixes that method's error channel to `PlatformError`, so the kernel projects
its refusal into one and keeps the structured original on the cause, where
`Permission.fromPlatformError` reads it back as a `PermissionRequired` naming
`fs:write` on `/workspace/out.txt`.

`permission_required`, not `permission_denied`: no rule matched, silence is not
consent, and this store has nobody to ask. Build the store with
`attended: true` instead and the same write parks on a request an operator can
answer, then resumes the operation it was authorized for. The
[quickstart](https://kernel.smithers.sh/quickstart/) runs both halves.

## What a yes or no answer leaves open

- **Confinement.** A path is authorized as a canonical resource and the
  operation runs through a pinned directory descriptor, so a symlink or a
  rename between the decision and the call cannot redirect it. A host that
  cannot address the real filesystem attests whole-volume isolation instead; a
  path-only adapter is unsupported and fails closed.
- **Containment.** A cancelled run signals its children, escalates to
  `SIGKILL` on a deadline, and records each child in a durable ledger, so a
  host that dies leaves orphan records its successor can reap.
- **A ceiling that only narrows.** `CapabilitySet.attenuate` bounds what a
  fiber may ask for, and no public operation widens it again.
- **Grants that outlive the process.** A decision is written to a journal
  before it takes effect, so a permission a person chose to remember is still
  in force after a restart.

## Public API

The root entry point exports these namespaces, and each is also importable from
`@smthrs/kernel/<Module>`. Every export, with its signature and its bounds, is
on the [API reference](https://kernel.smithers.sh/reference/api/).

| Namespace             | What it is                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Capability`          | The vocabulary a decision is made in: actions, exact capabilities, patterns, matching, and effect tiers.     |
| `Permission`          | The typed failure contract, plus policy rules and their evaluation.                                          |
| `CapabilitySet`       | The authority ceiling. `attenuate` narrows it; no public operation widens it again.                          |
| `GrantStore`          | The service that decides: check a capability, park a request, reply to it, and the bounds every value obeys. |
| `JournalGrantStore`   | A grant store that replays and persists its decisions through `Journal`.                                     |
| `GrantEvent`          | The durable grant vocabulary: once, remembered, run, denied, and envelope grants, with their schema.         |
| `HostServices`        | The closed list of five host slots, and the aggregate layer that decorates all of them in place.             |
| `FileSystem`          | The guarded filesystem, its canonical resources, and the confinement a host attaches at its boundary.        |
| `HttpClient`          | The guarded HTTP client: `net:get`, `net:post`, `model:call`, and every redirect hop rechecked.              |
| `ChildProcessSpawner` | The guarded spawner over Effect's own tag.                                                                   |
| `ContainedSpawner`    | A `SIGTERM`-then-`SIGKILL` deadline on every child, and a ledger entry released when its scope closes.       |
| `ProcessConfinement`  | Host confinement for approved processes, derived conservatively from effective grants and ceilings.          |
| `ProcessLedger`       | The durable record of spawned processes, and the `orphans` a dead host leaves its successor to reap.         |
| `CommandLine`         | The one renderer shared by the `proc:spawn` capability resource and the interpreters that run the line.      |
| `Jj`                  | The guarded [Jujutsu](https://jj-vcs.github.io) repository port over `@smthrs/jj`'s own tag.                 |
| `Path`                | Effect's `Path`, passed through unchecked by decision.                                                       |
| `Workspace`           | The root that filesystem capability resources are resolved against.                                          |

`ChildProcessEnvironment` builds a replacement environment from bootstrap names plus explicit declarations, withholding credential-shaped ambient values.

`Capability` and `Permission` are re-exports; their modules live in
[`@smthrs/capability`](https://capability.smithers.sh).

Two test helpers ship in the package's export map, not as dev-only files:
`@smthrs/kernel/test/TestGrantStore` for allow, deny, and scripted grant-store
doubles and `@smthrs/kernel/test/contract` for `runHostContract`, the behavioral
contract every host bundle must satisfy (`test/HostContract` is an alias).
The contract is Node-only. The
deterministic host bundle lives at `@smthrs/testing/TestHost` so the kernel does
not depend back on a platform implementation.

## Documentation

- [Overview](https://kernel.smithers.sh)
- [Quickstart](https://kernel.smithers.sh/quickstart/)
- [Guard a host bundle](https://kernel.smithers.sh/guides/guard-a-host-bundle/)
- [Write a capability policy](https://kernel.smithers.sh/guides/write-a-capability-policy/)
- [Decoration in place](https://kernel.smithers.sh/concepts/decoration-in-place/)
- [API reference](https://kernel.smithers.sh/reference/api/)
- [Troubleshooting](https://kernel.smithers.sh/troubleshooting/), which lists
  every refusal this package raises, what it means, and what to change.

`@smthrs/kernel` is one package of the Smithers durable flow engine, which
ships whole as [`@smthrs/flows`](https://flows.smithers.sh).

## License

MIT. See [LICENSE](./LICENSE).

---
title: "Testing"
description: "Test guarded hosts with the kernel grant-store doubles, the shared host contract suite, and the deterministic host from @smthrs/testing."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/kernel/docs/testing.md"
---

The kernel ships two public test helpers: `test/TestGrantStore` and
`test/contract` (also exported as `test/HostContract`). They are published code,
so consumers can use the same doubles and host contract as the package tests.

## Run the kernel suite

From the repository root, run `pnpm --dir packages/smithers/flows/kernel exec vitest run`.
The same command runs in the independent Windows kernel job, with the package's
coverage thresholds enforced.

## Pick a grant-store double

`@smthrs/kernel/test/TestGrantStore` gives you three layers, and none of them
needs a `Workspace`:

```ts
import * as TestGrantStore from "@smthrs/kernel/test/TestGrantStore"

TestGrantStore.layerAllow // every check passes
TestGrantStore.layerDeny("denied by test") // every check fails permission_denied
TestGrantStore.layerScripted(["once", "deny"]) // a deterministic sequence
```

`layerScripted` consumes one reply per check, in order. `once`, `run`, and
`remembered` allow the check; `deny` rejects it; exhausting the script rejects
every further check with the reason
`"permission reply script exhausted"`. Use it to assert **which** operations a
subject attempts and in what order, which a blanket allow or deny cannot show.

For a test about policy rather than about the subject, build a real store with
`GrantStore.layer({ attended: false, rules })` instead. It exercises the actual
evaluation path, and it needs a `Workspace`.

## Run against the deterministic host

Add `"@smthrs/testing": "workspace:*"` to the consuming package's
devDependencies in the checkout. See [Installation](/installation/).

`@smthrs/testing/TestHost` is the whole host surface with every source of
nondeterminism pinned: a `Map`-backed filesystem, a scripted interpreter,
`TestClock` so time moves only when a test moves it, and a seeded PRNG.

```ts
import * as TestHost from "@smthrs/testing/TestHost"

const host = TestHost.layer({
  files: { "/workspace/README.md": "# hello" },
  commands: { "npm test": { stdout: "1 passing\n", exitCode: 0 } },
  seed: 42
})
```

`TestHost.TestHost` is the zero-config bundle: empty filesystem, no scripted
commands, seed 42.

Three details are worth knowing. The filesystem is the very same
`BrowserFileSystem` adapter the browser runs, over a `Map`-backed volume, so a
bug in the adapter shows up in tests instead of hiding behind a second
implementation. The spawner is provided **over** the filesystem and path
layers, exactly as `NodeChildProcessSpawner` is, so the interpreter and the
`FileSystem` service agree about what exists. And a command that is not in
`commands` fails the way a real shell reports a missing binary, so a test
cannot accidentally depend on a host tool being installed.

`Jj` is [`@smthrs/jj`](https://jj.smithers.sh/reference/api/)'s `layerUnsupported`, whose every operation
fails with `not_installed`, so a test that reaches for the repository fails
loudly rather than touching the real machine. `HttpClient` is
`HttpClient.layerNoop`, which reports the absent host as a `TransportError`.

The module is Node-only: `effect/testing`'s `TestClock` reaches for
`node:assert`.

## Run the shared host contract

`@smthrs/kernel/test/contract` exports `runHostContract`, the behavioral
contract every host bundle must satisfy: the complete filesystem, process, Jj,
and HTTP capability matrices, including observable process liveness and
multi-leg pipelines. The Node, Bun, browser, test, and deliberately
unsupported bundles all run it.

It registers Vitest cases, so it requires the declared peers
(`@effect/vitest@4.0.0-rc.115` and `vitest@5.0.0`) and Node process and
temporary-directory fixtures. See
[Adapt a new host platform](/guides/adapt-a-new-host-platform/) for how to
declare your bundle's capabilities to it.

## What the package already proves

The kernel's own suite covers capability-set intersection and equality;
bounded, immutable grant state; journal replay and its envelope limits;
canonical filesystem resources and descriptor identity; command snapshots;
process containment and ledger recovery; HTTP method, origin, and redirect
authorization; Jujutsu resources; browser-safe imports; and every supported and
refused host operation.

If you are testing a subject that reaches the host, you rarely need to re-prove
any of that. Test what your subject does with the refusal.

## Related

- [Quickstart](/quickstart/): the doubles in a working composition.
- [Handle a permission failure](https://capability.smithers.sh/guides/handle-a-permission-failure/):
  reading the typed error a refusal carries.

---
title: "Runtime parity with Node"
description: "Which adapters Bun and Node share, how contained hosts prepare a runtime supervisor, and which runtime and platform boundaries still need separate verification."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-bun/docs/concepts/runtime-parity.md"
---

The Bun bundle shares its host adapters with Node. A flow asks for the same
service tags on either runtime. Shared source does not make every runtime or
operating-system behavior identical, especially around native process pipes
and cleanup.

## Bun and Node run the same modules here

Three of the raw bundle's five slots use shared implementations:

- `@effect/platform-bun/BunChildProcessSpawner` is
  `@effect/platform-node-shared`'s spawner re-exported. Spawning a child is one
  module, so there is nothing for a detection branch to choose between.
- `@smthrs/jj/bun/BunJj` is `@smthrs/jj/node/NodeJj` re-exported, because Bun
  implements the child-process API the argv-safe jj adapter uses. The two share
  the same error classification and the same interruption finalizer by
  construction, not by agreement.
- The filesystem slot is `@smthrs/platform-node`'s `AtomicFileSystem.layer`
  itself, the same value [`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/) puts in
  its own slot.

`effect/Path` is runtime independent, and the network slot is the shared Undici egress client, including the same
connection-pinning and proxy policy on both runtimes.

Contained POSIX variants substitute `ProcessReaper.layerSpawner`. It combines
the shared native process adapter with a supervisor started by the current
Node or Bun runtime. Preparation records the supervisor before executing the
target. Compiled Bun executables and Node single-executable applications are
refused before activation because they do not supply the runtime eval entry
point. Windows retains the raw runtime spawner and remains unsupported best
effort for containment.

## Two consequences you can rely on

**The bundle runs unchanged under Node.** Nothing in it requires the Bun
runtime, so a program composed on `BunHost.layer` executes on Node 26.4.0 or later as well. That is not a compatibility shim; it is what "the same modules"
means. The package declares both floors in `engines`.

**Recorded durable behavior does not require a Bun-specific flow.** The same
service contracts and error adapters are available on Node. Replay still
depends on the flow's recorded inputs and implementations; shared source alone
does not prove that a new native command has identical behavior on both hosts.

## Node-only in the browser-bundle sense

The same property that makes the bundle portable between Bun and Node is what
stops it reaching a browser. Falling back to the `@effect/platform-node`
adapters means resolving `node:` built-ins, so a browser bundler asked to
resolve `@smthrs/platform-bun` stops at `node:fs`. That is the intended
resolution, not a packaging defect to work around with an alias.

It runs on Bun and it runs on Node. What it does not do is bundle for a page.
That is [`@smthrs/platform-browser`](https://platform-browser.smithers.sh/reference/api/), which fills the
same five slots from browser primitives.

## Where the parity stops

The package's `test` target runs conformance under Node with V8 coverage.
The `bunTest` target imports Vitest's JavaScript entry under Bun and asserts
`process.versions.bun` inside every worker. Both lanes exercise redirects,
process containment, and filesystem helpers. Node coverage reports use private
`0700` directories under the package's gitignored `coverage/` directory and are
removed when the runner exits. Bun coverage is disabled.

Verify process streams, cancellation, and cleanup on the runtime and operating
system you deploy. The contained handle's POSIX
`pid` identifies its supervisor; target status and supported cleanup boundaries
are described in [Contain and reap child processes](/guides/contain-child-processes/).

The filesystem is the exception worth holding on to. Its no-follow extension
does not run in-process: it executes each guarded operation in a
`smithers-jj-export` subprocess, so the slot depends on that helper rather than
on anything either runtime ships. See
[Configure the filesystem helper](/guides/configure-the-filesystem-helper/).

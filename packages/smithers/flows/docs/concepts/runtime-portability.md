---
title: "Runtime portability"
description: "One durable engine, with Effect services selected at the host boundary."
---

# Runtime portability is a required contract

Smithers flow definitions and domain services must be Effect programs. Runtime
selection, connection creation and process spawning belong to injected host
services. Keep domain definitions independent of the executable that runs them.
`NodeRuntime` and `BunRuntime` bind the same `makeNative` runtime factory to their
matching database, host and cryptography layers.

The shared `@smthrs/flows/Runtime.storage` composition builds journal and durable
store layers over injected services; it does not select a SQL driver. The native
compositions supply that driver. SQLite adapters share the file guard and startup retries. PostgreSQL uses
the shared Effect SQL adapter and per-schema transaction locking. All stores
use the existing `DurableWriter` transaction policy.

```ts
import * as BunRuntime from "@smthrs/flows/BunRuntime"
import { Effect } from "effect"

const application = program.pipe(
  Effect.provide(BunRuntime.layerHost({
    filename: ".flows/engine.db",
    workspaceRoot: ".",
    owner: { hostId: "workspace-host" }
  }, registeredFlows))
)
```

Use `NodeRuntime.layerHost` with the same flow definitions in a Node executable.
The outer executable runs the Effect and owns its scope. The native host
composition forks that scope and builds the runtime inside it; closing the
caller's scope initiates runtime shutdown. `signals: []` leaves signal handling
with an embedding application. These examples cover native Node and Bun hosts;
browser and edge hosts need their own adapters and validation.

## Database ownership

Use the current flow execution identity and existing durable stores for coding
plans, checks, results, waits and recovery. A product-specific projection may
have its own migration namespace in the injected database when existing stores
do not represent it. It must not create a separate connection, job queue,
command ledger or lease system to repeat the engine's responsibilities.

For SQLite, the Node adapter requires Node's SQLite implementation. Under Bun, select
`@smthrs/database/bun/BunDatabase`; a wrong-driver refusal names that correction.
The durable engine itself has no Bun exclusion. Both SQLite drivers reject legacy
Smithers 0.x databases before adding tables. Either runtime can instead select
PostgreSQL using `SMITHERS_POSTGRES_URL` or an explicit connection string; see
[database configuration](https://database.smithers.sh/concepts/sqlite-only/).

## Evidence and regression contract

`test/NativeRuntimeParity.test.ts` launches separate real Node and Bun processes.
A flow executes a recorded action and parks on a durable deferred; the other
runtime opens the same database, completes the deferred and resumes the flow.
Reopening it in the first runtime must not repeat that action. Both directions
are exercised on SQLite and, with `SMITHERS_TEST_PG_URL`, PostgreSQL. This is native Bun execution, not running Node through a Bun
package-manager shim.

The Node suite contains named regression cases for registration ordering,
ownership, process containment and signal cleanup. These sources describe test
coverage; they do not certify that a particular test run passed. Bun-specific host and database contract
coverage must be expanded alongside behavior changes. A Node sidecar is not a
compatibility solution: when a supported runtime cannot run a flow, repair its
injected platform implementation and add a regression scenario here.

The shared confined filesystem also has a native Node/Bun regression for
concurrent macOS developer-tool launches. This covers helper identity when
developer-tool entry points share a hard-linked inode: choosing a different
hard-link name can dispatch the wrong tool. The shared host resolves the interpreter's parent directory and
follows actual leaf symlinks while preserving a hard-linked executable's entry
name. Explicit configuration still uses `AtomicFileSystem.layerWith`; domain
flows do not choose interpreters. Preserve executable identity, workspace confinement,
environment isolation and process limits in the shared host layer for both
runtimes; do not recreate those policies inside domain flows.

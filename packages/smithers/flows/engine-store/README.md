# @smthrs/engine-store

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://engine-store.smithers.sh

The durable half of the Smithers flow engine. It persists every step a flow
takes to a SQLite database, so a flow that crashes, is killed, or waits for a
week resumes where it stopped instead of starting over.

It is an [Effect](https://effect.website) library: every surface it exports is
a `Layer` you compose or an `Effect` you run.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

Node.js 26.4.0 or later. The package ships as both ESM and CommonJS with
TypeScript declarations.

## Testing

`smthrs test '//packages/smithers/flows/engine-store:test'` runs the existing
suite on SQLite and real PostgreSQL. By default the matrix starts and cleans
up its own disposable PostgreSQL server. To use an existing server, supply
`SMITHERS_TEST_PG_URL` before invoking the command; the target declares that
connection in its environment and execution key.

The canonical override accepts a credential-free `postgres:` or `postgresql:`
URL with optional `sslmode` and positive, at most two-digit `connect_timeout`.
Declared configuration is visible in plans, so passwords, credential files,
service configuration and other query options are refused without echoing the
URL. An unavailable configured server fails the PostgreSQL leg. The direct
matrix script retains its existing password support and disposable-server path.

## The shortest real use

`EngineStore.layer` is the composition. It provides `FlowRuntime`, the service
that executes a flow durably, and the snapshot boundary the engine measures
each step against:

```ts
import { EngineStore } from "@smthrs/engine-store"
import { FlowRuntime } from "@smthrs/flow"
import { Effect } from "effect"

const engineLayer = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "engine-store"
})

const program = Effect.gen(function*() {
  return yield* FlowRuntime.FlowRuntime
}).pipe(Effect.provide(engineLayer))
```

`engineLayer` still needs the storage it composes: `DurableWriter`, `Journal`, `RunStore`,
`AttemptStore`, `CacheStore`, `DurableEngineState`, `StepBoundary`, `Jj`,
`OwnerIdentity`, Effect's `Crypto`, and a `Scope`. Supply the same `DurableWriter`
used by the journal and run store. A missing service is an unmet
requirement in the layer's type, so a bad composition fails to compile rather
than at run time. Run the schema migrations before any SQL-backed service reads
the database, and provide `OwnerIdentity.layer` unless the host mints its own
owner tokens.

[The quickstart](https://engine-store.smithers.sh/quickstart/) wires all of it
over one SQLite file and watches a sealed step replay after a restart.

If you want the wiring rather than control over it, reach for
[`@smthrs/flows`](https://flows.smithers.sh) instead. It ships `NodeRuntime`,
which composes this package with the flow language, the journal, the run and
cache stores, and the artifact tier over one file.

## What it gives you

- **Durable attempts.** A step opens a row before its body runs and settles it
  afterwards, so a restart replays the recorded result instead of executing the
  body a second time.
- **One owner per run.** Every durable write is fenced against the owner that
  claimed the run, so two processes over one database cannot both drive it. A
  dead owner's runs are reclaimed under a liveness check you choose.
- **Waits that outlive the process.** A parked run holds a durable deferred or
  clock row, so a timer set by a process that has since died still fires.
- **Declared file boundaries.** The engine measures the tree a step actually
  touched against what it declared, refuses a step that wrote outside it, and
  admits only whole-tree evidence into the cache other runs read.
- **Explicit deletion.** Old run history and unreferenced artifacts go away
  when you run a retention or garbage-collection pass, never on a schedule you
  did not set.

Every durable write is one transaction. A lifecycle event is written inside the
same transaction that carries the state transition it describes: the attempt
row with its start and finish records, the run-row compare-and-set with its
decision, the deferred or clock row with its record, the cache entry with its
provenance. Either both halves are durable or neither is, so audit, sync, and
time travel never read a hole. No local transaction makes a remote effect
atomic, so external effects still need idempotency keys, fencing, or
compensation.

Closing an engine's Effect scope releases its run ownership across the full
claim, execution, and settlement lifetime. An interrupted partial claim is
abandoned; an activated run returns to `suspended`, preserving any declared
approval, timer, or event wait. This lets a replacement engine in the same
process resume with a new owner nonce without weakening the PID liveness
check. Only a persisted operator cancellation closes the run as `cancelled`.

## Browser imports and native durable execution

The entry point bundles for a browser. The two host reads it once made
directly, `process.pid` and `randomUUID` from `node:crypto`, enter through the
injectable `OwnerIdentity` service, and the SQL contracts it imports are
driver-neutral.

Bundling is not running. The durable backing is SQLite or PostgreSQL, composed by the
aggregate [`@smthrs/flows` runtime](../README.md) with native Node.js or Bun
host adapters and the selected SQL client over these driver-neutral stores. A browser or edge deployment
can import the types and browser-safe in-memory helpers, but cannot execute
durable flows; supplying an alternative browser SQL client is not a supported
runtime.

## Documentation

The full documentation is at <https://engine-store.smithers.sh>:

- [Installation](https://engine-store.smithers.sh/installation/): runtime
  requirements, import forms, and the storage packages a runnable composition
  adds.
- [Quickstart](https://engine-store.smithers.sh/quickstart/): compose a durable
  engine over SQLite and watch a step replay after a restart.
- [Compose a durable engine](https://engine-store.smithers.sh/guides/compose-a-durable-engine/):
  the required and optional services, and what each one changes.
- [API reference](https://engine-store.smithers.sh/reference/api/): every public
  export, with signatures and error codes.
- [Observe executions and page runs](https://engine-store.smithers.sh/guides/observe-executions/):
  coherent snapshots, filtered keyset pages, durable children and revisioned catch-up.
- [Troubleshooting](https://engine-store.smithers.sh/troubleshooting/): each
  typed failure, its cause, and its fix.

See also [durable execution](https://smithers.sh/docs/concepts/durable-execution/)
and [content addressing](https://smithers.sh/docs/concepts/content-addressing/)
on smithers.sh.

List reads of durable wait state skip corrupt rows and log storage-integrity warnings; point reads still fail for an invalid row.

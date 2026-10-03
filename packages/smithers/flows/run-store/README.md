# @smthrs/run-store

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://run-store.smithers.sh

Durable run state and fenced ownership for long-running jobs, as
[Effect](https://effect.website) services. `@smthrs/run-store` keeps one SQL row
per run holding what the run is doing, which process owns it, and the executable
state a restart re-enters. It also arbitrates who is allowed to touch that row,
so a process that comes back from the dead cannot overwrite the one that
replaced it.

Two services, `RunStore` and `AttemptStore`, plus the `Ownership` liveness
checks and heartbeat supervision. Arbitration itself — who holds the claim,
who holds the lease, whether a fence still stands — is delegated to
[`@smthrs/journal`](https://journal.smithers.sh)'s injectable `Consensus`
strategy, the same one the journal fences its durable channel through; the
run row mirrors the strategy's answer in the same transaction. They carry no
database of their own: both are written against the driver-neutral
[`@smthrs/database`](https://database.smithers.sh) contract, so the same code
runs over a local SQLite file, over a server, or over an in-memory database in a
test.

## Install

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

`effect` is a peer dependency at exactly `4.0.0-rc.115`. Two copies of `effect` in
one program are two sets of service tags, so a store layer built against one
copy cannot be provided to a program holding the other.

The package requires Node.js 26.4.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. Only the in-memory test layer binds a
Node built-in; the root entry point names no driver and bundles for the
browser.

## Take a run, do the work, settle it

This program creates a run, claims ownership of it, and finishes it. The stores
are the production ones; `TestRunStore.layer` provides them over a migrated
in-memory database, so the file runs with no configuration.

```ts
import { RunStore } from "@smthrs/run-store"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import * as TestRunStore from "@smthrs/run-store/test/TestRunStore"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"

const owner: OwnerId = { hostId: "worker-1", pid: 4102, nonce: "9c31-af02" }

const program = Effect.gen(function*() {
  const runs = yield* RunStore.RunStore

  yield* runs.create("build-42", JSON.stringify({ step: "checkout" }))

  const nowMs = yield* Clock.currentTimeMillis
  const taken = yield* runs.claimAndOwn(
    "build-42",
    { status: "pending", owner: null, heartbeatAtMs: null },
    owner,
    nowMs
  )
  if (taken._tag !== "Activated") return `another process has it: ${taken._tag}`

  // Do the work here, heartbeating while it runs.

  const settled = yield* runs.transitionOwned(
    "build-42",
    owner,
    "completed",
    JSON.stringify({ step: "done" })
  )
  return `run ended as ${settled._tag}`
})

console.log(
  await Effect.runPromise(
    program.pipe(Effect.provide(TestRunStore.layer), Effect.scoped)
  )
)
```

```text
run ended as Transitioned
```

The second argument to `claimAndOwn` is the row as you last read it, restated as
the three fields a claim guards. The third argument is the new owner. The claim
is admitted only while the row still matches. If a peer took the run between
your read and your write, this caller loses the race and leaves the peer's
ownership unchanged.

## What the stores guarantee

- **One row is the authority.** A restarted process reads the run row for its
  status, owner, heartbeat, cancellation request, and the executable state to
  re-enter, instead of replaying a log to work out where it was.
- **Every owned write carries a fence.** An owner identity is
  `{ hostId, pid, nonce }`, and every owned mutation asks the `Consensus`
  strategy whether that identity still holds the run inside the same
  serialized write transaction as the mutation it guards. There is no window
  between checking ownership and using it, so two processes cannot both win.
- **Competition is a value, not an error.** Losing a race returns
  `AlreadyClaimed`, `HeartbeatFresh`, or `FenceLost` as an ordinary success
  value you branch on. The error channel is reserved for real defects: invalid
  input, a corrupt row, a constraint violation, a database failure.
- **A takeover needs evidence, not just a timeout.** An expired lease says the
  owner stopped writing, not that it stopped working. `steal` and `recoverClaim`
  additionally require `LivenessEvidence` about the recorded owner, bound to the
  exact instant it is spent, and every unknown probe answer is read as life.
- **Step attempts inherit the run's fence.** `AttemptStore` records when each
  execution of a step started, the checkpoints it wrote, and how it ended, and
  refuses every write from a process that no longer owns the run.
- **Persisted values are copied inert.** Run state, checkpoints, errors,
  outcomes, and metadata are walked into a frozen detached copy before
  persistence can yield, so a getter, a cycle, or a `toJSON` method is refused
  rather than persisted, and rows are validated again on the way out.

## Public API

The root exports each module as a namespace, and each is also importable from
the matching `@smthrs/run-store/*` subpath. The
[API reference](https://run-store.smithers.sh/reference/api/) lists every export.

| Namespace         | What it holds                                                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunStore`        | The run lifecycle: create, read, cancel, the six claim operations, heartbeat, and owned transitions, with `layer` over `SqlConsensus` and `layerWith` over an injected strategy. |
| `AttemptStore`    | Fenced step attempts: start, heartbeat with a checkpoint, finish, patch, and read, with its policy options.                                                                      |
| `Ownership`       | `OwnerId` and `LivenessEvidence` from the journal, fail-closed pid probing, the lease checks, and the heartbeat supervision loop.                                                |
| `RunStoreMetrics` | `flows_run_claims`, `flows_run_heartbeats`, and `flows_run_transitions`, attributed by operation and outcome.                                                                    |
| `Migrations`      | The `flows_runs` and `flows_attempts` migration set, and the runner and layer that install the journal's set ahead of it.                                                        |

The root and those subpaths are driver-neutral and bundle for the browser.
Two subpaths are not namespaces of the root:

| Import                                | Platform | What it holds                                                                                                                                                                                                                                                                                |
| ------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@smthrs/run-store/Heartbeat`         | any      | The lease durations `heartbeatInterval`, `heartbeatStaleAfter`, `heartbeatSkewAllowance`, and `heartbeatWriteTolerance`, defined by `@smthrs/journal`'s `Consensus` and also re-exported from `Ownership`. A consumer that needs only the durations imports this leaf and pulls in no store. |
| `@smthrs/run-store/test/TestRunStore` | Node     | `layer`, providing migrated in-memory `RunStore` and `AttemptStore` services.                                                                                                                                                                                                                |

Migration implementations and package internals are blocked in the export map:
the migration set is the contract, not the numbered files inside it.

## Where the run store sits

`@smthrs/run-store` is one of the storage services inside
[`@smthrs/flows`](https://flows.smithers.sh), the package that carries the whole
Smithers durable flow engine in a single dependency. Flow authors never call it.

Reach for it directly when you are building the host rather than the flow: a
scheduler, a worker pool, or any service that hands durable work between
processes and needs ownership arbitration it can trust. Most hosts do not wire
it by hand even then.
[`@smthrs/engine-store`](https://engine-store.smithers.sh) already composes
these stores with the journal, the step cache, and the engine's own state into
one storage ladder.

The stores hold executable state. History lives in
[`@smthrs/journal`](https://journal.smithers.sh), and the two halves stay
consistent because both write through the same `@smthrs/database`
`DurableWriter`: `Journal.transact` commits a state projection and its durable
events in one transaction.

## Documentation

Full documentation is at
[run-store.smithers.sh](https://run-store.smithers.sh):

- [Installation](https://run-store.smithers.sh/installation/)
- [Quickstart](https://run-store.smithers.sh/quickstart/): one run through its
  whole lifecycle, including a step attempt.
- [Fencing and ownership](https://run-store.smithers.sh/concepts/fencing/): the
  compare-and-swap every write goes through.
- [The heartbeat lease](https://run-store.smithers.sh/concepts/leases/): the
  four durations, the two clocks that stamp one row, and what a wall-clock lease
  cannot promise.
- [Liveness evidence](https://run-store.smithers.sh/concepts/liveness-evidence/):
  what admits a takeover.
- [Durable values](https://run-store.smithers.sh/concepts/durable-values/): the
  persistence boundary and its shape limits.
- [Execution revisions](https://run-store.smithers.sh/concepts/execution-revisions/):
  database identity, monotonic changes, retained tombstones and cancellation acknowledgement.
- [API reference](https://run-store.smithers.sh/reference/api/): every public
  export.
- [Troubleshooting](https://run-store.smithers.sh/troubleshooting/): each
  refused outcome and typed error, and what to change.

## License

MIT

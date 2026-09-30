# @smthrs/time-travel

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://time-travel.smithers.sh

Read a durable run's past, branch it, or take it back. One injectable Effect
service, `TimeTravel`, carries the four verbs that do it: `replay` and `inspect`
read, `fork` branches, and `rewind` truncates. Each acts at a _frame_, a point
in the run's committed journal, and none of them re-executes anything.

The service folds the journal a run already wrote, so a replay costs nothing
and cannot change the run. It ships an in-memory store and a SQL store for SQLite or PostgreSQL, and it
reads the effect-boundary evidence that decides whether a rewind is safe.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

A durable fork reuses completed action results through its frame, including
compensable and irreversible actions. Steps after the frame execute under the
child's own identity, even with a shared cache environment. See
[Fork a run](https://time-travel.smithers.sh/guides/fork-a-run/).

Node.js 26.4.0 or later. The package ships ESM and CommonJS with TypeScript
declarations, and its root entry point bundles for the browser with no `node:`
built-in.

## Public API

Time travel is ONE injectable service. `TimeTravel` and the read-only
`ReadOnlyTimeTravel` are exported flat, because the service key is the door,
beside the namespaces you inject or integrate with. The `TimeTravel` module's
types and its two constants are re-exported flat with them, so annotating a
signature takes no second import.
Every module is also reachable at the matching `@smthrs/time-travel/*` subpath;
`@smthrs/time-travel/internal/*` is blocked at the `exports` map.

| Export                  | Public surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TimeTravel`            | The service key. Operations `replay(position, projection, options?)`, `inspect(position, projection)`, `fork(position, options?)`, and `rewind(position, options?)`, where a `Position` is `{ runId, frame }`. Beside it: `Service`, `Position`, `Projection`, `ReplayOptions` (`pageSize`, `maxHistoryEntries`, `engineEvents`), `ForkOptions` (`workspaceRoot`, `retainWorkspace`, `maxHistoryEntries`), `RewindOptions`, `ForkResult`, `RewindResult`, `Options` (`isAlive`, `maxHistoryEntries`), `defaultMaxHistoryEntries`, `forkWorkspaceName`, `make`, `makeWith`, `layer`, `layerWith`, and `readOnly`. A fork's jj workspace is named after the child run it mints, under `ForkOptions.workspaceRoot`, and pinned at the frame's recorded pointer; `forkWorkspaceName(childRunId)` returns that name. |
| `ReadOnlyTimeTravel`    | The read-only service key, carrying `replay` and `inspect` only. `TimeTravel.readOnly` builds it from `Journal` and `CacheStore` alone: no startup recovery, no mutation services, and no way to fork or rewind.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Frame`                 | `Frame` schema/type, `LineageEdgeKind` schema/type, `LineageEdge`, plus `forkCreatedEventType` and the `ForkCreated` payload a forked run records on its own journal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `TimeTravelError`       | `TimeTravelErrorCode` schema/type, `TimeTravelError`, and `error(code, message, cause?)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `TimeTravelStore`       | Models `Snapshot`, `AttemptRef`, `Descendants`, `Audit`, `AuditPatch`, `Receipt`, `ArchiveResult`, `Fork`, and `ForkIntent`; `Service` operations `snapshotAt`, `recordSnapshot`, `stateAt`, `attemptsAt`, `descendants`, `writeAudit`, `updateAudit`, `pendingAudits`, `archiveAndTruncate`, `archivedAt`, `nextForkId`, `abandonForkIntents`, `createFork`, and `recordReceipt`; `make`, `makeNoop`, and `layerNoop`.                                                                                                                                                                                                                                                                                                                                                                                         |
| `MemoryTimeTravelStore` | `JournalRecord`, `MemoryState`, and `Options`; deterministic `make(options?)` and `layer(options?)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SqlTimeTravelStore`    | Database-backed `migrate`, `make`, and `layer`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `EffectBoundary`        | The producer side: `EffectTier`, `EffectStatus`, `EffectRecord`, and `Description`; `eventType`; `guard`, `decodeEntry`, `fromRecords`, and `fromEntries`. `decodeEntry` skips a foreign event type and fails closed on a corrupt payload of its own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `CompensationHandlers`  | The contribution door: the `Handler` shape (`kind`, `tier`, `requiresIdempotencyKey`, `compensation`, `residue`, `assess`, `revert`, `rollback`), the `Classification` and `Assessment` schemas a custom `assess` is decoded against, the optional service, `layer(handlers)`, and `layerNoop`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Migrations`            | The same DDL as a rung on the shared migration ladder at id block `5000`: `set`, `sets`, `run`, and `layer`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

`Replay`, `Fork`, `Rewind`, `Recovery`, `Compensation`, `SnapshotProjector`,
`HistoryLimit`, and `EffectHandlerRegistry` are machinery a caller never names, and `@smthrs/time-travel/internal/*` is not importable.
Recovery is never a call: building `TimeTravel.layer` finishes or rolls back any
rewind a crash interrupted, and forgets the jj lane of any fork that reserved an
id and died before it committed.

`replay` and `inspect` are one fold. `replay` takes the read knobs
(`pageSize`, `maxHistoryEntries`, `engineEvents`); `inspect` is the same fold
under the service defaults and takes no options, so a run whose journal carries
versioned engine records is readable only through `replay`.

A lineage id is minted, never spelled. `FlowEngine.Lineage` is the one
constructor for it, the engine stamps its result on every record a run writes,
and the encoding is versioned. This package only stores and compares the value,
so it takes no dependency on the engine; the example reaches the constructor
through `@smthrs/flows`, the barrel a caller already installs.

```ts
import { Engine } from "@smthrs/flows"
import { TimeTravel } from "@smthrs/time-travel"
import { Effect } from "effect"

const rewound = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
  return yield* timeTravel.rewind({
    runId: "build-42",
    frame: { lineageId: Engine.FlowEngine.Lineage.root("build-42"), seq: 17 }
  })
})
```

## Failure behaviour

Every operation fails as a `TimeTravelError` discriminated by a closed `code`.
The [API reference](https://time-travel.smithers.sh/reference/api/) carries the
full table; in short:

`busy` (another owner holds the run), `live_parent` / `live_child` (the run or a
descendant is still executing), `not_found` (the run or frame addresses
nothing), `invalid` (a malformed option or an undecodable durable payload),
`already_crossed` (the effect already crossed its durable boundary),
`rate_limited`, `compensation_failed` (a rollback or workspace restore failed),
`irreversible` (a crossed effect cannot be undone), `fence_lost` (ownership was
superseded before a mutation committed), `limit_exceeded` (the operation would
read more journal entries than `maxHistoryEntries` allows), and `unknown`.

A rewind removes the mutable deferred completions and clock deadlines whose
completion or schedule records lie in the archived suffix. Reaching those
awaits again therefore parks or schedules them from the rewound history; a
discarded future cannot answer them.

## Limits

- The SQL store runs on an injected SQLite or PostgreSQL `SqlClient`. Other
  dialects, including MySQL, are unsupported.
- Journal reads page at 100 entries by default; `pageSize` is a throughput knob
  and never changes a derived answer.
- Every read is capped by `maxHistoryEntries`: the prefix a replay folds, or
  the suffix a fork or rewind assesses. The default is 100,000 entries
  (`TimeTravel.defaultMaxHistoryEntries`); `TimeTravel.layerWith({ maxHistoryEntries })`
  changes the service default and each verb's options override it per call.
  An operation past the cap fails `limit_exceeded`, a rewind before it claims
  the run. A replay streams the fold and stops at the frame; a fork or rewind
  keeps only the effect-boundary records of the suffix it assesses.
- The anchor refresh a fork or rewind runs first reads only the entries above
  the run's anchored high-water mark and at or below the frame, under the same
  cap, and writes each page's anchors in one store write. A run whose anchors
  are current reads one page and writes nothing. A rewind revalidates the tail
  under its claim from one page at the expected tail, never a second scan.
- A fork that reserved its id and died before committing leaves its jj lane
  registered until the next build of `TimeTravel.layer`, which forgets lanes
  whose reservation is older than five minutes. The reserved ordinal is never
  handed out again, so the retry lands under a fresh lane name.
- `Projection.reduce` receives store entries by reference. Treat them as
  read-only.
- Time travel is a library API, also exposed as
  `smthrs runs inspect|replay|fork|rewind`; see the
  [CLI reference](https://smithers.sh/docs/reference/cli/). MCP exposes these
  verbs only through the unified command tools.

## Documentation

- [Quickstart](https://time-travel.smithers.sh/quickstart/): execute a durable
  run, then fold its journal into a number.
- [Installation](https://time-travel.smithers.sh/installation/): the five
  services `TimeTravel.layer` requires.
- [API reference](https://time-travel.smithers.sh/reference/api/): every public
  export and the closed list of failure codes.
- [Troubleshooting](https://time-travel.smithers.sh/troubleshooting/): each
  refusal, and what to change.

Licensed MIT.

# @smthrs/control

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://control.smithers.sh

Control services and RPC projections for flows. It defines the
transport-independent Control service, its runtime and execution ports, local
and RPC implementations, verified ingress channels, credentials, and the shared
wire schemas both halves decode.

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/).

The package
requires Node.js 26.4.0 or later and ships as both ESM and CommonJS with
TypeScript declarations.

It imports no `node:*` module, so the same modules run in Node.js and in a
browser that supplies a SQL driver. That is a statement about the imports, not
a tested guarantee: verify your own bundle before you depend on it.

The `smthrs` command line, [`@smthrs/cli`](https://cli.smithers.sh), is a host
over this package: its verbs call the `Control` service defined here and
nothing else. Install the CLI to drive runs from a shell; install this package
to build a host of your own, such as a gateway, an MCP server, or a dashboard.

## Public API

The root entry point exports these namespaces; each is also importable from
`@smthrs/control/<Module>`. Every export of every namespace, with its
signature, is on the [API reference](https://control.smithers.sh/reference/api/).

| Namespace                                           | What it is                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Control`                                           | The service: `plan`, `run`, `approve`, `deny`, `steer`, `signal`, `cancel`, `resume`, `list`, `watch`. |
| `ControlSchema`                                     | The serializable values both halves of the wire decode, and the RPC request schemas.                   |
| `ControlError`                                      | Every stable failure, as classes and as one membership schema.                                         |
| `ControlLive`                                       | The in-process implementation over the runtime, the journal, the notification queue, and the registry. |
| `ControlRuntime`                                    | The persistence port, plus `layerMemory`.                                                              |
| `SqlControlRuntime`                                 | The durable persistence adapter over a SQL database and the fenced run store.                          |
| `ControlExecutor`                                   | The execution port: launch, cancel, signal, resume, and the park settlement a cancel needs.            |
| `DispatchReader`                                    | The trigger read port: registered triggers and the fire ledger `list` pages; `layerNone` refuses.      |
| `ControlRpcs`, `ControlServer`, `ControlClient`     | The RPC contract, the HTTP and WebSocket mount, and the client projected back into `Control`.          |
| `ScopedToken`                                       | Scoped, expiring tokens minted under a bearer credential and verified with it.                         |
| `Lineage`, `Cancellation`, `Steering`               | Pure projections: how a run came to exist, who cancelled it, and when a steer was delivered.           |
| `Monitor`                                           | Run health as a pure classification, and the beat loop that acts on it.                                |
| `Health`                                            | Configurable Effect checks, bounded observation policies, provenance, and the shared status rollup.    |
| `JevSessionChecker`                                 | The registered `jev.session` checker: does this session's own output show it waiting on a person?      |
| `Channels`, `WebhookChannel`                        | Verified ingress: an external request becomes a control mutation, once.                                |
| `Credential`, `CredentialStore`, `CredentialCipher` | The credential boundary and its two ports.                                                             |
| `SqlCredentialStore`, `WebCryptoCipher`             | Their durable and AES-256-GCM adapters.                                                                |
| `Migrations`                                        | The package's namespaced migration set and the layer that runs it.                                     |
| `SystemFlows`                                       | The reserved CLI verb to flow-id catalog.                                                              |

A host that binds `jev.session` supplies its existing evaluator through
`Health.makeRegistry(config, kind, evaluator)`. Native hosts use a subscription
seat. Missing configuration, unavailable seats and invalid judgments produce
`probe-error`, never a healthy result. No gateway key or separate auth path is
used.

```ts
import { Control } from "@smthrs/control"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const control = yield* Control.Control
  return yield* control.list({ _tag: "runs" })
}).pipe(Effect.provide(Control.layerNoop))
```

Use `ControlLive.layer` for in-process operation, `ControlClient.layer({ url, credential })`
for authenticated RPC, or `ControlRuntime.layerMemory()` when assembling a
deterministic runtime. `@smthrs/control/package.json` is also exported;
`internal/*` and nested `*/index` subpaths are blocked.

## Receipts and failures

Every mutation answers a `ControlSchema.Receipt` rather than throwing on a
second ask. `Accepted` means this call did the work, `AlreadyApplied` means an
earlier call under the same idempotency key did, `Conflict` means the key names
a different intent, `Parked` means the plan is waiting for an approval, and
`Terminal` means the run had already settled and reports the status it settled
with.

For `signal`, `Accepted` means durable admission. The command and its receipt
commit before execution observes the payload. Delivery is tracked separately
by `ControlRuntime.signalCommand`: `pending`, `delivered`, `rejected`, or
`terminal`. A definite incompatible wait still raises `NoMatchingWait`, and
that rejected disposition survives retries. Admission emits
`control.signal.admitted`; queued commands are never announced as delivered.

Before its first wait, each mutation copies only bounded JSON own data fields
and schema-decodes that detached value. Its durable fingerprint is a canonical
SHA-256 digest, and an authenticated request namespaces its idempotency key by
the principal's stable `kind` and `id`, not the changing server timestamp.
Accessors, `toJSON`, sparse arrays, cycles, and non-JSON objects are refused
with `InvalidInput` before any collaborator sees them.

`Channels.ingest` copies inbound bytes and own string header fields before
verification. A channel lists only the non-secret headers that change its
decoded command in `fingerprintHeaders`; those names are normalized
case-insensitively and joined with the body digest. Signature, authorization,
cookie, token, and credential headers stay outside durable identity. Reusing a
key with different declared semantics returns `Conflict`, while rotating an
excluded credential header remains the same delivery.

| Verb                       | Receipts                                             | Typed failures                                                                                                                                         |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plan`                     | returns a `PlanCard`, not a receipt                  | `FlowNotFound`, `InvalidInput`, `PersistenceError`, `Unavailable`                                                                                      |
| `run` (`Plan`)             | `Accepted`, `AlreadyApplied`, `Conflict`, `Parked`   | `PlanNotFound`, `PlanDenied`, `PlanDigestMismatch`, `EnvelopeMismatch`, `ClaimLost`, `InvalidInput`, `LaunchFailed`, `PersistenceError`, `Unavailable` |
| `run` (`Resume`), `resume` | `Accepted`, `AlreadyApplied`, `Conflict`, `Terminal` | `RunNotFound`, `ClaimLost`, `CodeDrift`, `InvalidInput`, `PersistenceError`, `Unavailable`                                                             |
| `approve`, `deny`          | `Accepted`, `AlreadyApplied`, `Conflict`, `Terminal` | `PlanDigestMismatch`, `EnvelopeMismatch`, `AlreadyResolved`, `PlanNotFound`, `RunNotFound`, `InvalidInput`, `PersistenceError`, `Unavailable`          |
| `steer`                    | `Accepted`, `AlreadyApplied`, `Conflict`, `Terminal` | `RunNotFound`, `InvalidInput`, `PersistenceError`, `Unavailable`                                                                                       |
| `signal`                   | `Accepted`, `AlreadyApplied`, `Conflict`, `Terminal` | `RunNotFound`, `NoMatchingWait`, `InvalidInput`, `PersistenceError`, `Unavailable`                                                                     |
| `cancel`                   | `Accepted`, `Terminal`                               | `RunNotFound`, `ClaimLost`, `InvalidInput`, `PersistenceError`, `Unavailable`                                                                          |
| `list`, `watch`            | a page or a stream                                   | every member of `ControlError`                                                                                                                         |

`ControlError.ControlErrorSchema` is the single membership list for the union,
including `CredentialConflict`, and `ControlClient.isControlError` is derived
from it. Each class carries a stable `code` (`plan_not_found`, `plan_denied`,
`run_not_found`, `claim_lost`, `no_matching_wait`, `invalid_input`, and so on)
that clients may branch on.

## Deployment requirements

`SqlControlRuntime` reads the engine's own columns for the projections it
reports: `flows_runs.waiting_reason`, the `flows_run_parents` spawn edges, fork
markers and `flows.engine.interrupted` entries in `flows_journal_events`, and
`cancel_requested_at_ms`. It reads them through the `SqlClient` it was built
over, so a composition that wants `RunSummary.waitingReason`, engine-created
children and forks in `list`, or `source: "engine"` cancel attribution must give
the control runtime and the engine ONE database.

The shipped `smthrs` CLI does not: it keeps `.flows/control.db` and
`.flows/engine.db` as two files, so one run has two rows. Cancellation still
converges, because the request is recorded on the engine row through the
`ControlExecutor` port and the owning driver settles from it. The projections
above are empty there.

## Limits

| Bound                       | Value                                                                                                | Refusal                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `list` page size            | `ControlSchema.defaultPageSize` (100) by default, `ControlSchema.maxPageSize` (500) maximum          | `InvalidInput` with code `invalid_input`, naming `limit`                                       |
| `list` cursor               | only a cursor a previous page returned                                                               | `InvalidInput`, naming `cursor`                                                                |
| `list` run filters          | `runId`, `flowId`, `status`, `parentRunId`, `lineageId`                                              | `InvalidInput` for `principalId`, which rc.0 records nothing to evaluate                       |
| `list` trigger listings     | `triggers` filters `triggerId`, `flowId`, `enabled`; `fires` filters `triggerId`, `runId`, `outcome` | `InvalidInput` naming `this host serves no trigger store` when no `DispatchReader` is provided |
| `watch` cursor              | `afterSequence` requires `runId`                                                                     | `InvalidInput`, naming `afterSequence`                                                         |
| `watch` follow-mode handoff | one high-water mark per partition present when the watch starts                                      | snapshot rows at or below the mark; buffered tail rows above it                                |
| `watch` partition reads     | 8 partition snapshots at a time, plus one reserved slot for the live tail                            | queued, never refused                                                                          |
| webhook request body        | `WebhookChannel.maximumBodyBytes` (1 MiB), lowered per mount by `handler`'s third argument           | `InvalidInput` naming both byte counts, before the read when `content-length` declares it      |
| mutation identity           | 4 MiB, 128 levels, 100,000 values and members; idempotency keys are 1 to 1,024 characters            | `InvalidInput` before the first wait                                                           |

A `steer` whose `message.runId` disagrees with the run the call names is
refused with `InvalidInput` before anything is admitted to the queue.

Approval and denial default to the exact identity `local/operator`, for both
plan and node targets and all grant scopes. The memory adapter's own default
also delegates its `memory/test` identity. Authentication
and approval authority are independent: a custom operator identity has no
authority until the host explicitly delegates it. Hosts may delegate exact
identity tuples, including agents, with specific target kinds and approval
scopes. Denial requires a delegated target kind and installs no grant. Callers
without authority receive `Unauthorized` (`code: "unauthorized"`) before target
reads or receipt replay. See [who may decide](docs/guides/approvals.md#who-may-decide).

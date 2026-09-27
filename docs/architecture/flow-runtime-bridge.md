# Flow runtime bridge

The product backend admits work through `packages/backend/flowdispatch`; the
TypeScript Flow host executes it. The boundary is `smithers.flow-runtime/v1`
on `/runtime/v1/command` and `/runtime/v1/observe`.

## Authority

| Fact | Authority | Backup |
| --- | --- | --- |
| Product request, actor, admission receipt | PostgreSQL | PostgreSQL backup and WAL policy |
| Flow plan, approval, steps, waits, cancellation, output, terminal status | TypeScript Control/engine journal | The owning host's durable state volume (`control.db`, `engine.db`, WAL companions) |
| Product run card/status | PostgreSQL projection of authenticated runtime receipts/events | Rebuild from product admission plus runtime replay |
| Executable identity | Packaged host SHA-256 and source revision | Release artifact plus digest sidecar; source repository revision |

Go does not read or edit runtime SQLite. A ready socket, successful HTTP
launch response, or exited host process is not a completed run. Completion is
only a canonical runtime projection with `completed`, `failed`, or
`cancelled`.

## Receipts and reconnect

Product admission is committed before launch. Runtime launch then returns a
canonical Control receipt and, when accepted, a runtime execution ID. The
product stores the application request ID, execution ID, immutable source and
artifact identity, last observed owner generation, and last event cursor in
the shared jobs external receipt.

Reconnect calls `observe` strictly after the stored cursor. Runtime sequences
are monotonic; repeated pages and repeated command delivery are safe. Planning
is idempotent by application request. Product reconciliation reuses the stable
external delivery attempt committed before the first network call; PostgreSQL
claim attempts and generations only fence product writes. Runtime owner
generation fences which host may execute the command but is not part of its
idempotency key. A replacement owner therefore reconciles a lost acknowledgment
against the same Control command. Control owns action replay and Flow retries.

A waiting Control run releases its PostgreSQL worker lease. The jobs row keeps
the opaque approval, runtime receipt, run ID, and cursor, then becomes ready for
a later bounded observation pass. Approval is another durable jobs operation;
cancellation is written to the launch row before any Control mutation.

## Failure and uncertainty

- A lost launch acknowledgment remains pending. Reconciliation probes host
  identity, repeats the persisted external attempt, then observes any returned
  execution.
- A version, artifact, source, or owner-generation mismatch refuses before
  execution. A new owner generation may take ownership only when artifact and
  source identity still match the admitted checkpoint.
- Authentication is bearer-token based and required for every bridge request,
  including loopback. The token is never placed in request identity, receipts,
  health, logs, or errors.
- Approval, denial, signal, steer, cancellation, and resume are durable Control
  mutations. Interrupted callers repeat the same application request ID.
- An unreachable runtime is uncertainty, not failure. Product state remains
  pending/running until replay observes a canonical terminal status.
- Runtime replay advances only through validated monotonic cursors. A cursor
  gap is retried from the last committed cursor; it is never filled by
  inference.

## Ownership and deployment

One active process owns a runtime state directory. SQLite WAL files stay on
that process's durable local volume; replicas do not share them over a network
filesystem. The single-owner self-hosted adapter and Plue's isolated adapter
start the same packaged TypeScript artifact with the same protocol, credential,
source revision, owner generation, and durable-state contract. No runtime
bundle is fetched from GCS.

Repository code is loaded only by a box's coding host behind the deployment
adapter; the trusted product process never dynamically imports it. Every
browser flow call names a box and reaches that box's coding host; there is no
repository-level product host.

## Product integration

Agent workflow dispatch admits `coding/dispatch` before clone credentials,
workspace provisioning, or a host call. Its stable request ID is
`agent-run:<workflow-run-id>` and its target is the durable agent-session
binding. One `flowhost.Resolver` maps that server-validated target through a
durable host binding in both deployment modes; only its trusted-process or
isolated WorkspaceRuntime launcher differs. Existing agent/workflow rows are
updated only by the idempotent receipt projector; assistant/model frames belong
to the separate durable turn journal.

Composition constructs one `jobs.Store`, then `flowdispatch.New` with the
deployment's `flowruntime.Resolver` and `AgentService` as projector, calls
`AgentService.SetFlowDispatcher`, and attaches
`flowdispatch.Service.RunWorker` to the shared lifecycle. The operation-filtered
worker performs its own expired-lease recovery. Admission handlers never wait
on that worker.

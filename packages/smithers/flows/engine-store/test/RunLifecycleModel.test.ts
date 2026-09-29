/**
 * A generated state-model test for the durable run lifecycle (issue #1813).
 *
 * `fast-check` generates command histories over two independent connections
 * to one SQLite file: claim, claimAndOwn, activate, abandonClaim, steal,
 * recoverClaim, heartbeat, transitionOwned, requestCancel, a cascading
 * cancel through the run DAG, retention compaction, change-feed polling, clock
 * steps and a full restart. After every step the outcome and every persisted
 * row and edge must equal a small independent model that knows no SQL.
 *
 * Invariants the model encodes:
 * - one live owner: a run has at most one owner, and only that owner's fence
 *   renews or transitions it;
 * - a stale owner's heartbeat and transition are refused with `FenceLost`;
 * - committed rows, edges and change cursors survive restart;
 * - a cancellation reaches every transitive descendant;
 * - a change cursor never acknowledges a change it has not returned.
 *
 * Replay with SMITHERS_FUZZ_SEED / SMITHERS_FUZZ_CASES / SMITHERS_FUZZ_STEPS.
 * With SMITHERS_FUZZ_ARTIFACT_DIR set, the seed, the replay path and the
 * shrunk history are written to `run-lifecycle-<seed>.json`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Flow, type FlowRuntime } from "@smthrs/flow"
import { heartbeatStaleAfter } from "@smthrs/run-store/Heartbeat"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Cause, Clock, Duration, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import fc from "fast-check"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as Retention from "../src/Retention.ts"
import * as RunChangeFeed from "../src/RunChangeFeed.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { clockAt } from "./Clocks.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"

const integer = (name: string, fallback: number, minimum: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > 0xffff_ffff) {
    throw new Error(`${name} must be an integer between ${minimum} and 4294967295`)
  }
  return value
}
const seed = integer("SMITHERS_FUZZ_SEED", 0x52_75_6e_4c, 0)
const cases = integer("SMITHERS_FUZZ_CASES", 4, 1)
const steps = integer("SMITHERS_FUZZ_STEPS", 60, 1)
const artifactDirectory = process.env["SMITHERS_FUZZ_ARTIFACT_DIR"]

const staleAfterMs = Duration.toMillis(heartbeatStaleAfter)
const RUNS = ["run-0", "run-1", "run-2", "run-3", "run-4"] as const
const OWNERS: ReadonlyArray<OwnerId> = [
  { hostId: "model-host-a", pid: 1, nonce: "owner-0" },
  { hostId: "model-host-a", pid: 2, nonce: "owner-1" },
  { hostId: "model-host-b", pid: 3, nonce: "owner-2" }
]
const ADVANCES = [1, 1_000, 10_000, staleAfterMs + 1] as const
const TARGETS = ["running", "suspended", "completed", "failed", "cancelled", "pending"] as const
const terminal = (status: string) => status === "completed" || status === "failed" || status === "cancelled"

const LifecycleFlow = Flow.make("RunLifecycleModel/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})
const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

type Conn = 0 | 1
type SnapshotKind = "current" | "pending" | "suspended"
type Token = "held" | "other"
type Op =
  | { readonly kind: "create"; readonly conn: Conn; readonly run: number }
  | { readonly kind: "link"; readonly conn: Conn; readonly child: number; readonly parent: number }
  | { readonly kind: "advance"; readonly ms: number }
  | {
    readonly kind: "claim"
    readonly conn: Conn
    readonly run: number
    readonly owner: number
    readonly snapshot: SnapshotKind
  }
  | {
    readonly kind: "claimAndOwn"
    readonly conn: Conn
    readonly run: number
    readonly owner: number
    readonly snapshot: SnapshotKind
    readonly evidence: boolean
  }
  | {
    readonly kind: "activate"
    readonly conn: Conn
    readonly run: number
    readonly owner: number
    readonly token: Token
    readonly snapshot: SnapshotKind
  }
  | {
    readonly kind: "abandon"
    readonly conn: Conn
    readonly run: number
    readonly owner: number
    readonly token: Token
  }
  | {
    readonly kind: "recover"
    readonly conn: Conn
    readonly run: number
    readonly owner: number
    readonly observer: number
    readonly token: Token
    readonly evidence: boolean
  }
  | {
    readonly kind: "heartbeat"
    readonly conn: Conn
    readonly run: number
    readonly owner: number
    readonly lagMs: number
  }
  | {
    readonly kind: "transition"
    readonly conn: Conn
    readonly run: number
    readonly owner: number
    readonly to: typeof TARGETS[number]
    readonly guard: "none" | "absent" | "present"
  }
  | {
    readonly kind: "steal"
    readonly conn: Conn
    readonly run: number
    readonly owner: number
    readonly snapshot: SnapshotKind
    readonly evidence: boolean
  }
  | { readonly kind: "requestCancel"; readonly conn: Conn; readonly run: number }
  | { readonly kind: "cancelTree"; readonly conn: Conn; readonly run: number }
  | { readonly kind: "compact"; readonly conn: Conn; readonly ageMs: number }
  | { readonly kind: "poll"; readonly conn: Conn; readonly reader: 0 | 1; readonly limit: number }
  | { readonly kind: "restart" }

// ---------------------------------------------------------------------------
// The independent model
// ---------------------------------------------------------------------------

interface Row {
  readonly status: RunStore.RunStatus
  readonly owner: number | null
  readonly heartbeatAtMs: number | null
  readonly claim: number | null
  readonly claimedAtMs: number | null
  readonly cancelRequestedAtMs: number | null
  readonly createdAtMs: number
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
  readonly stateJson: string
}

interface Reader {
  revision: number
  /** Runs changed since the cursor, mapped to whether the change was a deletion. */
  readonly dirty: Map<string, boolean>
}

interface Model {
  now: number
  commits: number
  restarts: number
  /** Generated commands executed. */
  steps: number
  rows: Map<string, Row>
  /** `child>parent` edges of the run DAG. */
  edges: Set<string>
  readonly readers: readonly [Reader, Reader]
}

type Outcome = unknown

const initialModel = (revision: number): Model => ({
  now: 1_800_000_000_000,
  commits: 0,
  restarts: 0,
  steps: 0,
  rows: new Map(),
  edges: new Set(),
  readers: [{ revision, dirty: new Map() }, { revision, dirty: new Map() }]
})

const pending = { status: "pending", owner: null, heartbeatAtMs: null } as const

interface Snapshot {
  readonly status: RunStore.RunStatus
  readonly owner: number | null
  readonly heartbeatAtMs: number | null
}

const snapshotOf = (model: Model, runId: string, kind: SnapshotKind): Snapshot => {
  const row = model.rows.get(runId)
  if (kind === "current" && row !== undefined) {
    return { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
  }
  return kind === "suspended" ? { status: "suspended", owner: null, heartbeatAtMs: null } : pending
}

const tokenOf = (model: Model, runId: string, token: Token): number => {
  const held = model.rows.get(runId)?.claimedAtMs ?? model.now
  return token === "held" ? held : held + 1
}

const matches = (row: Row, expected: Snapshot) =>
  row.status === expected.status && row.owner === expected.owner && row.heartbeatAtMs === expected.heartbeatAtMs

const claimLoss = (row: Row | undefined, now: number): Outcome => {
  if (row === undefined) return { _tag: "NotFound" }
  if (row.claim !== null) return { _tag: "AlreadyClaimed" }
  if (row.status === "running" && row.heartbeatAtMs !== null && row.heartbeatAtMs >= now - staleAfterMs) {
    return { _tag: "HeartbeatFresh" }
  }
  return { _tag: "SnapshotChanged" }
}

const requestOne = (model: Model, runId: string): Outcome => {
  const row = model.rows.get(runId)
  if (row === undefined) return { _tag: "NotFound" }
  if (terminal(row.status)) return { _tag: "Terminal", status: row.status }
  if (row.cancelRequestedAtMs !== null) return { _tag: "AlreadyRequested", requestedAtMs: row.cancelRequestedAtMs }
  model.rows.set(runId, { ...row, cancelRequestedAtMs: model.now })
  return { _tag: "CancelRequested", requestedAtMs: model.now }
}

const childrenOf = (model: Model, parentId: string) =>
  [...model.edges].map((edge) => edge.split(">") as [string, string]).filter(([, parent]) => parent === parentId).map((
    [child]
  ) => child)

const parentsOf = (model: Model, childId: string) =>
  [...model.edges].map((edge) => edge.split(">") as [string, string]).filter(([child]) => child === childId).map((
    [, parent]
  ) => parent)

const closure = (model: Model, start: ReadonlyArray<string>, next: (id: string) => ReadonlyArray<string>) => {
  const seen = new Set<string>()
  const frontier = start.flatMap(next)
  while (frontier.length > 0) {
    const id = frontier.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    frontier.push(...next(id))
  }
  return seen
}

/**
 * Applies `op` to the model and returns the outcome the store must report.
 * `poll` is verified against the real feed directly and is not modelled here.
 */
const transition = (model: Model, op: Op): Outcome => {
  const now = model.now
  switch (op.kind) {
    case "advance":
      model.now += op.ms
      return undefined
    case "restart":
      model.restarts += 1
      return undefined
    case "poll":
      return undefined
    case "create": {
      const runId = RUNS[op.run]!
      if (model.rows.has(runId)) return { error: "constraint" }
      model.rows.set(runId, {
        status: "pending",
        owner: null,
        heartbeatAtMs: null,
        claim: null,
        claimedAtMs: null,
        cancelRequestedAtMs: null,
        createdAtMs: now,
        startedAtMs: null,
        finishedAtMs: null,
        stateJson: JSON.stringify({ run: runId })
      })
      return undefined
    }
    case "link":
      model.edges.add(`${RUNS[op.child]}>${RUNS[op.parent]}`)
      return { _tag: "Recorded" }
    case "claim": {
      const runId = RUNS[op.run]!
      const row = model.rows.get(runId)
      const expected = snapshotOf(model, runId, op.snapshot)
      if (
        row !== undefined && (row.status === "pending" || row.status === "suspended") && matches(row, expected) &&
        row.claim === null
      ) {
        model.rows.set(runId, { ...row, claim: op.owner, claimedAtMs: now })
        return { _tag: "Claimed", claimedAtMs: now }
      }
      return claimLoss(row, now)
    }
    case "claimAndOwn": {
      const runId = RUNS[op.run]!
      const row = model.rows.get(runId)
      const expected = snapshotOf(model, runId, op.snapshot)
      if (expected.status === "running" && expected.owner !== op.owner && !op.evidence) {
        const loss = claimLoss(row, now)
        return (loss as { _tag: string })._tag === "SnapshotChanged" && row !== undefined && matches(row, expected)
          ? { _tag: "EvidenceRequired" }
          : loss
      }
      if (
        row !== undefined && row.status !== "completed" && row.status !== "failed" && row.status !== "cancelled" &&
        matches(row, expected) && row.claim === null &&
        (row.status !== "running" || row.heartbeatAtMs === null || row.heartbeatAtMs < now - staleAfterMs)
      ) {
        model.rows.set(runId, {
          ...row,
          status: "running",
          startedAtMs: row.startedAtMs ?? now,
          finishedAtMs: null,
          owner: op.owner,
          heartbeatAtMs: now
        })
        return { _tag: "Activated" }
      }
      return claimLoss(row, now)
    }
    case "activate": {
      const runId = RUNS[op.run]!
      const row = model.rows.get(runId)
      const expected = snapshotOf(model, runId, op.snapshot)
      const token = tokenOf(model, runId, op.token)
      const holds = row !== undefined && row.claim === op.owner && row.claimedAtMs === token
      if (!holds) return { _tag: "ClaimLost" }
      if (matches(row, expected)) {
        model.rows.set(runId, {
          ...row,
          status: "running",
          startedAtMs: row.startedAtMs ?? now,
          finishedAtMs: null,
          owner: op.owner,
          heartbeatAtMs: now,
          claim: null,
          claimedAtMs: null
        })
        return { _tag: "Activated" }
      }
      model.rows.set(runId, { ...row, claim: null, claimedAtMs: null })
      return { _tag: "SnapshotChanged" }
    }
    case "abandon": {
      const runId = RUNS[op.run]!
      const row = model.rows.get(runId)
      const token = tokenOf(model, runId, op.token)
      if (row === undefined || row.claim !== op.owner || row.claimedAtMs !== token) return { _tag: "ClaimLost" }
      model.rows.set(runId, { ...row, claim: null, claimedAtMs: null })
      return { _tag: "Abandoned" }
    }
    case "recover": {
      if (!op.evidence) return { _tag: "LivenessUnconfirmed" }
      const runId = RUNS[op.run]!
      const row = model.rows.get(runId)
      const token = tokenOf(model, runId, op.token)
      if (row === undefined) return { _tag: "NotFound" }
      const holds = row.claim === op.owner && row.claimedAtMs === token
      if (holds && token < now - staleAfterMs) {
        model.rows.set(runId, { ...row, claim: null, claimedAtMs: null })
        return { _tag: "Recovered" }
      }
      return holds ? { _tag: "ClaimFresh" } : { _tag: "ClaimChanged" }
    }
    case "heartbeat": {
      const runId = RUNS[op.run]!
      const row = model.rows.get(runId)
      if (row === undefined) return { _tag: "NotFound" }
      if (row.status !== "running" || row.owner !== op.owner) return { _tag: "FenceLost" }
      model.rows.set(runId, { ...row, heartbeatAtMs: Math.max(row.heartbeatAtMs!, now - op.lagMs) })
      return { _tag: "Updated" }
    }
    case "transition": {
      model.commits += 1
      if (op.to === "pending") return { error: "invalid_run" }
      const runId = RUNS[op.run]!
      const row = model.rows.get(runId)
      if (row === undefined) return { _tag: "NotFound" }
      const owns = row.status === "running" && row.owner === op.owner
      if (!owns) return { _tag: "FenceLost" }
      if (
        (op.guard === "absent" && row.cancelRequestedAtMs !== null) ||
        (op.guard === "present" && row.cancelRequestedAtMs === null)
      ) return { _tag: "GuardFailed" }
      const stateJson = JSON.stringify({ commit: model.commits })
      model.rows.set(
        runId,
        op.to === "running"
          ? { ...row, finishedAtMs: null, stateJson }
          : {
            ...row,
            status: op.to,
            finishedAtMs: terminal(op.to) ? now : null,
            owner: null,
            heartbeatAtMs: null,
            claim: null,
            claimedAtMs: null,
            stateJson
          }
      )
      return { _tag: "Transitioned" }
    }
    case "steal": {
      const runId = RUNS[op.run]!
      const row = model.rows.get(runId)
      const expected = snapshotOf(model, runId, op.snapshot)
      if (!op.evidence || expected.status !== "running") return { _tag: "LivenessUnconfirmed" }
      if (
        row !== undefined && matches(row, expected) && row.heartbeatAtMs! < now - staleAfterMs && row.claim === null
      ) {
        model.rows.set(runId, { ...row, claim: op.owner, claimedAtMs: now })
        return { _tag: "Claimed", claimedAtMs: now }
      }
      return claimLoss(row, now)
    }
    case "requestCancel":
      return requestOne(model, RUNS[op.run]!)
    case "cancelTree": {
      const root = RUNS[op.run]!
      requestOne(model, root)
      for (const child of closure(model, [root], (id) => childrenOf(model, id))) {
        if (child !== root) requestOne(model, child)
      }
      return undefined
    }
    case "compact": {
      const cutoff = now - op.ageMs
      const live = [...model.rows].filter(([, row]) => !terminal(row.status)).map(([id]) => id)
      const underLive = closure(model, live, (id) => childrenOf(model, id))
      const overLive = closure(model, live, (id) => parentsOf(model, id))
      const deleted = [...model.rows].filter(([id, row]) =>
        terminal(row.status) && (row.finishedAtMs ?? row.createdAtMs) < cutoff && !underLive.has(id) &&
        !overLive.has(id)
      ).map(([id]) => id).sort()
      for (const id of deleted) model.rows.delete(id)
      model.edges = new Set(
        [...model.edges].filter((edge) => !deleted.some((id) => edge.split(">").includes(id)))
      )
      return deleted
    }
  }
}

// ---------------------------------------------------------------------------
// The real system
// ---------------------------------------------------------------------------

const layerAt = (filename: string) =>
  RunChangeFeed.layer.pipe(Layer.provideMerge(TestStores.layerAt(filename)), Layer.provideMerge(NodeCrypto.layer))

type Runtime = ReturnType<typeof ManagedRuntime.make<Layer.Success<ReturnType<typeof layerAt>>, unknown>>
type Services = Layer.Success<ReturnType<typeof layerAt>>

class Harness {
  private runtimes: Array<Runtime> = []
  source = ""

  readonly directory: string
  readonly filename: string

  private constructor(directory: string, filename: string) {
    this.directory = directory
    this.filename = filename
  }

  static async open(): Promise<Harness> {
    const directory = mkdtempSync(join(tmpdir(), "run-lifecycle-model-"))
    const harness = new Harness(directory, join(directory, "runs.db"))
    await harness.connect()
    return harness
  }

  private async connect() {
    // Sequentially, so the second connection finds the migrated schema.
    for (let index = 0; index < 2; index++) {
      const runtime = ManagedRuntime.make(layerAt(this.filename)) as Runtime
      await runtime.runPromise(Effect.void)
      this.runtimes.push(runtime)
    }
  }

  async restart() {
    await this.disconnect()
    await this.connect()
  }

  private async disconnect() {
    const runtimes = this.runtimes
    this.runtimes = []
    for (const runtime of runtimes) await runtime.dispose()
  }

  async close() {
    await this.disconnect()
    rmSync(this.directory, { recursive: true, force: true })
  }

  run<A, E>(conn: Conn, now: number, effect: Effect.Effect<A, E, Services>): Promise<Exit.Exit<A, E>> {
    return this.runtimes[conn]!.runPromise(Effect.exit(Effect.provideService(effect, Clock.Clock, clockAt(now))))
  }
}

/** The observable outcome of an operation: its value, or its failure code. */
const settle = async <A, E>(exit: Promise<Exit.Exit<A, E>>): Promise<unknown> => {
  const result = await exit
  if (Exit.isSuccess(result)) return result.value
  const failure = result.cause.reasons.find(Cause.isFailReason)
  if (failure === undefined) throw new Error(`unexpected defect: ${Cause.pretty(result.cause)}`)
  const error = failure.error as { readonly code?: string; readonly _tag?: string }
  return { error: error.code ?? error._tag }
}

const ownerIndex = (owner: OwnerId | null): number | null => {
  if (owner === null) return null
  const index = OWNERS.findIndex((candidate) => candidate.nonce === owner.nonce)
  expect(index).toBeGreaterThanOrEqual(0)
  expect(owner).toEqual(OWNERS[index])
  return index
}

const project = (row: RunStore.RunRow): Row => ({
  status: row.status,
  owner: ownerIndex(row.owner),
  heartbeatAtMs: row.heartbeatAtMs,
  claim: ownerIndex(row.claim),
  claimedAtMs: row.claimedAtMs,
  cancelRequestedAtMs: row.cancelRequestedAtMs,
  createdAtMs: row.createdAtMs,
  startedAtMs: row.startedAtMs,
  finishedAtMs: row.finishedAtMs,
  stateJson: row.stateJson
})

const asOwnerSnapshot = (snapshot: Snapshot): RunStore.RunSnapshot => ({
  status: snapshot.status,
  owner: snapshot.owner === null ? null : OWNERS[snapshot.owner]!,
  heartbeatAtMs: snapshot.heartbeatAtMs
})

const leaseExpired = (expectedOwner: OwnerId, checkedAtMs: number) => ({
  expectedOwner,
  checkedAtMs,
  kind: "lease-expired" as const
})

/** Executes `op` against the store with arguments resolved from the pre-state model. */
const execute = async (model: Model, real: Harness, op: Op): Promise<unknown> => {
  const now = model.now
  switch (op.kind) {
    case "advance":
      return undefined
    case "restart":
      await real.restart()
      return undefined
    case "poll":
      return undefined
    case "create":
      return settle(real.run(
        op.conn,
        now,
        Effect.flatMap(
          RunStore.RunStore,
          (store) => store.create(RUNS[op.run]!, JSON.stringify({ run: RUNS[op.run] })).pipe(Effect.as(undefined))
        )
      ))
    case "link":
      return settle(real.run(
        op.conn,
        now,
        Effect.flatMap(
          DurableEngineState.DurableEngineState,
          (state) =>
            state.recordRunParent(RUNS[op.child]!, RUNS[op.parent]!).pipe(Effect.map((outcome) => ({
              _tag: outcome._tag
            })))
        )
      ))
    case "claim": {
      const runId = RUNS[op.run]!
      const expected = asOwnerSnapshot(snapshotOf(model, runId, op.snapshot))
      return settle(real.run(
        op.conn,
        now,
        Effect.flatMap(RunStore.RunStore, (store) => store.claim(runId, expected, OWNERS[op.owner]!, now))
      ))
    }
    case "claimAndOwn": {
      const runId = RUNS[op.run]!
      const expected = asOwnerSnapshot(snapshotOf(model, runId, op.snapshot))
      const owner = OWNERS[op.owner]!
      const evidence = op.evidence ? leaseExpired(expected.owner ?? owner, now) : undefined
      return settle(real.run(
        op.conn,
        now,
        Effect.flatMap(RunStore.RunStore, (store) => store.claimAndOwn(runId, expected, owner, now, evidence))
      ))
    }
    case "activate": {
      const runId = RUNS[op.run]!
      const expected = asOwnerSnapshot(snapshotOf(model, runId, op.snapshot))
      const token = tokenOf(model, runId, op.token)
      return settle(real.run(
        op.conn,
        now,
        Effect.flatMap(RunStore.RunStore, (store) => store.activate(runId, OWNERS[op.owner]!, token, expected))
      ))
    }
    case "abandon": {
      const runId = RUNS[op.run]!
      const token = tokenOf(model, runId, op.token)
      return settle(real.run(
        op.conn,
        now,
        Effect.flatMap(RunStore.RunStore, (store) => store.abandonClaim(runId, OWNERS[op.owner]!, token))
      ))
    }
    case "recover": {
      const runId = RUNS[op.run]!
      const token = tokenOf(model, runId, op.token)
      const stale = OWNERS[op.owner]!
      return settle(real.run(
        op.conn,
        now,
        Effect.flatMap(RunStore.RunStore, (store) =>
          store.recoverClaim(
            runId,
            stale,
            token,
            OWNERS[op.observer]!,
            now,
            leaseExpired(stale, op.evidence ? now : now - 1)
          ))
      ))
    }
    case "heartbeat":
      return settle(real.run(
        op.conn,
        now,
        Effect.flatMap(RunStore.RunStore, (store) => store.heartbeat(RUNS[op.run]!, OWNERS[op.owner]!, now - op.lagMs))
      ))
    case "transition":
      return settle(real.run(
        op.conn,
        now,
        Effect.flatMap(RunStore.RunStore, (store) =>
          store.transitionOwned(
            RUNS[op.run]!,
            OWNERS[op.owner]!,
            op.to,
            JSON.stringify({ commit: model.commits + 1 }),
            op.guard === "none" ? undefined : { cancelRequested: op.guard }
          ))
      ))
    case "steal": {
      const runId = RUNS[op.run]!
      const expected = asOwnerSnapshot(snapshotOf(model, runId, op.snapshot))
      const owner = OWNERS[op.owner]!
      return settle(real.run(
        op.conn,
        now,
        Effect.flatMap(
          RunStore.RunStore,
          (store) =>
            store.steal(runId, expected, owner, now, leaseExpired(expected.owner ?? owner, op.evidence ? now : now - 1))
        )
      ))
    }
    case "requestCancel":
      return settle(real.run(
        op.conn,
        now,
        Effect.flatMap(RunStore.RunStore, (store) => store.requestCancel(RUNS[op.run]!, now))
      ))
    case "cancelTree":
      // A separate driver that never ran the family: the cascade can only
      // come from durable rows and edges.
      return settle(real.run(
        op.conn,
        now,
        Effect.scoped(
          Effect.flatMap(
            RunDriver.make({
              owner: { hostId: "model-operator", pid: 9, nonce: `operator-${op.conn}` },
              journalSource: `run-lifecycle-${op.conn}`,
              isAlive: () => Effect.succeed(true),
              engine: Effect.succeed(fakeEngine)
            }),
            (driver) => driver.interrupt(LifecycleFlow, RUNS[op.run]!)
          )
        )
      ))
    case "compact":
      return settle(real.run(
        op.conn,
        now,
        Retention.collect({ olderThanMs: now - op.ageMs }).pipe(Effect.map((report) => [...report.runs].sort()))
      ))
  }
}

/** Reads one change page and checks that the cursor acknowledges only what it returned. */
const poll = async (model: Model, real: Harness, op: Extract<Op, { kind: "poll" }>) => {
  const reader = model.readers[op.reader]
  const exit = await real.run(
    op.conn,
    model.now,
    Effect.flatMap(RunChangeFeed.RunChangeFeed, (feed) =>
      Effect.all([
        feed.changesSince({ source: real.source, revision: reader.revision, limit: op.limit }),
        feed.current
      ]))
  )
  if (Exit.isFailure(exit)) throw new Error(`change feed failed: ${Cause.pretty(exit.cause)}`)
  const [page, current] = exit.value
  expect(page.source).toBe(real.source)
  expect(page.revision).toBeLessThanOrEqual(current.revision)
  expect(page.changes.length).toBeLessThanOrEqual(op.limit)
  let previous = reader.revision
  for (const change of page.changes) {
    expect(change.revision).toBeGreaterThan(previous)
    expect(change.revision).toBeLessThanOrEqual(page.revision)
    previous = change.revision
    const pendingDeletion = reader.dirty.get(change.runId)
    if (pendingDeletion !== undefined) {
      expect(change.deleted).toBe(pendingDeletion)
      reader.dirty.delete(change.runId)
    }
  }
  expect(page.nextRevision).toBeGreaterThanOrEqual(reader.revision)
  expect(page.nextRevision).toBeLessThanOrEqual(page.revision)
  if (page.hasMore) {
    expect(page.nextRevision).toBe(page.changes[page.changes.length - 1]!.revision)
  } else {
    expect(page.nextRevision).toBe(page.revision)
    // A drained cursor has seen every change the model applied.
    expect([...reader.dirty.keys()]).toEqual([])
  }
  reader.revision = page.nextRevision
}

/** Every persisted row and edge, read through both connections, equals the model. */
const verifyState = async (model: Model, real: Harness) => {
  for (const conn of [0, 1] as const) {
    for (const runId of RUNS) {
      const observed = await settle(real.run(
        conn,
        model.now,
        Effect.flatMap(RunStore.RunStore, (store) => store.get(runId))
      ))
      const expected = model.rows.get(runId)
      if (expected === undefined) {
        expect(observed, `${runId} over connection ${conn}`).toEqual({ error: "not_found_row" })
      } else {
        const row = observed as RunStore.RunRow
        expect(row.runId).toBe(runId)
        expect(row.parentRunId).toBeNull()
        expect(project(row), `${runId} over connection ${conn}`).toEqual(expected)
        // One live owner: ownership exists exactly while the run is running.
        expect(row.owner === null).toBe(row.status !== "running")
      }
      const children = await settle(real.run(
        conn,
        model.now,
        Effect.flatMap(DurableEngineState.DurableEngineState, (state) => state.runChildren(runId))
      )) as ReadonlyArray<{ readonly childId: string }>
      expect(children.map((edge) => edge.childId).sort(), `children of ${runId}`).toEqual(
        childrenOf(model, runId).sort()
      )
    }
  }
}

const snapshotRows = (model: Model) => new Map([...model.rows].map(([id, row]) => [id, JSON.stringify(row)]))

/** Runs one operation against both sides and checks the outcome and resulting state. */
const step = async (model: Model, real: Harness, op: Op): Promise<unknown> => {
  if (op.kind === "poll") {
    await poll(model, real, op)
    return undefined
  }
  const observed = await execute(model, real, op)
  const before = snapshotRows(model)
  const expected = transition(model, op)
  expect(observed, JSON.stringify(op)).toEqual(expected)
  const after = snapshotRows(model)
  for (const runId of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(runId) !== after.get(runId)) {
      for (const reader of model.readers) reader.dirty.set(runId, !after.has(runId))
    }
  }
  await verifyState(model, real)
  return observed
}

const precondition = (model: Model, op: Op): boolean =>
  op.kind !== "link" ||
  (op.parent < op.child && model.rows.has(RUNS[op.child]!) && model.rows.has(RUNS[op.parent]!) &&
    !model.edges.has(`${RUNS[op.child]}>${RUNS[op.parent]}`))

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

class LifecycleCommand implements fc.AsyncCommand<Model, Harness> {
  readonly op: Op
  constructor(op: Op) {
    this.op = op
  }
  check(model: Readonly<Model>) {
    return precondition(model as Model, this.op)
  }
  async run(model: Model, real: Harness) {
    model.steps += 1
    await step(model, real, this.op)
  }
  toString() {
    return JSON.stringify(this.op)
  }
}

const conn = fc.constantFrom<Conn>(0, 1)
const run = fc.nat({ max: RUNS.length - 1 })
const owner = fc.nat({ max: OWNERS.length - 1 })
const snapshot = fc.constantFrom<SnapshotKind>("current", "current", "current", "pending", "suspended")
const token = fc.constantFrom<Token>("held", "held", "other")

const operation: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("create" as const), conn, run }), weight: 3 },
  {
    arbitrary: fc.record({ kind: fc.constant("link" as const), conn, child: run, parent: run }),
    weight: 2
  },
  { arbitrary: fc.record({ kind: fc.constant("advance" as const), ms: fc.constantFrom(...ADVANCES) }), weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant("claim" as const), conn, run, owner, snapshot }), weight: 2 },
  {
    arbitrary: fc.record({
      kind: fc.constant("claimAndOwn" as const),
      conn,
      run,
      owner,
      snapshot,
      evidence: fc.boolean()
    }),
    weight: 4
  },
  {
    arbitrary: fc.record({ kind: fc.constant("activate" as const), conn, run, owner, token, snapshot }),
    weight: 2
  },
  { arbitrary: fc.record({ kind: fc.constant("abandon" as const), conn, run, owner, token }), weight: 1 },
  {
    arbitrary: fc.record({
      kind: fc.constant("recover" as const),
      conn,
      run,
      owner,
      observer: owner,
      token,
      evidence: fc.boolean()
    }),
    weight: 1
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("heartbeat" as const),
      conn,
      run,
      owner,
      lagMs: fc.constantFrom(0, 5_000)
    }),
    weight: 3
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("transition" as const),
      conn,
      run,
      owner,
      to: fc.constantFrom(...TARGETS),
      guard: fc.constantFrom("none" as const, "absent" as const, "present" as const)
    }),
    weight: 3
  },
  {
    arbitrary: fc.record({ kind: fc.constant("steal" as const), conn, run, owner, snapshot, evidence: fc.boolean() }),
    weight: 2
  },
  { arbitrary: fc.record({ kind: fc.constant("requestCancel" as const), conn, run }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("cancelTree" as const), conn, run }), weight: 1 },
  {
    arbitrary: fc.record({
      kind: fc.constant("compact" as const),
      conn,
      ageMs: fc.constantFrom(0, 1_000, staleAfterMs * 2)
    }),
    weight: 1
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("poll" as const),
      conn,
      reader: fc.constantFrom<0 | 1>(0, 1),
      limit: fc.constantFrom(1, 2, 1_000)
    }),
    weight: 2
  },
  { arbitrary: fc.constant({ kind: "restart" as const }), weight: 1 }
)

const withHarness = async <A>(body: (model: Model, real: Harness) => Promise<A>): Promise<A> => {
  const real = await Harness.open()
  try {
    const exit = await real.run(0, 0, Effect.flatMap(RunChangeFeed.RunChangeFeed, (feed) => feed.current))
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    real.source = exit.value.source
    return await body(initialModel(exit.value.revision), real)
  } finally {
    await real.close()
  }
}

const artifact = (value: unknown) => {
  if (artifactDirectory === undefined) return
  mkdirSync(artifactDirectory, { recursive: true })
  writeFileSync(join(artifactDirectory, `run-lifecycle-${seed}.json`), `${JSON.stringify(value, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/**
 * A fixed boundary history every run executes, whatever the seed: it drives
 * each invariant the generated histories may only reach by chance.
 */
const boundary: ReadonlyArray<Op> = [
  { kind: "heartbeat", conn: 0, run: 0, owner: 0, lagMs: 0 },
  { kind: "create", conn: 0, run: 0 },
  { kind: "create", conn: 1, run: 0 },
  { kind: "create", conn: 1, run: 1 },
  { kind: "create", conn: 0, run: 2 },
  { kind: "create", conn: 1, run: 3 },
  { kind: "link", conn: 0, child: 1, parent: 0 },
  { kind: "link", conn: 1, child: 2, parent: 1 },
  { kind: "poll", conn: 1, reader: 0, limit: 1 },
  { kind: "claimAndOwn", conn: 0, run: 0, owner: 0, snapshot: "current", evidence: false },
  // Another owner cannot take a fresh lease, with or without evidence.
  { kind: "claimAndOwn", conn: 1, run: 0, owner: 1, snapshot: "current", evidence: false },
  { kind: "claimAndOwn", conn: 1, run: 0, owner: 1, snapshot: "current", evidence: true },
  { kind: "steal", conn: 1, run: 0, owner: 1, snapshot: "current", evidence: true },
  { kind: "heartbeat", conn: 1, run: 0, owner: 0, lagMs: 5_000 },
  { kind: "advance", ms: staleAfterMs + 1 },
  { kind: "claimAndOwn", conn: 1, run: 0, owner: 1, snapshot: "current", evidence: false },
  { kind: "steal", conn: 1, run: 0, owner: 1, snapshot: "current", evidence: false },
  { kind: "steal", conn: 1, run: 0, owner: 1, snapshot: "current", evidence: true },
  { kind: "claimAndOwn", conn: 0, run: 0, owner: 2, snapshot: "current", evidence: true },
  { kind: "claim", conn: 0, run: 0, owner: 2, snapshot: "current" },
  { kind: "activate", conn: 1, run: 0, owner: 1, token: "other", snapshot: "current" },
  { kind: "activate", conn: 1, run: 0, owner: 1, token: "held", snapshot: "current" },
  // The displaced owner is fenced out of every write.
  { kind: "heartbeat", conn: 0, run: 0, owner: 0, lagMs: 0 },
  { kind: "transition", conn: 0, run: 0, owner: 0, to: "completed", guard: "none" },
  { kind: "transition", conn: 1, run: 0, owner: 1, to: "running", guard: "none" },
  { kind: "restart" },
  { kind: "poll", conn: 0, reader: 0, limit: 2 },
  { kind: "poll", conn: 0, reader: 0, limit: 1_000 },
  { kind: "claim", conn: 0, run: 1, owner: 2, snapshot: "current" },
  { kind: "recover", conn: 1, run: 1, owner: 2, observer: 0, token: "held", evidence: true },
  { kind: "abandon", conn: 1, run: 1, owner: 2, token: "other" },
  { kind: "advance", ms: staleAfterMs + 1 },
  { kind: "recover", conn: 1, run: 1, owner: 2, observer: 0, token: "held", evidence: false },
  { kind: "recover", conn: 1, run: 1, owner: 2, observer: 0, token: "other", evidence: true },
  { kind: "recover", conn: 1, run: 1, owner: 2, observer: 0, token: "held", evidence: true },
  { kind: "claim", conn: 0, run: 1, owner: 2, snapshot: "pending" },
  { kind: "activate", conn: 0, run: 1, owner: 2, token: "held", snapshot: "suspended" },
  { kind: "claim", conn: 0, run: 1, owner: 2, snapshot: "current" },
  { kind: "abandon", conn: 0, run: 1, owner: 2, token: "held" },
  { kind: "transition", conn: 1, run: 0, owner: 1, to: "completed", guard: "present" },
  { kind: "cancelTree", conn: 1, run: 0 },
  { kind: "requestCancel", conn: 0, run: 1 },
  { kind: "requestCancel", conn: 0, run: 4 },
  { kind: "transition", conn: 1, run: 0, owner: 1, to: "completed", guard: "absent" },
  { kind: "transition", conn: 1, run: 0, owner: 1, to: "pending", guard: "none" },
  { kind: "transition", conn: 1, run: 0, owner: 1, to: "cancelled", guard: "present" },
  { kind: "requestCancel", conn: 0, run: 0 },
  { kind: "restart" },
  { kind: "advance", ms: 1_000 },
  { kind: "claimAndOwn", conn: 0, run: 3, owner: 2, snapshot: "current", evidence: false },
  { kind: "transition", conn: 0, run: 3, owner: 2, to: "suspended", guard: "none" },
  { kind: "claimAndOwn", conn: 1, run: 3, owner: 0, snapshot: "suspended", evidence: false },
  { kind: "transition", conn: 0, run: 3, owner: 0, to: "failed", guard: "none" },
  { kind: "advance", ms: staleAfterMs + 1 },
  // run-0 is pinned by its live descendants; run-3 has no live relative.
  { kind: "compact", conn: 1, ageMs: 1_000 },
  { kind: "poll", conn: 1, reader: 1, limit: 1_000 },
  { kind: "claimAndOwn", conn: 0, run: 1, owner: 0, snapshot: "current", evidence: false },
  { kind: "transition", conn: 0, run: 1, owner: 0, to: "cancelled", guard: "present" },
  { kind: "claimAndOwn", conn: 0, run: 2, owner: 0, snapshot: "current", evidence: false },
  { kind: "transition", conn: 0, run: 2, owner: 0, to: "cancelled", guard: "present" },
  // A run that finished exactly at the cutoff is not yet old enough.
  { kind: "compact", conn: 0, ageMs: 0 },
  { kind: "advance", ms: 1 },
  { kind: "compact", conn: 0, ageMs: 0 },
  { kind: "create", conn: 1, run: 3 },
  { kind: "restart" },
  { kind: "poll", conn: 0, reader: 0, limit: 1 },
  { kind: "poll", conn: 1, reader: 0, limit: 1_000 },
  { kind: "poll", conn: 0, reader: 1, limit: 1_000 }
]

describe("run lifecycle state model", () => {
  it("matches the model across the fixed boundary history", async () => {
    const reached = new Set<string>()
    const model = await withHarness(async (model, real) => {
      for (const op of boundary) {
        const observed = await step(model, real, op) as { readonly _tag?: string; readonly error?: string } | undefined
        reached.add(`${op.kind}:${observed?._tag ?? observed?.error ?? "done"}`)
      }
      return model
    })
    expect([...reached]).toEqual(expect.arrayContaining([
      "create:constraint",
      "claimAndOwn:Activated",
      "claimAndOwn:HeartbeatFresh",
      "claimAndOwn:EvidenceRequired",
      "claimAndOwn:AlreadyClaimed",
      "steal:LivenessUnconfirmed",
      "steal:HeartbeatFresh",
      "steal:Claimed",
      "claim:AlreadyClaimed",
      "claim:Claimed",
      "activate:ClaimLost",
      "activate:Activated",
      "activate:SnapshotChanged",
      "abandon:ClaimLost",
      "abandon:Abandoned",
      "recover:ClaimFresh",
      "recover:LivenessUnconfirmed",
      "recover:ClaimChanged",
      "recover:Recovered",
      "heartbeat:NotFound",
      "heartbeat:Updated",
      "heartbeat:FenceLost",
      "transition:FenceLost",
      "transition:GuardFailed",
      "transition:Transitioned",
      "transition:invalid_run",
      "requestCancel:AlreadyRequested",
      "requestCancel:NotFound",
      "requestCancel:Terminal"
    ]))
    expect(model.restarts).toBe(3)
    expect([...model.rows.keys()].sort()).toEqual(["run-3"])
    expect(model.edges.size).toBe(0)
  })

  it(
    `matches the independent run-lifecycle model across two connections and restart (seed ${seed})`,
    async () => {
      let executed = 0
      let commandsRun = 0
      let restarts = 0
      const details = await fc.check(
        fc.asyncProperty(
          fc.commands([operation.map((op) => new LifecycleCommand(op))], { maxCommands: steps, size: "max" }),
          (
            commands
          ) =>
            withHarness(async (model, real) => {
              await fc.asyncModelRun(() => Promise.resolve({ model, real }), commands)
              executed += 1
              commandsRun += model.steps
              restarts += model.restarts
            })
        ),
        { seed, numRuns: cases }
      )
      if (details.failed) {
        artifact({
          status: "failed",
          seed,
          cases,
          steps,
          counterexamplePath: details.counterexamplePath,
          shrunk: details.counterexample === null ? null : String(details.counterexample[0]),
          error: String(details.errorInstance)
        })
        throw new Error(fc.defaultReportMessage(details))
      }
      artifact({ status: "passed", seed, cases, steps, executed, commands: commandsRun, restarts })
      expect(executed).toBeGreaterThanOrEqual(cases)
    },
    600_000
  )
})

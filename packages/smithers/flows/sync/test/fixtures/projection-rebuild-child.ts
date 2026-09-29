/** Application-owned projections, public snapshot cache and atomic durable cursors. */
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Deferred, Effect, Layer, Option, Redacted, Schema, Stream } from "effect"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import * as BranchCommands from "../../src/BranchCommands.ts"
import * as BranchProjection from "../../src/BranchProjection.ts"
import * as BranchProtocol from "../../src/BranchProtocol.ts"
import * as BranchShare from "../../src/BranchShare.ts"
import * as RunCatalog from "../../src/RunCatalog.ts"
import * as SyncAuth from "../../src/SyncAuth.ts"
import { SyncError } from "../../src/SyncError.ts"
import * as Protocol from "../../src/SyncProtocol.ts"
import * as SyncServer from "../../src/SyncServer.ts"
import * as TestSocket from "../../src/test/TestSocket.ts"
import * as TestSync from "../../src/test/TestSync.ts"
import * as WorkspaceShare from "../../src/WorkspaceShare.ts"

const [mode, directory, countText] = process.argv.slice(2)
const count = Number(countText)
if (
  !directory || !mode || !["seed", "crash", "crash-workspace", "finish", "moving"].includes(mode) ||
  !Number.isSafeInteger(count) || count < 1
) {
  throw new Error("Expected seed/crash/finish/moving, directory and positive history size")
}
const branchId = "rebuild-branch" as BranchProtocol.BranchId
const branchRun = BranchProtocol.branchRunId(branchId)
const workspaceRun = "rebuild-workspace" as JournalEvent.RunId
const floor = count === 17 ? count - 1 : Math.floor((count - 1) / 2)
const seq = (n: number) => n as JournalEvent.Seq
const owner = { hostId: "projection-fixture", pid: 1, nonce: "fence" }
const identities = [
  {
    protocolVersion: 1,
    runId: branchRun,
    lineageId: "branch-generation-1",
    projection: "branch",
    projectionVersion: 1
  },
  {
    protocolVersion: 1,
    runId: workspaceRun,
    lineageId: "workspace-generation-1",
    projection: "sum",
    projectionVersion: 1
  }
] as const
const Sum = Schema.Struct({ total: Schema.Int, count: Schema.Int })
type State = BranchProjection.State | typeof Sum.Type
const empty = (runId: JournalEvent.RunId): State =>
  runId === branchRun ? BranchProjection.empty(branchId) : { total: 0, count: 0 }
const fold = (runId: JournalEvent.RunId, state: State, entry: JournalEvent.Entry): State => {
  if (runId === branchRun) return BranchProjection.apply(state as BranchProjection.State, entry)
  const sum = state as typeof Sum.Type
  return { total: sum.total + Schema.decodeUnknownSync(Schema.Int)(entry.payload), count: sum.count + 1 }
}
const emit = (value: unknown) =>
  Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(value)}\n`)
  })
const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: join(directory, "history.sqlite") })
)
const storage = SqlJournal.layer({ capacity: 64, overflow: "reject" }).pipe(
  Layer.provideMerge(Layer.provideMerge(JournalMigrations.layer, database))
)
const auth = Layer.mergeAll(
  BranchShare.layerHmac({
    activeKid: "primary",
    keys: [{ kid: "primary", secret: Redacted.make("projection-rebuild-test-01234567") }]
  }),
  WorkspaceShare.layerHmac({
    activeKid: "test",
    keys: [{ kid: "test", secret: Redacted.make("workspace-rebuild-test-012345678") }]
  })
)
const program = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const sql = yield* SqlClient.SqlClient
  const share = yield* BranchShare.BranchShare
  const workspaceShare = yield* WorkspaceShare.WorkspaceShare
  const branchCapability = yield* share.mint({
    branchId,
    capabilityId: "branch-reader",
    access: "write",
    ttlMs: 60_000
  })
  const workspaceCapability = yield* workspaceShare.mint({
    capabilityId: "workspace-reader",
    access: "read",
    ttlMs: 60_000
  })
  const header = yield* SyncAuth.encodeCapability(workspaceCapability)
  if (mode === "seed") {
    const commands = yield* BranchCommands.makeLive
    for (const { runId } of identities) {
      yield* sql`
        INSERT INTO flows_consensus_leases (run_id, owner_host_id, owner_pid, owner_nonce, granted_at_ms, heartbeat_at_ms)
        VALUES (${runId}, ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0, 0)
      `
    }
    for (let index = 0; index < count; index++) {
      yield* commands.submit({
        capability: branchCapability,
        submission: yield* BranchCommands.submission({
          branchId,
          commandId: `command-${index}` as BranchProtocol.CommandId,
          participantId: (index % 2 === 0 ? "alice" : "bob") as BranchProtocol.ParticipantId,
          name: index % 3 === 0 ? BranchProtocol.SayCommand : "branch.edit",
          args: `value-${index}-é😀`,
          target: index % 3 === 0 ? "" : `field-${index % 2}`
        })
      })
      yield* journal.emitDurableUnfenced({
        runId: workspaceRun,
        sourceId: "writer" as JournalEvent.SourceId,
        eventType: "increment",
        payload: index + 1
      })
    }
    const projections = []
    for (const identity of identities) {
      const history = (yield* journal.entries({ runId: identity.runId, limit: count + 1 })).entries
      let full = empty(identity.runId)
      for (const entry of history) full = fold(identity.runId, full, entry)
      projections.push({ runId: identity.runId, seq: count - 1, state: full })
      let state = empty(identity.runId)
      for (const entry of history.slice(0, floor + 1)) state = fold(identity.runId, state, entry)
      yield* journal.checkpoint({
        runId: identity.runId,
        seq: seq(floor),
        state: {
          identity,
          public: state,
          private: "never-on-the-wire"
        }
      }, owner)
      yield* journal.compact({ runId: identity.runId, upTo: seq(floor) }, owner)
    }
    yield* emit({ phase: "seeded", count, floor, projections })
    return
  }
  const consumer = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(join(directory, "consumer.sqlite"))),
    (db) => Effect.sync(() => db.close())
  )
  consumer.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS projection (run TEXT PRIMARY KEY, state TEXT NOT NULL, seq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS public_snapshots (run TEXT PRIMARY KEY, snapshot TEXT NOT NULL);`)
  const moved = new Set<string>()
  const source: SyncServer.SnapshotSource["Service"] = {
    read: (request) =>
      Effect.gen(function*() {
        const identity = identities.find((value) => value.runId === request.runId)
        if (!identity) return yield* Effect.fail(new SyncError({ code: "not_found", message: "Unknown projection" }))
        const saved = yield* journal.latestCheckpoint(request.runId).pipe(Effect.orDie)
        if (Option.isNone(saved)) return yield* Effect.die(new Error("Checkpoint retention lost its floor"))
        const checkpoint = saved.value
        const envelope = checkpoint.state as { identity: unknown; public: unknown }
        if (JSON.stringify(envelope.identity) !== JSON.stringify(identity)) {
          return yield* Effect.die(new Error("Checkpoint identity mismatch"))
        }
        const state = identity.projection === "branch"
          ? Schema.decodeUnknownSync(BranchProjection.State)(envelope.public)
          : Schema.decodeUnknownSync(Sum)(envelope.public)
        const snapshot = Schema.decodeUnknownSync(Protocol.Snapshot)({ ...identity, seq: checkpoint.seq, state })
        // A disposable public cache is reconstructed from the retained authoritative checkpoint.
        consumer.prepare("INSERT OR REPLACE INTO public_snapshots VALUES (?, ?)").run(
          request.runId,
          JSON.stringify(snapshot)
        )
        if (mode === "moving" && !moved.has(request.runId) && count > 3) {
          moved.add(request.runId)
          const suffix =
            (yield* journal.entries({ runId: request.runId, after: checkpoint.seq, limit: count }).pipe(Effect.orDie))
              .entries
          let newer: State = state
          for (const entry of suffix.filter((entry) => entry.seq < count - 1)) newer = fold(request.runId, newer, entry)
          yield* journal.checkpoint(
            { runId: request.runId, seq: seq(count - 2), state: { identity, public: newer } },
            owner
          ).pipe(Effect.orDie)
          yield* journal.compact({ runId: request.runId, upTo: seq(count - 2) }, owner).pipe(Effect.orDie)
          // Collection happens after capture but before transfer. The response owns its bytes.
          consumer.prepare("DELETE FROM public_snapshots WHERE run=?").run(request.runId)
        }
        return snapshot
      })
  }
  const server = yield* SyncServer.makeLive.pipe(Effect.provideService(SyncServer.SnapshotSource, source))
  const pair = yield* TestSocket.makePair()
  let privateOnWire = false
  pair.faults.installFilter((bytes) => {
    privateOnWire ||= new TextDecoder().decode(bytes).includes("never-on-the-wire")
    return true
  })
  const remote = yield* TestSync.connect(pair).pipe(
    Effect.provideService(SyncServer.SyncServer, server),
    Effect.provide(SyncAuth.layer)
  )
  const restored: Record<string, Array<number>> = {}
  for (const identity of identities) {
    const finished = yield* Deferred.make<void>()
    const current = consumer.prepare("SELECT state, seq FROM projection WHERE run=?").get(identity.runId)
    let state: State = current ? JSON.parse(String(current.state)) as State : empty(identity.runId)
    const initialSeq = current ? Number(current.seq) : -1
    restored[identity.runId] = []
    if (initialSeq === count - 1) continue
    const store = (value: State, position: number) => {
      consumer.prepare("INSERT OR REPLACE INTO projection VALUES (?, ?, ?)").run(
        identity.runId,
        JSON.stringify(value),
        position
      )
      state = value
    }
    const request = {
      protocolVersion: 1,
      scope: { _tag: "Run", runId: identity.runId } as const,
      capability: branchCapability,
      cursors: initialSeq < 0 ? [] : [{ generation: 0, runId: identity.runId, afterSeq: seq(initialSeq) }]
    }
    // A client with no recovery support receives the original typed resync refusal.
    if (initialSeq < floor) {
      const refusal = yield* Effect.flip(
        RpcClient.withHeaders(remote.subscribe(request).pipe(Stream.take(1), Stream.runDrain), {
          [SyncAuth.capabilityHeader]: header
        })
      )
      if (!(refusal instanceof SyncError) || refusal.code !== "compacted") {
        return yield* Effect.die(new Error("Old client skipped compaction"))
      }
    }
    yield* RpcClient.withHeaders(
      remote.subscribe({
        ...request,
        onResync: (resync) =>
          Effect.gen(function*() {
            const snapshot = yield* remote.snapshot({
              ...identity,
              atLeastSeq: resync.checkpointSeq,
              capability: branchCapability
            })
            const value = identity.projection === "branch" ?
              Schema.decodeUnknownSync(BranchProjection.State)(snapshot.state)
              : Schema.decodeUnknownSync(Sum)(snapshot.state)
            consumer.exec("BEGIN IMMEDIATE")
            store(value, -1)
            if (
              (mode === "crash" && identity.projection === "branch") ||
              (mode === "crash-workspace" && identity.projection === "sum")
            ) {
              yield* emit({ phase: "uncommitted-rebuild", runId: identity.runId, snapshotSeq: snapshot.seq })
              yield* Effect.never
            }
            store(value, snapshot.seq)
            consumer.exec("COMMIT")
            restored[identity.runId]!.push(snapshot.seq)
            if (snapshot.seq === count - 1) yield* Deferred.succeed(finished, undefined)
            return { generation: 0, runId: identity.runId, afterSeq: snapshot.seq }
          }),
        apply: (entry) =>
          Effect.gen(function*() {
            const next = fold(identity.runId, state, entry)
            consumer.exec("BEGIN IMMEDIATE")
            store(next, entry.seq)
            consumer.exec("COMMIT")
            if (entry.seq === count - 1) yield* Deferred.succeed(finished, undefined)
          })
      }).pipe(Stream.interruptWhen(Deferred.await(finished)), Stream.runDrain),
      { [SyncAuth.capabilityHeader]: header }
    )
  }
  yield* emit({
    phase: "complete",
    restored,
    privateOnWire,
    projections: consumer.prepare("SELECT * FROM projection ORDER BY run").all().map((row) => ({
      runId: row.run,
      seq: row.seq,
      state: JSON.parse(String(row.state)) as unknown
    })),
    progress: yield* remote.progress
  })
}).pipe(Effect.provide(Layer.mergeAll(storage, auth, RunCatalog.layerStatic([branchRun, workspaceRun]))), Effect.scoped)
const keepAlive = setInterval(() => {}, 1000)
Effect.runPromise(program).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`)
  process.exitCode = 1
}).finally(() => clearInterval(keepAlive))

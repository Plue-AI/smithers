/** Optional scheduled workload. No credentials, remote services, or retained scratch databases. */
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import * as Socket from "effect/unstable/socket/Socket"
import * as SocketServer from "effect/unstable/socket/SocketServer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import * as Net from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as RunCatalog from "../../src/RunCatalog.ts"
import * as SyncClient from "../../src/SyncClient.ts"
import * as Protocol from "../../src/SyncProtocol.ts"
import * as SyncRpcs from "../../src/SyncRpcs.ts"
import * as SyncServer from "../../src/SyncServer.ts"
import * as TestSync from "../../src/test/TestSync.ts"
import { type Artifact, type Metric, type Sample, slope, slopeBudgets, verify } from "../soakArtifact.ts"

const minutes = Number(process.env.SMITHERS_SOAK_MINUTES)
assert.ok(Number.isFinite(minutes) && minutes >= 1 && minutes <= 720, "SMITHERS_SOAK_MINUTES must be 1..720")
const artifactPath = process.env.SMITHERS_SOAK_ARTIFACT
assert.ok(artifactPath, "SMITHERS_SOAK_ARTIFACT must name the output JSON file")
assert.ok(globalThis.gc, "Run the soak with --expose-gc")
const root = fileURLToPath(new URL("../../", import.meta.url))
const digest = createHash("sha256")
for (
  const file of readdirSync(join(root, "src"), { recursive: true }).map(String).filter((file) => file.endsWith(".ts"))
    .sort()
) {
  digest.update(file).update(readFileSync(join(root, "src", file)))
}
const directory = mkdtempSync(join(tmpdir(), "sync-long-soak-"))
const filename = join(directory, "history.sqlite")
const artifact: Artifact = {
  schemaVersion: 1,
  status: "failed",
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  candidate: {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0,
    sourceSha256: digest.digest("hex")
  },
  workload: { requestedMinutes: minutes, warmupMs: 20_000, sampleIntervalMs: 10_000, seed: 20260904 },
  samples: [],
  slopes: {} as Record<Metric, number>,
  cleanup: { activeReads: -1, pendingWrites: -1, slowSubscribers: -1, sockets: -1 }
}
const writeArtifact = () => {
  mkdirSync(dirname(artifactPath), { recursive: true })
  writeFileSync(`${artifactPath}.tmp`, `${JSON.stringify(artifact, null, 2)}\n`)
  renameSync(`${artifactPath}.tmp`, artifactPath)
}
// Even SIGKILL leaves an explicit incomplete receipt instead of a stale success.
artifact.failure = "incomplete: workload has not finished"
writeArtifact()
const handles = () => (process as unknown as { _getActiveHandles(): Array<unknown> })._getActiveHandles()
const sockets = () =>
  handles().filter((handle): handle is Net.Socket => handle instanceof Net.Socket && handle.remoteAddress !== undefined)
let activeReads = 0
let pendingWrites = 0
let slowSubscribers = 0
let connections = 0
let compactions = 0
let emitted = 0
let cycles = 0
const runId = "long-soak" as JournalEvent.RunId
const seq = (value: number) => value as JournalEvent.Seq
const owner = { hostId: "soak", pid: process.pid, nonce: "one-writer" }
const storage = SqlJournal.layer({ capacity: 64, overflow: "reject" }).pipe(Layer.provideMerge(
  Layer.provideMerge(
    JournalMigrations.layer,
    Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
  )
))
const program = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    INSERT INTO flows_consensus_leases (run_id, owner_host_id, owner_pid, owner_nonce, granted_at_ms, heartbeat_at_ms)
    VALUES (${runId}, ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0, 0)
  `
  const stalledChanges = yield* journal.changes
  const observed = Journal.Journal.of({
    ...journal,
    entries: (request) =>
      Effect.sync(() => {
        activeReads++
      }).pipe(
        Effect.andThen(journal.entries(request)),
        Effect.ensuring(Effect.sync(() => {
          activeReads--
        }))
      )
  })
  let checkpoint: Protocol.Snapshot = {
    protocolVersion: 1,
    runId,
    lineageId: "soak-generation",
    projection: "count",
    projectionVersion: 1,
    seq: seq(0),
    state: { total: 1 }
  }
  const server = yield* SyncServer.makeLiveWith({ tailIntervalMs: 25, concurrency: 4 }).pipe(
    Effect.provideService(Journal.Journal, observed),
    Effect.provideService(SyncServer.SnapshotSource, { read: () => Effect.sync(() => checkpoint) })
  )
  const listener = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })
  assert.equal(listener.address._tag, "InetAddressV4")
  const port = (listener.address as { port: number }).port
  const serverProtocol = yield* RpcServer.makeProtocolSocketServer.pipe(
    Effect.provideService(SocketServer.SocketServer, listener),
    Effect.provide(RpcSerialization.layerNdjson)
  )
  yield* RpcServer.make(SyncRpcs.SyncRpcs, { disableFatalDefects: true }).pipe(
    Effect.provideService(RpcServer.Protocol, serverProtocol),
    Effect.provide(SyncServer.layerHandlers.pipe(Layer.provide(Layer.succeed(SyncServer.SyncServer, server)))),
    Effect.provide(TestSync.layerTrustAllAsOwner),
    Effect.forkScoped
  )
  const connect = Effect.gen(function*() {
    const socket = yield* NodeSocket.makeNet({ host: "127.0.0.1", port })
    const protocol = yield* RpcClient.makeProtocolSocket().pipe(
      Effect.provideService(Socket.Socket, socket),
      Effect.provide(RpcSerialization.layerNdjson)
    )
    const client = yield* RpcClient.make(SyncRpcs.SyncRpcs).pipe(Effect.provideService(RpcClient.Protocol, protocol))
    connections++
    return yield* SyncClient.make({ client })
  })
  const append = Effect.gen(function*() {
    pendingWrites++
    yield* journal.emitDurableUnfenced({
      runId,
      sourceId: "writer" as JournalEvent.SourceId,
      eventType: "increment",
      payload: 1
    })
      .pipe(Effect.ensuring(Effect.sync(() => {
        pendingWrites--
      })))
    emitted++
  })
  yield* append
  const entered = yield* Deferred.make<void>()
  const slow = yield* Effect.gen(function*() {
    const client = yield* connect
    slowSubscribers++
    yield* client.subscribe({
      scope: { _tag: "Workspace" },
      cursors: [],
      credit: 4096,
      apply: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
    }).pipe(
      Stream.runDrain,
      Effect.ensuring(Effect.sync(() => {
        slowSubscribers--
      }))
    )
  }).pipe(Effect.scoped, Effect.forkScoped)
  yield* Deferred.await(entered)
  process.stdout.write(`${JSON.stringify({ phase: "ready", directory })}\n`)
  const began = performance.now()
  let nextSample = artifact.workload.warmupMs
  let compactedThrough = -1
  const fileSize = (file: string) => existsSync(file) ? statSync(file).size : 0
  const sample = Effect.gen(function*() {
    globalThis.gc!()
    const memory = process.memoryUsage()
    const retained = yield* sql<{ events: number }>`SELECT COUNT(*) AS events FROM flows_journal_events`
    const checkpoints = yield* sql<
      { checkpoints: number }
    >`SELECT COUNT(*) AS checkpoints FROM flows_journal_checkpoints`
    const peers = sockets()
    const value: Sample = {
      elapsedMs: performance.now() - began,
      cycle: cycles,
      emitted,
      connections,
      compactions,
      heapUsed: memory.heapUsed,
      rss: memory.rss,
      handles: handles().length,
      sockets: peers.length,
      activeReads,
      pendingWrites,
      socketQueuedBytes: peers.reduce((total, peer) => total + peer.readableLength + peer.writableLength, 0),
      journalQueued: stalledChanges.subscription.size(),
      databaseBytes: fileSize(filename),
      walBytes: fileSize(`${filename}-wal`),
      retainedRows: Number(retained[0]!.events),
      retainedCheckpoints: Number(checkpoints[0]!.checkpoints),
      slowSubscribers
    }
    artifact.samples.push(value)
    process.stdout.write(`${JSON.stringify({ checkpoint: artifact.samples.length, ...value })}\n`)
  })
  while (performance.now() - began < minutes * 60_000) {
    for (let i = 0; i < 8; i++) yield* append
    const tip = emitted - 1
    const floor = Math.max(0, tip - 31)
    checkpoint = { ...checkpoint, seq: seq(floor), state: { total: floor + 1 } }
    if (floor > compactedThrough) {
      yield* journal.checkpoint({ runId, seq: seq(floor), state: checkpoint }, owner)
      yield* journal.compact({ runId, upTo: seq(floor) }, owner)
      compactedThrough = floor
      compactions++
    }
    yield* Effect.all(
      Array.from({ length: 4 }, () =>
        Effect.gen(function*() {
          const client = yield* connect
          let total = 0
          yield* client.subscribe({
            scope: { _tag: "Run", runId },
            cursors: [],
            onResync: (resync) =>
              Effect.gen(function*() {
                const saved = yield* client.snapshot({
                  protocolVersion: 1,
                  runId,
                  lineageId: "soak-generation",
                  projection: "count",
                  projectionVersion: 1,
                  atLeastSeq: resync.checkpointSeq
                })
                total = (saved.state as { total: number }).total
                return { generation: 0, runId, afterSeq: saved.seq }
              }),
            apply: () =>
              Effect.sync(() => {
                total++
              })
          }).pipe(Stream.takeUntil((entry) => entry.seq === tip), Stream.runDrain)
          assert.equal(total, emitted)
          assert.deepEqual((yield* client.progress).applied, [{ generation: 0, runId, afterSeq: tip }])
        }).pipe(Effect.scoped)),
      { concurrency: 4 }
    )
    cycles++
    if (performance.now() - began >= nextSample) {
      yield* sample
      nextSample += artifact.workload.sampleIntervalMs
    }
    yield* Effect.sleep(100)
  }
  // The last sample proves the requested duration actually elapsed.
  if (artifact.samples.at(-1)!.elapsedMs < minutes * 60_000) yield* sample
  yield* Fiber.interrupt(slow)
}).pipe(Effect.provide(Layer.mergeAll(storage, RunCatalog.layerStatic([runId]))), Effect.scoped)

const abort = new AbortController()
const interrupted = () => abort.abort()
process.once("SIGINT", interrupted)
process.once("SIGTERM", interrupted)
try {
  await Effect.runPromise(program, { signal: abort.signal })
  // Node closes TCP handles asynchronously after their Effect scopes close.
  await new Promise((resolve) => setTimeout(resolve, 100))
  artifact.cleanup = { activeReads, pendingWrites, slowSubscribers, sockets: sockets().length }
  for (const metric of Object.keys(slopeBudgets) as Array<Metric>) {
    artifact.slopes[metric] = slope(artifact.samples, metric)
  }
  artifact.status = "complete"
  delete artifact.failure
  verify(artifact, minutes)
} catch (cause) {
  artifact.status = "failed"
  artifact.failure = String(cause)
  process.stderr.write(`${String(cause)}\n`)
  process.exitCode = 1
  await new Promise((resolve) => setTimeout(resolve, 100))
  artifact.cleanup = { activeReads, pendingWrites, slowSubscribers, sockets: sockets().length }
} finally {
  process.off("SIGINT", interrupted)
  process.off("SIGTERM", interrupted)
  writeArtifact()
  rmSync(directory, { recursive: true, force: true })
}

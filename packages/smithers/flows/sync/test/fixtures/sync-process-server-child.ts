import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal } from "@smthrs/journal"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Effect, Layer, Redacted, Stream } from "effect"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import * as Socket from "effect/unstable/socket/Socket"
import * as Net from "node:net"
import * as BranchCommands from "../../src/BranchCommands.ts"
import * as BranchProtocol from "../../src/BranchProtocol.ts"
import * as BranchShare from "../../src/BranchShare.ts"
import * as RunCatalog from "../../src/RunCatalog.ts"
import { SyncError } from "../../src/SyncError.ts"
import * as SyncRpcs from "../../src/SyncRpcs.ts"
import * as SyncServer from "../../src/SyncServer.ts"

const mode = process.argv[2]
const filename = process.argv[3]

if ((mode !== "first" && mode !== "second") || filename === undefined) {
  throw new Error("usage: sync-process-server-child.ts <first|second> <filename>")
}

const branchId = "process-recovery" as BranchProtocol.BranchId
const runId = BranchProtocol.branchRunId(branchId)
const participantId = "recovery-client" as BranchProtocol.ParticipantId
const entryCount = 300

const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
const migrated = Layer.provideMerge(JournalMigrations.layer, database)
const journal = SqlJournal.layer({ capacity: 512, overflow: "reject" }).pipe(
  Layer.provide(migrated)
)
const stack = Layer.mergeAll(
  journal,
  BranchShare.layerHmac({
    activeKid: "primary",
    keys: [{ kid: "primary", secret: Redacted.make("process-recovery-secret-01234567") }]
  }),
  RunCatalog.layerStatic([runId]),
  Layer.succeed(SyncRpcs.SyncAuth)((effect) => effect)
)

const listen = (server: Net.Server): Effect.Effect<void> =>
  Effect.promise(() =>
    new Promise<void>((resolve, reject) => {
      const onError = (cause: Error) => reject(cause)
      server.once("error", onError)
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError)
        resolve()
      })
    })
  )

const emit = (value: unknown): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(value)}\n`)
  })

const request = (
  capability: BranchProtocol.ShareCapability,
  index: number
): Effect.Effect<BranchProtocol.SubmitRequest, SyncError> =>
  Effect.map(
    BranchCommands.submission({
      branchId,
      commandId: `command-${index}` as BranchProtocol.CommandId,
      participantId,
      name: BranchProtocol.SayCommand,
      args: `message-${index}`
    }),
    (submission) => ({ capability, submission })
  )

const program = Effect.scoped(
  Effect.gen(function*() {
    const commands = yield* BranchCommands.makeLive
    const share = yield* BranchShare.BranchShare
    const sync = yield* SyncServer.makeLive
    const capability = yield* share.mint({
      branchId,
      capabilityId: `process-recovery-${mode}`,
      access: "write",
      ttlMs: 600_000
    })

    let retry: BranchProtocol.CommandReceipt | undefined
    if (mode === "first") {
      for (let index = 0; index < entryCount; index += 1) {
        yield* commands.submit(yield* request(capability, index))
      }
    } else {
      retry = yield* commands.submit(yield* request(capability, 0))
    }
    const durable = yield* Journal.Journal
    const page = yield* durable.entries({ runId, limit: entryCount + 1 })

    const listener = Net.createServer()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        listener.close()
      })
    )
    const accepted = new Promise<Net.Socket>((resolve) => listener.once("connection", resolve))
    yield* listen(listener)
    const address = listener.address()
    if (address === null || typeof address === "string") {
      return yield* Effect.die(new Error("loopback TCP listener has no numeric address"))
    }
    yield* emit({ phase: "ready", mode, port: address.port, capability, retry, durableCount: page.entries.length })

    const netSocket = yield* Effect.promise(() => accepted)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        netSocket.destroy()
      })
    )
    const socket = yield* NodeSocket.fromDuplex(Effect.succeed(netSocket))
    const serialization = RpcSerialization.ndjson.makeUnsafe()
    const writer = yield* socket.writer
    const handlers = SyncRpcs.SyncRpcs.toLayer(
      Effect.succeed(
        SyncRpcs.SyncRpcs.of({
          "Sync.Snapshot": (request) => sync.snapshot(request),
          "Sync.Read": (readRequest) => sync.read(readRequest),
          "Sync.Subscribe": (subscribeRequest) => sync.subscribe(subscribeRequest)
        })
      )
    )
    const rpcServer = yield* RpcServer.makeNoSerialization(SyncRpcs.SyncRpcs, {
      onFromServer: (response) => {
        const encoded = serialization.encode(response)
        return Effect.orDie(writer.write(encoded!))
      },
      disableFatalDefects: true
    }).pipe(Effect.provide(handlers))
    yield* Stream.runForEach(Socket.toStream(socket), (bytes) =>
      Effect.forEach(
        serialization.decode(bytes),
        (message) => rpcServer.write(0, message as never),
        { discard: true }
      )).pipe(Effect.forkScoped)
    return yield* Effect.never
  }).pipe(Effect.provide(stack))
)

// A process entrypoint: running the Effect here is the intended boundary.
Effect.runPromise(program).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`)
  process.exitCode = 1
})

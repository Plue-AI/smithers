/**
 * Share a sealed step result between engines with separate databases.
 *
 * Both engines compose a local cache with the same HTTP action-cache tier.
 * Deferred publication keeps the remote request outside the local state
 * transaction. A refused publication leaves the run successful and records an
 * unpublished provenance result.
 *
 * The example server uses loopback HTTP for the action-cache protocol. It does
 * not compose the remote artifact tier, which requires HTTPS.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodePath from "@effect/platform-node/NodePath"
import { CacheSync, EngineStore, StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Journal, type JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as CombinedCacheStore from "@smthrs/step-cache/CombinedCacheStore"
import * as RemoteCacheStore from "@smthrs/step-cache/RemoteCacheStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { createServer, type Server } from "node:http"
import { stubJj } from "./durable-layer.ts"

/** What one run of the example observed. */
export interface Summary {
  /** The value each engine answered with. */
  readonly results: readonly [string, string]
  /** How many times the sealed body actually executed across both engines. */
  readonly executions: number
  /** The `GET /ac/{keyDigest}` requests the shared tier served. */
  readonly acReads: number
  /** The `PUT /ac/{keyDigest}` requests the shared tier accepted. */
  readonly acWrites: number
  /** The `unpublished` cache-provenance records the second engine journalled. */
  readonly unpublished: ReadonlyArray<string>
}

/** The recorded entries the in-process action cache holds, keyed by digest. */
interface SharedTier {
  readonly url: string
  readonly reads: () => number
  readonly writes: () => number
  readonly close: () => Promise<void>
}

/**
 * A real HTTP action cache: `GET /ac/{key}` answers a stored entry or 404,
 * `PUT /ac/{key}` records one. `refusePut` makes every write answer 503, which
 * is how the third scenario reproduces an unreachable shared tier.
 */
const startSharedTier = (refusePut: boolean): Promise<SharedTier> => {
  const entries = new Map<string, string>()
  let reads = 0
  let writes = 0
  const server: Server = createServer((request, response) => {
    const key = decodeURIComponent((request.url ?? "").replace(/^\/ac\//, ""))
    if (request.method === "GET") {
      reads++
      const entry = entries.get(key)
      if (entry === undefined) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { "content-type": "application/json" }).end(entry)
      return
    }
    if (request.method === "PUT") {
      if (refusePut) {
        request.resume()
        response.writeHead(503).end()
        return
      }
      const chunks: Array<Buffer> = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        writes++
        entries.set(key, Buffer.concat(chunks).toString("utf8"))
        response.writeHead(201).end()
      })
      return
    }
    response.writeHead(405).end()
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        reads: () => reads,
        writes: () => writes,
        close: () =>
          new Promise((closed) => {
            server.closeAllConnections()
            server.close(() => closed())
          })
      })
    })
  })
}

/** The declared atom the flow's body names. */
export const Bundle = Action.make("examples/RemoteBundle", {
  payload: { target: Schema.String },
  success: Schema.String
})

export const Build = Flow.make("examples/RemoteBuild", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: (payload) => Bundle.call(payload)
})

/**
 * The sealed step whose result travels.
 *
 * Two declarations make it shareable, and a step missing either stays local:
 *
 * - `idempotencyKey` gives the step an identity another machine can derive.
 *   Without one the engine falls back to a run-local invocation key.
 * - `metadata` declares a HARD file boundary. Only a hermetic step is
 *   cacheable across runs, and the boundary is what the host measures the
 *   execution against to decide whether the claim held. An empty read set and
 *   an empty write set is the honest declaration for a body that touches no
 *   files at all.
 */
export const Compile = (onExecute: () => void) =>
  Action.make({
    name: "examples/RemoteCompile",
    success: Schema.String,
    tier: "sealed",
    idempotencyKey: "examples/remote-compile/v1",
    metadata: { readSet: [], writeSet: [], boundaryMode: "hard" },
    execute: Effect.sync(() => {
      onExecute()
      return "dist/server.js"
    })
  })

/**
 * One durable engine whose step cache reads through, and publishes to, the
 * shared tier at `endpoint`.
 *
 * The composition differs from `durable-layer.ts` is two layers: a `CacheStore` built
 * from the SQL local tier plus a `RemoteCacheStore`, and the `CacheSync` seam
 * the engine publishes through once its write transaction has committed. Both
 * are merged ABOVE the storage layer, so they shadow the local-only
 * `CacheStore` that `NodeRuntime.storage` provides.
 */
const engineLayer = (filename: string, hostId: string, endpoint: string) => {
  const remote = RemoteCacheStore.make({ endpoint })
  const shared = Layer.mergeAll(
    Layer.effect(CacheStore.CacheStore)(
      Effect.gen(function*() {
        const local = yield* CacheStore.make
        return CombinedCacheStore.make({
          local,
          remote: yield* remote,
          publication: "deferred"
        })
      })
    ),
    CacheSync.layer(remote)
  )
  const execution = Layer.mergeAll(
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    shared
  ).pipe(Layer.provideMerge(NodeRuntime.storage(filename)))
  return EngineStore.layer({
    owner: { hostId },
    journalSource: `${hostId}-engine`
  }).pipe(
    Layer.provideMerge(execution),
    Layer.provideMerge(
      Layer.mergeAll(
        stubJj,
        FetchHttpClient.layer,
        // The third declaration a shareable step needs, and the one that lives
        // on the COMPOSITION rather than the action: a complete cache
        // environment. Without it the engine refuses to claim any result is
        // reusable and scopes every key to its own run, so two engines derive
        // two digests and neither ever finds the other's row. It belongs
        // BENEATH the engine, where the dispatch reads it, not only where the
        // caller executes the flow. Declare it only when the composition can
        // name every semantic layer and capability; here there are none of
        // either.
        Action.layerCacheEnvironment({ layers: [], capabilities: {} })
      )
    ),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(Layer.merge(AtomicFileSystem.layer, NodePath.layer))
  )
}

const runOn = (
  filename: string,
  hostId: string,
  endpoint: string,
  executionId: string,
  onExecute: () => void
) =>
  Effect.gen(function*() {
    const result = yield* Build.execute({ target: "server" }, { executionId })
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: executionId as JournalEvent.RunId, limit: 200 })
    const unpublished = page.entries
      .filter((entry) => entry.eventType === "flows.engine.cache-provenance")
      .map((entry) => entry.payload as { readonly action?: string })
      .filter((payload) => payload.action === "unpublished")
      .map(() => executionId)
    return { result, unpublished }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Bundle.toLayer(({ target }) =>
          Effect.map(Compile(onExecute), (artifact) => `${artifact}?target=${target}`)
        ),
        Interpreter.layer(Build)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(engineLayer(filename, hostId, endpoint))
      )
    ),
    Effect.scoped,
    Effect.orDie
  )

/**
 * Runs the same flow on two engines over two database files, against one shared
 * action cache.
 *
 * With `refusePublish`, the shared tier answers every write 503: both engines
 * then execute the body, both succeed, and both journal the refusal.
 */
export const main = async (options: {
  readonly first: string
  readonly second: string
  readonly refusePublish?: boolean
}): Promise<Summary> => {
  const tier = await startSharedTier(options.refusePublish === true)
  let executions = 0
  const count = () => {
    executions++
  }
  try {
    const first = await Effect.runPromise(runOn(options.first, "engine-a", tier.url, "remote-a", count))
    const second = await Effect.runPromise(runOn(options.second, "engine-b", tier.url, "remote-b", count))
    return {
      results: [first.result, second.result],
      executions,
      acReads: tier.reads(),
      acWrites: tier.writes(),
      unpublished: [...first.unpublished, ...second.unpublished]
    }
  } finally {
    await tier.close()
  }
}

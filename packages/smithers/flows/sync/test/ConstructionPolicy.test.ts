/**
 * Where a numeric policy is refused, and what shape a service is provided in.
 *
 * A policy option is checked once, by the constructor that takes it, so a
 * composition with a bad one fails to build instead of building a service that
 * refuses every operation it is later asked for. `SyncClient` accepted a
 * `maxFrameBytes` of `NaN` and then failed each `subscribe` and each
 * `snapshot` under it; `RunCatalog` forwarded `changesCapacity` to
 * `PubSub.sliding` and `intervalMs` to `Effect.delay` unchecked, which is a
 * poll loop with no interval rather than a refusal. These cases pin the
 * boundary the API reference documents: `make`/`layer` carry the defaults and
 * cannot fail on a policy, `makeWith`/`layerWith` validate the caller's and
 * fail with `invalid_request`.
 *
 * @since 1.0.0-rc.0
 */
import { describe, expect, it } from "@effect/vitest"
import type { JournalEvent } from "@smthrs/journal"
import { Effect, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as Socket from "effect/unstable/socket/Socket"
import * as BranchPresence from "../src/BranchPresence.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncClient from "../src/SyncClient.ts"
import * as SyncProtocol from "../src/SyncProtocol.ts"
import * as TestSocket from "../src/test/TestSocket.ts"
import * as WorkspaceShare from "../src/WorkspaceShare.ts"

/** A transport no construction-time refusal ever reaches. */
const client = {} as Parameters<typeof SyncClient.make>[0]["client"]

const shareLayer = BranchShare.layerHmac({
  activeKid: "primary",
  keys: [{ kid: "primary", secret: Redacted.make("construction-secret-0123456789ab") }]
})

const runId = (value: string) => value as JournalEvent.RunId

describe("SyncClient construction policy", () => {
  it.effect("refuses a frame ceiling or page size that is not a positive safe integer", () =>
    Effect.gen(function*() {
      const bytes = yield* Effect.flip(SyncClient.makeWith({ client, maxFrameBytes: Number.NaN }))
      const zero = yield* Effect.flip(SyncClient.makeWith({ bootstrapLimit: 0, client }))
      const overLimit = yield* Effect.flip(
        SyncClient.makeWith({ bootstrapLimit: SyncProtocol.maxReadLimit + 1, client })
      )

      for (const refusal of [bytes, zero, overLimit]) expect(refusal.code).toBe("invalid_request")
      expect(bytes.message).toContain("SyncClient.Options.maxFrameBytes")
      expect(zero.message).toContain("SyncClient.Options.bootstrapLimit")
      expect(overLimit.message).toContain(`at most ${SyncProtocol.maxReadLimit}`)
    }))

  it.effect("accepts the default policy without a per-operation check", () =>
    Effect.gen(function*() {
      const sync = yield* SyncClient.makeWith({ client })
      const defaults = yield* SyncClient.make({ client })

      expect((yield* sync.progress).delivered).toEqual([])
      expect((yield* defaults.progress).delivered).toEqual([])
    }))

  it.effect("provides the client under an explicit policy, and fails the layer on a bad one", () =>
    Effect.gen(function*() {
      const overSocket = <A, E>(effect: Effect.Effect<A, E, RpcClient.Protocol>) =>
        Effect.gen(function*() {
          const pair = yield* TestSocket.makePair()
          const protocol = yield* RpcClient.makeProtocolSocket().pipe(
            Effect.provideService(Socket.Socket, pair.client),
            Effect.provide(RpcSerialization.layerJson)
          )
          return yield* Effect.provideService(effect, RpcClient.Protocol, protocol)
        }).pipe(Effect.scoped)

      const cursors = yield* overSocket(
        Effect.provide(
          Effect.flatMap(SyncClient.SyncClient, (sync) => Effect.map(sync.progress, (progress) => progress.delivered)),
          SyncClient.layerWith({
            bootstrapLimit: 8
          })
        )
      )
      const refusal = yield* Effect.flip(
        overSocket(
          Effect.provide(SyncClient.SyncClient, SyncClient.layerWith({ maxFrameBytes: 0 }))
        )
      )

      expect(cursors).toEqual([])
      expect(refusal.code).toBe("invalid_request")
      expect(refusal.message).toContain("SyncClient.Options.maxFrameBytes")
    }))
})

describe("RunCatalog construction policy", () => {
  it.effect("refuses a memory or polling option that is not a positive safe integer", () =>
    Effect.gen(function*() {
      const capacity = yield* Effect.flip(RunCatalog.makeMemory({ changesCapacity: Number.NaN }))
      const interval = yield* Effect.flip(
        Effect.scoped(RunCatalog.makePolling({ intervalMs: 0, read: Effect.succeed([]) }))
      )
      const pollingCapacity = yield* Effect.flip(
        Effect.scoped(RunCatalog.makePolling({ changesCapacity: -1, read: Effect.succeed([]) }))
      )

      expect(capacity.message).toContain("RunCatalog.MemoryOptions.changesCapacity")
      expect(interval.message).toContain("RunCatalog.PollingOptions.intervalMs")
      expect(pollingCapacity.message).toContain("RunCatalog.PollingOptions.changesCapacity")
      for (const refusal of [capacity, interval, pollingCapacity]) expect(refusal.code).toBe("invalid_request")
    }))

  it.effect("provides the in-memory catalog as a layer", () =>
    Effect.gen(function*() {
      const listed = yield* Effect.provide(
        Effect.flatMap(RunCatalog.RunCatalog, (catalog) => catalog.list),
        RunCatalog.layerMemory()
      )

      expect(listed).toEqual([])
    }))

  it.effect("keeps registering runs available beside the layer", () =>
    Effect.gen(function*() {
      const memory = yield* RunCatalog.makeMemory()
      yield* memory.register(runId("registered"))

      expect(yield* memory.catalog.list).toEqual([runId("registered")])
    }))
})

describe("BranchPresence layer shape", () => {
  const build = <A, E>(layer: Layer.Layer<BranchPresence.BranchPresence, E, BranchShare.BranchShare>) =>
    Effect.flatMap(BranchPresence.BranchPresence, (presence) => Effect.succeed(presence.leaseMs)).pipe(
      Effect.provide(layer.pipe(Layer.provideMerge(shareLayer))),
      Effect.provide(TestClock.layer())
    )

  it.effect("carries the default lease as a layer value", () =>
    Effect.gen(function*() {
      expect(yield* build(BranchPresence.layer)).toBe(BranchPresence.defaultLeaseMs)
    }))

  it.effect("takes an explicit lease through layerWith", () =>
    Effect.gen(function*() {
      expect(yield* build(BranchPresence.layerWith({ leaseMs: 5_000 }))).toBe(5_000)
    }))

  it.effect("fails the layer, not the operation, on a bad lease", () =>
    Effect.gen(function*() {
      const refusal = yield* Effect.flip(build(BranchPresence.layerWith({ leaseMs: 0 })))

      expect(refusal.code).toBe("invalid_request")
      expect(refusal.message).toContain("BranchPresence.PresenceOptions.leaseMs")
    }))
})

describe("type-only request models", () => {
  // A `Schema.Struct` nothing decodes is a type with unused checks: the
  // presence schema marked `leaseMs` required while `makeMemory` defaulted it,
  // and neither authorization request was ever decoded. What survives as a
  // runtime schema is what a constructor actually runs.
  it.each([
    ["BranchPresence.PresenceOptions", BranchPresence as Record<string, unknown>, "PresenceOptions"],
    ["BranchShare.AuthorizeRequest", BranchShare as Record<string, unknown>, "AuthorizeRequest"],
    ["WorkspaceShare.AuthorizeRequest", WorkspaceShare as Record<string, unknown>, "AuthorizeRequest"]
  ])("%s is a type, not an undecoded schema", (_name, module, key) => {
    expect(module[key]).toBeUndefined()
  })

  it.each([
    ["BranchShare.MintRequest", BranchShare as Record<string, unknown>, "MintRequest"],
    ["WorkspaceShare.MintRequest", WorkspaceShare as Record<string, unknown>, "MintRequest"]
  ])("%s stays a schema because mint decodes it", (_name, module, key) => {
    expect(module[key]).toBeDefined()
  })
})

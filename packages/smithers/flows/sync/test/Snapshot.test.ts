import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Cause, Deferred, Effect, Fiber, Layer, Logger, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncAuth from "../src/SyncAuth.ts"
import * as SyncClient from "../src/SyncClient.ts"
import { SyncError } from "../src/SyncError.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as Protocol from "../src/SyncProtocol.ts"
import * as SyncServer from "../src/SyncServer.ts"
import * as TestSocket from "../src/test/TestSocket.ts"
import * as TestSync from "../src/test/TestSync.ts"
import * as WorkspaceShare from "../src/WorkspaceShare.ts"

const request: Protocol.SnapshotRequest = {
  protocolVersion: 1,
  runId: "snapshot-run" as JournalEvent.RunId,
  lineageId: "lineage-1",
  projection: "counter",
  projectionVersion: 1,
  atLeastSeq: 2 as JournalEvent.Seq
}
const snapshot: Protocol.Snapshot = {
  protocolVersion: 1,
  runId: request.runId,
  lineageId: request.lineageId,
  projection: request.projection,
  projectionVersion: 1,
  seq: 4 as JournalEvent.Seq,
  state: { count: 5 }
}
type Source = SyncServer.SnapshotSource["Service"]
const owner = SyncPrincipal.workspace("snapshot-tests")
const base = Layer.mergeAll(Journal.layerNoop(), RunCatalog.layerStatic([request.runId]))
const server = (read?: Source["read"], maxFrameBytes = 4096) =>
  SyncServer.makeLiveWith({ maxFrameBytes }).pipe(Effect.provide(
    read === undefined ? base : Layer.merge(base, Layer.succeed(SyncServer.SnapshotSource, { read }))
  ))
const asOwner = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(SyncPrincipal.SyncPrincipal, owner))
const client = (response: unknown, maxFrameBytes = 4096) =>
  SyncClient.makeWith({
    maxFrameBytes,
    client: { "Sync.Snapshot": () => Effect.succeed(response) } as unknown as Parameters<
      typeof SyncClient.make
    >[0]["client"]
  })

describe("public snapshot admission", () => {
  it.effect("requires authorization before looking up an optional provider", () =>
    Effect.gen(function*() {
      let calls = 0
      const service = yield* server(() =>
        Effect.sync(() => {
          calls++
          return snapshot
        })
      )
      expect(yield* Effect.flip(service.snapshot(request))).toMatchObject({ code: "unauthorized" })
      expect(calls).toBe(0)
      expect(yield* asOwner(service.snapshot(request))).toEqual(snapshot)
      expect(calls).toBe(1)
      expect(yield* asOwner(Effect.flatMap(server(), (service) => Effect.flip(service.snapshot(request)))))
        .toMatchObject({ code: "not_found" })
      expect(yield* Effect.flip(SyncServer.makeNoop().snapshot(request))).toMatchObject({ code: "not_found" })
      expect(yield* Effect.flip(SyncClient.makeNoop().snapshot(request))).toMatchObject({ code: "closed" })
    }))

  it.effect("refuses malformed requests on both sides before any callback", () =>
    Effect.gen(function*() {
      let calls = 0
      const service = yield* server(() =>
        Effect.sync(() => {
          calls++
          return snapshot
        })
      )
      const remote = yield* client(snapshot)
      for (
        const invalid of [
          { ...request, lineageId: "" },
          { ...request, lineageId: "a".repeat(513) },
          { ...request, projection: "x".repeat(129) },
          { ...request, projectionVersion: 0 },
          { ...request, atLeastSeq: -1 },
          { ...request, atLeastSeq: Number.NaN },
          { ...request, extra: "private" }
        ]
      ) {
        const input = invalid as Protocol.SnapshotRequest
        expect(yield* Effect.flip(asOwner(service.snapshot(input)))).toMatchObject({ code: "invalid_request" })
        expect(yield* Effect.flip(remote.snapshot(input))).toMatchObject({ code: "invalid_request" })
      }
      // A version this revision does not speak is a protocol refusal, not a
      // malformed request: it decodes so every path answers the one code.
      const mismatched = { ...request, protocolVersion: Protocol.protocolVersion + 1 }
      expect(yield* Effect.flip(asOwner(service.snapshot(mismatched)))).toMatchObject({
        code: "protocol_violation",
        cause: "protocol_version_mismatch"
      })
      expect(yield* Effect.flip(remote.snapshot(mismatched))).toMatchObject({ code: "protocol_violation" })
      expect(calls).toBe(0)
    }))

  it.effect("detaches the expected identity before a provider or transport can mutate its request", () =>
    Effect.gen(function*() {
      const service = yield* server((input) =>
        Effect.sync(() => {
          Object.assign(input, { lineageId: "forged" })
          return { ...snapshot, lineageId: "forged" }
        })
      )
      expect(yield* Effect.flip(asOwner(service.snapshot(request)))).toMatchObject({ code: "protocol_violation" })
      const remote = yield* SyncClient.make({
        client: {
          "Sync.Snapshot": (input: Protocol.SnapshotRequest) =>
            Effect.sync(() => {
              Object.assign(input, { lineageId: "forged" })
              return { ...snapshot, lineageId: "forged" }
            })
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })
      expect(yield* Effect.flip(remote.snapshot(request))).toMatchObject({ code: "protocol_violation" })
      expect(request.lineageId).toBe("lineage-1")
    }))

  it.effect("validates responses and exact identities on both sides without cursor advancement", () =>
    Effect.gen(function*() {
      const cyclic: Record<string, unknown> = {}
      cyclic["cycle"] = cyclic
      const cases: Array<[unknown, string]> = [
        [undefined, "decode_failed"],
        [cyclic, "decode_failed"],
        [{ ...snapshot, state: 1n }, "decode_failed"],
        [{ ...snapshot, state: { count: Number.NaN } }, "decode_failed"],
        [{ ...snapshot, state: { count: undefined } }, "decode_failed"],
        [{ ...snapshot, state: new Date() }, "decode_failed"],
        [{ ...snapshot, extra: "secret" }, "decode_failed"],
        [{ ...snapshot, protocolVersion: Protocol.protocolVersion + 1 }, "protocol_violation"],
        [{ ...snapshot, runId: "another-run" }, "protocol_violation"],
        [{ ...snapshot, lineageId: "another-lineage" }, "protocol_violation"],
        [{ ...snapshot, projection: "private" }, "protocol_violation"],
        [{ ...snapshot, projectionVersion: 2 }, "protocol_violation"],
        [{ ...snapshot, seq: 1 }, "compacted"]
      ]
      for (const [value, code] of cases) {
        const service = yield* server(() => Effect.succeed(value as Protocol.Snapshot))
        const remote = yield* client(value)
        expect(yield* Effect.flip(asOwner(service.snapshot(request)))).toMatchObject({ code })
        expect(yield* Effect.flip(remote.snapshot(request))).toMatchObject({ code })
        expect((yield* remote.progress).delivered).toEqual([])
      }
      const remote = yield* client(snapshot)
      expect(yield* remote.snapshot(request)).toEqual(snapshot)
      expect((yield* remote.progress).delivered).toEqual([])
      // A frame ceiling of `NaN` is the client's policy, so it is refused by
      // the constructor rather than by each snapshot taken under it.
      expect(yield* Effect.flip(client(snapshot, Number.NaN))).toMatchObject({ code: "invalid_request" })
    }))

  it.effect("enforces exact encoded UTF-8 snapshot size at N-1, N and N+1", () =>
    Effect.gen(function*() {
      const value = { ...snapshot, state: "é😀" }
      const size = new TextEncoder().encode(JSON.stringify(value)).length
      for (const limit of [size - 1, size, size + 1]) {
        const service = yield* server(() => Effect.succeed(value), limit)
        const remote = yield* client(value, limit)
        for (const read of [asOwner(service.snapshot(request)), remote.snapshot(request)]) {
          if (limit < size) expect(yield* Effect.flip(read)).toMatchObject({ code: "frame_too_large" })
          else expect(yield* read).toEqual(value)
        }
      }
    }))

  it.effect("logs provider causes without leaking failures or defects into remote error messages", () =>
    Effect.gen(function*() {
      const logs: Array<{ level: string; cause: Cause.Cause<unknown> }> = []
      const capture = Logger.make((options) => {
        logs.push({ level: options.logLevel, cause: options.cause })
      })
      for (
        const read of [
          () => Effect.fail(new SyncError({ code: "unknown", message: "provider-secret" })),
          () => Effect.die(new Error("provider-secret"))
        ]
      ) {
        const service = yield* server(read)
        const failure = yield* Effect.flip(asOwner(service.snapshot(request))).pipe(
          Effect.provide(Logger.layer([capture]))
        )
        expect(failure).toMatchObject({ code: "not_found", message: "Public snapshot is unavailable" })
        expect(JSON.stringify(failure)).not.toContain("provider-secret")
      }
      expect(logs.map((log) => log.level)).toEqual(["Warn", "Warn"])
      expect(logs[0]!.cause.reasons.map((reason) => reason._tag)).toEqual(["Fail"])
      expect(logs[1]!.cause.reasons.map((reason) => reason._tag)).toEqual(["Die"])
      for (const log of logs) expect(Cause.pretty(log.cause)).toContain("provider-secret")
    }))

  it.effect("retains interruption while a provider is active", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const service = yield* server(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
      const fiber = yield* asOwner(service.snapshot(request)).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      expect((yield* Fiber.await(fiber))._tag).toBe("Failure")
    }))

  it.effect("checks credential expiry before and after provider work", () =>
    Effect.gen(function*() {
      let calls = 0
      const service = yield* server(() =>
        Effect.gen(function*() {
          calls++
          yield* TestClock.adjust(10)
          return snapshot
        })
      )
      const expired = yield* Effect.flip(
        service.snapshot(request).pipe(
          Effect.provideService(SyncPrincipal.SyncPrincipal, SyncPrincipal.workspace("expired", 0))
        )
      )
      expect(expired).toMatchObject({ code: "unauthorized" })
      expect(calls).toBe(0)
      const during = yield* Effect.flip(
        service.snapshot(request).pipe(
          Effect.provideService(SyncPrincipal.SyncPrincipal, SyncPrincipal.workspace("expires", 5))
        )
      )
      expect(during).toMatchObject({ code: "unauthorized" })
      expect(calls).toBe(1)
    }))

  it.effect("does not convert a provider's interruption into a missing snapshot", () =>
    Effect.gen(function*() {
      const service = yield* server(() => Effect.interrupt)
      const result = yield* asOwner(service.snapshot(request)).pipe(Effect.uninterruptible, Effect.exit)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(Cause.hasInterruptsOnly(result.cause)).toBe(true)
    }))

  it.effect("requires the exact branch capability even from a workspace principal", () =>
    Effect.gen(function*() {
      const share = yield* BranchShare.BranchShare
      const branchId = "branch-snapshot" as BranchProtocol.BranchId
      const runId = BranchProtocol.branchRunId(branchId)
      const input = { ...request, runId }
      let calls = 0
      const service = yield* server(() =>
        Effect.sync(() => {
          calls++
          return { ...snapshot, runId }
        })
      )
      expect(yield* Effect.flip(asOwner(service.snapshot(input)))).toMatchObject({ code: "unauthorized" })
      const wrong = yield* share.mint({
        branchId: "other" as BranchProtocol.BranchId,
        access: "read",
        capabilityId: "wrong",
        ttlMs: 1000
      })
      expect(yield* Effect.flip(service.snapshot({ ...input, capability: wrong }))).toMatchObject({
        code: "unauthorized"
      })
      expect(calls).toBe(0)
      const capability = yield* share.mint({ branchId, access: "read", capabilityId: "right", ttlMs: 1000 })
      expect(yield* service.snapshot({ ...input, capability })).toEqual({ ...snapshot, runId })
      expect(calls).toBe(1)
    }).pipe(
      Effect.provide(
        BranchShare.layerHmac({
          activeKid: "primary",
          keys: [{ kid: "primary", secret: Redacted.make("snapshot-test-only-0123456789abc") }]
        })
      )
    ))

  it.live("authenticates snapshot headers through production JSON RPC before calling the provider", () => {
    let calls = 0
    const authority = WorkspaceShare.layerHmac({
      activeKid: "snapshot-key",
      keys: [{ kid: "snapshot-key", secret: Redacted.make("snapshot-auth-test-only-01234567") }]
    })
    const stack = Layer.mergeAll(SyncServer.layer, SyncAuth.layer).pipe(
      Layer.provideMerge(Layer.mergeAll(
        base,
        authority,
        Layer.succeed(SyncServer.SnapshotSource, {
          read: () =>
            Effect.sync(() => {
              calls++
              return snapshot
            })
        })
      ))
    )
    return Effect.gen(function*() {
      const pair = yield* TestSocket.makePair()
      const remote = yield* TestSync.connect(pair)
      const share = yield* WorkspaceShare.WorkspaceShare
      const capability = yield* share.mint({ capabilityId: "snapshot-reader", access: "read", ttlMs: 60_000 })
      const forged = new WorkspaceShare.WorkspaceCapability({
        claims: new WorkspaceShare.WorkspaceClaims({ ...capability.claims, capabilityId: "forged-reader" }),
        signature: capability.signature
      })
      const fetch = (header: string) =>
        RpcClient.withHeaders(remote.snapshot(request), {
          [SyncAuth.capabilityHeader]: header
        })
      expect(yield* Effect.flip(remote.snapshot(request))).toMatchObject({ code: "unauthorized" })
      expect(yield* Effect.flip(fetch(yield* SyncAuth.encodeCapability(forged)))).toMatchObject({
        code: "unauthorized"
      })
      expect(yield* Effect.flip(fetch("malformed-header"))).toMatchObject({ code: "unauthorized" })
      expect(calls).toBe(0)
      expect(yield* fetch(yield* SyncAuth.encodeCapability(capability))).toEqual(snapshot)
      expect(calls).toBe(1)
      expect((yield* remote.progress).delivered).toEqual([])
    }).pipe(Effect.provide(stack), Effect.scoped)
  })

  it.live("fetches a versioned public projection through the real JSON RPC without exposing private state", () =>
    Effect.gen(function*() {
      const pair = yield* TestSocket.makePair()
      const wire: Array<string> = []
      pair.faults.installFilter((bytes) => {
        wire.push(new TextDecoder().decode(bytes))
        return true
      })
      const remote = yield* TestSync.connect(pair)
      const result = yield* remote.snapshot(request)
      expect(Schema.is(Protocol.Snapshot)(result)).toBe(true)
      expect(result).toEqual(snapshot)
      expect((yield* remote.progress).delivered).toEqual([])
      expect(wire.join("\n")).toContain("counter")
      expect(wire.join("\n")).not.toContain("private-provider-state")
    }).pipe(
      Effect.provide(SyncServer.layer.pipe(Layer.provideMerge(Layer.mergeAll(
        base,
        TestSync.layerTrustAllAsOwner,
        Layer.succeed(SyncServer.SnapshotSource, {
          read: () => {
            const privateRecord = { public: snapshot, secret: "private-provider-state" }
            return Effect.succeed(privateRecord.public)
          }
        })
      )))),
      Effect.scoped
    ))
})

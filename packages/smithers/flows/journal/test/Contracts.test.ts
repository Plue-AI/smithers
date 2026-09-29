import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Schema, Stream } from "effect"
import * as Consensus from "../src/Consensus.ts"
import * as Journal from "../src/Journal.ts"
import type { Input, RunId, Seq } from "../src/JournalEvent.ts"
import * as OwnerId from "../src/OwnerId.ts"
import * as Projection from "../src/Projection.ts"

describe("service contracts", () => {
  it.effect("constructs and exercises the closed Journal service", () =>
    Effect.gen(function*() {
      const implementation = Journal.makeNoop()
      expect(Journal.make(implementation)).toBe(implementation)

      yield* (Effect.scoped(Effect.gen(function*() {
        const input = {} as Input
        const owner = { hostId: "test", pid: 1, nonce: "test" } as OwnerId.OwnerId
        expect((yield* Effect.flip(implementation.emitLossy(input))).code).toBe("journal_closed")
        expect((yield* Effect.flip(implementation.emitDurable(input, owner))).code).toBe("journal_closed")
        expect((yield* Effect.flip(implementation.emitDurableUnfenced(input))).code).toBe("journal_closed")
        expect(
          (yield* Effect.flip(implementation.entries({
            runId: "run" as RunId,
            limit: 1
          }))).code
        ).toBe("journal_closed")
        expect(
          (yield* Stream.runHead(implementation.stream({
            runId: "run" as RunId
          })).pipe(Effect.flip)).code
        ).toBe("journal_closed")
        expect(
          (yield* Stream.runHead(implementation.project(
            Projection.make({
              name: "noop",
              initial: 0,
              reduce: (state) => Effect.succeed(state)
            }),
            { runId: "run" as RunId }
          )).pipe(Effect.flip)).code
        ).toBe("journal_closed")
        expect((yield* Effect.flip(implementation.flush)).code).toBe("journal_closed")
        expect(
          (yield* Effect.flip(implementation.checkpoint({
            runId: "run" as RunId,
            seq: 0 as Seq,
            state: null
          }, owner))).code
        ).toBe("journal_closed")
        expect((yield* Effect.flip(implementation.latestCheckpoint("run" as RunId))).code).toBe("journal_closed")
        expect((yield* Effect.flip(implementation.compact({ runId: "run" as RunId }, owner))).code).toBe(
          "journal_closed"
        )
        yield* implementation.changes
      })))

      const overridden = yield* (
        Effect.gen(function*() {
          const service = yield* Journal.Journal
          yield* service.flush
          return service
        }).pipe(Effect.provide(Journal.layerNoop({ flush: Effect.void })))
      )
      expect(overridden.flush).toBe(Effect.void)
    }))

  it.effect("constructs and exercises the refusing Consensus stub", () =>
    Effect.gen(function*() {
      const implementation = Consensus.makeNoop()
      expect(Consensus.make(implementation)).toBe(implementation)
      const owner: OwnerId.OwnerId = { hostId: "test", pid: 1, nonce: "test" }
      const evidence: Consensus.LivenessEvidence = { expectedOwner: owner, checkedAtMs: 0, kind: "lease-expired" }
      expect(yield* implementation.claim("run", owner, 0)).toEqual({ _tag: "Rejected", reason: "unavailable" })
      expect(yield* implementation.activate("run", owner, 0, 0)).toEqual({ _tag: "Lost" })
      expect(yield* implementation.heartbeat("run", owner, 0)).toEqual({ _tag: "Lost" })
      yield* implementation.release("run", owner)
      expect(yield* implementation.steal("run", owner, 0, evidence)).toEqual({ _tag: "Rejected", reason: "unavailable" })
      expect(yield* implementation.recover("run", owner, 0, owner, 0, evidence)).toEqual({
        _tag: "Rejected",
        reason: "unavailable"
      })
      const guard = yield* Effect.flip(implementation.guard("run", owner))
      expect(guard.code).toBe("fence_lost")
      expect(guard.message).toBe("run run is no longer owned by test:1:test")

      const overridden = yield* Effect.gen(function*() {
        const service = yield* Consensus.Consensus
        return yield* service.claim("run", owner, 7)
      }).pipe(Effect.provide(Consensus.layerNoop({ claim: () => Effect.succeed({ _tag: "Claimed", grantedAtMs: 7 }) })))
      expect(overridden).toEqual({ _tag: "Claimed", grantedAtMs: 7 })
    }))

  it("relates the lease constants structurally", () => {
    expect(Consensus.heartbeatWriteTolerance).toEqual(
      Duration.millis(
        Duration.toMillis(Consensus.heartbeatStaleAfter) -
          Duration.toMillis(Consensus.heartbeatSkewAllowance) -
          Duration.toMillis(Consensus.heartbeatInterval)
      )
    )
    expect(Schema.decodeUnknownSync(Consensus.LivenessEvidence)({
      expectedOwner: { hostId: "host", pid: 1, nonce: "nonce" },
      checkedAtMs: 0,
      kind: "lease-expired"
    }).kind).toBe("lease-expired")
  })

  it("decodes the fencing token the durable channel accepts", () => {
    const owner: OwnerId.OwnerId = { hostId: "host", pid: 1, nonce: "nonce" }
    expect(Schema.decodeUnknownSync(OwnerId.OwnerId)(owner)).toEqual(owner)
    expect(() => Schema.decodeUnknownSync(OwnerId.OwnerId)({ ...owner, pid: "1" })).toThrow()
  })
})

/**
 * Retention bounds on the two in-process change feeds.
 *
 * `RunCatalog.changes` and `BranchPresence.changes` are notification streams,
 * not logs: a follower reads them to learn that something moved and then reads
 * the authoritative state. Both were built on `PubSub.unbounded`, so a
 * subscriber that stops pulling — a disconnected browser tab whose socket has
 * not timed out, a follower blocked on a slow consumer — made the process
 * retain every announcement made since it stalled, without bound. These cases
 * pin the sliding bound: the stalled subscriber loses the oldest
 * announcements instead, and the publisher never grows on its behalf.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import type { JournalEvent } from "@smthrs/journal"
import { Deferred, Effect, Fiber, Redacted, Stream } from "effect"
import * as BranchPresence from "../src/BranchPresence.ts"
import type { BranchId, ParticipantId, ShareCapability } from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as RunCatalog from "../src/RunCatalog.ts"

const runId = (value: number) => `run-${value}` as JournalEvent.RunId

const capacity = 4
const overflow = 12

describe("bounded change feeds", () => {
  it.effect("slides a stalled run-catalog subscriber past the announcements it missed", () =>
    Effect.gen(function*() {
      const memory = yield* RunCatalog.makeMemory({ changesCapacity: capacity })
      const attached = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      // The subscriber accepts the first announcement, then stalls inside the
      // tap. Everything published while it is stalled has to fit the bound.
      const follower = yield* Stream.runCollect(
        Stream.take(
          memory.catalog.changes.pipe(
            Stream.onStart(Deferred.succeed(attached, undefined)),
            Stream.tap((id) => id === runId(0) ? Deferred.await(release) : Effect.void)
          ),
          1 + capacity
        )
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(attached)
      for (let index = 0; index < overflow; index++) {
        // A register never waits on a stalled follower: the bound is enforced
        // by dropping, not by blocking the publisher.
        yield* memory.register(runId(index))
      }
      yield* Deferred.succeed(release, undefined)
      const seen = Array.from(yield* Fiber.join(follower))

      expect(seen[0]).toBe(runId(0))
      // The tail survives; the announcements between the stall and the last
      // `capacity` are dropped rather than retained.
      expect(seen.slice(1)).toEqual(
        Array.from({ length: capacity }, (_, index) => runId(overflow - capacity + index))
      )
      expect(yield* memory.catalog.list).toHaveLength(overflow)
    }))

  it.effect("slides a stalled presence subscriber past the roster changes it missed", () =>
    Effect.gen(function*() {
      const branchId = (value: number) => `branch-${value}` as BranchId
      const presence = yield* BranchPresence.makeMemory({ leaseMs: 60_000, changesCapacity: capacity })
      const share = yield* BranchShare.BranchShare
      const attached = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      // Each announcement names a different branch, so the stalled follower's
      // view says exactly which changes reached it and which were dropped.
      const follower = yield* Stream.runCollect(
        Stream.take(
          presence.changes.pipe(
            Stream.onStart(Deferred.succeed(attached, undefined)),
            Stream.tap((id) => id === branchId(0) ? Deferred.await(release) : Effect.void)
          ),
          1 + capacity
        )
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(attached)
      const capabilities: Array<ShareCapability> = []
      for (let index = 0; index < overflow; index++) {
        const capability = yield* share.mint({
          branchId: branchId(index),
          capabilityId: `bounded-presence-${index}`,
          access: "write",
          ttlMs: 60_000
        })
        capabilities.push(capability)
        // An announce never waits on a stalled follower either.
        yield* presence.announce({
          capability,
          branchId: branchId(index),
          participantId: `participant-${index}` as ParticipantId,
          displayName: `Participant ${index}`,
          cursor: null
        })
      }
      yield* Deferred.succeed(release, undefined)
      const seen = Array.from(yield* Fiber.join(follower))

      expect(seen[0]).toBe(branchId(0))
      expect(seen.slice(1)).toEqual(
        Array.from({ length: capacity }, (_, index) => branchId(overflow - capacity + index))
      )
      // Dropping a notification never drops the roster it announced.
      const last = capabilities[overflow - 1]!
      expect(yield* presence.list({ capability: last, branchId: branchId(overflow - 1) })).toHaveLength(1)
    }).pipe(
      Effect.provide(
        BranchShare.layerHmac({
          activeKid: "primary",
          keys: [{ kid: "primary", secret: Redacted.make("bounded-presence-secret-01234567") }]
        })
      )
    ))
})

import { describe, expect, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Fiber, Layer, Redacted, Stream } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vitest"
import * as BranchPresence from "../src/BranchPresence.ts"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import { SyncError } from "../src/SyncError.ts"

const branchId = "live-branch" as BranchProtocol.BranchId
const otherBranchId = "other-branch" as BranchProtocol.BranchId
const participant = (id: string) => id as BranchProtocol.ParticipantId

const leaseMs = 30_000

const layer = BranchPresence.layerWith({ leaseMs }).pipe(
  Layer.provideMerge(
    BranchShare.layerHmac({
      activeKid: "primary",
      keys: [{ kid: "primary", secret: Redacted.make("presence-secret-0123456789abcdef") }]
    })
  )
)

const run = <A, E>(effect: Effect.Effect<A, E, BranchPresence.BranchPresence | BranchShare.BranchShare>) =>
  effect.pipe(Effect.provide(layer), Effect.provide(TestClock.layer()))

const capabilityFor = (target: BranchProtocol.BranchId, access: BranchProtocol.Access) =>
  Effect.flatMap(
    BranchShare.BranchShare,
    (share) => share.mint({ branchId: target, capabilityId: `cap-${target}`, access, ttlMs: 600_000 })
  )

describe("BranchPresence", () => {
  it.effect("keeps a roster scoped to one branch, sorted, and out of the journal", () =>
    Effect.gen(function*() {
      const [here, there] = yield* run(
        Effect.gen(function*() {
          const presence = yield* BranchPresence.BranchPresence
          const capability = yield* capabilityFor(branchId, "write")
          const otherCapability = yield* capabilityFor(otherBranchId, "write")
          for (const id of ["carol", "alice", "bob"]) {
            yield* presence.announce({
              capability,
              branchId,
              participantId: participant(id),
              displayName: id,
              cursor: null
            })
          }
          yield* presence.announce({
            capability: otherCapability,
            branchId: otherBranchId,
            participantId: participant("mallory"),
            displayName: "mallory",
            cursor: null
          })
          return [
            yield* presence.list({ capability, branchId }),
            yield* presence.list({ capability: otherCapability, branchId: otherBranchId })
          ] as const
        })
      )

      expect(here.map((entry) => entry.participantId)).toEqual(["alice", "bob", "carol"])
      expect(there.map((entry) => entry.participantId)).toEqual(["mallory"])
    }))

  it.effect("carries a cursor and re-announcing renews the lease in place", () =>
    Effect.gen(function*() {
      const [first, renewed] = yield* run(
        Effect.gen(function*() {
          const presence = yield* BranchPresence.BranchPresence
          const capability = yield* capabilityFor(branchId, "write")
          const announcement = {
            capability,
            branchId,
            participantId: participant("alice"),
            displayName: "Alice",
            cursor: new BranchProtocol.Cursor({ cardId: "card-1", offset: 4 })
          }
          const initial = yield* presence.announce(announcement)
          yield* TestClock.adjust(Duration.seconds(10))
          const again = yield* presence.announce(announcement)
          const roster = yield* presence.list({ capability, branchId })
          expect(roster).toHaveLength(1)
          return [initial, again] as const
        })
      )

      expect(first.cursor?.cardId).toBe("card-1")
      expect(first.cursor?.offset).toBe(4)
      expect(renewed.leaseExpiresAtMs).toBe(first.leaseExpiresAtMs + 10_000)
    }))

  it.effect("expires a lease without any disconnect notice, on every branch", () =>
    Effect.gen(function*() {
      const [beforeExpiry, afterExpiry, otherAfterExpiry] = yield* run(
        Effect.gen(function*() {
          const presence = yield* BranchPresence.BranchPresence
          const capability = yield* capabilityFor(branchId, "write")
          const otherCapability = yield* capabilityFor(otherBranchId, "write")
          yield* presence.announce({
            capability,
            branchId,
            participantId: participant("alice"),
            displayName: "Alice",
            cursor: null
          })
          yield* presence.announce({
            capability: otherCapability,
            branchId: otherBranchId,
            participantId: participant("mallory"),
            displayName: "Mallory",
            cursor: null
          })
          yield* TestClock.adjust(Duration.millis(leaseMs - 1))
          const live = yield* presence.list({ capability, branchId })
          yield* TestClock.adjust(Duration.millis(1))
          return [
            live,
            yield* presence.list({ capability, branchId }),
            yield* presence.list({ capability: otherCapability, branchId: otherBranchId })
          ] as const
        })
      )

      expect(beforeExpiry).toHaveLength(1)
      expect(afterExpiry).toEqual([])
      expect(otherAfterExpiry).toEqual([])
    }))

  it.effect("sweeps an abandoned branch when only another branch is listed", () =>
    run(Effect.gen(function*() {
      const presence = yield* BranchPresence.BranchPresence
      const capability = yield* capabilityFor(branchId, "write")
      const otherCapability = yield* capabilityFor(otherBranchId, "write")
      for (const [target, token] of [[branchId, capability], [otherBranchId, otherCapability]] as const) {
        yield* presence.announce({
          capability: token,
          branchId: target,
          participantId: participant("abandoned"),
          displayName: "Abandoned",
          cursor: null
        })
      }
      yield* TestClock.adjust(Duration.millis(leaseMs))
      // Observe storage removal directly, without listing the abandoned branch
      // (which would hide the leak) or relying on nondeterministic collection.
      const deleted = vi.spyOn(Map.prototype, "delete")
      try {
        expect(yield* presence.list({ capability, branchId })).toEqual([])
        expect(deleted).toHaveBeenCalledWith(otherBranchId)
        const index = deleted.mock.calls.findIndex(([key]) => key === otherBranchId)
        const roster = deleted.mock.contexts[index] as Map<BranchProtocol.BranchId, unknown>
        expect(roster.has(otherBranchId)).toBe(false)
      } finally {
        deleted.mockRestore()
      }
    })))

  it.effect("makes bounded sweep progress across abandoned branches on announcements", () =>
    run(Effect.gen(function*() {
      const presence = yield* BranchPresence.BranchPresence
      const capability = yield* capabilityFor(branchId, "write")
      const abandoned = Array.from({ length: 40 }, (_, index) => `abandoned-${index}` as BranchProtocol.BranchId)
      for (const target of abandoned) {
        yield* presence.announce({
          capability: yield* capabilityFor(target, "write"),
          branchId: target,
          participantId: participant("abandoned"),
          displayName: "Abandoned",
          cursor: null
        })
      }
      yield* TestClock.adjust(Duration.millis(leaseMs))
      const deleted = vi.spyOn(Map.prototype, "delete")
      try {
        for (let index = 0; index < 4; index++) {
          yield* presence.announce({
            capability,
            branchId,
            participantId: participant("active"),
            displayName: "Active",
            cursor: null
          })
        }
        for (const target of abandoned) expect(deleted).toHaveBeenCalledWith(target)
        expect(yield* presence.list({ capability, branchId })).toHaveLength(1)
      } finally {
        deleted.mockRestore()
      }
    })))

  for (const result of ["list", "announce"] as const) {
    it.effect(`detaches participant and cursor values returned by ${result}`, () =>
      run(Effect.gen(function*() {
        const presence = yield* BranchPresence.BranchPresence
        const writer = yield* capabilityFor(branchId, "write")
        const reader = yield* capabilityFor(branchId, "read")
        const announcement = {
          capability: writer,
          branchId,
          participantId: participant("alice"),
          displayName: "Alice",
          cursor: new BranchProtocol.Cursor({ cardId: "card-1", offset: 4 })
        }
        const announced = yield* presence.announce(announcement)
        const exposed = result === "announce"
          ? announced
          : (yield* presence.list({ capability: reader, branchId }))[0]!
        Object.assign(exposed, { displayName: "Changed by caller", leaseExpiresAtMs: 0 })
        Object.assign(exposed.cursor!, { cardId: "changed", offset: 99 })
        const roster = yield* presence.list({ capability: reader, branchId })
        expect(roster).toHaveLength(1)
        expect(roster[0]?.displayName).toBe("Alice")
        expect(roster[0]?.cursor).toEqual(announcement.cursor)
        expect(roster[0]?.leaseExpiresAtMs).toBe(leaseMs)
      })))
  }

  it.effect("drops a participant on an explicit leave and publishes the change", () =>
    Effect.gen(function*() {
      const [changes, roster] = yield* run(
        Effect.gen(function*() {
          const presence = yield* BranchPresence.BranchPresence
          const capability = yield* capabilityFor(branchId, "write")
          const collected = yield* Stream.runCollect(Stream.take(presence.changes, 2)).pipe(
            Effect.forkChild({ startImmediately: true })
          )
          yield* Effect.yieldNow
          yield* presence.announce({
            capability,
            branchId,
            participantId: participant("alice"),
            displayName: "Alice",
            cursor: null
          })
          yield* presence.leave({ capability, branchId, participantId: participant("alice") })
          return [
            Array.from(yield* Fiber.join(collected)),
            yield* presence.list({ capability, branchId })
          ] as const
        })
      )

      expect(changes).toEqual([branchId, branchId])
      expect(roster).toEqual([])
    }))

  it.effect("refuses cross-branch and read-only writes to a roster", () =>
    Effect.gen(function*() {
      const failures = yield* run(
        Effect.gen(function*() {
          const presence = yield* BranchPresence.BranchPresence
          const foreign = yield* capabilityFor(otherBranchId, "write")
          const readOnly = yield* capabilityFor(branchId, "read")
          return [
            yield* Effect.flip(
              presence.announce({
                capability: foreign,
                branchId,
                participantId: participant("mallory"),
                displayName: "Mallory",
                cursor: null
              })
            ),
            yield* Effect.flip(
              presence.leave({ capability: foreign, branchId, participantId: participant("alice") })
            ),
            yield* Effect.flip(presence.list({ capability: foreign, branchId })),
            yield* Effect.flip(
              presence.announce({
                capability: readOnly,
                branchId,
                participantId: participant("watcher"),
                displayName: "Watcher",
                cursor: null
              })
            )
          ] as const
        })
      )

      expect(failures.map((failure) => failure.code)).toEqual([
        "unauthorized",
        "unauthorized",
        "unauthorized",
        "unauthorized"
      ])
      expect(failures[3]?.message).toBe("The share capability is read-only")
    }))

  it.effect("lets a read-only capability watch the roster it may not join", () =>
    Effect.gen(function*() {
      const roster = yield* run(
        Effect.gen(function*() {
          const presence = yield* BranchPresence.BranchPresence
          const writer = yield* capabilityFor(branchId, "write")
          const reader = yield* Effect.flatMap(
            BranchShare.BranchShare,
            (share) => share.mint({ branchId, capabilityId: "cap-read", access: "read", ttlMs: 600_000 })
          )
          yield* presence.announce({
            capability: writer,
            branchId,
            participantId: participant("alice"),
            displayName: "Alice",
            cursor: null
          })
          return yield* presence.list({ capability: reader, branchId })
        })
      )

      expect(roster.map((entry) => entry.displayName)).toEqual(["Alice"])
    }))

  it.effect("refuses unavailable operations through the noop layer, and honours overrides", () =>
    Effect.gen(function*() {
      const noop = BranchPresence.makeNoop()
      const capability = new BranchProtocol.ShareCapability({
        claims: new BranchProtocol.ShareClaims({
          kid: "primary",
          branchId,
          capabilityId: "cap",
          access: "write",
          issuedAtMs: 0,
          expiresAtMs: 1
        }),
        signature: ""
      })
      const announcement = {
        capability,
        branchId,
        participantId: participant("alice"),
        displayName: "Alice",
        cursor: null
      }

      expect((yield* (Effect.flip(noop.announce(announcement)))).code).toBe("unsupported")
      expect(
        (yield* (Effect.flip(noop.leave({ capability, branchId, participantId: participant("a") }))))
          .code
      ).toBe("unsupported")
      expect((yield* Effect.flip(noop.list({ capability, branchId }))).code).toBe("unsupported")
      expect(yield* noop.presenceOn({ capability, branchId })).toBe("unknown")
      expect(Array.from(yield* (Stream.runCollect(noop.changes)))).toEqual([])
      expect(
        yield* (
          Effect.flatMap(BranchPresence.BranchPresence, (service) => service.presenceOn({ capability, branchId })).pipe(
            Effect.provide(BranchPresence.layerNoop)
          )
        )
      ).toEqual("unknown")
      expect(
        (yield* (
          Effect.flip(
            BranchPresence.makeNoop({
              list: () => Effect.fail(new SyncError({ code: "unauthorized", message: "overridden" }))
            }).list({ capability, branchId })
          )
        )).message
      ).toBe("overridden")
    }))
})

describe("BranchPresence participant ownership", () => {
  const mintAs = (capabilityId: string) =>
    Effect.flatMap(
      BranchShare.BranchShare,
      (share) => share.mint({ branchId, capabilityId, access: "write", ttlMs: 600_000 })
    )

  it.effect("refuses another write capability's announce or leave for a live participant", () =>
    Effect.gen(function*() {
      const [spoof, evict, roster, reclaimed] = yield* run(
        Effect.gen(function*() {
          const presence = yield* BranchPresence.BranchPresence
          const alice = yield* mintAs("cap-alice")
          const mallory = yield* mintAs("cap-mallory")
          yield* presence.announce({
            capability: alice,
            branchId,
            participantId: participant("alice"),
            displayName: "Alice",
            cursor: null
          })
          const spoof = yield* Effect.flip(presence.announce({
            capability: mallory,
            branchId,
            participantId: participant("alice"),
            displayName: "Mallory",
            cursor: null
          }))
          const evict = yield* Effect.flip(
            presence.leave({ capability: mallory, branchId, participantId: participant("alice") })
          )
          const roster = yield* presence.list({ capability: alice, branchId })
          // Once the owner's lease lapses the id is free for anyone again.
          yield* TestClock.adjust(Duration.millis(leaseMs))
          const reclaimed = yield* presence.announce({
            capability: mallory,
            branchId,
            participantId: participant("alice"),
            displayName: "Mallory",
            cursor: null
          })
          return [spoof, evict, roster, reclaimed] as const
        })
      )

      for (const refusal of [spoof, evict]) {
        expect(refusal.code).toBe("unauthorized")
        expect(refusal.message).toBe("Participant alice is held by another share capability")
      }
      expect(roster.map((entry) => entry.displayName)).toEqual(["Alice"])
      expect(reclaimed.displayName).toBe("Mallory")
    }))

  it.effect("lets the owning capability renew and leave its own participant", () =>
    Effect.gen(function*() {
      const roster = yield* run(
        Effect.gen(function*() {
          const presence = yield* BranchPresence.BranchPresence
          const alice = yield* mintAs("cap-alice")
          const announcement = {
            capability: alice,
            branchId,
            participantId: participant("alice"),
            displayName: "Alice",
            cursor: null
          }
          yield* presence.announce(announcement)
          yield* presence.announce({ ...announcement, displayName: "Alice B." })
          yield* presence.leave({ capability: alice, branchId, participantId: participant("alice") })
          return yield* presence.list({ capability: alice, branchId })
        })
      )
      expect(roster).toEqual([])
    }))
})

describe("BranchPresence request detachment", () => {
  /**
   * A share whose `verify` parks after the signature check until released, so
   * a test can mutate the caller's request object while the operation awaits.
   */
  const pausedShare = Effect.gen(function*() {
    const share = yield* BranchShare.makeHmac({
      activeKid: "primary",
      keys: [{ kid: "primary", secret: Redacted.make("presence-secret-0123456789abcdef") }]
    })
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let pause = false
    const paused: BranchShare.Service = {
      ...share,
      verify: (capability, requirement) =>
        share.verify(capability, requirement).pipe(
          Effect.tap(() =>
            pause
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void
          )
        )
    }
    return { share: paused, entered, release, start: () => (pause = true) }
  })

  const arm = Effect.gen(function*() {
    const { entered, release, share, start } = yield* pausedShare
    const presence = yield* BranchPresence.makeMemory({ leaseMs }).pipe(
      Effect.provideService(BranchShare.BranchShare, share)
    )
    const allowed = yield* share.mint({ branchId, capabilityId: "cap-allowed", access: "write", ttlMs: 600_000 })
    const forbidden = yield* share.mint({
      branchId: otherBranchId,
      capabilityId: "cap-forbidden",
      access: "write",
      ttlMs: 600_000
    })
    yield* presence.announce({
      capability: forbidden,
      branchId: otherBranchId,
      participantId: participant("victim"),
      displayName: "Private participant",
      cursor: null
    })
    start()
    return { presence, allowed, entered, release }
  })

  it.effect("list reads the branch it authorized, not the one written during verification", () =>
    Effect.gen(function*() {
      const { allowed, entered, presence, release } = yield* arm
      const request = { capability: allowed, branchId }
      const read = yield* presence.list(request).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      request.branchId = otherBranchId
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(read)).toEqual([])
    }))

  it.effect("announce joins the branch it authorized, not the one written during verification", () =>
    Effect.gen(function*() {
      const { allowed, entered, presence, release } = yield* arm
      const request = {
        capability: allowed,
        branchId,
        participantId: participant("intruder"),
        displayName: "Intruder",
        cursor: { cardId: "card-1", offset: 0 }
      }
      const join = yield* presence.announce(request).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      request.branchId = otherBranchId
      request.participantId = participant("victim")
      request.cursor.cardId = "card-2"
      yield* Deferred.succeed(release, undefined)
      const joined = yield* Fiber.join(join)
      expect(joined.branchId).toBe(branchId)
      expect(joined.participantId).toBe("intruder")
      expect(joined.cursor?.cardId).toBe("card-1")
      const readOnly = yield* BranchShare.makeHmac({
        activeKid: "primary",
        keys: [{ kid: "primary", secret: Redacted.make("presence-secret-0123456789abcdef") }]
      })
      const capability = yield* readOnly.mint({
        branchId: otherBranchId,
        capabilityId: "cap-read",
        access: "read",
        ttlMs: 600_000
      })
      const forbidden = yield* presence.list({ capability, branchId: otherBranchId })
      expect(forbidden.map((entry) => entry.displayName)).toEqual(["Private participant"])
    }))

  it.effect("leave drops from the branch it authorized, not the one written during verification", () =>
    Effect.gen(function*() {
      const { allowed, entered, presence, release } = yield* arm
      const request = { capability: allowed, branchId, participantId: participant("nobody") }
      const gone = yield* presence.leave(request).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      request.branchId = otherBranchId
      request.participantId = participant("victim")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(gone)
      const readOnly = yield* BranchShare.makeHmac({
        activeKid: "primary",
        keys: [{ kid: "primary", secret: Redacted.make("presence-secret-0123456789abcdef") }]
      })
      const capability = yield* readOnly.mint({
        branchId: otherBranchId,
        capabilityId: "cap-read",
        access: "read",
        ttlMs: 600_000
      })
      expect((yield* presence.list({ capability, branchId: otherBranchId })).map((entry) => entry.participantId))
        .toEqual(["victim"])
    }))
})

describe("PresenceOn host readiness", () => {
  it.effect("waits a full configured lease for participants to re-announce after restart", () =>
    run(Effect.gen(function*() {
      const presence = yield* BranchPresence.makeMemory({ leaseMs: 60_000, sourcesReady: () => Effect.succeed(true) })
      const capability = yield* capabilityFor(branchId, "write")
      const request = { capability, branchId }
      yield* TestClock.adjust(30_000)
      expect(yield* presence.presenceOn(request)).toBe("unknown")
      yield* TestClock.adjust(29_999)
      expect(yield* presence.presenceOn(request)).toBe("unknown")
      yield* presence.announce({ ...request, participantId: participant("alice"), displayName: "Alice", cursor: null })
      yield* TestClock.adjust(1)
      expect(yield* presence.presenceOn(request)).toBe("present")
      const otherCapability = yield* capabilityFor(otherBranchId, "read")
      expect(yield* presence.presenceOn({ capability: otherCapability, branchId: otherBranchId })).toBe("empty")
      yield* TestClock.adjust(59_999)
      expect(yield* presence.presenceOn(request)).toBe("empty")
    })))

  it.effect("stays unknown through startup and source loss, then distinguishes live and expired leases", () =>
    run(Effect.gen(function*() {
      let ready = true
      const presence = yield* BranchPresence.makeMemory({ sourcesReady: () => Effect.sync(() => ready) })
      const capability = yield* capabilityFor(branchId, "write")
      const request = { capability, branchId }
      expect(yield* presence.presenceOn(request)).toBe("unknown")
      yield* TestClock.adjust(29_900)
      expect(yield* presence.presenceOn(request)).toBe("unknown")
      yield* TestClock.adjust(100)
      expect(yield* presence.presenceOn(request)).toBe("empty")
      yield* presence.announce({ ...request, participantId: participant("alice"), displayName: "Alice", cursor: null })
      expect(yield* presence.presenceOn(request)).toBe("present")
      ready = false
      expect(yield* presence.presenceOn(request)).toBe("unknown")
      ready = true
      yield* TestClock.adjust(29_900)
      expect(yield* presence.presenceOn(request)).toBe("present")
      yield* TestClock.adjust(100)
      expect(yield* presence.presenceOn(request)).toBe("empty")
      const unavailable = yield* BranchPresence.makeMemory()
      yield* TestClock.adjust(30_000)
      expect(yield* unavailable.presenceOn(request)).toBe("unknown")
      const foreign = yield* capabilityFor(otherBranchId, "write")
      expect((yield* Effect.flip(presence.presenceOn({ capability: foreign, branchId }))).code).toBe("unauthorized")
    })))
})

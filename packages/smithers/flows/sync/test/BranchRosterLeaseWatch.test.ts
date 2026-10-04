import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Redacted, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as BranchCommands from "../src/BranchCommands.ts"
import * as BranchIds from "../src/BranchIds.ts"
import * as BranchPresence from "../src/BranchPresence.ts"
import { type BranchId, Participant, type ParticipantId } from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import { SyncAuth } from "../src/SyncRpcs.ts"
import * as TestSocket from "../src/test/TestSocket.ts"
import { connect, type Requirements } from "./fixtures/branchRpc.ts"

const base = Layer.mergeAll(
  BranchShare.layerHmac({
    activeKid: "primary",
    keys: [{ kid: "primary", secret: Redacted.make("roster-watch-secret-0123456789ab") }]
  }),
  BranchCommands.layerNoop,
  BranchPresence.layerNoop,
  BranchIds.layerSequential("roster"),
  Layer.succeed(SyncAuth)((effect) =>
    Effect.provideService(effect, SyncPrincipal.SyncPrincipal, SyncPrincipal.workspace("roster-test"))
  )
)

const program = <A, E>(effect: Effect.Effect<A, E, Requirements>) =>
  effect.pipe(Effect.provide(base), Effect.provide(TestClock.layer()), Effect.scoped)

const leaseMs = 1_000
const alice = "alice" as ParticipantId
const bob = "bob" as ParticipantId

describe("Branch.WatchRoster lease propagation", () => {
  it.effect("emits one removal when a lease expires while a survivor heartbeats", () =>
    Effect.gen(function*() {
      const rosters = yield* program(
        Effect.gen(function*() {
          const presence = yield* BranchPresence.makeMemory({ leaseMs })
          const pair = yield* TestSocket.makePair()
          const client = yield* connect(pair, { presence })
          const share = yield* BranchShare.BranchShare
          const branchId = "lease-watch" as BranchId
          const capability = yield* share.mint({
            branchId,
            capabilityId: "lease-watch-capability",
            access: "write",
            ttlMs: 60_000
          })
          const announce = (participantId: ParticipantId, displayName: string) =>
            client["Branch.Announce"]({ capability, branchId, participantId, displayName, cursor: null })
          yield* announce(alice, "Alice")
          yield* announce(bob, "Bob")

          const initial = yield* Deferred.make<void>()
          const removed = yield* Deferred.make<void>()
          let emissions = 0
          const watched = yield* Stream.runCollect(
            Stream.take(
              client["Branch.WatchRoster"]({ capability, branchId }).pipe(
                Stream.tap(() => {
                  emissions += 1
                  return emissions === 1
                    ? Deferred.succeed(initial, undefined)
                    : emissions === 2
                    ? Deferred.succeed(removed, undefined)
                    : Effect.void
                })
              ),
              3
            )
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(initial)
          yield* TestClock.adjust(leaseMs)
          yield* announce(bob, "Bob")
          yield* Deferred.await(removed)
          yield* announce(bob, "Bob")
          return Array.from(
            yield* Fiber.join(watched),
            (frame) => frame.participants.map((participant) => participant.participantId)
          )
        })
      )

      // The lease tick fires at `leaseMs`, when BOTH announcements have run
      // out, so the watch sees the empty roster before bob heartbeats back on.
      // The third emission is suppressed: the watch emits when the roster
      // changes, and a re-announcement that reproduces the same roster is not
      // a change.
      expect(rosters).toEqual([[alice, bob], [], [bob]])
      const removals = rosters.slice(1).filter((roster, index) =>
        rosters[index]?.includes(alice) === true && !roster.includes(alice)
      )
      expect(removals).toHaveLength(1)
    }))

  // Expiry used to be observable only as a side effect of somebody else
  // announcing, so a watcher of a branch whose LAST participant vanished kept
  // that participant on its roster forever. The watch re-lists on the lease
  // cadence, which bounds how long a lapsed lease can stay visible.
  it.effect("observes the last participant expiring with no survivor to report it", () =>
    Effect.gen(function*() {
      const rosters = yield* program(
        Effect.gen(function*() {
          const presence = yield* BranchPresence.makeMemory({ leaseMs: 30_000 })
          const pair = yield* TestSocket.makePair()
          const client = yield* connect(pair, { presence })
          const share = yield* BranchShare.BranchShare
          const branchId = "last-participant" as BranchId
          const capability = yield* share.mint({
            branchId,
            capabilityId: "last-participant-capability",
            access: "write",
            ttlMs: 600_000
          })
          yield* client["Branch.Announce"]({
            capability,
            branchId,
            participantId: alice,
            displayName: "Alice",
            cursor: null
          })

          // Offset subscription from announcement: a lease-length poll would miss expiry for almost another lease.
          yield* TestClock.adjust(900)
          const initial = yield* Deferred.make<void>()
          let emissions = 0
          const watched = yield* Stream.runCollect(
            Stream.take(
              client["Branch.WatchRoster"]({ capability, branchId }).pipe(
                Stream.tap(() => {
                  emissions += 1
                  return emissions === 1 ? Deferred.succeed(initial, undefined) : Effect.void
                })
              ),
              2
            )
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(initial)
          // Nobody announces, nobody leaves: the lease simply runs out.
          yield* TestClock.adjust(29_000)
          expect(emissions).toBe(1)
          yield* TestClock.adjust(1_000)
          return Array.from(
            yield* Fiber.join(watched),
            (frame) => frame.participants.map((participant) => participant.participantId)
          )
        })
      )

      expect(rosters).toEqual([[alice], []])
    }))

  it.effect("does not lose a roster change between the initial list and change subscription", () =>
    Effect.gen(function*() {
      const rosters = yield* program(
        Effect.gen(function*() {
          const memory = yield* BranchPresence.makeMemory({ leaseMs })
          const initialListed = yield* Deferred.make<void>()
          const releaseInitial = yield* Deferred.make<void>()
          let lists = 0
          const controlled = BranchPresence.BranchPresence.of({
            ...memory,
            list: (request) =>
              Effect.gen(function*() {
                const roster = yield* memory.list(request)
                lists += 1
                if (lists === 1) {
                  yield* Deferred.succeed(initialListed, undefined)
                  yield* Deferred.await(releaseInitial)
                }
                return roster
              })
          })
          const pair = yield* TestSocket.makePair()
          const client = yield* connect(pair, { presence: controlled })
          const share = yield* BranchShare.BranchShare
          const branchId = "watch-toctou" as BranchId
          const capability = yield* share.mint({
            branchId,
            capabilityId: "watch-toctou-capability",
            access: "write",
            ttlMs: 60_000
          })

          const watched = yield* Stream.runCollect(
            Stream.take(client["Branch.WatchRoster"]({ capability, branchId }), 2)
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(initialListed)
          yield* client["Branch.Announce"]({
            capability,
            branchId,
            participantId: alice,
            displayName: "Alice",
            cursor: null
          })
          yield* Deferred.succeed(releaseInitial, undefined)
          return Array.from(
            yield* Fiber.join(watched),
            (frame) => frame.participants.map((participant) => participant.participantId)
          )
        })
      )

      expect(rosters).toContainEqual([])
      expect(rosters).toContainEqual([alice])
    }))
  // The comparison used to join a participant's fields on a control byte, and
  // `ParticipantId` and `displayName` are `NonEmptyString` with no charset
  // constraint: two rosters differing only in where the field boundary falls
  // rendered identically, so the watch called a real change no change. The
  // roster is scripted here because the interleaving that reaches it is the
  // one where a leave and an announce are both applied before the re-list
  // either of them drove, and the watcher therefore never sees the empty
  // roster between them.
  it.live("emits a roster whose fields differ only in where the boundary falls", () =>
    Effect.gen(function*() {
      const split = "p\u0000q" as ParticipantId
      const whole = "p" as ParticipantId
      const branchId = "roster-boundary" as BranchId
      const participant = (participantId: ParticipantId, displayName: string) =>
        new Participant({ branchId, participantId, displayName, cursor: null, leaseExpiresAtMs: 1_000 })
      const scripted: Array<ReadonlyArray<Participant>> = [
        [participant(split, "d")],
        [participant(whole, "q\u0000d")]
      ]
      const rosters = yield* Effect.gen(function*() {
        let lists = 0
        const presence = BranchPresence.BranchPresence.of({
          ...BranchPresence.makeNoop(),
          leaseMs: 600_000,
          changes: Stream.make(branchId),
          list: () =>
            Effect.sync(() => {
              const roster = scripted[Math.min(lists, scripted.length - 1)] ?? []
              lists += 1
              return roster
            })
        })
        const pair = yield* TestSocket.makePair()
        const client = yield* connect(pair, { presence })
        const share = yield* BranchShare.BranchShare
        const capability = yield* share.mint({
          branchId,
          capabilityId: "roster-boundary-capability",
          access: "write",
          ttlMs: 600_000
        })
        return Array.from(
          yield* Stream.runCollect(
            Stream.take(client["Branch.WatchRoster"]({ capability, branchId }), 2)
          ),
          (frame) => frame.participants.map((entry) => entry.participantId)
        )
      }).pipe(Effect.provide(base), Effect.scoped, Effect.timeoutOption("5 seconds"))

      expect(rosters._tag).toBe("Some")
      expect(rosters._tag === "Some" ? rosters.value : []).toEqual([[split], [whole]])
    }))

  // The initial snapshot, the change re-list, and the lease re-list used to be
  // three CONCURRENT readers of one mutable roster. A change delivered while
  // the initial `list` was still in flight resolved first, so the watcher was
  // given the newer roster and then the older one; `changesWith` compares an
  // emission only against the one before it, so the stale roster passed and
  // stayed the watcher's last value until the next change or lease tick. Every
  // read is now a trigger into one sequential reader.
  it.live("never delivers an older roster after a newer one", () =>
    Effect.gen(function*() {
      const branchId = "roster-ordering" as BranchId
      const leases = yield* Effect.gen(function*() {
        let lists = 0
        const presence = BranchPresence.BranchPresence.of({
          ...BranchPresence.makeNoop(),
          leaseMs: 600_000,
          // Delivered at once, so it races the subscription's own snapshot.
          changes: Stream.make(branchId),
          list: () =>
            Effect.suspend(() => {
              lists += 1
              const call = lists
              // Each read observes a strictly newer roster, and the FIRST read
              // is the slow one: that is the interleaving in which concurrent
              // readers resolve in the opposite order to the state they read.
              return Effect.as(
                Effect.sleep(call === 1 ? "200 millis" : "0 millis"),
                [
                  new Participant({
                    branchId,
                    participantId: alice,
                    displayName: "Alice",
                    cursor: null,
                    leaseExpiresAtMs: call
                  })
                ]
              )
            })
        })
        const pair = yield* TestSocket.makePair()
        const client = yield* connect(pair, { presence })
        const share = yield* BranchShare.BranchShare
        const capability = yield* share.mint({
          branchId,
          capabilityId: "roster-ordering-capability",
          access: "write",
          ttlMs: 600_000
        })
        return Array.from(
          yield* Stream.runCollect(
            Stream.take(client["Branch.WatchRoster"]({ capability, branchId }), 2)
          ),
          (frame) => frame.participants[0]?.leaseExpiresAtMs
        )
      }).pipe(Effect.provide(base), Effect.scoped, Effect.timeoutOption("10 seconds"))

      expect(leases._tag).toBe("Some")
      // Read order, not completion order: the older roster is never last.
      expect(leases._tag === "Some" ? leases.value : []).toEqual([1, 2])
    }))

  // `changesWith` used to wrap only the change half, so its first value always
  // passed: a change that left the roster identical sent the watcher a second
  // copy of what the initial emission had just given it.
  it.effect("does not repeat the initial roster when a change leaves it identical", () =>
    Effect.gen(function*() {
      const rosters = yield* program(
        Effect.gen(function*() {
          const memory = yield* BranchPresence.makeMemory({ leaseMs })
          const listedAgain = yield* Deferred.make<void>()
          let lists = 0
          // The re-list a change drives has to COMPLETE before the next change
          // is published, or the two collapse into one list and the case
          // proves nothing either way.
          const controlled = BranchPresence.BranchPresence.of({
            ...memory,
            list: (request) =>
              Effect.gen(function*() {
                const roster = yield* memory.list(request)
                lists += 1
                if (lists === 2) yield* Deferred.succeed(listedAgain, undefined)
                return roster
              })
          })
          const pair = yield* TestSocket.makePair()
          const client = yield* connect(pair, { presence: controlled })
          const share = yield* BranchShare.BranchShare
          const branchId = "roster-initial" as BranchId
          const capability = yield* share.mint({
            branchId,
            capabilityId: "roster-initial-capability",
            access: "write",
            ttlMs: 600_000
          })
          const announce = (participantId: ParticipantId, displayName: string) =>
            client["Branch.Announce"]({ capability, branchId, participantId, displayName, cursor: null })
          yield* announce(alice, "Alice")

          const initial = yield* Deferred.make<void>()
          let emissions = 0
          const watched = yield* Stream.runCollect(
            Stream.take(
              client["Branch.WatchRoster"]({ capability, branchId }).pipe(
                Stream.tap(() => {
                  emissions += 1
                  return emissions === 1 ? Deferred.succeed(initial, undefined) : Effect.void
                })
              ),
              2
            )
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(initial)
          // The clock does not move, so alice's lease is unchanged and this
          // re-announcement leaves the roster exactly as the watcher has it.
          yield* announce(alice, "Alice")
          yield* Deferred.await(listedAgain)
          // A real change, which is what the SECOND emission must be.
          yield* announce(bob, "Bob")
          return Array.from(
            yield* Fiber.join(watched),
            (frame) => frame.participants.map((participant) => participant.participantId)
          )
        })
      )

      expect(rosters).toEqual([[alice], [alice, bob]])
    }))
})

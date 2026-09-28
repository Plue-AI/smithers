/**
 * End-to-end coverage for the branch collaboration RPC group: share-link
 * minting, idempotent command admission, presence announce/leave/roster, and
 * the roster watch stream, all over a real RPC client/server round trip.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Deferred, Effect, Exit, Fiber, Layer, Redacted, Result, Schema, type Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as BranchCommands from "../src/BranchCommands.ts"
import * as BranchIds from "../src/BranchIds.ts"
import * as BranchPresence from "../src/BranchPresence.ts"
import {
  Announcement,
  type BranchId,
  branchRunId,
  type CommandId,
  type CommandSubmission,
  Cursor,
  type ParticipantId,
  SayCommand,
  ShareClaims
} from "../src/BranchProtocol.ts"
import * as BranchRpcs from "../src/BranchRpcs.ts"
import * as BranchShare from "../src/BranchShare.ts"
import { SyncError } from "../src/SyncError.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import { SyncAuth } from "../src/SyncRpcs.ts"
import * as TestSocket from "../src/test/TestSocket.ts"
import { connect } from "./fixtures/branchRpc.ts"

const base = Layer.mergeAll(
  TestJournal.layer(),
  BranchShare.layerHmac({
    activeKid: "primary",
    keys: [{ kid: "primary", secret: Redacted.make("wire-secret-0123456789abcdefghij") }]
  }),
  BranchIds.layer
)
const services = Layer.mergeAll(BranchPresence.layerWith({ leaseMs: 600_000 }), BranchCommands.layer).pipe(
  Layer.provide(base)
)
const testAuth = Layer.succeed(SyncAuth)((effect) =>
  Effect.provideService(effect, SyncPrincipal.SyncPrincipal, SyncPrincipal.workspace("branch-test"))
)
const layer = Layer.mergeAll(base, services, testAuth)

type Requirements =
  | Journal.Journal
  | BranchShare.BranchShare
  | BranchPresence.BranchPresence
  | BranchCommands.BranchCommands
  | BranchIds.BranchIds
  | SyncAuth
  | Scope.Scope

const program = <A, E>(effect: Effect.Effect<A, E, Requirements>) =>
  effect.pipe(Effect.provide(layer), Effect.provide(TestClock.layer()), Effect.scoped)

const alice = "alice" as ParticipantId
const bob = "bob" as ParticipantId

const say = (
  branchId: BranchId,
  participantId: ParticipantId,
  commandId: string,
  text: string
): Effect.Effect<CommandSubmission, SyncError> =>
  BranchCommands.submission({
    branchId,
    commandId: commandId as CommandId,
    participantId,
    name: SayCommand,
    args: text
  })

describe("BranchRpcs over the wire", () => {
  // `BranchIds` is a host port typed `Effect<string>`, and `Branch.CreateBranch`
  // branded its result as a `BranchId` with a cast. A host id source yielding
  // "" therefore reached `new ShareClaims` and crashed a handler whose declared
  // failure is `SyncError`.
  it.effect("refuses a host id source that yields an empty branch id", () =>
    Effect.gen(function*() {
      const failure = yield* program(Effect.gen(function*() {
        const client = yield* connect(yield* TestSocket.makePair(), {
          ids: BranchIds.BranchIds.of({ fresh: Effect.succeed("") })
        })
        return yield* Effect.flip(client["Branch.CreateBranch"]({ ttlMs: 60_000 }))
      }))

      expect(SyncError.is(failure)).toBe(true)
      expect(failure).toMatchObject({ code: "invalid_request" })
    }))

  it.effect("requires workspace authentication and enforces the branch TTL policy", () =>
    Effect.gen(function*() {
      const denied = yield* program(Effect.gen(function*() {
        const client = yield* connect(yield* TestSocket.makePair(), { principal: SyncPrincipal.anonymous })
        return yield* Effect.flip(client["Branch.CreateBranch"]({ ttlMs: 60_000 }))
      }))
      expect(denied).toMatchObject({ code: "unauthorized" })
      expect(() =>
        Schema.decodeUnknownSync(BranchRpcs.CreateBranchPayload)({
          ttlMs: BranchRpcs.maximumBranchTtlMs + 1
        })
      ).toThrow()
    }))

  it.effect("creates a branch and admits commands idempotently", () =>
    Effect.gen(function*() {
      const [first, second, journalLength] = yield* program(
        Effect.gen(function*() {
          const pair = yield* TestSocket.makePair()
          const client = yield* connect(pair)
          const created = yield* client["Branch.CreateBranch"]({ ttlMs: 600_000 })
          const submission = yield* say(created.branchId, alice, "cmd-1", "hello branch")
          const admitted = yield* client["Branch.Submit"]({ capability: created.capability, submission })
          const duplicate = yield* client["Branch.Submit"]({ capability: created.capability, submission })
          const journal = yield* Journal.Journal
          const page = yield* journal.entries({ runId: branchRunId(created.branchId), limit: 10 })
          return [admitted, duplicate, page.entries.length] as const
        })
      )

      expect(first.status).toBe("admitted")
      expect(second.status).toBe("duplicate")
      expect(second.seq).toBe(first.seq)
      expect(journalLength).toBe(1)
    }))

  it.effect("rejects a tampered capability and a write through a read-only link", () =>
    Effect.gen(function*() {
      const [tampered, readOnly] = yield* program(
        Effect.gen(function*() {
          const pair = yield* TestSocket.makePair()
          const client = yield* connect(pair)
          const created = yield* client["Branch.CreateBranch"]({ ttlMs: 600_000 })
          const readLink = yield* client["Branch.MintShare"]({
            capability: created.capability,
            access: "read",
            ttlMs: 60_000
          })
          const tamperedError = yield* Effect.flip(
            client["Branch.Submit"]({
              capability: { ...created.capability, signature: "00" },
              submission: yield* say(created.branchId, alice, "cmd-t", "forgery")
            })
          )
          const readOnlyError = yield* Effect.flip(
            client["Branch.Submit"]({
              capability: readLink,
              submission: yield* say(created.branchId, bob, "cmd-r", "readers cannot write")
            })
          )
          return [tamperedError, readOnlyError] as const
        })
      )

      expect(tampered).toMatchObject({ code: "unauthorized" })
      expect(readOnly).toMatchObject({ code: "unauthorized" })
    }))

  it.effect("clamps a minted link to the minter's own expiry", () =>
    Effect.gen(function*() {
      const [linkExpiry, ownerExpiry] = yield* program(
        Effect.gen(function*() {
          const pair = yield* TestSocket.makePair()
          const client = yield* connect(pair)
          const created = yield* client["Branch.CreateBranch"]({ ttlMs: 60_000 })
          const link = yield* client["Branch.MintShare"]({
            capability: created.capability,
            access: "write",
            ttlMs: 600_000
          })
          return [link.claims.expiresAtMs, created.capability.claims.expiresAtMs] as const
        })
      )

      expect(linkExpiry).toBeLessThanOrEqual(ownerExpiry)
    }))

  for (const delayMs of [200, 1_000, 1_001]) {
    it.effect(`preserves the parent expiry after ${delayMs} ms of ID generation`, () =>
      program(Effect.gen(function*() {
        const share = yield* BranchShare.BranchShare
        const branchId = "delayed-branch" as BranchId
        const parent = yield* share.mint({
          branchId,
          capabilityId: "parent",
          access: "write",
          ttlMs: 1_000
        })
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const delayedIds = BranchIds.BranchIds.of({
          fresh: Effect.gen(function*() {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            return "child"
          })
        })
        const client = yield* connect(yield* TestSocket.makePair()).pipe(
          Effect.provideService(BranchIds.BranchIds, delayedIds)
        )
        const pending = yield* client["Branch.MintShare"]({
          capability: parent,
          access: "read",
          ttlMs: 60_000
        }).pipe(Effect.result, Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        yield* TestClock.adjust(delayMs)
        yield* Deferred.succeed(release, undefined)
        const result = yield* Fiber.join(pending)
        if (delayMs >= 1_000) {
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) {
            expect(result.failure).toMatchObject({ code: "unauthorized" })
            expect(result.failure.message).toContain("expired")
          }
        } else {
          expect(Result.isSuccess(result)).toBe(true)
          if (Result.isSuccess(result)) {
            const child = result.success
            yield* share.verify(child, { branchId, access: "read" })
            yield* TestClock.adjust(1_000 - delayMs)
            const verification = yield* Effect.result(share.verify(child, { branchId, access: "read" }))
            expect(Result.isFailure(verification)).toBe(true)
            expect(child.claims.expiresAtMs).toBe(parent.claims.expiresAtMs)
          }
        }
      })))
  }

  // `share.verify` reads the clock inside its own generator, after awaiting the
  // HMAC, and the handler reads it again. A parent that expires between the two
  // used to clamp the ttl to zero and hand back a capability `verify` refuses
  // on first use: a success carrying something that can never authorize.
  it.effect("refuses to mint a link from a capability that expired mid-request", () =>
    Effect.gen(function*() {
      const failure = yield* program(
        Effect.gen(function*() {
          const ambient = yield* BranchShare.BranchShare
          const expired = BranchShare.BranchShare.of({
            ...ambient,
            // Verification succeeds, and the claims it returns are already out
            // of date by the time the handler reads the clock.
            verify: (capability) =>
              Effect.succeed(
                new ShareClaims({
                  kid: "primary",
                  access: "write",
                  branchId: capability.claims.branchId,
                  capabilityId: capability.claims.capabilityId,
                  expiresAtMs: 0,
                  issuedAtMs: 0
                })
              )
          })
          const pair = yield* TestSocket.makePair()
          const client = yield* connect(pair, { share: expired })
          const created = yield* client["Branch.CreateBranch"]({ ttlMs: 600_000 })
          return yield* Effect.flip(
            client["Branch.MintShare"]({ capability: created.capability, access: "read", ttlMs: 60_000 })
          )
        })
      )

      expect(failure).toMatchObject({ code: "unauthorized" })
      expect(failure.message).toContain("expired")
    }))

  it.effect("refuses to mint from a read-only capability", () =>
    Effect.gen(function*() {
      const error = yield* program(
        Effect.gen(function*() {
          const pair = yield* TestSocket.makePair()
          const client = yield* connect(pair)
          const created = yield* client["Branch.CreateBranch"]({ ttlMs: 600_000 })
          const readLink = yield* client["Branch.MintShare"]({
            capability: created.capability,
            access: "read",
            ttlMs: 60_000
          })
          return yield* Effect.flip(
            client["Branch.MintShare"]({ capability: readLink, access: "read", ttlMs: 60_000 })
          )
        })
      )

      expect(error).toMatchObject({ code: "unauthorized" })
    }))

  it.effect("tracks join, cursor movement, and leave over the roster watch", () =>
    Effect.gen(function*() {
      const emissions = yield* program(
        Effect.gen(function*() {
          const pair = yield* TestSocket.makePair()
          const client = yield* connect(pair)
          const created = yield* client["Branch.CreateBranch"]({ ttlMs: 600_000 })
          const capability = created.capability
          const branchId = created.branchId

          // Both participants announce BEFORE the watch starts, so the first
          // emission is a deterministic snapshot rather than a race against the
          // watcher's initial list. The gate orders the leave AFTER the watch
          // has emitted that snapshot, so the second emission is the re-list the
          // leave's presence change triggers.
          yield* client["Branch.Announce"]({
            capability,
            branchId,
            participantId: alice,
            displayName: "Alice",
            cursor: null
          })
          yield* client["Branch.Announce"]({
            capability,
            branchId,
            participantId: bob,
            displayName: "Bob",
            cursor: new Cursor({ cardId: "branch-card", offset: 12 })
          })

          const snapshot = yield* Deferred.make<void>()
          const departure = yield* Deferred.make<void>()
          let emitted = 0
          const watched = yield* Stream.runCollect(
            Stream.take(
              client["Branch.WatchRoster"]({ capability, branchId }).pipe(
                Stream.tap(() => {
                  emitted += 1
                  return emitted === 1
                    ? Deferred.succeed(snapshot, undefined)
                    : emitted === 2
                    ? Deferred.succeed(departure, undefined)
                    : Effect.void
                })
              ),
              3
            )
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(snapshot)
          yield* client["Branch.Leave"]({ capability, branchId, participantId: alice })
          yield* Deferred.await(departure)
          // A caret that moves is a roster change, so the watch emits again.
          yield* client["Branch.Announce"]({
            capability,
            branchId,
            participantId: bob,
            displayName: "Bob",
            cursor: new Cursor({ cardId: "branch-card", offset: 20 })
          })
          return yield* Fiber.join(watched)
        })
      )

      const rosters = Array.from(emissions, (frame) => frame.participants)
      expect(rosters.map((roster) => roster.map((participant) => participant.participantId))).toEqual([
        [alice, bob],
        [bob],
        [bob]
      ])
      const bobSighting = rosters[0]?.[1]
      expect(bobSighting?.displayName).toBe("Bob")
      expect(bobSighting?.cursor).toMatchObject({ cardId: "branch-card", offset: 12 })
      expect(rosters[2]?.[0]?.cursor).toMatchObject({ cardId: "branch-card", offset: 20 })
    }))

  it.effect("refuses an empty displayName at the wire schema, before any handler runs", () =>
    Effect.gen(function*() {
      // `Branch.Announce` carries `BranchProtocol.Announcement`, the schema
      // `BranchPresence.announce` takes, so the wire and the service cannot
      // disagree about what a legal announcement is. The wire copy used to
      // accept `""` and hand it to a `NonEmptyString` `Participant`
      // constructor, which THREW: a defect outside the `SyncError` channel
      // the RPC declares, which an `Exit.isFailure` assertion could not tell
      // from a typed refusal.
      const decoded = Schema.decodeUnknownResult(Announcement)({
        capability: null,
        branchId: "b",
        participantId: alice,
        displayName: "",
        cursor: null
      })
      expect(Result.isFailure(decoded)).toBe(true)

      const [exit, roster] = yield* program(
        Effect.gen(function*() {
          const pair = yield* TestSocket.makePair()
          const client = yield* connect(pair)
          const presence = yield* BranchPresence.BranchPresence
          const created = yield* client["Branch.CreateBranch"]({ ttlMs: 600_000 })
          const outcome = yield* Effect.exit(
            presence.announce({
              capability: created.capability,
              branchId: created.branchId,
              participantId: alice,
              displayName: "" as string,
              cursor: null
            })
          )
          const current = yield* presence.list({
            capability: created.capability,
            branchId: created.branchId
          })
          return [outcome, current] as const
        })
      )

      // An in-process caller that bypasses the wire is refused TYPED, not by
      // a constructor throwing: the cause reason is a Fail carrying a
      // `SyncError`, which `Exit.isFailure` alone could never distinguish
      // from the Die this used to produce.
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons[0]
        expect(reason?._tag).toBe("Fail")
        const failure = reason?._tag === "Fail" ? reason.error : undefined
        expect(SyncError.is(failure)).toBe(true)
        expect((failure as SyncError).code).toBe("invalid_request")
      }
      expect(roster).toEqual([])
    }))

  it.effect("denies the roster to a capability for another branch and to an expired one", () =>
    Effect.gen(function*() {
      const [foreign, expired] = yield* program(
        Effect.gen(function*() {
          const pair = yield* TestSocket.makePair()
          const client = yield* connect(pair)
          const first = yield* client["Branch.CreateBranch"]({ ttlMs: 600_000 })
          const second = yield* client["Branch.CreateBranch"]({ ttlMs: 600_000 })
          const foreignError = yield* Effect.flip(
            client["Branch.Roster"]({ capability: second.capability, branchId: first.branchId })
          )
          const expiring = yield* client["Branch.CreateBranch"]({ ttlMs: 1 })
          yield* TestClock.adjust(600_000)
          const expiredError = yield* Effect.flip(
            client["Branch.Roster"]({ capability: expiring.capability, branchId: expiring.branchId })
          )
          return [foreignError, expiredError] as const
        })
      )

      expect(foreign).toMatchObject({ code: "unauthorized" })
      expect(expired).toMatchObject({ code: "unauthorized" })
    }))
})

/**
 * The server-side handlers of {@link BranchRpcs}: a thin projection of the
 * branch services onto the wire.
 *
 * Five procedures forward to the service that owns their boundary and add
 * nothing: `Branch.Submit` to {@link BranchCommands}, and `Branch.Announce`,
 * `Branch.Leave`, `Branch.Roster`, and `Branch.WatchRoster` to
 * {@link BranchPresence}. Two enforce policy here, on top of what
 * {@link BranchShare} checks: `Branch.CreateBranch` refuses any principal that
 * is not an authenticated workspace, and `Branch.MintShare` verifies write
 * access, refuses an expired parent, and caps the child at the parent's
 * expiry. `BranchShare.mint` performs none of those checks, so an in-process
 * host that mints through the service directly must gate the principal and
 * the parent capability itself.
 *
 * @since 0.1.0
 */

import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import type * as Rpc from "effect/unstable/rpc/Rpc"
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import * as BranchCommands from "./BranchCommands.ts"
import * as BranchIds from "./BranchIds.ts"
import * as BranchPresence from "./BranchPresence.ts"
import { BranchId, type Participant } from "./BranchProtocol.ts"
import { BranchRpcs } from "./BranchRpcs.ts"
import * as BranchShare from "./BranchShare.ts"
import * as Admission from "./internal/Admission.ts"
import { SyncError } from "./SyncError.ts"
import * as SyncPrincipal from "./SyncPrincipal.ts"

/**
 * Whether two roster emissions say the same thing.
 *
 * `list` returns participants sorted by id, so the comparison is positional.
 * The lease itself is part of the key: a heartbeat that only extends a lease
 * IS a change the watcher wants, because it is the evidence the participant is
 * still there.
 *
 * The rendering is JSON rather than delimiter-joined fields. Participant ids
 * and display names are `NonEmptyString` with no charset constraint, so every
 * separator is a character they may carry, including the control bytes this
 * used to join on. Two rosters differing only in where a field boundary falls
 * then rendered identically and a watcher never observed the change. JSON
 * quotes and escapes each field, so distinct rosters render distinctly.
 */
const rosterKey = (participants: ReadonlyArray<Participant>): string =>
  JSON.stringify(
    participants.map((participant) => [
      participant.participantId,
      participant.displayName,
      participant.leaseExpiresAtMs,
      participant.cursor === null ? null : [participant.cursor.cardId, participant.cursor.offset]
    ])
  )

const sameRoster = (
  left: ReadonlyArray<Participant>,
  right: ReadonlyArray<Participant>
): boolean => rosterKey(left) === rosterKey(right)

/**
 * Provides the branch RPC handlers over the branch services.
 *
 * A roster watch emits the roster as of subscription, then re-lists on every
 * presence change for the branch AND at least once per second, emitting
 * only when the roster it read differs from the one it last sent.
 *
 * All three of those are triggers into ONE sequential reader. The roster is
 * mutable state behind an effect, so concurrent readers can complete out of
 * order, and a watcher that receives an older roster after a newer one keeps
 * the older one: `changesWith` compares against the previous emission, not
 * against the freshest state. Serializing the reads is what makes the last
 * value a watcher holds the most recent one that was read.
 *
 * The periodic re-list is what makes expiry observable. A lapsed lease
 * publishes nothing — the roster drops it the next time somebody lists — so a
 * watch driven by change events alone never saw the LAST participant leave,
 * and a burst of announcements on unrelated branches could slide the one
 * notification this watch needed out of the shared feed. Both are bounded by
 * one second: a departure is visible within 1 s of lease expiry,
 * whether or not a survivor reports it.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerHandlers: Layer.Layer<
  Rpc.ToHandler<RpcGroup.Rpcs<typeof BranchRpcs>>,
  never,
  | BranchShare.BranchShare
  | BranchPresence.BranchPresence
  | BranchCommands.BranchCommands
  | BranchIds.BranchIds
> = BranchRpcs.toLayer(
  Effect.gen(function*() {
    const share = yield* BranchShare.BranchShare
    const presence = yield* BranchPresence.BranchPresence
    const commands = yield* BranchCommands.BranchCommands
    const ids = yield* BranchIds.BranchIds

    return BranchRpcs.of({
      "Branch.CreateBranch": ({ ttlMs }) =>
        Effect.gen(function*() {
          const principal = yield* SyncPrincipal.SyncPrincipal
          if (!SyncPrincipal.isWorkspace(principal)) {
            return yield* new SyncError({
              code: "unauthorized",
              message: "Creating a branch requires an authenticated workspace principal"
            })
          }
          // Decoded, not branded: `BranchIds` is a host port whose `fresh` is
          // typed `Effect<string>`, so a host id source yielding "" turned an
          // asserted `BranchId` into a schema defect inside `mint` rather than
          // the `SyncError` this handler declares.
          const branchId = yield* Admission.decode(BranchId, yield* ids.fresh, "invalid_request")
          const capability = yield* share.mint({
            branchId,
            capabilityId: yield* ids.fresh,
            access: "write",
            ttlMs
          })
          return { branchId: capability.claims.branchId, capability }
        }),
      "Branch.MintShare": ({ capability, access, ttlMs }) =>
        Effect.gen(function*() {
          const claims = yield* share.verify(capability, {
            branchId: capability.claims.branchId,
            access: "write"
          })
          const capabilityId = yield* ids.fresh
          const nowMs = yield* Clock.currentTimeMillis
          // ID generation may outlast the parent. Refuse before minting, and
          // pass the absolute ceiling so the signing clock cannot extend it.
          if (nowMs >= claims.expiresAtMs) {
            return yield* new SyncError({
              code: "unauthorized",
              message: "The share capability has expired"
            })
          }
          // A link never outlives the capability it was minted from.
          return yield* share.mint({
            branchId: claims.branchId,
            capabilityId,
            access,
            ttlMs,
            maxExpiresAtMs: claims.expiresAtMs
          })
        }),
      "Branch.Submit": (payload) => commands.submit(payload),
      "Branch.Announce": (payload) => presence.announce(payload),
      "Branch.Leave": (payload) => Effect.as(presence.leave(payload), null),
      "Branch.Roster": (payload) => presence.list(payload),
      "Branch.WatchRoster": (payload) =>
        Stream.merge(
          // The subscription's own snapshot is a TRIGGER like the other two,
          // not a fourth reader. Reading it here concurrently with them let
          // the roster a change produced overtake it: `presence.list` is an
          // effect against mutable state, three of them ran at once, and the
          // slowest one won the merge. `changesWith` compares an emission only
          // against the one before it, so the older roster passed the filter
          // and the watcher's LAST value said a participant who had already
          // left was still present, until the next change or lease tick.
          Stream.succeed(undefined),
          Stream.merge(
            presence.changes.pipe(
              Stream.filter((branchId) => branchId === payload.branchId),
              Stream.map(() => undefined)
            ),
            // A lapsed lease publishes nothing, so a watch driven only by
            // change events never observes the LAST participant leaving, and
            // an unrelated branch's burst can slide the one notification this
            // watch needed out of the shared feed. Re-listing at least once per second
            // bounds both: a departure is visible within 1 s of expiry, whether or not anyone reports it.
            Stream.fromEffectRepeat(Effect.sleep(Math.min(presence.leaseMs, 1_000))).pipe(Stream.map(() => undefined))
          )
        ).pipe(
          // ONE reader, sequential by default, so a roster is read in the
          // order its trigger arrived and every emission is at least as fresh
          // as the one before it.
          Stream.mapEffect(() => presence.list(payload)),
          // Deduplicated over the WHOLE stream, initial emission included.
          // Applied to the change half alone, its first value always passed,
          // so a change that left the roster identical still sent the watcher
          // a second copy of what it had just been given.
          Stream.changesWith(sameRoster),
          Stream.map((participants) => ({ participants }))
        )
    })
  })
)

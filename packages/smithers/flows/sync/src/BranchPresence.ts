/**
 * Ephemeral presence and cursors for one shared branch.
 *
 * Presence is deliberately NOT journalled. A roster is a lease table: every
 * announcement extends a lease, and a participant that stops announcing —
 * because the tab closed, the network dropped, or the process died — ages out
 * without anyone reporting the disconnect. Writing presence to the journal
 * would make "who was looking at this" part of the durable, replayable history
 * of a run, which is both unbounded and wrong: replaying a branch must not
 * resurrect a stranger's caret.
 *
 * Every operation authorizes through {@link BranchShare}, so a capability for
 * one branch can neither read nor write another branch's roster. A live
 * participant is bound to the capability that announced it: announcing or
 * leaving under that `participantId` with any other capability is refused
 * with `unauthorized` until the lease lapses.
 *
 * @since 0.1.0
 */

import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PubSub from "effect/PubSub"
import * as Stream from "effect/Stream"
import {
  type Announcement,
  type BranchId,
  Cursor,
  type LeaveRequest,
  Participant,
  type ParticipantId,
  type RosterRequest
} from "./BranchProtocol.ts"
import * as BranchShare from "./BranchShare.ts"
import { positiveInt } from "./internal/PolicyOptions.ts"
import { SyncError } from "./SyncError.ts"

/**
 * Ephemeral branch presence operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly announce: (announcement: Announcement) => Effect.Effect<Participant, SyncError>
  readonly leave: (request: LeaveRequest) => Effect.Effect<void, SyncError>
  /**
   * One branch's live roster, as a fresh array of detached participants and
   * cursors. Reading drops expired leases and advances a cross-branch sweep.
   */
  readonly list: (request: RosterRequest) => Effect.Effect<ReadonlyArray<Participant>, SyncError>
  /**
   * Returns `unknown` for one lease after host startup or while a required
   * heartbeat source is unavailable; otherwise reports `present` or `empty`.
   *
   * @since 1.0.0
   */
  readonly presenceOn: (request: RosterRequest) => Effect.Effect<"unknown" | "present" | "empty", SyncError>
  readonly changes: Stream.Stream<BranchId>
  /**
   * How long one announcement keeps a participant on the roster, in
   * milliseconds.
   *
   * A lease lapses without anyone reporting it, and nothing publishes on
   * `changes` when it does, so a watcher cannot learn of the last
   * participant's departure from the change feed alone. It re-lists on this
   * cadence capped at one second, bounding how long an expired lease stays visible.
   */
  readonly leaseMs: number
}

/**
 * The branch presence registry.
 *
 * @category services
 * @since 0.1.0
 */
export class BranchPresence extends Context.Service<BranchPresence, Service>()("@smthrs/sync/BranchPresence") {}

const unavailable = new SyncError({ code: "unsupported", message: "Branch presence is unavailable" })

/**
 * The lease {@link makeNoop} reports. It holds no one, so the value only has
 * to be a positive number a watcher can build a re-list cadence from.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultLeaseMs = 30_000

/**
 * Constructs an unavailable presence registry.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  BranchPresence.of({
    announce: () => Effect.fail(unavailable),
    leave: () => Effect.fail(unavailable),
    list: () => Effect.fail(unavailable),
    presenceOn: () => Effect.succeed("unknown"),
    changes: Stream.empty,
    leaseMs: defaultLeaseMs,
    ...overrides
  })

/**
 * Provides an unavailable presence registry.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<BranchPresence> = Layer.succeed(BranchPresence, makeNoop())

/**
 * The policy one presence registry runs under. Every field defaults, and
 * {@link makeMemory} and {@link layerWith} validate what a caller supplies.
 *
 * @category models
 * @since 0.1.0
 */
export interface PresenceOptions {
  /**
   * How long an announcement keeps a participant on the roster, in
   * milliseconds. Defaults to {@link defaultLeaseMs}.
   */
  readonly leaseMs?: number | undefined
  /**
   * Roster changes a stalled {@link Service.changes} subscriber may fall
   * behind by. Defaults to {@link defaultChangesCapacity}.
   */
  readonly changesCapacity?: number | undefined
  /**
   * Participants one branch may hold at once. Defaults to
   * {@link defaultMaxParticipants}.
   */
  readonly maxParticipants?: number | undefined
  /**
   * Host readiness, including authorization, revocation, bridge and session
   * sources. Defaults to unavailable.
   *
   * @since 1.0.0
   */
  readonly sourcesReady?: ((branchId: BranchId) => Effect.Effect<boolean>) | undefined
}

/**
 * One roster slot: the participant, and the capability that announced it.
 *
 * `participantId` is chosen by the client, so it proves nothing on its own.
 * The slot is bound to the verified `capabilityId` of its first live
 * announcement, and only that capability may refresh or leave it until the
 * lease lapses. Without the binding any write link on the branch could
 * rename, move the caret of, or evict another link's participant.
 */
interface Seat {
  readonly participant: Participant
  readonly capabilityId: string
}

const heldByAnother = (participantId: ParticipantId): SyncError =>
  new SyncError({
    code: "unauthorized",
    message: `Participant ${participantId} is held by another share capability`
  })

/** The resolved, already-validated presence policy. */
interface Resolved {
  readonly leaseMs: number
  readonly changesCapacity: number
  readonly maxParticipants: number
  readonly sourcesReady: (branchId: BranchId) => Effect.Effect<boolean>
}

/**
 * Roster changes a stalled {@link Service.changes} subscriber may fall behind
 * by before the oldest are dropped.
 *
 * Presence is a lease table, and `changes` only says that some branch's roster
 * moved: a follower answers it with `list`. Holding an unbounded backlog for a
 * subscriber that has stopped pulling would let one abandoned watcher retain
 * every announcement the process has seen since. A subscriber that falls
 * further behind than this bound loses the oldest notifications and re-lists;
 * because every notification is answered by a fresh `list`, dropping one never
 * loses roster state.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultChangesCapacity = 256

/**
 * Participants one branch may hold at once.
 *
 * A roster is unbounded fan-out in two directions: it is walked on every
 * `list`, and `Branch.Roster` returns it whole, which no frame ceiling covers.
 * Nothing caps how many distinct `participantId`s one write capability may
 * announce, so without this a single share link could pin an arbitrary number
 * of `Participant` objects until their leases expired. Two hundred and fifty
 * six is far above any real collaborative session; a further announce is
 * refused with `backpressure`.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxParticipants = 256

const defaults: Resolved = {
  leaseMs: defaultLeaseMs,
  changesCapacity: defaultChangesCapacity,
  maxParticipants: defaultMaxParticipants,
  sourcesReady: () => Effect.succeed(false)
}

/**
 * Constructs the in-memory, lease-expiring presence registry.
 *
 * Announcing requires write access: a read-only share link may watch the
 * roster but never appears on it, so a shared read link cannot be used to
 * impersonate a collaborator. A live participant belongs to the capability
 * that announced it, so another write link can neither overwrite nor evict it.
 * Holders of one link share its `capabilityId` and stay indistinguishable.
 *
 * The roster is keyed by branch and then by participant, so listing one branch
 * costs that branch plus a bounded sweep of other branches, and no two
 * branches can share a slot. One flat key built by concatenation collided
 * for valid branded ids, which let one announcement overwrite another branch's
 * participant.
 *
 * The change feed slides at {@link defaultChangesCapacity}: announcing never
 * waits on a stalled watcher, and never grows the process on its behalf.
 *
 * Fails with `invalid_request` when an option is not a positive safe integer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeMemory = (
  options: PresenceOptions = {}
): Effect.Effect<Service, SyncError, BranchShare.BranchShare> =>
  Effect.flatMap(
    Effect.all({
      leaseMs: positiveInt("BranchPresence.PresenceOptions.leaseMs", options.leaseMs, defaults.leaseMs),
      changesCapacity: positiveInt(
        "BranchPresence.PresenceOptions.changesCapacity",
        options.changesCapacity,
        defaults.changesCapacity
      ),
      maxParticipants: positiveInt(
        "BranchPresence.PresenceOptions.maxParticipants",
        options.maxParticipants,
        defaults.maxParticipants
      )
    }),
    (resolved) => makeResolved({ ...resolved, sourcesReady: options.sourcesReady ?? defaults.sourcesReady })
  )

/** The registry over an already-validated policy. */
const makeResolved = (
  { changesCapacity, leaseMs, maxParticipants, sourcesReady }: Resolved
): Effect.Effect<Service, never, BranchShare.BranchShare> =>
  Effect.gen(function*() {
    const startedAtMs = yield* Clock.currentTimeMillis
    const share = yield* BranchShare.BranchShare
    const roster = new Map<BranchId, Map<ParticipantId, Seat>>()
    const changes = yield* PubSub.sliding<BranchId>(changesCapacity)

    const expire = (branchId: BranchId, nowMs: number) => {
      const branch = roster.get(branchId)
      if (branch === undefined) return undefined
      for (const [participantId, seat] of branch) {
        if (seat.participant.leaseExpiresAtMs <= nowMs) branch.delete(participantId)
      }
      if (branch.size === 0) {
        roster.delete(branchId)
        return undefined
      }
      return branch
    }

    // Each announce/list advances through at most 16 branch maps. Their
    // participant counts are capped, so unrelated activity reclaims abandoned
    // rosters without scanning the entire registry in a single request.
    let sweepCursor = roster.keys()
    const sweep = (nowMs: number) => {
      for (let index = 0; index < 16; index++) {
        const next = sweepCursor.next()
        if (next.done) {
          sweepCursor = roster.keys()
          break
        }
        expire(next.value, nowMs)
      }
    }

    const detach = (participant: Participant): Participant =>
      new Participant({
        ...participant,
        cursor: participant.cursor === null ? null : new Cursor(participant.cursor)
      })

    /**
     * Drop this branch's expired leases and advance cleanup of other branches.
     * Abandoned maps are reclaimed as announce/list calls advance the sweep;
     * an idle registry keeps them until activity resumes. Results are detached
     * from storage, including each participant's cursor.
     */
    const live = (branchId: BranchId, nowMs: number): Array<Participant> => {
      sweep(nowMs)
      const branch = expire(branchId, nowMs)
      if (branch === undefined) return []
      return Array.from(branch.values(), (seat) => detach(seat.participant)).sort((left, right) =>
        left.participantId < right.participantId ? -1 : 1
      )
    }

    /**
     * Copy a request out of the caller's object before the first await.
     *
     * `share.verify` awaits Web Crypto between authorizing `branchId` and the
     * roster access that follows. The request objects are plain structs the
     * in-process caller still holds, so reading them again after the await let
     * a caller move `branchId` (or the participant identity) onto a branch the
     * capability never authorized. Matches the claim snapshot in `BranchShare`.
     */
    const detachRoster = (request: RosterRequest): RosterRequest => ({
      capability: request.capability,
      branchId: request.branchId
    })
    const detachLeave = (request: LeaveRequest): LeaveRequest => ({
      ...detachRoster(request),
      participantId: request.participantId
    })
    const detachAnnouncement = (request: Announcement) => {
      const suppliedCursor: unknown = request.cursor
      const cursor: { readonly cardId: unknown; readonly offset: unknown } | null = suppliedCursor === null
        ? null
        : typeof suppliedCursor === "object"
        ? { cardId: (suppliedCursor as Cursor).cardId, offset: (suppliedCursor as Cursor).offset }
        : { cardId: undefined, offset: undefined }
      return { ...detachLeave(request), displayName: request.displayName, cursor }
    }

    const announce = Effect.fn("BranchPresence.announce")(function*(supplied: Announcement) {
      const detached = detachAnnouncement(supplied)
      yield* Effect.annotateCurrentSpan({
        branchId: detached.branchId,
        participantId: detached.participantId
      })
      const claims = yield* share.verify(detached.capability, {
        branchId: detached.branchId,
        access: "write"
      })
      // The wire schema IS `Announcement`, so a remote caller cannot reach
      // here with an empty name. An in-process caller can, and `Participant`
      // requires a `NonEmptyString`: without this the constructor threw a
      // defect out of an operation whose type promises a `SyncError`.
      if (detached.displayName.length === 0) {
        return yield* Effect.fail(
          new SyncError({ code: "invalid_request", message: "A participant's display name must not be empty" })
        )
      }
      let cursor: Cursor | null = null
      if (detached.cursor !== null) {
        const { cardId, offset } = detached.cursor
        if (typeof cardId !== "string" || cardId.length === 0) {
          return yield* Effect.fail(
            new SyncError({ code: "invalid_request", message: "A cursor's card ID must not be empty" })
          )
        }
        if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
          return yield* Effect.fail(
            new SyncError({ code: "invalid_request", message: "A cursor's offset must be a nonnegative safe integer" })
          )
        }
        cursor = new Cursor({ cardId, offset })
      }
      const announcement = { ...detached, cursor }
      const nowMs = yield* Clock.currentTimeMillis
      // Run-out leases are dropped before the cap is judged, so a branch that
      // has simply been busy over time is never refused for a stale roster.
      live(announcement.branchId, nowMs)
      const branch = roster.get(announcement.branchId) ?? new Map<ParticipantId, Seat>()
      const held = branch.get(announcement.participantId)
      if (held !== undefined && held.capabilityId !== claims.capabilityId) {
        return yield* Effect.fail(heldByAnother(announcement.participantId))
      }
      if (held === undefined && branch.size >= maxParticipants) {
        return yield* Effect.fail(
          new SyncError({
            code: "backpressure",
            message: `Branch ${announcement.branchId} already holds ${maxParticipants} participants`
          })
        )
      }
      const participant = new Participant({
        branchId: announcement.branchId,
        participantId: announcement.participantId,
        displayName: announcement.displayName,
        cursor: announcement.cursor,
        leaseExpiresAtMs: nowMs + leaseMs
      })
      branch.set(announcement.participantId, { participant, capabilityId: claims.capabilityId })
      roster.set(announcement.branchId, branch)
      yield* PubSub.publish(changes, announcement.branchId)
      return detach(participant)
    })

    const leave = Effect.fn("BranchPresence.leave")(function*(supplied: LeaveRequest) {
      const request = detachLeave(supplied)
      yield* Effect.annotateCurrentSpan({ branchId: request.branchId, participantId: request.participantId })
      const claims = yield* share.verify(request.capability, { branchId: request.branchId, access: "write" })
      const branch = expire(request.branchId, yield* Clock.currentTimeMillis)
      if (branch !== undefined) {
        const held = branch.get(request.participantId)
        if (held !== undefined && held.capabilityId !== claims.capabilityId) {
          return yield* Effect.fail(heldByAnother(request.participantId))
        }
        branch.delete(request.participantId)
        if (branch.size === 0) roster.delete(request.branchId)
      }
      yield* PubSub.publish(changes, request.branchId)
    })

    const list = Effect.fn("BranchPresence.list")(function*(supplied: RosterRequest) {
      const request = detachRoster(supplied)
      yield* Effect.annotateCurrentSpan({ branchId: request.branchId })
      yield* share.verify(request.capability, { branchId: request.branchId, access: "read" })
      return live(request.branchId, yield* Clock.currentTimeMillis)
    })

    const presenceOn = Effect.fn("BranchPresence.presenceOn")(function*(supplied: RosterRequest) {
      const request = detachRoster(supplied)
      yield* share.verify(request.capability, { branchId: request.branchId, access: "read" })
      const nowMs = yield* Clock.currentTimeMillis
      if (nowMs - startedAtMs < leaseMs || !(yield* sourcesReady(request.branchId))) return "unknown" as const
      return live(request.branchId, nowMs).length === 0 ? "empty" as const : "present" as const
    })

    return BranchPresence.of({ announce, leave, list, presenceOn, changes: Stream.fromPubSub(changes), leaseMs })
  })

/**
 * Provides the in-memory, lease-expiring presence registry under the default
 * policy, which is valid by construction and so cannot fail.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<BranchPresence, never, BranchShare.BranchShare> = Layer.effect(
  BranchPresence,
  makeResolved(defaults)
)

/**
 * Provides the in-memory, lease-expiring presence registry under an explicit
 * policy. Fails with `invalid_request` when an option is not a positive safe
 * integer, so a bad policy fails the composition rather than an announcement.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerWith = (
  options: PresenceOptions
): Layer.Layer<BranchPresence, SyncError, BranchShare.BranchShare> => Layer.effect(BranchPresence, makeMemory(options))

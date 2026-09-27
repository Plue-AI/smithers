/**
 * Durable trigger declaration and fire store.
 *
 * @see packages/smithers/agent/triggers/docs/api.md
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
// `Result` already names the reported end of an occurrence in this module, so
// the `effect/Result` a listed row decodes to is imported as `Decode`.
import * as Decode from "effect/Result"
import type { Action } from "./Overlap.ts"
import type { Trigger } from "./Trigger.ts"
import { TriggerError } from "./TriggerError.ts"

/**
 * A stored trigger, with the revision that fences concurrent edits and
 * when it last fired.
 *
 * @category models
 * @since 0.1.0
 */
export interface Registered extends Trigger {
  readonly revision: number
  readonly lastFiredAt?: number | undefined
}
/**
 * One scheduled occurrence of a trigger, addressed by its occurrence
 * number so a retry cannot fire it twice.
 *
 * @category models
 * @since 0.1.0
 */
export interface Fire {
  readonly triggerId: string
  readonly occurrence: number
}
/**
 * A {@link Fire} together with the revision it was computed from and whether
 * it is resuming a buffered occurrence.
 *
 * The overlap policy is deliberately absent. A claim applies the policy stored
 * on the trigger row, read inside the same transaction, so a caller holding a
 * stale snapshot cannot fire a trigger that has since been disabled, cannot
 * point it at a different flow, and cannot supersede a run that the stored
 * declaration says to leave alone. `expectedRevision` is the fence: a claim
 * whose revision no longer matches the row is refused with `revision_mismatch`
 * so the caller re-reads before deciding again.
 *
 * @category models
 * @since 0.1.0
 */
export interface ClaimFire extends Fire {
  readonly expectedRevision: number
  readonly resumeBuffered?: boolean | undefined
}
/**
 * The outcome of claiming an occurrence: either another worker holds it, or
 * this caller does and must take `action`.
 *
 * A claim that hands the caller work to launch always names the reservation it
 * wrote against the trigger row, so the caller has an id to release. A claim
 * that only records a decision has no reservation and names none: the two
 * shapes are separate so a caller cannot read a reservation id that was never
 * written.
 *
 * @category models
 * @since 0.1.0
 */
export type Claim =
  | { readonly claimed: false }
  | { readonly claimed: true; readonly action: Extract<Action, "skip" | "buffer"> }
  | {
    readonly claimed: true
    readonly action: Extract<Action, "fire" | "supersede">
    readonly reservationId: string
    readonly activeRunId?: string | undefined
  }

/**
 * Time after which an uncommitted launch reservation may be reclaimed.
 *
 * Both store implementations use this value so swapping the test store for
 * the SQL store cannot change recovery timing.
 *
 * @category constants
 * @since 0.1.0
 */
export const reservationLeaseMs = 5 * 60 * 1000

/**
 * The prefix marking an `active_run_id` that is a launch reservation rather
 * than a run the runtime knows about.
 *
 * A reservation is written by the claim and replaced by the real run id once
 * the launch reports one, so both stores and the scheduler read this prefix.
 * It is a contract between them and lives here rather than being re-spelled at
 * each site.
 *
 * @category constants
 * @since 0.1.0
 */
export const reservationPrefix = "trigger-reservation:"

/**
 * The reservation id one occurrence of one trigger claims.
 *
 * @category constructors
 * @since 0.1.0
 */
export const reservationId = (triggerId: string, occurrence: number, attempt?: string): string =>
  `${reservationPrefix}${triggerId}:${attempt === undefined ? "" : `${attempt}:`}${occurrence}`

/**
 * Whether a stored `active_run_id` is a launch reservation.
 *
 * @category predicates
 * @since 0.1.0
 */
export const isReservation = (runId: string | undefined): boolean =>
  runId !== undefined && runId.startsWith(reservationPrefix)

/**
 * Reads the occurrence encoded in a launch reservation.
 *
 * @category getters
 * @since 0.1.0
 */
export const reservationOccurrence = (runId: string): number | undefined => {
  if (!isReservation(runId)) return undefined
  const occurrence = Number(runId.slice(runId.lastIndexOf(":") + 1))
  return Number.isFinite(occurrence) ? occurrence : undefined
}

/**
 * How a claimed occurrence ended.
 *
 * @category models
 * @since 0.1.0
 */
export type Outcome = "launched" | "completed" | "skipped" | "buffered" | "superseded" | "failed"
/**
 * The reported end of one occurrence, with the run it started when it
 * launched one.
 *
 * @category models
 * @since 0.1.0
 */
export type Result =
  & Fire
  & { readonly error?: string | undefined }
  & (
    | { readonly outcome: "launched"; readonly runId: string; readonly reservationId: string }
    | {
      readonly outcome: Exclude<Outcome, "launched">
      readonly runId?: string | undefined
      readonly reservationId?: string | undefined
    }
  )

/**
 * Refuses results that no longer own a permissible fire transition.
 * Launched run ids are validated at runtime for adapters outside TypeScript.
 *
 * @category predicates
 * @since 1.0.0-rc.0
 */
export const resultRefusal = (
  result: Result,
  fire: FireRecord | undefined,
  activeRunId: string | undefined
): TriggerError | undefined => {
  if (result.outcome === "launched" && (typeof result.runId !== "string" || result.runId.trim().length === 0)) {
    return new TriggerError({ code: "invalid_options", message: "launched requires a non-empty runId", path: "runId" })
  }
  const unfinished = fire?.outcome === null || fire?.outcome === "buffered"
  const reservation = activeRunId !== undefined && isReservation(activeRunId) &&
    reservationOccurrence(activeRunId) === result.occurrence
  const owner = result.reservationId ?? result.runId ?? (reservation ? activeRunId : undefined)
  const permitted = result.outcome === "launched"
    ? unfinished && reservation && result.reservationId === activeRunId
    : fire !== undefined && (
      // A repeated decision or settlement is harmless; callers do not rewrite it.
      (fire.outcome === result.outcome && (result.runId === undefined || result.runId === fire.runId)) ||
      (fire.outcome === "launched" && result.outcome !== "skipped" && result.outcome !== "buffered" &&
        result.reservationId === undefined && (result.runId === undefined || result.runId === fire.runId)) ||
      (unfinished && reservation && owner === activeRunId)
    )
  return permitted ? undefined : new TriggerError({
    code: "stale_owner",
    message: `result no longer owns trigger ${result.triggerId} occurrence ${result.occurrence}`
  })
}

/**
 * One row of the fire ledger: a claimed occurrence and what became of it.
 *
 * `outcome` is `null` between a claim and its `recordResult`, the window in
 * which a launch is reserved but not yet reported.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface FireRecord extends Fire {
  readonly outcome: Outcome | null
  readonly runId?: string | undefined
  readonly error?: string | undefined
}

/**
 * A ledger query. Every filter narrows; `cursor` is the last record of the
 * previous page, so the page after it holds only older records; `limit` caps
 * a page and must be a positive safe integer when stated. With no limit the
 * whole ledger answers in one page.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface HistoryQuery {
  readonly triggerId?: string | undefined
  readonly runId?: string | undefined
  readonly outcome?: Outcome | undefined
  readonly cursor?: Fire | undefined
  readonly limit?: number | undefined
}

/**
 * One page of the ledger, newest occurrence first, with the cursor that
 * addresses the next page when the limit cut the page short.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface HistoryPage {
  readonly items: ReadonlyArray<FireRecord>
  readonly nextCursor?: Fire | undefined
}

/**
 * What one trigger holds right now: the run or launch reservation on its row
 * and the occurrence buffered behind it. A plain read; `activeRun` is the read
 * that expires a stale reservation.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Held {
  readonly activeRunId?: string | undefined
  readonly pendingAt?: number | undefined
}

/**
 * One row of a listing: what the trigger holds right now, and either the
 * declaration the row decoded to or the failure it could not be read through.
 *
 * `trigger` is an `effect/Result`: narrow it with `Result.isFailure` before
 * reading the declaration. An undecodable row is isolated here rather than
 * failing the whole listing,
 * so one corrupt input cannot stop every other trigger from being scheduled.
 * The held state travels with the row because a scheduler tick would otherwise
 * ask for it again per trigger, once to expire a reservation that is not there
 * and once for a buffered occurrence that is not there either.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Listed extends Held {
  readonly triggerId: string
  readonly trigger: Decode.Result<Registered, TriggerError>
}

/**
 * A listed row for a declaration that decoded, holding what the trigger holds
 * right now. Both stores build their rows through this, so a caller composing
 * a store or a scheduler fixture of its own does not restate the shape.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const listed = (trigger: Registered, held: Held = {}): Listed => ({
  triggerId: trigger.id,
  trigger: Decode.succeed(trigger),
  ...held
})

/**
 * The last poll one scheduler host recorded.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Heartbeat {
  readonly host: string
  readonly tickedAt: number
}

/**
 * Validates a {@link HistoryQuery} limit: absent, or a positive safe integer.
 * Both stores apply this before reading so swapping one for the other cannot
 * change which queries are refused.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const historyLimit = (limit: number | undefined): Effect.Effect<number | undefined, TriggerError> =>
  limit === undefined || (Number.isSafeInteger(limit) && limit > 0)
    ? Effect.succeed(limit)
    : Effect.fail(
      new TriggerError({
        code: "invalid_options",
        message: `history limit must be a positive safe integer, received ${limit}`,
        path: "limit"
      })
    )

/**
 * Validates a prune cutoff: any safe integer. Both stores apply this before
 * deleting so swapping one for the other cannot change which cutoffs are
 * refused.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const pruneCutoff = (olderThan: number): Effect.Effect<number, TriggerError> =>
  Number.isSafeInteger(olderThan)
    ? Effect.succeed(olderThan)
    : Effect.fail(
      new TriggerError({
        code: "invalid_options",
        message: `prune cutoff must be a safe integer, received ${olderThan}`,
        path: "olderThan"
      })
    )

/**
 * Newest occurrence first; equal occurrences of different triggers order by
 * descending trigger id so a cursor names one position.
 *
 * @category ordering
 * @since 1.0.0-rc.0
 */
export const compareNewestFirst = (left: Fire, right: Fire): number =>
  right.occurrence - left.occurrence ||
  (right.triggerId < left.triggerId ? -1 : right.triggerId > left.triggerId ? 1 : 0)

/**
 * Whether a record lies after `cursor` in {@link compareNewestFirst} order.
 *
 * @category predicates
 * @since 1.0.0-rc.0
 */
export const isAfterCursor = (record: Fire, cursor: Fire): boolean => compareNewestFirst(cursor, record) < 0

/**
 * Cuts an ordered, filtered record list to one page. The caller fetches one
 * record past the limit; that record's presence is what says a next page
 * exists, and the page's last record is the cursor addressing it.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const historyPage = (records: ReadonlyArray<FireRecord>, limit: number | undefined): HistoryPage => {
  if (limit === undefined || records.length <= limit) return { items: records }
  const items = records.slice(0, limit)
  const last = items[items.length - 1] as FireRecord
  return { items, nextCursor: { triggerId: last.triggerId, occurrence: last.occurrence } }
}

/**
 * Durable trigger state: registration, listing, and the claim protocol that
 * keeps two schedulers from firing the same occurrence.
 *
 * Neither listing is a due-time query. Due-ness is a cron computation the
 * scheduler performs against its own watermark, so the store is asked only for
 * the rows eligible to be considered. A scheduler tick reads `list`, not
 * `listEnabled`: a disabled trigger can still hold an active occurrence that
 * has to recover, and the tick skips only its new claims. `listEnabled`
 * answers the narrower question for a caller that wants the declarations.
 *
 * A claim, result, pending-state, or active-run method fails with
 * `unknown_trigger` when the row it addresses does not exist. `get` answers
 * `None` for an absent row and `register` creates one. `clearActive` is a
 * compare-and-swap that cannot tell a missing trigger from a run id that no
 * longer matches, so it stays a no-op for both. `history`, `pruneFires`,
 * `heartbeat`, and `lastHeartbeat` address the whole store.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly register: (trigger: Trigger) => Effect.Effect<Registered, TriggerError>
  readonly get: (triggerId: string) => Effect.Effect<Option.Option<Registered>, TriggerError>
  /**
   * Every trigger, enabled or not, ordered by id. This is what a scheduler
   * tick polls: see {@link Listed} for why a row carries its decode result and
   * its held state rather than a bare declaration.
   */
  readonly list: () => Effect.Effect<ReadonlyArray<Listed>, TriggerError>
  readonly listEnabled: () => Effect.Effect<ReadonlyArray<Registered>, TriggerError>
  readonly claimFire: (fire: ClaimFire) => Effect.Effect<Claim, TriggerError>
  /**
   * Claims the buffered occurrence, when one exists.
   *
   * One transaction reads the occurrence, applies the same claim protocol as
   * {@link Service.claimFire}, and clears the buffer only when the decision
   * consumes it. A concurrent buffer decision keeps it pending. No failure can
   * land between reading the buffer and claiming it.
   */
  readonly claimPending: (fire: {
    readonly triggerId: string
    readonly expectedRevision: number
  }) => Effect.Effect<
    Option.Option<{ readonly occurrence: number; readonly claim: Claim }>,
    TriggerError
  >
  readonly recordResult: (result: Result) => Effect.Effect<void, TriggerError>
  /** Atomically re-arms unfinished work and releases only its matching reservation.
   * A retained predecessor is restored with the pending pointer in the same write.
   * A stale token fails with `stale_owner`; a failed write leaves the lease intact.
   */
  readonly restorePending: (fire: Fire & { readonly reservationId: string }) => Effect.Effect<void, TriggerError>
  readonly setPending: (fire: Fire) => Effect.Effect<void, TriggerError>
  readonly activeRun: (triggerId: string) => Effect.Effect<Option.Option<string>, TriggerError>
  /**
   * Returns the occurrence owned by one active run or launch reservation.
   *
   * `lastFiredAt` cannot answer this: later skipped and buffered occurrences
   * advance that cursor while an older run remains active.
   */
  readonly activeOccurrence: (
    triggerId: string,
    runId: string
  ) => Effect.Effect<Option.Option<number>, TriggerError>
  readonly clearActive: (triggerId: string, runId: string) => Effect.Effect<void, TriggerError>
  /**
   * Reads the fire ledger newest first. See {@link HistoryQuery} for the
   * filters and paging contract; a limit that is not a positive safe integer
   * is refused with `invalid_options`.
   */
  readonly history: (query?: HistoryQuery) => Effect.Effect<HistoryPage, TriggerError>
  /**
   * Deletes settled fire ledger rows older than `olderThan`, answering how
   * many it removed. Nothing else in the store deletes from the ledger, so a
   * host that never calls this keeps one row per occurrence forever.
   *
   * A row is settled when its outcome is `completed`, `failed`, `skipped`, or
   * `superseded`. The occurrence a trigger currently buffers and the row
   * naming its active run are kept whatever their age, so pruning cannot take
   * state the scheduler still reads. `olderThan` that is not a safe integer is
   * refused with `invalid_options`.
   */
  readonly pruneFires: (options: { readonly olderThan: number }) => Effect.Effect<number, TriggerError>
  /**
   * Reads what one trigger holds without expiring anything, so a listing can
   * report a reservation or a buffered occurrence exactly as the row has it.
   */
  readonly inspect: (triggerId: string) => Effect.Effect<Held, TriggerError>
  /** Records that `host` polled the store at the store clock's current time. */
  readonly heartbeat: (host: string) => Effect.Effect<void, TriggerError>
  /** The most recent heartbeat across every host, or `None` when no scheduler has ever polled. */
  readonly lastHeartbeat: () => Effect.Effect<Option.Option<Heartbeat>, TriggerError>
}

/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 0.1.0
 */
export class TriggerStore extends Context.Service<TriggerStore, Service>()("flows/triggers/TriggerStore") {}

const unavailable = (method: string): Effect.Effect<never, TriggerError> =>
  Effect.fail(new TriggerError({ code: "store", message: `${method} is unavailable` }))

/**
 * A {@link Service} that fails every method as unavailable, for an
 * environment with no trigger store. Overrides replace individual methods.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => ({
  register: () => unavailable("register"),
  get: () => unavailable("get"),
  list: () => unavailable("list"),
  listEnabled: () => unavailable("listEnabled"),
  claimFire: () => unavailable("claimFire"),
  claimPending: () => unavailable("claimPending"),
  recordResult: () => unavailable("recordResult"),
  restorePending: () => unavailable("restorePending"),
  setPending: () => unavailable("setPending"),
  activeRun: () => unavailable("activeRun"),
  activeOccurrence: () => unavailable("activeOccurrence"),
  clearActive: () => unavailable("clearActive"),
  history: () => unavailable("history"),
  pruneFires: () => unavailable("pruneFires"),
  inspect: () => unavailable("inspect"),
  heartbeat: () => unavailable("heartbeat"),
  lastHeartbeat: () => unavailable("lastHeartbeat"),
  ...overrides
})

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<TriggerStore> =>
  Layer.succeed(TriggerStore)(makeNoop(overrides))

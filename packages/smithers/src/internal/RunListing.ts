/**
 * The one run-listing request `ps`, `runs list`, and `runs count` build from
 * their filter flags, so a count always matches the listing it describes.
 *
 * @since 1.0.0
 */

import { Control as ControlService, ControlSchema } from "@smthrs/control"
import { Ownership } from "@smthrs/run-store"
import { Effect, Schema } from "effect"
import { hostname } from "node:os"
import * as CliError from "../CliError.ts"

/**
 * The listing's filter flags as a command receives them.
 *
 * @category models
 * @since 1.0.0
 */
export interface Filters {
  readonly flow?: string | undefined
  readonly status?: ControlSchema.RunStatus | undefined
  readonly since?: string | undefined
  readonly until?: string | undefined
  readonly sort?: "newest" | "oldest" | undefined
  readonly parent?: string | undefined
  readonly trigger?: string | undefined
}

/**
 * A `runs` listing request.
 *
 * @category models
 * @since 1.0.0
 */
export type Request = Extract<ControlSchema.ListRequest, { readonly _tag: "runs" }>

/**
 * The creation-time sort orders a listing accepts.
 *
 * @category models
 * @since 1.0.0
 */
export const sorts = ["newest", "oldest"] as const

/**
 * Reads an epoch millisecond or an ISO 8601 date/time.
 *
 * @category parsing
 * @since 1.0.0
 */
export const instant = (flag: string, value: string): Effect.Effect<number, CliError.UsageError> => {
  const trimmed = value.trim()
  const parsed = /^\d+$/.test(trimmed)
    ? Number(trimmed)
    : /^\d{4}-\d{2}-\d{2}/.test(trimmed)
    ? Date.parse(trimmed)
    : NaN
  return Number.isSafeInteger(parsed)
    ? Effect.succeed(parsed)
    : Effect.fail(
      new CliError.UsageError({
        message: `--${flag} must be epoch milliseconds or an ISO 8601 date, received ${JSON.stringify(value)}`
      })
    )
}

/**
 * Builds the listing request for `filters`, plus the page to read.
 *
 * @category constructors
 * @since 1.0.0
 */
export const request = (
  filters: Filters,
  page: { readonly limit?: number | undefined; readonly cursor?: string | undefined } = {}
): Effect.Effect<Request, CliError.UsageError> =>
  Effect.gen(function*() {
    const since = filters.since === undefined ? undefined : yield* instant("since", filters.since)
    const until = filters.until === undefined ? undefined : yield* instant("until", filters.until)
    if (since !== undefined && until !== undefined && since > until) {
      return yield* new CliError.UsageError({ message: "--since must not be after --until" })
    }
    const selected = {
      ...(filters.flow === undefined ? {} : { flowId: filters.flow }),
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.parent === undefined ? {} : { parentRunId: filters.parent }),
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
      ...(filters.trigger === undefined ? {} : { triggerId: filters.trigger })
    }
    return {
      _tag: "runs" as const,
      filters: selected,
      ...(filters.sort === undefined ? {} : { order: filters.sort }),
      ...(page.limit === undefined ? {} : { limit: page.limit }),
      ...(page.cursor === undefined ? {} : { cursor: page.cursor })
    }
  })

/**
 * Counts every run `listing` selects by walking its pages at the largest size.
 *
 * @category combinators
 * @since 1.0.0
 */
export const count = (listing: Request) =>
  Effect.gen(function*() {
    const control = yield* ControlService.Control
    const { cursor: _cursor, limit: _limit, ...base } = listing
    let total = 0
    let cursor: string | undefined
    do {
      const page = yield* control.list({
        ...base,
        limit: ControlSchema.maxPageSize,
        ...(cursor === undefined ? {} : { cursor })
      })
      if (page._tag !== "runs") return total
      total += page.items.length
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return total
  })

/**
 * The window a driven launch may sit at `accepted` before it claims the run.
 *
 * An ordinary driven launch commits an accepted summary before its executor
 * begins work, so the listing waits out this handoff before probing the owner.
 */
const executorHandoffWindowMillis = 5_000

/**
 * Whether a listing should say a run is waiting for an executor.
 *
 * This is a rendering heuristic over the listing's own fields, not a durable
 * verdict: the durable one is the `control.run.pending` event the status card
 * reads from the run's journal. For a same-host owner it uses the same
 * fail-closed PID probe as run recovery. A foreign-host owner cannot be
 * inspected and is never declared absent here.
 */
const statusObserver: Ownership.OwnerId = Object.freeze({
  hostId: hostname(),
  pid: process.pid,
  nonce: "cli-status-observer"
})

const unclaimed = (run: ControlSchema.RunSummary, now: number): Effect.Effect<boolean> => {
  if (run.status !== "accepted" || run.waitingReason !== undefined) return Effect.succeed(false)
  if (now - run.updatedAt < executorHandoffWindowMillis) return Effect.succeed(false)
  if (run.ownerId === undefined) return Effect.succeed(true)
  try {
    const owner = Schema.decodeUnknownSync(Ownership.OwnerId)(JSON.parse(run.ownerId))
    if (owner.hostId !== statusObserver.hostId) return Effect.succeed(false)
    return Ownership.sameHostPidProbe(owner, {
      claimant: statusObserver,
      heartbeatAtMs: null,
      nowMs: now
    }).pipe(Effect.map((alive) => !alive))
  } catch {
    return Effect.succeed(false)
  }
}

/**
 * Names what an unclaimed run waits for, in the field that already carries it.
 *
 * `RunSummary.waitingReason` is "what a parked run is holding on". This one
 * holds on an executor, and before the label a listing showed it as an
 * ordinary `accepted` run, indistinguishable from one a live peer owns.
 *
 * @category combinators
 * @since 1.0.0
 */
export const label = (listed: ControlSchema.ListResponse, now: number): Effect.Effect<ControlSchema.ListResponse> =>
  listed._tag === "runs"
    ? Effect.map(
      Effect.forEach(
        listed.items,
        (run) => Effect.map(unclaimed(run, now), (missing) => missing ? { ...run, waitingReason: "executor" } : run)
      ),
      (items) => ({ ...listed, items })
    )
    : Effect.succeed(listed)

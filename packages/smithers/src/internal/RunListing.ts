/**
 * The one run-listing request `ps`, `runs list`, and `runs count` build from
 * their filter flags, so a count always matches the listing it describes.
 *
 * @since 1.0.0
 */

import { Control as ControlService, ControlSchema } from "@smthrs/control"
import { Effect } from "effect"
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

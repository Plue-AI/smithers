/**
 * Run-row helpers rewind and recovery share when they claim and fence runs.
 *
 * @since 0.1.0
 */

import type * as RunStore from "@smthrs/run-store/RunStore"
import { error, type TimeTravelError } from "../TimeTravelError.ts"

/**
 * The compare-and-swap snapshot of a row, as `RunStore.claim` expects it.
 *
 * @since 0.1.0
 * @category constructors
 */
export const snapshotOf = (row: RunStore.RunRow): RunStore.RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

/**
 * Maps a run-store failure during `operation`: a missing row is `not_found`,
 * anything else `unknown`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const failure = (operation: string, cause: RunStore.RunStoreError): TimeTravelError =>
  error(
    cause.code === "not_found_row" ? "not_found" : "unknown",
    `${operation} failed`,
    cause
  )

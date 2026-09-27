/**
 * Shared cancellation operation for the legacy and unified command surfaces.
 *
 * @since 1.0.0
 */

import { Control } from "@smthrs/control"
import { Effect } from "effect"

/**
 * Collects every page before cancelling, keeping one Control service for the
 * whole operation and preserving the single-run cancellation keys and receipts.
 * @category constructors
 * @since 1.0.0
 */
export const cancelAll = () =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    const ids: Array<string> = []
    let cursor: string | undefined
    do {
      const page = yield* control.list({ _tag: "runs", ...(cursor === undefined ? {} : { cursor }) })
      if (page._tag !== "runs") throw new Error("Expected durable runs")
      ids.push(
        ...page.items.filter((run) => !["completed", "failed", "cancelled"].includes(run.status)).map((run) =>
          run.runId
        )
      )
      cursor = page.nextCursor
    } while (cursor !== undefined)
    const cancelled = yield* Effect.forEach(ids, (runId) =>
      Effect.map(
        control.cancel({ runId, idempotencyKey: `cli:cancel:${runId}` }),
        (receipt) => ({ runId, receipt })
      ))
    return { cancelled }
  })

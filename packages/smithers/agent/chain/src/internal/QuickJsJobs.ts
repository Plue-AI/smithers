/**
 * Disposal and failure translation for QuickJS's pending-job result.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import type { ExecutePendingJobsResult } from "quickjs-emscripten-core"
import * as JsonBoundary from "../JsonBoundary.ts"
import * as ScriptRunner from "../ScriptRunner.ts"

/**
 * Disposes a pending-job result and translates its live error handle before
 * disposal when execution failed.
 *
 * @private
 * @since 0.1.0
 */
export const check = (jobs: ExecutePendingJobsResult): Effect.Effect<void, ScriptRunner.ScriptFailure> => {
  if (jobs.error === undefined) {
    jobs.dispose()
    return Effect.void
  }
  const dumped = jobs.error.context.dump(jobs.error)
  jobs.dispose()
  return Effect.fail(
    new ScriptRunner.ScriptFailure({
      code: "runtime",
      message: JsonBoundary.failureMessage(dumped)
    })
  )
}

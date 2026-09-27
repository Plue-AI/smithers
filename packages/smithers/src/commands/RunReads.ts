/**
 * One run's history and summary, read from the control plane for a verb.
 *
 * @since 1.0.0
 */

import type { Control as ControlService } from "@smthrs/control"
import { Effect } from "effect"
import * as CliError from "../CliError.ts"
import * as BoundedEvents from "../internal/BoundedEvents.ts"
import * as Settlement from "./Settlement.ts"

/**
 * Every event of one run, oldest first.
 * @category getters
 * @since 1.0.0
 */
export const events = (control: ControlService.Service, runId: string) =>
  BoundedEvents.collect(control.watch({ runId, follow: false }), {
    operation: "event-history read",
    subject: `run ${JSON.stringify(runId)}`
  }).pipe(
    Effect.mapError((error) =>
      error instanceof CliError.ResourceLimitError ? error : Settlement.watchFailure(error, runId, "event-history read")
    )
  )

/**
 * One run's summary, or undefined when the control plane has no such run.
 * @category getters
 * @since 1.0.0
 */
export const summary = (control: ControlService.Service, runId: string) =>
  Effect.map(
    control.list({ _tag: "runs", filters: { runId } }),
    (listed) => listed._tag === "runs" ? listed.items.find((item) => item.runId === runId) : undefined
  )

/**
 * The usage error a verb reports for a run id the control plane does not hold.
 * @category constructors
 * @since 1.0.0
 */
export const missing = (runId: string): CliError.UsageError =>
  new CliError.UsageError({ message: `Run not found: ${JSON.stringify(runId)}` })

/**
 * One run's summary, failing before a reader projects an empty history.
 * @category getters
 * @since 1.0.0
 */
export const existing = (control: ControlService.Service, runId: string) =>
  summary(control, runId).pipe(
    Effect.flatMap((run) => run === undefined ? Effect.fail(missing(runId)) : Effect.succeed(run))
  )

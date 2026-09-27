/**
 * `smthrs bug`: preview, consent, and the post, behind both parsers.
 *
 * @since 1.0.0
 */

import { Control as ControlService, ControlError } from "@smthrs/control"
import { Effect } from "effect"
import * as Bug from "../Bug.ts"
import * as CliError from "../CliError.ts"
import * as Environment from "../Environment.ts"
import * as Forensics from "../Forensics.ts"
import * as BoundedEvents from "../internal/BoundedEvents.ts"
import * as Ui from "../Ui.ts"
import { packageVersion } from "../Version.ts"
import * as Globals from "./Globals.ts"

/**
 * The typed options both parsers produce.
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** The summary words, joined; an empty summary is a usage error. */
  readonly summary: string
  readonly runId?: string | undefined
  readonly yes: boolean
  readonly dryRun: boolean
  /**
   * Receives the endpoint and the already-redacted consent document before
   * any confirmation, so the operator can inspect everything a subsequent
   * POST will send. Each entry routes it to its own stderr, even under quiet.
   */
  readonly preview: (line: string) => Effect.Effect<void>
}

/**
 * The document the verb renders.
 * @category models
 * @since 1.0.0
 */
export type Outcome =
  | { readonly reported: false; readonly endpoint: string; readonly payload: Bug.Report }
  | { readonly reported: true; readonly endpoint: string }

/**
 * Builds the redacted report, previews it, asks, and posts.
 * @category constructors
 * @since 1.0.0
 */
export const submit = (
  options: Options,
  globals: Globals.Options
): Effect.Effect<
  Outcome,
  CliError.UsageError | CliError.UnsupportedError | CliError.ResourceLimitError | ControlError.ControlError,
  ControlService.Control
> =>
  Effect.gen(function*() {
    yield* Globals.guard(globals)
    const environment = globals.environment ?? process.env
    const summary = options.summary.trim()
    if (summary === "") {
      return yield* Effect.fail(new CliError.UsageError({ message: "smthrs bug needs a one-line summary" }))
    }
    const control = yield* ControlService.Control
    const runId = options.runId
    const listed = runId === undefined ? undefined : yield* control.list({ _tag: "runs", filters: { runId } })
    const digest = runId === undefined ? undefined : Forensics.digest(
      yield* BoundedEvents.collect(control.watch({ runId, follow: false }), {
        operation: "event-history read",
        subject: `run ${JSON.stringify(runId)}`
      }).pipe(
        Effect.mapError((error) =>
          error instanceof CliError.ResourceLimitError ? error : new ControlError.TransportError({
            message: `Control watch failed during event-history read for run ${
              JSON.stringify(runId)
            }. Retry the command.`,
            retryable: error instanceof ControlError.TransportError ? error.retryable : true,
            cause: error
          })
        )
      )
    )
    const body = Bug.report({
      summary,
      version: packageVersion,
      platform: `${process.platform}-${process.arch}`,
      node: process.versions.node,
      runs: listed?._tag === "runs" ? listed.items.filter((run) => run.runId === runId) : [],
      ...(digest === undefined ? {} : { digest })
    })
    const endpoint = Environment.read(environment, "SMITHERS_BUG_ENDPOINT") ?? Bug.defaultEndpoint
    const payload = JSON.stringify(body)
    yield* options.preview(endpoint)
    yield* options.preview(payload)
    if (options.dryRun) return { reported: false as const, endpoint, payload: body }
    const ui = yield* Ui.current
    const confirmed = options.yes || (ui.interactive && (yield* ui.confirm({
      message: `Post this report to ${endpoint}?`,
      initialValue: false,
      nonInteractive: false
    })))
    if (!confirmed) {
      return yield* Effect.fail(
        new CliError.UsageError({
          message: "Report not sent. Use --yes to post the previewed payload, or --dry-run to inspect it."
        })
      )
    }
    const posted = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
          signal: AbortSignal.timeout(Bug.timeoutMs)
        })
        return { status: response.status, ok: response.ok }
      },
      catch: (error) =>
        new CliError.UnsupportedError({
          message: `Could not reach ${endpoint}: ${error instanceof Error ? error.message : String(error)}`
        })
    })
    if (!posted.ok) {
      return yield* Effect.fail(new CliError.UnsupportedError({ message: `${endpoint} answered ${posted.status}` }))
    }
    return { reported: true as const, endpoint }
  })

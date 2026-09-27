/**
 * How a verb that launched or restarted a run learns what the run then did.
 *
 * A local CLI owns the executor layer. It keeps that scope alive after
 * accepting a run so its driver is not interrupted as soon as the receipt is
 * printed, and it reports the settlement it waited for as the process status.
 *
 * @since 1.0.0
 */

import { type Control as ControlService, ControlError, type ControlSchema } from "@smthrs/control"
import { Effect, Stream } from "effect"
import * as RunProgress from "../cli/RunProgress.ts"
import * as CliError from "../CliError.ts"
import * as ExecutorOwnership from "../ExecutorOwnership.ts"
import * as CommandStatus from "../internal/CommandStatus.ts"
import { causeLine } from "../internal/Failure.ts"

/**
 * The event kind that settled a run, and the cause its payload recorded.
 * @category models
 * @since 1.0.0
 */
export interface Settlement {
  readonly kind: string
  readonly cause?: string
}

/**
 * Whether an event leaves this process nothing to drive: a park for approval,
 * a `pending` launch the executor declined, or a terminal status.
 * @category predicates
 * @since 1.0.0
 */
export const settled = (kind: string): boolean =>
  kind === "control.run.waiting-approval" ||
  kind === "control.run.pending" ||
  kind === "control.run.completed" ||
  kind === "control.run.failed" ||
  kind === "control.run.cancelled"

/**
 * The retryable transport failure a failed watch reports, naming the run and
 * the operation it interrupted.
 * @category constructors
 * @since 1.0.0
 */
export const watchFailure = (
  error: unknown,
  runId: string,
  operation: string
): ControlError.TransportError =>
  new ControlError.TransportError({
    message: `Control watch failed during ${operation} for run ${JSON.stringify(runId)}. Retry the command.`,
    retryable: error instanceof ControlError.TransportError ? error.retryable : true,
    cause: error
  })

/**
 * Waits for the run to settle and reports the event kind that settled it, or
 * `undefined` when nothing was waited for. `quiet` suppresses progress.
 * @category constructors
 * @since 1.0.0
 */
export const awaitRun = (
  control: ControlService.Service,
  runId: string,
  afterSequence: number | undefined,
  quiet: boolean
): Effect.Effect<Settlement | undefined, ControlError.TransportError> =>
  RunProgress.observe(
    control.watch(afterSequence === undefined ? { runId } : { runId, afterSequence }),
    runId,
    quiet
  ).pipe(
    Stream.filter((event) => settled(event.kind)),
    Stream.take(1),
    Stream.runCollect,
    Effect.map((events): Settlement | undefined => {
      const event = globalThis.Array.from(events)[0]
      if (event === undefined) return undefined
      const payload = event.payload
      const cause = typeof payload === "object" && payload !== null && "cause" in payload ? payload.cause : undefined
      return { kind: event.kind, ...(typeof cause === "string" ? { cause } : {}) }
    }),
    Effect.mapError((error) => watchFailure(error, runId, "settlement"))
  )

/**
 * Finds the greatest sequence in a stream without retaining its history.
 *
 * Use this for journal cursors whose histories can exceed the JavaScript
 * argument limit. Stream failures are preserved so a caller never substitutes
 * a weaker cursor after a failed read.
 *
 * @category getters
 * @since 1.0.0-rc.0
 */
export const latestSequence = <E, R>(
  events: Stream.Stream<{ readonly sequence: number }, E, R>
): Effect.Effect<number | undefined, E, R> =>
  Stream.runFold(
    events,
    () => undefined as number | undefined,
    (latest, event) => latest === undefined || event.sequence > latest ? event.sequence : latest
  )

/**
 * The sequence of the latest committed `control.run.waiting-approval` event:
 * the park a resume applies to. It keys the resume mutation, so resuming a
 * second park is a fresh mutation instead of a replay of the first resume's
 * recorded receipt, and it scopes the settlement wait.
 * @category getters
 * @since 1.0.0
 */
export const latestPark = (control: ControlService.Service, runId: string) =>
  latestSequence(
    control.watch({ runId, follow: false }).pipe(
      Stream.filter((event) => event.kind === "control.run.waiting-approval")
    )
  ).pipe(
    // A failed park lookup cannot safely mint the run-only resume key. Keep it
    // in the error channel so no mutation is attempted with a weaker key.
    Effect.mapError((error) => watchFailure(error, runId, "approval-park lookup"))
  )

/**
 * Waits for a run this process's executor owns, or reports the receipt's own
 * terminal status.
 * @category constructors
 * @since 1.0.0
 */
export const awaitOwnedRun = (
  control: ControlService.Service,
  receipt: ControlSchema.Receipt,
  afterSequence: number | undefined,
  quiet: boolean
) =>
  Effect.gen(function*() {
    // A run that had already settled when the verb reached it has no
    // settlement event left to wait for, and the receipt carries the answer.
    // Without this, `smthrs run --resume <run-id>` against a run that
    // settled `failed` printed `{"_tag":"Terminal","status":"failed"}` and
    // exited 0, because every receipt tag but `Accepted` reported nothing at
    // all (recorded by the cli-exit-code lane's verifier).
    if (receipt._tag === "Terminal") return { kind: `control.run.${receipt.status}` }
    const ownsExecutor = yield* ExecutorOwnership.ExecutorOwnership
    if (!ownsExecutor || receipt._tag !== "Accepted" || receipt.runId === undefined) return undefined
    return yield* awaitRun(control, receipt.runId, afterSequence, quiet)
  })

/**
 * The park a decision answers, or nothing for a plan-level decision.
 *
 * `Control.approve` and `Control.deny` restart the run their `ask` parked, in
 * the deciding call. The driver that picks that
 * resume up is this process's own executor, so a command that printed its
 * receipt and returned took the driver down with it and left the run it had
 * just restarted exactly where it stood, still needing `run --resume`, which
 * is the second call the contract says a decision replaces.
 *
 * A plan-level decision has no run yet, and the settlement wait needs one.
 * @category getters
 * @since 1.0.0
 */
export const decisionPark = (
  control: ControlService.Service,
  target: ControlSchema.ApprovalTarget
) => target._tag === "Node" ? latestPark(control, target.runId) : Effect.succeed(undefined)

/**
 * The refusal a declined launch exits with, given what the control plane
 * knows about the run.
 *
 * `control.run.pending` is the executor saying it will not take the run: no
 * seat resolved, a capability was not granted, or the host refused it. The run
 * row is durable and stays at `accepted` with nothing driving it. Printing the
 * launch receipt there said `Accepted` and exited 0, which is the one answer
 * that is wrong in both halves.
 * @category constructors
 * @since 1.0.0
 */
export const declined = (runId: string, summary: ControlSchema.RunSummary | undefined): CliError.UnsupportedError =>
  new CliError.UnsupportedError({
    message: `Run ${runId} was accepted but no executor took it: it is ` +
      `${summary?.status ?? "accepted"} with nothing running. This host drives prompt flows. A flow whose ` +
      `body is a module (\`flow.ts\`) is driven by the host program that registers its delegates, and a flow ` +
      `this project's registry does not hold belongs to another host: run the flow from that program, or end ` +
      `the run with \`smthrs runs cancel ${runId}\`. \`smthrs runs show ${runId}\` shows what it waits for.`
  })

/**
 * Whether the settlement this process waited for was the executor declining.
 * @category predicates
 * @since 1.0.0
 */
export const wasDeclined = (settlement: Settlement | undefined): boolean => settlement?.kind === "control.run.pending"

/**
 * The process status one settlement reports, or nothing when the settlement
 * says nothing about how the run ended.
 *
 * The `up` command promises that an
 * attached launch exits with the terminal status code. The launch contract
 * paragraph is the vocabulary that code is spelled in: 0 success, 1 error, 2
 * usage, 3 parked, 130 SIGINT, 143 SIGTERM. A cancel reports the interrupt
 * status because a cancel is an interruption: `Control.cancel` settles the run
 * through `ControlRuntime.interrupt`, and reporting it separately keeps a
 * cancelled run distinguishable from a failed one.
 *
 * Until this existed, `runLaunch` failed only on `control.run.pending`, so a
 * `control.run.failed` settlement rendered the launch receipt and exited 0.
 * No caller of `smthrs up` could read a red run from the exit code: the
 * release validation measured `smthrs up ci-fast --json` returning 0 in
 * three seconds while `smthrs ps` reported `failed`.
 * @category getters
 * @since 1.0.0
 */
export const status = (settlement: Settlement | undefined): number | undefined => {
  switch (settlement?.kind) {
    case "control.run.completed":
      return 0
    case "control.run.failed":
      return 1
    case "control.run.cancelled":
      return 130
    case "control.run.waiting-approval":
      return 3
    default:
      return undefined
  }
}

/**
 * Reports a settled run's terminal status as this process's exit status.
 *
 * Written after the receipt is rendered, never instead of it: the `--json`
 * contract is that an attached launch prints its receipt, and a caller reads
 * `runId` from that document whatever the run then did. `bin.ts` hands a
 * successful exit whatever `process.exitCode` holds, which is how
 * `smthrs migrate` reports its own status too.
 * @category constructors
 * @since 1.0.0
 */
export const report = (settlement: Settlement | undefined) =>
  Effect.suspend(() => {
    const code = status(settlement)
    return code === undefined ? Effect.void : CommandStatus.set(code)
  })

/**
 * The receipt document to render. Admission stays identifiable while an
 * attached failure states its verdict.
 * @category getters
 * @since 1.0.0
 */
export const receiptDocument = (receipt: ControlSchema.Receipt, settlement: Settlement | undefined): unknown =>
  settlement?.kind === "control.run.failed"
    ? {
      ...receipt,
      status: "failed",
      cause: settlement.cause === undefined ? "no cause recorded in the journal" : causeLine(settlement.cause)
    }
    : receipt

/**
 * Three flows that park, one per durable wait the RC supports.
 *
 * Each one parks where a real run parks: on an unanswered human task, on a
 * durable deferred nobody has completed, or on a timer that has not come due.
 * The waiting-event flow also appends to the execution counter before it parks,
 * so a restart that re-dispatches the step is visible in a file rather than in
 * a claim.
 *
 * @since 1.0.0
 */
import { Action, DurableDeferred, Flow, HumanTask, Interpreter, RetryPolicy, Sleep } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import { Node } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { appendFileSync } from "node:fs"
import { dirname } from "node:path"

/** Which wait a child parks on. */
export type WaitMode = "approval" | "event" | "timer"

/** The step recorded in the execution counter by the waiting-event flow. */
export const preparedStep = "prepared"

/** The externally counted action after a durable timer fires. */
export const timerFiredStep = "timer-fired"

/** The human task's name; its deferred and token are derived from it. */
export const taskName = "release"

/** How many times the question may be re-asked before the task fails. */
export const maxAttempts = 3

/** The signal a waiting-event run is completed with. */
export const EventSignal: DurableDeferred.DurableDeferred<typeof Schema.String> = DurableDeferred.make(
  "e2e/wait/event",
  { success: Schema.String }
)

/** A run that parks on an unanswered question. */
export const ApprovalFlow = Flow.make("e2e/wait/approval", {
  payload: { label: Schema.String },
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: ({ label }) =>
    HumanTask.action.call({
      name: taskName,
      kind: "confirm",
      prompt: `ship ${label}?`,
      maxAttempts
    })
})

/** The declared step of the waiting-event flow. */
export const EventStep = Action.make("e2e/wait/EventStep", {
  payload: { label: Schema.String },
  success: Schema.String
})

/** A run that parks on a durable deferred. */
export const EventFlow = Flow.make("e2e/wait/event", {
  payload: { label: Schema.String },
  success: Schema.String,
  body: (payload) => EventStep.call(payload)
})

/** A counted action that must not execute twice when timer hosts race. */
export const TimerStep = Action.make("e2e/wait/TimerStep", {
  payload: {},
  success: Schema.Void
})

/** A run that parks on a timer, then records one observable action. */
export const TimerFlow = Flow.make("e2e/wait/timer", {
  payload: { millis: Schema.Number },
  success: Schema.Void,
  error: Sleep.SleepRequestInvalid,
  // A second process cannot receive the winning process's in-memory wake.
  // Poll the durable result promptly so the race checks ownership and exactly
  // once execution instead of the default 30-second retry cap's phase.
  suspendedRetryPolicy: RetryPolicy.make({ initialMs: 200, factor: 1.5, maxMs: 2_000 }),
  body: ({ millis }) => Node.andThen(Sleep.action.call({ millis }), TimerStep.call({}))
})

/** Everything a parking child needs. */
export interface WaitOptions {
  readonly filename: string
  readonly counterFile: string
  readonly hostId: string
}

/** The registration layer of the waiting-approval flow. */
export const approvalRegistration = Interpreter.layer(ApprovalFlow).pipe(
  Layer.provideMerge(HumanTask.layer),
  Layer.provideMerge(Action.layerImplementations)
)

/** The registration layer of the waiting-timer flow. */
export const timerRegistration = (options: WaitOptions) =>
  Interpreter.layer(TimerFlow).pipe(
    Layer.provideMerge(Sleep.layer),
    Layer.provideMerge(
      TimerStep.toLayer(() => Effect.sync(() => appendFileSync(options.counterFile, `${timerFiredStep}\n`)))
    ),
    Layer.provideMerge(Action.layerImplementations)
  )

/** The registration layer of the waiting-event flow. */
export const eventRegistration = (options: WaitOptions) =>
  Interpreter.layer(EventFlow).pipe(
    Layer.provideMerge(
      EventStep.toLayer(({ label }) =>
        Effect.gen(function*() {
          yield* Effect.sync(() => appendFileSync(options.counterFile, `${preparedStep}\n`))
          const signalled = yield* DurableDeferred.await(EventSignal)
          return `${label}:${signalled}`
        })
      )
    ),
    Layer.provideMerge(Action.layerImplementations)
  )

/** The Node host options both incarnations of a wait case share. */
export const hostOptions = (options: WaitOptions) => ({
  filename: options.filename,
  workspaceRoot: dirname(options.filename),
  owner: { hostId: options.hostId },
  signals: [] as ReadonlyArray<NodeJS.Signals>
})

/**
 * The host for one registration. Taking the registration itself, not a wait
 * mode, keeps each flow's step requirement in the host's type, so a body run
 * on it is checked against that registration (#2704).
 *
 * @since 1.0.0
 * @category layers
 */
export const host = <ROut, E, RIn>(registration: Layer.Layer<ROut, E, RIn>, options: WaitOptions) =>
  // Fault cases start and replace hosts in quick succession. On a busy CI
  // runner, several independent `jj --version` probes can take longer than
  // the production layer's 5s startup bound even though the binary is healthy.
  // Keep that production default unchanged and give this stress harness a
  // wider probe budget so a scheduler delay is not reported as a host fault.
  NodeRuntime.layerHost(hostOptions(options), registration).pipe(
    Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs, 30_000))
  )

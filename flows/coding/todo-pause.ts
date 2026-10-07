/** TODO controls use the existing durable signal inbox and WaitFor journal. */
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import { Action, Flow, WaitFor } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Option, Schema } from "effect"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import { CodingError } from "./schema.ts"

/** The observation is a recorded step: replay must not re-read a later inbox. */
export const TodoPauseRequested = Action.make("coding/todo-pause-requested", {
  payload: {},
  success: Schema.Struct({ requested: Schema.Boolean, pause: Schema.String, resume: Schema.String }),
  error: CodingError,
  nondeterministic: true
})

export const todoPauseLayer = TodoPauseRequested.toLayer(() => Effect.gen(function*() {
  const owner = yield* Effect.serviceOption(ModuleOwner)
  if (Option.isNone(owner) || owner.value.flowId !== "todo") {
    return yield* Effect.fail(new CodingError({ code: "invalid_receipt", message: "Pause requires a TODO attempt" }))
  }
  const runtime = yield* ControlRuntime
  const signals = yield* runtime.deliveredSignals(owner.value.rootId)
  let generation: number | null = null
  for (const signal of signals) {
    if (signal.name !== "pause" || typeof signal.payload !== "number" ||
      !Number.isSafeInteger(signal.payload) || signal.payload <= 0) continue
    const n = signal.payload
    if (!signals.some((entry) => entry.name === `resume#${n}`) && (generation === null || n > generation)) {
      generation = n
    }
  }
  return { requested: generation !== null, pause: `pause#${generation}`, resume: `resume#${generation}` }
}).pipe(Effect.mapError((error) => new CodingError({ code: "unavailable", message: String(error) }))))

/** A separate deferred per Stop prevents an old Resume from releasing a later Stop.
 * The pause rendezvous first acknowledges the admitted signal. Only the resume
 * wait is Paused; both waits and the inbox observation survive engine replay.
 */
export const TodoBoundary = Flow.make("coding/todo-boundary", {
  payload: {},
  success: Schema.Void,
  error: Schema.Union([CodingError, WaitFor.WaitForRequestInvalid]),
  body: Node.capture({ version: "todo-pause/v1" }, () => TodoPauseRequested.call({}).pipe(
    Node.branch({
      if: Node.capture({}, (request) => request.requested),
      then: Node.capture({}, (request) => WaitFor.action.call({ name: request.pause }).pipe(
        Node.andThen(WaitFor.action.call({ name: request.resume })),
        Node.map(Node.capture({}, () => undefined))
      )),
      else: Node.capture({}, () => Node.succeed(undefined))
    })
  ))
})

/** The coding package's TODO steps. The `todo` composition over them is
 * `flows/todo/flow.ts`; the legacy route interpreter stays available here
 * while already-admitted request histories drain.
 */
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { Action, Flow, FlowRuntime, Interpreter, WaitFor } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Option, Schema } from "effect"
import * as NotificationQueue from "../../packages/smithers/notifications/src/NotificationQueue.ts"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import Request from "./request-flow.ts"
import { CodingError, RequestInput, RequestResult } from "./schema.ts"
import { renderFeedback } from "./steering.ts"
import { TodoBoundary } from "./todo-pause.ts"
import { readTodoDelivery } from "./vibe-evidence.ts"
import Vibe, { VibeError } from "./vibe-flow.ts"
import { VibeDelivered } from "./vibe-schema.ts"
import { VibeInput } from "./vibe-schema.ts"

// Keep the legacy route interpreter available while admitted requests drain.
export { Route } from "./schema.ts"
export {
  clipTodo,
  leafFeedback,
  MAX_TODO_BYTES,
  RouteRequest,
  RouteTodo,
  routeTodo,
  StampRoute,
  todoLayers,
  todoRouter
} from "./todo-route.ts"

/** No caller-supplied child ID: only a current-attempt host binding may
 * resolve the planner receipt used by the existing delivery implementation.
 * The existing candidate provider still authorizes submission against the
 * current attempt and machine; this action only resolves retained evidence.
 */
export const TodoDelivery = Action.make("coding/todo-delivery", {
  payload: { request: RequestResult },
  success: VibeInput,
  error: CodingError,
  nondeterministic: true
})

export const todoDeliveryLayer = TodoDelivery.toLayer(readTodoDelivery).pipe(Layer.provide(RunCatalogRead.layer))

/** The existing notification inbox is also the trailing review rendezvous.
 * Empty observations are not action results: a resumed action reads again.
 * Draining the same boundary replays its exact input after a crash.
 */
export const TodoReviewInput = Action.make("coding/todo-review-input", {
  payload: {},
  success: Schema.String,
  error: CodingError,
  nondeterministic: true
})
const reviewInputLayer = TodoReviewInput.toLayer(() =>
  Effect.gen(function*() {
    const owner = yield* Effect.serviceOption(ModuleOwner)
    if (Option.isNone(owner) || owner.value.flowId !== "todo") {
      return yield* new CodingError({ code: "unavailable", message: "Review input requires its TODO attempt" })
    }
    const instance = yield* FlowRuntime.FlowInstance
    const queue = yield* NotificationQueue.NotificationQueue
    for (let rung = 0;; rung++) {
      const boundary = `todo-review:${instance.executionId}:${rung}`
      const receipt = yield* queue.drain({
        runId: owner.value.rootId,
        targetLineageId: owner.value.rootId,
        boundary,
        wouldIdle: true
      })
        .pipe(
          Effect.mapError(() => new CodingError({ code: "unavailable", message: "Review input could not be read" }))
        )
      if (receipt.notifications.length > 0) return renderFeedback({ boundary, messages: receipt.notifications })
      if (!receipt.duplicate) break
    }
    yield* FlowRuntime.annotateWaiting({ reason: "event", request: JSON.stringify({ kind: "stack" }) })
    return yield* Flow.suspend(instance)
  })
)

const ReviewPayload = Schema.Struct({ input: RequestInput })
const ReviewError = Schema.Union([Request.errorSchema, VibeError, CodingError, WaitFor.WaitForRequestInvalid])
type ReviewFlow = Flow.Flow<
  "coding/todo-review",
  typeof ReviewPayload,
  typeof VibeDelivered,
  typeof ReviewError,
  Action.Requirement<"coding/todo-review-input" | "coding/todo-delivery">
>
/** Each review round keeps the root's attempt, pin and working copy. It does
 * not import the initial stack base again or launch a new TODO run.
 */
export const TodoReview: ReviewFlow = Flow.make("coding/todo-review", {
  payload: ReviewPayload,
  success: VibeDelivered,
  error: ReviewError,
  body: ({ input }: typeof ReviewPayload.Type) => {
    const { base: _, ...continuation } = input
    return TodoReviewInput.call({}).pipe(
      Node.bindPlanned((feedback) =>
        TodoBoundary.child({}).pipe(
          Node.andThen(Request.child({ ...continuation, feedback }))
        )
      ),
      Node.bindPlanned((request) => TodoDelivery.call({ request })),
      Node.bindPlanned((delivery) => Vibe.call(delivery)),
      Node.bindPlanned((delivered) => Node.succeed(delivered).pipe(Node.andThen(TodoReview.child({ input }))))
    )
  }
})
export const todoReviewLayer = Layer.merge(reviewInputLayer, Interpreter.layer(TodoReview))

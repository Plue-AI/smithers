/** The coding package's TODO steps. The `todo` composition over them is
 * `flows/todo/flow.ts`; the legacy route interpreter stays available here
 * while already-admitted request histories drain.
 */
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { Action, FlowRuntime } from "@smthrs/flow"
import { Effect, Layer } from "effect"
import Request from "./request/flow.ts"
import { CodingError, RequestResult } from "./schema.ts"
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

/** The delivery step of the `todo` composition: it names the composition's
 * own request child for the delivery child to finalize. No caller supplies
 * the ID: the handler reads the one completed `coding/Request` child of the
 * composition execution it runs in, from this host's run catalog.
 */
export const TodoDelivery = Action.make("coding/todo-delivery", {
  payload: { request: RequestResult },
  success: VibeInput,
  error: CodingError
})

const refuse = (message: string) => new CodingError({ code: "invalid_receipt", message })

export const todoDeliveryLayer = TodoDelivery.toLayer(() =>
  Effect.gen(function*() {
    const instance = yield* FlowRuntime.FlowInstance, catalog = yield* RunCatalogRead.RunCatalogRead
    const children = yield* catalog.listRuns({
      filters: { flowName: Request._tag, parentRunId: instance.executionId },
      limit: 2
    })
    if (children.cursor !== null || children.runs.length !== 1) {
      return yield* Effect.fail(
        refuse(`The TODO flow ${instance.executionId} has ${children.runs.length} request children, not one`)
      )
    }
    return { requestExecutionId: children.runs[0]!.runId }
  }).pipe(Effect.mapError((error) =>
    error instanceof CodingError ? error : refuse("The TODO flow's request child could not be read")
  ))
).pipe(Layer.provideMerge(RunCatalogRead.layer))

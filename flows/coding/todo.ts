/** The coding package's TODO steps. The `todo` composition over them is
 * `flows/todo/flow.ts`; the legacy route interpreter stays available here
 * while already-admitted request histories drain.
 */
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { Action, FlowRuntime } from "@smthrs/flow"
import { Effect, Layer, Option } from "effect"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import { Request } from "./request.ts"
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

/** Resolve only this composition’s completed Request child. Finalization
 * independently validates its retained result, input and approved ancestry. */
export const TodoDelivery = Action.make("coding/todo-delivery", {
  payload: { request: RequestResult },
  success: VibeInput,
  error: CodingError
})

export const todoDelivery = Effect.gen(function*() {
  const owner = yield* Effect.serviceOption(ModuleOwner)
  if (Option.isNone(owner) || owner.value.flowId !== "todo") {
    return yield* Effect.fail(
      new CodingError({ code: "invalid_receipt", message: "TODO delivery requires its approved composition" })
    )
  }
  const instance = yield* FlowRuntime.FlowInstance
  const catalog = yield* RunCatalogRead.RunCatalogRead
  const children = yield* catalog.listRuns({
    filters: { flowName: Request._tag, parentRunId: instance.executionId },
    limit: 2
  })
  if (children.cursor !== null || children.runs.length !== 1 || children.runs[0]!.status !== "completed") {
    return yield* Effect.fail(
      new CodingError({ code: "invalid_receipt", message: "TODO delivery requires one completed Request child" })
    )
  }
  return { requestExecutionId: children.runs[0]!.runId }
}).pipe(Effect.mapError((error) =>
  error instanceof CodingError ? error : new CodingError({
    code: "unavailable",
    message: "The TODO request receipt could not be read"
  })
))

export const todoDeliveryLayer = TodoDelivery.toLayer(() => todoDelivery).pipe(Layer.provideMerge(RunCatalogRead.layer))

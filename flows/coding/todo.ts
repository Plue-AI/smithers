/** The coding package's TODO steps. The `todo` composition over them is
 * `flows/todo/flow.ts`; the legacy route interpreter stays available here
 * while already-admitted request histories drain.
 */
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { Action } from "@smthrs/flow"
import { Layer } from "effect"
import { CodingError, RequestResult } from "./schema.ts"
import { readTodoDelivery } from "./vibe-evidence.ts"
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

/** The coding package's TODO steps. The `todo` composition over them is
 * `flows/todo/flow.ts`; the legacy route interpreter stays available here
 * while already-admitted request histories drain.
 */
import { Action } from "@smthrs/flow"
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

/** No caller-supplied child ID: only a current-attempt host binding may
 * resolve the planner receipt used by the existing delivery implementation.
 * Deliberately unimplemented until the durable candidate provider is wired
 * (T-STK-12); an interpreter cannot dispatch the composition without it.
 */
export const TodoDelivery = Action.make("coding/todo-delivery", {
  payload: { request: RequestResult },
  success: VibeInput,
  error: CodingError
})

/** The unmounted TODO head reuses the retained planner and delivery steps.
 * Admission stays dark until the host can bind the completed child receipt
 * to the current attempt. The old Vibe input cannot safely infer that identity.
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import Request from "./request/flow.ts"
import { CodingError, RequestInput, RequestResult, StackBase } from "./schema.ts"
import { VibeDelivered, VibeInput } from "./vibe-schema.ts"
import Vibe, { VibeError } from "./vibe/flow.ts"

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
 * Deliberately unimplemented until the durable candidate provider is wired;
 * an interpreter cannot dispatch this composition without that capability.
 */
export const TodoDelivery = Action.make("coding/todo-delivery", {
  payload: { request: RequestResult },
  success: VibeInput,
  error: CodingError
})

export const Todo = Flow.make("todo", {
  description: "Route, plan, implement and deliver one TODO.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: Schema.Struct({ ...RequestInput.fields, base: StackBase }),
  success: VibeDelivered,
  error: Schema.Union([Request.errorSchema, VibeError]),
  body: (input) =>
    Request.child(input).pipe(
      Node.bindPlanned((request) => TodoDelivery.call({ request })),
      Node.bindPlanned((delivery) => Vibe.child(delivery))
    )
})
export default Todo

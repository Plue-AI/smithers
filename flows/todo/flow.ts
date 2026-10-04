/** The built-in TODO composition: route, plan, implement and deliver one TODO
 * over the coding package's step flows. A repository overrides it by copying
 * only this file to `flows/todo/flow.ts` and importing the steps it keeps.
 * The stack engine launches it once per attempt, pinned to its digest, and
 * keeps verification and review as its own launches. No host serves it,
 * packaged or overridden, until pinned-source activation (T-FLW-03/04) binds
 * each launch to its attempt (flows/repository/registry.ts).
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import Request from "../coding/request/flow.ts"
import { RequestInput, StackBase } from "../coding/schema.ts"
import { TodoDelivery } from "../coding/todo.ts"
import { VibeDelivered } from "../coding/vibe-schema.ts"
import Vibe, { VibeError } from "../coding/vibe/flow.ts"

export default Flow.make("todo", {
  description: "Route, plan, implement and deliver one TODO.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  // Only stack admission starts an attempt; a model never launches one.
  modelInvocable: false,
  payload: Schema.Struct({ ...RequestInput.fields, base: StackBase }),
  success: VibeDelivered,
  error: Schema.Union([Request.errorSchema, VibeError]),
  body: (input) =>
    Request.child(input).pipe(
      Node.bindPlanned((request) => TodoDelivery.call({ request })),
      Node.bindPlanned((delivery) => Vibe.child(delivery))
    )
})

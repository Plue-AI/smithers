/** The built-in TODO composition: route, plan, implement and deliver one TODO
 * over the coding package's step flows (`@smthrs/coding`). A repository
 * overrides it by copying only this file to `flows/todo/flow.ts`; the steps it
 * keeps come from the coding host the install ships. The stack engine
 * launches it once per attempt, pinned to the Active version at a main
 * commit, and keeps verification and review as its own launches. The lane's
 * host reads that version from that commit and serves it to that launch alone
 * (flows/repository/pinned.ts).
 */
import { Request, RequestInput, StackBase, TodoDelivery, Vibe, VibeDelivered, VibeError } from "@smthrs/coding"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

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

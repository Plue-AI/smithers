import { Flow, HumanTask } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { Child, Prepare } from "./layer.ts"
export { layer } from "./layer.ts"

const entry = "approved-entry"
export default Flow.make("snapshot", {
  description: "Keep an approved module closure across child calls.",
  capabilities: ["fs:read:**", "fs:write:**"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { root: Schema.String, edit: Schema.Boolean, park: Schema.Boolean, early: Schema.Boolean, concurrent: Schema.Boolean },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: Node.capture({}, ({ root, edit, park, early, concurrent }) =>
    Prepare.call({ root, early }).pipe(Node.andThen(concurrent
      ? Node.all({
        first: Child.child({ root, edit, entry, index: 1 }),
        second: Child.child({ root, edit, entry, index: 2 }),
        third: Child.child({ root, edit, entry, index: 3 })
      }).pipe(Node.map(({ third }) => third))
      : Child.child({ root, edit, entry, index: 1 }).pipe(
      Node.andThen(park
        ? HumanTask.action.call({ name: "source-snapshot", kind: "ask", prompt: "Continue?", maxAttempts: 3 })
        : Node.succeed(null)),
      Node.andThen(Child.child({ root, edit, entry, index: 2 })),
      Node.andThen(Child.child({ root, edit, entry, index: 3 }))
    ))))
})

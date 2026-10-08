/** Appendix B.4 controls whose providers arrive with their card tickets. */
import { Schema } from "effect"
import { operation, type Operation, type OperationPayload } from "./index"
const N = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Text = Schema.NonEmptyString
const Todo = Schema.Struct({ n: N })
const MovedTodo = Schema.Struct({ n: N, id: Schema.optional(Text) })
const Branch = Schema.Struct({ branch: Text })
const Foreign = Schema.Struct({ branch: Text, id: Text, revision: Text })
const Learning = Schema.Struct({ id: Text })
const controlHttp = (name: string): NonNullable<Operation["http"]> | null =>
  name === "branch.rebase-now" ? { method: "POST" as const, path: "/api/branches/{branch}", defaults: { rebase: true } } : name === "todo.return-to-item" || name === "todo.keep-moved" ? { method: "POST" as const, path: "/api/todos/{n}", defaults: { op: name === "todo.return-to-item" ? "return-to-item" : "keep-moved" } } : name === "order.ok" ? { method: "POST" as const, path: "/api/stack/attention/{id}", body: { revision: "revision" } } : name === "branch.discard-foreign" || name === "branch.bring-in" ? { method: "POST" as const, path: "/api/branches/{branch}", defaults: { op: name === "branch.bring-in" ? "bring-in" : "discard-foreign" } } : name === "main.reset-to-github" ? { method: "POST" as const, path: "/api/stack/attention/{id}", body: { old: "old", new: "new" } } : name === "learning.accept" ? { method: "POST" as const, path: "/api/proposals/{id}/accept" } : name === "learning.dismiss" ? { method: "POST" as const, path: "/api/proposals/{id}/dismiss" } : null
const control = <const Name extends string, I extends OperationPayload>(name: Name, summary: string, input: I,
  agent: "run" | "confirm" | "never", minimumRole: "member" | "maintainer" | "owner" = "member") =>
  operation({ name, summary, input, agent, hidden: true, minimumRole, visibility: "in-card", slash: null, cli: null, http: controlHttp(name),
    journey: [], group: "", actors: agent === "never" ? ["person"] as const : ["person", "app_agent"] as const })

export const pendingControls = [
  control("todo.preapprove", "Pre-approve", Todo, "never", "maintainer"),
  control("todo.unapprove", "Remove pre-approval", Todo, "never", "maintainer"),
  control("todo.return-to-item", "Return to this TODO", MovedTodo, "run"),
  control("todo.keep-moved", "Keep for now", MovedTodo, "never"),
  control("branch.bring-in", "Bring in", Foreign, "confirm"),
  control("branch.discard-foreign", "Discard", Schema.Struct({ branch: Text, id: Text, revision: Text }), "confirm", "maintainer"),
  operation({ name: "branch.rebase-now", summary: "Rebase now", input: Branch, agent: "run", hidden: false,
    minimumRole: "member", visibility: "core", slash: "/rebase", cli: null, http: controlHttp("branch.rebase-now"),
    journey: ["J7"], group: "Branches and machines", actors: ["person", "app_agent"] }),
  control("learning.accept", "Make TODO", Learning, "confirm"),
  control("learning.dismiss", "Dismiss", Learning, "confirm"),
  control("todo.takeover", "Take over", Todo, "never", "maintainer"),
  control("merge.confirm", "Review & merge", Schema.Struct({ n: N, revision: Text }), "never", "maintainer"),
  control("order.ok", "OK", Schema.Struct({ id: Text, revision: N }), "never", "maintainer"),
  control("main.reset-to-github", "Reset to GitHub main", Schema.Struct({ id: Text, old: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)), new: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)) }), "never", "owner"),
  control("settings.model.set", "Change model", Schema.Struct({ role: Schema.Literals(["fast", "coding", "jev"]), model: Text }), "never", "owner")
] as const

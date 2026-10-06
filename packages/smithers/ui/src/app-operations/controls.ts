/** Appendix B.4 controls whose providers arrive with their card tickets. */
import { Schema } from "effect"
import { operation, type OperationPayload } from "./index"
const N = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Text = Schema.NonEmptyString
const Todo = Schema.Struct({ n: N })
const Branch = Schema.Struct({ branch: Text })
const Foreign = Schema.Struct({ branch: Text, revision: Text })
const Learning = Schema.Struct({ id: Text })
const control = <const Name extends string, I extends OperationPayload>(name: Name, summary: string, input: I,
  agent: "run" | "confirm" | "never", minimumRole: "member" | "maintainer" | "owner" = "member") =>
  operation({ name, summary, input, agent, hidden: true, minimumRole, visibility: "in-card", slash: null, cli: null, http: name === "learning.accept" ? { method: "POST" as const, path: "/api/proposals/{id}/accept" } : name === "learning.dismiss" ? { method: "POST" as const, path: "/api/proposals/{id}/dismiss" } : null,
    journey: [], group: "", actors: agent === "never" ? ["person"] as const : ["person", "app_agent"] as const })

export const pendingControls = [
  control("todo.preapprove", "Pre-approve", Todo, "never", "maintainer"),
  control("todo.unapprove", "Remove pre-approval", Todo, "never", "maintainer"),
  control("todo.return-to-item", "Return to this TODO", Todo, "run"),
  control("todo.keep-moved", "Keep for now", Todo, "never"),
  control("branch.bring-in", "Bring in", Foreign, "confirm"),
  control("branch.discard-foreign", "Discard", Foreign, "confirm", "maintainer"),
  control("branch.rebase-now", "Rebase now", Branch, "run"),
  control("learning.accept", "Make TODO", Learning, "confirm"),
  control("learning.dismiss", "Dismiss", Learning, "confirm"),
  control("todo.takeover", "Take over", Todo, "never", "maintainer"),
  control("merge.confirm", "Review & merge", Schema.Struct({ n: N, revision: Text }), "never", "maintainer"),
  control("order.ok", "OK", Todo, "never", "maintainer"),
  control("main.reset-to-github", "Reset to GitHub main", Schema.Struct({ revision: Text }), "never", "owner"),
  control("settings.model.set", "Change model", Schema.Struct({ role: Schema.Literals(["fast", "coding", "jev"]), model: Text }), "never", "owner")
] as const

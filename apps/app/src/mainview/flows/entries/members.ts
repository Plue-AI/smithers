import { Schema } from "effect"
import { flow, NoPayload } from "./Declare"
import { membersUnavailable } from "../../state/seams/MembersSeam"

/** Not registered: T-CAT-01 must bind these person-only commands to the production authorizer. */
export const membersFlows = () => [
  flow({ name: "members", summary: "Members", input: NoPayload, userOnly: true,
    userOnlyReason: "Only a person can do this", handler: () => membersUnavailable.message }),
  ...(["members.add", "members.role", "members.remove"] as const).map(name => flow({
    name, summary: name === "members.add" ? "Add" : name === "members.role" ? "Role" : "Remove",
    hidden: true, userOnly: true, userOnlyReason: "Only a person can do this",
    input: Schema.Struct({ login: Schema.String, role: Schema.optional(Schema.Literals(["maintainer", "member"])) }),
    handler: () => membersUnavailable.message
  }))
]

import { Schema } from "effect"
import { flow, NoPayload, type CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"

const MEMBER = Schema.Struct({ login: Schema.String, role: Schema.optional(Schema.Literals(["maintainer", "member"])) })
const REASON = "Only a person can do this"

/* Person-only doors (§6.15): the app agent has no path to people. On an install they run GET/POST/PATCH/DELETE /api/members;
 * elsewhere the seeded roster (MOCK SEAM, DesignWorld/settings.ts) answers. */
export const membersFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "members", summary: "Add people and manage roles", input: NoPayload, userOnly: true, userOnlyReason: REASON,
    handler: async () => { await actions.presentCard("members", "Members"); actions.showMembers() } }),
  flow({ name: "members.add", summary: "Add", hidden: true, userOnly: true, userOnlyReason: REASON, input: MEMBER,
    handler: ({ login, role }) => actions.changeMembers("members.add", { login, role }) }),
  flow({ name: "members.role", summary: "Role", hidden: true, userOnly: true, userOnlyReason: REASON, input: MEMBER,
    handler: ({ login, role }) => actions.changeMembers("members.role", { login, role: role ?? "member" }) }),
  flow({ name: "members.remove", summary: "Remove", hidden: true, userOnly: true, userOnlyReason: REASON, input: MEMBER,
    handler: ({ login }) => actions.changeMembers("members.remove", { login }) })
]

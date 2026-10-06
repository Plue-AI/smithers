import { Schema } from "effect"
import { flow, NoPayload, type CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"

const MEMBER = Schema.Struct({ login: Schema.String, role: Schema.optional(Schema.Literals(["maintainer", "member"])) })
const REASON = "Only a person can do this"

/* Person-only doors (§6.15): the app agent has no path to people. On an install they run GET/POST/PATCH/DELETE /api/members;
 * elsewhere the seeded roster (MOCK SEAM, DesignWorld/settings.ts) answers. */
export const membersFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "members", agent: "never",   slash: "/members", cli: null, journey: ["J1"], group: "Account and settings", visibility: "core", actors: ["person"], minimumRole: "maintainer", http: null, summary: "Add people and manage roles", input: NoPayload, agentReason: REASON,
    handler: async () => { await actions.presentCard("members", "Members"); actions.showMembers() } }),
  flow({ name: "members.add", agent: "never", minimumRole: "maintainer", actors: ["person"], visibility: "in-card",  summary: "Add", hidden: true, agentReason: REASON, input: MEMBER,
    handler: ({ login, role }) => actions.changeMembers("members.add", { login, role }) }),
  flow({ name: "members.role", agent: "never", minimumRole: "maintainer", actors: ["person"], visibility: "in-card",  summary: "Role", hidden: true, agentReason: REASON, input: MEMBER,
    handler: ({ login, role }) => actions.changeMembers("members.role", { login, role: role ?? "member" }) }),
  flow({ name: "members.remove", agent: "never", minimumRole: "maintainer", actors: ["person"], visibility: "in-card",  summary: "Remove", hidden: true, agentReason: REASON, input: MEMBER,
    handler: ({ login }) => actions.changeMembers("members.remove", { login }) })
]

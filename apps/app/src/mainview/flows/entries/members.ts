import { Schema } from "effect"
import { flow, NoPayload, type CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"
// MOCK SEAM: members.* write the seeded design world until /api/members answers.
import { designMembers, designViewerRole } from "../../state/seams/DesignWorld/settings"

const MEMBER = Schema.Struct({ login: Schema.String, role: Schema.optional(Schema.Literals(["maintainer", "member"])) })
const REASON = "Only a person can do this"
/* A maintainer or the owner manages people; the app agent has no path here (person-only doors). */
const managed = (actions: CommandActions, act: () => string | { readonly value: string }) =>
  designViewerRole(actions.design) === "member" ? "A maintainer manages members" : act()

export const membersFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "members", summary: "Add people and manage roles", input: NoPayload, userOnly: true, userOnlyReason: REASON,
    handler: async () => { await actions.presentCard("members", "Members") } }),
  flow({ name: "members.add", summary: "Add", hidden: true, userOnly: true, userOnlyReason: REASON, input: MEMBER,
    handler: ({ login, role }) => managed(actions, () => designMembers(actions.design).add(login, role)) }),
  flow({ name: "members.role", summary: "Role", hidden: true, userOnly: true, userOnlyReason: REASON, input: MEMBER,
    handler: ({ login, role }) => managed(actions, () => designMembers(actions.design).role(login, role ?? "member")) }),
  flow({ name: "members.remove", summary: "Remove", hidden: true, userOnly: true, userOnlyReason: REASON, input: MEMBER,
    handler: ({ login }) => managed(actions, () => designMembers(actions.design).remove(login)) })
]

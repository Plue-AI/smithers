import type { Action } from "../../src/CardAction.ts"
import type { MembersCard } from "../../src/MembersCard.ts"
import { ben, ben_color, placeholder_avatar, will, will_color } from "./_shared.ts"
import { type Story, story } from "./_story.ts"

type Member = MembersCard["members"][number]
const access_url = "https://github.com/smithersai/smithers/settings/access"
const sam = {
  login: "sam",
  name: "Sam Lee",
  avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
  color_index: 2
}
const willRow = { ...will, color_index: will_color }
const benRow = { ...ben, color_index: ben_color }
const roles = ["owner", "maintainer", "member"]
const role = (login: string, value: string): Action => ({
  tag: "members.role",
  label: "Role",
  args: { login },
  input: [{ name: "role", label: "Role", kind: "choice", choices: roles, required: true, value }]
})
const remove = (login: string): Action => ({ tag: "members.remove", label: "Remove", args: { login } })
// What a maintainer sees: every row but the owner's carries Role and Remove.
const row = (
  person: typeof ben & { readonly color_index: number },
  value: Member["role"],
  flags: Partial<Member> = {}
): Member => ({
  ...person,
  role: value,
  needs_access: false,
  suspended: false,
  actions: value === "owner" ? [] : [role(person.login, value), remove(person.login)],
  ...flags
})
const add: Action = {
  tag: "members.add",
  label: "Add",
  primary: true,
  input: [
    { name: "login", label: "GitHub username", kind: "text", required: true },
    { name: "role", label: "Role", kind: "choice", choices: ["maintainer", "member"], required: true, value: "member" }
  ]
}
const team: MembersCard = {
  access_url,
  members: [row(willRow, "owner"), row(benRow, "maintainer"), row(sam, "member")]
}

export const fixtures = {
  empty: story("Only the owner", { access_url, members: [row(willRow, "owner")] }, {
    actions: [add],
    expect: ["Will Cory", "Add"]
  }),
  team: story("Owner, maintainer and member", team, {
    actions: [add],
    expect: ["Will Cory", "Ben Carter", "Sam Lee", "Role", "Remove"]
  }),
  needs_access: story(
    "A member who never had write access",
    { access_url, members: [row(willRow, "owner"), row(benRow, "member", { needs_access: true })] },
    { actions: [add], expect: ["Ben Carter"] }
  ),
  suspended: story(
    "A member suspended after losing write access",
    { access_url, members: [row(willRow, "owner"), row(benRow, "member", { suspended: true })] },
    { actions: [add], expect: ["Ben Carter"] }
  ),
  suspended_needs_access: story(
    "Suspended and needing access",
    { access_url, members: [row(benRow, "maintainer", { needs_access: true, suspended: true })] },
    { actions: [add], expect: ["Ben Carter"] }
  ),
  member_view: story(
    "The roster as a member sees it",
    { access_url, members: team.members.map((member) => ({ ...member, actions: [] })) },
    { expect: ["Sam Lee"] }
  ),
  placeholder_avatar: story(
    "A member with the bundled avatar",
    { access_url, members: [row({ ...sam, avatar_url: placeholder_avatar }, "member")] },
    { actions: [add], expect: ["Sam Lee"] }
  )
} satisfies Record<string, Story<MembersCard>>

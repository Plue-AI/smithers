import { fixtures } from "@smthrs/rpc/fixtures/Members"
import type { Action } from "@smthrs/rpc/CardAction"
import { MembersView } from "./MembersView"
import type { ViewStory } from "./stories"

// Literal C-UI-12 oracles: spec §14.3 Members, §5.1.3 and People.tsx copy.
const expects = {
  empty: ["Members", "Will Cory", "Owner", "Add"],
  team: ["Will Cory", "Ben Carter", "Sam Lee", "Owner", "Maintainer", "Member", "Remove"],
  needs_access: ["Ben Carter", "needs access on GitHub"],
  suspended: ["Ben Carter", "lost access on GitHub"],
  suspended_needs_access: ["Ben Carter", "lost access on GitHub"],
  member_view: ["Will Cory", "Ben Carter", "Sam Lee", "Owner", "Maintainer", "Member"],
  placeholder_avatar: ["Sam Lee", "Member"],
}
const add: Action = { tag: "members.add", label: "Add", args: { login: "alice", role: "member" } }
const role = (login: string, value: string): Action => ({ tag: "members.role", label: "Role", args: { login, role: value } })
const remove = (login: string): Action => ({ tag: "members.remove", label: "Remove", args: { login } })
const expectedActions: Record<keyof typeof fixtures, Action[]> = {
  empty: [add], team: [role("ben", "maintainer"), remove("ben"), role("sam", "member"), remove("sam"), add],
  needs_access: [role("ben", "member"), remove("ben"), add], suspended: [role("ben", "member"), remove("ben"), add],
  suspended_needs_access: [role("ben", "maintainer"), remove("ben"), add], member_view: [],
  placeholder_avatar: [role("sam", "member"), remove("sam"), add],
}
export const stories: ViewStory[] = Object.entries(fixtures).map(([key, fixture]) => ({
  name: key, expect: expects[key as keyof typeof expects], actions: expectedActions[key as keyof typeof fixtures],
  interactions: [
    ...fixture.model.members.flatMap(member => member.actions.filter(action => action.input).map(() => ({ selector: `[data-login="${member.login}"] select`, event: "change" as const, value: member.role }))),
    ...(fixture.actions.length ? [{ selector: '.mvp-add-row input', event: "input" as const, value: "alice" }, { selector: '.mvp-add-row select', event: "change" as const, value: "member" }] : []),
  ],
  render: ({ onAction, onView }, actions) => {
    // Ordinary renders pass every supplied action unchanged; only step 3 removes one.
    let removeFirst = actions !== undefined
    const keep = () => { if (removeFirst) { removeFirst = false; return false }; return true }
    const members = fixture.model.members.map(member => ({ ...member, actions: member.actions.filter(keep) }))
    const footer = fixture.actions.filter(keep)
    return <MembersView {...fixture} model={{ ...fixture.model, members }}
      actions={footer.map(action => ({ ...action, input: action.input?.map(field => field.name === "login" ? { ...field, value: "alice" } : field) }))} onAction={onAction} onView={onView} />
  },
}))

stories.push({
  name: "disabled", expect: ["Members", "Add", "Checking access"],
  actions: [{ tag: "members.add", label: "Add", disabled: { reason: "Checking access" } }],
  render: (callbacks, actions = [{ tag: "members.add", label: "Add", disabled: { reason: "Checking access" } }]) => <MembersView model={{ members: [], access_url: "https://github.com/smithersai/smithers/settings/access" }} actions={actions as Action[]} gestures={{}} view={{ maximized: false }} {...callbacks} />,
})

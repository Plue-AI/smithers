import { useSyncExternalStore, type ComponentType } from "react"
import { useController } from "../ControllerContext"
import type { CardActions, CardFamily } from "./CardFamily"
import { MembersCardSchema, type MembersViewProps } from "@smthrs/rpc/MembersCard"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "../flows/cardActions"
import { toActor } from "../state/ProductActor"
import type { MembersSnapshots } from "../state/seams/MembersSeam"
import { validMemberLogin } from "../state/seams/MembersSeam"
import { MembersView } from "./views/MembersView"

export function MembersCard({ roster, role, dispatch, View = MembersView, view, onView }: {
  readonly roster: MembersSnapshots
  readonly role: "owner" | "maintainer" | "member"
  readonly dispatch: CardCommandDispatch
  readonly View?: ComponentType<MembersViewProps>
  readonly view: MembersViewProps["view"]
  readonly onView: MembersViewProps["onView"]
}) {
  const snapshot = useSyncExternalStore(roster.subscribe, roster.get, roster.get)
  if (!snapshot.model) return null
  const source = MembersCardSchema.parse(snapshot.model)
  const definitions: CardActionDefinition[] = []
  if (role !== "member") definitions.push({ tag: "members.add", label: "Add", command_input: { login: "", role: "member" },
    input: [{ name: "login", label: "GitHub username", kind: "text", required: true }],
    resolve_input: input => ({ login: input.login ?? "", role: "member" }) })
  const model = { ...source, members: source.members.map(member => {
    const actor = toActor({ person: member.login }, [{ ...member, id: member.login }])
    if (role !== "member" && member.role !== "owner") {
      definitions.push({ tag: "members.role", label: "Role", args: { login: member.login },
        command_input: { login: member.login, role: member.role },
        input: [{ name: "role", label: "Role", kind: "choice", choices: ["maintainer", "member"], required: true, value: member.role }],
        resolve_input: input => ({ login: member.login, role: input.role === "maintainer" ? "maintainer" : "member" }) },
      { tag: "members.remove", label: "Remove", args: { login: member.login }, command_input: { login: member.login } })
    }
    return { ...member, name: actor.kind === "person" ? actor.name : member.name, actions: [] as typeof member.actions }
  }) }
  // Row args select the binding; incoming server actions are never command authority.
  const bindings = cardActions((tag, input) => {
    if (tag === "members.add" && !validMemberLogin((input as { login: string }).login)) return
    return dispatch(tag, input)
  }, definitions)
  for (const member of model.members) member.actions = bindings.actions.filter(action => action.args?.login === member.login)
  return <View model={model} actions={bindings.actions.filter(action => !action.args?.login)} gestures={bindings.gestures}
    onAction={bindings.onAction} view={view} onView={onView} />
}

/* The members card (card-kinds.md L5): subject only; maintainers and the owner manage people. On an install the roster is
 * GET /api/members; elsewhere it is the seeded roster (MOCK SEAM, DesignWorld/settings.ts). */
const MembersBody = ({ presentation }: { readonly presentation: CardActions["presentation"] }) => {
  const controller = useController()
  const roster = controller.membersRoster
  useSyncExternalStore(roster.subscribe, roster.get, roster.get)
  return <MembersCard roster={roster} role={controller.membersRole()} view={{ maximized: presentation === "maximized" }} onView={() => {}}
    dispatch={(tag, input) => controller.commands.submit({ name: tag, payload: (input ?? {}) as Record<string, unknown>, actor: "user" })} />
}
export const membersCardFamily: CardFamily<"members"> = { members: { render: (_card, { presentation }) => <MembersBody presentation={presentation} />, pill: () => "" } }

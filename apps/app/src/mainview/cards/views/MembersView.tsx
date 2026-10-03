import { ExternalLink } from "lucide-react"
import type { MembersViewProps } from "@smthrs/rpc/MembersCard"
import { MemberAction } from "./MembersActionView"
import { ActorChip, actorName } from "./ActorChip"

const roleWords: Record<string, string> = { owner: "Owner", maintainer: "Maintainer", member: "Member" }

export function MembersView({ model, actions, onAction }: MembersViewProps) {
  const rows = []
  for (const member of model.members) {
    const controls = []
    for (const action of member.actions) controls.push(<MemberAction key={action.tag} action={action} onAction={onAction} />)
    const actor = { kind: "person" as const, login: member.login, name: member.name, avatar_url: member.avatar_url, color_index: member.color_index }
    rows.push(<li key={member.login} data-login={member.login}>
      <ActorChip actor={actor} size="s" />
      <span className="mvp-member-name" title={actorName(actor)}>{member.name}</span>
      <span className="mvp-member-login">@{member.login}</span>
      {member.suspended || member.needs_access ? <a className="mvp-access" href={model.access_url} target="_blank" rel="noreferrer">{member.suspended ? "lost access on GitHub" : "needs access on GitHub"}<ExternalLink size={12} aria-hidden="true" /></a> : <span />}
      <span className="mvp-member-controls">
        {!member.actions.some(action => action.input?.some(field => field.name === "role")) ? <span className="mvp-role">{roleWords[member.role]}</span> : null}
        {controls}
      </span>
    </li>)
  }
  const footer = []
  for (const action of actions) footer.push(<MemberAction key={action.tag} action={action} onAction={onAction} />)
  return <section className="mvp-members-view" data-kind="members" data-keyboard-pane="Members" aria-label="Members">
    <h2>Members</h2>
    <ul className="mvp-members">
      {rows}
    </ul>
    <div className="mvp-add-row">{footer}</div>
  </section>
}

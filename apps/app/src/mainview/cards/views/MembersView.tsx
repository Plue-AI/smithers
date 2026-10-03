import { useState, type ChangeEvent, type FormEvent } from "react"
import type { Action } from "@smthrs/rpc/CardAction"
import { ExternalLink } from "lucide-react"
import type { MembersViewProps } from "@smthrs/rpc/MembersCard"
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

// Inputs and available choices are supplied by the Container, never role policy here.
function MemberAction({ action, onAction }: { action: Action; onAction: MembersViewProps["onAction"] }) {
  const signature = JSON.stringify([action.tag, action.args, action.input])
  const [draft, setDraft] = useState<{ signature: string; values: Record<string, string> }>({ signature, values: {} })
  const values = draft.signature === signature ? draft.values : {}
  if (draft.signature !== signature) setDraft({ signature, values: {} })
  const initial = (field: NonNullable<Action["input"]>[number]) => field.value ?? (field.kind === "choice" ? field.choices?.[0] : undefined) ?? ""
  const input = { ...action.args, ...Object.fromEntries((action.input ?? []).map(field => [field.name, initial(field)])), ...values }
  const change = (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft({ signature, values: { ...values, [event.currentTarget.name]: event.currentTarget.value } })
  const submit = (event: FormEvent) => { event.preventDefault(); onAction(action.tag, input) }
  return <span className="mvp-member-action">
    <form data-flow={action.tag} onSubmit={submit}>
      {action.input?.map(field => field.kind === "choice"
        ? <select key={field.name} name={field.name} aria-label={field.label} required={field.required} disabled={!!action.disabled} value={values[field.name] ?? initial(field)} onChange={change}>
          {field.choices?.map(choice => <option key={choice} value={choice}>{roleWords[choice] ?? choice}</option>)}
        </select>
        : <input key={field.name} name={field.name} aria-label={field.label} placeholder={field.label} type={field.kind === "secret" ? "password" : "text"} required={field.required} disabled={!!action.disabled} value={values[field.name] ?? initial(field)} onChange={change} />)}
      <button data-flow={action.tag} type="submit" disabled={!!action.disabled}>{action.label}</button>
    </form>
    {action.disabled ? <span className="mvp-member-reason">{action.disabled.reason}</span> : null}
  </span>
}

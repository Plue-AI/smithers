/*
 * Members and Secrets (mvp.md §6.15, M-05, M-25). Members sign in with
 * GitHub; there are no invitations, and everyone added starts as a Member.
 * Roles: Owner (installed it), Maintainer (merges, manages people and
 * secrets), Member (everything else). A person needs write access on GitHub:
 * "needs access" was never granted it, "lost access" had it and is suspended.
 * Secret values are write-only; each secret says where it reaches.
 */
import { Button } from "@smthrs/ui"
import { Check, ChevronDown, ExternalLink, KeyRound } from "lucide-react"
import { Avatar, Card } from "../parts"
import { typedOr, useFrame } from "../frame"
import type { Member } from "../world"
import type { ExtraCardProps } from "./extra"

const ROLE_WORD = { owner: "Owner", maintainer: "Maintainer", member: "Member" } as const
/* The roles a maintainer can give; Owner belongs to whoever installed it. */
const ASSIGNABLE = ["maintainer", "member"] as const

/* The role select, with its menu open when the card view is "role:<member id>". */
const RoleSelect = ({ person, open }: { readonly person: Member; readonly open: boolean }) => (
  <span className="mvp-role-wrap">
    <button type="button" className="mvp-select mvp-role-select" aria-haspopup="listbox" aria-expanded={open}
      aria-label={`${person.name}'s role: ${ROLE_WORD[person.role]}`} data-mock={`role-${person.id}`}>
      {ROLE_WORD[person.role]}<ChevronDown size={13} aria-hidden="true" /></button>
    {open ? (
      <div className="mvp-menu mvp-role-menu" role="listbox" aria-label={`${person.name}'s role`}>
        {ASSIGNABLE.map(role => (
          <button key={role} type="button" role="option" aria-selected={person.role === role} data-mock={`role-${person.id}-${role}`}>
            {person.role === role ? <Check size={14} aria-hidden="true" /> : <span className="mvp-menu-pad" aria-hidden="true" />}{ROLE_WORD[role]}
          </button>
        ))}
      </div>
    ) : null}
  </span>
)

export const MembersCard = ({ id, view }: ExtraCardProps) => {
  const frame = useFrame()
  const { world, seq } = frame.state
  const menu = view?.startsWith("role:") ? view.slice("role:".length) : undefined
  const access = `https://github.com/${world.repo}/settings/access`
  return (
    <Card id={id} kind="members" title="Members">
      <ul className="mvp-members">
        {world.members.map(person => (
          <li key={person.id} data-fresh={person.seq === seq || undefined}>
            <Avatar world={world} who={person.id} size={24} />
            <span className="mvp-member-name">{person.name}</span>
            <span className="mvp-member-login">@{person.login}</span>
            {person.suspended ? <a className="mvp-warn-text mvp-access" href={access} target="_blank" rel="noreferrer">lost access on GitHub<ExternalLink size={12} aria-hidden="true" /></a>
              : person.needsAccess ? <a className="mvp-warn-text mvp-access" href={access} target="_blank" rel="noreferrer">needs access on GitHub<ExternalLink size={12} aria-hidden="true" /></a>
              : <span />}
            {person.role === "owner" ? <span className="mvp-role">Owner</span> : <RoleSelect person={person} open={menu === person.id} />}
            {person.role === "owner" ? <span /> : <Button size="sm" variant="ghost" data-mock={`remove-${person.id}`}>Remove</Button>}
          </li>
        ))}
      </ul>
      <form className="mvp-inline-input mvp-add-row" onSubmit={event => event.preventDefault()}>
        <input aria-label="GitHub username" placeholder="GitHub username" readOnly value={typedOr(frame, "member-login", "")} data-mock="member-login" />
        <Button size="sm" variant="outline" data-mock="member-add">Add</Button>
      </form>
    </Card>
  )
}

/* The add form's scope is "main only" when the card view is "scope:main". */
export const SecretsCard = ({ id, view }: ExtraCardProps) => {
  const frame = useFrame()
  const { world } = frame.state
  const scope = view === "scope:main" ? "main only" : "all branches"
  return (
    <Card id={id} kind="secrets" title="Secrets">
      <ul className="mvp-secrets">
        {world.secrets.map(secret => (
          <li key={secret.name}>
            <KeyRound size={14} aria-hidden="true" />
            <code>{secret.name}</code>
            <button type="button" className="mvp-select mvp-scope" aria-label={`${secret.name} reaches ${secret.scope}`}>{secret.scope}<ChevronDown size={13} aria-hidden="true" /></button>
            <span className="mvp-actions-end"><Button size="sm" variant="ghost">Replace</Button><Button size="sm" variant="ghost">Delete</Button></span>
          </li>
        ))}
      </ul>
      <form className="mvp-secret-add" onSubmit={event => event.preventDefault()}>
        <input aria-label="Name" placeholder="NAME" readOnly value={typedOr(frame, "secret-name", "")} data-mock="secret-name" />
        <input aria-label="Value" placeholder="Value" type="password" readOnly value={typedOr(frame, "secret-value", "")} data-mock="secret-value" />
        <button type="button" className="mvp-select mvp-scope" aria-label={`Reaches ${scope}`} data-mock="secret-scope">
          {scope}<ChevronDown size={13} aria-hidden="true" /></button>
        <Button size="sm" variant="outline" data-mock="secret-add">Add</Button>
      </form>
    </Card>
  )
}

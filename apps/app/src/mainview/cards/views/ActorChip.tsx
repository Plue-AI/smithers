import type { CSSProperties } from "react"
import { Bot, FolderSync, SquareTerminal } from "lucide-react"

// ui-components v0.4 until engineering's #3601 exports this Actor contract.
type Member = { login: string; name: string; avatar_url: string; color_index?: number }
export type Actor = (
  | ({ kind: "person"; via?: "ssh" | "terminal" | "cli" } & Member)
  | { kind: "agent"; id: string; agent: "smithers" | "coding" | "reviewer" | "claude-code" | "codex" | "external";
      avatar_url: string; session_id?: string; run_id?: string; for_member?: Member; name?: string; todo?: number }
  | { kind: "system" } | { kind: "github"; login: string } | { kind: "outside" }
) & { color_index: number }
export type ActorChipProps = { actor: Actor; size: "s" | "m"; live?: boolean }
const first = (name: string) => name.trim().split(/\s+/)[0]
const agentNames = { smithers: "Smithers", coding: "Coding agent", reviewer: "Reviewer", "claude-code": "Claude Code", codex: "Codex", external: "External agent" }
export function actorName(actor: Actor): string {
  switch (actor.kind) {
    case "person": return actor.via === "terminal" ? `${first(actor.name)}'s terminal`
      : `${first(actor.name)}${actor.via ? ` via ${actor.via.toUpperCase()}` : ""}`
    case "agent": return `${actor.name || agentNames[actor.agent]}${actor.for_member ? ` for ${first(actor.for_member.name)}` : ""}`
    case "github": return `@${actor.login}`
    case "outside": return "Changed outside Smithers"
    case "system": return "Smithers"
  }
}
export function ActorChip({ actor, size, live = false }: ActorChipProps) {
  const label = actorName(actor)
  const agent = actor.kind === "agent"
  const smithers = agent && actor.agent === "smithers"
  const delegated = agent && actor.for_member !== undefined
  const index = actor.kind === "person" || delegated ? actor.color_index : agent ? 6 : 7
  const style = { "--size": size === "s" ? "22px" : "28px", "--who": smithers && !delegated ? "var(--text)" : `var(--lane-${index})` } as CSSProperties
  const avatar = actor.kind === "person" || agent ? actor.avatar_url : undefined
  const initials = actor.kind === "person" ? actor.name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join("") : label[0]
  return <span className="mvp-avatar" role="img" aria-label={label} title={label} style={style}
    data-kind={actor.kind} data-agent={agent || undefined} data-smithers={smithers || undefined}
    data-for={delegated || undefined} data-live={agent && live || undefined} data-via={actor.kind === "person" ? actor.via : undefined}>
    {smithers ? "S" : avatar ? <img src={avatar} alt="" onError={event => { event.currentTarget.hidden = true }} />
      : actor.kind === "github" ? <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.7.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6A12 12 0 0 0 12 .5Z" /></svg>
      : actor.kind === "outside" ? <FolderSync size={14} aria-hidden="true" />
      : agent && actor.agent === "coding" ? <Bot size={14} aria-hidden="true" /> : initials}
    {avatar && !smithers ? <span className="mvp-avatar-fallback" aria-hidden="true">{agent && actor.agent === "coding" ? <Bot size={14} /> : initials}</span> : null}
    {actor.kind === "person" && actor.via ? <span className="mvp-avatar-badge" aria-hidden="true"><SquareTerminal size={10} /></span> : null}
  </span>
}

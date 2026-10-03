import { useState, type CSSProperties, type ReactNode } from "react"
import { Bot, FolderSync, SquareTerminal } from "lucide-react"

import type { ActorChipCard } from "@smthrs/rpc/ActorChipCard"
import type { Actor } from "@smthrs/rpc/CardPrimitives"
export type { Actor } from "@smthrs/rpc/CardPrimitives"
export type ActorChipProps = ActorChipCard
import { actorName } from "./actorName"
export { actorName } from "./actorName"
export function actorColour(actor: Actor) {
  const agent = actor.kind === "agent"
  const delegated = agent && actor.for_member !== undefined
  const index = actor.kind === "person" || delegated ? actor.color_index : agent ? 6 : 7
  return agent && actor.agent === "smithers" && !delegated ? "var(--text)" : `var(--lane-${index})`
}
function AvatarImage({ url, fallback }: { url: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false)
  return failed ? fallback : <><img src={url} alt="" onError={() => setFailed(true)} /><span className="mvp-avatar-fallback" aria-hidden="true">{fallback}</span></>
}
export function ActorChip({ actor, size, live = false }: ActorChipProps) {
  const label = actorName(actor)
  const agent = actor.kind === "agent"
  const smithers = agent && actor.agent === "smithers"
  const delegated = agent && actor.for_member !== undefined
  const style = { "--size": size === "s" ? "22px" : "28px", "--who": actorColour(actor) } as CSSProperties
  const avatar = actor.kind === "person" ? actor.avatar_url : undefined
  const initials = actor.kind === "person" ? actor.name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join("") : label[0]
  return <span className="mvp-avatar" role="img" aria-label={label} title={label} style={style}
    data-kind={actor.kind} data-agent={agent || undefined} data-smithers={smithers || undefined}
    data-for={delegated || undefined} data-live={agent && live || undefined} data-via={actor.kind === "person" ? actor.via : undefined}>
    {smithers ? "S" : avatar ? <AvatarImage key={avatar} url={avatar} fallback={initials} />
      : actor.kind === "github" ? <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.7.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6A12 12 0 0 0 12 .5Z" /></svg>
      : actor.kind === "outside" ? <FolderSync size={14} aria-hidden="true" />
      : agent && actor.agent === "coding" ? <Bot size={14} aria-hidden="true" /> : agent && actor.agent === "reviewer" ? "R" : initials}
    {actor.kind === "person" && actor.via ? <span className="mvp-avatar-badge" aria-hidden="true"><SquareTerminal size={10} /></span> : null}
  </span>
}

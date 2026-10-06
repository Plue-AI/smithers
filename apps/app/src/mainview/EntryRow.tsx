import type { CardProps } from "@smthrs/rpc/CardAction"
import { useState, type ReactNode } from "react"
import { Lock } from "lucide-react"
import type { EntryRowCard } from "@smthrs/rpc/EntryRowCard"
import { ActorChip, actorName } from "./cards/views/ActorChip"
import { StateWord } from "./cards/views/StateWord"
import { ContextLine, type ContextLineProps } from "./ContextLine"
export type EntryRowProps = EntryRowCard & { card?: ReactNode; contextActions?: Pick<ContextLineProps, "openActions" | "onAction">; source?: { origin?: string; session?: string; correlation?: string; participant?: string }; onAction: CardProps<unknown>["onAction"] }

export function OnlyYouChip() { return <span className="locked">
    <Lock size={12} aria-hidden="true" />Only you</span> }

export function EntryRow({ kind, author, title, summary, tone, state, context, contextActions, action, private: onlyYou, card, tombstone, source, onAction }: EntryRowProps) {
  const [expanded, setExpanded] = useState(false)
  if (tombstone) return <div className="tombstone">{title}
    </div>
  return <article className="entry smithers-chat-message" data-role={kind === "prompt" ? "user" : "assistant"} data-origin={source?.origin} data-session-id={source?.session} data-correlation-id={source?.correlation} data-participant-id={source?.participant} data-kind={kind} data-tone={tone} data-private={onlyYou || undefined}>
    <header>
    <span className="author">
    <ActorChip actor={author} size="s" />{actorName(author)}
    </span>{onlyYou ? <OnlyYouChip /> : null}{state ? <StateWord state={state} /> : null}
    </header>
    {title ? <div className="entry-title">{title}
    </div> : null}{summary ? <p className="entry-summary">{summary}
    </p> : null}{card}{context ? <ContextLine count={context.count} items={context.items} expanded={expanded} onView={patch => setExpanded(patch.expanded)} {...contextActions} /> : null}{action ? <div className="entry-action">
    <button type="button" data-flow={action.tag} disabled={Boolean(action.disabled)} onClick={() => onAction(action.tag, action.args ?? {})}>{action.label}
    </button>{action.disabled ? <span className="mvp-disabled-reason">{action.disabled.reason}
    </span> : null}
    </div> : null}
    </article>
}

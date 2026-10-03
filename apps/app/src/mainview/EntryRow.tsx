import type { CardProps } from "@smthrs/rpc/CardAction"
import { useState, type ReactNode } from "react"
import { Lock } from "lucide-react"
import type { EntryRowCard } from "@smthrs/rpc/EntryRowCard"
import { ActorChip, actorName } from "./cards/views/ActorChip"
import { StateWord } from "./cards/views/StateWord"
import { ContextLine } from "./ContextLine"
export type EntryRowProps = EntryRowCard & { card?: ReactNode; onAction: CardProps<unknown>["onAction"] }

export function OnlyYouChip() { return <span className="mvp-locked">
    <Lock size={12} aria-hidden="true" />Only you</span> }

export function EntryRow({ kind, author, title, summary, tone, state, context, action, private: onlyYou, card, tombstone, onAction }: EntryRowProps) {
  const [expanded, setExpanded] = useState(false)
  if (tombstone) return <div className="mvp-tombstone">{title}
    </div>
  return <article className="mvp-entry" data-kind={kind} data-tone={tone} data-private={onlyYou || undefined}>
    <header>
    <span className="mvp-author">
    <ActorChip actor={author} size="s" />{actorName(author)}
    </span>{onlyYou ? <OnlyYouChip /> : null}{state ? <StateWord state={state} /> : null}
    </header>
    <div className="mvp-entry-title">{title}
    </div>{summary ? <p className="mvp-entry-summary">{summary}
    </p> : null}{card}{context ? <ContextLine count={context.count} items={context.items} expanded={expanded} onView={patch => setExpanded(patch.expanded)} /> : null}{action ? <div className="mvp-entry-action">
    <button type="button" data-flow={action.tag} disabled={Boolean(action.disabled)} onClick={() => onAction(action.tag, action.args ?? {})}>{action.label}
    </button>{action.disabled ? <span className="mvp-disabled-reason">{action.disabled.reason}
    </span> : null}
    </div> : null}
    </article>
}

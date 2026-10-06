import { Layers } from "lucide-react"
import type { ContextLineProps } from "@smthrs/rpc/ContextLineCard"
export type { ContextLineProps } from "@smthrs/rpc/ContextLineCard"

export function ContextLine({ count, items, expanded, onView, openActions, onAction }: ContextLineProps) {
  return <div className="context" data-open={expanded || undefined}>
    <button type="button" className="context-toggle" aria-expanded={expanded} onClick={() => onView({ expanded: !expanded })}>
    <Layers size={12} aria-hidden="true" />Context · {count}
    </button>{expanded ? items.map((item, index) => {
      const action = openActions?.[index]
      const title = [item.ref, item.revision, item.reason].filter(Boolean).join(" · ")
      return action !== undefined && action.disabled === undefined && onAction !== undefined
        ? <button key={index} type="button" className="context-chip" data-kind={item.kind} title={title}
          data-flow={action.tag} onClick={() => onAction(action.tag, action.args)}>{item.label}</button>
        : <span key={index} className="context-chip" data-kind={item.kind} title={title}>{item.label}</span>
    }) : null}
    </div>
}

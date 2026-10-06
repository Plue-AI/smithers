import { Layers } from "lucide-react"
import type { ContextLineProps } from "@smthrs/rpc/ContextLineCard"
export type { ContextLineProps } from "@smthrs/rpc/ContextLineCard"

export function ContextLine({ count, items, expanded, onView }: ContextLineProps) {
  return <div className="context" data-open={expanded || undefined}>
    <button type="button" className="context-toggle" aria-expanded={expanded} onClick={() => onView({ expanded: !expanded })}>
    <Layers size={12} aria-hidden="true" />Context · {count}
    </button>{expanded ? items.map((item, index) => <span key={index} className="context-chip" data-kind={item.kind} title={item.revision ? `${item.ref} · ${item.revision}` : item.ref}>{item.label}
    </span>) : null}
    </div>
}

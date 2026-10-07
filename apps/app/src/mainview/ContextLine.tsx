import { File, FileText, CircleDot, ListTodo, Play, Layers, Maximize2 } from "lucide-react"
import type { ContextLineProps } from "@smthrs/rpc/ContextLineCard"
export type { ContextLineProps } from "@smthrs/rpc/ContextLineCard"

const glyphs = { file: File, page: FileText, issue: CircleDot, todo: ListTodo, run: Play }

export function ContextLine({ count, items, actions, expanded, onAction, onView }: ContextLineProps) {
  if (count === 0 || items.length === 0) return null
  return <div className="context" data-open={expanded || undefined}>
    <button type="button" className="context-toggle" aria-expanded={expanded} onClick={() => onView({ expanded: !expanded })}>
      <Layers size={12} aria-hidden="true" />Context · {count}
    </button>{expanded ? <>
      {items.map((item, index) => {
        const Glyph = glyphs[item.kind]
        const action = item.action
        const content = <><Glyph size={12} aria-hidden="true" />{item.label}{item.revision ? <span>{item.revision}</span> : null}</>
        const title = item.revision ? `${item.ref} · ${item.revision}` : item.ref
        return <span key={index} className="context-item">
          {action ? <button type="button" className="context-chip" data-kind={item.kind} title={title} data-flow={action.tag} disabled={Boolean(action.disabled)} onClick={() => onAction(action.tag, action.args ?? {})}>{content}</button>
            : <span className="context-text" data-kind={item.kind} title={title}>{content}</span>}
          {action?.disabled ? <span>{action.disabled.reason}</span> : null}
        </span>
      })}
      {actions.map((action, index) => <span key={index} className="context-item">
        <button type="button" className="context-chip" data-flow={action.tag} disabled={Boolean(action.disabled)} onClick={() => onAction(action.tag, action.args ?? {})}><Maximize2 size={12} aria-hidden="true" />{action.label}</button>
        {action.disabled ? <span>{action.disabled.reason}</span> : null}
      </span>)}
    </> : null}
  </div>
}

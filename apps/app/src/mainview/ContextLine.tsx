import { File, FileText, CircleDot, ListTodo, Play, Layers } from "lucide-react"
import { Button } from "@smthrs/ui/button"
import type { ContextLineProps } from "@smthrs/rpc/ContextLineCard"
export type { ContextLineProps } from "@smthrs/rpc/ContextLineCard"

const glyphs = { file: File, page: FileText, issue: CircleDot, todo: ListTodo, run: Play }

export function ContextLine({ count, items, actions, expanded, onAction, onView }: ContextLineProps) {
  return <div className="mvp-context" data-open={expanded || undefined}>
    <button type="button" className="mvp-context-toggle" aria-expanded={expanded} onClick={() => onView({ expanded: !expanded })}>
      <Layers size={12} aria-hidden="true" />Context · {count}
    </button>{expanded ? <>
      {items.map((item, index) => {
        const Glyph = glyphs[item.kind]
        const action = item.action
        const content = <><Glyph size={12} aria-hidden="true" />{item.label}{item.revision ? <span>{item.revision}</span> : null}</>
        const title = item.revision ? `${item.ref} · ${item.revision}` : item.ref
        return <span key={index} className="mvp-context-item">
          {action ? <button type="button" className="mvp-context-chip" data-kind={item.kind} title={title} data-flow={action.tag} disabled={Boolean(action.disabled)} onClick={() => onAction(action.tag, action.args ?? {})}>{content}</button>
            : <span className="mvp-context-chip" data-kind={item.kind} title={title}>{content}</span>}
          {action?.disabled ? <span>{action.disabled.reason}</span> : null}
        </span>
      })}
      {actions.map((action, index) => <span key={index} className="mvp-context-item">
        <Button size="sm" variant="outline" data-flow={action.tag} disabled={Boolean(action.disabled)} onClick={() => onAction(action.tag, action.args ?? {})}>{action.label}</Button>
        {action.disabled ? <span>{action.disabled.reason}</span> : null}
      </span>)}
    </> : null}
  </div>
}

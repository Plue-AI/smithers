import { BookOpen, ChevronRight, GitCommitHorizontal, Lightbulb } from "lucide-react"
import type { LessonsReceiptViewProps, ProposalViewProps } from "@smthrs/rpc/ProposalCard"
import { FlowActionView } from "./FlowActionView"

function GestureLink({ action, label, onAction }: { action: NonNullable<ProposalViewProps["gestures"]["todo"]>; label: string; onAction: ProposalViewProps["onAction"] }) { return <>
  <button type="button" data-flow={action.tag} disabled={!!action.disabled} onClick={() => onAction(action.tag, { ...action.args })}>{label}</button>
  {action.disabled ? <span className="flow-disabled">{action.disabled.reason}</span> : null}
</> }

/** Reuses Home’s count copy for TODO and the detailed receipt. */
export function LessonsCount({ count }: { count?: number }) {
  return count === undefined ? null : <span>{count} {count === 1 ? "lesson" : "lessons"}</span>
}

// Props are untrusted even before the HTTP/storage validator is wired.
function safeRef(url: string) {
  if (!/^https?:\/\//i.test(url) || /[\\\u0000-\u0020\u007f]/.test(url)) return false
  try { return ["http:", "https:"].includes(new URL(url).protocol) } catch { return false }
}

export function ProposalView({ model, actions, gestures, onAction }: ProposalViewProps) {
  const todo = model.todo
  const open = gestures.todo
  return <section className="smithers-card proposal-view" data-kind="proposal" data-keyboard-pane="Proposal" aria-label={model.title}>
    <header className="smithers-card-header"><h2 className="smithers-card-title"><Lightbulb size={14} aria-hidden="true" />{model.title}</h2>
      <span className="mvp-state proposal-status" data-state={model.state}>{model.state === "open" ? "Suggested" : model.state === "dismissed" ? "Dismissed" : "Accepted"}</span>
    </header>
    <div className="smithers-card-body">
      {model.evidence.length || model.refs.length ? <details className="proposal-evidence" open={model.state === "open"}>
        <summary><ChevronRight size={13} aria-hidden="true" />Evidence</summary>
        {model.evidence.map((text, index) => <p key={index}>{text}</p>)}
        <div className="proposal-refs">{model.refs.map((ref, index) => <span className="proposal-ref" key={index}>{safeRef(ref.url) ? <a href={ref.url}>{ref.label}</a> : ref.label}</span>)}</div>
      </details> : null}
      {todo ? <div className="proposal-made"><GitCommitHorizontal size={14} aria-hidden="true" />
        {open ? <GestureLink action={open} label={`T${todo.n} · ${todo.title}`} onAction={onAction} /> : <span>T{todo.n} · {todo.title}</span>}
      </div> : null}
      <div className="flow-actions proposal-actions">{actions.map((action, index) => <FlowActionView key={index} action={action} onAction={onAction} />)}</div>
    </div>
  </section>
}

export function LessonsReceiptView({ model, actions, gestures, onAction }: LessonsReceiptViewProps) {
  if (model.lessons.length === 0) return null
  return <section className="proposal-view proposal-lessons" aria-label={`Lessons from T${model.todo}`}>
    <BookOpen size={13} aria-hidden="true" /><LessonsCount count={model.lessons.length} />
    {model.lessons.map((lesson, index) => {
      const action = gestures[lesson.ref]
      return <span className="proposal-page" key={index}>{action ? <GestureLink action={action} label={lesson.title} onAction={onAction} /> : <span>{lesson.title}</span>}</span>
    })}
    <div className="flow-actions proposal-actions">{actions.map((action, index) => <FlowActionView key={index} action={action} onAction={onAction} />)}</div>
  </section>
}

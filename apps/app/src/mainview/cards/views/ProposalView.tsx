import { BookOpen, ChevronRight, GitCommitHorizontal, Lightbulb } from "lucide-react"
import type { LessonsReceiptViewProps, ProposalViewProps } from "@smthrs/rpc/ProposalCard"
import { FlowActionView } from "./FlowActionView"

const GestureLink = ({ action, label, onAction }: { action: NonNullable<ProposalViewProps["gestures"]["todo"]>; label: string; onAction: ProposalViewProps["onAction"] }) => <>
  <button type="button" data-flow={action.tag} disabled={!!action.disabled} onClick={() => onAction(action.tag, { ...action.args })}>{label}</button>
  {action.disabled ? <span className="flow-disabled">{action.disabled.reason}</span> : null}
</>

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
        <div className="proposal-refs">{model.refs.map((ref, index) => <a className="proposal-ref" key={index} href={ref.url}>{ref.label}</a>)}</div>
      </details> : null}
      {todo ? <div className="proposal-made"><GitCommitHorizontal size={14} aria-hidden="true" />
        {open ? <GestureLink action={open} label={`T${todo.n} · ${todo.title}`} data-flow={open.tag} onAction={() => onAction(open.tag, { ...open.args })} /> : <span>T{todo.n} · {todo.title}</span>}
      </div> : null}
      <div className="flow-actions proposal-actions">{actions.map((action, index) => <FlowActionView key={index} action={action} onAction={onAction} />)}</div>
    </div>
  </section>
}

export function LessonsReceiptView({ model, actions, gestures, onAction }: LessonsReceiptViewProps) {
  if (model.lessons.length === 0) return null
  return <section className="proposal-view proposal-lessons" aria-label={`Lessons from T${model.todo}`}>
    <BookOpen size={13} aria-hidden="true" /><span>{model.lessons.length} {model.lessons.length === 1 ? "lesson" : "lessons"}</span>
    {model.lessons.map((lesson, index) => {
      const action = gestures[lesson.ref]
      return <span className="proposal-page" key={index}>{action ? <GestureLink action={action} label={lesson.title} data-flow={action.tag} onAction={() => onAction(action.tag, { ...action.args })} /> : <span>{lesson.title}</span>}</span>
    })}
    <div className="flow-actions proposal-actions">{actions.map((action, index) => <FlowActionView key={index} action={action} onAction={onAction} />)}</div>
  </section>
}

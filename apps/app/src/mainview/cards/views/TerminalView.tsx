import { FlowActionView } from "./FlowActionView"
import { Eye } from "lucide-react"
import { Terminal, type TerminalProps } from "@smthrs/ui/adapters/terminal"
import type { TerminalCard } from "@smthrs/rpc/TerminalCard"
import type { CardProps } from "@smthrs/rpc/CardAction"
import { ActorChip, actorName } from "./ActorChip"

export type TerminalViewProps = CardProps<TerminalCard> & {
  terminal: Pick<TerminalProps, "lines" | "stream" | "onData" | "onResize" | "onError" | "theme">
}

export function TerminalView({ model, actions, onAction, terminal }: TerminalViewProps) {
  const readOnly = !model.viewer_is_owner || model.frozen
  return <section className="smithers-card terminal-view" data-kind="terminal" data-keyboard-pane="Terminal" aria-label={model.title}>
    <header className="smithers-card-header">
      <h2 className="smithers-card-title">{model.title}</h2>
      <code className="terminal-branch">{model.branch}</code>
      {model.command ? <code className="terminal-command" data-live={!model.frozen || undefined}>{model.command}</code> : null}
      <div className="terminal-people">
        <span className="terminal-person" title={`${actorName(model.owner)}'s terminal`}><ActorChip actor={model.owner} size="s" /></span>
        {model.agents.map((actor, i) => <span className="terminal-person" key={i}><ActorChip actor={actor} size="s" live={!model.frozen} /><span>{actorName(actor)}</span></span>)}
        {model.watchers.map((actor, i) => <span className="terminal-person" data-watching key={i} title={`${actorName(actor)} · Watching`}><ActorChip actor={actor} size="s" /><Eye size={11} aria-hidden="true" /></span>)}
      </div>
    </header>
    <div className="smithers-card-body">
      <div className="terminal-output" aria-label={`${model.title} output`} role="region">
        <div inert={readOnly}><Terminal key={model.id} {...terminal} onData={readOnly ? undefined : terminal.onData}
          readOnly={readOnly} palette="paper" fontSize={12.5} cursorBlink={!readOnly}
          aria-label={`${model.title} terminal`} /></div>
      </div>
      {model.frozen || !model.viewer_is_owner ? <div className="terminal-status" role="status">{model.frozen ? <span>Rebasing…</span> : null}{!model.viewer_is_owner ? <span>Watching</span> : null}</div> : null}
      {actions.length ? <div className="terminal-actions">{actions.map((action, i) => <FlowActionView key={i} action={action} onAction={onAction} />)}</div> : null}
    </div>
  </section>
}

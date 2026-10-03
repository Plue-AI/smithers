import { useId, type ReactNode } from "react"
import { copyText } from "@smthrs/ui/copy"
import { Copy, GitBranch, Moon, SquareTerminal } from "lucide-react"
import type { Action } from "@smthrs/rpc/CardAction"
import type { BranchViewProps } from "@smthrs/rpc/BranchCard"
import { ActorChip, actorName } from "./ActorChip"
import { StateWord } from "./StateWord"
import { FlowActionView } from "./FlowActionView"
import { SetupAction } from "./SetupAction"

const tabs = ["activity", "files", "terminals"] as const
const machineWords = { awake: "Awake", asleep: "Asleep", waking: "Waking", waiting: "Waiting for a machine", closed: "Closed", failed: "Failed" }

function BranchLink({ action, input, onAction, children }: { action?: Action; input: Record<string, string>; onAction: BranchViewProps["onAction"]; children: ReactNode }) {
  return action ? <span><button type="button" className="branch-link" data-flow={action.tag} disabled={!!action.disabled} onClick={() => onAction(action.tag, { ...action.args, ...input })}>{children}</button>{action.disabled ? <span className="branch-muted">{action.disabled.reason}</span> : null}</span> : <>{children}</>
}

export function BranchView({ model, actions, gestures, view, onAction, onView }: BranchViewProps) {
  const id = useId()
  const tab = tabs.find(value => value === view.tab) ?? "activity"
  const terminalName = (id: string) => model.terminals.find(terminal => terminal.id === id)?.title ?? id
  const lastAnswer = model.activity.map(entry => entry.kind).lastIndexOf("answer")
  return <section className="smithers-card branch-view" data-kind="branch" data-keyboard-pane="Branch" data-machine={model.machine.state}>
    <header className="smithers-card-header"><GitBranch size={16} aria-hidden="true" /><h2>{model.name}</h2>
      <span className="branch-machine" data-state={model.machine.state}>{model.machine.state === "awake" ? <span className="branch-live-dot" /> : model.machine.state === "asleep" ? <Moon size={12} aria-hidden="true" /> : null}{machineWords[model.machine.state]}{model.machine.state === "waiting" ? ` · #${model.machine.position}` : ""}</span>
    </header>
    <div className="smithers-card-body">
      <div className="branch-item">{model.item ? <><StateWord state={model.item.state} step={model.item.step} /><b>T{model.item.n}</b><BranchLink action={gestures.item} input={{ n: String(model.item.n) }} onAction={onAction}>{model.item.title}</BranchLink><span className="branch-muted">#{model.item.place} in stack</span></> : <><span className="branch-scratch">Scratch</span>{model.scratch ? <span>Forked from {model.scratch.forked_from.kind === "main" ? "main" : model.scratch.forked_from.kind === "item" ? `T${model.scratch.forked_from.n} ${model.scratch.forked_from.title}` : model.scratch.forked_from.name}</span> : null}</>}</div>
      {model.machine.state === "failed" ? <div className="branch-notice" data-tone="failed">{model.machine.error.message}</div> : null}
      {model.moved_off ? <div className="branch-notice" data-tone="attention"><b>Needs you</b><span>{actorName(model.moved_off.by)} moved off T{model.moved_off.item}</span></div> : null}
      {model.rebase ? <div className="branch-notice" data-tone={model.rebase.state === "conflict" ? "attention" : model.rebase.state === "rebasing" ? "live" : "quiet"}>
        <span>{model.rebase.state === "pending" ? "Rebase pending" : model.rebase.state === "rebasing" ? "Rebasing…" : "Rebase conflict"} onto {model.rebase.onto}</span>
        {model.rebase.state === "pending" && model.rebase.waiting_for ? <span>Waiting for {actorName(model.rebase.waiting_for.actor)} · {terminalName(model.rebase.waiting_for.terminal)}</span> : null}
        {model.rebase.state === "conflict" ? <ul>{model.rebase.paths.map(path => <li key={path}><code>{path}</code></li>)}</ul> : null}
      </div> : null}
      <ul className="branch-presence" aria-label="On this branch">{model.presence.length ? [...model.presence.filter(row => row.actor.kind === "person"), ...model.presence.filter(row => row.actor.kind !== "person")].map((row, index) => <li key={index}>
        <ActorChip actor={row.actor} size="s" live={model.machine.state === "awake"} /><b>{actorName(row.actor)}</b>
        <span className="branch-location"><BranchLink action={row.where.kind === "file" ? gestures.file : row.where.kind === "terminal" ? gestures.terminal : undefined} input={row.where.kind === "file" ? { path: row.where.path, ...(row.where.line === undefined ? {} : { line: String(row.where.line) }) } : row.where.kind === "terminal" ? { id: row.where.id } : {}} onAction={onAction}>{row.where.kind === "file" ? `${row.where.path}${row.where.line === undefined ? "" : `:${row.where.line}`}` : row.where.kind === "terminal" ? terminalName(row.where.id) : row.where.kind === "step" ? row.where.label : "here"}</BranchLink></span>
        {row.watching ? <span className="branch-muted">watching <BranchLink action={gestures.terminal} input={{ id: row.watching }} onAction={onAction}>{terminalName(row.watching)}</BranchLink></span> : null}
      </li>) : <li className="branch-muted">Nobody here</li>}</ul>
      <div className="branch-tabs" role="tablist" aria-label={`${model.name} views`}>{tabs.map(value => <button type="button" role="tab" id={`${id}-${value}`} aria-controls={`${id}-panel`} aria-selected={tab === value} key={value} data-tab={value} onClick={() => onView({ tab: value })}>{value === "activity" ? "Activity" : value === "files" ? "Files" : "Terminals"}{value === "files" && model.changed_files.length ? <b>{model.changed_files.length}</b> : value === "terminals" && model.terminals.length ? <b>{model.terminals.length}</b> : null}</button>)}</div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
        {tab === "activity" ? <ol className="branch-activity">{model.activity.map((entry, index) => <li key={entry.id} data-kind={entry.kind} data-unanswered={entry.kind === "question" && index > lastAnswer || undefined}>
          <ActorChip actor={entry.actor} size="s" /><div><span>{entry.asked_by ? <span className="branch-muted">{actorName(entry.asked_by)} asked · </span> : null}<b>{actorName(entry.actor)}</b> · {entry.text}{entry.files === undefined ? "" : ` · ${entry.files} ${entry.files === 1 ? "file" : "files"}`}</span>
            {entry.items?.map(item => <code key={item}>{item}</code>)}
            {entry.actions.map((action, index) => <FlowActionView key={index} action={action} onAction={onAction} />)}
          </div>
        </li>)}</ol> : tab === "files" ? <ul className="branch-list">{model.changed_files.map(file => <li key={file.path}><code><BranchLink action={gestures.file} input={{ path: file.renamed_to ?? file.path }} onAction={onAction}>{file.path}{file.renamed_to ? ` → ${file.renamed_to}` : ""}</BranchLink></code><span className="branch-muted">{file.change}</span><span className="branch-avatars">{file.authors.map((actor, index) => <ActorChip key={index} actor={actor} size="s" />)}</span></li>)}</ul> : <ul className="branch-list">{model.terminals.map(terminal => <li key={terminal.id}><SquareTerminal size={14} aria-hidden="true" /><b><BranchLink action={gestures.terminal} input={{ id: terminal.id }} onAction={onAction}>{terminal.title}</BranchLink></b>{terminal.command ? <code>{terminal.command}</code> : null}<span className="branch-avatars"><ActorChip actor={terminal.owner} size="s" />{terminal.agents.map((actor, index) => <ActorChip key={index} actor={actor} size="s" />)}</span>{terminal.watchers.length ? <span className="branch-watchers"><span className="branch-muted">watching</span>{terminal.watchers.map((actor, index) => <ActorChip key={index} actor={actor} size="s" />)}</span> : null}{terminal.frozen ? <span className="branch-frozen">Rebasing…</span> : null}</li>)}</ul>}
      </div>
      <div className="branch-actions">{actions.map((action, index) => action.input?.length ? <SetupAction key={index} action={action} onAction={onAction} /> : <FlowActionView key={index} action={action} onAction={onAction} />)}</div>
      <div className="branch-ssh"><code>{model.ssh_line}</code><button type="button" aria-label="Copy SSH line" onClick={() => { void copyText(model.ssh_line) }}><Copy size={14} aria-hidden="true" /></button></div>
    </div>
  </section>
}

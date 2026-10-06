import { Check, GitPullRequest, Hourglass, Loader, TriangleAlert } from "lucide-react"
import type { FlowViewProps } from "@smthrs/rpc/FlowCard"
import { failureDetail } from "@smthrs/rpc/UserFailure"
import { FailureDetails } from "../../FailureDetails"
import { FlowActionView } from "./FlowActionView"

const words = {
  active: "Active", proposed: "Proposed", "merged-syncing": "Merged · active after sync",
  "merged-failed": "Merged · not active", previous: "Previous"
}
export function FlowView({ model, actions, gestures, onAction, view, onView }: FlowViewProps) {
  const choose = (event: React.MouseEvent<HTMLButtonElement>) => onView({ tab: event.currentTarget.dataset.version })
  const selected = model.versions.find(version => version.id === view.tab) ?? model.versions.find(version => version.state === "active") ?? model.versions[0]
  return <section className="smithers-card flow-view" data-kind="flow" data-keyboard-pane="Flow" aria-label={`${model.name === "todo" ? "TODO" : model.name} flow`}>
    <header className="smithers-card-header"><h2 className="smithers-card-title">{model.name === "todo" ? "TODO" : model.name} flow</h2></header>
    <div className="smithers-card-body">
      <div className="flow-versions" role="group" aria-label="Versions">{model.versions.filter(version => version.state !== "previous").map(version => <button type="button" className="flow-version" key={version.id} data-version={version.id} data-state={version.state} aria-pressed={version.id === selected?.id} onClick={choose}>
    {version.state === "active" ? <Check size={13} aria-hidden="true" /> : version.state === "proposed" ? <GitPullRequest size={13} aria-hidden="true" /> : version.state === "merged-syncing" ? <Loader size={13} aria-hidden="true" /> : version.state === "merged-failed" ? <TriangleAlert size={13} aria-hidden="true" /> : null}
    <span>{words[version.state]}</span>{version.todo === undefined ? null : <span className="flow-version-todo">T{version.todo}</span>}
  </button>)}</div>
      <p className="flow-path">{"builtin" in model.source ? "Built-in" : model.source.path}</p>
      <ol className="flow-steps">{selected?.steps.map((step, index) => "wait" in step ? <li key={step.id} className="flow-wait">
        <span className="flow-n"><Hourglass size={12} aria-hidden="true" /></span><span className="flow-title">Wait for merge</span>
        <span className="flow-signals">{step.signals.map((signal, i) => <span className="flow-signal" key={i}>{signal.on} <span aria-hidden="true">↺</span> {signal.to}</span>)}</span>
      </li> : <li key={step.id} data-added={step.added === true || undefined} data-agent={step.agent === undefined ? undefined : true}>
        <span className="flow-n">{index + 1}</span><span className="flow-title">{step.label}</span>
        {step.agent === undefined ? null : !gestures?.agent ? <span className="flow-agent">{step.agent}</span> : <button type="button" className="flow-agent" data-flow={gestures?.agent?.tag} onClick={() => gestures?.agent && onAction(gestures.agent.tag, { name: step.agent! })}>{step.agent}</button>}
        {step.detail === undefined ? null : <span className="flow-detail">{step.detail}</span>}
      </li>)}</ol>
      {selected?.state === "merged-failed" ? <div className="flow-failure"><TriangleAlert size={14} aria-hidden="true" /><b>Load failed</b><FailureDetails detail={failureDetail(selected.error ?? "")} /></div> : null}
      {model.proposal === undefined ? null : <div className="flow-proposal"><pre>{model.proposal.diff}</pre></div>}
      <div className="flow-actions">{actions.map((action, index) => <FlowActionView key={index} action={action} onAction={onAction} />)}</div>
    </div>
  </section>
}

import { DiffHunks, parseUnifiedFile } from "@smthrs/ui"
import { useState } from "react"
import { Check, GitPullRequest, Hourglass, Loader, TriangleAlert } from "lucide-react"
import type { FlowViewProps } from "@smthrs/rpc/FlowCard"
import { failureDetail } from "@smthrs/rpc/UserFailure"
import { FailureDetails } from "../../FailureDetails"
import { FlowActionView } from "./FlowActionView"

const words = {
  active: "Active", proposed: "Proposed", "merged-syncing": "Merged · active after sync",
  "merged-failed": "Merged · not active", previous: "Previous"
}
export function FlowView({ model, actions, onAction }: FlowViewProps) {
  const [versionId, setVersionId] = useState<string>()
  const choose = (event: React.MouseEvent<HTMLButtonElement>) => setVersionId(event.currentTarget.dataset.version)
  const selected = model.versions.find(version => version.id === versionId) ?? model.versions.find(version => version.state === "active") ?? model.versions[0]
  return <section className="smithers-card flow-view" data-kind="flow" data-keyboard-pane="Flow" aria-label={`${model.name === "todo" ? "TODO" : model.name} flow`}>
    <header className="smithers-card-header"><h2 className="smithers-card-title">{model.name === "todo" ? "TODO" : model.name} flow</h2></header>
    <div className="smithers-card-body">
      <div className="mvp-versions" role="group" aria-label="Versions">{model.versions.map(version => <button type="button" className="mvp-version" key={version.id} data-version={version.id} data-state={version.state} aria-pressed={version.id === selected?.id} onClick={choose}>
    {version.state === "active" ? <Check size={13} aria-hidden="true" /> : version.state === "proposed" ? <GitPullRequest size={13} aria-hidden="true" /> : version.state === "merged-syncing" ? <Loader size={13} aria-hidden="true" /> : version.state === "merged-failed" ? <TriangleAlert size={13} aria-hidden="true" /> : null}
    <span>{words[version.state]}</span>{version.todo === undefined ? null : <span className="mvp-version-todo">T{version.todo}</span>}
  </button>)}</div>
      <p className="mvp-flow-path">{"builtin" in model.source ? "Built-in" : model.source.path}</p>
      <ol className="mvp-flow-steps">{selected?.steps.map((step, index) => "wait" in step ? <li key={step.id} className="mvp-flow-wait">
        <span className="mvp-flow-n"><Hourglass size={12} aria-hidden="true" /></span><span className="mvp-flow-title">Wait for merge</span>
        <span className="mvp-flow-signals">{step.signals.map((signal, i) => <span className="mvp-signal" key={i}>{signal.on} <span aria-hidden="true">↺</span> {signal.to}</span>)}</span>
      </li> : <li key={step.id} data-added={step.added === true || undefined} data-agent={step.agent === undefined ? undefined : true}>
        <span className="mvp-flow-n">{index + 1}</span><span className="mvp-flow-title">{step.label}</span>
        {step.agent === undefined ? null : <span className="mvp-flow-agent">{step.agent}</span>}
        {step.detail === undefined ? null : <span className="mvp-flow-detail">{step.detail}</span>}
      </li>)}</ol>
      {selected?.state === "merged-failed" ? <div className="flow-failure"><TriangleAlert size={14} aria-hidden="true" /><b>Load failed</b><FailureDetails detail={failureDetail(selected.error ?? "")} /></div> : null}
      {model.proposal ? <DiffHunks file={parseUnifiedFile(model.proposal.context)} /> : null}
      <div className="flow-actions">{actions.map((action, index) => <FlowActionView key={index} action={action} onAction={onAction} />)}</div>
    </div>
  </section>
}

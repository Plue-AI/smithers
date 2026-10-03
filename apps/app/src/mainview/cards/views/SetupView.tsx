import type { SetupViewProps } from "@smthrs/rpc/SetupCard"

import { SetupActions } from "./SetupActions"
import { ThisMac, ModelAccess } from "./SetupFields"
const titles = { address: "Address", app_manifest: "GitHub App", sign_in: "Sign in", repository: "Repository", models: "Model access", source: "Source", machine: "Machine" }

export function SetupView({ model, actions, onAction }: SetupViewProps) {
  const rows = []
  for (const [index, step] of model.steps.entries()) rows.push(<li key={step.id} data-step={step.id} data-state={step.state}>
      <span className="setup-mark" data-tone={step.state === "running" ? "live" : step.state === "blocked" ? "attention" : step.state === "failed" ? "failed" : step.state === "done" ? "done" : "quiet"} aria-label={step.state}>{step.state === "done" ? "✓" : step.state === "failed" ? "×" : index + 1}</span>
      <div className="setup-body"><strong>{titles[step.id]}</strong>
        {step.id === "address" && <><span className="setup-muted">{model.address.listen === "mac" ? "This Mac only" : "Network"} · {model.address.bind}</span>{model.address.origins.map(origin => <code key={origin}>{origin}</code>)}</>}
        {step.id === "app_manifest" && model.github.owner && <span>{model.github.owner}</span>}
        {step.id === "sign_in" && model.github.signed_in && <span className="setup-muted">Signed in with GitHub</span>}
        {step.id === "repository" && model.repository && <><code>{model.repository.owner}/{model.repository.name}</code>{model.github.squash_allowed === true && <span className="setup-muted">✓ Squash merging on GitHub</span>}</>}
        {step.id === "models" && <ModelAccess model={model} />}
        {(step.id === "source" || step.id === "machine") && <><span className="setup-muted">{step.state === "done" ? `${titles[step.id]} ready` : step.state === "pending" ? "Waiting" : step.state === "running" ? `${step.pct ?? 0}%` : null}</span>{step.pct !== undefined && <progress max={100} value={step.pct} aria-label={titles[step.id]} />}</>}
        {step.blocked && <a className="setup-blocked" data-tone="attention" href={step.blocked.fix_url} target="_blank" rel="noreferrer">{step.blocked.line}</a>}
        {step.error && <span className="setup-error" role="alert">{step.error.message}</span>}
        <SetupActions actions={actions.filter(action => action.args?.step === step.id)} onAction={onAction} />
      </div>
    </li>)
  return <section className="setup-view" data-kind="setup" data-keyboard-pane="Setup" aria-label="Set up Smithers">
    <h2>Set up Smithers</h2><ThisMac model={model} onAction={onAction} />
    <ol className="setup-steps">{rows}</ol>
    <SetupActions actions={actions.filter(action => !model.steps.some(step => step.id === action.args?.step))} onAction={onAction} />
  </section>
}

import type { SetupViewProps } from "@smthrs/rpc/SetupCard"

import type { Action, CardProps } from "@smthrs/rpc/CardAction"
import type { SetupCard } from "@smthrs/rpc/SetupCard"
import { SetupAction } from "./SetupAction"
import { SetupActions } from "./SetupActions"
import { ThisMac } from "./SetupFields"

/* mvp.md §6.5: three named roles. The Decisions role's internal id never reaches the page. */
export const ROLE_LABELS = { fast: "Fast model", coding: "Coding model", jev: "Decisions" } as const
const KEY_STATE = { none: "", validating: "Validating", saved: "Saved", failed: "Failed" } as const
/** A key action bound to one role's row (SetupCard roleKeyActions). */
export const roleKeyAction = (actions: ReadonlyArray<Action>, role: string) =>
  actions.find(action => action.tag === "settings.model-key" && action.args?.role === role)

/** One model role: its provider, its own key control (or the masked key) and its key state, with the provider's reason when it failed. */
export function ModelRole({ role, chatgpt, action, onAction, omitLabel = false }: {
  role: SetupCard["models"][number]; chatgpt: boolean; action?: Action; onAction: CardProps<unknown>["onAction"]; omitLabel?: boolean
}) {
  const label = ROLE_LABELS[role.role]
  const keyField = action?.input?.find(field => field.kind === "secret")
  return <div className="setup-model" data-state={role.key}>
    {!omitLabel && <span>{label}</span>}
    <span className="setup-muted">{keyField ? keyField.label : role.role === "coding" && chatgpt ? "ChatGPT" : role.provider}</span>
    {action ? <SetupAction inline action={action} onAction={onAction} />
      : <input type="password" aria-label={role.role === "jev" ? "AI Gateway key" : `${label} key`} readOnly value={role.key === "saved" || role.key === "validating" ? "••••••••••••" : ""} aria-invalid={role.key === "failed" || undefined} />}
    <span className="setup-key-state" data-tone={role.key === "validating" ? "live" : role.key === "failed" ? "failed" : "quiet"}>{KEY_STATE[role.key]}</span>
    {role.error && <span className="setup-error" role="alert">{role.error}</span>}
  </div>
}

const titles = { address: "Address", app_manifest: "GitHub App", sign_in: "Sign in", repository: "Repository", models: "Model access", source: "Source", machine: "Machine" }

export function SetupView({ model, actions, onAction }: SetupViewProps) {
  const rows = []
  for (const [index, step] of model.steps.entries()) {
    const own = actions.filter(action => action.args?.step === step.id && !(step.id === "models" && roleKeyAction(actions, action.args?.role ?? "") === action))
    const controls = <SetupActions actions={own} onAction={onAction} />
    rows.push(<li key={step.id} data-step={step.id} data-state={step.state}>
      <span className="setup-mark" data-tone={step.state === "running" ? "live" : step.state === "blocked" ? "attention" : step.state === "failed" ? "failed" : step.state === "done" ? "done" : "quiet"} aria-label={step.state}>{step.state === "done" ? "✓" : step.state === "failed" ? "×" : index + 1}</span>
      <div className="setup-body"><strong>{titles[step.id]}</strong>
        {step.id === "address" && <><span className="setup-muted">{model.address.listen === "mac" ? "This Mac only" : "Network"} · {model.address.bind}</span>{model.address.origins.map(origin => <code key={origin}>{origin}</code>)}</>}
        {step.id === "app_manifest" && model.github.owner && <span>{model.github.owner}</span>}
        {step.id === "sign_in" && model.github.signed_in && <span className="setup-muted">Signed in with GitHub</span>}
        {step.id === "repository" && model.repository && <><code>{model.repository.owner}/{model.repository.name}</code>{model.github.squash_allowed === true && <span className="setup-muted">✓ Squash merging on GitHub</span>}</>}
        {step.id === "models" && <div className="setup-models">{model.models.map(role => <ModelRole key={role.role} role={role} chatgpt={model.chatgpt} action={roleKeyAction(actions, role.role)} onAction={onAction} />)}</div>}
        {(step.id === "source" || step.id === "machine") && <><span className="setup-muted">{step.state === "done" ? `${titles[step.id]} ready` : step.state === "pending" ? "Waiting" : step.state === "running" ? `${step.pct ?? 0}%` : null}</span>{step.pct !== undefined && <progress max={100} value={step.pct} aria-label={titles[step.id]} />}</>}
        {step.blocked && <a className="setup-blocked" data-tone="attention" href={step.blocked.fix_url} target="_blank" rel="noreferrer">{step.blocked.line}</a>}
        {step.error && <span className="setup-error" role="alert">{step.error.message}</span>}
        {step.state === "done" && own.length > 0 ? <details className="setup-change"><summary>Change</summary>{controls}</details> : controls}
      </div>
    </li>)
  }
  return <section className="setup-view" data-kind="setup" data-keyboard-pane="Setup" aria-label="Set up Smithers">
    <h2>Set up Smithers</h2><ThisMac model={model} onAction={onAction} />
    <ol className="setup-steps">{rows}</ol>
    <SetupActions actions={actions.filter(action => !model.steps.some(step => step.id === action.args?.step) && roleKeyAction(actions, action.args?.role ?? "") !== action)} onAction={onAction} />
  </section>
}

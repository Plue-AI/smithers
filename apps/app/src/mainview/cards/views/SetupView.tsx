import { useId, useState } from "react"
import type { Action, CardProps } from "@smthrs/rpc/CardAction"
import type { SetupCard, SetupViewProps } from "@smthrs/rpc/SetupCard"

const roles = { fast: "Fast model", coding: "Coding model", jev: "Decisions" }
const titles = { address: "Address", app_manifest: "GitHub App", sign_in: "Sign in", repository: "Repository", models: "Model access", source: "Source", machine: "Machine" }

/** Supplied forms preserve action order and bound arguments. */
export function SetupActions({ actions, onAction }: Pick<CardProps<unknown>, "actions" | "onAction">) {
  return <div className="setup-actions">{actions.map((action, index) => <SetupAction key={index} action={action} onAction={onAction} />)}</div>
}
function SetupAction({ action, onAction }: { action: Action; onAction: CardProps<unknown>["onAction"] }) {
  const id = useId()
  const [input, setInput] = useState<Record<string, string>>({})
  const values = Object.fromEntries((action.input ?? []).map(field => [field.name, input[field.name] ?? field.value ?? field.choices?.[0] ?? ""]))
  const stepper = ["capacity", "parallel", "todo_daily_admissions"].includes(action.args?.field ?? "")
  return <form className="setup-action" onSubmit={event => { event.preventDefault(); if (!action.disabled) onAction(action.tag, { ...action.args, ...values }) }} data-flow={action.tag}>
    {action.input?.map(field => <div className="setup-field" key={field.name}>{stepper ? <span>{field.label}</span> : <label htmlFor={`${id}-${field.name}`}>{field.label}</label>}
      {stepper ? <span className="setup-stepper">
        <button type="button" data-flow={action.tag} disabled={!!action.disabled} aria-label={`Fewer ${field.label}`} onClick={event => { event.preventDefault(); onAction(action.tag, { ...action.args, value: String(Math.max(0, Number(values[field.name]) - 1)) }) }}>−</button>
        <output>{values[field.name]}</output>
        <button type="button" data-flow={action.tag} disabled={!!action.disabled} aria-label={`More ${field.label}`} onClick={event => { event.preventDefault(); onAction(action.tag, { ...action.args, value: String(Number(values[field.name]) + 1) }) }}>+</button>
      </span> : field.kind === "choice" ? <select id={`${id}-${field.name}`} value={values[field.name]} required={field.required} disabled={!!action.disabled} onChange={event => setInput({ ...input, [field.name]: event.target.value })}>{field.choices?.map(choice => <option key={choice}>{choice}</option>)}</select>
        : <input id={`${id}-${field.name}`} type={field.kind === "secret" ? "password" : "text"} autoComplete={field.kind === "secret" ? "new-password" : "off"} value={values[field.name]} required={field.required} disabled={!!action.disabled} onChange={event => setInput({ ...input, [field.name]: event.target.value })} />}
    </div>)}
    {stepper ? null : <button type="submit" data-flow={action.tag} data-primary={action.primary || undefined} disabled={!!action.disabled}>{action.label}</button>}
    {action.disabled && <span className="setup-reason">{action.disabled.reason}</span>}
  </form>
}
export function ThisMac({ model }: { model: SetupCard }) {
  return <div className="setup-mac"><strong>This Mac</strong><span>{model.this_mac.memory_gb} GB · {model.this_mac.disk_free_gb} GB free</span>
    {model.this_mac.capacity === 0 && <span className="setup-capacity">No machine fits · {model.this_mac.limit?.term} · {model.this_mac.limit?.fix}</span>}
  </div>
}
export function ModelAccess({ model }: { model: SetupCard }) {
  return <div className="setup-models">{model.models.map(role => <div className="setup-model" key={role.role} data-state={role.key}>
    <span>{roles[role.role]}</span><span className="setup-muted">{role.provider}</span>
    <input type="password" aria-label={role.role === "jev" ? "AI Gateway key" : `${roles[role.role]} key`} readOnly value={role.key === "saved" || role.key === "validating" ? "••••••••••••" : ""} aria-invalid={role.key === "failed" || undefined} />
    <span className="setup-key-state">{role.key === "none" ? "" : role.key === "saved" ? "Saved" : role.key === "validating" ? "Validating" : "Failed"}</span>
    {role.error && <span className="setup-error" role="alert">{role.error}</span>}
  </div>)}</div>
}
export function SetupView({ model, actions, onAction }: SetupViewProps) {
  return <section className="setup-view" data-kind="setup" data-keyboard-pane="Setup" aria-label="Set up Smithers">
    <h2>Set up Smithers</h2><ThisMac model={model} />
    <ol className="setup-steps">{model.steps.map((step, index) => <li key={step.id} data-step={step.id} data-state={step.state}>
      <span className="setup-mark" aria-label={step.state}>{step.state === "done" ? "✓" : step.state === "failed" ? "×" : index + 1}</span>
      <div className="setup-body"><strong>{titles[step.id]}</strong>
        {step.id === "address" && <><span className="setup-muted">{model.address.listen === "mac" ? "This Mac only" : "Network"} · {model.address.bind}</span>{model.address.origins.map(origin => <code key={origin}>{origin}</code>)}</>}
        {step.id === "app_manifest" && model.github.owner && <span>{model.github.owner}</span>}
        {step.id === "sign_in" && model.github.signed_in && <span className="setup-muted">Signed in with GitHub</span>}
        {step.id === "repository" && model.repository && <><code>{model.repository.owner}/{model.repository.name}</code>{model.github.squash_allowed === true && <span className="setup-muted">✓ Squash merging on GitHub</span>}</>}
        {step.id === "models" && <ModelAccess model={model} />}
        {(step.id === "source" || step.id === "machine") && <><span className="setup-muted">{step.state === "done" ? `${titles[step.id]} ready` : step.state === "pending" ? "Waiting" : step.state === "running" ? `${step.pct ?? 0}%` : null}</span>{step.pct !== undefined && <progress max={100} value={step.pct} aria-label={titles[step.id]} />}</>}
        {step.blocked && <a className="setup-blocked" href={step.blocked.fix_url} target="_blank" rel="noreferrer">{step.blocked.line}</a>}
        {step.error && <span className="setup-error" role="alert">{step.error.message}</span>}
        <SetupActions actions={actions.filter(action => action.args?.step === step.id)} onAction={onAction} />
      </div>
    </li>)}</ol>
    <SetupActions actions={actions.filter(action => !model.steps.some(step => step.id === action.args?.step))} onAction={onAction} />
  </section>
}

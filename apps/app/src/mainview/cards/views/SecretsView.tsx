import type { SecretsViewProps } from "@smthrs/rpc/SecretsCard"
import type { Action } from "@smthrs/rpc/CardAction"
import { KeyRound } from "lucide-react"
import { useId, useState } from "react"

// Secrets need Cancel and write-only defaults; SetupAction has neither.
function SecretAction({ action, onAction }: { action: Action; onAction: SecretsViewProps["onAction"] }) {
  const id = useId()
  const [input, setInput] = useState<Record<string, string>>({})
  const values = Object.fromEntries((action.input ?? []).map(field => [field.name,
    field.kind === "secret" ? input[field.name] ?? "" : input[field.name] ?? field.value ?? field.choices?.[0] ?? ""]))
  const submit = () => { if (!action.disabled) onAction(action.tag, { ...action.args, ...values }) }
  return <form className="setup-action" data-flow={action.tag} onSubmit={event => {
    event.preventDefault()
    submit()
    setInput({})
  }}>
    {action.input?.map(field => <div className="setup-field" key={field.name}>
      {field.kind === "choice" ? <select id={`${id}-${field.name}`} aria-label={field.label} value={values[field.name]} required={field.required} disabled={!!action.disabled} onChange={event => setInput({ ...input, [field.name]: event.target.value })}>
        {field.choices?.map(choice => <option key={choice} value={choice}>{scopeWords[choice as keyof typeof scopeWords] ?? choice}</option>)}
      </select> : <input id={`${id}-${field.name}`} aria-label={field.label} placeholder={field.label} type={field.kind === "secret" ? "password" : "text"} autoComplete={field.kind === "secret" ? "new-password" : "off"} value={values[field.name]} required={field.required} disabled={!!action.disabled} onChange={event => setInput({ ...input, [field.name]: event.target.value })} />}
    </div>)}
    <button type="submit" data-flow={action.tag} disabled={!!action.disabled}>{action.label}</button>
    {action.input?.length ? <button type="button" onClick={() => setInput({})}>Cancel</button> : null}
    {action.disabled ? <span className="setup-reason">{action.disabled.reason}</span> : null}
  </form>
}

const scopeWords = { all_branches: "all branches", main_only: "main only" }

export function SecretsView({ model, actions, onAction }: SecretsViewProps) {
  const control = (action: Action, index: number, replace = false) => {
    const form = <SecretAction key={JSON.stringify(action)} action={action} onAction={onAction} />
    return replace && action.input?.length
      ? <details key={index}><summary>{action.label}</summary>{form}</details>
      : <div key={index}>{form}</div>
  }
  return <section className="secrets-view" data-kind="secrets" data-keyboard-pane="Secrets" aria-label="Secrets">
    <h2>Secrets</h2>
    <ul className="secrets-list">
      {model.secrets.map(secret => <li key={secret.name}>
        <div className="secret-row"><KeyRound size={14} aria-hidden="true" /><code>{secret.name}</code><span className="secret-scope">{scopeWords[secret.scope]}</span></div>
        <div className="secret-actions">{secret.actions.map((action, index) => control(action, index, true))}</div>
      </li>)}
    </ul>
    <div className="secret-add">{actions.map((action, index) => control(action, index))}</div>
  </section>
}

import { useState } from "react"
import type { CommandsViewProps } from "@smthrs/rpc/CommandsCard"
import type { Action } from "@smthrs/rpc/CardAction"

export function CommandActionView({ action, onAction }: { action: Action; onAction: CommandsViewProps["onAction"] }) {
  const [input, setInput] = useState<Record<string, string>>({})
  const values = Object.fromEntries((action.input ?? []).map(field => [field.name, input[field.name] ?? field.value ?? action.args?.[field.name] ?? ""]))
  const missing = (action.input ?? []).some(field => field.required && !values[field.name]?.trim())
  const press = () => onAction(action.tag, { ...action.args, ...values })
  const fields = []
  for (const field of action.input ?? []) {
    fields.push(<label key={field.name}>{field.label}{field.kind === "choice"
      ? <select name={field.name} required={field.required} disabled={!!action.disabled} value={values[field.name]} onChange={event => setInput({ ...input, [field.name]: event.currentTarget.value })}>{(field.choices ?? []).map(choice => <option key={choice}>{choice}</option>)}</select>
      : field.multiline && field.kind === "text"
        ? <textarea name={field.name} required={field.required} disabled={!!action.disabled} value={values[field.name]} onInput={event => setInput({ ...input, [field.name]: event.currentTarget.value })} />
        : <input name={field.name} required={field.required} disabled={!!action.disabled} value={values[field.name]} type={field.kind === "secret" ? "password" : "text"} onInput={event => setInput({ ...input, [field.name]: event.currentTarget.value })} />}</label>)
  }
  return <div>{fields}<button type="button" data-flow={action.tag} disabled={!!action.disabled || missing} onClick={press}>{action.label}</button>{action.disabled && <span>{action.disabled.reason}</span>}</div>
}

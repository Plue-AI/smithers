import { useState } from "react"
import type { Action } from "@smthrs/rpc/CardAction"
import type { CommandsViewProps } from "@smthrs/rpc/CommandsCard"

function CommandRows({ commands }: { commands: CommandsViewProps["model"]["groups"][number]["commands"] }) {
  return <dl>{commands.map((command, index) => <div key={index} className="mvp-command">
    <dt>{command.synopsis === "⌘K (no slash)" ? <><kbd>⌘K</kbd> (no slash)</> : <code>{command.synopsis}</code>}</dt>
    <dd>{command.description}</dd>
    {command.agent !== "run" && <dd className="mvp-command-policy">{command.agent === "confirm" ? "Asks first" : "Only you"}</dd>}
  </div>)}</dl>
}

export function CommandsView({ model, actions, onAction }: CommandsViewProps) {
  const controls = []
  for (const [index, action] of actions.entries()) controls.push(<CommandActionView key={`${index}:${JSON.stringify(action)}`} action={action} onAction={onAction} />)
  return <article className="mvp-commands-card" aria-label="Commands">
    <div className="mvp-commands">{model.groups.map((group, index) => group.advanced
      ? <details key={index} className="mvp-commands-advanced"><summary>{group.label}</summary><CommandRows commands={group.commands} /></details>
      : <section key={index}><h3>{group.label}</h3><CommandRows commands={group.commands} /></section>)}</div>
    {controls}
  </article>
}


function CommandActionView({ action, onAction }: { action: Action; onAction: CommandsViewProps["onAction"] }) {
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

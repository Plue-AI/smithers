import { useId, useState } from "react"
import type { Action, CardProps } from "@smthrs/rpc/CardAction"

export function SetupAction({ action, onAction, inline = false, choiceLabels = {}, placeholders = false }: { action: Action; onAction: CardProps<unknown>["onAction"]; inline?: boolean; choiceLabels?: Record<string, string>; placeholders?: boolean }) {
  const id = useId()
  const [input, setInput] = useState<Record<string, string>>({})
  const values = Object.fromEntries((action.input ?? []).map(field => [field.name, input[field.name] ?? field.value ?? field.choices?.[0] ?? ""]))
  const clearedInput = Object.fromEntries(Object.entries(input).filter(([name]) => action.input?.find(f => f.name === name)?.kind !== "secret"))
  const stepper = ["capacity", "parallel", "todo_daily_admissions"].includes(action.args?.field ?? "")
  const fewer = { ...action.args, value: String(Math.max(0, Number(values.value) - 1)) }
  const more = { ...action.args, value: String(Number(values.value) + 1) }
  return <form className="setup-action" onSubmit={event => { event.preventDefault(); onAction(action.tag, { ...action.args, ...values }); setInput(clearedInput) }} data-flow={action.tag}>
    {action.input?.map(field => inline && field.name === "model" && /jev/i.test(field.value ?? "") ? null : <div className="setup-field" key={field.name}>{inline ? null : stepper ? <span>{field.label}</span> : <label htmlFor={`${id}-${field.name}`}>{field.label}</label>}
      {stepper ? <span className="setup-stepper">
        <button type="button" data-flow={action.tag} disabled={!!action.disabled} aria-label={`Fewer ${field.label}`} onClick={event => { event.preventDefault(); onAction(action.tag, fewer) }}>−</button>
        <output>{values[field.name]}</output>
        <button type="button" data-flow={action.tag} disabled={!!action.disabled} aria-label={`More ${field.label}`} onClick={event => { event.preventDefault(); onAction(action.tag, more) }}>+</button>
      </span> : field.kind === "choice" ? <select aria-label={inline ? field.label : undefined} id={`${id}-${field.name}`} value={values[field.name]} required={field.required} disabled={!!action.disabled} onChange={event => setInput({ ...input, [field.name]: event.target.value })}>{field.choices?.map(choice => <option key={choice} value={choice}>{choiceLabels[choice] ?? choice}</option>)}</select>
        : field.multiline && field.kind === "text" && !inline ? <textarea placeholder={placeholders ? field.label : undefined} aria-label={inline ? field.label : undefined} id={`${id}-${field.name}`} value={values[field.name]} required={field.required} disabled={!!action.disabled} onChange={event => setInput({ ...input, [field.name]: event.target.value })} />
        : <input placeholder={placeholders || inline ? field.label : undefined} aria-label={inline ? field.label : undefined} id={`${id}-${field.name}`} type={field.kind === "secret" ? "password" : "text"} autoComplete={field.kind === "secret" ? "new-password" : "off"} value={values[field.name]} required={field.required} disabled={!!action.disabled} onChange={event => setInput({ ...input, [field.name]: event.target.value })} />}
    </div>)}
    {stepper ? null : <button type="submit" data-flow={action.tag} data-primary={action.primary || undefined} disabled={!!action.disabled}>{action.label}</button>}
    {action.disabled && <span className="setup-reason">{action.disabled.reason}</span>}
  </form>
}

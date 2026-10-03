import { useState, type ChangeEvent, type FormEvent } from "react"
import type { MembersViewProps } from "@smthrs/rpc/MembersCard"
import type { Action } from "@smthrs/rpc/CardAction"
const roleWords: Record<string, string> = { owner: "Owner", maintainer: "Maintainer", member: "Member" }
// Inputs and available choices are supplied by the Container, never role policy here.
export function MemberAction({ action, onAction }: { action: Action; onAction: MembersViewProps["onAction"] }) {
  const signature = JSON.stringify([action.tag, action.args, action.input])
  const [draft, setDraft] = useState<{ signature: string; values: Record<string, string> }>({ signature, values: {} })
  const values = draft.signature === signature ? draft.values : {}
  if (draft.signature !== signature) setDraft({ signature, values: {} })
  const initial = (field: NonNullable<Action["input"]>[number]) => field.value ?? (field.kind === "choice" ? field.choices?.[0] : undefined) ?? ""
  const input = { ...action.args, ...Object.fromEntries((action.input ?? []).map(field => [field.name, initial(field)])), ...values }
  const change = (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft({ signature, values: { ...values, [event.currentTarget.name]: event.currentTarget.value } })
  const submit = (event: FormEvent) => { event.preventDefault(); onAction(action.tag, input) }
  return <span className="mvp-member-action">
    <form data-flow={action.tag} onSubmit={submit}>
      {action.input?.map(field => field.kind === "choice"
        ? <select key={field.name} name={field.name} aria-label={field.label} required={field.required} disabled={!!action.disabled} value={values[field.name] ?? initial(field)} onChange={change}>
          {field.choices?.map(choice => <option key={choice} value={choice}>{roleWords[choice] ?? choice}</option>)}
        </select>
        : <input key={field.name} name={field.name} aria-label={field.label} placeholder={field.label} type={field.kind === "secret" ? "password" : "text"} required={field.required} disabled={!!action.disabled} value={values[field.name] ?? initial(field)} onChange={change} />)}
      <button data-flow={action.tag} type="submit" disabled={!!action.disabled}>{action.label}</button>
    </form>
    {action.disabled ? <span className="mvp-member-reason">{action.disabled.reason}</span> : null}
  </span>
}


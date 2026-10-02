/*
 * A form (THE FORM LAW, apps/app/AGENTS.md; mvp.md §6.5): a flow invoked
 * without its required input, from a slash or by the app agent, opens a form
 * for exactly the missing fields, prefilled with whatever was given. It takes
 * the keyboard at its first open field, and Submit waits for every required
 * one. Submit runs the flow as the person who asked; the card becomes its receipt.
 */
import { Button } from "@smthrs/ui"
import { Check } from "lucide-react"
import { Card } from "../parts"
import { typedOr, useFrame } from "../frame"
import type { FlowForm } from "../world"
import type { ExtraCardProps } from "./extra"

export const FormCard = ({ id, target }: ExtraCardProps) => {
  const frame = useFrame()
  const { world, seq } = frame.state
  const form = world.forms?.find(each => each.id === target)
  if (form === undefined) return null
  const valueOf = (field: FlowForm["fields"][number]): string => typedOr(frame, `form:${form.id}:${field.id}`, field.value)
  const ready = form.fields.every(field => field.required !== true || valueOf(field).trim() !== "")
  return (
    <Card id={id} kind="form" title={form.title} focused={frame.state.viewers[frame.me]?.focus === id}>
      {form.receipt !== undefined ? (
        <p className="mvp-receipt-line" data-fresh={form.seq === seq || undefined}><Check size={14} aria-hidden="true" />{form.receipt}</p>
      ) : (
        <form onSubmit={event => event.preventDefault()}>
          {form.fields.map(field => (
            <label key={field.id} className="mvp-field">
              <span>{field.label}</span>
              {field.multiline
                ? <textarea rows={3} value={valueOf(field)} readOnly required={field.required} data-mock={`form-${form.id}-${field.id}`} />
                : <input value={valueOf(field)} readOnly required={field.required} data-mock={`form-${form.id}-${field.id}`} />}
            </label>
          ))}
          <div className="mvp-actions">
            <span className="mvp-actions-end">
              <Button size="sm" variant="ghost">Cancel</Button>
              <Button size="sm" variant="solid" type="submit" disabled={!ready} data-mock={`form-submit-${form.id}`}>{form.submit}</Button>
            </span>
          </div>
        </form>
      )}
    </Card>
  )
}

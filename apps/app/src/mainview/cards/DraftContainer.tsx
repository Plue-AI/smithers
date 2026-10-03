import type { ComponentType } from "react"
import { DraftCardSchema, type DraftCard } from "@smthrs/rpc/DraftCard"
import type { CardProps } from "@smthrs/rpc/CardAction"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "../flows/cardActions"
import type { DraftEntry } from "../state/seams/TodoSeam"

export interface DraftViewProps extends CardProps<DraftCard, {}, "set"> {
  readonly failure?: string
}
export interface DraftContainerProps {
  readonly card: DraftEntry
  readonly memberId: string
  readonly dispatch: CardCommandDispatch
  readonly View: ComponentType<DraftViewProps>
  readonly view: CardProps<DraftCard>["view"]
  readonly onView: CardProps<DraftCard>["onView"]
}
export const DraftContainer = ({ card, memberId, dispatch, View, view, onView }: DraftContainerProps) => {
  if (card.audience_member_id !== null && card.audience_member_id !== memberId) return null
  const model = DraftCardSchema.parse(card.payload)
  const definitions: CardActionDefinition[] = []
  if (model.committed) definitions.push({ tag: "todo", label: `T${model.committed.n}`, command_input: { n: model.committed.n } })
  else {
    const pending = card.payload.request && card.payload.request.state !== "failed"
    const place = model.place
    const invalid = !model.title.trim() || !model.prompt.trim() || place.mode !== "append" && !place.options.some(option => option.n === place.n)
    const common = { cardId: card.id, idempotencyKey: card.payload.idempotencyKey, text: model.prompt }
    const disabled = pending ? { reason: "Commit pending" } : invalid ? { reason: "Complete the draft" } : undefined
    if (place.mode === "amend") definitions.push({ tag: "todo.amend", label: "Commit", primary: true,
      command_input: { ...common, n: place.n }, disabled })
    else {
      const input = { ...common, title: model.title, acceptance: model.acceptance, before: place.mode === "before" ? place.n : undefined }
      definitions.push({ tag: "todo.new", label: "Commit", primary: true, command_input: input, disabled })
    }
    definitions.push({ tag: "draft.discard", label: "Discard", command_input: { draft: card.id }, disabled: pending ? { reason: "Commit pending" } : undefined })
    definitions.push({ tag: "form.set", gesture: "set", label: "Edit", command_input: { cardId: card.id, field: "", value: "" },
      disabled: pending ? { reason: "Commit pending" } : undefined,
      resolve_input: input => ({ cardId: card.id, field: input.field ?? "", value: input.value ?? "" }) })
  }
  const bindings = cardActions(dispatch, definitions)
  return <View model={model} actions={bindings.actions} onAction={bindings.onAction} view={view} onView={onView}
    gestures={bindings.gestures} failure={card.payload.request?.error ?? card.payload.optionsFailure} />
}

import type { ComponentType } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import { DraftCardSchema, type DraftCard } from "@smthrs/rpc/DraftCard"
import type { CardProps } from "@smthrs/rpc/CardAction"
import { cardActions, type CardActionDefinition, type CardCommandDispatch } from "../flows/cardActions"
import type { DraftEntry } from "../state/seams/TodoSeam"
import { useController } from "../ControllerContext"
import { designAudience } from "../state/seams/DesignWorld/todo"
import { useDesignViewer } from "../state/seams/DesignWorld/hooks"
import type { CardFamily, CardOf } from "./CardFamily"
import { DraftView } from "./views/DraftView"

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
    /* Title and prompt save on blur, so a Commit pressed while typing must stay live; the flow refuses an empty draft. */
    const invalid = place.mode !== "append" && !place.options.some(option => option.n === place.n)
    /* Absent keys stay absent: the flow input decodes `before?: number`, not `before: undefined`. */
    const common = { cardId: card.id, text: model.prompt, ...(card.payload.idempotencyKey === undefined ? {} : { idempotencyKey: card.payload.idempotencyKey }) }
    const disabled = pending ? { reason: "Commit pending" } : invalid ? { reason: "Complete the draft" } : undefined
    if (place.mode === "amend") definitions.push({ tag: "todo.amend", label: "Commit", primary: true,
      command_input: { ...common, n: place.n }, disabled })
    else {
      /* The seam commits the saved Draft. A press rendered before the Title's save landed carries no empty title, which the flow input refuses. */
      const input = { ...common, ...(model.title ? { title: model.title } : {}), acceptance: model.acceptance, ...(place.mode === "before" ? { before: place.n } : {}) }
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

/** The `draft` kind: private to its author until Commit. The viewer comes from the design seed (mock seam). */
const DraftBody = ({ card, maximized }: { readonly card: CardOf<"draft">; readonly maximized: boolean }) => {
  const controller = useController()
  const viewer = useDesignViewer()
  const identity = useLiveQuery(controller.store.collections.identitySessions).data[0]
  const dispatch: CardCommandDispatch = (tag, input) =>
    controller.commands.submit({ name: tag, payload: (input ?? {}) as Record<string, unknown>, actor: "user", originCardId: card.id })
  return <DraftContainer card={card} memberId={card.audience_member_id?.startsWith("design:") ? designAudience(viewer) : identity?.login ?? ""} dispatch={dispatch} View={DraftView}
    view={{ maximized }} onView={() => {}} />
}
export const draftCardFamily: CardFamily<"draft"> = {
  draft: { render: (card, actions) => <DraftBody card={card} maximized={actions.presentation === "maximized"} />, pill: () => "" }
}

import { Data } from "effect"
import { MemberConfirmationSchema, type MemberConfirmation, type ConfirmCard, type ConfirmViewProps } from "@smthrs/rpc/ConfirmCard"
import { cardActions, type CardCommandDispatch } from "../flows/cardActions"
import type { CardFamily } from "./CardFamily"

export class ConfirmationUnavailable extends Data.TaggedError("ConfirmationUnavailable") {
  readonly message = "Confirmation unavailable"
  readonly status = 503
  readonly error = { class: "infra", code: "confirmation_unavailable", message: "Confirmation unavailable" }
}

/** T-ACC-02/03/04 and T-CAT-01 must supply private audience and session-only dispatch before activation. */
export const confirmationUnavailable = (): never => {
  throw new ConfirmationUnavailable()
}

/** No initiating command is dispatched as an approval; missing consumers fail before effects. */
export const confirmCardProps = (model: ConfirmCard): ConfirmViewProps => ({
  model,
  ...cardActions(confirmationUnavailable, [], confirmationUnavailable),
  view: { maximized: false },
  onView: () => {}
})

/** Only the authenticated private live projection can supply a person confirmation. */
export const memberConfirmations = (data: unknown): readonly MemberConfirmation[] => {
  if (!Array.isArray(data)) return []
  const rows = data.flatMap(value => {
    const row = MemberConfirmationSchema.safeParse(value)
    return row.success ? [row.data] : []
  })
  return [...new Map(rows.map(row => [row.id, row])).values()]
}

/** The initiating tag is presentation only; the press always uses a person decision flow. */
export const memberConfirmCardProps = (row: MemberConfirmation, dispatch: CardCommandDispatch, mayMerge = false): ConfirmViewProps => {
  let model = row.payload.card
  if (row.state === "expired") {
    const by = model.asked_by.kind === "person" ? model.asked_by : model.asked_by.kind === "agent" ? model.asked_by.for_member : undefined
    if (by) model = { ...model, receipt: { by, result: "expired", at: row.decided_at ?? row.expires_at, text: "Expired" } }
  }
  const pending = row.state === "pending" && !model.receipt
  const disabled = model.kind === "review_merge" && (!mayMerge || model.review?.merge.state !== "ready")
    ? { reason: mayMerge ? "" : "A maintainer merges" } : undefined
  return { model, view: { maximized: false }, onView: () => {},
    ...cardActions(dispatch, pending ? [
      { tag: "approval.approve", label: model.action.verb, primary: true, command_input: { cardId: `confirmation:${row.id}` }, ...(disabled ? { disabled } : {}) },
      { tag: "approval.deny", label: "Cancel", command_input: { cardId: `confirmation:${row.id}` }, ...(model.kind === "review_merge" && model.review?.merge.state === "merging" ? { disabled: { reason: "" } } : {}) }
    ] : [], confirmationUnavailable) }
}

/** Legacy rows keep their title in the shared shell. No private Confirm payload mounts without actor authority. */
export const approvalCardFamily: CardFamily<"approval"> = {
  approval: { render: () => null, pill: () => "" }
}

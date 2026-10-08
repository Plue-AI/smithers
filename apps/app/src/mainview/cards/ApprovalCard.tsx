import { useLiveQuery } from "@tanstack/react-db"
import { ApprovalAnswerForm } from "./RunsCards"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { describedFailure, FailureNotice } from "../FailureNotice"
import { runtimeApprovalIdOf, projectRuntimeCard } from "../state/RuntimeProjection"
import type { CardActions, RunCommand } from "./CardFamily"
import type { Card } from "../state/AppState"
import { Data } from "effect"
import { MemberConfirmationSchema, type MemberConfirmation, type ConfirmCard, type ConfirmViewProps } from "@smthrs/rpc/ConfirmCard"
import { flowArgs } from "../flows/FlowArgs"
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

export const APPROVAL_DECISION_FAILED: UserFailureCopy = {
  fault: "infra", sentence: "Smithers could not record this decision. Not your fault.", actions: []
}

const TrustedApprovalBody = ({ card, onDecideApproval, onRunCommand }: {
  readonly card: Extract<Card, { kind: "approval" }>
  readonly onDecideApproval: CardActions["onDecideApproval"]
  readonly onRunCommand: RunCommand
}) => {
  const { payload } = card
  if (!payload.question || card.status === "acted") return <ApprovalRecord card={card} />
  return <div className="sui-approval-answer-body">
    <ApprovalAnswerForm question={payload.question} draft={payload.answerDraft}
      disabled={payload.pending === true}
      onDraft={value => { if (payload.answerDraft) onRunCommand("form.set", flowArgs("form.set", { cardId: card.id, field: `answer:${payload.answerDraft.question}`, value })) }}
      onAnswer={answer => onDecideApproval(card.id, "approved", answer, payload.answerDraft?.question)} />
    {card.status === "error" && payload.error !== undefined ? <FailureNotice className="sui-approval-error" data-testid="approval-decision-failure"
      failure={describedFailure("approval.decide", APPROVAL_DECISION_FAILED, payload.error)} /> : null}
  </div>
}

/** Historical records stay readable and cannot become executable by gaining a callback. */
const ApprovalRecord = ({ card }: { readonly card: Extract<Card, { kind: "approval" }> }) => <div className="sui-approval-record">
  <p>{card.body ?? card.payload.detail ?? card.payload.question?.prompt ?? card.payload.capability}</p>
  {card.payload.question?.options?.length ? <ul>{card.payload.question.options.map(option => <li key={option}>{option}</li>)}</ul> : null}
</div>

/** Only a current private runtime projection supplies the answer/grant controls. */
const RuntimeApprovalBody = ({ card, actions }: { readonly card: Extract<Card, { kind: "approval" }>; readonly actions: CardActions & { readonly projectionStore: NonNullable<CardActions["projectionStore"]> } }) => {
  const { data: approvals } = useLiveQuery(actions.projectionStore.collections.runtimeApprovals)
  const id = runtimeApprovalIdOf(card)
  if (card.runtimeView?.revision !== undefined || !id || !approvals.some(row => row.id === id)) return <ApprovalRecord card={card} />
  const projected = projectRuntimeCard(card, [], approvals)
  if (projected.kind !== "approval") return <ApprovalRecord card={card} />
  return <TrustedApprovalBody card={projected} onDecideApproval={actions.onDecideApproval} onRunCommand={actions.onRunCommand} />
}

export const approvalCardFamily: CardFamily<"approval"> = {
  approval: { render: (card, actions) => actions.projectionStore ? <RuntimeApprovalBody card={card} actions={{ ...actions, projectionStore: actions.projectionStore }} /> : <ApprovalRecord card={card} />, pill: () => "" }
}

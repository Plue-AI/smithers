import { flowArgs } from "../flows/FlowArgs"
/*
 * The approval card: a capability the run asked the human to allow. The
 * decision rides onDecideApproval; the stamp says what was decided and when.
 *
 * A card carrying a QUESTION is the other shape: a HumanTask parked the run on
 * something only a person knows, so the card renders the prompt and a box for
 * the answer, and the answer rides the same callback.
 */
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest
} from "@smthrs/ui"
import type { ApprovalState } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import { ApprovalAnswerForm } from "./ApprovalAnswer"
import { timeLabel as clockLabel } from "../Timestamps"
import type { CardFamily, RunCommand } from "./CardFamily"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { describedFailure, FailureNotice } from "../FailureNotice"

/* A decision the gateway did not record; its own words stay behind Details. Shared with the approvals inbox. */
export const APPROVAL_DECISION_FAILED: UserFailureCopy = {
  fault: "infra", sentence: "Smithers could not record this decision. Not your fault.", actions: []
}

const ApprovalCardBody = ({
  card,
  onDecideApproval,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "approval" }>
  readonly onDecideApproval: (id: string, decision: "approved" | "denied", answer?: unknown, question?: string) => void
  readonly onRunCommand: RunCommand
}) => {
  const payload = card.payload
  const pending = payload.pending === true
  const state: ApprovalState = card.status === "error"
    ? "failed-submission"
    : card.status === "acted"
    ? (payload.decision ?? "approved")
    : "requested"
  const summary = card.body ?? payload.detail
  const stamp = payload.decidedAt !== undefined
    ? `${payload.decision === "denied" ? "Denied" : "Approved"} — ${clockLabel(payload.decidedAt)}`
    : undefined
  return (
    <Confirmation state={state}>
      <ConfirmationRequest>
        {summary !== undefined ? <div className="sui-approval-summary">{summary}</div> : null}
        {/* The capability is the card's title at creation, so it prints only
         * when it says something the header doesn't — as a mono caption, not
         * a one-item bullet list. */}
        {payload.capability === card.title ? null : <p className="sui-approval-meta"><code>{payload.capability}</code></p>}
      </ConfirmationRequest>
      {pending ? <p className="sui-approval-pending">Sending your decision…</p> : card.status === "acted" ? null : payload.question !== undefined ?
        (
          /* A gate that asks a question rather than for a grant: the run is
           * stuck on something only a person knows, and approve/deny answer
           * none of it. */
          <ApprovalAnswerForm
            key={payload.answerDraft?.question}
            question={payload.question}
            draft={payload.answerDraft}
            onDraft={value => {
              if (payload.answerDraft !== undefined) onRunCommand("form.set", flowArgs("form.set", { cardId: card.id, field: `answer:${payload.answerDraft.question}`, value }))
            }}
            disabled={false}
            onAnswer={(answer) => onDecideApproval(card.id, "approved", answer, payload.answerDraft?.question)}
          />
        ) :
        (
          <ConfirmationActions>
            <ConfirmationAction
              decision="approve"
              onDecide={() => onDecideApproval(card.id, "approved")}
            />
            <ConfirmationAction
              decision="deny"
              onDecide={() => onDecideApproval(card.id, "denied")}
            />
          </ConfirmationActions>
        )}
      {card.status === "error" && payload.error !== undefined ?
        <FailureNotice className="sui-approval-error" data-testid="approval-decision-failure"
          failure={describedFailure("approval.decide", APPROVAL_DECISION_FAILED, payload.error)} /> :
        null}
      <ConfirmationAccepted>{stamp}</ConfirmationAccepted>
      <ConfirmationRejected>{stamp}</ConfirmationRejected>
    </Confirmation>
  )
}


export const approvalCardFamily: CardFamily<"approval"> = {
  approval: {
    render: (card, actions) => <ApprovalCardBody card={card} onDecideApproval={actions.onDecideApproval} onRunCommand={actions.onRunCommand} />,
    pill: (card) => {
      if (card.status === "acted") return card.payload.decision ?? "approved"
      return "waiting-approval"
    }
  }
}

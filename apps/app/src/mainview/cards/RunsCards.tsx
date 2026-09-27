import { flowAction } from "../flows/FlowAction"
/*
 * Lane runs — the run inbox and the approvals inbox cards.
 *
 * The run inbox (runs.list) rows one summary per run on the workspace; a
 * row's only act is Open, which materializes the run's own card — the acts
 * (resume, steer, stop) live on that card, so there is one run surface, not
 * two. The approvals inbox (approvals.list) carries each pending gate with
 * the submit-ready envelope the gateway published; a decision dispatches the
 * same approval.approve / approval.deny flows a per-run approval card uses,
 * addressed by the inbox card, run and request together. A row that carries a
 * QUESTION — a HumanTask waiting on a person — gets an answer box instead of
 * the two buttons, because approve and deny tell that run nothing.
 */
import { Button, Confirmation, ConfirmationAccepted, ConfirmationAction, ConfirmationActions, ConfirmationRejected, ConfirmationRequest } from "@smthrs/ui"
import { StatusDetails } from "../StatusDetails"
import type { Card } from "../state/AppState"
import { approvalActionId, approvalRowKey } from "../state/ApprovalReference"
import { ApprovalAnswerForm } from "./ApprovalAnswer"
import { timeLabel as clockLabel } from "../Timestamps"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"
import { flowArgs } from "../flows/FlowArgs"

/** Why a run is not moving, in words: the control plane's reason, translated. */
const waitingWords = (waiting: string): string =>
  waiting === "executor" ? "accepted · nothing is driving it" : `waiting · ${waiting}`

/** The statuses a run can still be stopped in. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["accepted", "running", "parked", "waiting-approval"])

export const RunListCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "run-list" }>
  readonly onRunCommand: RunCommand
}) => {
  const { repo, runs, approvals = [], observationError } = card.payload
  const attention = card.payload.status === "attention"
  const pending = card.payload.listRequest?.state === "pending"
  /*
   * The header's mono count line: one clause per status present, in the
   * order a reader triages — live first, settled last.
   */
  const countByStatus = new Map<string, number>()
  for (const run of runs) countByStatus.set(run.status, (countByStatus.get(run.status) ?? 0) + 1)
  const countLine = [...countByStatus.entries()]
    .sort(([left], [right]) => Number(LIVE_STATUSES.has(right)) - Number(LIVE_STATUSES.has(left)) || left.localeCompare(right))
    .map(([status, count]) => `${count} ${status}`)
    .join(" · ")
  /* The filter chips: every status the unfiltered workspace could carry, each re-invoking runs.list with its argument. */
  const chips = [...new Set([...(card.payload.statuses ?? []), ...runs.map((run) => run.status)])].sort()
  const listArgs = (status?: string): string =>
    flowArgs("runs.list", { status, flow: card.payload.flow, lineage: card.payload.lineage, sourceCard: card.id, repo })
  const liveCount = runs.filter((run) => LIVE_STATUSES.has(run.status)).length
  return (
    <div className="world-card-list">
      <div className="flow-run-actions">
        <Button size="sm" variant={attention ? "default" : "outline"} 
          {...flowAction(onRunCommand, "runs.attention", flowArgs("runs.attention", { sourceCard: card.id, repo }))}>Needs attention</Button>
        <Button size="sm" variant="outline" 
          {...flowAction(onRunCommand, "runs.list", listArgs(card.payload.status))}>Refresh</Button>
        {attention ? <Button size="sm" variant="outline" 
          {...flowAction(onRunCommand, "runs.list", listArgs())}>All runs</Button> : null}
      </div>
      {observationError === undefined ? null : <p className="sui-approval-error" role="alert">Some state could not be read: {observationError}</p>}
      {attention && card.payload.observedAt !== undefined ? <p className="smithers-card-note">{repo} · checked {clockLabel(card.payload.observedAt)}</p> : null}
      {attention && approvals.length > 0 ? <ul className="world-card-list" aria-label="Pending approvals">
        {approvals.map(approval => <li key={`${approval.runId}:${approval.requestId}`} className="world-card-row">
          <span className="world-card-title">{approval.title}</span>
          <span className="world-card-path">run {approval.runId} · approval required</span>
          <Button size="sm" variant="outline" 
            {...flowAction(onRunCommand, "approvals.open", flowArgs("approvals.open", { runId: approval.runId, sourceCard: card.id }))}>Review request</Button>
        </li>)}
      </ul> : null}
      {pending || (runs.length === 0 && observationError !== undefined) ? null : <p className="smithers-card-note" data-testid="run-list-counts">
        {runs.length === 0 ? attention
          ? observationError !== undefined ? "Run state is incomplete." : approvals.length === 0 ? "No pending approvals or parked or failed runs were recorded." : "No other parked or failed runs were recorded."
          : "No runs match." : `${runs.length} ${runs.length === 1 ? "run" : "runs"} · ${countLine}`}
      </p>}
      {!attention && chips.length > 1 ?
        (
          <div className="flow-run-actions" role="group" aria-label="Filter by status">
            <Button
              size="sm"
              variant={card.payload.status === undefined ? "default" : "outline"}
              {...flowAction(onRunCommand, "runs.list", listArgs())}
            >
              All
            </Button>
            {chips.map((status) => (
              <Button
                key={status}
                size="sm"
                variant={card.payload.status === status ? "default" : "outline"}
                data-testid={`run-list-chip-${status}`}
                {...flowAction(onRunCommand, "runs.list", listArgs(status))}
              >
                {status}
              </Button>
            ))}
          </div>
        ) :
        null}
      {runs.length === 0 ?
        null :
        (
          <ul className="world-card-list">
            {runs.map((run) => (
              <li key={run.runId} className="world-card-row" data-status={run.status}>
                <span className="world-card-path">{run.runId}</span>
                <span className="world-card-title">{run.flowId}</span>
                <span className="world-card-path">
                  {run.statusRollup === undefined ? run.waiting === undefined ? run.status : waitingWords(run.waiting) :
                    <StatusDetails status={run.statusRollup} fallback={run.status} />}
                </span>
                <span className="world-card-path">
                  {run.turns} {run.turns === 1 ? "turn" : "turns"} · {run.calls} {run.calls === 1 ? "call" : "calls"}
                </span>
                <span className="world-card-path">{clockLabel(run.createdAt)}</span>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`runs-open-${run.runId}`}
                  {...flowAction(onRunCommand, "runs.open", flowArgs("runs.open", { sourceCard: card.id, runId: run.runId }))}
                >
                  Open
                </Button>
              </li>
            ))}
          </ul>
        )}
      {liveCount > 0 ?
        (
          <div className="flow-run-actions">
            <Button
              size="sm"
              variant="outline"
              data-testid="run-list-stop-all"
              {...flowAction(onRunCommand, "flow.run.stop-all", flowArgs("flow.run.stop-all", { sourceCard: card.id, repo }))}
            >
              Stop all {liveCount}
            </Button>
          </div>
        ) :
        null}
    </div>
  )
}

/** The run that asked: its door when the card dispatches, else its id. */
const RunRef = ({ runId, onRunCommand }: { readonly runId: string; readonly onRunCommand?: RunCommand | undefined }) => (
  <span className="inbox-refs">
    <span>run {onRunCommand === undefined ? <code>{runId}</code> : (
      <button type="button" className="thread-ref" {...flowAction(onRunCommand, "runs.open", flowArgs("runs.open", { runId }))}>{runId}</button>
    )}</span>
  </span>
)

export const ApprovalsInboxCardBody = ({
  card,
  onDecideApproval,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "approvals-inbox" }>
  readonly onDecideApproval: (id: string, decision: "approved" | "denied", answer?: unknown, question?: string) => void
  readonly onRunCommand?: RunCommand
}) => {
  const { repo, approvals } = card.payload
  const grants = approvals.filter(approval => approval.decision === undefined && approval.question === undefined).length
  const questions = approvals.filter(approval => approval.decision === undefined && approval.question !== undefined).length
  if (approvals.length === 0) {
    return <p className="smithers-card-note">Nothing needs you on {repo}.</p>
  }
  /* The header's mono count line: one clause per kind present. */
  const countLine = [
    grants > 0 ? `${grants} approval${grants === 1 ? "" : "s"} pending` : undefined,
    questions > 0 ? `${questions} question${questions === 1 ? "" : "s"} pending` : undefined
  ].filter((clause): clause is string => clause !== undefined)
  return (
    <div className="world-card-list">
      <p className="smithers-card-note" data-testid="approvals-inbox-count">
        {countLine.length === 0 ? "0 approvals pending" : countLine.join(" · ")}
      </p>
      {approvals.map((approval) => {
        // The row id the decision flows take: the inbox card plus the gate it names.
        const rowId = approvalActionId(card.id, approval)
        const state = approval.decisionError !== undefined
          ? "failed-submission"
          : approval.decision ?? "requested"
        // The stamp states WHEN the decision was made, never when the gate was
        // raised; a row that has no decision time says only what it decided.
        const stamp = approval.decidedAt === undefined
          ? undefined
          : `${approval.decision === "denied" ? "Denied" : "Approved"} — ${clockLabel(approval.decidedAt)}`
        // The answer form carries its prompt while editable; every other
        // state retains that prompt or the grant title beside its receipt.
        return (
          <Confirmation key={approvalRowKey(approval)} state={state}>
            {approval.question === undefined || approval.decision !== undefined || approval.pending === true ?
              <div className="sui-approval-question">{approval.question?.prompt ?? approval.title}</div> : null}
            <ConfirmationRequest>
              <p className="sui-approval-meta">
                <RunRef runId={approval.runId} onRunCommand={onRunCommand} /> · {clockLabel(approval.requestedAt)}
              </p>
            </ConfirmationRequest>
            {approval.decision !== undefined || approval.pending === true ?
              null :
              approval.question !== undefined ?
              (
                /* A gate that asks a question: the run needs a value, not a
                 * grant, so the row gets the box the answer is typed into. */
                <ApprovalAnswerForm
                  key={approval.answerDraft?.question}
                  question={approval.question}
                  draft={approval.answerDraft}
                  onDraft={value => {
                    if (approval.answerDraft !== undefined) onRunCommand?.("form.set", flowArgs("form.set", { cardId: rowId, field: `answer:${approval.answerDraft.question}`, value }))
                  }}
                  disabled={false}
                  onAnswer={(answer) => onDecideApproval(rowId, "approved", answer, approval.answerDraft?.question)}
                />
              ) :
              (
                <ConfirmationActions>
                  <ConfirmationAction
                    decision="approve"
                    onDecide={() => onDecideApproval(rowId, "approved")}
                  />
                  <ConfirmationAction
                    decision="deny"
                    onDecide={() => onDecideApproval(rowId, "denied")}
                  />
                </ConfirmationActions>
              )}
            {approval.decisionError !== undefined ?
              (
                <p className="sui-approval-error" role="alert">
                  {approval.decisionError}
                </p>
              ) :
              null}
            <ConfirmationAccepted>{stamp}</ConfirmationAccepted>
            <ConfirmationRejected>{stamp}</ConfirmationRejected>
          </Confirmation>
        )
      })}
    </div>
  )
}

/* Lane runs: the inboxes are listings; they settle the moment they render. */
export const runsCardFamily: CardFamily<"run-list" | "approvals-inbox"> = {
  "run-list": {
    render: (card, actions) => <RunListCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  },
  "approvals-inbox": {
    render: (card, actions) => <ApprovalsInboxCardBody card={card} onDecideApproval={actions.onDecideApproval} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}

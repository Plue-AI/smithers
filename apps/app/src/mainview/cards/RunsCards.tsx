import { canDecide } from "../state/ApprovalDeciders"
import { flowAction } from "../flows/FlowAction"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { describedFailure, FailureNotice } from "../FailureNotice"
/*
 * Lane runs — the run inbox and the approvals inbox cards.
 *
 * The run inbox (runs.list) groups one summary per run on the workspace into
 * Needs you, Working and Done. Every row opens the run's own card, where the
 * acts (resume, steer, stop) live; a needs-you row adds its one act, Answer
 * (approvals.open, the gate's answer form) or Resume for an operator's park. The approvals inbox (approvals.list) carries each pending gate with
 * the submit-ready envelope the gateway published; a decision dispatches the
 * same approval.approve / approval.deny flows a per-run approval card uses,
 * addressed by the inbox card, run and request together. A row that carries a
 * QUESTION — a HumanTask waiting on a person — gets an answer box instead of
 * the two buttons, because approve and deny tell that run nothing.
 */
import { Button, Textarea, Confirmation, ConfirmationAccepted, ConfirmationAction, ConfirmationActions, ConfirmationRejected, ConfirmationRequest } from "@smthrs/ui"
import { StatusDetails } from "../StatusDetails"
import type { Card } from "../state/AppState"
import { approvalActionId, approvalRowKey } from "../state/ApprovalReference"
import { timeLabel as clockLabel } from "../Timestamps"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"
import { flowArgs } from "../flows/FlowArgs"
import { runSourceCommand } from "@smthrs/ui/run-command"
import { GROUP_HEADING, INBOX_GROUPS, needsYouAct, onProviderLimit, runGroup, runTone, TONE_GLYPH, type InboxGroup, type InboxRun } from "./RunsInbox"

/* A run listing the gateway answered only in part, or not at all: the read's state picks the sentence. */
export const RUN_LIST_FAILURES: Readonly<Record<"partial" | "failed", UserFailureCopy>> = {
  partial: { fault: "infra", sentence: "Smithers could not read every run. Not your fault.", actions: [] },
  failed: { fault: "infra", sentence: "Smithers could not load this repository's runs. Not your fault.", actions: [] }
}

/** Why a run is not moving, in words: the control plane's reason, translated. */
const waitingWords = (waiting: string): string =>
  waiting === "executor" ? "accepted · nothing is driving it" : waiting === "budget" ? "spend cap" : `waiting · ${waiting}`

/** The statuses a run can still be stopped in. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["accepted", "running", "parked", "waiting-approval"])

export const RunListCardBody = ({
  admin = false,
  card,
  onRunCommand
}: {
  readonly admin?: boolean
  readonly card: Extract<Card, { kind: "run-list" }>
  readonly onRunCommand: RunCommand
}) => {
  const { repo, runs, observationError } = card.payload
  // An approval nobody here can decide is not offered (state/ApprovalDeciders.ts).
  const approvals = (card.payload.approvals ?? []).filter((approval) =>
    canDecide(runs.find((run) => run.runId === approval.runId)?.flowId, admin))
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
  /*
   * Needs you, Working, Done (cards/RunsInbox.ts). A pending approval whose
   * run is not already a needs-you row is a needs-you row of its own.
   */
  const byGroup = (group: InboxGroup) => runs.filter((run) => runGroup(run) === group)
  const needsYou = new Set(byGroup("needs-you").map((run) => run.runId))
  const loneApprovals = approvals.filter((approval) => !needsYou.has(approval.runId))
  const runCommand = runSourceCommand(card.id, onRunCommand)
  const answer = (runId: string) =>
    flowAction(onRunCommand, "approvals.open", flowArgs("approvals.open", { runId, sourceCard: card.id }))
  const runRow = (run: InboxRun) => {
    const tone = runTone(run)
    /* The gate's own words, so the row says what is being asked before it is opened. */
    const gate = approvals.find((approval) => approval.runId === run.runId)
    /* A gate nobody here can decide is not offered (state/ApprovalDeciders.ts), exactly as on the run card. */
    const act = tone !== "needs-you" ? undefined : needsYouAct(run) === "resume" ? "resume" : canDecide(run.flowId, admin) ? "answer" : undefined
    return (
      <li key={run.runId} className="world-card-row" data-status={run.status} data-tone={tone}>
        <span className="runs-inbox-glyph" data-tone={tone} aria-hidden>{TONE_GLYPH[tone]}</span>
        <span className="world-card-path">{run.runId}</span>
        <span className="world-card-title">{run.flowId}</span>
        {gate === undefined ? null : <span className="world-card-title" data-testid={`runs-gate-${run.runId}`}>{gate.title}</span>}
        <span className="world-card-path">
          {run.statusRollup === undefined ? run.waiting === undefined ? run.status : waitingWords(run.waiting) :
            <StatusDetails status={run.statusRollup} fallback={run.status} />}
        </span>
        {onProviderLimit(run) ? <span className="world-card-path" data-testid={`runs-limit-${run.runId}`}>Not your fault · @fucory</span> : null}
        <span className="world-card-path">
          {run.turns} {run.turns === 1 ? "turn" : "turns"} · {run.calls} {run.calls === 1 ? "call" : "calls"}
        </span>
        <span className="world-card-path">{clockLabel(run.createdAt)}</span>
        {act === "answer" ?
          <Button size="sm" data-testid={`runs-answer-${run.runId}`} aria-label={`Answer ${run.runId}`} {...answer(run.runId)}>Answer</Button> :
          act === "resume" ?
          <Button size="sm" data-testid={`runs-resume-${run.runId}`} aria-label={`Resume ${run.runId}`} {...flowAction(runCommand, "runs.resume", run.runId)}>Resume</Button> : null}
        <Button
          size="sm"
          variant="outline"
          data-testid={`runs-open-${run.runId}`}
          aria-label={`Open ${run.runId}`}
          {...flowAction(onRunCommand, "runs.open", flowArgs("runs.open", { sourceCard: card.id, runId: run.runId }))}
        >
          Open
        </Button>
      </li>
    )
  }
  const groups = INBOX_GROUPS.map((group) => ({ group, rows: byGroup(group) }))
    .map(({ group, rows }) => ({ group, rows, count: rows.length + (group === "needs-you" ? loneApprovals.length : 0) }))
    .filter(({ count }) => count > 0)
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
      {observationError === undefined ? null : ((read: "partial" | "failed") => (
        <FailureNotice className="sui-approval-error" data-testid="run-list-failure"
          failure={describedFailure(`runs.list.${read}`, RUN_LIST_FAILURES[read], observationError)} />
      ))(card.payload.listRequest?.state === "failed" ? "failed" : "partial")}
      {attention && card.payload.observedAt !== undefined ? <p className="smithers-card-note">{repo} · checked {clockLabel(card.payload.observedAt)}</p> : null}
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
      {groups.map(({ group, rows, count }) => (
        <section key={group} className="runs-inbox-group" aria-label={GROUP_HEADING[group].label} data-testid={`runs-inbox-${group}`}>
          <h3 className="runs-inbox-heading" data-group={group}>
            <span className="runs-inbox-glyph" aria-hidden>{GROUP_HEADING[group].glyph}</span> {GROUP_HEADING[group].label} <span className="runs-inbox-count">{count}</span>
          </h3>
          <ul className="world-card-list">
            {group !== "needs-you" ? null : loneApprovals.map((approval) => (
              <li key={`${approval.runId}:${approval.requestId}`} className="world-card-row" data-tone="needs-you">
                <span className="runs-inbox-glyph" data-tone="needs-you" aria-hidden>{TONE_GLYPH["needs-you"]}</span>
                <span className="world-card-path">{approval.runId}</span>
                <span className="world-card-title">{approval.title}</span>
                <Button size="sm" data-testid={`runs-answer-${approval.runId}`} aria-label={`Answer ${approval.runId}`} {...answer(approval.runId)}>Answer</Button>
              </li>
            ))}
            {rows.map(runRow)}
          </ul>
        </section>
      ))}
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
/** A decision's word: a guard's park is continued or stopped, any other gate approved or denied. */
const decisionWords = (denied: boolean, incident: boolean): string =>
  incident ? denied ? "Stopped" : "Continued" : denied ? "Denied" : "Approved"

const RunRef = ({ runId, onRunCommand }: { readonly runId: string; readonly onRunCommand?: RunCommand | undefined }) => (
  <span className="inbox-refs">
    <span>run {onRunCommand === undefined ? <code>{runId}</code> : (
      <button type="button" className="thread-ref" {...flowAction(onRunCommand, "runs.open", flowArgs("runs.open", { runId }))}>{runId}</button>
    )}</span>
  </span>
)

export const ApprovalsInboxCardBody = ({
  admin = false,
  card,
  onDecideApproval,
  onRunCommand
}: {
  readonly admin?: boolean
  readonly card: Extract<Card, { kind: "approvals-inbox" }>
  readonly onDecideApproval: (id: string, decision: "approved" | "denied", answer?: unknown, question?: string) => void
  readonly onRunCommand?: RunCommand
}) => {
  const { repo } = card.payload
  // An approval nobody here can decide is not offered (state/ApprovalDeciders.ts).
  const approvals = card.payload.approvals.filter((approval) => canDecide(approval.question?.name, admin))
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
          : `${decisionWords(approval.decision === "denied", approval.incident !== undefined)} — ${clockLabel(approval.decidedAt)}`
        // The answer form carries its prompt while editable; every other
        // state retains that prompt or the grant title beside its receipt.
        return (
          <Confirmation key={approvalRowKey(approval)} state={state}>
            {approval.question === undefined || approval.decision !== undefined || approval.pending === true ?
              <div className="sui-approval-question" title={approval.incident?.message}>
                {approval.incident === undefined ? approval.question?.prompt ?? approval.title : `${approval.incident.classification} · ${approval.title}`}
              </div> : null}
            {/* A build target's approval is a plan, not a run: its title names it. */}
            {approval.runId.startsWith("plan:") ? null : (
              <ConfirmationRequest>
                <p className="sui-approval-meta">
                  <RunRef runId={approval.runId} onRunCommand={onRunCommand} /> · {clockLabel(approval.requestedAt)}
                </p>
              </ConfirmationRequest>
            )}
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
                  {/* A guard's park is decided as Continue and Stop. */}
                  <ConfirmationAction
                    decision="approve"
                    onDecide={() => onDecideApproval(rowId, "approved")}
                  >{approval.incident === undefined ? undefined : "Continue"}</ConfirmationAction>
                  <ConfirmationAction
                    decision="deny"
                    onDecide={() => onDecideApproval(rowId, "denied")}
                  >{approval.incident === undefined ? undefined : "Stop"}</ConfirmationAction>
                </ConfirmationActions>
              )}
            {approval.decisionError !== undefined ?
              <FailureNotice className="sui-approval-error" data-testid="approval-decision-failure"
                failure={describedFailure("approval.decide", APPROVAL_DECISION_FAILED, approval.decisionError)} /> :
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
    render: (card, actions) => <RunListCardBody card={card} onRunCommand={actions.onRunCommand} admin={actions.admin === true} />,
    pill: settledPill
  },
  "approvals-inbox": {
    render: (card, actions) => <ApprovalsInboxCardBody card={card} onDecideApproval={actions.onDecideApproval} onRunCommand={actions.onRunCommand} admin={actions.admin === true} />,
    pill: settledPill
  }
}

import { useRef, useState } from "react"
import type { ApprovalQuestion } from "./ApprovalQuestion"
import { attemptWords } from "./ApprovalQuestion"

/** What a person typed, shaped for the question's kind, or why it cannot be sent. */
export const answerValue = (
  question: ApprovalQuestion,
  typed: string
): { readonly value: unknown } | { readonly error: string } => {
  const trimmed = typed.trim()
  if (question.kind === "json") {
    if (trimmed === "") return { error: "Type the JSON answer this question asks for." }
    try {
      return { value: JSON.parse(trimmed) as unknown }
    } catch {
      return { error: "That is not JSON. Check the quotes and brackets, then send it again." }
    }
  }
  if (trimmed === "") return { error: "Type an answer before sending it." }
  return { value: trimmed }
}

export const ApprovalAnswerForm = ({
  question,
  draft,
  onDraft,
  disabled,
  onAnswer
}: {
  readonly question: ApprovalQuestion
  readonly draft?: { readonly question: string; readonly text: string }
  readonly onDraft?: (value: string) => void
  readonly disabled: boolean
  readonly onAnswer: (answer: unknown) => void
}) => {
  // The DOM holds in-flight editing while form.set commits; the normalized
  // question's event projection restores the text on remount or reload.
  const box = useRef<HTMLTextAreaElement>(null)
  const pendingText = useRef<{ question: string | undefined; text: string } | undefined>(undefined)
  const restoreDraft = (node: HTMLTextAreaElement | null): void => {
    box.current = node
    if (node === null || draft === undefined) return
    if (pendingText.current?.question === draft.question && pendingText.current.text !== draft.text && node.ownerDocument.activeElement === node) return
    pendingText.current = undefined
    if (node.value !== draft.text) node.value = draft.text
  }
  const [answerNote, setAnswerNote] = useState<string | undefined>(undefined)
  const attempt = attemptWords(question)

  const send = (): void => {
    const shaped = answerValue(question, box.current?.value ?? "")
    if ("error" in shaped) {
      setAnswerNote(shaped.error)
      return
    }
    setAnswerNote(undefined)
    onAnswer(shaped.value)
  }

  return (
    <div className="sui-approval-answer" data-testid="approval-answer">
      <p className="sui-approval-question">{question.prompt}</p>
      {attempt === undefined ? null : <p className="smithers-card-note">{attempt}</p>}
      {question.kind === "confirm" ?
        (
          /* The gate's acts match the grant gate's: the affirmative is the
           * solid primary, at the same control height as Approve. */
          <div className="flow-run-actions">
            <Button variant="solid" disabled={disabled} data-testid="approval-answer-yes" onClick={() => onAnswer(true)}>
              Yes
            </Button>
            <Button
              variant="outline"
              disabled={disabled}
              data-testid="approval-answer-no"
              onClick={() => onAnswer(false)}
            >
              No
            </Button>
          </div>
        ) :
        question.kind === "select" ?
        (
          <div className="flow-run-actions">
            {(question.options ?? []).map((option) => (
              <Button
                key={option}
                variant="outline"
                disabled={disabled}
                data-testid={`approval-answer-option-${option}`}
                onClick={() => onAnswer(option)}
              >
                {option}
              </Button>
            ))}
          </div>
        ) :
        (
          <>
            <Textarea
              key={draft?.question}
              ref={restoreDraft}
              defaultValue={draft?.text ?? ""}
              onInput={event => {
                pendingText.current = { question: draft?.question, text: event.currentTarget.value }
                onDraft?.(event.currentTarget.value)
              }}
              aria-label={question.prompt}
              data-testid="approval-answer-text"
              disabled={disabled}
              placeholder={question.kind === "json" ? "A JSON value" : "Your answer"}
            />
            <div className="flow-run-actions">
              <Button variant="solid" disabled={disabled} data-testid="approval-answer-send" onClick={send}>
                Send answer
              </Button>
            </div>
          </>
        )}
      {answerNote === undefined ? null : (
        <p className="sui-approval-error" role="alert">
          {answerNote}
        </p>
      )}
    </div>
  )
}

export const APPROVAL_DECISION_FAILED: UserFailureCopy = {
  fault: "infra", sentence: "Smithers could not record this decision. Not your fault.", actions: []
}

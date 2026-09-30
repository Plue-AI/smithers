import { flowAction } from "../flows/FlowAction"
import { runSourceCommand } from "@smthrs/ui/run-command"
import type { Card } from "../state/AppState"
import { codingEvidenceOf } from "./CodingPlan"
import { traceFromJournal, type TraceModel } from "./RunTrace"
import { traceGoals } from "./RunTraceStatus"
import { RunTraceGoals, GOAL_STATE_WORDS } from "./RunTraceGoals"
import { codingVibeAvailable, codingVibeRequestOf, type WorkflowCatalog } from "./CodingVibe"
import { flowArgs } from "../flows/FlowArgs"
import type { RunCommand } from "./CardFamily"
import { describedFailure, FailureNotice } from "../FailureNotice"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"

type RunCard = Extract<Card, { kind: "run-trace" }>

/* A blocked correction says one sentence; the recorded cause stays behind Details. The card's own door (Inspect failed execution) is the next step. */
const CODING_BLOCKED: UserFailureCopy = { fault: "infra", sentence: "Smithers stopped this change before it passed its checks. Not your fault.", actions: [] }

/**
 * The plan inside a run card: its goals, and the planned changes opened
 * through their persisted selection. Predicted ownership is visible before
 * execution; recorded receipts arrive through the run journal.
 */
export const CodingPlanBody = ({ card, onRunCommand: sendRunCommand, workflowCatalogs = [], model }: {
  readonly card: RunCard
  readonly model?: TraceModel
  readonly onRunCommand: RunCommand
  readonly workflowCatalogs?: ReadonlyArray<WorkflowCatalog>
}) => {
  const onRunCommand = runSourceCommand(card.id, sendRunCommand)
  const { plan, outcome, blockedSpanId, reviewFeedback } = codingEvidenceOf(card)
  if (plan === undefined) return null
  const vibeRequest = codingVibeRequestOf(card)
  const canVibe = vibeRequest !== undefined && codingVibeAvailable(card, workflowCatalogs)
  const selected = plan.changes.find((change) => change.id === card.payload.codingChangeId)
  const reviewSummary = reviewFeedback?.result.findings[0]?.message ?? ""
  const detailsId = `${card.id}-coding-details`
  const goals = traceGoals(model ?? traceFromJournal({ runId: card.payload.runId, flowId: card.payload.workflow, status: card.payload.phase }, card.payload.events ?? []), plan, card.payload.cursorSeq)
  return (
    <section className="coding-plan" aria-label="Coding plan">
      {reviewFeedback === undefined ? null : (
        <div className="coding-plan-notice" aria-label="Coding review feedback">
          <p>Review requested changes. Waiting for the correction result.</p>
          <p>{reviewSummary.length <= 240 ? reviewSummary : `${reviewSummary.slice(0, 240)}…`}</p>
          <button
            type="button"
            className="run-trace-filter"
            {...flowAction(onRunCommand, "runs.trace.select", flowArgs("runs.trace.select", { runId: card.payload.runId, nodeId: reviewFeedback.spanId }))}
          >
            Inspect review feedback
          </button>
        </div>
      )}
      {outcome === undefined ? null : (
        <div className="coding-plan-notice" aria-label="Coding outcome">
          <p>
            {outcome.status === "validated" ? "Validated" : outcome.status === "changes-requested" ? "Changes requested" : "Blocked"}
            {` after ${outcome.rounds} ${outcome.rounds === 1 ? "round" : "rounds"}.`}
          </p>
          {outcome.blocked === null ? null : (
            <FailureNotice data-testid="coding-plan-blocked" data-execution={outcome.blocked.executionId}
              failure={describedFailure("CodingBlocked", CODING_BLOCKED, outcome.blocked.message)} />
          )}
          {vibeRequest === undefined ? null : canVibe ? (
            <button type="button" className="run-trace-filter" 
              {...flowAction(onRunCommand, "flow.run", flowArgs("flow.run", {
                name: "coding/vibe", input: { requestExecutionId: vibeRequest.requestExecutionId }
              }))}>Vibe this change</button>
          ) : (
            <div>
              <p>Vibe is not available in this workspace's recorded flows.</p>
              <button type="button" className="run-trace-filter" 
                {...flowAction(onRunCommand, "flow.list")}>Check available flows</button>
            </div>
          )}
          {blockedSpanId === undefined ? null : (
            <button
              type="button"
              className="run-trace-filter"
              {...flowAction(onRunCommand, "runs.trace.select", flowArgs("runs.trace.select", { runId: card.payload.runId, nodeId: blockedSpanId }))}
            >
              Inspect failed execution
            </button>
          )}
        </div>
      )}
      <RunTraceGoals goals={goals} runId={card.payload.runId} selected={selected?.id} detailsId={detailsId} onRunCommand={onRunCommand} />
      {selected === undefined ?
        null :
        (
          <section id={detailsId} className="coding-plan-detail" aria-label={selected.title}>
            <h4>{selected.title}</h4>
            <p>{selected.intent}</p>
            <ol className="coding-plan-atoms" aria-label="Predicted atomic changes">
              {selected.atoms.map((atom, index) => (
                <li key={index}>
                  <strong>{atom.message}</strong>
                  <p>{atom.intent}</p>
                  <p className="coding-plan-meta">
                    {atom.changeId === null ? "New JJ change" : (
                      <>
                        Existing JJ change <code>{atom.changeId}</code>
                      </>
                    )}
                  </p>
                  <div className="coding-plan-paths">
                    <Paths label="Predicted reads" paths={atom.reads} />
                    <Paths label="Predicted writes" paths={atom.writes} />
                  </div>
                </li>
              ))}
            </ol>
            <h5>Planned checks</h5>
            <ul className="coding-plan-checks">
              {selected.checks.map((check) => (
                <li key={check.id}>
                  <span>{check.target}</span>
                  <span className="coding-plan-meta">{check.tier} · {check.required ? "required" : "optional"}</span>
                  <span data-check={check.id} data-state={goals.find(goal => goal.id === selected.id)?.checks.find(item => item.id === check.id)?.state}>
                    {GOAL_STATE_WORDS[goals.find(goal => goal.id === selected.id)?.checks.find(item => item.id === check.id)?.state ?? "pending"]}
                  </span>
                </li>
              ))}
            </ul>
            <details>
              <summary>Plan context</summary>
              <dl className="run-trace-kv">
                <dt>Memory revision</dt>
                <dd>
                  <code>{plan.memoryRevision}</code>
                </dd>
                <dt>Base JJ change</dt>
                <dd>
                  <code>{plan.base.changeId}</code>
                </dd>
                <dt>Base commit</dt>
                <dd>
                  <code>{plan.base.commitId}</code>
                </dd>
                <dt>Base tree</dt>
                <dd>
                  <code>{plan.base.treeId}</code>
                </dd>
                <dt>Native operation</dt>
                <dd>
                  <code>{plan.base.operationId}</code>
                </dd>
              </dl>
            </details>
          </section>
        )}
    </section>
  )
}

const Paths = ({ label, paths }: { readonly label: string; readonly paths: ReadonlyArray<string> }) => (
  <div>
    <h5>{label}</h5>
    {paths.length === 0 ?
      <p className="coding-plan-meta">None declared</p> :
      (
        <ul>
          {paths.map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
      )}
  </div>
)

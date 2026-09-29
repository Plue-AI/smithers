import { flowArgs } from "../flows/FlowArgs"
import { takeoverAct } from "./RunTakeover"
import { canDecide } from "../state/ApprovalDeciders"
import type { Card } from "../state/AppState"
import type { RunCommand } from "./CardFamily"
import { flowAction } from "../flows/FlowAction"
import { runSourceCommand } from "@smthrs/ui/run-command"
import type { TraceModel } from "./RunTrace"
import { latestNeedsHelp, NEEDS_HELP_LABELS } from "./RunNeedsHelp"
import { traceStatus } from "./RunTraceStatus"
import { launchSourceOf } from "../state/WorkflowLaunch"
import { runMeterLabel, runMeterOf, runMeterParts } from "./RunMeter"

/** The one word for each run phase; the app home's tiles read it for a last result. */
export const RUN_PHASE_WORDS: Readonly<Record<string, string>> = {
  launching: "Starting…", running: "Running", "waiting-approval": "Approval needed",
  reconnecting: "Reconnecting…", quiet: "No recent progress", stopped: "Stopped watching",
  completed: "Finished.", failed: "Failed.", cancelled: "Cancelled.", "no-capacity": "No workspace capacity"
}
const words = RUN_PHASE_WORDS
const terminal = new Set(["completed", "failed", "cancelled", "no-capacity"])

/** The live verdict and action never follow the inspection cursor. */
export const RunTraceSummary = ({ card, model, facts, onRunCommand: send, admin = false }: {
  readonly admin?: boolean
  readonly card: Extract<Card, { kind: "run-trace" }>
  readonly model: TraceModel
  readonly facts: ReadonlyArray<string>
  readonly onRunCommand: RunCommand
}) => {
  const { phase, runId, waiting } = card.payload
  const current = traceStatus(model)
  const verdict = terminal.has(phase) ? phase : current.verdict
  const action = verdict !== undefined ? undefined : current.action ??
    (phase === "waiting-approval" || waiting === "approval" ? "approval" : waiting === undefined ? undefined : "resume")
  const condition = verdict !== undefined ? undefined : action === "approval" ? "Approval needed"
    : current.condition === "thrashing" ? "Thrashing" : current.condition === "blocked" || action === "resume" ? "Blocked" : undefined
  const status = verdict ?? phase
  const activity = verdict === undefined && (phase === "running" || phase === "waiting-approval") ? current.activity : undefined
  const needsHelp = latestNeedsHelp(model.journal)
  const onRunCommand = runSourceCommand(card.id, send)
  // A change that started from the caller's pushed ref (#1964) says which.
  const source = launchSourceOf(card)
  const shown = source === undefined ? facts : [`from ${source}`, ...facts]
  const meter = runMeterOf(card.payload.events ?? [])
  const takeover = takeoverAct(card)
  const takeoverDoor = takeover === "release"
    ? { flow: "runs.release" as const, args: flowArgs("runs.release", { runId }) }
    : { flow: "runs.takeover" as const, args: flowArgs("runs.takeover", { runId }) }
  const parts = meter === undefined ? undefined : runMeterParts(meter)
  return <header className="run-outcome" data-phase={status} data-testid={`run-outcome-${runId}`} aria-label="Current run status">
    <span className="run-outcome-dot" data-status={status} aria-hidden />
    <span className="run-outcome-words">{verdict === undefined ? activity ?? words[phase] ?? phase : words[verdict]}</span>
    {condition === undefined || condition === words[phase] && activity === undefined ? null
      : <span className="run-outcome-condition" data-condition={current.condition ?? (action === "approval" ? "approval" : "blocked")}>{condition}</span>}
    {needsHelp === undefined || needsHelp === "none" ? null : (
      <span
        className="run-needs-help-dot"
        data-needs-help={needsHelp}
        role="img"
        tabIndex={0}
        aria-label={NEEDS_HELP_LABELS[needsHelp]}
        title={NEEDS_HELP_LABELS[needsHelp]}
      />
    )}
    {action === "approval" && canDecide(card.payload.workflow, admin) ? <button type="button" className="run-trace-filter" {...flowAction(onRunCommand, "approvals.open", runId)}>Answer</button>
      : action === "resume" ? <button type="button" className="run-trace-filter" data-testid={`flow-run-resume-${runId}`} {...flowAction(onRunCommand, "runs.resume", runId)}>Resume</button> : null}
    {takeover === undefined ? null : (
      <button type="button" className="run-trace-filter" data-testid={takeover === "release" ? `flow-run-release-${runId}` : `flow-run-takeover-${runId}`}
        {...flowAction(onRunCommand, takeoverDoor.flow, takeoverDoor.args)}>
        {takeover === "release" ? "Release" : "Take over"}
      </button>
    )}
    {shown.length === 0 ? null : <span className="run-outcome-facts">{shown.join(" · ")}</span>}
    {parts === undefined ? null : (
      // role="img" so the label, which says the arrows and levels in words, is what a screen reader reads.
      <span className="run-outcome-facts run-meter" data-testid={`run-meter-${runId}`} role="img" aria-label={runMeterLabel(meter!)}>
        {parts.usage}
        {parts.window === undefined ? null : (
          <span data-level={parts.windowDanger ? "danger" : undefined} title={parts.windowDanger ? "Context window nearly full" : undefined}>{` · ${parts.window}`}</span>
        )}
        {parts.cache === undefined ? null : (
          <span data-level={parts.cacheWarning ? "warning" : undefined} title={parts.cacheWarning ? "Low cache hit rate" : undefined}>{` · ${parts.cache}`}</span>
        )}
      </span>
    )}
  </header>
}

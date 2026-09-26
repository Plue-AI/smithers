import { allowed, type Action, type Status } from "@smthrs/rpc/WorkerControls"
import type { Card } from "./state/AppState"
import type { ToastAction } from "./ToastAction"
import { workflowLaunchOf } from "./state/WorkflowLaunch"
import { flowArgs } from "./flows/FlowArgs"
import { runSourceCommand } from "@smthrs/ui/run-command"

/** A toast carries a card identity; controls always read that card's latest state. */
export const workerToastActions = (card: Card | undefined, cards: ReadonlyArray<Card> = []): ReadonlyArray<ToastAction> => {
  if (!card) return []
  const actions: ToastAction[] = [{ label: "Open tab", flow: "tab.card", args: card.id }]
  if (card.kind === "repository-setup") {
    const id = card.payload.receipt?.jobRunId ?? card.payload.receipt?.runId
    const run = cards.find(other => other.kind === "run-trace" && other.payload.runId === id
      && other.payload.repo === card.payload.repo && other.payload.workspaceId === card.payload.workspaceId)
    if (run) actions.push(...workerToastActions(run).slice(1))
    else if (card.payload.request?.state === "failed") actions.push({ label: "Retry", flow: "setup.retry", args: card.id })
    return actions
  }
  if (card.kind === "agent") {
    const payload = card.payload
    if ("cloud" in payload) {
      if (payload.state === "active") actions.push({ label: "Stop", flow: "agent.session.stop", args: flowArgs("agent.session.stop", { sessionId: payload.sessionId, repo: payload.repo }) })
    } else if (payload.phase === "running") actions.push({ label: "Stop", flow: "tab.close", args: payload.tabId })
    return actions
  }
  if (card.kind !== "run-trace") return actions
  const { phase, runId, waiting } = card.payload
  const request = workflowLaunchOf(card)
  if (request && request.runId === undefined) {
    if (request.error) actions.push({ label: "Retry", flow: "flow.run.retry", args: card.id })
    return actions
  }
  if (phase === "launching" || runId === "" || runId.startsWith("pending-")) return actions
  const status: Status = phase === "completed" ? "done" : phase === "failed" || phase === "no-capacity" ? "failed"
    : phase === "cancelled" ? "cancelled" : phase === "waiting-approval" || waiting === "approval" ? "waiting"
    : waiting ? "parked" : "running"
  const add = (control: Action, label: string, flow: ToastAction["flow"], args: string) => {
    if (!allowed(control, { status, liveModelSwitch: true })) return
    runSourceCommand<ToastAction["flow"]>(card.id, (flow, args) => actions.push({ label, flow, args }))(flow, args)
  }
  add("stop", "Stop", "flow.run.stop", card.id)
  add("steer", "Steer", "runs.steer", flowArgs("runs.steer", { runId, body: "" }))
  if (status === "running" || status === "parked") add("model", "Model", "runs.seat", flowArgs("runs.seat", { runId, seat: "" }))
  add("thinking", "Thinking", "runs.thinking", flowArgs("runs.thinking", { runId, thinking: "" }))
  add("approval", "Review approval", "approvals.open", runId)
  if (status === "parked") add("resume", "Resume", "runs.resume", runId)
  add("retry", "Run again", "runs.rerun", runId)
  if (phase === "stopped" || phase === "quiet" || phase === "reconnecting" || card.payload.observationError) {
    actions.push({ label: "Reconnect", flow: "flow.run.retry", args: card.id })
  }
  return actions
}

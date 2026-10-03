import { allowed, type Action } from "@smthrs/rpc/WorkerControls"
import type { Card } from "./state/AppState"
import type { ToastAction } from "./ToastAction"
import { workflowLaunchOf } from "./state/WorkflowLaunch"
import { flowArgs } from "./flows/FlowArgs"
import { runSourceCommand } from "@smthrs/ui/run-command"
import { runStatus } from "./state/Subagents"
import { adminDecided } from "./state/ApprovalDeciders"

/** A toast carries a card identity; controls always read that card's latest state. */
export const workerToastActions = (card: Card | undefined, _cards: ReadonlyArray<Card> = []): ReadonlyArray<ToastAction> => {
  if (!card) return []
  const actions: ToastAction[] = []
  if (card.kind !== "run-trace") return actions
  const { phase, runId } = card.payload
  const request = workflowLaunchOf(card)
  if (request && request.runId === undefined) {
    if (request.error) actions.push({ label: "Retry", flow: "flow.run.retry", args: card.id })
    return actions
  }
  if (phase === "launching" || runId === "" || runId.startsWith("pending-")) return actions
  const status = runStatus(card)
  const add = (control: Action, label: string, flow: ToastAction["flow"], args: string) => {
    if (!allowed(control, { status, liveModelSwitch: true })) return
    runSourceCommand<ToastAction["flow"]>(card.id, (flow, args) => actions.push({ label, flow, args }))(flow, args)
  }
  add("stop", "Stop", "flow.run.stop", card.id)
  add("steer", "Steer", "runs.steer", flowArgs("runs.steer", { runId, body: "" }))
  // An admin-decided wait is reached from the admin's approvals inbox, never from a run's toast.
  // Every gate is answered: the run inbox and the run card say the same verb for the same act.
  if (!adminDecided(card.payload.workflow)) add("approval", "Answer", "approvals.open", runId)
  if (status === "parked") add("resume", "Resume", "runs.resume", runId)
  add("retry", "Run again", "runs.rerun", runId)
  if (phase === "stopped" || phase === "quiet" || phase === "reconnecting" || card.payload.observationError) {
    actions.push({ label: "Reconnect", flow: "flow.run.retry", args: card.id })
  }
  return actions
}

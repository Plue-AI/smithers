import { flowArgs } from "../flows/FlowArgs"
import { flowAction } from "../flows/FlowAction"
import type { Card } from "../state/AppState"
import { runSourceCommand } from "@smthrs/ui/run-command"
import type { RunCommand } from "./CardFamily"
import { codingVibeProgressOf } from "./CodingVibe"

/** The same native child debugger explains each finalization receipt. */
export const CodingVibeBody = ({ card, onRunCommand: send }: {
  readonly card: Extract<Card, { kind: "run-trace" }>
  readonly onRunCommand: RunCommand
}) => {
  const progress = codingVibeProgressOf(card)
  if (progress === undefined) return null
  const onRunCommand = runSourceCommand(card.id, send)
  const wording = {
    admitted: ["Validated request admitted for cleanup.", "Inspect admission receipt"],
    cleaned: ["History descriptions cleaned and checks revalidated.", "Inspect cleanup receipt"],
    "original-retained": ["Original source retained.", "Inspect original source receipt"],
    "cleaned-retained": ["Cleaned source retained.", "Inspect cleaned source receipt"]
  }[progress.stage]
  return <section className="coding-plan" aria-label="Coding finalization">
    <p>{wording[0]} {progress.sourceCommitId === undefined ? null : <code>{progress.sourceCommitId.slice(0, 12)}</code>}</p>
    {progress.summary === undefined ? null : <p>{progress.summary.length <= 240 ? progress.summary : `${progress.summary.slice(0, 240)}…`}</p>}
    <button type="button" className="run-trace-filter" 
      {...flowAction(onRunCommand, "runs.trace.select", flowArgs("runs.trace.select", { runId: card.payload.runId, nodeId: progress.spanId }))}>
      {wording[1]}
    </button>
  </section>
}

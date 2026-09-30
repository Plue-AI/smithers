import type { Card } from "../state/AppState"
import { codingEvidenceOf } from "./CodingPlan"

/** Task-level evidence only; excludes raw launch payloads and tool logs. */
export const runHandoff = (card: Extract<Card, { kind: "run-trace" }>, sourceHref?: string): string => {
  const { repo, runId, workflow, phase, waiting, cursorSeq, observationError } = card.payload
  const { plan, outcome, reviewFeedback } = codingEvidenceOf(card)
  return [
    `# Handoff: ${card.title}`,
    `Repository: ${repo}\nFlow: ${workflow}\nRun: ${runId}\nSource card: ${card.id}`,
    ...(sourceHref === undefined ? [] : [`[Open recorded run evidence](${sourceHref}) (requires this workspace's saved history).`]),
    `## Goal\n${plan?.prompt ?? (typeof card.payload.input?.prompt === "string" ? card.payload.input.prompt : "Not recorded as a structured plan; fill in the goal.")}`,
    `## Recorded state\n${cursorSeq === undefined ? `Run phase: ${phase}${waiting === undefined ? "" : `\nWaiting: ${waiting}`}${observationError === undefined ? "" : `\nObservation incomplete: ${observationError}`}` : `Historical evidence through event ${cursorSeq}; live state is not represented.`}`,
    `Starting revision: ${plan?.base.commitId ?? "Not recorded."}\nRecheck the current revision before continuing.`,
    `## Plan and evidence\n${plan === undefined ? "No structured plan recorded." : plan.changes.map(change =>
      `- ${change.title}: ${change.intent}\n${change.checks.map(check => `  - Planned ${check.tier} check: ${check.target} (${check.id}); this declaration is not a passing result.`).join("\n")}`).join("\n")}`,
    `Recorded plan outcome: ${outcome === undefined ? "Not recorded." : `${outcome.status} after ${outcome.rounds} rounds.`}`,
    ...(card.payload.result === null || cursorSeq !== undefined ? [] : [`## Agent report (not independent verification)\n${card.payload.result}`]),
    ...(outcome?.blocked ? [`Blocker: ${outcome.blocked.message}`] : []),
    ...(reviewFeedback ? [`Review requested changes. Inspect evidence span ${reviewFeedback.spanId} on the source run.`] : []),
    `Evidence: open the source run's trace and the Change's current checks/review. Run completion does not establish human acceptance or deployment.`,
    "## Remaining work and next step\nFill in what remains and the next action before copying."
  ].join("\n\n")
}

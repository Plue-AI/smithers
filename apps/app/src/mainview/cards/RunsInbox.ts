/*
 * The run inbox's triage: which runs a person must act on, which are moving,
 * and which are settled.
 *
 * The control plane names every park it makes (`event`, `approval`, `timer`,
 * `quota`, `released`, `budget`); the run list carries that word as `waiting`,
 * or "parked" when the park has no reason (an operator parked it through
 * `ControlRuntime.writeStatus`). A person acts on a question or grant
 * (`approval`), a spend cap (`budget`) and an operator's park. A provider limit
 * (`quota`) or a clock (`timer`) is not the person's to act on: the run waits
 * and resumes on its own.
 */
import type { Card } from "../state/AppState"

export type InboxRun = Extract<Card, { kind: "run-list" }>["payload"]["runs"][number]

export type InboxGroup = "needs-you" | "working" | "done"

/** The groups in the order a reader triages them. */
export const INBOX_GROUPS: ReadonlyArray<InboxGroup> = ["needs-you", "working", "done"]

/** The parks a person must act on. */
const PERSON_PARKS: ReadonlySet<string> = new Set(["approval", "budget", "parked"])

const SETTLED: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"])

/** The group one run belongs to. */
export const runGroup = (run: InboxRun): InboxGroup =>
  run.status === "waiting-approval" || run.status === "parked" && PERSON_PARKS.has(run.waiting ?? "parked")
    ? "needs-you"
    : SETTLED.has(run.status) ? "done" : "working"

/** A needs-you run's one act: a gate is answered, an operator's park is resumed. */
export const needsYouAct = (run: InboxRun): "answer" | "resume" =>
  run.status === "parked" && (run.waiting ?? "parked") === "parked" ? "resume" : "answer"

/** A run waiting on a provider limit: the infrastructure's fault, never the person's. */
export const onProviderLimit = (run: InboxRun): boolean => run.status === "parked" && run.waiting === "quota"

/**
 * The state grammar's tone: purple means the person acts now, blue is in
 * motion, amber is parked until a time, and settled runs are green, red or grey.
 */
export type InboxTone = "needs-you" | "working" | "parked" | "completed" | "failed" | "cancelled"

export const runTone = (run: InboxRun): InboxTone => {
  const group = runGroup(run)
  if (group === "needs-you") return "needs-you"
  if (group === "working") return run.status === "parked" && (run.waiting === "timer" || run.waiting === "quota") ? "parked" : "working"
  return run.status === "failed" ? "failed" : run.status === "cancelled" ? "cancelled" : "completed"
}

export const TONE_GLYPH: Readonly<Record<InboxTone, string>> = {
  "needs-you": "◆", working: "◐", parked: "●", completed: "●", failed: "●", cancelled: "●"
}

export const GROUP_HEADING: Readonly<Record<InboxGroup, { readonly glyph: string; readonly label: string }>> = {
  "needs-you": { glyph: "◆", label: "Needs you" },
  working: { glyph: "◐", label: "Working" },
  done: { glyph: "●", label: "Done" }
}

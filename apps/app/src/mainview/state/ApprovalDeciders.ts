/*
 * Who may decide an approval. Most waits belong to the person whose run it
 * is; a registration's review and its note belong to the Smithers admin
 * (docs/mvp/REGISTRATION.md), who reaches them through the approvals inbox.
 * An action nobody here can take is never rendered.
 */
import type { Card } from "./AppState"

/** Flows whose waits only a Smithers admin decides, matched by flow id or HumanTask name. */
const ADMIN_DECIDED = ["register-repository"] as const

export const adminDecided = (flowOrTask: string | undefined): boolean =>
  flowOrTask !== undefined && ADMIN_DECIDED.some((flow) => flowOrTask === flow || flowOrTask.startsWith(`${flow}/`))

export const canDecide = (flowOrTask: string | undefined, admin: boolean): boolean => admin || !adminDecided(flowOrTask)

/**
 * Whether a card has a place in the transcript. A registration's run and import are steps of the
 * registration card, and an approval nobody here can decide is not shown.
 */
export const shownInTranscript = (card: Card, admin: boolean): boolean => {
  if (card.kind === "repo-import") return card.payload.registration !== true
  if (card.kind === "run-trace") return card.payload.workflow !== "register-repository"
  if (card.kind === "approval") return canDecide(card.payload.question?.name, admin)
  return true
}

import type { Card } from "./AppState"

/** These cards carry human authority, recorded gateway provenance, or a flow's original actor. */
export const isRuntimeOwnedCard = (card: Pick<Card, "kind"> | undefined): boolean =>
  card?.kind === "approval" || card?.kind === "approvals-inbox" ||
  card?.kind === "grant-confirm" || card?.kind === "flow-form" ||
  card?.kind === "run-trace" || card?.kind === "run-list"

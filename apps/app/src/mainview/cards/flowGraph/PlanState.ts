/*
 * Where a plan card ended up, as one closed set.
 *
 * A plan card carries the control plane's own vocabulary and nothing more:
 * `pending` while the ask is out, `done` with the nodes it answered, and
 * `failed` with the sentence whoever refused it wrote. That is three endings,
 * so this is three cases, and the fold below is exhaustive at compile time —
 * a fourth status on the wire fails `tsc` here rather than falling through to
 * a card that draws a plan it does not have.
 *
 * WHY A SENTENCE AND NOT A CODE. The refusals a plan can meet arrive with
 * different amounts of type behind them, and the card is handed the least of
 * them:
 *
 *  - The box's provision states — `ready`, `provisioning`, or a refusal —
 *    are collapsed into a sentence by the provision poll
 *    (state/controller/workflows.ts), which answers `true | string`.
 *  - A control-plane refusal carries a `code` on the seam's own result
 *    (state/controller/gateway.ts `GatewayResult`), which the plan settle
 *    does not keep.
 *  - A box older than a projection selector answers with a defect that
 *    carries NO code at all (packages/smithers/gateway/test/GatewayServer.test.ts),
 *    so no reader anywhere can branch on one.
 *
 * So the honest ending here is "refused, and here is what the workspace
 * said", with the door that asks again beside it. A fault class on the card
 * would have to be invented from prose, and an invented fault class is worse
 * than none.
 */
import type { PlanCardNode } from "../FlowGraph"
import type { Card } from "../../state/AppState"

type PlanPayload = Extract<Card, { kind: "flow-plan" }>["payload"]

/**
 * What a plan card is, reduced to the one thing it draws.
 *
 * `planned` carries the nodes because "answered with no nodes" and "answered
 * with a graph" are the same ending with different evidence: neither is a
 * failure, and only one draws a canvas.
 */
export type PlanCardState =
  | { readonly kind: "planning" }
  | { readonly kind: "planned"; readonly nodes: ReadonlyArray<PlanCardNode> }
  | { readonly kind: "refused"; readonly sentence?: string }

/**
 * The ending one plan card reached.
 *
 * Nothing here reads the sentence: a refusal is a refusal whatever it says,
 * and a card that matched prose would be guessing at a fault class the seam
 * never stated.
 */
export const planCardState = (payload: PlanPayload): PlanCardState => {
  switch (payload.status) {
    case "pending":
      return { kind: "planning" }
    case "done":
      return { kind: "planned", nodes: payload.nodes ?? [] }
    case "failed":
      return payload.error === undefined ? { kind: "refused" } : { kind: "refused", sentence: payload.error }
    default: {
      const unreachable: never = payload.status
      return unreachable
    }
  }
}

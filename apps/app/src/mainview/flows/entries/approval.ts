/*
 * The `approval` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { flow, CardTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `approval` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "approval", label: "Approvals", summary: "Approve or deny requests" }

/** The `approval` flows registered as one aggregator block. */
export const approvalFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "approval.approve", visibility: "in-card",
    summary: "Approve a pending approval card",
    hidden: true,
    args: "<cardId>",
    agent: "never" as const,
    agentReason: "approvals belong to the human",
    input: CardTarget,
    handler: ({ cardId }) => {
      actions.decideApproval(cardId, "approved")
    }
  }),
  flow({
    name: "approval.deny", visibility: "in-card",
    summary: "Deny a pending approval card",
    hidden: true,
    args: "<cardId>",
    agent: "never" as const,
    agentReason: "approvals belong to the human",
    input: CardTarget,
    handler: ({ cardId }) => {
      actions.decideApproval(cardId, "denied")
    }
  })
]

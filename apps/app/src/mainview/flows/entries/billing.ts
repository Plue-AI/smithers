/*
 * The `billing` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `billing` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "billing", label: "Billing", summary: "Balance and plan" }

/*
 * The host's billing doors, read off the bootstrap. Registration-only callers
 * pass inert actions whose every member answers a function or `undefined`
 * (FlowFlags.test.ts), so the read guards the answer as well as the member:
 * no capability list registers no billing flow.
 */
const hostCapabilities = (actions: CommandActions): ReadonlyArray<string> => {
  const capabilities: unknown = actions.bootstrap?.capabilities
  return Array.isArray(capabilities) ? capabilities : []
}

/** The balance read remains available beside plan and sandbox usage. */
export const billingBalanceFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => hostCapabilities(actions).includes("billing.balance") ? [
  flow({
    name: "billing.balance",
    summary: "Show your balance",
    runtime: ["identity", "billing.balance"],
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.showBalance()
  })
] : []

/** Plan reads and human billing doors only where their routes exist. */
export const billingPlanFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => hostCapabilities(actions).some(capability => ["billing.plans", "billing.checkout", "billing.portal"].includes(capability)) ? [
  flow({
    name: "billing.plans", summary: "Show plans and sandbox usage", runtime: ["identity", "billing.plans"],
    requires: ["signed-in"], input: NoPayload, handler: () => actions.showBillingPlans()
  }),
  flow({
    name: "billing.upgrade",
    summary: "Upgrade your plan (opens Stripe checkout)",
    runtime: ["identity", "billing.checkout"],
    userOnly: true,
    userOnlyReason: "external checkout with real money; the human clicks",
    args: "[plan]",
    requires: ["signed-in"],
    input: Schema.Struct({ plan: Schema.optional(Schema.String) }),
    handler: ({ plan }) => actions.startCheckout(plan)
  }),
  flow({
    name: "billing.portal",
    summary: "Manage billing (opens the Stripe portal)",
    runtime: ["identity", "billing.portal"],
    userOnly: true,
    userOnlyReason: "the external billing portal; the human clicks",
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.openBillingPortal()
  })
] : []

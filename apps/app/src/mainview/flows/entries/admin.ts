/*
 * The `admin` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, NoPayload, CardTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `admin` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "admin", label: "Admin", summary: "Operator tooling" }

/** The reset confirm dialog's ask and cancel. */
export const adminResetFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "admin.reset.ask",
    summary: "Ask before discarding the conversation",
    hidden: true,
    userOnly: true,
    userOnlyReason: "opens the human's confirm dialog for the reset",
    input: NoPayload,
    handler: () => actions.askReset()
  }),
  flow({
    name: "admin.reset.cancel",
    summary: "Keep the current conversation",
    hidden: true,
    userOnly: true,
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: NoPayload,
    handler: () => actions.cancelReset()
  })
]

/** The bare reset and the dev-tools panel, registered after the billing plan flows. */
export const adminToolFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  const RESET = {
    name: "admin.reset",
    summary: "Start a fresh conversation (dev tooling — nothing is kept)",
    userOnly: true,
    userOnlyReason: "destroys the whole store with no undo; the confirm dialog is the only door",
    input: NoPayload,
    handler: () => actions.reset()
  }
  return [
  /*
   * The bare reset is admin-only dev tooling (§2): no sweep, nothing kept.
   * Users get /chat.clear instead.
   */
  flow(RESET),
  flow({
    /* The admin dev-tools panel (§2b/§2d): the machinery, visible. */
    name: "admin.devtools",
    summary: "Toggle the dev-tools panel",
    userOnly: true,
    userOnlyReason: "the admin panel's presentation toggle",
    input: NoPayload,
    handler: () => actions.toggleDevtools()
  })
  ]
}

/** The operator flows: grants and health. */
export const adminOperatorFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "admin.grant",
    summary: "Grant balance to a login (asks for confirmation first)",
    runtime: ["identity"],
    args: "<amountUsd> <login>",
    input: Schema.Struct({ amountUsd: Schema.Number, login: Schema.String }),
    handler: ({ amountUsd, login }) => actions.adminGrant(amountUsd, login)
  }),
  flow({
    name: "admin.grant.confirm",
    summary: "Confirm a pending balance grant",
    runtime: ["identity"],
    hidden: true,
    args: "<cardId>",
    userOnly: true,
    userOnlyReason: "a grant confirmation is the operator's own answer",
    input: CardTarget,
    handler: ({ cardId }) => actions.adminGrantConfirm(cardId)
  }),
  flow({
    name: "admin.grant.cancel",
    summary: "Cancel a pending balance grant",
    runtime: ["identity"],
    hidden: true,
    args: "<cardId>",
    userOnly: true,
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: CardTarget,
    handler: ({ cardId }) => actions.adminGrantCancel(cardId)
  }),
  flow({
    name: "admin.health",
    summary: "Service health",
    runtime: ["identity"],
    input: NoPayload,
    handler: () => actions.adminHealth()
  })
]


import { flow, NoPayload } from "./Declare"
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


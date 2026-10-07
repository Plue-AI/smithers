/**
 * The flow-authoring pack: the one id the app launches to author a flow, and
 * the stage bodies that pipeline is made of.
 *
 * This module exists because those ids are a contract between two halves that
 * cannot import each other. The app's `/flow.new` door launches
 * {@link FLOW_AUTHORING_ENTRY} through the gateway; the workspace host
 * (`flows/repository/registry.ts`) provisions the same names as built-in
 * bodies on every workspace it serves. When the two drifted apart the door
 * launched `create-workflow`, a name from the 0.x JSX runtime that no 1.0
 * composition has ever registered, and every attempt refused.
 *
 * `flows/` and `apps/app` both read the names from here, so a rename is one
 * edit and a test on either side is testing the id the other side uses.
 *
 * @since 1.0.0
 */

/**
 * The id `/flow.new` launches.
 *
 * It is a prompt body, deliberately: `AgentSession` runs a Prompt body through
 * its trace and pump and returns early for every other kind, so a module entry
 * would produce a run card with no agent frames on it.
 *
 * @since 1.0.0
 * @category constants
 */
export const FLOW_AUTHORING_ENTRY = "create-flow"

/**
 * The stages the entry works through, in order.
 *
 * Each remains an independently runnable prompt body. The workspace host also
 * embeds their instructions in the entry so its agent need not start another
 * agent inside a cell call.
 *
 * @since 1.0.0
 * @category constants
 */
export const FLOW_AUTHORING_STAGES = [
  "create-flow/clarify",
  "create-flow/provision",
  "create-flow/design",
  "create-flow/scaffold",
  "create-flow/fix",
  "create-flow/document"
] as const

/**
 * Every id the pack registers, entry first.
 *
 * @since 1.0.0
 * @category constants
 */
export const FLOW_AUTHORING_PACK: ReadonlyArray<string> = [FLOW_AUTHORING_ENTRY, ...FLOW_AUTHORING_STAGES]

/**
 * What a person is told when the workspace cannot resolve the authoring flow.
 *
 * The control plane's own refusal is `No flow "create-flow" is registered on
 * this workspace.`, which names an internal id and no action. A person reading
 * it can only conclude the product is broken. This sentence says which flow is
 * missing in the product's own words and what closes the gap, and it is the
 * one place that wording lives.
 *
 * @since 1.0.0
 * @category constructors
 */
export const flowAuthoringUnavailable = (repo: string): string =>
  `${repo}'s workspace does not have the flow-authoring flow installed, so there is nothing to build your flow with yet. `
  + `Update the workspace from Settings and run /flow.new again, or use /flow.list to see what it can run today.`

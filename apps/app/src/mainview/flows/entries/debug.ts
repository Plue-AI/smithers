/*
 * The `debug` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { debugApiOperation } from "@smthrs/ui/app-operations"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `debug` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "debug", label: "Debug", summary: "Observability and dev tooling" }

/** Public diagnostics, available without an account, repository or admin plugin. */
export const debugVerboseFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  /*
   * The maintainer's switch: every flow invocation (hidden, aliased,
   * agent-driven, deferred) and every background or system transition
   * renders as a trace line, and the transition logger writes to the
   * console. Registered for every session rather than the admin plugin:
   * the local host has no identity seam, so an admin gate would make the
   * switch unreachable exactly where the maintainer runs the app.
   */
  const VERBOSE = {
    name: "debug.verbose", visibility: "hidden" as const,
    summary: "Show everything Smithers is doing",
    input: NoPayload,
    handler: () => actions.toggleVerbose()
  }
  return [
  flow(VERBOSE),
  flow({
    name: "debug.errors", visibility: "hidden" as const,
    summary: "Read recent app errors and toast history, including dismissed notifications; no repository or sign-in needed",
    args: "[text] [--source toast|network|event|tool] [--since ISO-timestamp] [--limit 1..100] [--all]",
    input: Schema.Struct({ query: Schema.optional(Schema.String) }),
    handler: ({ query }) => actions.debugErrors(query)
  })
  ]
}

/** The `debug.*` admin flows. */
export const debugFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * DESIGN.md §14: report what drives a turn. A read, not a switch — there
     * is one backend, and an argument asking for another is answered rather
     * than ignored. user-only: the agent must never reason about its engine.
     */
    name: "debug.backend", visibility: "hidden" as const,
    summary: "Report the agent backend",
    args: "[backend] [--health]",
    agent: "never" as const,
    agentReason: "admin diagnostics; the agent must never reason about its engine",
    input: Schema.Struct({ backend: Schema.String, probe: Schema.optional(Schema.Literals(["health"])) }),
    form: { fields: { probe: { hidden: true } }, args: payload => payload.probe === "health" ? "--health" : String(payload.backend ?? "") },
    handler: ({ backend, probe }) => probe === "health" ? actions.debugSeams() : actions.describeAgentBackend(backend)
  }),
  flow({
    /* The debug reads — one typed surface the panel AND the agent share. */
    name: "debug.snapshot", visibility: "hidden" as const,
    summary: "Read the app state snapshot",
    input: NoPayload,
    handler: () => actions.debugSnapshot()
  }),
  flow({
    name: "debug.events", visibility: "hidden" as const,
    summary: "Read the transition journal tail",
    input: NoPayload,
    handler: () => actions.debugEvents()
  }),
  flow({
    /* Debug mode's wire tap (§14): the controller's fetch ring. */
    name: "debug.net", visibility: "hidden" as const,
    summary: "Read the network tap",
    input: NoPayload,
    handler: () => actions.debugNet()
  })
]

/** T-APP-21: slash, card and CLI share the canonical person-only playground. */
export const debugApiFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  const available = typeof actions.debugApi?.available === "function" && actions.debugApi.available()
  return [flow({ ...debugApiOperation, name: "debug-api",
    slash: "/debug-api", cli: null, http: null, journey: [], group: "Advanced",
    visibility: available ? "advanced" : "hidden", actors: ["person"], minimumRole: "member",
    summary: "Call the documented API", args: "[operationId]", hidden: !available,
    agent: "never" as const, agentReason: "raw API bypasses flow typing and approvals; agents use flows",
    handler: payload => actions.debugApiCommand(payload)
  })]
}

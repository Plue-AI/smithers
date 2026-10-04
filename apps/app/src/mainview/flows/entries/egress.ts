/*
 * The `egress` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `egress` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "egress", label: "Egress", summary: "What a computer or an agent session called out to" }

/** The repository an act names, else the one selected when it is asked for. */
const targetRepo = (actions: CommandActions, payload: Record<string, unknown>): string | undefined =>
  (typeof payload["repo"] === "string" ? payload["repo"] : undefined) ?? actions.activeRepository() ?? undefined

/** The `egress` flows registered as one aggregator block. */
export const egressFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * The owner's allowlist (#2653): every running sandbox of the repository
     * reloads it. It widens what the repository's sandboxes may reach, so the
     * model may ask for it and the person confirms.
     */
    name: "egress.allow", hidden: true, discloseToAgent: false,
    summary: "Let a repository's sandboxes reach a host",
    runtime: ["cloud"],
    confirm: (payload) => `let ${targetRepo(actions, payload) ?? "the selected repository"}'s sandboxes reach ${String(payload["host"])}`,
    /* The confirmation carries the repository named at ask time, so switching repositories cannot retarget it. */
    confirmArgs: (payload) => {
      const repo = targetRepo(actions, payload)
      return repo === undefined ? undefined : `${String(payload["host"])} ${repo}`
    },
    args: "<host> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ host: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ host, repo }) => actions.allowEgressHost(host, repo)
  }),
  flow({
    /* The same audit for an agent session's sandbox; the app has no agent-session card to face it. */
    name: "egress.session", hidden: true, discloseToAgent: false,
    summary: "List what an agent session called out to, and which secret names were swapped in",
    runtime: ["cloud"],
    args: "<sessionId> [owner/repo] [cursor]",
    requires: ["signed-in"],
    input: Schema.Struct({
      sessionId: Schema.String,
      repo: Schema.optional(Schema.String),
      cursor: Schema.optional(Schema.String)
    }),
    handler: ({ sessionId, repo, cursor }) => actions.listSessionEgress(sessionId, repo, cursor)
  })
]

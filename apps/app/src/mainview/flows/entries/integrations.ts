/*
 * The `integrations` flow: the services that sync with conversations and the
 * wiki — Slack, Notion — read into the connect card's rows (DESIGN
 * §3.6). One module per namespace, registered in Flows.ts.
 */
import type { FlowEntry, Namespace } from "../registry"
import { Schema } from "effect"
import { flow, RepoTarget } from "./Declare"
import type { CommandActions } from "./Declare"

/** The `integrations` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "integrations", label: "Integrations", summary: "Slack and Notion for conversations and the wiki" }

export const integrationsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "integrations.admit",
    summary: "Admit a Slack channel to a repository's conversations",
    runtime: ["cloud"],
    args: "<connection_id> <scope_id> <conversation_id> [external_user_id] [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      connection_id: Schema.String, scope_id: Schema.String, conversation_id: Schema.String,
      external_user_id: Schema.optional(Schema.String), repo: Schema.optional(Schema.String)
    }),
    form: {
      submitLabel: "Connect",
      args: payload => JSON.stringify(Object.fromEntries(["connection_id", "scope_id", "conversation_id", "external_user_id", "repo"].flatMap(key =>
        typeof payload[key] === "string" && payload[key] !== "" ? [[key, payload[key]]] : []))),
      fields: {
        connection_id: { label: "Connection", placeholder: "slack-main", kind: "text" },
        scope_id: { label: "Workspace", placeholder: "T0123", kind: "text" },
        conversation_id: { label: "Channel", placeholder: "C0123", kind: "text" },
        external_user_id: { label: "User", placeholder: "U0123", kind: "text" },
        repo: { label: "Repository", optionsFrom: "cloud-repos", kind: "text" }
      }
    },
    confirm: payload => `admit Slack channel ${String(payload["conversation_id"])} to ${typeof payload["repo"] === "string" ? payload["repo"] : "the selected repository"}`,
    handler: ({ connection_id, scope_id, conversation_id, external_user_id, repo }) =>
      actions.admitSlackChannel({ connection_id, scope_id, conversation_id, external_user_id }, repo)
  }),
  flow({
    name: "integrations.list",
    summary: "Show the services connected to a repository's conversations, issues and wiki",
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } } },
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.listIntegrations(repo)
  })
]

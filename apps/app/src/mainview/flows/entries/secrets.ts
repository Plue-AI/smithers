/*
 * The `secrets` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `secrets` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "secrets", label: "Secrets", summary: "Secrets a repository's sessions may use" }

/** The repository a secrets.scope names, or the active one. */
const scopeRepo = (actions: CommandActions, payload: Record<string, unknown>): string | undefined =>
  (typeof payload["repo"] === "string" ? payload["repo"] : undefined) ?? actions.activeRepository() ?? undefined

/** The `secrets` flows registered as one aggregator block. */
export const secretsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "secrets.connect", summary: "Connect Claude for coding in your repositories", runtime: ["cloud"],
    requires: ["signed-in"], input: Schema.Struct({ value: Schema.optional(Schema.String) }),
    form: { submitLabel: "Connect", fields: { value: { label: "Claude token", kind: "write-only", required: true } } },
    confirm: () => "connect Claude for coding",
    handler: (_input, _signal, _call, gesture) => actions.connectCodingProvider(gesture)
  }),
  flow({
    name: "secrets.connect.codex", summary: "Connect Codex for coding in your repositories", runtime: ["cloud"],
    requires: ["signed-in"], input: Schema.Struct({}),
    handler: () => actions.connectCodex()
  }),
  flow({
    name: "secrets.connections", summary: "Show coding accounts", runtime: ["cloud"],
    requires: ["signed-in"], input: Schema.Struct({}),
    handler: () => actions.listCodingProviders()
  }),
  flow({
    name: "secrets.move", summary: "Move a coding account up or down its provider's order", runtime: ["cloud"],
    requires: ["signed-in"], args: "<id> <up|down>",
    input: Schema.Struct({ id: Schema.String, direction: Schema.Literals(["up", "down"]) }),
    handler: ({ id, direction }) => actions.moveCodingProvider(id, direction)
  }),
  flow({
    name: "secrets.revoke", summary: "Revoke coding connection", runtime: ["cloud"],
    requires: ["signed-in"], args: "<id>", input: Schema.Struct({ id: Schema.String }),
    confirm: payload => `revoke coding connection ${String(payload["id"])}`,
    handler: ({ id }) => actions.revokeCodingProvider(id)
  }),
  flow({
    name: "secrets.scope",
    summary: "Limit a repository secret to trusted runs on main, or give it to every run",
    runtime: ["cloud"],
    args: "<name> <main-only|all> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ name: Schema.String, scope: Schema.Literals(["main-only", "all"]), repo: Schema.optional(Schema.String) }),
    /*
     * Giving a main-only secret to every run hands it to agent runs, so the
     * agent may only ask; the human confirms, for the repository named at
     * ask time.
     */
    confirm: payload => payload["scope"] === "all"
      ? `give ${String(payload["name"])} to every run in ${scopeRepo(actions, payload) ?? "the selected repository"}`
      : undefined,
    confirmArgs: payload => {
      const repo = scopeRepo(actions, payload)
      return repo === undefined ? undefined : `${String(payload["name"])} ${String(payload["scope"])} ${repo}`
    },
    handler: ({ name, scope, repo }) => actions.scopeSecret(name, scope, repo)
  }),
  flow({
    name: "secrets.bind",
    summary: "Set the hosts and headers a repository secret may be sent to",
    runtime: ["cloud"],
    args: "<NAME> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      name: Schema.String, hosts: Schema.String, headers: Schema.String, repo: Schema.optional(Schema.String)
    }),
    form: {
      submitLabel: "Save",
      fields: {
        name: { label: "Name", placeholder: "NPM_TOKEN", kind: "text" },
        hosts: { label: "Hosts", placeholder: "registry.npmjs.org", kind: "text", required: true },
        headers: { label: "Headers", placeholder: "authorization", kind: "text", required: true },
        repo: { label: "Repository", optionsFrom: "cloud-repos", kind: "text" }
      }
    },
    /* A binding chooses where a secret's value may be sent, so the agent may only ask. */
    confirm: payload => `bind secret ${String(payload["name"])} in ${scopeRepo(actions, payload) ?? "the selected repository"}`,
    /* The confirmation carries the repository named at ask time, so switching repositories cannot retarget it. */
    confirmArgs: payload => {
      const repo = scopeRepo(actions, payload)
      return repo === undefined ? undefined : JSON.stringify({ name: payload["name"], hosts: payload["hosts"], headers: payload["headers"], repo })
    },
    handler: ({ name, hosts, headers, repo }) => actions.bindSecret({ name, hosts, headers, repo })
  }),
  flow({
    name: "secrets.set",
    summary: "Add a repository secret or replace its value",
    runtime: ["cloud"],
    args: "<NAME> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      name: Schema.String, value: Schema.optional(Schema.String),
      hosts: Schema.optional(Schema.String), headers: Schema.optional(Schema.String), repo: Schema.optional(Schema.String)
    }),
    form: {
      submitLabel: "Save",
      args: payload => JSON.stringify(Object.fromEntries(["name", "hosts", "headers", "repo"].flatMap(key =>
        typeof payload[key] === "string" && payload[key] !== "" ? [[key, payload[key]]] : []))),
      fields: {
        name: { label: "Name", placeholder: "API_TOKEN", kind: "text" },
        value: { label: "Value", kind: "write-only", required: true },
        hosts: { label: "Hosts", placeholder: "api.example.com", kind: "text" },
        headers: { label: "Headers", placeholder: "authorization", kind: "text" },
        /* Shown so a slash-opened form names where the save goes; the card's doors fill it. */
        repo: { label: "Repository", optionsFrom: "cloud-repos", kind: "text" }
      }
    },
    confirm: payload => `save secret ${String(payload["name"])}`,
    handler: ({ name, hosts, headers, repo }, _signal, _call, gesture) => actions.setSecret({ name, hosts, headers, repo }, gesture)
  }),
  flow({
    name: "secrets.delete",
    summary: "Delete a repository secret",
    runtime: ["cloud"],
    args: "<NAME> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ name: Schema.String, repo: Schema.optional(Schema.String) }),
    confirm: payload => `delete secret ${String(payload["name"])} from ${scopeRepo(actions, payload) ?? "the selected repository"}`,
    confirmArgs: payload => {
      const repo = scopeRepo(actions, payload)
      return repo === undefined ? undefined : `${String(payload["name"])} ${repo}`
    },
    handler: ({ name, repo }) => actions.deleteSecret(name, repo)
  }),
  flow({
    name: "secrets.list",
    summary: "Show the secrets a repository's sessions may use: names and bindings, never values",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    prepare: ({ repo }) => actions.listSecrets.preload?.(repo),
    handler: ({ repo }) => actions.listSecrets(repo)
  })
]

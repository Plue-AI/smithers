import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"
import { payloadFor } from "../SlashPayload"
import { publicSecretInput } from "../SecretPayload"

export const namespace: Namespace = { id: "secrets", label: "Secrets", summary: "Secrets a repository's sessions may use" }
const scopeRepo = (actions: CommandActions, payload: Record<string, unknown>): string | undefined =>
  (typeof payload.repo === "string" ? payload.repo : undefined) ?? actions.activeRepository() ?? undefined
const fields = {
  name: Schema.optional(Schema.String), repo: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.Literals(["all_branches", "main_only"])),
  hosts: Schema.optional(Schema.String), headers: Schema.optional(Schema.String), path: Schema.optional(Schema.String), value: Schema.optional(Schema.String)
}
const required: Readonly<Record<string, readonly string[]>> = {
  set: ["name", "value"], delete: ["name"], scope: ["name", "scope"], bind: ["name", "hosts", "headers"]
}
const nameAndRepo = Schema.Struct({ name: Schema.String, repo: fields.repo })
const scopeInput = Schema.Struct({ name: Schema.String, repo: fields.repo, scope: Schema.Literals(["all_branches", "main_only"]) })
const bindInput = Schema.Struct({ name: Schema.String, repo: fields.repo, hosts: Schema.String, headers: Schema.String })
const setInput = Schema.Struct({ name: Schema.String, repo: fields.repo, scope: fields.scope, hosts: fields.hosts, headers: fields.headers, path: fields.path })

export const secretsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [flow({
  name: "secrets", slash: "/secrets", cli: null, journey: ["J1"], group: "Account and settings", visibility: "core",
  actors: ["person"], minimumRole: "member", agent: "never", http: null,
  summary: "Set secrets machines can use", runtimeAny: ["cloud", "install"], args: "[owner/repo]", requires: ["signed-in"],
  grammar: args => {
    if (!args?.trim().startsWith("{")) return payloadFor("secrets", args)
    try {
      const input: unknown = JSON.parse(args)
      return input && typeof input === "object" && !Array.isArray(input)
        ? { payload: publicSecretInput(input as Record<string, unknown>) } : { error: "Enter a JSON object" }
    } catch { return { error: "Enter a JSON object" } }
  },
  input: Schema.Struct({ operation: Schema.optional(Schema.Literals(["set", "delete", "scope", "bind"])), ...fields }),
  preflight: input => {
    if (!input.operation) return
    const role = actions.secretsProviders?.authority?.() ?? actions.snapshot().viewerRole
    return role === undefined ? "Secrets unavailable" : role === "owner" || role === "maintainer" ? undefined : "Maintainer required"
  },
  form: { submitLabel: "Save", args: input => JSON.stringify(publicSecretInput(input)),
    requires: input => required[String(input.operation)] ?? [],
    optionalFields: input => input.operation === "set" ? ["hosts", "headers", "path", "repo"] : [],
    fields: { operation: { hidden: true }, name: { label: "Name", kind: "text" },
      value: { label: "Value", kind: "write-only", required: false },
      hosts: { label: "Hosts", kind: "text" }, headers: { label: "Headers", kind: "text" },
      path: { label: "Path", kind: "text" }, repo: { label: "Repository", optionsFrom: "cloud-repos", kind: "text" } }
  },
  confirm: payload => payload.operation === "delete"
    ? `delete secret ${String(payload.name)} from ${scopeRepo(actions, payload) ?? "the selected repository"}`
    : payload.operation === "bind" ? `bind secret ${String(payload.name)} in ${scopeRepo(actions, payload) ?? "the selected repository"}`
    : payload.operation === "scope" && payload.scope === "all_branches"
      ? `give ${String(payload.name)} to all branches in ${scopeRepo(actions, payload) ?? "the selected repository"}` : undefined,
  confirmArgs: payload => {
    if (payload.operation !== "delete" && payload.operation !== "bind" && !(payload.operation === "scope" && payload.scope === "all_branches")) return
    const repo = scopeRepo(actions, payload)
    return repo === undefined ? undefined : JSON.stringify(publicSecretInput({ ...payload, repo }))
  },
  prepare: input => input.operation === undefined ? actions.listSecrets.preload?.(input.repo) : undefined,
  handler: (input, _signal, _call, gesture) => {
    switch (input.operation) {
      case "set": return actions.setSecret(Schema.decodeUnknownSync(setInput)(input), gesture)
      case "delete": { const value = Schema.decodeUnknownSync(nameAndRepo)(input); return actions.deleteSecret(value.name, value.repo) }
      case "bind": return actions.bindSecret(Schema.decodeUnknownSync(bindInput)(input))
      case "scope": { const value = Schema.decodeUnknownSync(scopeInput)(input); return actions.scopeSecret(value.name, value.scope === "main_only" ? "main-only" : "all", value.repo) }
      default: return actions.listSecrets(input.repo)
    }
  }
})]

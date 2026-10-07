import { publicSettingsInput } from "../SettingsPayload"
import { Schema } from "effect"
import { SETUP_STEP_IDS } from "@smthrs/rpc/SetupCard"
import { flow } from "./Declare"
import type { CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"
import type { Grammar } from "../SlashPayload"

// T-APP-03: these new controls keep JSON at the slash boundary, never in handlers.
const object: Grammar = args => {
  if (!args?.trim()) return { payload: {} }
  try {
    const payload: unknown = JSON.parse(args)
    if (payload && typeof payload === "object" && !Array.isArray(payload)) return { payload: payload as Record<string, unknown> }
  } catch { /* The form supplies missing inputs; malformed JSON remains a refusal. */ }
  return { error: "Enter settings as a JSON object" }
}
/* The inputs each setup step needs (InstallSeam.setupStep's bodies); THE FORM LAW asks for the missing ones. */
const SETUP_REQUIRES: Readonly<Record<string, ReadonlyArray<string>>> = { address: ["bind", "origins"], app_manifest: ["owner"], repository: ["repository"] }
const address = Schema.Struct({ listen: Schema.Literals(["mac", "network"]), bind: Schema.String, origins: Schema.Array(Schema.String) })
const capacity = Schema.Struct({ capacity: Schema.Number })
const parallel = Schema.Struct({ parallel: Schema.Number })
const preapprove = Schema.Struct({ todo_preapprove_default: Schema.Boolean })
const admissions = Schema.Struct({ todo_daily_admissions: Schema.Number })
const obsidian = Schema.Struct({ path: Schema.String })
const modelKey = Schema.Struct({ role: Schema.Literals(["fast", "coding", "jev"]), provider: Schema.String,
  model: Schema.optional(Schema.String), action: Schema.optional(Schema.Literal("remove")) })
const setup = Schema.Struct({ step: Schema.Literals(SETUP_STEP_IDS), owner: Schema.optional(Schema.String),
  repository: Schema.optional(Schema.String), bind: Schema.optional(Schema.String), origins: Schema.optional(Schema.Array(Schema.String)) })
const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  address: ["listen", "bind", "origins"], capacity: ["capacity"], parallel: ["parallel"],
  "preapprove-default": ["todo_preapprove_default"], "daily-admissions": ["todo_daily_admissions"],
  "fast-model": ["action"], obsidian: ["path"], "model-key": ["role", "provider"], setup: ["step"]
}

export const settingsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "settings", slash: "/settings", cli: null, journey: ["J1"], group: "Account and settings", visibility: "core",
    actors: ["person"], minimumRole: "owner", http: null, summary: "Model access, machines, GitHub (owner)",
    agentReason: "Install status requires the owner’s person session", agent: "never",
    grammar: args => {
      if (!args?.trim().startsWith("{")) return { payload: {} }
      const parsed = object(args)
      if ("payload" in parsed) return { payload: publicSettingsInput(parsed.payload) }
      return parsed
    },
    input: Schema.Struct({
      operation: Schema.optional(Schema.Literals(["address", "capacity", "parallel", "preapprove-default", "daily-admissions", "obsidian", "model-key", "setup", "fast-model"])),
      listen: Schema.optional(Schema.Literals(["mac", "network"])), bind: Schema.optional(Schema.String), origins: Schema.optional(Schema.Array(Schema.String)),
      capacity: Schema.optional(Schema.Number), parallel: Schema.optional(Schema.Number), todo_preapprove_default: Schema.optional(Schema.Boolean),
      todo_daily_admissions: Schema.optional(Schema.Number), path: Schema.optional(Schema.String), role: Schema.optional(Schema.Literals(["fast", "coding", "jev"])),
      provider: Schema.optional(Schema.String), model: Schema.optional(Schema.String), action: Schema.optional(Schema.Literals(["remove", "sign-in", "sign-out"])), value: Schema.optional(Schema.String),
      step: Schema.optional(Schema.Literals(SETUP_STEP_IDS)), owner: Schema.optional(Schema.String), repository: Schema.optional(Schema.String)
    }),
    form: { submitLabel: "Save", args: input => JSON.stringify(publicSettingsInput(input)),
      requires: input => [...(REQUIRED[String(input.operation)] ?? []),
        ...(input.operation === "setup" ? SETUP_REQUIRES[String(input.step)] ?? [] : []),
        ...(input.operation === "model-key" && input.action !== "remove" ? ["value"] : [])],
      fields: { operation: { hidden: true }, value: { label: "Key", kind: "write-only", required: false },
        role: { label: "Role", kind: "select" }, provider: { label: "Provider", kind: "text" } }
    },
    handler: async (input, _signal, _call, gesture) => {
      switch (input.operation) {
        case "fast-model": return actions.fastModelAccess(Schema.decodeUnknownSync(Schema.Literals(["sign-in", "sign-out"]))(input.action))
        case "address": return actions.setInstallAddress(Schema.decodeUnknownSync(address)(input))
        case "capacity": return actions.setInstallCapacity(Schema.decodeUnknownSync(capacity)(input).capacity)
        case "parallel": return actions.setInstallParallel(Schema.decodeUnknownSync(parallel)(input).parallel)
        case "preapprove-default": return actions.setInstallPreapproveDefault(Schema.decodeUnknownSync(preapprove)(input).todo_preapprove_default)
        case "daily-admissions": return actions.setInstallDailyAdmissions(Schema.decodeUnknownSync(admissions)(input).todo_daily_admissions)
        case "obsidian": return actions.setInstallObsidian(Schema.decodeUnknownSync(obsidian)(input).path)
        case "model-key": return actions.saveInstallModelKey(Schema.decodeUnknownSync(modelKey)(input), gesture)
        case "setup": return actions.setupStep(Schema.decodeUnknownSync(setup)(input))
        default: await actions.presentCard("settings", "Settings"); return actions.showSettings()
      }
    }
  })
]

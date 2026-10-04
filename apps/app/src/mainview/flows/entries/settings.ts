import { Schema } from "effect"
import { SETUP_STEP_IDS } from "@smthrs/rpc/SetupCard"
import { flow, NoPayload } from "./Declare"
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
const count = (field: string): Grammar => args => args?.trim().startsWith("{") ? object(args)
  : !args?.trim() ? { payload: {} } : Number.isFinite(Number(args.trim()))
    ? { payload: { [field]: Number(args.trim()) } } : { error: "Enter a number" }
const key: Grammar = args => {
  const parsed = object(args)
  if ("payload" in parsed) { const { role, provider, model } = parsed.payload; return { payload: {
    ...(role === undefined ? {} : { role }), ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model })
  } } }
  return parsed
}
/* The inputs each setup step needs (InstallSeam.setupStep's bodies); THE FORM LAW asks for the missing ones. */
const SETUP_REQUIRES: Readonly<Record<string, ReadonlyArray<string>>> = { address: ["bind", "origins"], app_manifest: ["owner"], repository: ["repository"] }
export const settingsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "settings", summary: "Settings", userOnly: true, userOnlyReason: "Install status requires the owner’s person session", input: NoPayload,
    /* MOCK SEAM (DesignWorld/settings.ts designInstall): the card shows the seeded install now; the live read replaces it once /api/install serves a model. */
    handler: async () => { await actions.presentCard("settings", "Settings"); return actions.showSettings() } }),
  flow({ name: "settings.address", summary: "Change Address", hidden: true, userOnly: true, userOnlyReason: "Install controls require the owner’s person session",
    grammar: object, args: "<address>", input: Schema.Struct({ listen: Schema.Literals(["mac", "network"]), bind: Schema.String, origins: Schema.Array(Schema.String) }),
    handler: input => actions.setInstallAddress(input) }),
  flow({ name: "settings.capacity", summary: "Change Machines", hidden: true, userOnly: true, userOnlyReason: "Install controls require the owner’s person session",
    grammar: count("capacity"), args: "<capacity>", input: Schema.Struct({ capacity: Schema.Number }),
    handler: ({ capacity }) => actions.setInstallCapacity(capacity) }),
  flow({ name: "settings.parallel", summary: "Change At once", hidden: true, userOnly: true, userOnlyReason: "Install controls require the owner’s person session",
    grammar: count("parallel"), args: "<parallel>", input: Schema.Struct({ parallel: Schema.Number }),
    handler: ({ parallel }) => actions.setInstallParallel(parallel) }),
  flow({ name: "settings.obsidian", summary: "Change Obsidian folder", hidden: true, userOnly: true, userOnlyReason: "Install controls require the owner’s person session",
    grammar: object, args: "<path>", input: Schema.Struct({ path: Schema.String }),
    handler: ({ path }) => actions.setInstallObsidian(path) }),
  flow({ name: "settings.model-key", summary: "Change model key", hidden: true, userOnly: true, userOnlyReason: "Install controls require the owner’s person session",
    grammar: key, args: "<role> <provider>",
    input: Schema.Struct({ role: Schema.Literals(["fast", "coding", "jev"]), provider: Schema.String, model: Schema.optional(Schema.String), value: Schema.optional(Schema.String) }),
    form: { submitLabel: "Save", args: input => JSON.stringify({ role: input.role, provider: input.provider }), fields: {
      role: { label: "Role", kind: "select" }, provider: { label: "Provider", kind: "text" },
      value: { label: "Key", kind: "write-only", required: true }
    } },
    handler: ({ role, provider, model }, _signal, _call, gesture) => actions.saveInstallModelKey({ role, provider, ...(model ? { model } : {}) }, gesture) }),
  flow({ name: "settings.setup", summary: "Continue setup", hidden: true, userOnly: true, userOnlyReason: "Install controls require the owner’s person session",
    grammar: object, args: "<step>", input: Schema.Struct({ step: Schema.Literals(SETUP_STEP_IDS),
      owner: Schema.optional(Schema.String), repository: Schema.optional(Schema.String), bind: Schema.optional(Schema.String), origins: Schema.optional(Schema.Array(Schema.String)) }),
    form: { submitLabel: "Continue", args: input => JSON.stringify(input),
      requires: payload => SETUP_REQUIRES[String(payload.step)] ?? [] },
    handler: input => actions.setupStep(input) })
]

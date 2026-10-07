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
  if ("payload" in parsed) { const { role, provider, model, action } = parsed.payload; return { payload: {
    ...(role === undefined ? {} : { role }), ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }), ...(action === undefined ? {} : { action })
  } } }
  return parsed
}
/* The inputs each setup step needs (InstallSeam.setupStep's bodies); THE FORM LAW asks for the missing ones. */
const SETUP_REQUIRES: Readonly<Record<string, ReadonlyArray<string>>> = { address: ["bind", "origins"], app_manifest: ["owner"], repository: ["repository"] }
export const settingsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
 flow({ name: "settings.fast-model", slash:"/settings.fast-model", agent: "never", minimumRole: "owner", actors:["person"], visibility:"in-card", summary:"Smithers fast-model sign-in", agentReason:"Browser sign-in and sign-out require the owner's person session",
 grammar: object, input: Schema.Struct({action:Schema.Literals(["sign-in","sign-out"])}),
 handler: ({action}) => actions.fastModelAccess(action) }),
  flow({ name: "settings",   slash: "/settings", cli: null, journey: ["J1"], group: "Account and settings", visibility: "core", actors: ["person"], minimumRole: "owner", http: null, summary: "Model access, machines, GitHub (owner)", agentReason: "Install status requires the owner’s person session", agent: "never", input: NoPayload,
    /* MOCK SEAM (DesignWorld/settings.ts designInstall): the card shows the seeded install now; the live read replaces it once /api/install serves a model. */
    handler: async () => { await actions.presentCard("settings", "Settings"); return actions.showSettings() } }),
  flow({ name: "settings.address", agent: "never", minimumRole: "owner", actors: ["person"], visibility: "in-card",  summary: "Change Address", hidden: true, agentReason: "Install controls require the owner’s person session",
    grammar: object, args: "<address>", input: Schema.Struct({ listen: Schema.Literals(["mac", "network"]), bind: Schema.String, origins: Schema.Array(Schema.String) }),
    form: { args: payload => JSON.stringify(payload) },
    handler: input => actions.setInstallAddress(input) }),
  flow({ name: "settings.capacity", agent: "never", minimumRole: "owner", actors: ["person"], visibility: "in-card",  summary: "Change Machines", hidden: true, agentReason: "Install controls require the owner’s person session",
    grammar: count("capacity"), args: "<capacity>", input: Schema.Struct({ capacity: Schema.Number }),
    handler: ({ capacity }) => actions.setInstallCapacity(capacity) }),
  flow({ name: "settings.preapprove-default", agent: "never", minimumRole: "owner", actors: ["person"], visibility: "in-card", summary: "New TODOs start pre-approved", hidden: true, agentReason: "Install controls require the owner’s person session",
    grammar: object, input: Schema.Struct({ todo_preapprove_default: Schema.Boolean }),
    form: { args: payload => JSON.stringify(payload) },
    handler: ({ todo_preapprove_default }) => actions.setInstallPreapproveDefault(todo_preapprove_default) }),
  flow({ name: "settings.daily-admissions", agent: "never", minimumRole: "owner", actors: ["person"], visibility: "in-card", summary: "Change TODOs per day", hidden: true, agentReason: "Install controls require the owner’s person session",
    grammar: count("todo_daily_admissions"), args: "<todo_daily_admissions>", input: Schema.Struct({ todo_daily_admissions: Schema.Number }),
    handler: ({ todo_daily_admissions }) => actions.setInstallDailyAdmissions(todo_daily_admissions) }),
  flow({ name: "settings.parallel", agent: "never", minimumRole: "owner", actors: ["person"], visibility: "in-card",  summary: "Change At once", hidden: true, agentReason: "Install controls require the owner’s person session",
    grammar: count("parallel"), args: "<parallel>", input: Schema.Struct({ parallel: Schema.Number }),
    handler: ({ parallel }) => actions.setInstallParallel(parallel) }),
  flow({ name: "settings.obsidian", agent: "never", minimumRole: "owner", actors: ["person"], visibility: "in-card",  summary: "Change Obsidian folder", hidden: true, agentReason: "Install controls require the owner’s person session",
    grammar: object, args: "<path>", input: Schema.Struct({ path: Schema.String }),
    form: { args: payload => JSON.stringify(payload) },
    handler: ({ path }) => actions.setInstallObsidian(path) }),
  flow({ name: "settings.model-key", agent: "never", minimumRole: "owner", actors: ["person"], visibility: "in-card",  summary: "Change model key", hidden: true, agentReason: "Install controls require the owner’s person session",
    grammar: key, args: "<role> <provider>",
    input: Schema.Struct({ role: Schema.Literals(["fast", "coding", "jev"]), provider: Schema.String, model: Schema.optional(Schema.String), action: Schema.optional(Schema.Literal("remove")), value: Schema.optional(Schema.String) }),
    form: { submitLabel: "Save", args: input => JSON.stringify({ role: input.role, provider: input.provider, ...(input.action ? { action: input.action } : {}) }), requires: input => input.action === "remove" ? [] : ["value"], fields: {
      role: { label: "Role", kind: "select" }, provider: { label: "Provider", kind: "text" },
      value: { label: "Key", kind: "write-only", required: false }
    } },
    handler: ({ role, provider, model, action }, _signal, _call, gesture) => actions.saveInstallModelKey({ role, provider, ...(model ? { model } : {}), ...(action ? { action } : {}) }, gesture) }),
  flow({ name: "settings.setup", agent: "never", minimumRole: "owner", actors: ["person"], visibility: "in-card",  summary: "Continue setup", hidden: true, agentReason: "Install controls require the owner’s person session",
    grammar: object, args: "<step>", input: Schema.Struct({ step: Schema.Literals(SETUP_STEP_IDS),
      owner: Schema.optional(Schema.String), repository: Schema.optional(Schema.String), bind: Schema.optional(Schema.String), origins: Schema.optional(Schema.Array(Schema.String)) }),
    form: { submitLabel: "Continue", args: input => JSON.stringify(input),
      requires: payload => SETUP_REQUIRES[String(payload.step)] ?? [] },
    handler: input => actions.setupStep(input) })
]

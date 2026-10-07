import { MODEL_PROTOCOLS } from "@smthrs/rpc/ConfiguredModel"
import { Schema } from "effect"
import { flow, NoPayload } from "./Declare"
import type { CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"

const target = Schema.Struct({ id: Schema.String })
const targetGrammar = (args?: string) => ({ payload: args?.trim() ? { id: args.trim() } : {} })
const owner = { hidden: true, visibility: "in-card", agent: "never", actors: ["person"], minimumRole: "owner", agentReason: "Only the owner’s browser session configures models" } as const
export const modelFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
 flow({ name: "model.list", summary: "Models", hidden: true, input: NoPayload, handler: () => actions.listAgents() }),
 flow({ name: "model.show", summary: "Model", hidden: true, input: target, grammar: targetGrammar, handler: ({ id }) => actions.showModel(id) }),
 flow({ name: "model.new", summary: "New model", ...owner, input: NoPayload, handler: () => actions.newModel() }),
 flow({ name: "model.edit", summary: "Edit model", ...owner, input: target, grammar: targetGrammar, handler: ({ id }) => actions.editModel(id) }),
 flow({ name: "model.remove", summary: "Remove model", ...owner, input: target, grammar: targetGrammar, handler: ({ id }) => actions.removeModel(id) }),
 flow({ name: "model.test", summary: "Test model", ...owner, input: target, grammar: targetGrammar, handler: ({ id }) => actions.testModel(id) }),
 flow({ name: "model.save", summary: "Save model", ...owner,
  grammar: args => { try { return { payload: JSON.parse(args ?? "{}") } } catch { return { error: "Invalid model" } } },
  input: Schema.Struct({ name: Schema.String, protocol: Schema.Literals(MODEL_PROTOCOLS), modelId: Schema.String, credential: Schema.String, baseUrl: Schema.optional(Schema.String), path: Schema.optional(Schema.String) }),
  form: { submitLabel: "Save", args: input => JSON.stringify(input), fields: { modelId: { label: "Model" }, credential: { label: "Credential" } } },
  handler: input => actions.saveModel(input) }),
 flow({ name: "model.assign", summary: "Assign model", ...owner,
  grammar: args => { try { return { payload: JSON.parse(args ?? "{}") } } catch { const [role, model] = (args ?? "").trim().split(/\s+/); return { payload: { ...(role ? { role } : {}), ...(model ? { model } : {}) } } } },
  form: { submitLabel: "Save", args: payload => JSON.stringify(payload) },
  input: Schema.Struct({ role: Schema.String, model: Schema.String }), handler: input => actions.assignAgentModel(input.role, input.model) })
]

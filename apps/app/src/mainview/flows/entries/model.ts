/*
 * The `model` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { MODEL_FIELD_KINDS, MODEL_PROTOCOL_DEFAULTS, MODEL_PROTOCOLS, MODEL_QUESTION_TYPES } from "@smthrs/rpc/ConfiguredModel"
import { Schema } from "effect"
import { flag, line } from "@smthrs/ui/flow-form"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"
import { payloadFor } from "../SlashPayload"

/** The `model` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "model", label: "Models", summary: "Models and the seats they answer for" }

/** A model by the name it was saved under. */
const ModelTarget = Schema.Struct({ id: Schema.String })
const target = { fields: { id: { label: "Model", optionsFrom: "models" } } } as const

/*
 * The composer's edits (state/controller/modelCall.ts). Text a person types
 * holds newlines and quotes, so each edit takes a JSON object, as the setup
 * card's do. Four edits, each set-or-remove, because every catalog entry is
 * paid for out of the agent's 16 KiB instructions. Hidden from the human
 * menu, because the card's controls are their doors, and disclosed to the
 * agent, so it composes through the same acts.
 */
const jsonForm = { args: (payload: Readonly<Record<string, unknown>>) => JSON.stringify(payload) }

/*
 * The record as the form asks for it, flat: one control per field, and the
 * name is the id. A credential is a NAME the host resolves; there is no field
 * a value could be typed into. The rules a form cannot express (openai-chat
 * needs a base URL, a path belongs to openai-chat) are the controller's
 * refusals (state/controller/models.ts), painted on the form.
 */
const ModelRecord = Schema.Struct({
  name: Schema.String,
  protocol: Schema.Literals(MODEL_PROTOCOLS),
  baseUrl: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  modelId: Schema.String,
  credential: Schema.String
})

/*
 * The `model` flows registered as one aggregator block. None names a host
 * capability: both hosts answer the Models routes themselves, and listing
 * what a host holds is free on either. The two acts that make a real call
 * name `signed-in-to-spend`, the host-aware row in entries/auth.ts: the
 * Worker spends a deployment key behind its session, the local host spends
 * the operator's own key with nobody signed in.
 */
export const modelFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  /* The bare door: `/model` is the namespace's top surface, the way `/issues` is its list. */
  flow({
    name: "model",
    hidden: true,
    grammar: args => payloadFor("model.list", args),
    summary: "List the models and their seats",
    input: NoPayload,
    handler: () => actions.listModels()
  }),
  flow({
    name: "model.list",
    summary: "List the models and their seats",
    input: NoPayload,
    handler: () => actions.listModels()
  }),
  flow({
    name: "model.new",
    summary: "Add a model",
    input: NoPayload,
    handler: () => actions.newModel()
  }),
  flow({
    name: "model.edit",
    summary: "Edit a model",
    args: "<name>",
    input: ModelTarget,
    form: target,
    handler: ({ id }) => actions.editModel(id)
  }),
  flow({
    name: "model.save",
    summary: "Save a model",
    args: `--name <name> --protocol <${MODEL_PROTOCOLS.join("|")}> --model <model id> --credential <NAME> [--url <base url>] [--path <path>]`,
    input: ModelRecord,
    form: {
      submitLabel: "Save",
      args: (payload) =>
        line(
          flag(payload, "name"),
          flag(payload, "protocol"),
          flag(payload, "modelId", "model"),
          flag(payload, "credential"),
          flag(payload, "baseUrl", "url"),
          flag(payload, "path")
        ),
      fields: {
        baseUrl: { label: "Base URL", placeholder: "https://" },
        path: { placeholder: MODEL_PROTOCOL_DEFAULTS["openai-chat"].path },
        modelId: { label: "Model" },
        credential: { optionsFrom: "credentials" }
      }
    },
    handler: (input) => actions.saveModel(input)
  }),
  flow({
    name: "model.show",
    summary: "Select a model on the Models card",
    args: "<name>",
    input: ModelTarget,
    form: target,
    handler: ({ id }) => actions.showModel(id)
  }),
  flow({
    name: "model.remove",
    summary: "Remove a model",
    args: "<name>",
    input: ModelTarget,
    form: target,
    confirm: (payload) => `remove the model ${String(payload["id"])}`,
    handler: ({ id }) => actions.removeModel(id)
  }),
  flow({
    name: "model.test",
    summary: "Test a model with one real call",
    args: "<name>",
    requires: ["signed-in-to-spend"],
    input: ModelTarget,
    form: target,
    handler: ({ id }) => actions.testModel(id)
  }),
  flow({
    name: "model.compose",
    summary: "Compose a request for a model",
    args: "<name>",
    input: ModelTarget,
    form: target,
    handler: ({ id }) => actions.composeModel(id)
  }),
  flow({
    name: "model.ask",
    summary: "Ask a model its composed request",
    args: "<name>",
    requires: ["signed-in-to-spend"],
    input: ModelTarget,
    form: target,
    handler: ({ id }) => actions.askModel(id)
  }),
  flow({
    name: "model.recall",
    summary: "Reset a composer to the last test",
    args: "<name>",
    input: ModelTarget,
    form: target,
    handler: ({ id }) => actions.recallModel(id)
  }),
  flow({
    name: "model.fixture",
    summary: "Script the last decision answer as a test fixture",
    args: "<name>",
    input: ModelTarget,
    form: target,
    handler: ({ id }) => actions.fixtureModel(id)
  }),
  flow({
    name: "model.prompt", summary: "Set a composed prompt", hidden: true, discloseToAgent: true,
    args: "<JSON: {id, system?, prompt?, maxTokens?, temperature?}>", form: jsonForm,
    input: Schema.Struct({ id: Schema.String, system: Schema.optional(Schema.String), prompt: Schema.optional(Schema.String),
      maxTokens: Schema.optional(Schema.Number), temperature: Schema.optional(Schema.String) }),
    handler: (input) => actions.setModelPrompt(input)
  }),
  flow({
    name: "model.state", summary: "Set or remove a composed state field", hidden: true, discloseToAgent: true,
    args: `<JSON: {id, key?, kind?: "${MODEL_FIELD_KINDS.join("|")}", value?, was?, remove?}>`, form: jsonForm,
    input: Schema.Struct({ id: Schema.String, key: Schema.optional(Schema.String), kind: Schema.optional(Schema.String), value: Schema.optional(Schema.String),
      was: Schema.optional(Schema.String), remove: Schema.optional(Schema.Boolean) }),
    handler: (input) => actions.setModelField(input)
  }),
  flow({
    name: "model.question", summary: "Add, set or remove a composed question", hidden: true, discloseToAgent: true,
    args: `<JSON: {id, question?, type?: "${MODEL_QUESTION_TYPES.join("|")}", instructions?, criteria?, was?, remove?}>`, form: jsonForm,
    input: Schema.Struct({ id: Schema.String, question: Schema.optional(Schema.String), type: Schema.optional(Schema.String),
      instructions: Schema.optional(Schema.String), criteria: Schema.optional(Schema.Json), was: Schema.optional(Schema.String), remove: Schema.optional(Schema.Boolean) }),
    handler: (input) => actions.setModelQuestion(input)
  }),
  flow({
    name: "model.option", summary: "Set or remove a question's option or rung", hidden: true, discloseToAgent: true,
    args: "<JSON: {id, question, option?, about?, was?, remove?}>", form: jsonForm,
    input: Schema.Struct({ id: Schema.String, question: Schema.String, option: Schema.optional(Schema.String), about: Schema.optional(Schema.String),
      was: Schema.optional(Schema.String), remove: Schema.optional(Schema.Boolean) }),
    handler: (input) => actions.setModelOption(input)
  }),
  flow({
    name: "model.assign",
    summary: "Assign a model to a seat, or `default`",
    args: "<seat> <name|default>",
    input: Schema.Struct({ seat: Schema.String, recordId: Schema.String }),
    form: {
      submitLabel: "Assign",
      fields: { seat: { optionsFrom: "seats" }, recordId: { label: "Model", optionsFrom: "models" } }
    },
    confirm: (payload) => `assign ${String(payload["recordId"])} to the ${String(payload["seat"])} seat`,
    handler: ({ seat, recordId }) => actions.assignSeat(seat, recordId)
  })
]

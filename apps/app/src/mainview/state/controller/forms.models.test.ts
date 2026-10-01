import { describe, expect, test } from "bun:test"
import type { ModelsCardPayload } from "@smthrs/rpc/ConfiguredModel"
import { createCommandRegistry } from "../../flows/Commands"
import type { CommandActions } from "../../flows/Flows"
import type { Card, StoredModel } from "../AppState"
import type { ControllerContext } from "./context"
import { createFormsController } from "./forms"
import { MODELS_CARD_ID } from "./models"

/*
 * The model forms (THE FORM LAW): create, edit and assign are the derived
 * flow-form card and nothing else. Their selects are facts: a credential is a
 * NAME the host listed on the Models card, a seat is one the host resolves,
 * and a model is a row of app-models that the chosen seat takes. These drive
 * the real forms controller and the real flows over a store of plain maps.
 */

type FlowFormCard = Extract<Card, { kind: "flow-form" }>

const MODELS: ReadonlyArray<StoredModel> = [
  { id: "fast-kimi", protocol: "openai-chat", baseUrl: "http://127.0.0.1:11434", modelId: "kimi-for-coding/k3", credential: "OLLAMA" },
  { id: "jev", protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY", builtin: true }
]

const LISTED: Pick<ModelsCardPayload, "credentials" | "seats"> = {
  credentials: [
    { name: "OLLAMA", present: true, origins: ["http://127.0.0.1:11434"] },
    { name: "OPENAI_API_KEY", present: false, origins: ["https://api.openai.com"] }
  ],
  seats: [
    { id: "explainer", recordId: null, resolvable: true },
    { id: "recommend", recordId: null, resolvable: true }
  ]
}

const fixture = (listed: Pick<ModelsCardPayload, "credentials" | "seats"> | null = LISTED) => {
  const cards = new Map<string, Card>()
  if (listed !== null) {
    cards.set(MODELS_CARD_ID, {
      id: MODELS_CARD_ID, kind: "models", title: "Models", status: "active", createdAt: 1, ordinal: 1,
      payload: { models: [], tests: [], testing: [], host: "observed", ...listed }
    } as Card)
  }
  const saved: Array<unknown> = []
  const store = {
    session: () => ({}),
    collections: {
      cards, messages: new Map(), repos: new Map(), repositories: new Map(), workingCopies: new Map(), harnesses: new Map(),
      models: new Map(MODELS.map((model) => [model.id, model])), seats: new Map()
    },
    dispatch: (event: { type: string; card?: Card }) => {
      if (event.type === "card.upsert") cards.set(event.card!.id, event.card!)
      return { isPersisted: { promise: Promise.resolve() } }
    }
  }
  const actions = {
    repositoryFlows: () => undefined,
    knownRepositories: () => new Set<string>(),
    noteCommandRun: () => {},
    traceFlow: () => {},
    saveModel: async (input: unknown) => {
      saved.push(input)
      return "invalid · baseUrl"
    },
    snapshot: () => ({ surface: "chat", typing: false, hasConnectors: true, admin: false, signedOut: false })
  } satisfies Partial<CommandActions>
  const commands = createCommandRegistry(actions as unknown as CommandActions)
  const context = { store, commands, commandActor: "user" } as unknown as ControllerContext
  const forms = createFormsController(context, { nextOrdinal: () => 1 })
  const card = (id: string): FlowFormCard => cards.get(id) as FlowFormCard
  const field = (id: string, name: string) => card(id).payload.fields.find((candidate) => candidate.name === name)!
  const ask = (name: string, args?: string) => forms.renderFlowForm({ name, args, via: "user" })!
  return { forms, saved, card, field, ask }
}

describe("the model form", () => {
  test("model.save asks for the record, flat, and nothing in it can hold a credential's value", () => {
    const app = fixture()
    const { cardId, missing } = app.ask("model.save")
    expect(missing).toEqual(["name", "protocol", "modelId", "credential"])
    expect(app.card(cardId).payload.fields.map((field) => [field.name, field.kind, field.required])).toEqual([
      ["name", "text", true],
      ["protocol", "select", true],
      ["baseUrl", "text", false],
      ["path", "text", false],
      ["modelId", "text", true],
      ["credential", "select", true]
    ])
    expect(app.field(cardId, "protocol").options?.map((option) => option.value)).toEqual(["anthropic-messages", "openai-responses", "openai-chat", "evaluation"])
  })

  test("the credential select is the names the host listed, and one it does not hold cannot be picked", () => {
    const app = fixture()
    const { cardId } = app.ask("model.save")
    expect(app.field(cardId, "credential").options).toEqual([
      { value: "OLLAMA", label: "OLLAMA" },
      { value: "OPENAI_API_KEY", label: "OPENAI_API_KEY", disabled: true, reason: "missing" }
    ])
  })

  test("with no Models card the host listed nothing, so no credential or seat is invented", () => {
    const app = fixture(null)
    expect(app.field(app.ask("model.save").cardId, "credential").options).toEqual([])
    expect(app.field(app.ask("model.assign").cardId, "seat").options).toEqual([])
  })

  test("the line model.edit opens the form with prefills every field", () => {
    const app = fixture()
    const { cardId, missing } = app.ask("model.save", "--name fast-kimi --protocol openai-chat --model kimi-for-coding/k3 --credential OLLAMA --url http://127.0.0.1:11434")
    expect(app.card(cardId).payload.draft).toEqual({
      name: "fast-kimi", protocol: "openai-chat", baseUrl: "http://127.0.0.1:11434", modelId: "kimi-for-coding/k3", credential: "OLLAMA"
    })
    // Nothing is missing, so the form reports every field: it was opened to edit them.
    expect(missing).toEqual(["name", "protocol", "baseUrl", "path", "modelId", "credential"])
  })

  test("a rule the form cannot express is the controller's refusal, painted on the form", async () => {
    const app = fixture()
    const { cardId } = app.ask("model.save", "--name fast-kimi --protocol openai-chat --model kimi-for-coding/k3 --credential OLLAMA")
    await app.forms.submitForm(cardId, undefined, undefined)
    expect(app.saved).toEqual([{ name: "fast-kimi", protocol: "openai-chat", modelId: "kimi-for-coding/k3", credential: "OLLAMA" }])
    expect(app.card(cardId).status).toBe("error")
    expect(app.card(cardId).payload.error).toBe("invalid · baseUrl")
  })
})

describe("the seat form", () => {
  test("the seats are the ones the host listed, named as the card names them", () => {
    const app = fixture()
    expect(app.field(app.ask("model.assign").cardId, "seat").options).toEqual([
      { value: "explainer", label: "Explainer" },
      { value: "recommend", label: "Recommendations" }
    ])
  })

  test("before a seat is picked every model is offered; a seat narrows them to its kind and adds the host's default", async () => {
    const app = fixture()
    const { cardId } = app.ask("model.assign")
    expect(app.field(cardId, "recordId").options?.map((option) => option.value)).toEqual(["fast-kimi", "jev"])
    await app.forms.setFormField(cardId, "seat", "explainer")
    expect(app.field(cardId, "recordId").options).toEqual([
      { value: "default", label: "Default" },
      { value: "fast-kimi", label: "fast-kimi · kimi-for-coding/k3" }
    ])
    await app.forms.setFormField(cardId, "seat", "recommend")
    expect(app.field(cardId, "recordId").options?.map((option) => option.value)).toEqual(["default", "jev"])
  })

  test("the card's Assign button names the seat, and the form opens on the models that seat takes", () => {
    const app = fixture()
    const { cardId, missing } = app.ask("model.assign", "recommend")
    expect(missing).toEqual(["recordId"])
    expect(app.card(cardId).payload.draft).toEqual({ seat: "recommend" })
    expect(app.field(cardId, "recordId").options?.map((option) => option.value)).toEqual(["default", "jev"])
  })
})

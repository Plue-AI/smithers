import { expect, test } from "bun:test"
import ts from "typescript"
import { APP_TRANSITION_SCHEMAS, validateAppTransition } from "./AppTransitionValidation"
import { APP_TRANSITION_TYPES, emptyAppProjection, projectAppEvent, seedAppProjection } from "./AppProjection"

const fixture = () => seedAppProjection(emptyAppProjection(), { createdAt: 1, theme: "light" })

test("every transition has a payload schema and top-level contract fields cannot silently drift", async () => {
  expect(Object.keys(APP_TRANSITION_SCHEMAS).sort()).toEqual(Object.keys(APP_TRANSITION_TYPES).sort())
  const source = ts.createSourceFile("AppState.ts", await Bun.file(new URL("./AppState.ts", import.meta.url)).text(), ts.ScriptTarget.Latest, true)
  const alias = source.statements.find((node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === "AppTransition")!
  expect(ts.isUnionTypeNode(alias.type)).toBe(true)
  for (const member of (alias.type as ts.UnionTypeNode).types) {
    const properties = (member as ts.TypeLiteralNode).members as ts.NodeArray<ts.PropertySignature>
    const tag = properties.find(property => property.name!.getText(source) === "type")!.type as ts.LiteralTypeNode
    const name = (tag.literal as ts.StringLiteral).text as keyof typeof APP_TRANSITION_SCHEMAS
    expect(Object.keys(APP_TRANSITION_SCHEMAS[name].shape).sort()).toEqual(properties.map(property => property.name!.getText(source)).sort())
    expect(APP_TRANSITION_SCHEMAS[name].safeParse({ type: name, actor: "unknown-actor" }).success).toBe(false)
  }
})

test("validates fields which diagnostic-only reducer cases do not write into domain rows", () => {
  const state = fixture()
  const flow = { type: "flow.invoked", actor: "user", name: "help", args: null, hidden: true,
    outcome: "executed", detail: null, durationMs: 5 } as const
  expect(validateAppTransition(state, flow)).toEqual(flow)
  for (const invalid of [{ ...flow, durationMs: "5" }, { ...flow, outcome: "pretend" }, { ...flow, extra: true },
    { ...flow, actor: "invalid-actor" }, { type: "flow.invoked", actor: "user" }]) {
    expect(() => validateAppTransition(state, invalid)).toThrow("event contract")
  }
})

test("an omitted card kind binds to the current kind and validates payload clears", () => {
  const state = projectAppEvent(fixture(), { revision: 1, createdAt: 2, persistenceMode: "memory", transition: {
    type: "card.upsert", actor: "system", card: { id: "file", kind: "file", title: "File", status: "active", createdAt: 1, ordinal: 0,
      payload: { repo: "org/repo", path: "a.ts", content: "hello", truncated: false, line: 3 } }
  } })
  const transition = validateAppTransition(state, { type: "card.updated", actor: "system", id: "file", patch: { payload: { line: undefined } } })
  expect(transition).toMatchObject({ patch: { payload: { line: undefined } } })
  expect(() => validateAppTransition(state, { type: "card.updated", actor: "system", id: "file", patch: { payload: { line: "three" } } })).toThrow("event contract")
})

test("domain schemas validate observed inventories and creation types", () => {
  const state = fixture()
  expect(validateAppTransition(state, { type: "repositories.loaded", actor: "system", repositories: [] })).toMatchObject({ repositories: [] })
  for (const invalid of [
    { type: "repositories.loaded", actor: "system", repositories: [{ id: "org/repo" }] },
    { type: "repo-tree.loaded", actor: "system", copyId: "copy", path: "", entries: [], truncated: "false" },
    { type: "card.maximized", actor: "smithers", id: "file" },
    { type: "connector.local.connected", actor: "system", access: "root", repository: {} },
    { type: "billing.plans.loaded", actor: "system", planKey: "pro", sandbox: { concurrentInUse: -1 }, plans: [] },
    { type: "billing.plans.loaded", actor: "unknown", planKey: "pro", sandbox: {}, plans: [] },
    { type: "tab.opened", actor: "user", tab: { id: "t", kind: "terminal", title: "Terminal" } }
  ]) expect(() => validateAppTransition(state, invalid)).toThrow("event contract")
})

test("a model event carries a credential name and never a value, a test record or a reserved name", () => {
  const state = fixture()
  const model = { id: "mine", protocol: "openai-chat", baseUrl: "https://openrouter.ai", modelId: "moonshotai/kimi-k3", credential: "OPENROUTER_API_KEY" }
  const test = { id: "mine", testedAt: 5, result: { ok: false, latencyMs: 9, failure: { code: "timeout", deadlineMs: 15000 }, fault: "dependency" } }
  for (const valid of [
    { type: "models.observed", actor: "system", models: [{ ...model, builtin: true }] },
    { type: "model.saved", actor: "smithers", model },
    { type: "model.removed", actor: "user", id: "mine" },
    { type: "model.tested", actor: "system", test },
    { type: "seat.assigned", actor: "user", seat: "explainer", recordId: null }
  ] as const) expect(validateAppTransition(state, valid)).toEqual(valid as unknown as ReturnType<typeof validateAppTransition>)
  for (const invalid of [
    { type: "model.saved", actor: "user", model: { ...model, apiKey: "sk-live" } },
    { type: "model.saved", actor: "user", model: { ...model, lastTest: test } },
    { type: "model.saved", actor: "user", model: { ...model, id: "default" } },
    { type: "model.saved", actor: "user", model: { ...model, credential: "sk-live-lowercase" } },
    { type: "models.observed", actor: "user", models: [] },
    { type: "model.tested", actor: "user", test },
    { type: "model.tested", actor: "system", test: { ...test, result: { ...test.result, failure: { code: "timeout", deadlineMs: 15000, message: "sk-live" } } } },
    { type: "seat.assigned", actor: "user", seat: "role:ui", recordId: "mine" },
    { type: "seat.assigned", actor: "user", seat: "explainer", recordId: "default" }
  ]) expect(() => validateAppTransition(state, invalid)).toThrow("event contract")
})

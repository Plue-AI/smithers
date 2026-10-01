import { MODEL_CATALOG_PATH,MODEL_TEST_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { ConfiguredModel,ModelCatalog,ModelTestResult } from "@smthrs/rpc/ConfiguredModel"
import { MODEL_TEST_DEADLINE_MS } from "@smthrs/rpc/ConfiguredModel"
import type { StorageApi } from "@tanstack/db"
import { afterEach,expect,test } from "bun:test"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import { memoryStorage } from "../TestFixtures"
import type { ControllerContext } from "./context"
import { createFailureController } from "./failures"
import type { FormRenderRequest } from "./forms"
import { MODELS_CARD_ID,createModelsController,modelFailureLine,resolvedSeats,seatBinding } from "./models"

const mine: ConfiguredModel = { id: "mine", protocol: "openai-chat", baseUrl: "https://openrouter.ai", modelId: "moonshotai/kimi-k3", credential: "OPENROUTER_API_KEY" }
const jev: ConfiguredModel = { id: "jev", protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY", builtin: true }
const catalog: ModelCatalog = { models: [jev], seats: ["explainer", "recommend"], credentials: [
  { name: "OPENROUTER_API_KEY", present: true, origins: ["https://openrouter.ai"] },
  { name: "AI_GATEWAY_API_KEY", present: true, origins: ["https://ai-gateway.vercel.sh"] }
] }
const passed: ModelTestResult = { ok: true, latencyMs: 412, sample: "ok" }
const refused: ModelTestResult = { ok: false, latencyMs: 9, failure: { code: "refused", status: 401 }, fault: "user" }

type Answer = (url: string, init: RequestInit | undefined) => Promise<Response>
const opened: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of opened.splice(0)) await close() })

async function setup(answer: Answer, storage: StorageApi = memoryStorage(), services: object = {}) {
  const store = await createAppStore({ kind: "localStorage", storage })
  const calls: Array<{ path: string; body: unknown }> = []
  const forms: FormRenderRequest[] = []
  let disposed = false
  const ctx = { store, commandActor: "user", baseUrl: "", accountEpoch: 0, services, onDispose: () => {}, get disposed() { return disposed },
    boundedFetch: async (url: string, init?: RequestInit) => {
      calls.push({ path: url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return answer(url, init)
    } } as unknown as ControllerContext
  Object.assign(ctx, { toastRuns: new Map(), toastDebounceMs: 0, toastAutoDismissMs: 10_000, unref: () => {} })
  const failures = createFailureController(ctx)
  const background: Promise<unknown>[] = []
  ctx.withToast = ((...args: Parameters<typeof failures.withToast>) => {
    const work = failures.withToast(...args)
    background.push(work)
    return work
  }) as typeof ctx.withToast
  ctx.resolveToast = failures.resolveToast
  let minimized = 0
  const models = createModelsController(ctx, { nextOrdinal: store.nextOrdinal, minimizeCard: () => { minimized += 1 },
    renderFlowForm: (request) => { forms.push(request); return { cardId: "form-model.save", missing: ["name"] } } })
  opened.push(async () => { disposed = true; await store.settled?.(); await store.dispose?.() })
  const card = (): Extract<Card, { kind: "models" }> | undefined => {
    const row = store.collections.cards.get(MODELS_CARD_ID)
    return row?.kind === "models" ? row : undefined
  }
  const toast = (id: string) => store.collections.toasts.get(`toast-model.test:${id}`)
  const settled = () => Promise.all(background)
  return { store, storage, ctx, calls, forms, models, card, toast, settled, minimized: () => minimized, tests: () => calls.filter((call) => call.path === MODEL_TEST_PATH) }
}
const save = (t: Awaited<ReturnType<typeof setup>>, model: ConfiguredModel = mine) =>
  t.store.dispatch({ type: "model.saved", actor: "user", model }).isPersisted.promise
const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms))

test("a catalog cached by the departed account cannot repopulate its credential names after sign-out", async () => {
  const enrolled = { ...catalog, credentials: [{ name: "ALICE_ONLY", origins: ["https://alice.example"], present: true, managed: true }] }
  const t = await setup(() => Promise.resolve(Response.json(enrolled)))
  await t.models.listModels(); await t.settled()
  expect(t.card()?.payload.credentials[0]?.name).toBe("ALICE_ONLY")
  Object.assign(t.ctx, { accountEpoch: t.ctx.accountEpoch + 1 })
  await t.store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
  t.models.newModel()
  // Rendering before the next network response must not recover the old account's metadata.
  await t.models.saveModel({ name: "public", protocol: "openai-chat", modelId: "public", credential: "CEREBRAS_API_KEY", baseUrl: "https://api.cerebras.ai" })
  expect(JSON.stringify(t.card()?.payload)).not.toContain("ALICE_ONLY")
})

/** A host whose test route answers only when the test says so. */
const held = () => {
  const releases: Array<(response: Response) => void> = []
  const answer: Answer = (url) => url === MODEL_TEST_PATH ? new Promise<Response>((resolve) => { releases.push(resolve) }) : Promise.resolve(Response.json(catalog))
  return { answer, releases }
}

test("a test is requested before the host answers, chat stays usable, and the toast settles only with the result", async () => {
  const host = held()
  const t = await setup(host.answer)
  await save(t)
  const result = await Promise.race([t.models.testModel("mine"), tick(100).then(() => "blocked")])
  expect(result).toEqual({ value: "Requested" })
  expect(t.card()?.payload.testing).toEqual(["mine"])
  await tick()
  expect(t.toast("mine")?.status).toBe("running")
  // The work is still out: nothing about it holds the transcript or the composer.
  await t.store.dispatch({ type: "composer.changed", actor: "user", draft: "still typing" }).isPersisted.promise
  expect(t.store.session().draft).toBe("still typing")
  expect(t.store.collections.models.get("mine")?.lastTest).toBeUndefined()
  // The wire carries the record and nothing the app added to it.
  expect(t.tests()).toEqual([{ path: MODEL_TEST_PATH, body: { model: mine } }])
  host.releases[0]!(Response.json(passed))
  await t.settled()
  expect(t.store.collections.models.get("mine")?.lastTest).toMatchObject({ id: "mine", result: passed })
  expect(t.card()?.payload).toMatchObject({ testing: [], tests: [{ id: "mine", result: passed }] })
  expect(t.card()?.payload.attention).toBeUndefined()
  expect(t.toast("mine")?.status).toBe("ok")
})

test("a repeated launch is one call, and the settled test can be launched again", async () => {
  const host = held()
  const t = await setup(host.answer)
  await save(t)
  await t.models.testModel("mine")
  expect(await t.models.testModel("mine")).toEqual({ value: "Requested" })
  expect(t.tests()).toHaveLength(1)
  host.releases[0]!(Response.json(passed))
  await t.settled()
  await t.models.testModel("mine")
  expect(t.tests()).toHaveLength(2)
  host.releases[1]!(Response.json(passed))
  await t.settled()
})

test("a failure stays on the toast and surfaces the card unasked, with the number the host armed", async () => {
  const host = held()
  const t = await setup(host.answer)
  await save(t)
  await t.models.listModels()
  await t.settled()
  const listed = t.card()!.ordinal
  await t.store.dispatch({ type: "message.appended", actor: "user", text: "meanwhile" }).isPersisted.promise
  await t.models.testModel("mine")
  await tick()
  const timeout: ModelTestResult = { ok: false, latencyMs: 15001, failure: { code: "timeout", deadlineMs: 15001 }, fault: "dependency" }
  host.releases[0]!(Response.json(timeout))
  await t.settled()
  expect(t.store.collections.models.get("mine")?.lastTest?.result).toEqual(timeout)
  expect(t.card()?.payload).toMatchObject({ testing: [], attention: { kind: "test-failed", recordId: "mine" } })
  expect(t.card()!.ordinal).toBeGreaterThan(listed)
  // The record's deadline, not this build's constant.
  expect(MODEL_TEST_DEADLINE_MS).not.toBe(15001)
  // The card's one fix, on the toast too: a timeout is not the record's mistake, so it is tried again.
  expect(t.toast("mine")).toMatchObject({ status: "failed", detail: "timeout · 15001 ms", action: { flow: "model.test", args: "mine", label: "Test" } })
  // Retryable: the failed toast is the one the next launch resolves.
  await t.models.testModel("mine")
  host.releases[1]!(Response.json(passed))
  await t.settled()
  expect(t.toast("mine")?.status).toBe("ok")
  expect(t.card()?.payload.attention).toBeUndefined()
})

test("a host that refuses to run the test, or never answers, is a typed failure without its words", async () => {
  const secretish = "sk-live-should-never-be-stored"
  const t = await setup(async (url) => url === MODEL_TEST_PATH
    ? Response.json({ code: "sign_in_required", message: `Sign in first ${secretish}` }, { status: 401 })
    : Response.json(catalog))
  await save(t)
  await t.models.testModel("mine")
  await t.settled()
  const stored = t.store.collections.models.get("mine")!.lastTest!
  expect(stored.result).toMatchObject({ ok: false, fault: "user", failure: { code: "host_refused", refusal: "sign_in_required", status: 401 } })
  expect(JSON.stringify([stored, t.card()])).not.toContain(secretish)

  const dead = await setup(async (url) => { if (url === MODEL_TEST_PATH) throw new Error(`connect failed ${secretish}`); return Response.json(catalog) })
  await save(dead)
  await dead.models.testModel("mine")
  await dead.settled()
  expect(dead.store.collections.models.get("mine")!.lastTest!.result).toMatchObject({ ok: false, fault: "infra", failure: { code: "host_refused", refusal: null, status: null } })
  expect(JSON.stringify([...dead.store.collections.models.values(), dead.card()])).not.toContain(secretish)

  const garbled = await setup(async (url) => Response.json(url === MODEL_TEST_PATH ? { ok: true, latencyMs: "fast" } : catalog))
  await save(garbled)
  await garbled.models.testModel("mine")
  await garbled.settled()
  expect(garbled.store.collections.models.get("mine")!.lastTest!.result).toMatchObject({ ok: false, fault: "bug", failure: { code: "host_refused", status: 200 } })
})

test("a response for an account that left, or for a route that was edited meanwhile, writes nothing", async () => {
  const host = held()
  const t = await setup(host.answer)
  await save(t)
  await t.models.testModel("mine")
  await tick()
  Object.assign(t.ctx, { accountEpoch: t.ctx.accountEpoch + 1 })
  host.releases[0]!(Response.json(passed))
  await t.settled()
  expect(t.store.collections.models.get("mine")?.lastTest).toBeUndefined()
  expect(t.card()?.payload.testing).toEqual([])
  expect(t.toast("mine")).toBeUndefined()

  // The old route's answer is not evidence about the new one; the new route's own test still lands.
  await t.models.testModel("mine")
  await t.models.saveModel({ name: "mine", protocol: "openai-chat", modelId: "qwen/qwen3-coder", credential: "OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai" })
  await t.models.testModel("mine")
  expect(t.tests()).toHaveLength(3)
  host.releases[1]!(Response.json(refused))
  await tick()
  expect(t.store.collections.models.get("mine")?.lastTest).toBeUndefined()
  expect(t.card()?.payload.testing).toEqual(["mine"])
  host.releases[2]!(Response.json(passed))
  await t.settled()
  expect(t.store.collections.models.get("mine")?.lastTest?.result).toEqual(passed)
})

test("the failed toast's one fix follows the fault: the user's own mistake is edited, anything else is tried again", async () => {
  const rateLimited: ModelTestResult = { ok: false, latencyMs: 9, failure: { code: "refused", status: 429 }, fault: "wait" }
  for (const [result, action] of [
    [refused, { flow: "model.edit", args: "mine", label: "Edit" }],
    [rateLimited, { flow: "model.test", args: "mine", label: "Test" }]
  ] as const) {
    const host = held()
    const t = await setup(host.answer)
    await save(t)
    await t.models.testModel("mine")
    // Past the debounce, so there is a toast for the failure to stay on.
    await tick()
    host.releases[0]!(Response.json(result))
    await t.settled()
    expect(t.toast("mine")).toMatchObject({ status: "failed", action })
  }
})

test("a press after the account changed starts its own test, and its result is kept", async () => {
  const host = held()
  const t = await setup(host.answer)
  await save(t)
  await t.models.testModel("mine")
  await tick()
  Object.assign(t.ctx, { accountEpoch: t.ctx.accountEpoch + 1 })
  expect(await t.models.testModel("mine")).toEqual({ value: "Requested" })
  expect(t.tests()).toHaveLength(2)
  // The account that left gets no say, and does not clear the test that is out now.
  host.releases[0]!(Response.json(refused))
  await tick()
  expect(t.store.collections.models.get("mine")?.lastTest).toBeUndefined()
  expect(t.card()?.payload.testing).toEqual(["mine"])
  host.releases[1]!(Response.json(passed))
  await t.settled()
  expect(t.store.collections.models.get("mine")?.lastTest?.result).toEqual(passed)
  expect(t.card()?.payload.testing).toEqual([])
  expect(t.toast("mine")?.status).toBe("ok")
})

test("a test requested before a reload is launched again, once, and one whose model is gone is forgotten", async () => {
  const storage = memoryStorage()
  const before = await setup(held().answer, storage)
  await save(before)
  await before.models.testModel("mine")
  await tick()
  await opened.pop()!()

  const host = held()
  const after = await setup(host.answer, storage)
  expect(after.card()?.payload.testing).toEqual(["mine"])
  after.models.resumeModels()
  after.models.resumeModels()
  await tick()
  expect(after.tests()).toHaveLength(1)
  host.releases[0]!(Response.json(passed))
  await after.settled()
  expect(after.card()?.payload.testing).toEqual([])
  expect(after.store.collections.models.get("mine")?.lastTest?.result).toEqual(passed)
  await opened.pop()!()

  const gone = await setup(host.answer, storage)
  await gone.store.dispatch({ type: "card.upsert", actor: "system", card: { ...gone.card()!, payload: { ...gone.card()!.payload, testing: ["absent"] } } }).isPersisted.promise
  gone.models.resumeModels()
  expect(gone.tests()).toHaveLength(0)
  expect(gone.card()?.payload.testing).toEqual([])
})

test("listing paints the stored models at once, then the host's own rows, seats and credential names", async () => {
  let release!: (response: Response) => void
  const t = await setup((url) => url === MODEL_CATALOG_PATH ? new Promise((resolve) => { release = resolve }) : Promise.reject(new Error("unexpected")))
  await save(t)
  const listing = t.models.listModels()
  await tick()
  expect(t.card()?.payload).toMatchObject({ models: [mine], host: "unavailable", seats: [] })
  release(Response.json(catalog))
  expect(await listing).toEqual({ value: "Requested" })
  await t.settled()
  expect(t.card()?.payload).toMatchObject({ models: [jev, mine], host: "observed", credentials: catalog.credentials,
    seats: catalog.seats.map((id) => ({ id, recordId: null, resolvable: true })) })
  expect(t.store.collections.models.get("jev")?.builtin).toBe(true)
})

test("a host that refuses its catalog says so on the card and lists nothing of its own", async () => {
  const t = await setup(async () => Response.json({ code: "sign_in_required", message: "Sign in to continue." }, { status: 401 }))
  await t.models.listModels()
  await t.settled()
  expect(t.card()?.payload.host).toBe("unavailable")
  expect(t.card()?.payload.error).toContain("sign_in_required")
  expect(t.store.collections.models.size).toBe(0)
})

test("a catalog failure stays typed and retryable, and a departed account cannot overwrite a newer refresh", async () => {
  const releases: Array<(response: Response) => void> = []
  const t = await setup(() => new Promise<Response>((resolve) => { releases.push(resolve) }))
  await t.models.listModels()
  await tick()
  releases[0]!(Response.json({ code: "sign_in_required", message: "private provider prose" }, { status: 401 }))
  await t.settled()
  expect(t.card()?.payload.refresh).toEqual({ state: "failed", failure: { code: "host_refused", refusal: "sign_in_required", status: 401, fault: "user" } })
  expect(t.store.collections.toasts.get("toast-model.list")).toMatchObject({ status: "failed", action: { flow: "model.list", label: "Retry" } })
  expect(JSON.stringify(t.card())).not.toContain("private provider prose")
  await t.models.listModels()
  await tick()
  Object.assign(t.ctx, { accountEpoch: t.ctx.accountEpoch + 1 })
  await t.models.listModels()
  await tick()
  expect(releases).toHaveLength(3)
  releases[1]!(Response.json(catalog))
  await tick()
  expect(t.card()?.payload.refresh).toEqual({ state: "requested" })
  expect(t.store.collections.models.size).toBe(0)
  expect(t.store.collections.toasts.get("toast-model.list")?.status).toBe("running")
  releases[2]!(Response.json(catalog))
  await t.settled()
  expect(t.card()?.payload.refresh).toBeUndefined()
  expect(t.store.collections.models.get("jev")?.builtin).toBe(true)
  expect(t.store.collections.toasts.get("toast-model.list")?.status).toBe("ok")
})

test("an assigned seat whose credential the host lacks surfaces once, and boot asks nothing when no seat is assigned", async () => {
  const missing: ModelCatalog = { ...catalog, credentials: [{ name: "OPENROUTER_API_KEY", present: false, origins: ["https://openrouter.ai"] }] }
  const bootstrap = { capabilities: ["agent"] }
  const t = await setup(async () => Response.json(missing), memoryStorage(), { bootstrap })
  await save(t)
  await t.models.observeModels()
  expect(t.calls).toHaveLength(0)
  expect(await t.models.assignSeat("explainer", "mine")).toBeUndefined()
  await t.models.observeModels()
  expect(t.card()?.payload).toMatchObject({ attention: { kind: "seat-unresolved", seat: "explainer" },
    seats: [{ id: "explainer", recordId: "mine", resolvable: false }, { id: "recommend", recordId: null, resolvable: true }] })
  const raised = t.card()!.ordinal
  await t.store.dispatch({ type: "message.appended", actor: "user", text: "meanwhile" }).isPersisted.promise
  await t.models.observeModels()
  expect(t.card()!.ordinal).toBe(raised)

  const quiet = await setup(async () => Response.json(missing), memoryStorage(), {})
  await save(quiet)
  await quiet.models.assignSeat("explainer", "mine")
  const asked = quiet.calls.length
  await quiet.models.observeModels()
  expect(quiet.calls).toHaveLength(asked)
})

test("save, assign and remove refuse what the record cannot be, and write nothing", async () => {
  const t = await setup(async () => Response.json(catalog))
  await t.models.listModels()
  await t.settled()
  const input = { name: "mine", protocol: "openai-chat", modelId: "moonshotai/kimi-k3", credential: "OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai" } as const
  for (const [refusal, bad] of [
    ["invalid · baseUrl", { ...input, baseUrl: undefined }],
    ["invalid · path", { ...input, protocol: "anthropic-messages", baseUrl: undefined, path: "/v2/messages" }],
    ["invalid · credential", { ...input, credential: "sk-live-pasted-key" }],
    ["invalid · name", { ...input, name: "default" }],
    ["invalid · name", { ...input, name: "jev" }]
  ] as const) expect(await t.models.saveModel(bad)).toBe(refusal)
  expect(t.store.collections.models.size).toBe(1)
  // A pasted key never reaches a row, the card, or the refusal that turned it away.
  expect(JSON.stringify([...t.store.collections.cards.values()])).not.toContain("sk-live-pasted-key")

  expect(await t.models.saveModel({ ...input, baseUrl: " https://openrouter.ai ", path: "" })).toEqual({ value: "saved mine" })
  expect(t.store.collections.models.get("mine")).toMatchObject(mine)
  expect(t.store.collections.models.get("mine")?.path).toBeUndefined()
  expect(t.card()?.payload.selected).toBe("mine")

  expect(await t.models.assignSeat("role:ui", "mine")).toBeString()
  // The deleted front-door seat is an unknown seat now, and a generation model never takes a decision seat.
  expect(await t.models.assignSeat("front-door", "jev")).toBeString()
  expect(await t.models.assignSeat("recommend", "mine")).toBeString()
  expect(await t.models.assignSeat("explainer", "absent")).toBeString()
  expect(t.store.collections.seats.size).toBe(0)
  expect(await t.models.assignSeat("explainer", "mine")).toBeUndefined()
  expect(await t.models.assignSeat("recommend", "jev")).toBeUndefined()
  expect(resolvedSeats(t.store)).toEqual([{ seat: "explainer", model: mine }, { seat: "recommend", model: jev }])
  expect(seatBinding(t.store, "explainer")).toEqual({ protocol: "openai-chat", baseUrl: "https://openrouter.ai", modelId: "moonshotai/kimi-k3", credential: "OPENROUTER_API_KEY" })
  expect(seatBinding(t.store, "chat")).toBeUndefined()
  expect(await t.models.assignSeat("explainer", "default")).toBeUndefined()
  expect(resolvedSeats(t.store).map((row) => row.seat)).toEqual(["recommend"])

  expect(await t.models.removeModel("jev")).toBeString()
  expect(await t.models.removeModel("absent")).toBeString()
  expect(await t.models.removeModel("mine")).toBeUndefined()
  expect(t.card()?.payload).toMatchObject({ models: [jev] })
  expect(t.card()?.payload.selected).toBeUndefined()
})

test("a local host has no cloud seat to assign", async () => {
  const t = await setup(async () => Response.json({ ...catalog, seats: ["explainer"] }))
  await t.models.listModels()
  await t.settled()
  expect(await t.models.assignSeat("recommend", "jev")).toBeString()
  expect(t.store.collections.seats.size).toBe(0)
})

test("a form opened from the maximized pane returns the card to the transcript, where the form is", async () => {
  const t = await setup(async () => Response.json(catalog))
  await save(t)
  await t.models.listModels()
  await t.settled()
  t.models.newModel()
  expect(t.minimized()).toBe(0)
  await t.store.dispatch({ type: "card.maximized", actor: "user", id: MODELS_CARD_ID }).isPersisted.promise
  t.models.newModel()
  t.models.editModel("mine")
  expect(t.minimized()).toBe(2)
  // A refusal opens no form, so the pane stays.
  t.models.editModel("jev")
  expect(t.minimized()).toBe(2)
})

test("new and edit open the one save form, and a host row is not editable", async () => {
  const t = await setup(async () => Response.json(catalog))
  await save(t, { ...mine, path: "/api/v1/chat/completions" })
  await t.models.listModels()
  await t.settled()
  expect(t.models.newModel()).toEqual({ value: "rendered a form for name: ask the user to fill it in" })
  t.models.editModel("mine")
  expect(t.forms).toEqual([
    { name: "model.save", args: undefined, via: "user" },
    { name: "model.save", via: "user",
      args: "--name mine --protocol openai-chat --model moonshotai/kimi-k3 --credential OPENROUTER_API_KEY --url https://openrouter.ai --path /api/v1/chat/completions" }
  ])
  expect(t.models.editModel("jev")).toBeString()
  expect(t.models.editModel("absent")).toBeString()
  expect(t.forms).toHaveLength(2)
  expect(t.models.showModel("jev")).toBeUndefined()
  expect(t.card()?.payload.selected).toBe("jev")
  expect(t.models.showModel("absent")).toBeString()
})

test("a failure reads as its code and its number, never a sentence", () => {
  expect([
    modelFailureLine({ code: "refused", status: 401 }),
    modelFailureLine({ code: "timeout", deadlineMs: 15000 }),
    modelFailureLine({ code: "invalid", field: "baseUrl" }),
    modelFailureLine({ code: "credential_missing", credential: "OPENAI_API_KEY" }),
    modelFailureLine({ code: "endpoint_forbidden" }),
    modelFailureLine({ code: "host_refused", refusal: "sign_in_required", status: 401, fault: "user" }),
    modelFailureLine({ code: "host_refused", refusal: null, status: null, fault: "infra" })
  ]).toEqual(["refused · 401", "timeout · 15000 ms", "invalid · baseUrl", "credential_missing · OPENAI_API_KEY", "endpoint_forbidden",
    "host_refused · sign_in_required", "host_refused"])
})

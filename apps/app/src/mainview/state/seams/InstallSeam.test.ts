import { describe, expect, setSystemTime, test } from "bun:test"
import { createAppStore } from "../AppStore"
import type { StorageApi } from "@tanstack/db"
import type { SeamContext } from "./SeamContext"
import { TOAST_SUPERSEDED, type FailureController } from "../controller/failures"
import { createInstallSeam, type InstallSeamOptions, type InstallTopic } from "./InstallSeam"
import { InstallModelSchema, setupCardModel, settingsCardModel, type InstallError } from "./InstallModel"
import { credentialReceipt, installFixture } from "./InstallFixtures.test-support"
import { installRequestId } from "./InstallRequestId"
import { writeOnlyGesture } from "../../flows/CommandGesture"

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(done => setTimeout(done, 0))
const memoryStorage = (): StorageApi => {
  const values = new Map<string, string>()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } }
}
const failure = (fault: InstallError["class"] = "user"): InstallError => ({ code: "refused", class: fault, message: "Address refused", fix: "Use another origin", retry_at: "2026-10-02T12:00:00Z" })
const harness = async (answer: (path: string, init?: RequestInit) => Promise<Response> | Response, options: InstallSeamOptions = {}, storage = memoryStorage()) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  const requests: Array<{ path: string; init?: RequestInit }> = []
  const toasts: Array<{ outcome?: unknown }> = []
  const jobs: Promise<unknown>[] = []
  const presentations: string[] = []
  let receive: ((data: unknown) => void) | undefined
  let refuse: ((error: InstallError) => void) | undefined
  let subscribed = 0, stopped = 0
  const topic: InstallTopic = { subscribe: (name, data, error) => { expect(name).toBe("install"); subscribed++; receive = data; refuse = error; return () => { stopped++ } } }
  const withToast: FailureController["withToast"] = async (_key, _title, _done, work) => {
    const toast: { outcome?: unknown } = {}; toasts.push(toast)
    const job = work().then(outcome => { toast.outcome = outcome; return outcome }); jobs.push(job); return job
  }
  const ctx: SeamContext = { http: async (path, init) => { requests.push({ path, init }); return answer(path, init) }, baseUrl: "", store,
    dispatch: store.dispatch, actor: () => "user", nextOrdinal: store.nextOrdinal }
  const seam = createInstallSeam(ctx, withToast, { topic, present: kind => { presentations.push(kind) }, ...options })
  return { seam, store, requests, toasts, presentations, receive: (data: unknown) => receive?.(data), refuse: (data: InstallError) => refuse?.(data),
    subscribed: () => subscribed, stopped: () => stopped, idle: async () => { await tick(); await Promise.all(jobs); await tick() } }
}

describe("T-APP-03 install seam", () => {
  test("setup cookie authenticates reads; subscription begins after the claim", async () => {
    const model = installFixture(); model.github.signed_in = false
    const h = await harness(() => Response.json(model))
    expect(await h.seam.readInstall()).toBeUndefined()
    expect(new Headers(h.requests[0]?.init?.headers).get("Authorization")).toBeNull()
    expect(JSON.stringify(h.seam.snapshots.get())).not.toContain("one-time-token")
    expect(h.subscribed()).toBe(0)
    model.github.signed_in = true; await h.seam.readInstall(); await h.seam.readInstall()
    expect(h.subscribed()).toBe(1)
  })
  test("setup input bodies match the four input-bearing contracts and use cookies", async () => {
    for (const [step, input, path, body] of [
      ["address", { bind: "127.0.0.1:4000", origins: ["http://localhost:4000"] }, "address", { bind: "127.0.0.1:4000", origins: ["http://localhost:4000"] }],
      ["app_manifest", { owner: "smithersai" }, "app", { owner: "smithersai" }],
      ["repository", { repository: "smithersai/smithers" }, "repository", { repository: "smithersai/smithers" }],
      ["models", {}, "models", {}]
    ] as const) {
      const model = installFixture(); model.steps.find(row => row.id === step)!.state = "pending"
      const h = await harness((_path, init) => Response.json(init?.method === "POST" ? installFixture() : model))
      await h.seam.readInstall(); h.seam.setupStep({ step, ...input }); await h.idle()
      const request = h.requests[1]!
      expect(request.path).toBe(`/api/install/setup/${path}`)
      expect(JSON.parse(String(request.init!.body))).toEqual(body)
      expect(request.init!.credentials).toBe("same-origin")
      expect(new Headers(request.init!.headers).has("Authorization")).toBe(false)
      h.seam.dispose()
    }
  })
  test("S1 install projection requires no separate progress or parallel", () => {
    const fixture = installFixture(); delete fixture.parallel
    const model = InstallModelSchema.parse(fixture)
    expect(setupCardModel(model).steps).toEqual(fixture.steps)
    expect(model).not.toHaveProperty("source"); expect(model).not.toHaveProperty("machine")
  })
  test("missing install and network failures stay visible; only a real install presents Setup", async () => {
    const open = async (answer: Parameters<typeof harness>[0]) => {
      const h = await harness(answer)
      h.seam.showSetup(); await h.idle()
      return h
    }
    const missing = await open(() => new Response("<!doctype html>", { status: 404 }))
    expect(missing.toasts.map(toast => toast.outcome)).toEqual(["No install on this host"]); expect(missing.presentations).toEqual([])
    const offline = await open(() => { throw new Error("offline") })
    expect(offline.toasts.map(toast => toast.outcome)).toEqual(["Could not reach this install"])
    expect((await open(() => new Response("<!doctype html>", { status: 502 }))).toasts[0]?.outcome).toBe("Install request failed")
    expect((await open(() => Response.json(failure("permission"), { status: 403 }))).toasts[0]?.outcome).toBe("Address refused")
    const real = await open(() => Response.json(installFixture()))
    expect(real.presentations).toEqual(["setup"]); expect(real.toasts[0]?.outcome).toBe(true)
  })
  test("with the design seed standing in, only a host with no install route opens quietly; an unreachable or failing install stays visible", async () => {
    const open = async (answer: Parameters<typeof harness>[0]) => {
      const h = await harness(answer, { quietWithoutInstall: true })
      h.seam.showSetup(); await h.idle()
      return h
    }
    const missing = await open(() => new Response("<!doctype html>", { status: 404 }))
    expect(missing.toasts.map(toast => toast.outcome)).toEqual([TOAST_SUPERSEDED]); expect(missing.presentations).toEqual([])
    expect(missing.seam.snapshots.get()).toEqual({ error: { code: "no_install", class: "infra", message: "No install on this host" } })
    expect((await open(() => Response.json({}, { status: 404 }))).toasts.map(toast => toast.outcome)).toEqual([TOAST_SUPERSEDED])
    // The hosted site's HTML fallback answers 200 with a page, not an install.
    expect((await open(() => new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } }))).toasts.map(toast => toast.outcome)).toEqual([TOAST_SUPERSEDED])
    const offline = await open(() => { throw new Error("offline") })
    expect(offline.toasts.map(toast => toast.outcome)).toEqual(["Could not reach this install"]); expect(offline.presentations).toEqual([])
    expect(offline.seam.snapshots.get().error).toEqual({ code: "unreachable", class: "infra", message: "Could not reach this install" })
    expect((await open(() => new Response("Bad gateway", { status: 502 }))).toasts[0]?.outcome).toBe("Install request failed")
    expect((await open(() => Response.json(failure("permission"), { status: 403 }))).toasts[0]?.outcome).toBe("Address refused")
    expect((await open(() => Response.json({ code: "unavailable", class: "infra", message: "Install unavailable" }, { status: 503 }))).toasts[0]?.outcome).toBe("Install unavailable")
    const real = await open(() => Response.json(installFixture()))
    expect(real.presentations).toEqual(["setup"]); expect(real.toasts[0]?.outcome).toBe(true)
  })
  test("permission envelopes present no settings card", async () => {
    const h = await harness(() => Response.json(failure("permission"), { status: 403 }))
    expect(h.seam.showSettings()).toEqual({ value: "Requested" }); await h.idle()
    expect(h.seam.snapshots.get()).toEqual({ error: failure("permission") })
    expect(h.presentations).toEqual([]); expect(h.toasts[0]?.outcome).toBe("Address refused")
    expect([...h.store.collections.cards.values()]).toEqual([])
  })
  test("a setup session cannot open owner-only Settings even when GET succeeds", async () => {
    const model = installFixture(); model.github.signed_in = false
    const h = await harness(() => Response.json(model)); h.seam.showSettings(); await h.idle()
    expect(h.presentations).toEqual([])
    expect(h.seam.snapshots.get().error?.class).toBe("permission")
    expect(h.toasts[0]?.outcome).toBe("Owner access required")
  })
  test("unresolved reads acknowledge immediately; duplicate opens coalesce", async () => {
    const gate = deferred<Response>(); const h = await harness(() => gate.promise)
    expect(h.seam.showSettings()).toEqual({ value: "Requested" })
    expect(h.seam.showSettings()).toEqual({ value: "Requested" }); await tick()
    expect(h.requests).toHaveLength(1); expect(h.toasts).toEqual([{}]); expect(h.presentations).toEqual([])
    gate.resolve(Response.json(installFixture())); await h.idle()
    expect(h.presentations).toEqual(["settings"]); expect(h.toasts[0]?.outcome).toBe(true)
  })
  test("source and machine progress are independent; malformed topic data retains the projection", async () => {
    const h = await harness(() => Response.json(installFixture())); await h.seam.readInstall()
    const live = installFixture(); live.steps[6] = { id: "machine", state: "running", pct: 20 }; h.receive(live)
    expect(setupCardModel(h.seam.snapshots.get().model!).steps.find(step => step.id === "source")!.state).toBe("done")
    expect(setupCardModel(h.seam.snapshots.get().model!).steps.find(step => step.id === "machine")).toMatchObject({ state: "running", pct: 20 })
    h.receive({ bad: true }); expect(h.seam.snapshots.get().model).toEqual(live)
    expect(h.seam.snapshots.get().error?.code).toBe("invalid_install")
  })
  test("a newer topic snapshot fences an older unresolved REST response", async () => {
    const gate = deferred<Response>(); let calls = 0
    const h = await harness(() => ++calls === 1 ? Response.json(installFixture()) : gate.promise)
    await h.seam.readInstall(); const read = h.seam.readInstall()
    const live = installFixture(); live.steps[6] = { id: "machine", state: "running", pct: 75 }; h.receive(live)
    gate.resolve(Response.json(installFixture())); await read
    expect(h.seam.snapshots.get().model?.steps[6]).toEqual(live.steps[6])
  })
  test("permission loss clears privileged data; disposal fences late responses", async () => {
    const gate = deferred<Response>(); let calls = 0
    const h = await harness(() => ++calls === 1 ? Response.json(installFixture()) : gate.promise)
    await h.seam.readInstall(); h.refuse(failure("permission"))
    expect(h.seam.snapshots.get().model).toBeUndefined(); expect(h.stopped()).toBe(1)
    const pending = h.seam.readInstall(); h.seam.dispose(); gate.resolve(Response.json(installFixture())); await pending
    expect(h.seam.snapshots.get().model).toBeUndefined()
  })
  test.each(["pending", "running", "failed", "blocked"] as const)("earlier %s prevents later setup writes", async state => {
    const model = installFixture(); model.steps[0]!.state = state; model.steps[1]!.state = "pending"
    const h = await harness(() => Response.json(model)); await h.seam.readInstall()
    expect(h.seam.setupStep({ step: "app_manifest" })).toBe("Complete the earlier step"); expect(h.requests).toHaveLength(1)
  })
  test("Retry launches once; the toast waits for the terminal machine event", async () => {
    const model = installFixture(); model.steps[6]!.state = "failed"; model.steps[6] = { id: "machine", state: "failed", pct: 60 }
    const started = structuredClone(model); started.steps[6]!.state = "done"; started.steps[6] = { id: "machine", state: "running", pct: 61 }
    const h = await harness((_path, init) => Response.json(init?.method === "POST" ? started : model))
    await h.seam.readInstall()
    h.seam.setupStep({ step: "machine" }); h.seam.setupStep({ step: "machine" }); await tick()
    expect(h.requests.filter(request => request.init?.method === "POST")).toHaveLength(1)
    expect(h.requests[1]?.path).toBe("/api/install/setup/machine")
    expect(h.seam.snapshots.get().model?.steps[6]?.state).toBe("running"); expect(h.toasts[0]?.outcome).toBeUndefined()
    h.receive(installFixture()); await h.idle(); expect(h.toasts[0]?.outcome).toBe(true)
  })
  test("limits reject invalid values before transport and allow both boundaries", async () => {
    const h = await harness(() => Response.json(installFixture())); await h.seam.readInstall()
    for (const n of [-1, 3.5, NaN, Infinity, 4]) expect(typeof h.seam.setInstallCapacity(n)).toBe("string")
    for (const n of [0, -1, 2.5, NaN, Infinity, 9]) expect(typeof h.seam.setInstallParallel(n)).toBe("string")
    expect(h.requests).toHaveLength(1)
    h.seam.setInstallCapacity(3); await h.idle()
    expect(JSON.parse(String(h.requests[1]?.init?.body))).toEqual({ capacity: 3 })
    h.seam.setInstallParallel(8); await h.idle()
    expect(JSON.parse(String(h.requests[2]?.init?.body))).toEqual({ parallel: 8 })
  })
  test("refused origins stay inactive and writes remain retryable", async () => {
    const h = await harness((_path, init) => init?.method === "PUT" ? Response.json(failure(), { status: 422 }) : Response.json(installFixture()))
    await h.seam.readInstall(); const address = { listen: "network" as const, bind: "0.0.0.0:4000", origins: ["http://refused.test"] }
    h.seam.setInstallAddress(address); await h.idle()
    expect(h.seam.snapshots.get().model?.address.origins).not.toContain("http://refused.test")
    expect(h.seam.snapshots.get().error).toEqual(failure())
    h.seam.setInstallAddress(address); await h.idle(); expect(h.toasts).toHaveLength(2)
  })
  test("keys are consumed once, never stored; a refusal keeps the provider reason", async () => {
    const secret = "test-private-key"
    const h = await harness(path => path === "/api/model/credential" ? Response.json({ ...failure(), message: "Provider refused key" }, { status: 422 }) : Response.json(installFixture()))
    await h.seam.readInstall(); const gesture = writeOnlyGesture("settings.model-key", { value: secret })
    h.seam.saveInstallModelKey({ role: "coding", provider: "OpenAI" }, gesture)
    expect(gesture.takeWriteOnly?.("value")).toBeUndefined(); await h.idle()
    expect(h.requests[1]?.init?.body).toContain(secret)
    expect(JSON.stringify(h.seam.snapshots.get())).not.toContain(secret)
    expect(JSON.stringify([...h.store.collections.cards.values()])).not.toContain(secret)
    expect(h.seam.snapshots.get().model?.models[1]).toEqual({ role: "coding", provider: "OpenAI", key: "failed", error: "Provider refused key" })
  })
  test("a key is Validating while its request is in flight, then Failed with the provider's relayed reason", async () => {
    const gate = deferred<Response>()
    const h = await harness(path => path === "/api/model/credential" ? gate.promise : Response.json(installFixture()))
    await h.seam.readInstall()
    h.seam.saveInstallModelKey({ role: "jev", provider: "AI Gateway" }, writeOnlyGesture("settings.model-key", { value: "private-key" }))
    await tick(); await tick()
    expect(h.seam.snapshots.get().model?.models[2]).toEqual({ role: "jev", provider: "AI Gateway", key: "validating" })
    expect(h.seam.snapshots.get().model?.models[0]).toEqual({ role: "fast", provider: "Cerebras", key: "saved" })
    gate.resolve(Response.json({ ok: false, failure: { code: "host_refused", status: 401, refusal: "401 invalid API key" }, fault: "user" })); await h.idle()
    expect(h.seam.snapshots.get().model?.models[2]).toEqual({ role: "jev", provider: "AI Gateway", key: "failed", error: "401 invalid API key" })
    expect(h.toasts[0]?.outcome).toBe("401 invalid API key")
    expect(JSON.stringify(h.seam.snapshots.get())).not.toContain("private-key")
  })
  test("coding Save persists the chosen model after its sealed key and reports default failure (#3455)", async () => {
    for (const ok of [true, false]) {
      const h = await harness(path => path === "/api/model/credential" ? Response.json(credentialReceipt("OPENAI_API_KEY"))
        : path === "/api/model/default" ? Response.json({ ok }, { status: ok ? 200 : 503 }) : Response.json(installFixture()))
      await h.seam.readInstall()
      h.seam.saveInstallModelKey({ role: "coding", provider: "OpenAI", model: "gpt-5" }, writeOnlyGesture("settings.model-key", { value: "private-key" }))
      await h.idle()
      const request = h.requests.find(request => request.path === "/api/model/default")!
      expect(request.init?.method).toBe("PUT")
      expect(JSON.parse(String(request.init?.body))).toEqual({ model: { protocol: "openai-responses", modelId: "gpt-5", credential: "OPENAI_API_KEY" } })
      expect(request.init?.body).not.toContain("private-key")
      expect(h.toasts[0]?.outcome).toBe(ok ? true : "Could not save model")
    }
  })
  test("coding Save names each provider's address: chat protocols carry a base URL without /v1", async () => {
    for (const [provider, credential, model] of [
      ["OpenRouter", "OPENROUTER_API_KEY", { protocol: "openai-chat", modelId: "openai/gpt-5", credential: "OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai/api" }],
      ["Anthropic", "ANTHROPIC_API_KEY", { protocol: "anthropic-messages", modelId: "openai/gpt-5", credential: "ANTHROPIC_API_KEY" }],
      ["AI Gateway", "AI_GATEWAY_API_KEY", { protocol: "openai-chat", modelId: "openai/gpt-5", credential: "AI_GATEWAY_API_KEY", baseUrl: "https://ai-gateway.vercel.sh" }]
    ] as const) {
      const h = await harness(path => path === "/api/model/credential" ? Response.json(credentialReceipt(credential))
        : path === "/api/model/default" ? Response.json({ ok: true }) : Response.json(installFixture()))
      await h.seam.readInstall()
      h.seam.saveInstallModelKey({ role: "coding", provider, model: "openai/gpt-5" }, writeOnlyGesture("settings.model-key", { value: "private-key" }))
      await h.idle()
      const request = h.requests.find(request => request.path === "/api/model/default")!
      expect(JSON.parse(String(request.init?.body))).toEqual({ model })
    }
  })
  test("coding on the AI Gateway rotates the Gateway key Decisions saved, and enrolls it when none is saved", async () => {
    for (const [decisions, credential] of [
      ["saved", { action: "rotate", name: "AI_GATEWAY_API_KEY" }],
      ["none", { action: "enroll", name: "AI_GATEWAY_API_KEY", origin: "https://ai-gateway.vercel.sh" }]
    ] as const) {
      const model = installFixture(); model.models[2] = { role: "jev", provider: "AI Gateway", key: decisions }
      const h = await harness(path => path === "/api/model/credential" ? Response.json(credentialReceipt("AI_GATEWAY_API_KEY"))
        : path === "/api/model/default" ? Response.json({ ok: true }) : Response.json(model))
      await h.seam.readInstall()
      h.seam.saveInstallModelKey({ role: "coding", provider: "AI Gateway", model: "anthropic/claude-sonnet-4.5" }, writeOnlyGesture("settings.model-key", { value: "private-key" }))
      await h.idle()
      const sent = JSON.parse(String(h.requests.find(request => request.path === "/api/model/credential")!.init?.body))
      expect(sent).toMatchObject({ ...credential, value: "private-key" })
      expect(JSON.parse(String(h.requests.find(request => request.path === "/api/model/default")!.init?.body))).toEqual({ model: {
        protocol: "openai-chat", modelId: "anthropic/claude-sonnet-4.5", credential: "AI_GATEWAY_API_KEY", baseUrl: "https://ai-gateway.vercel.sh" } })
      expect(h.toasts[0]?.outcome).toBe(true)
    }
  })
  test("saved keys refresh from GET; repeated submissions send one write", async () => {
    const gate = deferred<Response>()
    const h = await harness(path => path === "/api/model/credential" ? gate.promise : Response.json(installFixture()))
    await h.seam.readInstall()
    for (let i = 0; i < 2; i++) h.seam.saveInstallModelKey({ role: "fast", provider: "Cerebras" }, writeOnlyGesture("settings.model-key", { value: "private-key" }))
    await tick()
    expect(h.requests.filter(request => request.path === "/api/model/credential")).toHaveLength(1)
    expect(h.toasts[0]?.outcome).toBeUndefined()
    gate.resolve(Response.json(credentialReceipt("CEREBRAS_API_KEY"))); await h.idle()
    expect(h.requests.map(request => request.path)).toEqual(["/api/install", "/api/model/credential", "/api/install"])
    expect(h.seam.snapshots.get().model?.models[0]?.key).toBe("saved")
    expect(JSON.stringify(h.seam.snapshots.get())).not.toContain("private-key")
    expect(h.toasts[0]?.outcome).toBe(true)
  })
  test("an HTTP-200 negative credential receipt never claims a saved key", async () => {
    const h = await harness(path => path === "/api/model/credential" ? Response.json({ ok: false, failure: { code: "invalid", field: "value" }, fault: "user" }) : Response.json(installFixture()))
    await h.seam.readInstall()
    h.seam.saveInstallModelKey({ role: "coding", provider: "OpenAI" }, writeOnlyGesture("settings.model-key", { value: "private-key" }))
    await h.idle()
    expect(h.toasts[0]?.outcome).toBe("Key refused")
    expect(h.seam.snapshots.get().model?.models[1]?.key).toBe("failed")
  })
  test("reload during a machine build follows its durable step without relaunching", async () => {
    const model = installFixture(); model.steps[6]!.state = "running"; model.steps[6] = { id: "machine", state: "running", pct: 50 }
    const h = await harness(() => Response.json(model))
    h.seam.showSetup(); await tick()
    expect(h.presentations).toEqual(["setup"]); expect(h.toasts[0]?.outcome).toBeUndefined()
    expect(h.requests).toHaveLength(1)
    h.receive(installFixture()); await h.idle()
    expect(h.toasts[0]?.outcome).toBe(true)
    expect(h.requests.some(request => request.init?.method === "POST")).toBe(false)
  })
  test("failed image launches project the typed reason; disposal settles a running toast", async () => {
    const model = installFixture(); model.steps[6]!.state = "pending"
    const h = await harness((_path, init) => init?.method === "POST" ? Response.json({ ...failure("infra"), message: "Image build failed" }, { status: 500 }) : Response.json(model))
    await h.seam.readInstall(); h.seam.setupStep({ step: "machine" }); await h.idle()
    expect(setupCardModel(h.seam.snapshots.get().model!).steps[6]?.error?.message).toBe("Image build failed")
    const running = installFixture(); running.steps[6]!.state = "running"
    model.steps[6]!.state = "running"
    h.receive(running); h.seam.showSetup(); await tick(); h.seam.dispose(); await h.idle()
    expect(h.toasts[1]?.outcome).toBe(false)
  })
  test("different setting writes queue in order while duplicate writes coalesce", async () => {
    const gate = deferred<Response>()
    let puts = 0
    const h = await harness((_path, init) => init?.method === "PUT" && ++puts === 1 ? gate.promise : Response.json(installFixture()))
    await h.seam.readInstall()
    h.seam.setInstallParallel(1); h.seam.setInstallParallel(1); h.seam.setInstallParallel(2); await tick()
    expect(h.requests.filter(request => request.init?.method === "PUT")).toHaveLength(1)
    gate.resolve(Response.json(installFixture())); await h.idle()
    expect(h.requests.filter(request => request.init?.method === "PUT").map(request => JSON.parse(String(request.init?.body)))).toEqual([{ parallel: 1 }, { parallel: 2 }])
  })
  test.each(["invalid-json", "network"])("%s is typed and retains prior data", async kind => {
    let broken = false
    const h = await harness(() => { if (!broken) return Response.json(installFixture()); if (kind === "network") throw new Error("private transport detail"); return new Response("not json") })
    await h.seam.readInstall(); broken = true
    expect((await h.seam.readInstall())?.class).toBe("infra"); expect(h.seam.snapshots.get().model).toEqual(installFixture())
  })
  test("mapping retains every origin and derives HTTP notification restrictions", () => {
    const model = installFixture(); expect(setupCardModel(model).address.origins).toEqual(model.address.origins)
    expect(settingsCardModel(model, "http://mini.local:4000").notifications_need_https).toBe(true)
    for (const origin of ["http://localhost:4000", "http://127.0.0.1:4000", "http://[::1]:4000", "https://mini.local"]) expect(settingsCardModel(model, origin).notifications_need_https).toBe(false)
    expect(InstallModelSchema.safeParse({ ...model, parallel: 8 }).success).toBe(true)
    expect(InstallModelSchema.safeParse({ ...model, capacity: 4 }).success).toBe(false)
    model.address.origins = []
    expect(setupCardModel(model).address.origins).toEqual([])
  })
  test("current card projections retain typed errors, model order and Settings health", () => {
    const model = installFixture()
    model.models.reverse()
    model.steps[0] = { id: "address", state: "failed", error: { code: "refused", class: "never", message: "Unsupported address" } }
    const parsed = InstallModelSchema.parse(model)
    const setup = setupCardModel(parsed)
    expect(setup.steps[0]!.error).toEqual({ class: "never", message: "Unsupported address" })
    expect(setup.models.map(model => model.role)).toEqual(["fast", "coding", "jev"])
    expect(setup.chatgpt).toBe(false)
    expect(setup.this_mac).toEqual(model.this_mac)
    const settings = settingsCardModel(parsed, "http://mini.local:4000")
    expect(settings.health).toEqual(model.health!)
    expect(settings.laptop_lines).toEqual(model.address.origins.map(origin => `smthrs login ${origin}`))
  })
  test("install projections refuse missing, duplicate and reordered setup steps", () => {
    const model = installFixture()
    expect(InstallModelSchema.safeParse({ ...model, steps: model.steps.slice(1) }).success).toBe(false)
    expect(InstallModelSchema.safeParse({ ...model, steps: [...model.steps].reverse() }).success).toBe(false)
    expect(InstallModelSchema.safeParse({ ...model, steps: model.steps.map((step, index) => index === 1 ? model.steps[0] : step) }).success).toBe(false)
    expect(InstallModelSchema.parse(model).steps.map(step => step.id)).toEqual(["address", "app_manifest", "sign_in", "repository", "models", "source", "machine"])
  })
  test("idempotency IDs work without randomUUID", () => {
    expect(installRequestId()).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    expect(installRequestId()).not.toBe(installRequestId())
  })
})


test("accepted setup receipts stay running, deduplicate and settle only from the operation", async () => {
  const gate = deferred<Response>()
  const model = installFixture(); model.steps[6] = { id: "machine", state: "pending" }
  const h = await harness((_path, init) => init?.method === "POST" ? gate.promise : Response.json(model))
  await h.seam.readInstall()
  expect(h.seam.setupStep({ step: "machine" })).toEqual({ value: "Requested" })
  h.seam.setupStep({ step: "machine" }); await tick(); await tick()
  expect(h.requests.filter(row => row.init?.method === "POST")).toHaveLength(1)
  expect(h.seam.snapshots.get().model?.steps[6]?.state).toBe("running")
  expect(h.toasts[0]?.outcome).toBeUndefined()
  gate.resolve(Response.json({ operationId: "operation", requestId: "request", kind: "install.machine", state: "accepted" }, { status: 202 }))
  await tick(); await tick()
  expect(h.seam.snapshots.get().error).toBeUndefined()
  expect(h.toasts[0]?.outcome).toBeUndefined()
  h.receive({ ...model, steps: model.steps.map(step => step.id === "machine" ? { id: "machine", state: "running", pct: 50 } : step) })
  expect(h.toasts[0]?.outcome).toBeUndefined()
  h.receive(installFixture()); await h.idle()
  expect(h.toasts[0]?.outcome).toBe(true)
})

test("the App receipt hands the public manifest to a top-level browser form once", async () => {
  const model = installFixture(); model.steps[1] = { id: "app_manifest", state: "pending" }; model.steps[2] = { id: "sign_in", state: "pending" }
  const handoffs: unknown[] = []
  const receipt = { action_url: "https://github.com/settings/apps/new?state=state", manifest: { name: "Smithers", redirect_url: "http://localhost:4000/setup/github/callback" }, state: "state" }
  const h = await harness((_path, init) => Response.json(init?.method === "POST" ? receipt : model), { handoff: value => { handoffs.push(value) } })
  await h.seam.readInstall(); h.seam.setupStep({ step: "app_manifest", owner: "acme" }); h.seam.setupStep({ step: "app_manifest", owner: "acme" })
  await tick(); await tick()
  expect(handoffs).toEqual([receipt]); expect(h.seam.snapshots.get().error).toBeUndefined()
  expect(h.seam.snapshots.get().model?.steps[1]?.state).toBe("running")
  h.seam.dispose(); await h.idle()
})


test("reload of an unresolved launch follows the running operation without another POST", async () => {
  const storage = memoryStorage(), gate = deferred<Response>()
  const model = installFixture(); model.steps[6] = { id: "machine", state: "pending" }
  const first = await harness((_path, init) => init?.method === "POST" ? gate.promise : Response.json(model), {}, storage)
  await first.seam.readInstall(); first.seam.setupStep({ step: "machine" }); await tick(); await tick()
  const id = first.store.session().installRequests?.[0]?.id
  expect(id).toBeString(); expect(first.store.session().installRequests?.[0]?.state).toBe("requested")
  first.seam.dispose(); await first.store.settled?.()
  model.steps[6] = { id: "machine", state: "running", pct: 30 }
  const second = await harness(() => Response.json(model), {}, storage)
  second.seam.showSetup(); await tick(); await tick()
  expect(second.store.session().installRequests?.[0]?.id).toBe(id)
  expect(second.requests.filter(row => row.init?.method === "POST")).toHaveLength(0)
  expect(second.toasts[0]?.outcome).toBeUndefined()
  gate.resolve(Response.json({ operationId: "operation", requestId: id, kind: "install.machine", state: "accepted" }, { status: 202 }))
  await first.idle()
  second.receive(installFixture()); await second.idle()
  expect(second.toasts[0]?.outcome).toBe(true)
  expect(second.store.session().installRequests?.[0]?.state).toBe("completed")
})

test("a receipt followed by operation failure stays retryable with its real reason", async () => {
  const model = installFixture(); model.steps[6] = { id: "machine", state: "pending" }
  const h = await harness((_path, init) => Response.json(init?.method === "POST" ? { operationId: "operation", requestId: "request", kind: "install.machine", state: "accepted" } : model))
  await h.seam.readInstall(); h.seam.setupStep({ step: "machine" }); await tick(); await tick()
  h.receive({ ...model, steps: model.steps.map(step => step.id === "machine" ? { id: "machine", state: "failed", error: failure() } : step) })
  await h.idle()
  expect(h.toasts[0]?.outcome).toBe("Address refused")
  expect(h.store.session().installRequests?.[0]?.state).toBe("failed")
  expect(h.seam.setupStep({ step: "machine" })).toEqual({ value: "Requested" })
  await tick(); await tick(); h.receive(installFixture()); await h.idle()
  expect(h.requests.filter(row => row.init?.method === "POST")).toHaveLength(2)
  expect(h.toasts[1]?.outcome).toBe(true)
})

test("a late launch refusal cannot overwrite newer operation completion", async () => {
  const gate = deferred<Response>(), model = installFixture(); model.steps[6] = { id: "machine", state: "pending" }
  const h = await harness((_path, init) => init?.method === "POST" ? gate.promise : Response.json(model))
  await h.seam.readInstall(); h.seam.setupStep({ step: "machine" }); await tick(); await tick()
  h.receive(installFixture()); gate.resolve(Response.json(failure(), { status: 400 })); await h.idle()
  expect(h.seam.snapshots.get().model?.steps[6]?.state).toBe("done")
  expect(h.seam.snapshots.get().error).toBeUndefined()
  expect(h.toasts[0]?.outcome).toBe(true)
})

test("setup address crosses real HTTP and polls its operation instead of completing at acceptance", async () => {
  const gate = deferred<Response>()
  const model = installFixture(); model.github.signed_in = false; model.steps[0] = { id: "address", state: "pending" }
  let writes = 0, posted: unknown
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async request => {
    if (request.method === "POST") { writes++; posted = await request.json(); model.steps[0] = { id: "address", state: "running" }; return gate.promise }
    return Response.json(model)
  } })
  const h = await harness((path, init) => fetch(new URL(path, server.url), init))
  try {
    await h.seam.readInstall()
    expect(h.seam.setupStep({ step: "address", bind: "127.0.0.1:4000", origins: ["http://localhost:4000"] })).toEqual({ value: "Requested" })
    h.seam.setupStep({ step: "address", bind: "127.0.0.1:4000", origins: ["http://localhost:4000"] })
    for (let n = 0; n < 50 && !writes; n++) await tick()
    expect(writes).toBe(1); expect(posted).toEqual({ bind: "127.0.0.1:4000", origins: ["http://localhost:4000"] })
    expect(h.toasts[0]?.outcome).toBeUndefined()
    gate.resolve(Response.json({ operationId: "op-address", requestId: "request-address", kind: "install.address", state: "accepted" }, { status: 202 }))
    await tick(); await tick()
    expect(h.toasts[0]?.outcome).toBeUndefined()
    expect(h.seam.snapshots.get().model?.steps[0]?.state).toBe("running")
    model.steps[0] = { id: "address", state: "done" }
    await h.idle()
    expect(h.toasts[0]?.outcome).toBe(true)
    expect(h.seam.snapshots.get().model?.steps[0]?.state).toBe("done")
    expect(h.requests.filter(row => row.init?.method !== "POST").length).toBeGreaterThan(1)
  } finally { h.seam.dispose(); server.stop(true) }
})

/* The App step's browser handoff (#3455): GitHub's manifest form POST leaves the app, so it runs only on a person's press. */
const until = async (ready: () => boolean) => { for (let n = 0; n < 100 && !ready(); n++) await tick() }
const appReceipt = (state = "state") => ({ action_url: `https://github.com/settings/apps/new?state=${state}`,
  manifest: { name: "Smithers", redirect_url: "http://localhost:4000/setup/github/callback" }, state })
const appModel = (app: "pending" | "running" | "done" | "failed") => {
  const model = installFixture(); model.github = { signed_in: false, app_installed: false }
  model.steps[1] = { id: "app_manifest", state: app }; model.steps[2] = { id: "sign_in", state: "pending" }
  return model
}
type Row = NonNullable<ReturnType<Awaited<ReturnType<typeof harness>>["store"]["session"]>["installRequests"]>[number]
const persist = async (storage: StorageApi, ...rows: Row[]) => {
  const seed = await harness(() => Response.json(appModel("running")), {}, storage)
  await seed.store.dispatch({ type: "install.requests.changed", actor: "user", requests: rows }).isPersisted.promise
  seed.seam.dispose(); await seed.store.settled?.()
}
const appRow = (state: Row["state"], expires: number): Row => ({ id: "earlier", origin: "", step: "app_manifest", body: { owner: "acme" }, state,
  ...(state === "running" ? { handoff: appReceipt("earlier") } : {}), expires_at: new Date(expires).toISOString() })
/* The person presses Create GitHub App once on a first page, which hands off and leaves its request persisted. */
const pressedOnce = async (storage: StorageApi, receipt = appReceipt("earlier")) => {
  const first = await harness((_path, init) => Response.json(init?.method === "POST" ? receipt : appModel("pending")), { handoff: () => {} }, storage)
  await first.seam.readInstall(); first.seam.setupStep({ step: "app_manifest", owner: "acme" })
  await until(() => first.store.session().installRequests?.[0]?.handoff !== undefined)
  expect(first.store.session().installRequests?.[0]).toMatchObject({ state: "running", handoff: receipt })
  first.seam.dispose(); await first.store.settled?.()
}

test("a reload while the App step runs restores it without leaving the page; each press continues to GitHub once", async () => {
  const storage = memoryStorage()
  await pressedOnce(storage)
  for (const load of [1, 2]) {
    const handoffs: unknown[] = []
    const h = await harness(() => Response.json(appModel("running")), { handoff: value => { handoffs.push(value) } }, storage)
    h.seam.showSetup(); await until(() => h.presentations.length > 0); await tick(); await tick()
    expect(handoffs).toEqual([])
    expect(h.seam.snapshots.get().model?.steps[1]?.state).toBe("running")
    expect(h.seam.snapshots.get().model?.github.owner).toBe("acme")
    expect(h.seam.setupStep({ step: "app_manifest", owner: "acme" })).toEqual({ value: "Requested" })
    expect(handoffs).toEqual([appReceipt("earlier")])
    if (load === 2) { h.seam.setupStep({ step: "app_manifest", owner: "acme" }); expect(handoffs).toHaveLength(2) }
    expect(h.requests.filter(row => row.init?.method === "POST")).toHaveLength(0)
    h.seam.dispose(); await h.store.settled?.()
  }
})

test("a lapsed App lease the install still serves as running is retryable; a press starts one new request, never the stale handoff", async () => {
  const storage = memoryStorage(), start = Date.parse("2026-10-04T12:00:00Z"), gate = deferred<Response>()
  try {
    setSystemTime(new Date(start))
    await pressedOnce(storage)
    setSystemTime(new Date(start + 11 * 60_000))
    const handoffs: unknown[] = []
    const h = await harness((_path, init) => init?.method === "POST" ? gate.promise : Response.json(appModel("running")), { handoff: value => { handoffs.push(value) } }, storage)
    h.seam.showSetup(); await h.idle()
    expect(handoffs).toEqual([])
    expect(h.seam.snapshots.get().model?.steps[1]?.state).toBe("failed")
    expect(h.store.session().installRequests?.map(row => row.state)).toEqual(["failed"])
    expect(h.seam.setupStep({ step: "app_manifest", owner: "acme" })).toEqual({ value: "Requested" })
    expect(h.seam.setupStep({ step: "app_manifest", owner: "acme" })).toEqual({ value: "Requested" })
    await until(() => h.requests.some(row => row.init?.method === "POST")); await tick(); await tick()
    expect(h.requests.filter(row => row.init?.method === "POST").map(row => [row.path, JSON.parse(String(row.init!.body))]))
      .toEqual([["/api/install/setup/app", { owner: "acme" }]])
    expect(handoffs).toEqual([])
    gate.resolve(Response.json(appReceipt("fresh"))); await until(() => handoffs.length > 0)
    expect(handoffs).toEqual([appReceipt("fresh")])
    expect(h.seam.snapshots.get().model?.steps[1]?.state).toBe("running")
    h.seam.dispose(); await h.idle()
  } finally { setSystemTime() }
})

test("a served failed App step is retryable even while its persisted handoff is inside the lease", async () => {
  const storage = memoryStorage()
  await persist(storage, appRow("running", Date.now() + 60_000))
  const handoffs: unknown[] = []
  const h = await harness((_path, init) => Response.json(init?.method === "POST" ? appReceipt("fresh") : appModel("failed")), { handoff: value => { handoffs.push(value) } }, storage)
  h.seam.showSetup(); await h.idle()
  expect(handoffs).toEqual([])
  expect(h.store.session().installRequests?.find(row => row.id === "earlier")?.state).toBe("failed")
  h.seam.setupStep({ step: "app_manifest", owner: "acme" }); await until(() => handoffs.length > 0)
  expect(handoffs).toEqual([appReceipt("fresh")])
  expect(h.requests.filter(row => row.init?.method === "POST")).toHaveLength(1)
  h.seam.dispose(); await h.idle()
})

test("a persisted request whose step is no longer running on the install is dropped, not replayed", async () => {
  for (const state of ["requested", "running"] as const) {
    const storage = memoryStorage()
    await persist(storage, appRow(state, Date.now() + 60_000), { id: "machine", origin: "", step: "machine", body: {}, state: "running" })
    const model = appModel("pending"); model.steps[6] = { id: "machine", state: "pending" }
    const handoffs: unknown[] = []
    const h = await harness((_path, init) => Response.json(init?.method === "POST" ? appReceipt("fresh") : model), { handoff: value => { handoffs.push(value) } }, storage)
    h.seam.showSetup(); await until(() => h.store.session().installRequests?.every(row => row.state === "failed") === true); await tick(); await tick()
    expect(h.store.session().installRequests?.map(row => [row.id, row.state])).toEqual([["earlier", "failed"], ["machine", "failed"]])
    expect(h.requests.filter(row => row.init?.method === "POST")).toHaveLength(0)
    expect(handoffs).toEqual([])
    expect(h.seam.snapshots.get().model?.steps.map(step => step.state)).toEqual(["done", "pending", "pending", "done", "done", "done", "pending"])
    h.seam.dispose(); await h.idle()
  }
})

test("a live App lease asked for another owner starts a new request instead of continuing the old one", async () => {
  const storage = memoryStorage()
  await persist(storage, appRow("running", Date.now() + 60_000))
  const handoffs: unknown[] = []
  const h = await harness((_path, init) => init?.method === "POST"
    ? Response.json({ code: "conflict", class: "conflict", message: "GitHub App setup is already running or complete" }, { status: 409 })
    : Response.json(appModel("running")), { handoff: value => { handoffs.push(value) } }, storage)
  h.seam.showSetup(); await until(() => h.presentations.length > 0); await tick()
  h.seam.setupStep({ step: "app_manifest", owner: "other" })
  await until(() => h.seam.snapshots.get().model?.steps[1]?.state === "failed")
  expect(handoffs).toEqual([])
  expect(h.requests.filter(row => row.init?.method === "POST").map(row => JSON.parse(String(row.init!.body)))).toEqual([{ owner: "other" }])
  expect(h.seam.snapshots.get().model?.steps[1]?.error?.message).toBe("GitHub App setup is already running or complete")
  h.seam.setupStep({ step: "app_manifest", owner: "acme" })
  expect(handoffs).toEqual([appReceipt("earlier")])
  h.seam.dispose(); await h.idle()
})

test("the return from GitHub completes the App step from the install and hands off nothing", async () => {
  const storage = memoryStorage()
  await persist(storage, appRow("running", Date.now() + 60_000))
  const handoffs: unknown[] = []
  const h = await harness(() => Response.json(appModel("done")), { handoff: value => { handoffs.push(value) } }, storage)
  h.seam.showSetup(); await h.idle()
  expect(handoffs).toEqual([])
  expect(h.store.session().installRequests?.find(row => row.id === "earlier")?.state).toBe("completed")
  expect(h.seam.snapshots.get().model?.steps.slice(1, 3).map(step => step.state)).toEqual(["done", "pending"])
  expect(h.toasts[0]?.outcome).toBe(true)
})

test("an App receipt that arrives after the step completed elsewhere never leaves the page", async () => {
  const gate = deferred<Response>(), handoffs: unknown[] = []
  let served = appModel("pending")
  const h = await harness((_path, init) => init?.method === "POST" ? gate.promise : Response.json(served), { handoff: value => { handoffs.push(value) } })
  await h.seam.readInstall(); h.seam.setupStep({ step: "app_manifest", owner: "acme" })
  await until(() => h.requests.some(row => row.init?.method === "POST"))
  served = appModel("done"); await h.seam.readInstall()
  gate.resolve(Response.json(appReceipt())); await h.idle()
  expect(handoffs).toEqual([])
  expect(h.seam.snapshots.get().model?.steps[1]?.state).toBe("done")
})

test("the card lists the repository installed on GitHub without a reload, then stops reading (J1 2.3)", async () => {
  const blocked = installFixture()
  delete blocked.repository; blocked.repositories = []; blocked.github.app_installed = false
  blocked.steps = blocked.steps.map(step => step.id === "repository" ? { id: step.id, state: "blocked", blocked: { line: "Install the GitHub App", fix_url: "https://github.com/apps/smithers-1234/installations/new" } }
    : ["models", "source", "machine"].includes(step.id) ? { id: step.id, state: "pending" } : step)
  const installed = { ...blocked, github: { ...blocked.github, app_installed: true }, repositories: ["smithersai/smithers"],
    steps: blocked.steps.map(step => step.id === "repository" ? { id: step.id, state: "pending" as const } : step) }
  let served = blocked
  const h = await harness(() => Response.json(served), { installPollMs: 5 })
  await h.seam.readInstall()
  await Bun.sleep(40)
  const waiting = h.requests.length
  expect(waiting).toBeGreaterThan(2)
  expect(h.seam.snapshots.get().model?.repositories).toEqual([])
  // GitHub returned the person in another tab; this card reads the install on its own.
  served = installed
  await Bun.sleep(40)
  expect(h.seam.snapshots.get().model?.repositories).toEqual(["smithersai/smithers"])
  expect(h.seam.snapshots.get().model?.steps.find(step => step.id === "repository")?.state).toBe("pending")
  const settled = h.requests.length
  await Bun.sleep(40)
  expect(h.requests.length).toBe(settled)
  expect(h.requests.every(request => request.path === "/api/install")).toBe(true)
  h.seam.dispose()
})

test("a blocked repository step stops reading the install on dispose", async () => {
  const blocked = installFixture()
  delete blocked.repository; blocked.repositories = []
  blocked.steps = blocked.steps.map(step => step.id === "repository" ? { id: step.id, state: "blocked", blocked: { line: "Install the GitHub App", fix_url: "https://github.com/apps/smithers-1234/installations/new" } } : step)
  const h = await harness(() => Response.json(blocked), { installPollMs: 5 })
  await h.seam.readInstall()
  h.seam.dispose()
  const count = h.requests.length
  await Bun.sleep(30)
  expect(h.requests.length).toBe(count)
})

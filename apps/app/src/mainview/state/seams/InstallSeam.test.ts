import { describe, expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import type { StorageApi } from "@tanstack/db"
import type { SeamContext } from "./SeamContext"
import type { FailureController } from "../controller/failures"
import { createInstallSeam, type InstallTopic } from "./InstallSeam"
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
const harness = async (answer: (path: string, init?: RequestInit) => Promise<Response> | Response) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
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
  const seam = createInstallSeam(ctx, withToast, { topic, present: kind => { presentations.push(kind) } })
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
    for (const n of [-1, 2.5, NaN, Infinity, 3]) expect(typeof h.seam.setInstallParallel(n)).toBe("string")
    expect(h.requests).toHaveLength(1)
    h.seam.setInstallCapacity(3); await h.idle()
    expect(JSON.parse(String(h.requests[1]?.init?.body))).toEqual({ capacity: 3 })
    h.seam.setInstallParallel(0); await h.idle()
    expect(JSON.parse(String(h.requests[2]?.init?.body))).toEqual({ parallel: 0 })
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
    expect(InstallModelSchema.safeParse({ ...model, parallel: 4 }).success).toBe(false)
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
  test("idempotency IDs work without randomUUID", () => {
    expect(installRequestId()).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    expect(installRequestId()).not.toBe(installRequestId())
  })
})

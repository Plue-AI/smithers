import { afterEach, expect, test } from "bun:test"
import { createAppStore, type AppStore } from "../AppStore"
import { memoryStorage } from "../TestFixtures"
import { createSecretsSeam } from "./SecretsSeam"
import { writeOnlyGesture } from "../../flows/CommandGesture"
import type { SeamContext } from "./SeamContext"

const pending = new Set<Promise<unknown>>()
const retirements = new Set<() => void>()
const releases = new Set<() => void>()
const stores = new Set<AppStore>()
const unexpected: string[] = []
const track = <T>(task: Promise<T>): Promise<T> => {
  pending.add(task)
  void task.then(() => pending.delete(task), () => pending.delete(task))
  return task
}
const trackResponse = (response: Response): Response => {
  const json = response.json.bind(response)
  const clone = response.clone.bind(response)
  response.json = () => track(json())
  response.clone = () => trackResponse(clone())
  return response
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const drain = async () => {
  do {
    await Promise.allSettled([...pending])
    await tick()
  } while (pending.size > 0)
}
const bounded = async (task: Promise<unknown>) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Provider fixture work did not settle")), 3000)
    })])
  } finally { clearTimeout(timer) }
}
afterEach(async () => {
  const failures: unknown[] = []
  for (const retire of retirements) { try { retire() } catch (error) { failures.push(error) } }
  retirements.clear()
  for (const release of releases) { try { release() } catch (error) { failures.push(error) } }
  releases.clear()
  try { await bounded(drain()) } catch (error) { failures.push(error) }
  for (const store of stores) {
    try {
      if (!store.dispose) throw new Error("Provider store disposal is required")
      await store.dispose()
    } catch (error) { failures.push(error) }
  }
  stores.clear()
  if (unexpected.length) failures.push(new Error(`Unexpected provider HTTP: ${unexpected.join(", ")}`))
  unexpected.length = 0
  if (failures.length) throw new AggregateError(failures, "Provider fixture cleanup failed")
})

const active = { id: "current", provider: "claude", label: "Current account", state: "active", account_email: "current@example.test" }
const fixture = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  stores.add(store)
  let disposed = false
  retirements.add(() => { disposed = true })
  const login = async (name: string) => { await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: name, admin: false, scopesPlain: null }).isPersisted.promise }
  await login("alice")
  let fetch = async (): Promise<Response> => Response.json([active])
  const work: Promise<unknown>[] = []
  const ctx: SeamContext = { store, dispatch: event => { const tx = store.dispatch(event); track(tx.isPersisted.promise); return tx }, nextOrdinal: store.nextOrdinal, baseUrl: "https://app.test", actor: () => "user", isDisposed: () => disposed,
    http: (url, init) => { const read = fetch; return track(Promise.resolve().then(async () => {
      const method = init?.method ?? "GET"
      if ((url !== "https://app.test/api/user/provider-connections" || method !== "GET") &&
        (url !== "https://app.test/api/user/provider-connections/current" || method !== "DELETE") &&
        (url !== "https://app.test/api/user/provider-connections" || method !== "POST") &&
        (url !== "https://app.test/api/user/provider-connections/codex/device" || method !== "POST")) {
        unexpected.push(`${method} ${url}`)
        throw new Error("Unexpected provider request")
      }
      const response = await read()
      return trackResponse(response)
    })) }, withToast: (_key, _title, _done, task) => { const job = track(task()); work.push(job); return job } }
  const real = createSecretsSeam(ctx, ctx.withToast!)
  const seam = { ...real, listCodingProviders: () => track(real.listCodingProviders()),
    connectCodingProvider: (...args: Parameters<typeof real.connectCodingProvider>) => track(real.connectCodingProvider(...args)),
    connectCodex: () => track(real.connectCodex()), revokeCodingProvider: (id: string) => track(real.revokeCodingProvider(id)) }
  return { store, seam, work, login, retire: () => { disposed = true }, setFetch: (read: typeof fetch) => { fetch = read },
    card: () => store.collections.cards.get("provider-accounts") }
}
const delayedGate = () => {
  const parsed = Promise.withResolvers<void>()
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const response = new Response(new ReadableStream<Uint8Array>({ start: controller => { stream = controller } }), { status: 403 })
  const clone = response.clone.bind(response)
  response.clone = () => {
    parsed.resolve()
    const copy = clone()
    const json = copy.json.bind(copy)
    copy.json = () => track(json())
    return copy
  }
  let released = false
  const release = () => { if (released) return; released = true; stream.enqueue(new TextEncoder().encode('{"message":"feature not available"}')); stream.close() }
  releases.add(release)
  return { response, parsed: parsed.promise, release }
}
const heldResponse = () => {
  const gate = Promise.withResolvers<Response>()
  void gate.promise.catch(() => {})
  releases.add(() => gate.reject(new Error("Provider fixture retired")))
  return gate
}
for (const action of ["list", "claude", "codex"] as const) for (const retirement of ["account", "dispose"] as const) {
  test(`${action} delayed gate cannot withdraw a card after ${retirement}`, async () => {
    const t = await fixture()
    await t.seam.listCodingProviders()
    const gate = delayedGate()
    t.setFetch(async () => gate.response)
    const pending = action === "list" ? t.seam.listCodingProviders() : action === "claude"
      ? t.seam.connectCodingProvider(writeOnlyGesture("secrets.connect", { value: "sk-ant-api03-owned-fixture" })) : t.seam.connectCodex()
    await gate.parsed
    if (retirement === "account") {
      await t.login("bob")
      t.setFetch(async () => Response.json([{ ...active, id: "bob", label: "Bob" }]))
      await t.seam.listCodingProviders()
    } else t.retire()
    const before = t.card()
    gate.release()
    try { await pending; await Promise.all(t.work); expect(t.card()).toEqual(before) }
    finally { t.retire() }
  })
}

test("an older gated list cannot replace a newer available pool", async () => {
  const t = await fixture(), gate = delayedGate()
  t.setFetch(async () => gate.response)
  const old = t.seam.listCodingProviders()
  await gate.parsed
  t.setFetch(async () => Response.json([active]))
  await t.seam.listCodingProviders()
  const current = t.card()
  gate.release()
  try { expect(await old).toEqual({ value: "" }); expect(t.card()).toEqual(current) }
  finally { t.retire() }
})

test("an older available list cannot reopen a newer gated pool", async () => {
  const t = await fixture(), held = heldResponse()
  t.setFetch(() => held.promise)
  const old = t.seam.listCodingProviders()
  t.setFetch(async () => Response.json({ message: "feature not available" }, { status: 403 }))
  await t.seam.listCodingProviders()
  const current = t.card()
  held.resolve(Response.json([active]))
  try { expect(await old).toEqual({ value: "" }); expect(t.card()).toEqual(current) }
  finally { t.retire() }
})

const backgroundRefresh = async (t: Awaited<ReturnType<typeof fixture>>, response: Promise<Response>) => {
  let calls = 0
  const started = Promise.withResolvers<void>()
  t.setFetch(async () => {
    if (++calls === 1) return new Response(null, { status: 204 })
    started.resolve()
    return response
  })
  expect(await t.seam.revokeCodingProvider(active.id)).toEqual({ value: "Requested" })
  await started.promise
  await Promise.all(t.work)
}
for (const outcome of ["available", "http-error", "network-error", "malformed"] as const) {
  test(`an older ${outcome} background refresh cannot reopen a newer gated pool`, async () => {
    const t = await fixture(), held = heldResponse()
    await t.seam.listCodingProviders()
    await backgroundRefresh(t, held.promise)
    t.setFetch(async () => Response.json({ message: "feature not available" }, { status: 403 }))
    await t.seam.listCodingProviders()
    const current = t.card()
    try {
      if (outcome === "network-error") held.reject(new Error("offline"))
      else held.resolve(outcome === "available" ? Response.json([active]) : outcome === "http-error" ? new Response(null, { status: 503 }) : Response.json({ invalid: true }))
      await drain()
      expect(t.card()).toEqual(current)
    } finally { t.retire() }
  })
}

test("a background feature gate withdraws the pool and a newer successful refresh restores it", async () => {
  const t = await fixture()
  try {
    await t.seam.listCodingProviders()
    await backgroundRefresh(t, Promise.resolve(Response.json({ message: "feature not available" }, { status: 403 })))
    await drain()
    expect(t.card()?.payload).toEqual({ accounts: [], unavailable: true })
    await backgroundRefresh(t, Promise.resolve(Response.json([active])))
    await drain()
    expect(t.card()?.payload).toMatchObject({ accounts: [{ id: active.id }] })
    expect(t.card()?.payload).not.toHaveProperty("unavailable")
  } finally { t.retire() }
})

test("an older background feature gate cannot withdraw a newer available pool", async () => {
  const t = await fixture(), gate = delayedGate()
  try {
    await t.seam.listCodingProviders()
    await backgroundRefresh(t, Promise.resolve(gate.response))
    await gate.parsed
    t.setFetch(async () => Response.json([active]))
    await t.seam.listCodingProviders()
    const current = t.card()
    gate.release()
    await drain()
    expect(t.card()).toEqual(current)
  } finally { t.retire() }
})

test("failed background reads retain the last available accounts", async () => {
  const t = await fixture()
  try {
    await t.seam.listCodingProviders()
    const current = t.card()
    for (const result of ["http-error", "network-error", "malformed"] as const) {
      const held = heldResponse()
      await backgroundRefresh(t, held.promise)
      if (result === "network-error") held.reject(new Error("offline"))
      else held.resolve(result === "http-error" ? new Response(null, { status: 503 }) : Response.json({ invalid: true }))
      await drain()
      expect(t.card()).toEqual(current)
    }
  } finally { t.retire() }
})

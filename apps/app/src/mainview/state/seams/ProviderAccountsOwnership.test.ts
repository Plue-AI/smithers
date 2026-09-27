import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { memoryStorage } from "../TestFixtures"
import { createSecretsSeam } from "./SecretsSeam"
import { writeOnlyGesture } from "../../flows/CommandGesture"
import type { SeamContext } from "./SeamContext"

const active = { id: "current", provider: "claude", label: "Current account", state: "active", account_email: "current@example.test" }
const fixture = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const login = async (name: string) => { await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: name, allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise }
  await login("alice")
  let disposed = false
  let fetch = async (): Promise<Response> => Response.json([active])
  const work: Promise<unknown>[] = []
  const ctx: SeamContext = { store, dispatch: store.dispatch, nextOrdinal: store.nextOrdinal, baseUrl: "https://app.test", actor: () => "user", isDisposed: () => disposed,
    http: () => fetch(), withToast: async (_key, _title, _done, task) => { const job = task(); work.push(job); return job } }
  const seam = createSecretsSeam(ctx, ctx.withToast!)
  return { store, seam, work, login, retire: () => { disposed = true }, setFetch: (read: typeof fetch) => { fetch = read },
    card: () => store.collections.cards.get("provider-accounts"), dispose: async () => { disposed = true; await Promise.all(work); await store.dispose?.() } }
}
const delayedGate = () => {
  const parsed = Promise.withResolvers<void>()
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const response = new Response(new ReadableStream<Uint8Array>({ start: controller => { stream = controller } }), { status: 403 })
  const clone = response.clone.bind(response)
  response.clone = () => { parsed.resolve(); return clone() }
  return { response, parsed: parsed.promise, release: () => { stream.enqueue(new TextEncoder().encode('{"message":"feature not available"}')); stream.close() } }
}
for (const action of ["list", "claude", "codex"] as const) for (const retirement of ["account", "dispose"] as const) {
  test(`${action} delayed gate cannot withdraw a card after ${retirement}`, async () => {
    const t = await fixture()
    await t.seam.listCodingProviders()
    const gate = delayedGate()
    t.setFetch(async () => gate.response)
    const pending = action === "list" ? t.seam.listCodingProviders() : action === "claude"
      ? t.seam.connectCodingProvider(writeOnlyGesture("secrets.connect", { value: "sk-ant-oat01-owned-fixture" })) : t.seam.connectCodex()
    await gate.parsed
    if (retirement === "account") {
      await t.login("bob")
      t.setFetch(async () => Response.json([{ ...active, id: "bob", label: "Bob" }]))
      await t.seam.listCodingProviders()
    } else t.retire()
    const before = t.card()
    gate.release()
    try { await pending; await Promise.all(t.work); expect(t.card()).toEqual(before) }
    finally { await t.dispose() }
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
  finally { await t.dispose() }
})

test("an older available list cannot reopen a newer gated pool", async () => {
  const t = await fixture(), held = Promise.withResolvers<Response>()
  t.setFetch(() => held.promise)
  const old = t.seam.listCodingProviders()
  t.setFetch(async () => Response.json({ message: "feature not available" }, { status: 403 }))
  await t.seam.listCodingProviders()
  const current = t.card()
  held.resolve(Response.json([active]))
  try { expect(await old).toEqual({ value: "" }); expect(t.card()).toEqual(current) }
  finally { await t.dispose() }
})

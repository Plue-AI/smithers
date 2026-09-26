import { afterEach, expect, test } from "bun:test"
import { createActorBindings } from "../ActorBindings"
import { createAppStore, type AppStore } from "../AppStore"
import type { Card } from "../AppState"
import type { CloudLspClient, CloudLspEvent } from "../CloudLspClient"
import { createCodeIntelSeam, type CodeIntelSeam, type CodeIntelSeamOptions } from "./CodeIntelSeam"
import { SIGN_OUT_REFUSAL } from "./CloudSignIn"

const stores: AppStore[] = [], seams: CodeIntelSeam[] = []
afterEach(async () => { for (const seam of seams.splice(0)) seam.dispose(); for (const store of stores.splice(0)) await store.dispose?.() })
const identity = (login: string | null, provider: "github" | "local" = "github") => ({ type: "identity.session.loaded" as const, actor: "system" as const,
  state: login === null ? "signed-out" as const : "signed-in" as const, login, provider, allowlisted: login !== null, admin: false, scopesPlain: null })
const cloud = (username: string | null) => ({ type: "cloud.session.loaded" as const, actor: "system" as const,
  state: username === null ? "signed-out" as const : "signed-in" as const, username, expiresAt: null, scopes: null })
const card: Extract<Card, { kind: "file" }> = { id: "file-owner/repo-index.ts", kind: "file", title: "File", status: "active", ordinal: 1, createdAt: 1,
  payload: { repo: "owner/repo", path: "index.ts", content: "const value = 1", truncated: false } }
const reopenFile = async (store: AppStore) => {
  await store.dispatch({ type: "workspace.updated", actor: "system", workspace: { id: "ws-lsp", repoId: "owner/repo", name: "LSP", status: "running", targetBookmark: null, provisioningStage: null, suspendedAt: null, createdAt: null } }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "user", card }).isPersisted.promise
}
const diagnostic = { line: 1, character: 1, endLine: 1, endCharacter: 2, severity: "error" as const, message: "Previous account private diagnostic" }
const event = (type: "diagnostics" | "waiting" | "closed"): CloudLspEvent => {
  const scope = { repo: "owner/repo", workspaceId: "ws-lsp", language: "typescript" as const }
  if (type === "diagnostics") return { ...scope, type, path: "index.ts", content: card.payload.content, total: 1, items: [diagnostic] }
  if (type === "waiting") return { ...scope, type, paths: ["index.ts"], note: "Previous account private failure" }
  return { ...scope, type, paths: ["index.ts"], code: 1008, reason: "Previous account private close" }
}
const setup = async (options: { readFile?: CodeIntelSeamOptions["readFile"]; missingFile?: boolean; startingAfterMs?: number } = {}) => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } } }, { seedWiki: false })
  stores.push(store)
  await store.dispatch(identity("first")).isPersisted.promise
  await store.dispatch(cloud("first")).isPersisted.promise
  await reopenFile(store)
  if (options.missingFile) await store.dispatch({ type: "card.removed", actor: "user", id: card.id }).isPersisted.promise
  const clients: Array<{ client: CloudLspClient; publish(event: CloudLspEvent): void; disposals: number; unsubscribes: number }> = []
  const calls = { hover: 0, definition: 0, diagnostics: 0, readFile: 0 }
  const answers = {
    hover: async (): ReturnType<CloudLspClient["hover"]> => ({ ok: { hover: null } }),
    definition: async (): ReturnType<CloudLspClient["definition"]> => ({ ok: { locations: [], total: 0, omitted: 0 } }),
    diagnostics: async (): ReturnType<CloudLspClient["diagnostics"]> => ({ ok: { items: null, total: null } })
  }
  let disposed = false
  const ctx = { store, baseUrl: "", actor: () => "user" as const, nextOrdinal: () => 1, dispatch: store.dispatch,
    isDisposed: () => disposed, http: async () => { throw new Error("Unexpected HTTP") } }
  const seamOptions: CodeIntelSeamOptions = {
    startingAfterMs: options.startingAfterMs ?? 60_000,
    readFile: async (...args) => { calls.readFile++; return options.readFile?.(...args) },
    createCloudLsp: () => {
      let publish: ((event: CloudLspEvent) => void) | undefined
      const entry = { disposals: 0, unsubscribes: 0, publish: (value: CloudLspEvent) => publish!(value), client: {
        hover: async () => { calls.hover++; return answers.hover() }, definition: async () => { calls.definition++; return answers.definition() },
        diagnostics: async () => { calls.diagnostics++; return answers.diagnostics() },
        // Retain the callback deliberately: an already queued publication must also be fenced.
        subscribe: (listener: (event: CloudLspEvent) => void) => { publish = listener; return () => { entry.unsubscribes++ } },
        dispose: () => { entry.disposals++ }
      } }
      clients.push(entry)
      return entry.client
    }
  }
  const bindings = createActorBindings(finalizer => seams.push({ ...seam, dispose: finalizer }))
  const seam = bindings.pair(ctx, context => createCodeIntelSeam(context, seamOptions))
  seams.push(seam)
  const untilCalled = async (method: keyof typeof calls, count = 1) => {
    for (let i = 0; i < 100 && calls[method] < count; i++) await new Promise(resolve => setTimeout(resolve, 1))
    expect(calls[method]).toBe(count)
  }
  return { store, seam, agent: () => bindings.select(seam), answers, calls, clients, untilCalled, disposeContext: () => { disposed = true; seam.dispose() } }
}
const changes = ["account", "identity-sign-out", "identity-ABA", "provider", "cloud-account", "cloud-ABA", "dispose"] as const
type Fixture = Awaited<ReturnType<typeof setup>>
const retire = async (fixture: Fixture, change: typeof changes[number]) => {
  const { store } = fixture
  if (change === "account") await store.dispatch(identity("second")).isPersisted.promise
  if (change === "identity-sign-out") await store.dispatch(identity(null)).isPersisted.promise
  if (change === "identity-ABA") { await store.dispatch(identity(null)).isPersisted.promise; await store.dispatch(identity("first")).isPersisted.promise }
  if (change === "provider") await store.dispatch(identity("first", "local")).isPersisted.promise
  if (change === "cloud-account") await store.dispatch(cloud("second")).isPersisted.promise
  if (change === "cloud-ABA") { await store.dispatch(cloud(null)).isPersisted.promise; await store.dispatch(cloud("first")).isPersisted.promise }
  if (change === "dispose") fixture.disposeContext()
  await reopenFile(store)
}

for (const method of ["hover", "definition", "diagnostics"] as const) {
  test.each([...changes])(`late ${method} cannot annotate or answer for a retired owner: %s`, async change => {
    const fixture = await setup(), { store, seam, answers, clients, untilCalled } = fixture
    const reply = Promise.withResolvers<Awaited<ReturnType<CloudLspClient[typeof method]>>>()
    Object.assign(answers, { [method]: () => reply.promise })
    const pending = method === "diagnostics" ? seam.diagnostics("index.ts", "owner/repo") : seam[method]("index.ts", 1, 1, "owner/repo")
    await untilCalled(method)
    await retire(fixture, change)
    const before = await store.eventHistory()
    if (method === "hover") reply.resolve({ ok: { hover: { contents: "Previous account private hover", truncated: false } } })
    if (method === "definition") reply.resolve({ ok: { locations: [{ path: "private.ts", line: 1, character: 1, endLine: 1, endCharacter: 2 }], total: 1, omitted: 0 } })
    if (method === "diagnostics") reply.resolve({ ok: { items: [diagnostic], total: 1 } })
    expect(await pending).toBe(SIGN_OUT_REFUSAL)
    expect((await store.eventHistory()).head).toEqual(before.head)
    expect(clients[0]!.disposals).toBe(1)
    expect(clients[0]!.unsubscribes).toBe(1)
    expect(fixture.calls.readFile).toBe(0)
  })
}

for (const type of ["diagnostics", "waiting", "closed"] as const) {
  test(`a retired ${type} publication cannot annotate a matching file; the new owner gets a fresh client`, async () => {
    const fixture = await setup(), { store, seam, clients } = fixture
    await seam.hover("index.ts", 1, 1, "owner/repo")
    await retire(fixture, "account")
    await store.dispatch(cloud("second")).isPersisted.promise
    await seam.hover("index.ts", 1, 1, "owner/repo")
    expect(clients.length).toBe(2)
    const before = await store.eventHistory()
    clients[0]!.publish(event(type))
    expect((await store.eventHistory()).head).toEqual(before.head)
    clients[1]!.publish(event(type))
    expect((await store.eventHistory()).head).not.toEqual(before.head)
    expect(clients[1]!.disposals).toBe(0)
  })
}

test("same-owner refreshes and the agent door retain the active client", async () => {
  const { store, seam, clients, agent } = await setup()
  await seam.hover("index.ts", 1, 1, "owner/repo")
  await store.dispatch({ ...identity("first"), admin: true }).isPersisted.promise
  await store.dispatch({ ...cloud("first"), expiresAt: "2099-01-01T00:00:00Z" }).isPersisted.promise
  await agent().diagnostics("index.ts", "owner/repo")
  expect(clients.length).toBe(1)
  expect(clients[0]!.disposals).toBe(0)
  clients[0]!.publish(event("diagnostics"))
  await store.settled?.()
  expect(store.collections.cards.get(card.id)).toHaveProperty("payload.diagnostics.0.message", diagnostic.message)
  seam.dispose(); agent().dispose()
  expect(clients[0]!.disposals).toBe(1)
  expect(await seam.hover("index.ts", 1, 1, "owner/repo")).toBe(SIGN_OUT_REFUSAL)
  expect(clients.length).toBe(1)
})

test("an account switch during initial file loading does not start a client", async () => {
  const read = Promise.withResolvers<void>()
  const fixture = await setup({ missingFile: true, readFile: () => read.promise }), { seam, clients, untilCalled } = fixture
  const pending = seam.hover("index.ts", 1, 1, "owner/repo")
  await untilCalled("readFile"); await retire(fixture, "account"); read.resolve()
  expect(await pending).toBe(SIGN_OUT_REFUSAL)
  expect(clients.length).toBe(0)
})

test("an account switch while opening a definition suppresses its private answer", async () => {
  const read = Promise.withResolvers<void>()
  const fixture = await setup({ readFile: () => read.promise }), { seam, answers, untilCalled } = fixture
  answers.definition = async () => ({ ok: { locations: [{ path: "private.ts", line: 1, character: 1, endLine: 1, endCharacter: 2 }], total: 1, omitted: 0 } })
  const pending = seam.definition("index.ts", 1, 1, "owner/repo")
  await untilCalled("readFile"); await retire(fixture, "account"); read.resolve()
  expect(await pending).toBe(SIGN_OUT_REFUSAL)
})

test("an old starting timer and refusal cannot patch the next owner's file", async () => {
  const fixture = await setup({ startingAfterMs: 40 }), { store, seam, answers, untilCalled } = fixture
  const reply = Promise.withResolvers<Awaited<ReturnType<CloudLspClient["hover"]>>>()
  answers.hover = () => reply.promise
  const pending = seam.hover("index.ts", 1, 1, "owner/repo")
  await untilCalled("hover"); await retire(fixture, "account")
  const before = await store.eventHistory()
  await new Promise(resolve => setTimeout(resolve, 60))
  reply.resolve({ refusal: { code: "closed", message: "Previous account private failure" } })
  expect(await pending).toBe(SIGN_OUT_REFUSAL)
  expect((await store.eventHistory()).head).toEqual(before.head)
})

import { afterEach, expect, test } from "bun:test"
import { createActorBindings } from "../ActorBindings"
import { createAppStore, type AppStore } from "../AppStore"
import type { Card } from "../AppState"
import type { CloudLspClient, CloudLspEvent, CloudLspDocument } from "../CloudLspClient"
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
  const store = await createAppStore({ kind: "localStorage", storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } } })
  stores.push(store)
  await store.dispatch(identity("first")).isPersisted.promise
  await store.dispatch(cloud("first")).isPersisted.promise
  await reopenFile(store)
  if (options.missingFile) await store.dispatch({ type: "card.removed", actor: "user", id: card.id }).isPersisted.promise
  const clients: Array<{ client: CloudLspClient; publish(event: CloudLspEvent): void; disposals: number; unsubscribes: number }> = []
  const documents: CloudLspDocument[] = []
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
        hover: async (document: CloudLspDocument) => { documents.push(document); calls.hover++; return answers.hover() }, definition: async (document: CloudLspDocument) => { documents.push(document); calls.definition++; return answers.definition() },
        diagnostics: async (document: CloudLspDocument) => { documents.push(document); calls.diagnostics++; return answers.diagnostics() },
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
  return { store, seam, agent: () => bindings.select(seam), answers, calls, clients, documents, untilCalled, disposeContext: () => { disposed = true; seam.dispose() } }
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

test("a late hover cannot replace the answer for a newer cursor position", async () => {
  const { store, seam, answers, untilCalled } = await setup()
  const reply = Promise.withResolvers<Awaited<ReturnType<CloudLspClient["hover"]>>>()
  answers.hover = () => reply.promise
  const old = seam.hover("index.ts", 1, 1, "owner/repo")
  await untilCalled("hover")
  answers.hover = async () => ({ ok: { hover: { contents: "Newer hover", truncated: false } } })
  await seam.hover("index.ts", 1, 2, "owner/repo")
  const before = await store.eventHistory()
  reply.resolve({ ok: { hover: { contents: "Older hover", truncated: false } } })
  expect(JSON.stringify(await old)).toContain("Older hover")
  const shown = store.collections.cards.get(card.id)
  expect(shown?.kind).toBe("file")
  if (shown?.kind === "file") expect(shown.payload.hover).toEqual({ line: 1, character: 2, contents: "Newer hover" })
  expect((await store.eventHistory()).head).toEqual(before.head)
})

for (const first of ["user", "smithers"] as const) {
  for (const second of ["user", "smithers"] as const) {
    for (const outcome of ["hover", "empty", "refusal"] as const) {
      test(`${first} late ${outcome} cannot overwrite ${second}'s newer hover`, async () => {
        const { store, seam, agent, answers, untilCalled } = await setup()
        const reply = Promise.withResolvers<Awaited<ReturnType<CloudLspClient["hover"]>>>()
        answers.hover = () => reply.promise
        const old = (first === "user" ? seam : agent()).hover("index.ts", 1, 1, "owner/repo")
        await untilCalled("hover")
        answers.hover = async () => ({ ok: { hover: { contents: "Newer hover", truncated: false } } })
        await (second === "user" ? seam : agent()).hover("index.ts", 1, 2, "owner/repo")
        const before = await store.eventHistory()
        reply.resolve(outcome === "refusal" ? { refusal: { code: "closed", message: "Older refusal" } }
          : { ok: { hover: outcome === "empty" ? null : { contents: "Older hover", truncated: false } } })
        const result = await old
        expect(JSON.stringify(result)).toContain(outcome === "refusal" ? "Older refusal" : outcome === "empty" ? "nothing at" : "Older hover")
        const shown = store.collections.cards.get(card.id)
        if (shown?.kind !== "file") throw new Error("Expected the file card")
        expect(shown.payload.hover?.contents).toBe("Newer hover")
        expect(shown.payload.hover?.character).toBe(2)
        expect(shown.payload.intel?.state).toBe("ready")
        expect((await store.eventHistory()).head).toEqual(before.head)
      })
    }
  }
}

for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
  test(`three hovers settling ${order.join(",")} publish only the last cursor position`, async () => {
    const { store, seam, answers, untilCalled } = await setup()
    const replies = Array.from({ length: 3 }, () => Promise.withResolvers<Awaited<ReturnType<CloudLspClient["hover"]>>>())
    const pending = []
    for (let i = 0; i < 3; i++) {
      answers.hover = () => replies[i]!.promise
      pending.push(seam.hover("index.ts", 1, i + 1, "owner/repo"))
      await untilCalled("hover", i + 1)
    }
    const before = await store.eventHistory()
    for (const index of order) {
      replies[index]!.resolve({ ok: { hover: { contents: `Hover ${index}`, truncated: false } } })
      expect(JSON.stringify(await pending[index])).toContain(`Hover ${index}`)
      const shown = store.collections.cards.get(card.id)
      if (shown?.kind !== "file") throw new Error("Expected the file card")
      if (order.indexOf(index) < order.indexOf(2)) expect(shown.payload.hover).toBeUndefined()
      else expect(shown.payload.hover?.contents).toBe("Hover 2")
    }
    expect((await store.eventHistory()).head.sequence).toBe(before.head.sequence + 1)
  })
}

for (const outcome of ["empty", "refusal"] as const) {
  test(`an old hover and its starting timer cannot overwrite a newer ${outcome}`, async () => {
    const { store, seam, answers, untilCalled } = await setup({ startingAfterMs: 25 })
    const reply = Promise.withResolvers<Awaited<ReturnType<CloudLspClient["hover"]>>>()
    answers.hover = () => reply.promise
    const old = seam.hover("index.ts", 1, 1, "owner/repo")
    await untilCalled("hover")
    answers.hover = async () => outcome === "empty" ? { ok: { hover: null } } : { refusal: { code: "closed", message: "Latest refusal" } }
    await seam.hover("index.ts", 1, 2, "owner/repo")
    const before = await store.eventHistory()
    await new Promise(resolve => setTimeout(resolve, 40))
    expect((await store.eventHistory()).head).toEqual(before.head)
    reply.resolve({ ok: { hover: { contents: "Older hover", truncated: false } } })
    await old
    expect((await store.eventHistory()).head).toEqual(before.head)
    // A later request still owns its card after both earlier requests settle.
    answers.hover = async () => ({ ok: { hover: { contents: "Fresh hover", truncated: false } } })
    await seam.hover("index.ts", 1, 3, "owner/repo")
    const shown = store.collections.cards.get(card.id)
    if (shown?.kind !== "file") throw new Error("Expected the file card")
    expect(shown.payload.hover?.contents).toBe("Fresh hover")
  })
}

test("hover ordering is claimed before a delayed file preparation", async () => {
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const fixture = await setup({ missingFile: true, readFile: async () => { entered.resolve(); await gate.promise } })
  const { store, seam, answers, calls } = fixture
  const old = seam.hover("index.ts", 1, 1, "owner/repo")
  await entered.promise
  await reopenFile(store)
  answers.hover = async () => ({ ok: { hover: { contents: calls.hover === 1 ? "Newer hover" : "Older hover", truncated: false } } })
  await seam.hover("index.ts", 1, 2, "owner/repo")
  const before = await store.eventHistory()
  gate.resolve()
  expect(JSON.stringify(await old)).toContain("Older hover")
  const shown = store.collections.cards.get(card.id)
  if (shown?.kind !== "file") throw new Error("Expected the file card")
  expect(shown.payload.hover?.contents).toBe("Newer hover")
  expect((await store.eventHistory()).head).toEqual(before.head)
})

test("hovers in different files retain independent cards", async () => {
  const { store, seam, answers, untilCalled } = await setup()
  const other = { ...card, id: "file-owner/repo-other.ts", payload: { ...card.payload, path: "other.ts" } }
  await store.dispatch({ type: "card.upsert", actor: "user", card: other }).isPersisted.promise
  const reply = Promise.withResolvers<Awaited<ReturnType<CloudLspClient["hover"]>>>()
  answers.hover = () => reply.promise
  const old = seam.hover("index.ts", 1, 1, "owner/repo")
  await untilCalled("hover")
  answers.hover = async () => ({ ok: { hover: { contents: "Other file hover", truncated: false } } })
  await seam.hover("other.ts", 1, 2, "owner/repo")
  reply.resolve({ ok: { hover: { contents: "First file hover", truncated: false } } })
  await old
  for (const [id, text] of [[card.id, "First file hover"], [other.id, "Other file hover"]]) {
    const shown = store.collections.cards.get(id!)
    if (shown?.kind !== "file") throw new Error("Expected the file card")
    expect(shown.payload.hover?.contents).toBe(text)
  }
})

for (const type of ["diagnostics", "waiting", "closed"] as const) {
  test(`an old workspace's ${type} cannot annotate a file now using another workspace`, async () => {
    const { store, seam, clients, documents } = await setup()
    await seam.hover("index.ts", 1, 1, "owner/repo")
    const old = store.collections.cloudWorkspaces.get("ws-lsp")!
    await store.dispatch({ type: "workspace.updated", actor: "system", workspace: { ...old, status: "stopped" } }).isPersisted.promise
    await store.dispatch({ type: "workspace.updated", actor: "system", workspace: { ...old, id: "ws-new", name: "New workspace" } }).isPersisted.promise
    await seam.hover("index.ts", 1, 1, "owner/repo")
    expect(documents.map(doc => doc.workspaceId)).toEqual(["ws-lsp", "ws-new"])
    const before = await store.eventHistory()
    clients[0]!.publish(event(type))
    expect((await store.eventHistory()).head).toEqual(before.head)
    clients[0]!.publish({ ...event(type), workspaceId: "ws-new" })
    expect((await store.eventHistory()).head).not.toEqual(before.head)
  })
}

const useWorkspace = async (store: AppStore, id: string) => {
  for (const row of [...store.collections.cloudWorkspaces.values()]) {
    await store.dispatch({ type: "workspace.updated", actor: "system", workspace: { ...row, status: "stopped" } }).isPersisted.promise
  }
  const template = store.collections.cloudWorkspaces.get("ws-lsp")!
  await store.dispatch({ type: "workspace.updated", actor: "system", workspace: { ...template, id, name: id, status: "running" } }).isPersisted.promise
}

for (const method of ["hover", "definition", "diagnostics"] as const) {
  for (const outcome of ["answer", "empty", "refusal"] as const) {
    for (const actor of ["user", "smithers"] as const) {
      test(`retired workspace ${actor} ${method} ${outcome} keeps data but cannot change the current card`, async () => {
        const { store, seam, agent, answers, untilCalled, calls, documents } = await setup({ startingAfterMs: 20 })
        const reply = Promise.withResolvers<Awaited<ReturnType<CloudLspClient[typeof method]>>>()
        Object.assign(answers, { [method]: () => reply.promise })
        const oldDoor = actor === "user" ? seam : agent(), newDoor = actor === "user" ? agent() : seam
        const old = method === "diagnostics" ? oldDoor.diagnostics("index.ts", "owner/repo") : oldDoor[method]("index.ts", 1, 1, "owner/repo")
        await untilCalled(method)
        await useWorkspace(store, "ws-new")
        // Use a different action so hover ordering alone cannot hide the workspace bug.
        if (method === "hover") {
          answers.diagnostics = async () => ({ refusal: { code: "closed", message: "Current workspace refusal" } })
          await newDoor.diagnostics("index.ts", "owner/repo")
        } else {
          answers.hover = async () => ({ refusal: { code: "closed", message: "Current workspace refusal" } })
          await newDoor.hover("index.ts", 1, 2, "owner/repo")
        }
        expect(documents.map(doc => doc.workspaceId)).toEqual(["ws-lsp", "ws-new"])
        const before = await store.eventHistory()
        await new Promise(resolve => setTimeout(resolve, 25))
        expect((await store.eventHistory()).head).toEqual(before.head)
        if (outcome === "refusal") reply.resolve({ refusal: { code: "closed", message: "Old workspace refusal" } })
        else if (method === "hover") reply.resolve({ ok: { hover: outcome === "empty" ? null : { contents: "Old workspace hover", truncated: false } } })
        else if (method === "definition") reply.resolve({ ok: { locations: outcome === "empty" ? [] : [{ path: "old.ts", line: 1, character: 1, endLine: 1, endCharacter: 2 }], total: outcome === "empty" ? 0 : 1, omitted: 0 } })
        else reply.resolve({ ok: { items: outcome === "empty" ? null : [diagnostic], total: outcome === "empty" ? null : 1 } })
        const result = await old
        expect(result).not.toBe(SIGN_OUT_REFUSAL)
        expect(result).toBeDefined()
        expect((await store.eventHistory()).head).toEqual(before.head)
        expect(calls.readFile).toBe(0)
      })
    }
  }
}

test("returning to a workspace cannot revive an earlier pending response", async () => {
  const { store, seam, answers, untilCalled } = await setup()
  const reply = Promise.withResolvers<Awaited<ReturnType<CloudLspClient["diagnostics"]>>>()
  answers.diagnostics = () => reply.promise
  const old = seam.diagnostics("index.ts", "owner/repo")
  await untilCalled("diagnostics")
  await useWorkspace(store, "ws-new"); await seam.hover("index.ts", 1, 1, "owner/repo")
  await useWorkspace(store, "ws-lsp"); await seam.hover("index.ts", 1, 2, "owner/repo")
  const before = await store.eventHistory()
  reply.resolve({ ok: { items: [diagnostic], total: 1 } }); await old
  expect((await store.eventHistory()).head).toEqual(before.head)
})

test("workspace ownership is claimed before a delayed file read", async () => {
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  const { store, seam, answers, clients } = await setup({ missingFile: true, readFile: async () => { entered.resolve(); await gate.promise } })
  const old = seam.diagnostics("index.ts", "owner/repo")
  await entered.promise
  await reopenFile(store); await useWorkspace(store, "ws-new")
  await seam.hover("index.ts", 1, 1, "owner/repo")
  const before = await store.eventHistory()
  answers.diagnostics = async () => ({ ok: { items: [diagnostic], total: 1 } })
  gate.resolve(); await old
  clients[0]!.publish(event("diagnostics"))
  expect((await store.eventHistory()).head).toEqual(before.head)
})

for (const refusal of ["no-workspace", "no-language"] as const) {
  test(`a ${refusal} preparation retires the file's prior publications`, async () => {
    const { store, seam, clients } = await setup()
    await seam.hover("index.ts", 1, 1, "owner/repo")
    const old = store.collections.cloudWorkspaces.get("ws-lsp")!
    await store.dispatch({ type: "workspace.updated", actor: "system", workspace: { ...old, ...(refusal === "no-workspace" ? { status: "stopped" as const } : { lspLanguages: [] }) } }).isPersisted.promise
    expect(typeof await seam.hover("index.ts", 1, 1, "owner/repo")).toBe("string")
    const before = await store.eventHistory()
    for (const type of ["diagnostics", "waiting", "closed"] as const) clients[0]!.publish(event(type))
    expect((await store.eventHistory()).head).toEqual(before.head)
  })
}

test("a workspace handoff for one file leaves the other file's subscription live", async () => {
  const { store, seam, clients } = await setup()
  const other = { ...card, id: "file-owner/repo-other.ts", payload: { ...card.payload, path: "other.ts" } }
  await store.dispatch({ type: "card.upsert", actor: "user", card: other }).isPersisted.promise
  await seam.hover("index.ts", 1, 1, "owner/repo")
  await seam.hover("other.ts", 1, 1, "owner/repo")
  await useWorkspace(store, "ws-new"); await seam.hover("index.ts", 1, 1, "owner/repo")
  clients[0]!.publish({ ...event("closed"), type: "closed", paths: ["index.ts", "other.ts"], code: 1000, reason: "Old workspace closed" })
  const current = store.collections.cards.get(card.id), previous = store.collections.cards.get(other.id)
  if (current?.kind !== "file" || previous?.kind !== "file") throw new Error("Expected both files")
  expect(current.payload.intel?.state).toBe("ready")
  expect(previous.payload.intel?.state).toBe("unavailable")
})

test("a selected box that is not running refuses; only with no box selected does the running box answer", async () => {
  const { store, seam, calls } = await setup()
  const running = store.collections.cloudWorkspaces.get("ws-lsp")!
  await store.dispatch({ type: "workspace.updated", actor: "system", workspace: { ...running, id: "ws-idle", name: "Idle", status: "suspended" } }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: "owner/repo#workspace:ws-idle" }).isPersisted.promise
  expect(await seam.hover("index.ts", 1, 1, "owner/repo")).toBe("Resume the selected box first: /box.resume ws-idle")
  expect(calls.hover).toBe(0)
  await store.dispatch({ type: "repo.selected", actor: "user", id: "owner/repo" }).isPersisted.promise
  expect(typeof await seam.hover("index.ts", 1, 1, "owner/repo")).not.toBe("string")
  expect(calls.hover).toBe(1)
})

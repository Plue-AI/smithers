import { expect, test } from "bun:test"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { memoryStorage } from "./TestFixtures"
import type { FileCard } from "@smthrs/rpc/FileCard"
import type { AgentPort } from "../runtime/AgentPort"
const controller = scopedControllers()
const agent: AgentPort = { available: false, startTurn: async () => ({ status: "error", message: "Unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} }
const file: FileCard = { branch: "main", path: "README.md", language: "markdown", digest: "fixture-one", content: { kind: "text", text: "literal mirror bytes\n" }, mode: "read_only", diagnostics: [], authors: [], editors: [] }
test("controller forwards authenticated branch options to the existing seam", async () => {
  const requests: string[] = []
  const app = controller(await createAppStore({ kind: "localStorage", storage: memoryStorage() }), agent, {
    branchOptions: { ready: () => true, scope: () => ({ branch: "main", member: "ben", revision: 1, sleeping: false }) },
    fetchImpl: async url => { requests.push(String(url)); return new Response(JSON.stringify(file)) }
  })
  expect(await app.branchFiles.read("main", "README.md")).toEqual({ ok: file })
  expect(requests).toEqual(["/api/branches/main/files/README.md"])
})
test("controller without provider receipts keeps branch reads dark", async () => {
  const requests: string[] = []
  const app = controller(await createAppStore({ kind: "localStorage", storage: memoryStorage() }), agent, {
    fetchImpl: async url => { requests.push(String(url)); return new Response(JSON.stringify(file)) }
  })
  expect(await app.branchFiles.read("main", "README.md")).toEqual({ error: "Branch files are unavailable." })
  expect(requests).toEqual([])
})

test("seeded Follow keeps the File card identity and moves its existing file row", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const app = controller(store, agent, { fetchImpl: async () => new Response("{}", { status: 404 }) })
  const file = app.design.world().files.find(file => file.gone?.kind === "renamed") ?? app.design.world().files[0]!
  app.design.patch("files", file.id, current => ({ ...current, gone: { kind: "renamed", to: "src/deliver.ts", by: "maya" } }))
  await app.commands.submit({ name: "file", payload: { path: file.path, branch: file.branch }, actor: "user" })
  const opened = [...store.collections.cards.values()].find(card => card.kind === "file" && card.payload.path === file.path)
  expect(opened?.kind).toBe("file")
  expect((await app.commands.submit({ name: "file.follow-rename", payload: { path: file.path, branch: file.branch }, actor: "user" })).status).toBe("executed")
  const followed = store.collections.cards.get(opened!.id)
  if (followed?.kind !== "file") throw new Error("Missing followed file")
  expect(followed.payload.path).toBe("src/deliver.ts")
  expect(app.design.world().files.find(row => row.id === file.id)?.path).toBe("src/deliver.ts")
  expect(app.design.world().files.find(row => row.id === file.id)?.gone).toBeUndefined()
})

// Contract fake supplies HTTP bytes only; commands, seam, Flux and persisted cards are production.
for (const actor of ["user", "agent"] as const) {
  test(`${actor} File recovery doors use branch HTTP and retain the persisted card`, async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const requests: Array<{ url: string; method: string; body?: unknown }> = []
    const writer = { kind: "person", login: "maya", name: "Maya", avatar_url: "https://example.com/maya.png", color_index: 1 } as const
    let model: FileCard = { ...file, branch: "scratch/maya/demo", path: "src/old.ts", digest: "deleted", gone: { kind: "deleted", by: writer }, outside: { version: "before-17", post_digest: "absent", at: "2026-10-06T00:00:00Z" } }
    const app = controller(store, agent, {
      bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "none", sandbox: null },
      branchOptions: { ready: () => true, scope: (branch = model.branch) => ({ branch, member: "maya", revision: 1, sleeping: false }) },
      fetchImpl: async (url, init) => {
        const request = { url: String(url), method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) }
        requests.push(request)
        if (request.method === "POST") {
          model = { ...model, digest: "restored", content: { kind: "text", text: "restored literal bytes\n" }, gone: undefined }
          return new Response("{}")
        }
        if (request.url.includes("?compare=")) return new Response(JSON.stringify({ text: "captured literal bytes\n" }))
        return new Response(JSON.stringify(model))
      }
    })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", admin: false, scopesPlain: null }).isPersisted.promise
    const run = (name: "file" | "file.compare" | "file.restore-deleted" | "file.follow-rename") => app.commands.submit({ name, payload: { path: "src/old.ts", branch: model.branch }, actor })
    requests.length = 0
    expect((await run("file")).status).toBe("executed")
    const opened = [...store.collections.cards.values()].find(card => card.kind === "file" && card.payload.path === "src/old.ts")!
    expect(opened).toBeDefined()
    expect((await run("file.compare")).status).toBe("executed")
    const compared = store.collections.cards.get(opened.id)
    if (compared?.kind !== "file") throw Error("Missing comparison card")
    expect(compared.payload.comparison).toEqual({ version: "before-17", text: "captured literal bytes\n" })
    expect(compared.payload.compare).toBe(true)
    expect((await run("file.restore-deleted")).status).toBe("executed")
    const restored = store.collections.cards.get(opened.id)
    if (restored?.kind !== "file") throw Error("Missing restored card")
    expect(restored.payload.content).toBe("restored literal bytes\n")
    expect(restored.payload.file?.gone).toBeUndefined()
    expect(restored.createdAt).toBe(opened.createdAt)
    expect(restored.ordinal).toBe(opened.ordinal)
    model = { ...model, gone: { kind: "renamed", to: "src/new.ts", by: writer } }
    await run("file")
    model = { ...model, path: "src/new.ts", gone: undefined }
    expect((await run("file.follow-rename")).status).toBe("executed")
    const followed = store.collections.cards.get(opened.id)
    if (followed?.kind !== "file") throw Error("Missing followed card")
    expect(followed.payload.path).toBe("src/new.ts")
    expect([...store.collections.cards.values()].filter(card => card.kind === "file")).toHaveLength(1)
    expect(requests).toEqual([
      { url: "/api/branches/scratch%2Fmaya%2Fdemo/files/src/old.ts", method: "GET" },
      { url: "/api/branches/scratch%2Fmaya%2Fdemo/files/src/old.ts?compare=before-17", method: "GET" },
      { url: "/api/branches/scratch%2Fmaya%2Fdemo/files/src/old.ts", method: "POST", body: { action: "restore-deleted", version: "before-17", base_digest: "absent" } },
      { url: "/api/branches/scratch%2Fmaya%2Fdemo/files/src/old.ts", method: "GET" },
      { url: "/api/branches/scratch%2Fmaya%2Fdemo/files/src/old.ts", method: "GET" },
      { url: "/api/branches/scratch%2Fmaya%2Fdemo/files/src/new.ts", method: "GET" }
    ])
  })
}

test("failed Compare keeps the File card and reports a visible failure", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: string[] = []
  const model: FileCard = { ...file, outside: { version: "before-17", at: "2026-10-06T00:00:00Z" } }
  const app = controller(store, agent, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "none", sandbox: null },
    branchOptions: { ready: () => true, scope: () => ({ branch: "main", member: "ben", revision: 1, sleeping: false }) },
    fetchImpl: async url => {
      requests.push(String(url))
      return String(url).includes("?compare=")
        ? new Response(JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "Live file provider unavailable" } }), { status: 503 })
        : new Response(JSON.stringify(model))
    }
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  requests.length = 0
  await app.commands.submit({ name: "file", payload: { path: file.path, branch: file.branch }, actor: "user" })
  const opened = [...store.collections.cards.values()].find(card => card.kind === "file")!
  const result = await app.commands.submit({ name: "file.compare", payload: { path: file.path, branch: file.branch }, actor: "user" })
  expect(result.status).toBe("failed")
  expect(JSON.stringify(result)).toContain("Could not compare the file.")
  expect(store.collections.cards.get(opened.id)).toEqual(opened)
  expect(requests).toEqual(["/api/branches/main/files/README.md", "/api/branches/main/files/README.md?compare=before-17"])
})

test("install file commands use the persisted selected branch without injected options", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: string[] = []
  const branch = "scratch/maya/selected"
  const app = controller(store, agent, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "none", sandbox: null },
    fetchImpl: async url => {
      requests.push(String(url))
      return new Response(JSON.stringify({ ...file, branch }))
    }
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "branch.navigation.changed", actor: "user", navigation: { owner: "maya", open: true, selected_branch: branch, nodes: [] } }).isPersisted.promise
  requests.length = 0
  expect((await app.commands.submit({ name: "file", payload: { path: "README.md" }, actor: "user" })).status).toBe("executed")
  expect(requests).toEqual(["/api/branches/scratch%2Fmaya%2Fselected/files/README.md"])
  expect([...store.collections.cards.values()].find(card => card.kind === "file")?.payload).toMatchObject({ path: "README.md", file: { branch } })
})

test("install code intelligence uses the selected branch File card and daemon exec provider", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const branch = "scratch/maya/intelligence"
  const opens: unknown[] = []
  const methods: string[] = []
  let qualified = true
  let liveSockets = 0
  let snapshot: import("../runtime/LiveChannel").TopicSnapshot = { topic: `branch:${branch}`, data: { id: "machine-1", name: branch, machine: { state: "running" } } }
  const listeners = new Set<() => void>()
  const update = (next: typeof snapshot) => { snapshot = next; for (const listener of [...listeners]) listener() }
  const waitClosed = async () => { for (let n = 0; liveSockets && n < 100; n++) await Bun.sleep(5); expect(liveSockets).toBe(0) }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: (request, server) => server.upgrade(request) ? undefined : new Response("No", { status: 400 }),
    websocket: { open: () => { liveSockets++ }, close: () => { liveSockets-- }, message: (socket, raw) => {
      const message = JSON.parse(String(raw))
      methods.push(message.method)
      if (message.method === "initialize") {
        expect(message.params.rootUri).toBe("file:///workspace")
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } }))
      }
      if (message.method === "textDocument/didOpen") socket.send(JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: message.params.textDocument.uri, version: 1, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, severity: 2, message: "literal daemon diagnostic" }] } }))
      if (message.method === "textDocument/definition") socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { uri: "file:///workspace/definition.ts", range: { start: { line: 2, character: 0 }, end: { line: 2, character: 6 } } } }))
      if (message.method === "textDocument/hover") socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { contents: "literal daemon hover" } }))
    } }
  })
  const app = controller(store, agent, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "none", sandbox: null },
    live: { subscribe: (topic, changed) => { if (topic === snapshot.topic) listeners.add(changed); return () => { listeners.delete(changed) } }, getSnapshot: topic => topic === snapshot.topic ? snapshot : undefined },
    socketProtocols: () => ["smithers.local.test"],
    daemonLsp: {
      ready: () => qualified,
      openSession: async scope => { opens.push(scope); return Response.json({ id: "17", kind: "exec", language: "typescript" }) },
      socketUrl: () => `ws://127.0.0.1:${server.port}`
    },
    fetchImpl: async url => {
      expect(String(url)).toMatch(/^\/api\/branches\/scratch%2Fmaya%2Fintelligence\/files\/(retry|definition)\.ts$/)
      return Response.json({ ...file, branch, path: String(url).endsWith("definition.ts") ? "definition.ts" : "retry.ts", language: "typescript", content: { kind: "text", text: "export const retry = 1\n" } })
    }
  })
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "branch.navigation.changed", actor: "user", navigation: { owner: "maya", open: true, selected_branch: branch, nodes: [] } }).isPersisted.promise
    expect(app.commands.find("code.hover")?.metadata.visibility).toBe("in-card")
    const outcome = await app.commands.submit({ name: "code.hover", payload: { path: "retry.ts", line: 1, column: 14 }, actor: "user" })
    expect(outcome).toMatchObject({ status: "executed" })
    expect(JSON.stringify(outcome)).toContain("literal daemon hover")
    expect(opens).toEqual([{ branch, kind: "exec", language: "typescript" }])
    expect(methods).toEqual(["initialize", "initialized", "textDocument/didOpen", "textDocument/hover"])
    const card = store.collections.cards.get(`file-branch-${branch}-retry.ts`)
    expect(card?.kind).toBe("file")
    if (card?.kind !== "file") throw new Error("Missing branch File")
    expect(card.payload.hover?.contents).toBe("literal daemon hover")
    expect(card.payload.file?.branch).toBe(branch)
    // The agent uses the same provider, reusing the member's language session.
    expect(await app.commands.runAsAgent("code.hover", "retry.ts:1:14")).toMatchObject({ status: "executed" })
    expect((await app.commands.submit({ name: "code.definition", payload: { path: "retry.ts", line: 1, column: 14 }, actor: "user" })).status).toBe("executed")
    const defined = store.collections.cards.get(`file-branch-${branch}-definition.ts`)
    expect(defined?.kind).toBe("file")
    if (defined?.kind !== "file") throw new Error("Missing definition File")
    expect(defined.payload.line).toBe(3)
    expect(JSON.stringify(await app.commands.submit({ name: "code.diagnostics", payload: { path: "retry.ts" }, actor: "user" }))).toContain("literal daemon diagnostic")
    expect(opens).toHaveLength(1)
    update({ topic: snapshot.topic, data: { id: "machine-1", name: branch, machine: { state: "asleep" } } })
    await waitClosed()
    expect(JSON.stringify(await app.commands.submit({ name: "code.hover", payload: { path: "retry.ts", line: 1, column: 14 }, actor: "user" }))).toContain("The branch is asleep.")
    expect(opens).toHaveLength(1)
    update({ topic: snapshot.topic, data: { id: "machine-1", name: branch, machine: { state: "running" } } })
    expect((await app.commands.submit({ name: "code.hover", payload: { path: "retry.ts", line: 1, column: 14 }, actor: "user" })).status).toBe("executed")
    expect(opens).toHaveLength(2)
    update({ topic: snapshot.topic, error: "forbidden" })
    await waitClosed()
    expect((await app.commands.submit({ name: "code.hover", payload: { path: "retry.ts", line: 1, column: 14 }, actor: "user" })).status).toBe("failed")
    expect(opens).toHaveLength(2)
    qualified = false
    expect(app.commands.find("code.hover")).toBeUndefined()
    expect((await app.commands.runAsAgent("code.hover", "retry.ts:1:14")).status).toBe("unknown-command")
    expect(opens).toHaveLength(2)
  } finally { await app.dispose(); await server.stop(true) }
})

test("sleeping branch intelligence refuses all doors without reads or session starts", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const calls: string[] = []
  const app = controller(store, agent, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "none", sandbox: null },
    branchOptions: { ready: () => true, scope: (branch = "scratch/maya/asleep") => ({ branch, member: "maya", revision: 1, sleeping: true, capturedHead: "captured" }) },
    daemonLsp: { ready: () => true, openSession: async () => { calls.push("session"); throw new Error("Must not open") }, socketUrl: () => { calls.push("socket"); return undefined } },
    fetchImpl: async () => { calls.push("read"); throw new Error("Must not read") }
  })
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", admin: false, scopesPlain: null }).isPersisted.promise
    calls.length = 0
    for (const name of ["code.hover", "code.definition", "code.diagnostics"] as const) {
      const outcome = await app.commands.submit({ name, payload: { path: "retry.ts", ...(name === "code.diagnostics" ? {} : { line: 1, column: 1 }) }, actor: "user" })
      expect(JSON.stringify(outcome)).toContain("The branch is asleep.")
      expect((await app.commands.runAsAgent(name, name === "code.diagnostics" ? "retry.ts" : "retry.ts:1:1")).status).toBe("failed")
    }
    expect(calls).toEqual([])
    expect([...store.collections.cards.values()].filter(card => card.kind === "file")).toEqual([])
  } finally { await app.dispose() }
})

test("install File commands consume captured sleep facts and refuse Restore before HTTP", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const branch = "scratch/maya/sleep"
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  const requests: string[] = []
  let snapshot: import("../runtime/LiveChannel").TopicSnapshot = { topic: `branch:${branch}`, data: { id: "machine-1", name: branch, head, machine: { state: "asleep" } } }
  const subscriptions: string[] = []
  const app = controller(store, agent, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "none", sandbox: null },
    live: { subscribe: topic => { subscriptions.push(topic); return () => {} }, getSnapshot: topic => topic === snapshot.topic ? snapshot : undefined },
    fetchImpl: async url => { requests.push(String(url)); return new Response(JSON.stringify({ ...file, branch, outside: { version: "before-17", post_digest: "fixture-one", at: "2026-10-06T00:00:00Z" } })) }
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "branch.navigation.changed", actor: "user", navigation: { owner: "maya", open: true, selected_branch: branch, nodes: [] } }).isPersisted.promise
  requests.length = 0
  expect((await app.commands.submit({ name: "file", payload: { path: "README.md" }, actor: "user" })).status).toBe("executed")
  expect(requests).toEqual([`/api/branches/scratch%2Fmaya%2Fsleep/files/README.md?at=${head}`])
  expect(subscriptions.filter(topic => topic === snapshot.topic)).toHaveLength(1)
  const opened = [...store.collections.cards.values()].find(card => card.kind === "file")!
  expect(opened.payload.ref).toBe(head)
  requests.length = 0
  expect((await app.commands.submit({ name: "file.restore", payload: { path: "README.md", branch }, actor: "user" })).status).toBe("failed")
  expect(requests).toEqual([])
  snapshot = { topic: snapshot.topic, data: { id: "machine-1", name: branch, machine: { state: "asleep" } } }
  expect(await app.branchFiles.read(branch, "README.md")).toEqual({ error: "The branch is asleep." })
  snapshot = { topic: snapshot.topic, error: "forbidden" }
  expect(await app.branchFiles.read(branch, "README.md")).toEqual({ error: "Branch access was removed." })
  expect(requests).toEqual([])
})

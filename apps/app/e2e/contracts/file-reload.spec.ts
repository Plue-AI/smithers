import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { createElement } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { scopedControllers } from "../../src/mainview/state/ControllerTestScope"
import { createAppStore } from "../../src/mainview/state/AppStore"
import { memoryStorage } from "../../src/mainview/state/TestFixtures"
import { ControllerContext } from "../../src/mainview/ControllerContext"
import { renderCardBody } from "../../src/mainview/cards/CardRenderers"
import type { CardActions } from "../../src/mainview/cards/CardFamily"
import type { DiffCard } from "@smthrs/rpc/DiffCard"
import type { FileCard } from "@smthrs/rpc/FileCard"
import type { AgentPort } from "../../src/mainview/runtime/AgentPort"
import { LiveChannel, type LiveSocket } from "../../src/mainview/runtime/LiveChannel"
GlobalRegistrator.register()
afterAll(async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() }, 20_000)
class Socket implements LiveSocket {
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  frames: string[] = []
  send(data: string | Uint8Array) { if (typeof data === "string") this.frames.push(data) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  receive(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }) }
}
const noActions: CardActions = {
  onDecideApproval() {}, onConnectGitHub() {}, onRunWorkflow() {}, onStopRun() {}, onRetryRun() {},
  onChooseWorkflowRepo() {}, worldDocuments: [], onChangeWorldDocument() {}, onRunCommand() {}
}
const controller = scopedControllers()
const agent: AgentPort = { available: false, startTurn: async () => ({ status: "error", message: "Unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} }
const maya = { kind: "person", login: "maya", name: "Maya", avatar_url: "https://example.com/maya.png", color_index: 1, via: "ssh" } as const
const first: FileCard = { branch: "b12", path: "retry.ts", language: "typescript", digest: "one", content: { kind: "text", text: "export const retry = 1\n" }, mode: "read_only", diagnostics: [], authors: [], editors: [] }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const bootstrap = { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "none", sandbox: null } as const
const wait = async (predicate: () => boolean) => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10)); expect(predicate()).toBe(true) }

test("/file dispatch loads branch bytes; live writes, gone states and Follow keep the mounted card identity", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let model = first
  const requests: string[] = []
  const socket = new Socket()
  const channel = new LiveChannel({ socket: () => socket })
  let cursor = 0
  const app = controller(store, agent, { bootstrap: { ...bootstrap, capabilities: ["install"] },
    branchOptions: { ready: () => true, scope: () => ({ branch: "b12", member: "ben", revision: 1, sleeping: false }) },
    live: channel,
    fetchImpl: async url => { const path = String(url); if (!path.includes("/branches/b12/files/")) return json({}, 404); requests.push(path); return json(model) }
  })
  const result = await app.commands.submit({ name: "file", payload: { path: "retry.ts", branch: "b12" }, actor: "user" })
  expect(result.status).toBe("executed")
  const id = "file-branch-b12-retry.ts"
  expect(store.collections.cards.get(id)?.kind).toBe("file")
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host)
  const actions: CardActions = { ...noActions, onRunCommand: (name, args) => { void app.runCommand(name, args) } }
  const render = () => flushSync(() => root.render(createElement(ControllerContext.Provider, { value: app }, renderCardBody(store.collections.cards.get(id)!, actions))))
  try {
    render(); await wait(() => !!host.querySelector('[data-kind="file"]'))
    const surface = host.querySelector('[data-kind="file"]')
    socket.open()
    const subscription = socket.frames.map(frame => JSON.parse(frame)).find(frame => frame.t === "sub" && frame.topic === "branch:b12:files")
    expect(subscription.topic).toBe("branch:b12:files")
    socket.receive({ t: "snap", id: subscription.id, cursor: 0, data: [] })
    const publish = (path: string, digest: string) => socket.receive({ t: "delta", id: subscription.id, cursor: ++cursor, data: { kind: "file_written", path, post_digest: digest, actor: maya } })
    publish("unrelated.ts", "two"); expect(requests).toHaveLength(1)
    model = { ...first, digest: "two", content: { kind: "text", text: "export const retry = 2\n" } }
    publish("retry.ts", "two")
    await wait(() => store.collections.cards.get(id)?.kind === "file" && (store.collections.cards.get(id) as any).payload.digest === "two")
    render(); expect(host.querySelector('[data-kind="file"]')).toBe(surface)
    expect(host.querySelector('[data-digest="two"]')).not.toBeNull()
    expect((store.collections.cards.get(id) as any).payload.file.last_writer).toEqual(maya)
    model = { ...model, digest: "absent", gone: { kind: "deleted", by: maya }, outside: { version: "versions-17", at: "now" } }
    publish("retry.ts", "absent"); await wait(() => (store.collections.cards.get(id) as any).payload.file.gone?.kind === "deleted"); render()
    expect(host.textContent).toContain("Deleted by Maya via SSH")
    expect(host.textContent).toContain("Restore")
    model = { ...first, digest: "renamed", gone: { kind: "renamed", to: "deliver.ts", by: maya } }
    publish("retry.ts", "renamed"); await wait(() => (store.collections.cards.get(id) as any).payload.file.gone?.kind === "renamed"); render()
    expect(host.textContent).toContain("Renamed to deliver.ts by Maya via SSH")
    model = { ...first, path: "deliver.ts", digest: "three" }
    const follow = host.querySelector<HTMLButtonElement>('[data-flow="file.follow-rename"]')
    expect(follow?.textContent).toBe("Follow")
    follow!.click()
    await wait(() => (store.collections.cards.get(id) as any).payload.path === "deliver.ts")
    render(); expect(host.querySelector('[data-kind="file"]')).toBe(surface)
    expect(requests).toEqual(["/api/branches/b12/files/retry.ts", "/api/branches/b12/files/retry.ts?digest=two", "/api/branches/b12/files/retry.ts?digest=absent", "/api/branches/b12/files/retry.ts?digest=renamed", "/api/branches/b12/files/deliver.ts"])
  } finally { flushSync(() => root.unmount()); host.remove(); await app.dispose(); channel.dispose() }
})

test("/files and /diff use branch routes and preserve literal item-prefix and scratch-fork bases", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let sleeping = false
  const requests: string[] = []
  const item: DiffCard = { path: "retry.ts", branch: "b12", against: { kind: "item_base", rev: "candidate-11" }, change: "modified", last_writer: maya,
    hunks: [{ old_start: 1, new_start: 1, lines: [{ op: "-", text: "const n = 1" }, { op: "+", text: "const n = 2" }] }] }
  const scratch: DiffCard = { ...item, against: { kind: "fork", rev: "fork-7" } }
  const app = controller(store, agent, { bootstrap: { ...bootstrap, capabilities: ["install"] },
    branchOptions: { ready: () => true, scope: () => ({ branch: "b12", member: "ben", revision: 1, sleeping, ...(sleeping ? { capturedHead: "snapshot-7" } : {}) }) },
    fetchImpl: async url => {
      const path = String(url)
      if (!path.includes("/api/branches/b12/")) return json({}, 404)
      requests.push(path)
      return path.includes("/diff") ? json({ files: [sleeping ? scratch : item] }) : json([{ name: "retry.ts", type: "file" }])
    }
  })
  expect((await app.commands.submit({ name: "files", payload: { branch: "b12" }, actor: "user" })).status).toBe("executed")
  expect((await app.commands.submit({ name: "diff", payload: { branch: "b12" }, actor: "user" })).status).toBe("executed")
  const diff = store.collections.cards.get("diff-branch-b12")
  expect(diff?.kind).toBe("diff")
  if (diff?.kind !== "diff") throw new Error("Missing diff")
  expect(diff.payload.branchFiles).toEqual([item])
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host)
  try {
    flushSync(() => root.render(renderCardBody(diff, noActions)))
    expect(host.querySelector('[data-against="item_base"]')?.textContent).toBe("candidate-11")
    sleeping = true
    expect((await app.commands.submit({ name: "diff", payload: { branch: "b12" }, actor: "user" })).status).toBe("executed")
    const captured = store.collections.cards.get(diff.id)
    if (captured?.kind !== "diff") throw new Error("Missing captured diff")
    expect(captured.payload.branchFiles).toEqual([scratch])
    flushSync(() => root.render(renderCardBody(captured, noActions)))
    expect(host.querySelector('[data-against="fork"]')?.textContent).toBe("fork-7")
    expect(requests).toEqual(["/api/branches/b12/files", "/api/branches/b12/diff", "/api/branches/b12/diff?at=snapshot-7"])
  } finally { flushSync(() => root.unmount()); host.remove(); await app.dispose() }
})

test("catalog Restore carries the burst digest; stale opens Compare once without an overwrite", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const current: FileCard = { ...first, digest: "newer", content: { kind: "text", text: "export const retry = 3\n" }, outside: { version: "versions-17", post_digest: "burst-after", at: "now" } }
  const calls: Array<{ path: string; body?: unknown }> = []
  const app = controller(store, agent, { bootstrap: { ...bootstrap, capabilities: ["install"] },
    branchOptions: { ready: () => true, scope: () => ({ branch: "b12", member: "ben", revision: 1, sleeping: false }) },
    fetchImpl: async (url, init) => {
      const path = String(url); if (!path.includes("/branches/b12/files/")) return json({}, 404)
      calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
      if (init?.method === "POST") return json({ code: "stale" }, 409)
      if (path.includes("compare=")) return json({ text: "export const retry = 1\n" })
      return json(current)
    }
  })
  await app.commands.submit({ name: "file", payload: { path: "retry.ts", branch: "b12" }, actor: "user" })
  expect((await app.commands.submit({ name: "file.restore", payload: { path: "retry.ts", branch: "b12" }, actor: "user" })).status).toBe("executed")
  const card = store.collections.cards.get("file-branch-b12-retry.ts")
  if (card?.kind !== "file") throw new Error("Missing file")
  expect(card.payload.compare).toBe(true)
  expect(card.payload.file?.digest).toBe("newer")
  expect(card.payload.comparison).toEqual({ version: "versions-17", text: "export const retry = 1\n" })
  expect(calls).toEqual([
    { path: "/api/branches/b12/files/retry.ts" },
    { path: "/api/branches/b12/files/retry.ts", body: { action: "restore", version: "versions-17", base_digest: "burst-after" } },
    { path: "/api/branches/b12/files/retry.ts?compare=versions-17" }
  ])
  await app.dispose()
})

test("deleted Restore uses absent and a recreated file is read without a second write", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let model: FileCard = { ...first, digest: "absent", gone: { kind: "deleted", by: maya }, outside: { version: "delete-17", at: "now" } }
  const calls: Array<{ path: string; body?: unknown }> = []
  const app = controller(store, agent, { bootstrap: { ...bootstrap, capabilities: ["install"] },
    branchOptions: { ready: () => true, scope: () => ({ branch: "b12", member: "ben", revision: 1, sleeping: false }) },
    fetchImpl: async (url, init) => {
      const path = String(url); if (!path.includes("/branches/b12/files/")) return json({}, 404)
      calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
      if (init?.method === "POST") { model = { ...first, digest: "recreated", content: { kind: "text", text: "recreated by Maya\n" } }; return json({ code: "stale" }, 409) }
      return json(model)
    }
  })
  await app.commands.submit({ name: "file", payload: { path: "retry.ts", branch: "b12" }, actor: "user" })
  expect((await app.commands.submit({ name: "file.restore-deleted", payload: { path: "retry.ts", branch: "b12" }, actor: "user" })).status).toBe("executed")
  const card = store.collections.cards.get("file-branch-b12-retry.ts")
  if (card?.kind !== "file") throw new Error("Missing file")
  expect(card.payload.content).toBe("recreated by Maya\n")
  expect(card.payload.file?.gone).toBeUndefined()
  expect(calls).toEqual([
    { path: "/api/branches/b12/files/retry.ts" },
    { path: "/api/branches/b12/files/retry.ts", body: { action: "restore-deleted", version: "delete-17", base_digest: "absent" } },
    { path: "/api/branches/b12/files/retry.ts" }
  ])
  await app.dispose()
})


test.each(["read_only", "live", "large"] as const)("install files.read retains a %s projection as read-only through CardRenderers without execution providers", async variant => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: string[] = []
  const text = variant === "large" ? "// retained line\n".repeat(1100) + "export const retry = 1\n" : "export const retry = 1\n"
  const model: FileCard = { ...first, branch: "main", last_writer: maya, mode: variant === "live" ? "live" : "read_only", content: { kind: "text", text } }
  const app = controller(store, agent, { bootstrap: { ...bootstrap, capabilities: ["install", "identity"] },
    fetchImpl: async input => {
      const url = String(input); requests.push(url)
      if (url === "/api/members") return json({ members: [{ login: "ben", name: "Ben", avatar_url: "https://example.com/ben.png", color_index: 0, role: "owner", needs_access: false, suspended: false, actions: [] }], access_url: "https://github.com/will/flows/settings/access" })
      if (url === "/api/branches/main/files/retry.ts") return json(model)
      return json({}, 404)
    }
  })
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host)
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: { bookmark: "main", changeId: "change123", commitId: "commit123" } }] }).isPersisted.promise
    expect((await app.commands.run("files.read", "retry.ts:1:2")).status).toBe("executed")
    const card = [...store.collections.cards.values()].find(card => card.kind === "file")
    if (card?.kind !== "file") throw new Error("Missing install File card")
    expect(card.payload.file).toEqual({ ...model, mode: "read_only", reveal: { line: 1, col: 1 } })
    expect(card.payload.digest).toBe("one")
    expect(card.payload.content).toBe(text)
    expect(card.payload.truncated).toBe(false)
    flushSync(() => root.render(createElement(ControllerContext.Provider, { value: app }, renderCardBody(card, noActions))))
    await wait(() => !!host.querySelector('[data-digest="one"]'))
    expect(host.textContent).toContain(variant === "large" ? "retained line" : "export const retry = 1")
    expect(host.querySelector('[role="img"][aria-label="Maya via SSH"]')).not.toBeNull()
    expect(host.querySelector('[data-mode="read_only"]')).not.toBeNull()
    expect(requests.filter(url => url.includes("retry.ts"))).toEqual(["/api/branches/main/files/retry.ts"])
    expect(requests.some(url => url.includes("sessions") || url.includes("wake"))).toBe(false)
    expect(app.commands.find("code.hover")).toBeUndefined()
  } finally { flushSync(() => root.unmount()); host.remove(); await app.dispose() }
})

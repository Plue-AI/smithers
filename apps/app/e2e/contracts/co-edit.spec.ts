import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createElement } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { EditorView } from "@codemirror/view"
import { LiveDocRelay } from "@smthrs/rpc/testing/LiveDocRelay"
import { LiveChannel, type LiveSocket } from "../../src/mainview/runtime/LiveChannel"
import { LiveDocProvider, type DocumentPrerequisites } from "../../src/mainview/runtime/LiveDocProvider"
import { LiveFileContext, liveBinding } from "../../src/mainview/cards/liveDoc"
import { renderCardBody } from "../../src/mainview/cards/CardRenderers"
import type { CardActions } from "../../src/mainview/cards/CardFamily"
import type { Card } from "../../src/mainview/state/AppState"

GlobalRegistrator.register()
afterAll(async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })
const ready: DocumentPrerequisites = { contract: true, actor: true, file: true, recovery: true, catalog: true, machine: true }
class Socket implements LiveSocket {
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  frames: (string | Uint8Array)[] = []
  send(data: string | Uint8Array) { this.frames.push(data) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  receive(data: unknown) { this.onmessage?.({ data }) }
}
const actions: CardActions = {
  onDecideApproval() {}, onConnectGitHub() {}, onRunWorkflow() {}, onStopRun() {}, onRetryRun() {},
  onChooseWorkflowRepo() {}, worldDocuments: [], onChangeWorldDocument() {}, onRunCommand() {}
}
const topic = "doc:code:T12:retry.ts"
const card: Extract<Card, { kind: "file" }> = { id: "file-retry", kind: "file", title: "retry.ts", status: "active", createdAt: 1, ordinal: 1,
  payload: { repo: "acme/repo", ref: "T12", path: "retry.ts", content: "seed fallback", truncated: false } }

test("TS fake relay replays literal golden frames through the sole channel and mounted File editor", async () => {
  const golden = JSON.parse(readFileSync(new URL("../../../../packages/backend/internal/compose/testdata/cocontracts/doc-browser.json", import.meta.url), "utf8")) as { frames: (string | number[])[] }
  const relay = new LiveDocRelay(golden.frames)
  const socket = new Socket(); let connections = 0
  const channel = new LiveChannel({ documentFrames: true, socket: () => { connections++; return socket } })
  const releases = Array.from({ length: 6 }, (_, n) => channel.subscribe(`branch:reserved-${n}`, () => {}))
  const provider = new LiveDocProvider(topic, channel, ready)
  socket.open()
  socket.receive(relay.next())
  expect(connections).toBe(1)
  expect(socket.frames.at(-1)).toEqual(Uint8Array.from([1, 0, 0, 0, 7, 0, 1, 0]))
  socket.receive(relay.next()); socket.receive(relay.next())
  const binding = liveBinding(provider.doc, {}, () => provider.editable)
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(createElement(LiveFileContext.Provider, {
      value: { resolve: (branch: string, path: string) => branch === "T12" && path === "retry.ts" ? { provider, binding } : undefined }
    }, renderCardBody(card, actions))))
    for (let i = 0; i < 100 && !host.querySelector(".cm-editor"); i++) await new Promise(resolve => setTimeout(resolve, 10))
    const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!
    flushSync(() => editor.dispatch({ changes: { from: 0, insert: "A" } }))
    expect(provider.saved).toBe("saving")
    for (let i = 3; i < 5; i++) socket.receive(relay.next())
    expect(editor.state.doc.toString()).toBe("A")
    socket.receive(relay.next())
    expect(provider.saved).toBe("saved")
    socket.receive(relay.next())
    expect(socket.frames.at(-1)).toEqual(Uint8Array.from([1, 0, 0, 0, 7, 0, 3, 1, 42, 1]))
    const before = socket.frames.length
    // A different subscription's saved or update cannot affect this document.
    socket.receive('{"t":"saved","id":99,"sv":"ASoB","seq":1}')
    socket.receive(Uint8Array.from([1, 0, 0, 0, 99, 2, 2, 0, 0]))
    socket.receive('{"t":"saved","id":7,"sv":"!","seq":1}')
    expect(editor.state.doc.toString()).toBe("A")
    socket.receive(relay.next())
    expect(provider.editable).toBe(false)
    expect(provider.setLine(1, "blue")).toBe(false)
    expect(socket.frames.length).toBe(before)
    expect(host.querySelector(".cm-ySelection")).toBeNull()
    const gone = relay.next()
    expect(gone).toBe('{"t":"gone","id":7,"data":{"kind":"deleted","by":{"id":"ben","kind":"person","member_id":"ben","via":"app"}}}')
    socket.receive(gone)
    expect(provider.editable).toBe(false)
    expect(editor.state.doc.toString()).toBe("A")
    const forbidden = relay.next()
    expect(forbidden).toBe('{"t":"err","id":7,"code":"forbidden"}')
    socket.receive(forbidden)
    expect(provider.editable).toBe(false)
    expect(editor.state.doc.toString()).toBe("A")
    expect(provider.unsaved).toBeUndefined()
    expect(socket.frames.length).toBe(before)
    expect(relay.next()).toBeUndefined()
  } finally {
    flushSync(() => root.unmount()); host.remove(); binding.dispose(); provider.dispose()
    for (const release of releases) release()
    channel.dispose()
  }
})

test("two File cards opened through files.read converge on literal 1000-edit packets, outside text and reconnect", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./co-edit.frames.json", import.meta.url), "utf8")) as {
    seed: number[]; frames: number[][]; outside: number[]; complete: number[]; saved: string; expected: string; outsideExpected: string
  }
  const { createAppStore } = await import("../../src/mainview/state/AppStore")
  const { createAppController } = await import("../../src/mainview/state/AppController")
  const { memoryStorage } = await import("../../src/mainview/state/TestFixtures")
  const { fileDocument, documentAuthors } = await import("../../src/mainview/cards/liveDoc")
  const resources: Array<() => void> = []
  const peers: Array<{ socket: Socket; sockets: Socket[]; channel: LiveChannel; provider: LiveDocProvider; editor: EditorView; reconnect(): Socket }> = []
  const relay = new LiveDocRelay(fixture.frames)
  try {
    for (const [login, clientId] of [["alice", 42], ["bob", 43]] as const) {
      const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
      const reads: string[] = []
      const controller = createAppController(store, {
        available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {}
      }, { fetchImpl: async input => {
        const path = String(input)
        if (path.startsWith("/api/repos/acme/repo/contents/retry.ts")) {
          reads.push(path); return Response.json({ path: "retry.ts", content: "", encoding: "", size: 0 })
        }
        return Response.json({ code: "not_found", message: "Unavailable" }, { status: 404 })
      } })
      resources.push(() => controller.dispose())
      await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login, admin: false, scopesPlain: null }).isPersisted.promise
      await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "acme/repo", org: "acme", ownerKind: "org", name: "repo", head: { bookmark: "main", changeId: "change-12", commitId: "commit-12" } }] }).isPersisted.promise
      expect((await controller.commands.run("files.read", "retry.ts acme/repo --ref T12")).status).toBe("executed")
      const opened = [...store.collections.cards.values()].find(item => item.kind === "file")!
      expect(opened).toMatchObject({ kind: "file", payload: { repo: "acme/repo", ref: "T12", path: "retry.ts", content: "" } })
      expect(reads).toEqual(["/api/repos/acme/repo/contents/retry.ts?ref=T12"])
      const sockets: Socket[] = []; let reconnect: (() => void) | undefined
      const channel = new LiveChannel({ documentFrames: true, socket: () => { const socket = new Socket(); sockets.push(socket); return socket },
        schedule: callback => { reconnect = callback; return callback }, cancel: () => {} })
      const provider = new LiveDocProvider(topic, channel, ready)
      const socket = sockets[0]!; socket.open()
      expect(socket.frames[0]).toBe('{"t":"sub","id":1,"topic":"doc:code:T12:retry.ts"}')
      socket.receive(JSON.stringify({ t: "snap", id: 1, cursor: 0, data: { epoch: "00112233445566778899aabbccddeeff", client_id: clientId } }))
      expect(provider.editable).toBe(false)
      socket.receive(new LiveDocRelay([fixture.seed]).next())
      expect(provider.editable).toBe(true)
      const resource = fileDocument(provider)
      const host = document.createElement("div"); document.body.append(host)
      const root = createRoot(host)
      resources.push(() => { flushSync(() => root.unmount()); host.remove(); resource.dispose(); channel.dispose() })
      flushSync(() => root.render(createElement(LiveFileContext.Provider, {
        value: { resolve: (branch: string, path: string) => branch === "T12" && path === "retry.ts" ? resource : undefined }
      }, renderCardBody(opened, actions))))
      for (let i = 0; i < 100 && !host.querySelector(".cm-editor"); i++) await new Promise(resolve => setTimeout(resolve, 10))
      const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!
      peers.push({ socket, sockets, channel, provider, editor, reconnect: () => { reconnect!(); const next = sockets.at(-1)!; next.open(); return next } })
    }
    for (let i = 0; i < 1000; i++) {
      const writer = peers[i % 2]!, reader = peers[(i + 1) % 2]!
      flushSync(() => writer.editor.dispatch({ changes: { from: writer.editor.state.doc.length, insert: i % 2 === 0 ? "A" : "B" }, userEvent: "input.type" }))
      expect(writer.socket.frames.at(-1)).toEqual(Uint8Array.from(fixture.frames[i]!))
      reader.socket.receive(relay.next())
    }
    expect(relay.next()).toBeUndefined()
    expect(peers[0]!.editor.state.doc.toString()).toBe(fixture.expected)
    expect(peers[1]!.editor.state.doc.toString()).toBe(fixture.expected)
    for (const peer of peers) {
      peer.socket.receive(new LiveDocRelay([fixture.outside]).next())
      expect(peer.editor.state.doc.toString()).toBe(fixture.outsideExpected)
      expect(documentAuthors(peer.provider.doc).at(-1)?.actor).toEqual({ kind: "outside", color_index: 7 })
      expect(peer.provider.saved).toBe("saving")
      expect(peer.editor.dom.querySelector("script, .cm-ySelection")).toBeNull()
    }
    expect((globalThis as Record<string, unknown>).__coeditExecuted).toBeUndefined()
    const a = peers[0]!, b = peers[1]!
    flushSync(() => a.editor.dispatch({ selection: { anchor: 1 } }))
    const awareness = a.socket.frames.at(-1) as Uint8Array
    expect([...awareness.subarray(0, 5)]).toEqual([2, 0, 0, 0, 1])
    b.socket.receive(awareness)
    expect(b.provider.awareness.getStates().get(42)).toEqual({ actor: { kind: "person", login: "alice", name: "Alice", avatar_url: "https://example.com/alice", color_index: 0 }, colour: "var(--lane-0)", line: 1 })
    a.socket.close(); a.socket.onclose?.()
    const resumed = a.reconnect()
    resumed.receive('{"t":"snap","id":1,"cursor":1,"data":{"epoch":"00112233445566778899aabbccddeeff","client_id":42}}')
    resumed.receive(new LiveDocRelay([fixture.complete]).next())
    resumed.receive('{"t":"gap","id":1}')
    expect(a.editor.state.doc.toString()).toBe(fixture.outsideExpected)
    expect(a.provider.saved).toBe("saving")
    // Saved metadata alone has not settled either member's pending updates.
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(a.provider.saved).toBe("saving")
    resumed.receive(JSON.stringify({ t: "saved", id: 1, sv: fixture.saved, seq: 1000 }))
    expect(a.provider.saved).toBe("saved")
    expect(a.sockets.length).toBe(2)
    resumed.receive('{"t":"err","id":1,"code":"forbidden"}')
    const count = resumed.frames.length
    flushSync(() => a.editor.dispatch({ changes: { from: 0, insert: "refused" }, userEvent: "input.type" }))
    expect(a.provider.doc.getText("content").toString()).toBe(fixture.outsideExpected)
    expect(resumed.frames.length).toBe(count)
  } finally { for (const dispose of resources.reverse()) dispose() }
}, 180_000)

test("File recovery buttons cross the registered dispatcher and branch transport without S2 writes", async () => {
  const { createAppStore } = await import("../../src/mainview/state/AppStore")
  const { createAppController } = await import("../../src/mainview/state/AppController")
  const { memoryStorage } = await import("../../src/mainview/state/TestFixtures")
  const { ControllerContext } = await import("../../src/mainview/ControllerContext")
  const { fileModel } = await import("../../src/mainview/cards/FileCards")
  const seed = (JSON.parse(readFileSync(new URL("./co-edit.frames.json", import.meta.url), "utf8")) as { seed: number[] }).seed
  const socket = new Socket()
  const channel = new LiveChannel({ documentFrames: true, socket: () => socket })
  const calls: Array<[string, unknown]> = []
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const model = { ...fileModel(card.payload), digest: "digest-17" }
  const controller = createAppController(store, {
    available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {}
  }, {
    live: channel, documentOptions: { channel, prerequisites: ready },
    branchOptions: { ready: () => true, scope: () => ({ branch: "T12", member: "alice", revision: 1, sleeping: false }) },
    fetchImpl: async (input, init) => {
      calls.push([String(input), init?.body ? JSON.parse(String(init.body)) : null])
      if (String(input).includes("/contents/retry.ts")) return Response.json({ path: "retry.ts", content: "seed fallback", encoding: "", size: 13 })
      if (init?.method === "POST") return Response.json({ code: "stale", message: "stale" }, { status: 409 })
      if (String(input).includes("compare=")) return Response.json({ before: "Maya's outside text", current: "Alice's live text" })
      return Response.json({ ...model, path: "src/renamed.ts" })
    }
  })
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "acme/repo", org: "acme", ownerKind: "org", name: "repo", head: { bookmark: "main", changeId: "change-12", commitId: "commit-12" } }] }).isPersisted.promise
    expect((await controller.commands.run("files.read", "retry.ts acme/repo --ref T12")).status).toBe("executed")
    const opened = [...store.collections.cards.values()].find(item => item.kind === "file")!
    expect(calls).toEqual([["/api/repos/acme/repo/contents/.smithers/factory.json", null], ["/api/repos/acme/repo/home", null], ["/api/repos/acme/repo/contents/retry.ts?ref=T12", null]])
    calls.length = 0
    const resource = controller.fileDocuments!.resolve("T12", "retry.ts")!
    socket.open()
    socket.receive('{"t":"snap","id":1,"cursor":0,"data":{"epoch":"00000000000000000000000000000001","client_id":42}}')
    socket.receive(new LiveDocRelay([seed]).next())
    resource.provider.doc.getText("content").insert(0, "Alice's retained document")
    const dispatches: Promise<unknown>[] = []
    const mountedActions = { ...actions, onRunCommand: (name: string, args?: string) => { dispatches.push(controller.runCommandForResult(name, args)) } }
    flushSync(() => root.render(createElement(ControllerContext.Provider, { value: controller }, renderCardBody(opened, mountedActions))))
    for (let i = 0; i < 100 && !host.querySelector(".cm-editor"); i++) await new Promise(resolve => setTimeout(resolve, 10))
    const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!
    flushSync(() => editor.dispatch({ selection: { anchor: 3 } }))
    expect(socket.frames.at(-1) instanceof Uint8Array).toBe(true)
    expect(resource.provider.awareness.getLocalState()).toEqual({ actor: { kind: "person", login: "alice", name: "Alice", avatar_url: "https://example.com/alice", color_index: 0 }, colour: "var(--lane-0)", line: 1 })
    socket.receive(JSON.stringify({ t: "snap", id: 2, cursor: 0, data: [{ path: "first.ts", change: "added", authors: [] }, { ...model, change: "modified", outside: { version: "outside-17", at: "2026-10-05T12:00:00Z" } }, { path: "last.ts", change: "deleted", authors: [] }] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    flushSync(() => root.render(createElement(ControllerContext.Provider, { value: controller }, renderCardBody(opened, mountedActions))))
    host.querySelector<HTMLButtonElement>('[data-flow="file.compare"]')!.click()
    await Promise.all(dispatches.splice(0))
    expect(calls).toEqual([["/api/branches/T12/files/retry.ts?compare=outside-17", null]])
    expect(editor.state.doc.toString()).toBe("Alice's retained document")
    expect(host.querySelector('[aria-label="Live and outside versions"]')?.textContent).toContain("Maya's outside text")
    expect(resource.provider.comparison).toEqual({ version: "outside-17", text: "Maya's outside text" })
    socket.receive('{"t":"delta","id":2,"cursor":1,"data":{"path":"retry.ts","saved_digest":"digest-17","saved_at":"2026-10-05T12:01:00Z","outside_change":{"version":"outside-18","by":{"outside":true}}}}')
    expect(resource.provider.file?.outside).toEqual({ version: "outside-18", at: "2026-10-05T12:01:00Z" })
    expect(resource.provider.saved).toBe("saving")
    expect(channel.getSnapshot("branch:T12:files")?.data).toMatchObject({ rows: [{ path: "first.ts", change: "added", authors: [] }, { path: "retry.ts", change: "modified", authors: [] }, { path: "last.ts", change: "deleted", authors: [] }] })
    socket.receive('{"t":"delta","id":2,"cursor":2,"data":{"path":"retry.ts"}}')
    expect(resource.provider.file?.outside).toBeUndefined()
    expect(resource.provider.comparison).toBeUndefined()
    resource.provider.setFile({ ...model, gone: { kind: "deleted", by: { kind: "outside", color_index: 7 } } })
    flushSync(() => root.render(createElement(ControllerContext.Provider, { value: controller }, renderCardBody(opened, mountedActions))))
    expect(resource.provider.editable).toBe(false)
    host.querySelector<HTMLButtonElement>('[data-flow="file.restore-deleted"]')!.click()
    await Promise.all(dispatches.splice(0))
    expect(calls.at(-1)).toEqual(["/api/branches/T12/files/retry.ts", { action: "restore-deleted", text: "Alice's retained document", base_digest: "absent" }])
    expect(calls.length).toBe(2)
    resource.provider.setFile({ ...model, gone: { kind: "renamed", to: "src/renamed.ts", by: { kind: "outside", color_index: 7 } } })
    flushSync(() => root.render(createElement(ControllerContext.Provider, { value: controller }, renderCardBody(opened, mountedActions))))
    host.querySelector<HTMLButtonElement>('[data-flow="file.follow-rename"]')!.click()
    await Promise.all(dispatches.splice(0))
    expect(calls.at(-1)).toEqual(["/api/branches/T12/files/src/renamed.ts", null])
    expect(store.collections.cards.get(opened.id)).toMatchObject({ kind: "file", payload: { path: "src/renamed.ts", ref: "T12", content: "seed fallback" } })
    expect(socket.frames).toContain('{"t":"sub","id":3,"topic":"doc:code:T12:src/renamed.ts"}')
    resource.provider.setFile(model)
    socket.receive('{"t":"snap","id":1,"cursor":1,"data":{"epoch":"00000000000000000000000000000002","client_id":42}}')
    socket.receive(new LiveDocRelay([seed]).next())
    expect(resource.provider.unsaved?.text).toBe("Alice's retained document")
    expect(await resource.provider.copy(async () => ({ ok: false, code: "clipboard-write-failed", cause: "denied" }))).toBe(false)
    expect(resource.provider.unsaved?.text).toBe("Alice's retained document")
    flushSync(() => root.render(createElement(ControllerContext.Provider, { value: controller }, renderCardBody(opened, mountedActions))))
    host.querySelector<HTMLButtonElement>('[data-flow="file.reapply"]')!.click()
    await Promise.all(dispatches.splice(0))
    expect(resource.provider.doc.getText("content").toString()).toBe("Alice's retained document")
    expect(resource.provider.unsaved?.text).toBe("Alice's retained document")
    // Client 42 inserted 25 retained characters in the new epoch; only the covering vector clears recovery.
    socket.receive('{"t":"saved","id":1,"sv":"ASoA","seq":1}')
    expect(resource.provider.unsaved?.text).toBe("Alice's retained document")
    socket.receive('{"t":"saved","id":1,"sv":"ASoZ","seq":1}')
    expect(resource.provider.unsaved).toBeUndefined()
    resource.provider.setFile({ ...model, gone: { kind: "deleted", by: { kind: "outside", color_index: 7 } } })
    socket.receive('{"t":"err","id":2,"code":"forbidden"}')
    const requestsBeforeRevokedRestore = calls.length
    expect((await controller.runCommandForResult("file.restore-deleted", '{"path":"retry.ts"}')).status).toBe("failed")
    expect(calls.length).toBe(requestsBeforeRevokedRestore)
  } finally { flushSync(() => root.unmount()); host.remove(); await controller.dispose(); channel.dispose() }
})

test("the mounted Copy control retains recovery on failure and clears it only after clipboard success", async () => {
  const seed = (JSON.parse(readFileSync(new URL("./co-edit.frames.json", import.meta.url), "utf8")) as { seed: number[] }).seed
  const { fileDocument } = await import("../../src/mainview/cards/liveDoc")
  const socket = new Socket(), channel = new LiveChannel({ documentFrames: true, socket: () => socket })
  const provider = new LiveDocProvider(topic, channel, ready), resource = fileDocument(provider)
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  let fail = true
  const copied: string[] = []
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => {
    if (fail) throw new Error("denied")
    copied.push(text)
  } } })
  try {
    socket.open()
    socket.receive('{"t":"snap","id":1,"cursor":0,"data":{"epoch":"00000000000000000000000000000001","client_id":42}}')
    socket.receive(new LiveDocRelay([seed]).next())
    provider.doc.getText("content").insert(0, "retained bytes")
    socket.receive('{"t":"snap","id":1,"cursor":1,"data":{"epoch":"00000000000000000000000000000002","client_id":42}}')
    socket.receive(new LiveDocRelay([seed]).next())
    const mount = () => flushSync(() => root.render(createElement(LiveFileContext.Provider, { value: { resolve: () => resource } }, renderCardBody(card, actions))))
    mount()
    for (let i = 0; i < 100 && !host.querySelector(".cm-editor"); i++) await new Promise(resolve => setTimeout(resolve, 10))
    const copies = () => [...host.querySelectorAll<HTMLButtonElement>("button")].filter(button => button.textContent === "Copy")
    expect(copies().length).toBe(1)
    const frames = socket.frames.length
    copies()[0]!.click()
    await new Promise(resolve => setTimeout(resolve, 0)); mount()
    expect(provider.unsaved).toEqual({ count: 1, text: "retained bytes" })
    expect(host.textContent).toContain("Copy failed")
    expect(copied).toEqual([])
    expect(socket.frames.length).toBe(frames)
    fail = false
    copies()[0]!.click()
    await new Promise(resolve => setTimeout(resolve, 0)); mount()
    expect(copied).toEqual(["retained bytes"])
    expect(provider.unsaved).toBeUndefined()
    expect(copies().length).toBe(0)
    expect(socket.frames.length).toBe(frames)
  } finally {
    if (previous) Object.defineProperty(navigator, "clipboard", previous)
    else Reflect.deleteProperty(navigator, "clipboard")
    flushSync(() => root.unmount()); host.remove(); resource.dispose(); channel.dispose()
  }
}, 180_000)

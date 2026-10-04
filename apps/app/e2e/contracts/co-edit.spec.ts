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
    socket.receive('{"t":"saved","id":99,"sv":"ASoB","at":"2026-10-03T12:00:00Z"}')
    socket.receive(Uint8Array.from([1, 0, 0, 0, 99, 2, 2, 0, 0]))
    socket.receive('{"t":"saved","id":7,"sv":"!","at":"2026-10-03T12:00:00Z"}')
    expect(editor.state.doc.toString()).toBe("A")
    socket.receive(relay.next())
    expect(provider.editable).toBe(false)
    expect(provider.setLine(1, "blue")).toBe(false)
    expect(socket.frames.length).toBe(before)
    expect(host.querySelector(".cm-ySelection")).toBeNull()
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
    const a = peers[0]!
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
    resumed.receive(JSON.stringify({ t: "saved", id: 1, sv: fixture.saved, at: "2026-10-04T12:00:00Z" }))
    expect(a.provider.saved).toBe("saved")
    expect(a.sockets.length).toBe(2)
    resumed.receive('{"t":"err","id":1,"code":"forbidden"}')
    const count = resumed.frames.length
    flushSync(() => a.editor.dispatch({ changes: { from: 0, insert: "refused" }, userEvent: "input.type" }))
    expect(a.provider.doc.getText("content").toString()).toBe(fixture.outsideExpected)
    expect(resumed.frames.length).toBe(count)
  } finally { for (const dispose of resources.reverse()) dispose() }
}, 30_000)

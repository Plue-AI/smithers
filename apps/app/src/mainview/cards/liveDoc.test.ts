import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import * as Y from "yjs"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { authorRanges, documentAuthors, documentEditors, liveBinding } from "./liveDoc"
GlobalRegistrator.register()
afterAll(() => GlobalRegistrator.unregister())
const alice = { kind: "person", login: "alice", name: "Alice", avatar_url: "https://example.com/alice", color_index: 0 } as const
const bob = { kind: "person", login: "bob", name: "Bob", avatar_url: "https://example.com/bob", color_index: 1 } as const
test("pinned Yjs items retain two authors and omit deleted characters", () => {
  const a = new Y.Doc(); a.clientID = 7; a.getMap("authors").set("7", alice); a.getText("content").insert(0, "abc")
  const b = new Y.Doc(); b.clientID = 8; Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); b.getMap("authors").set("8", bob); b.getText("content").insert(3, "def")
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b)); a.getText("content").delete(1, 1)
  expect(a.getText("content").toString()).toBe("acdef")
  expect(documentAuthors(a)).toEqual([{ from: 0, to: 1, actor: alice }, { from: 1, to: 2, actor: alice }, { from: 2, to: 5, actor: bob }])
  expect(documentEditors(new Map([[7, { actor: alice, line: 1 }], [8, { actor: bob, line: 2, selection: "ignored" }], [9, { actor: bob, line: 0 }]]), 7)).toEqual([{ actor: bob, line: 2 }])
  a.destroy(); b.destroy()
})
test("real editor binding has no remote selections and undo reverts only local typing", async () => {
  const doc = new Y.Doc(); doc.clientID = 7
  doc.getMap("authors").set("7", alice)
  const binding = liveBinding(doc)
  const host = document.createElement("div"); document.body.append(host)
  const view = new EditorView({ parent: host, state: EditorState.create({ extensions: binding.extensions }) })
  view.dispatch({ changes: { from: 0, insert: "local" } })
  const remote = new Y.Doc(); remote.clientID = 8; Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc)); remote.getMap("authors").set("8", bob); remote.getText("content").insert(5, " remote")
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote), "remote")
  expect(view.state.doc.toString()).toBe("local remote")
  binding.undo.undo()
  expect(view.state.doc.toString()).toBe(" remote")
  await Promise.resolve()
  expect(view.state.facet(authorRanges)).toEqual([{ from: 0, to: 7, actor: bob }])
  expect(host.querySelector(".cm-ySelection")).toBeNull()
  view.destroy(); host.remove(); binding.dispose(); doc.destroy(); remote.destroy()
})
test("the file model selects live data only with authenticated editable text; gone and large stay read-only", () => {
  const { LiveDocProvider } = require("../runtime/LiveDocProvider") as typeof import("../runtime/LiveDocProvider")
  const { liveFileModel } = require("./liveDoc") as typeof import("./liveDoc")
  const provider = new LiveDocProvider("doc:code:T12:retry.ts")
  const model = { path: "retry.ts", branch: "T12", language: "typescript", digest: "literal", content: { kind: "text" as const, text: "seed" }, mode: "live" as const, diagnostics: [], authors: [], editors: [] }
  expect(liveFileModel(model, provider)).toEqual({ ...model, mode: "read_only" })
  provider.dispose()
})

test("UI, app and RPC share the exact private-item traversal pin", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs")
  for (const path of ["../../../../../packages/smithers/ui/package.json", "../../../../../packages/rpc/package.json", "../../../package.json"]) {
    const manifest = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"))
    expect(manifest.dependencies.yjs).toBe("13.6.32")
  }
})
test("served document size, binary and gone metadata all refuse a live binding", () => {
  const { LiveDocProvider } = require("../runtime/LiveDocProvider") as typeof import("../runtime/LiveDocProvider")
  const { liveFileModel } = require("./liveDoc") as typeof import("./liveDoc")
  let receive!: (event: import("../runtime/LiveDocProvider").DocumentEvent) => void
  const provider = new LiveDocProvider("doc:code:T12:retry.ts", { subscribeDocument(_topic, callback) {
    receive = callback; return { send() {}, release() {} }
  } }, { contract: true, actor: true, file: true, recovery: true, catalog: true, machine: true })
  receive({ kind: "assigned", epoch: "00000000000000000000000000000001", clientId: 7 })
  receive({ kind: "sync", payload: Uint8Array.from([1, 2, 0, 0]) })
  const model = { path: "retry.ts", branch: "T12", language: "typescript", digest: "literal", content: { kind: "text" as const, text: "seed" }, mode: "live" as const, diagnostics: [], authors: [], editors: [] }
  provider.doc.getText("content").insert(0, "served")
  expect(liveFileModel(model, provider).mode).toBe("live")
  expect(liveFileModel({ ...model, content: { kind: "binary", bytes: 12 } }, provider).mode).toBe("read_only")
  expect(liveFileModel({ ...model, gone: { kind: "deleted", by: bob } }, provider).mode).toBe("read_only")
  provider.doc.getText("content").insert(6, "a".repeat(1_200_000))
  const large = liveFileModel(model, provider)
  expect(large.mode).toBe("read_only"); expect(large.content.kind).toBe("too_large")
  provider.dispose()
})

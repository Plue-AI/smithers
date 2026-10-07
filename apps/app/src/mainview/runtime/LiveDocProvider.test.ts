import { expect, test } from "bun:test"
import * as Y from "yjs"
import * as sync from "y-protocols/sync"
import * as encoding from "lib0/encoding"
import * as decoding from "lib0/decoding"
import { LiveDocProvider, type DocumentEvent, type DocumentChannel, type DocumentPrerequisites } from "./LiveDocProvider"
const ready: DocumentPrerequisites = { contract: true, actor: true, file: true, recovery: true, catalog: true, machine: true }
function fixture(prerequisites = ready) {
  const sent: Uint8Array[] = []; let receives: ((event: DocumentEvent) => void) | undefined; let released = 0
  const channel: DocumentChannel = { subscribeDocument(topic, receive) {
    expect(topic).toBe("doc:code:T12:retry.ts"); receives = receive
    return { send: (_kind, payload) => { sent.push(payload) }, release: () => { released++ } }
  } }
  const provider = new LiveDocProvider("doc:code:T12:retry.ts", channel, prerequisites)
  return { provider, sent, event: (event: DocumentEvent) => { receives?.(event); if (event.kind === "assigned") receives?.({ kind: "sync", payload: Uint8Array.from([1, 2, 0, 0]) }) }, get released() { return released } }
}
const epoch = "00000000000000000000000000000001"
test("every missing prerequisite refuses subscription and edits", () => {
  for (const key of Object.keys(ready) as (keyof DocumentPrerequisites)[]) {
    const f = fixture({ ...ready, [key]: false })
    expect(f.provider.editable).toBe(false); expect(f.sent).toEqual([])
    f.provider.dispose(); expect(f.released).toBe(0)
  }
  const p = new LiveDocProvider("doc:code:T12:retry.ts")
  expect(p.editable).toBe(false); p.dispose()
})
test("same epoch reconnect resends exactly once per restart and saved vectors alone cover local clocks", () => {
  const f = fixture(); f.event({ kind: "assigned", epoch, clientId: 7 })
  f.provider.doc.getText("content").insert(0, "retry")
  expect(f.provider.saved).toBe("saving")
  f.event({ kind: "saved", seq: 1, vector: new Uint8Array([1, 7, 4]) })
  expect(f.provider.saved).toBe("saving")
  f.event({ kind: "saved", seq: 1, vector: new Uint8Array([255]) })
  expect(f.provider.saved).toBe("saving")
  const before = f.sent.length
  f.event({ kind: "assigned", epoch, clientId: 7 })
  expect(f.sent.length - before).toBe(2)
  expect(f.sent.at(-1)).toEqual(f.sent[1])
  expect(f.provider.doc.getText("content").toString()).toBe("retry")
  f.event({ kind: "saved", seq: 1, vector: new Uint8Array([1, 7, 5]) })
  expect(f.provider.saved).toBe("saved"); f.provider.dispose(); expect(f.released).toBe(1)
})
test("new epoch retains text; reapply clears only on covering save", () => {
  const f = fixture(); f.event({ kind: "assigned", epoch, clientId: 7 })
  f.provider.doc.getText("content").insert(0, "<script>inert</script>")
  f.event({ kind: "assigned", epoch: "00000000000000000000000000000002", clientId: 8 })
  expect(f.provider.unsaved).toEqual({ count: 1, text: "<script>inert</script>" })
  expect(f.provider.doc.getText("content").toString()).toBe("")
  expect(f.provider.editable).toBe(false)
  expect(f.provider.reapply()).toBe(true); expect(f.provider.reapply()).toBe(false)
  expect(f.provider.doc.getText("content").toString()).toBe("<script>inert</script>")
  f.event({ kind: "saved", seq: 1, vector: new Uint8Array([1, 8, 1]) }); expect(f.provider.unsaved?.count).toBe(1)
  f.event({ kind: "saved", seq: 1, vector: Y.encodeStateVector(f.provider.doc) }); expect(f.provider.unsaved).toBeUndefined()
  expect(f.provider.editable).toBe(true); f.provider.dispose()
})
test("revocation stops sending and failed clipboard preserves retained text", async () => {
  const f = fixture(); f.event({ kind: "assigned", epoch, clientId: 7 })
  f.provider.doc.getText("content").insert(0, "unsaved")
  f.event({ kind: "refused" }); const count = f.sent.length
  f.event({ kind: "restart" }); f.event({ kind: "saved", seq: 1, vector: Y.encodeStateVector(f.provider.doc) })
  expect(f.sent.length).toBe(count); expect(f.provider.editable).toBe(false)
  await expect(f.provider.copy(async () => { throw new Error("clipboard refused") })).rejects.toThrow("clipboard refused")
  expect(f.provider.unsaved).toEqual({ count: 1, text: "unsaved" })
  expect(await f.provider.copy(async () => ({ ok: false, code: "clipboard-unavailable", cause: undefined }))).toBe(false)
  expect(f.provider.unsaved?.text).toBe("unsaved")
  expect(await f.provider.copy(async text => { expect(text).toBe("unsaved"); return { ok: true } })).toBe(true)
  expect(f.provider.unsaved).toBeUndefined(); f.provider.dispose()
})
test("malformed identity cannot start a document", () => {
  const f = fixture(); f.event({ kind: "assigned", epoch: "bad", clientId: 7 })
  expect(f.sent).toEqual([]); expect(f.provider.editable).toBe(false); f.provider.dispose()
})
test("awareness uses only the authenticated authors map and drops after revocation", () => {
  const f = fixture(); f.event({ kind: "assigned", epoch, clientId: 7 })
  expect(f.provider.setLine(3, "blue")).toBe(false)
  f.provider.doc.getMap("authors").set("7", { person: "alice" })
  expect(f.provider.setLine(3, "blue")).toBe(true)
  expect(f.provider.awareness.getLocalState()).toEqual({ actor: { person: "alice" }, colour: "blue", line: 3 })
  expect(f.provider.setLine(0, "blue")).toBe(false)
  f.event({ kind: "refused" }); const count = f.sent.length
  expect(f.provider.setLine(4, "blue")).toBe(false); expect(f.sent.length).toBe(count)
  f.provider.dispose()
})

// Protocol unit harness only: this is not T-COL-08b's unlanded fake relay or a persistence check.
test("two protocol clients converge over 1000 interleaved edits and restart", () => {
  const authority = new Y.Doc()
  const receivers: Array<(event: DocumentEvent) => void> = []
  const channel: DocumentChannel = { subscribeDocument(_topic, receive) {
    receivers.push(receive)
    return { release() {}, send(kind, payload) {
      if (kind !== 1) return
      const response = encoding.createEncoder()
      sync.readSyncMessage(decoding.createDecoder(payload), response, authority, "client")
      if (encoding.length(response)) receive({ kind: "sync", payload: encoding.toUint8Array(response) })
    } }
  } }
  authority.on("update", update => {
    const frame = encoding.createEncoder(); sync.writeUpdate(frame, update)
    for (const receive of receivers) receive({ kind: "sync", payload: encoding.toUint8Array(frame) })
  })
  const a = new LiveDocProvider("doc:code:T12:retry.ts", channel, ready)
  const b = new LiveDocProvider("doc:code:T12:retry.ts", channel, ready)
  receivers[0]!({ kind: "assigned", epoch, clientId: 7 })
  receivers[1]!({ kind: "assigned", epoch, clientId: 8 })
  for (let i = 0; i < 500; i++) {
    a.doc.getText("content").insert(a.doc.getText("content").length, "A")
    b.doc.getText("content").insert(b.doc.getText("content").length, "B")
  }
  receivers[0]!({ kind: "restart" })
  receivers[1]!({ kind: "assigned", epoch, clientId: 8 })
  const expected = "ABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABAB"
  expect(a.doc.getText("content").toString()).toBe(expected)
  expect(b.doc.getText("content").toString()).toBe(expected)
  expect(authority.getText("content").toString()).toBe(expected)
  a.dispose(); b.dispose(); authority.destroy()
})

test("pre-assignment edits cannot be transmitted with a browser-generated client id", () => {
  const f = fixture()
  f.provider.doc.getText("content").insert(0, "retained")
  expect(f.sent).toEqual([])
  f.event({ kind: "assigned", epoch, clientId: 7 })
  expect(f.provider.doc.getText("content").toString()).toBe("")
  expect(f.sent.length).toBe(1)
  expect(f.provider.unsaved).toEqual({ count: 1, text: "retained" })
  expect(f.provider.reapply()).toBe(true)
  expect(f.provider.doc.clientID).toBe(7)
  f.provider.dispose(); f.provider.dispose(); expect(f.released).toBe(1)
})
test("same-epoch authorization recovery clears retained text only after the resends are saved", () => {
  const f = fixture(); f.event({ kind: "assigned", epoch, clientId: 7 })
  f.provider.doc.getText("content").insert(0, "retry")
  f.event({ kind: "refused" })
  expect(f.provider.unsaved).toEqual({ count: 1, text: "retry" })
  f.event({ kind: "assigned", epoch, clientId: 7 })
  expect(f.provider.unsaved?.text).toBe("retry")
  f.event({ kind: "saved", seq: 1, vector: Uint8Array.from([1, 7, 5]) })
  expect(f.provider.unsaved).toBeUndefined(); expect(f.provider.saved).toBe("saved")
  f.provider.dispose()
})
test("the same provider retains the wiki's markdown root without creating a second transport", () => {
  let receive!: (event: DocumentEvent) => void
  const provider = new LiveDocProvider("doc:wiki:page", { subscribeDocument(topic, callback) {
    expect(topic).toBe("doc:wiki:page"); receive = callback; return { send() {}, release() {} }
  } }, ready)
  receive({ kind: "assigned", epoch, clientId: 7 })
  receive({ kind: "sync", payload: Uint8Array.from([1, 2, 0, 0]) })
  provider.doc.getText("markdown").insert(0, "wiki text")
  receive({ kind: "refused" })
  expect(provider.unsaved).toEqual({ count: 1, text: "wiki text" })
  expect(provider.doc.share.has("content")).toBe(false)
  provider.dispose()
})

test("delete-only edits need a sequence receipt even when the saved vector is unchanged", () => {
  const f = fixture(); f.event({ kind: "assigned", epoch, clientId: 7 })
  const text = f.provider.doc.getText("content")
  text.insert(0, "keep")
  const vector = Y.encodeStateVector(f.provider.doc)
  f.event({ kind: "saved", seq: 1, vector }); expect(f.provider.saved).toBe("saved")
  text.delete(0, 4)
  expect(Y.encodeStateVector(f.provider.doc)).toEqual(vector)
  f.event({ kind: "saved", seq: 1, vector }); expect(f.provider.saved).toBe("saving")
  f.event({ kind: "saved", seq: 3, vector }); expect(f.provider.saved).toBe("saving")
  f.event({ kind: "saved", seq: 2, vector }); expect(f.provider.saved).toBe("saved")
  f.provider.dispose()
})

test("Reapply preserves new-epoch edits and opens Compare on overlapping replacement", async () => {
  for (const current of ["remote hello world", "hello changed"]) {
    const f = fixture(); f.event({ kind: "assigned", epoch, clientId: 7 })
    const seed = new Y.Doc(); seed.getText("content").insert(0, "hello world")
    const frame = encoding.createEncoder(); sync.writeSyncStep2(frame, seed)
    f.event({ kind: "sync", payload: encoding.toUint8Array(frame) })
    f.provider.doc.getText("content").delete(6, 5)
    f.provider.doc.getText("content").insert(6, "friend")
    f.event({ kind: "assigned", epoch: "00000000000000000000000000000002", clientId: 8 })
    const next = new Y.Doc(); next.getText("content").insert(0, current)
    const response = encoding.createEncoder(); sync.writeSyncStep2(response, next)
    f.event({ kind: "sync", payload: encoding.toUint8Array(response) })
    if (current.startsWith("remote")) {
      expect(f.provider.reapply()).toBe(true)
      expect(f.provider.doc.getText("content").toString()).toBe("remote hello friend")
      expect(f.provider.unsaved?.text).toBe("hello friend")
      f.event({ kind: "saved", seq: 1, vector: Y.encodeStateVector(f.provider.doc) })
      expect(f.provider.unsaved).toBeUndefined()
    } else {
      expect(f.provider.reapply()).toBe(false)
      expect(f.provider.doc.getText("content").toString()).toBe("hello changed")
      expect(f.provider.comparison).toEqual({ version: "unsaved", text: "hello friend" })
      f.provider.setFile({ path: "retry.ts", branch: "T12", language: "typescript", digest: "new", content: { kind: "text", text: "old card" }, mode: "read_only", authors: [], editors: [], diagnostics: [] })
      expect(f.provider.comparison).toEqual({ version: "unsaved", text: "hello friend" })
      const { liveFileModel } = require("../cards/liveDoc") as typeof import("../cards/liveDoc")
      expect(liveFileModel(f.provider.file!, f.provider).content).toEqual({ kind: "text", text: "hello changed" })
      expect(await f.provider.copy(async () => ({ ok: true }))).toBe(true)
      expect(f.provider.comparison).toBeUndefined()
      expect(f.provider.unsaved).toBeUndefined()
    }
    f.provider.dispose(); seed.destroy(); next.destroy()
  }
})

test("caret positions use the wire JSON shape and authenticated remote names", async () => {
  const a = fixture(), b = fixture()
  a.event({ kind: "assigned", epoch, clientId: 7 }); b.event({ kind: "assigned", epoch, clientId: 8 })
  a.provider.doc.getText("content").insert(0, "hello")
  const seed = encoding.createEncoder(); sync.writeSyncStep2(seed, a.provider.doc)
  b.event({ kind: "sync", payload: encoding.toUint8Array(seed) })
  a.provider.doc.getMap("authors").set("7", { id: "alice", kind: "person", member_id: "alice", via: "app" })
  expect(a.provider.setLine(1, "#123456")).toBe(true)
  const position = Y.createRelativePositionFromTypeIndex(a.provider.doc.getText("content"), 5)
  a.provider.awareness.setLocalStateField("cursor", { anchor: position, head: position })
  await new Promise(resolve => setTimeout(resolve, 70))
  b.event({ kind: "awareness", payload: a.sent.at(-1)! })
  const remote = b.provider.awareness.getStates().get(7)!
  expect(remote.user).toEqual({ name: "alice", color: "#123456" })
  expect(Y.createAbsolutePositionFromRelativePosition(remote.cursor.head, b.provider.doc)?.index).toBe(5)
  a.provider.dispose(); b.provider.dispose()
})

test("reload retains unreceipted text until Reapply is receipted or Copy succeeds", async () => {
  let record: unknown
  const storage = { read: () => record, write: (value: unknown) => { record = value } }
  let receive!: (event: DocumentEvent) => void
  const channel: DocumentChannel = { subscribeDocument(_topic, callback) { receive = callback; return { send() {}, release() {} } } }
  const first = new LiveDocProvider("doc:code:T12:retry.ts", channel, ready, storage)
  receive({ kind: "assigned", epoch, clientId: 7 }); receive({ kind: "sync", payload: Uint8Array.from([1, 2, 0, 0]) })
  first.doc.getText("content").insert(0, "retained")
  expect(record).toMatchObject({ count: 1, text: "retained", base: "", epoch })
  first.dispose()
  const second = new LiveDocProvider("doc:code:T12:retry.ts", channel, ready, storage)
  expect(second.unsaved).toEqual({ count: 1, text: "retained" })
  receive({ kind: "assigned", epoch, clientId: 8 }); receive({ kind: "sync", payload: Uint8Array.from([1, 2, 0, 0]) })
  receive({ kind: "saved", seq: 0, vector: Y.encodeStateVector(second.doc) })
  expect(second.unsaved?.text).toBe("retained")
  expect(second.reapply()).toBe(true)
  expect(record).toMatchObject({ text: "retained" })
  receive({ kind: "saved", seq: 1, vector: Y.encodeStateVector(second.doc) })
  expect(record).toBeUndefined()
  second.dispose()
})

test("line awareness coalesces at 50 ms and repeated coordinates emit no frame", async () => {
  const f = fixture(); f.event({ kind: "assigned", epoch, clientId: 7 })
  f.provider.doc.getMap("authors").set("7", { person: "alice" })
  const count = f.sent.length
  f.provider.setLine(1, "blue"); f.provider.setLine(2, "blue"); f.provider.setLine(3, "blue")
  expect(f.sent.length).toBe(count)
  await new Promise(resolve => setTimeout(resolve, 70))
  expect(f.sent.length).toBe(count + 1)
  f.provider.setLine(3, "blue")
  await new Promise(resolve => setTimeout(resolve, 70))
  expect(f.sent.length).toBe(count + 1)
  f.provider.dispose()
})

test("Reapply after reload does not duplicate text already in the host mirror", () => {
  let record: unknown = { count: 1, text: "retained", base: "", epoch }
  let receive!: (event: DocumentEvent) => void
  const provider = new LiveDocProvider("doc:code:T12:retry.ts", { subscribeDocument(_topic, callback) {
    receive = callback; return { send() {}, release() {} }
  } }, ready, { read: () => record, write: value => { record = value } })
  receive({ kind: "assigned", epoch, clientId: 8 })
  const mirror = new Y.Doc(); mirror.getText("content").insert(0, "retained")
  const frame = encoding.createEncoder(); sync.writeSyncStep2(frame, mirror)
  receive({ kind: "sync", payload: encoding.toUint8Array(frame) })
  expect(provider.reapply()).toBe(true)
  expect(provider.doc.getText("content").toString()).toBe("retained")
  expect(provider.saved).toBe("saving")
  receive({ kind: "saved", seq: 1, vector: Y.encodeStateVector(provider.doc) })
  expect(record).toBeUndefined()
  provider.dispose(); mirror.destroy()
})

test("a replacement authenticated client retains old-id updates rather than forging them", () => {
  const f = fixture(); f.event({ kind: "assigned", epoch, clientId: 7 })
  f.provider.doc.getText("content").insert(0, "pending")
  const before = f.sent.length
  f.event({ kind: "assigned", epoch, clientId: 8 })
  expect(f.sent.length - before).toBe(1)
  expect(f.provider.unsaved).toEqual({ count: 1, text: "pending" })
  expect(f.provider.editable).toBe(false)
  expect(f.provider.reapply()).toBe(true)
  expect(f.provider.doc.getText("content").toString()).toBe("pending")
  f.event({ kind: "saved", seq: 1, vector: Y.encodeStateVector(f.provider.doc) })
  expect(f.provider.unsaved).toBeUndefined()
  f.provider.dispose()
})

test("durable wiki edits wait for storage before send and reload replays under the same assigned identity", async () => {
  let receive!: (event: DocumentEvent) => void
  const sent: Uint8Array[] = []
  let release!: () => void
  let hold = false
  let stored: import("./LiveDocProvider").DurableDocument | undefined
  const channel: DocumentChannel = { subscribeDocument(_topic, listener, clientId) {
    receive = listener
    if (stored) expect(clientId).toBe(7)
    return { send(_kind, bytes) { sent.push(bytes) }, release() {} }
  } }
  const persistence = { save: async (value: import("./LiveDocProvider").DurableDocument) => {
    if (hold) await new Promise<void>(resolve => { release = resolve })
    stored = value
  } }
  const p = new LiveDocProvider("doc:wiki:42", channel, ready, persistence)
  receive({ kind: "assigned", epoch, clientId: 7 })
  receive({ kind: "sync", payload: Uint8Array.from([1, 2, 0, 0]) })
  await new Promise(resolve => setTimeout(resolve, 0))
  hold = true
  p.doc.getText("markdown").insert(0, "offline")
  const before = sent.length
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(sent.length).toBe(before)
  hold = false; release()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(sent.length).toBe(before + 1)
  expect(stored!.pending).toHaveLength(1)
  p.dispose()
  const reloaded = new LiveDocProvider("doc:wiki:42", channel, ready, { ...persistence, initial: stored! })
  const prior = sent.length
  receive({ kind: "assigned", epoch, clientId: 7 })
  receive({ kind: "sync", payload: Uint8Array.from([1, 2, 0, 0]) })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(sent.length).toBe(prior + 2)
  expect(reloaded.doc.getText("markdown").toString()).toBe("offline")
  receive({ kind: "saved", vector: Y.encodeStateVector(reloaded.doc), seq: 0 })
  expect(reloaded.saved).toBe("saving")
  receive({ kind: "saved", vector: Y.encodeStateVector(reloaded.doc), seq: 1 })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(stored!.pending).toHaveLength(0)
  reloaded.dispose()

})

// Admission prepares a causal delta before persistence; committing that delta
// is a local transaction rather than synchronization with another replica.
test("a prepared local wiki delta keeps the host-assigned client id", () => {
  let receive!: (event: DocumentEvent) => void
  const provider = new LiveDocProvider("doc:wiki:42", { subscribeDocument(_topic, listener) { receive = listener; return { send() {}, release() {} } } }, ready)
  receive({ kind: "assigned", epoch, clientId: 7 })
  receive({ kind: "sync", payload: Uint8Array.from([1, 2, 0, 0]) })
  const draft = new Y.Doc(); draft.clientID = 7; draft.getText("markdown").insert(0, "admitted")
  provider.doc.transact(transaction => { Y.applyUpdate(provider.doc, Y.encodeStateAsUpdate(draft)); transaction.local = true })
  expect(provider.doc.clientID).toBe(7)
  receive({ kind: "saved", seq: 1, vector: Y.encodeStateVector(provider.doc) })
  expect(provider.saved).toBe("saved")
  provider.dispose(); draft.destroy()
})

test("remote text reaches its editor subscription before local persistence finishes", async () => {
  let receive!: (event: DocumentEvent) => void
  let release!: () => void
  const held = new Promise<void>(done => { release = done })
  let writes = 0
  const provider = new LiveDocProvider("doc:wiki:42", { subscribeDocument(_topic, listener) { receive = listener; return { send() {}, release() {} } } }, ready, { save: async () => { await held; writes++ } })
  receive({ kind: "assigned", epoch, clientId: 7 })
  receive({ kind: "sync", payload: Uint8Array.from([1, 2, 0, 0]) })
  const shown: string[] = []
  provider.subscribeText(() => { if (provider.available) shown.push(provider.doc.getText("markdown").toString()) })
  const peer = new Y.Doc(); peer.getText("markdown").insert(0, "peer keystroke")
  const message = encoding.createEncoder(); sync.writeUpdate(message, Y.encodeStateAsUpdate(peer))
  receive({ kind: "sync", payload: encoding.toUint8Array(message) })
  expect(shown.at(-1)).toBe("peer keystroke")
  expect(writes).toBe(0)
  provider.dispose(); peer.destroy(); release()
  await new Promise(done => setTimeout(done, 0))
})

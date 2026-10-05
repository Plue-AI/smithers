import { expect, test } from "bun:test"
import * as Y from "yjs"
import * as sync from "y-protocols/sync"
import * as encoding from "lib0/encoding"
import * as decoding from "lib0/decoding"
import { Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness"
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
  f.event({ kind: "saved", vector: new Uint8Array([1, 7, 4]) })
  expect(f.provider.saved).toBe("saving")
  f.event({ kind: "saved", vector: new Uint8Array([255]) })
  expect(f.provider.saved).toBe("saving")
  const before = f.sent.length
  f.event({ kind: "assigned", epoch, clientId: 7 })
  expect(f.sent.length - before).toBe(2)
  expect(f.sent.at(-1)).toEqual(f.sent[1])
  expect(f.provider.doc.getText("content").toString()).toBe("retry")
  f.event({ kind: "saved", vector: new Uint8Array([1, 7, 5]) })
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
  f.event({ kind: "saved", vector: new Uint8Array([1, 8, 1]) }); expect(f.provider.unsaved?.count).toBe(1)
  f.event({ kind: "saved", vector: Y.encodeStateVector(f.provider.doc) }); expect(f.provider.unsaved).toBeUndefined()
  expect(f.provider.editable).toBe(true); f.provider.dispose()
})
test("revocation stops sending and failed clipboard preserves retained text", async () => {
  const f = fixture(); f.event({ kind: "assigned", epoch, clientId: 7 })
  f.provider.doc.getText("content").insert(0, "unsaved")
  f.event({ kind: "refused" }); const count = f.sent.length
  f.event({ kind: "restart" }); f.event({ kind: "saved", vector: Y.encodeStateVector(f.provider.doc) })
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
  f.event({ kind: "saved", vector: Uint8Array.from([1, 7, 5]) })
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

test("reapply is offered only to an assigned, synced replica holding retained edits", () => {
  const f = fixture(); f.event({ kind: "assigned", epoch, clientId: 7 })
  expect(f.provider.canReapply).toBe(false)
  f.provider.doc.getText("content").insert(0, "kept")
  f.event({ kind: "refused" })
  expect(f.provider.unsaved?.text).toBe("kept"); expect(f.provider.canReapply).toBe(false)
  expect(f.provider.collection.get("document")?.canReapply).toBe(false)
  f.event({ kind: "assigned", epoch: "00000000000000000000000000000002", clientId: 8 })
  expect(f.provider.editable).toBe(false); expect(f.provider.canReapply).toBe(true)
  expect(f.provider.collection.get("document")?.canReapply).toBe(true)
  expect(f.provider.reapply()).toBe(true)
  expect(f.provider.canReapply).toBe(false)
  f.provider.dispose()
})
test("an awareness change alone republishes the status row, so remote flags render and leave", () => {
  const f = fixture(); f.event({ kind: "assigned", epoch, clientId: 7 })
  const peer = new Y.Doc(); peer.clientID = 9
  const remote = new Awareness(peer)
  remote.setLocalState({ actor: { kind: "outside", color_index: 7 }, colour: "x", line: 2 })
  const before = f.provider.collection.get("document")!.revision
  f.provider.awareness.emit("change", [{ added: [], updated: [], removed: [] }, "timer"])
  expect(f.provider.collection.get("document")!.revision).toBe(before)
  f.event({ kind: "awareness", payload: encodeAwarenessUpdate(remote, [9]) })
  const joined = f.provider.collection.get("document")!.revision
  expect(joined).toBeGreaterThan(before)
  expect(f.provider.awareness.getStates().get(9)).toMatchObject({ line: 2 })
  // A timeout removal arrives with no document event; the row still moves.
  removeAwarenessStates(f.provider.awareness, [9], "timeout")
  expect(f.provider.awareness.getStates().has(9)).toBe(false)
  expect(f.provider.collection.get("document")!.revision).toBeGreaterThan(joined)
  remote.destroy(); peer.destroy(); f.provider.dispose()
})

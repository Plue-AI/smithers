// I5 proof through the native C ABI; the process adapter is test-only.
// YJS_MODULE=node_modules/.pnpm/yjs@13.6.32/node_modules/yjs
// DOCUMENT_INTEROP_BIN=../../target/debug/examples/live_document_interop
import { strict as assert } from "node:assert"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
const require = createRequire(import.meta.url)
const Y = require(process.env.YJS_MODULE ?? "yjs")
const bin = process.env.DOCUMENT_INTEROP_BIN
assert.ok(bin, "DOCUMENT_INTEROP_BIN required")
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")
const bytes = (value: string) => new Uint8Array(Buffer.from(value, "base64"))
function call(value: object) {
  const result = spawnSync(bin!, [], { input: JSON.stringify(value), encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
let authority = call({})
const a = new Y.Doc(), b = new Y.Doc()
a.clientID = 11; b.clientID = 22
Y.applyUpdate(a, bytes(authority.state)); Y.applyUpdate(b, bytes(authority.state))
for (let i = 0; i < 500; i++) {
  const beforeA = Y.encodeStateVector(a), beforeB = Y.encodeStateVector(b)
  a.transact(() => a.getText("content").insert(0, i % 3 ? "a" : "🐙"))
  b.transact(() => b.getText("content").insert(b.getText("content").length, i % 3 ? "b" : "é"))
  const updates = [
    { actor: "alice", update: b64(Y.encodeStateAsUpdate(a, beforeA)) },
    { actor: "bob", update: b64(Y.encodeStateAsUpdate(b, beforeB)) },
  ]
  if (i % 2) updates.reverse()
  for (const update of updates) authority = call({ state: authority.state, ...update })
  Y.applyUpdate(a, bytes(authority.state)); Y.applyUpdate(b, bytes(authority.state))
  assert.equal(a.getText("content").toString(), authority.text)
  assert.equal(b.getText("content").toString(), authority.text)
  if (i % 10 === 0) {
    // A reconnect's full step-2 state includes other actors' known structs.
    const retry = call({ state: authority.state, actor: "alice", update: b64(Y.encodeStateAsUpdate(a)) })
    assert.equal(retry.text, authority.text)
  }
}
// Sync step 2 is used by a reconnecting browser, including delete-only state.
const reconnect = new Y.Doc()
Y.applyUpdate(reconnect, bytes(call({state:authority.state,sv:b64(Y.encodeStateVector(reconnect))}).sync))
assert.equal(reconnect.getText("content").toString(), authority.text)
const wiki = call({kind:1}), editor = new Y.Doc()
editor.clientID = 11
Y.applyUpdate(editor,bytes(wiki.state))
const wikiSV=Y.encodeStateVector(editor)
editor.getText("markdown").insert(0,"# Shared 🌎")
const written=call({kind:1,state:wiki.state,actor:"alice",update:b64(Y.encodeStateAsUpdate(editor,wikiSV))})
assert.equal(written.text,"# Shared 🌎")
const beforeDelete=Y.encodeStateVector(editor)
editor.getText("markdown").delete(2,6)
const deleted=call({kind:1,state:written.state,actor:"alice",update:b64(Y.encodeStateAsUpdate(editor,beforeDelete))})
const viewer=new Y.Doc()
Y.applyUpdate(viewer,bytes(written.state))
Y.applyUpdate(viewer,bytes(call({kind:1,state:deleted.state,sv:b64(Y.encodeStateVector(viewer))}).sync))
assert.equal(viewer.getText("markdown").toString(),editor.getText("markdown").toString())
console.log("PASS: Yjs 13.6.32 ↔ Yrs 0.27.4 live-document C ABI; 1,000 concurrent interleaved edits, Unicode, retries, wiki, sync step 2, delete-only sync")

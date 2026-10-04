// Module interop only while the production dispatcher/envelope codec is absent.
// YJS_MODULE=node_modules/.pnpm/yjs@13.6.32/node_modules/yjs
// DOCUMENT_INTEROP_BIN=tests/document-component/target/debug/examples/interop
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
console.log("PASS: Yjs 13.6.32 ↔ shared Yrs 0.27.4 code core; 1,000 concurrent interleaved edits, Unicode, retries")

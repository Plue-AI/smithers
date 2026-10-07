// Driven by documents.rs through production RPC dispatch. Uses the app's pinned Yjs.
import { strict as assert } from "node:assert"
import { createRequire } from "node:module"
import { createInterface } from "node:readline"
const require = createRequire(new URL("../../../apps/app/package.json", import.meta.url))
assert.equal(require("yjs/package.json").version, "13.6.32")
const Y = require("yjs")
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
async function receive() {
  const line = await lines.next()
  assert.equal(line.done, false, "daemon peer closed")
  return JSON.parse(line.value!)
}
const bytes = (s: string) => new Uint8Array(Buffer.from(s, "base64"))
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64")
const initial = await receive()
const a = new Y.Doc(), b = new Y.Doc()
a.clientID = 4242; b.clientID = 4243
for (const doc of [a, b]) Y.applyUpdate(doc, bytes(initial.state))
let seq = 2
for (let round = 0; round < 500; round++) {
  // Both deltas start at the same state, before either sees the other's edit.
  const updates = [a, b].map((doc, index) => {
    const before = Y.encodeStateVector(doc)
    const text = doc.getText("content")
    if (round % 7 === 0 && text.length) {
      const first = Array.from(text.toString())[0] as string
      text.delete(0, first.length) // UTF-16; never split a surrogate pair.
    } else {
      text.insert(index ? text.length : 0, ["é", "🦀", "x\n"][round % 3])
    }
    return Y.encodeStateAsUpdate(doc, before)
  })
  let response: any
  for (const index of round % 2 ? [0, 1] : [1, 0]) {
    const request = { actor: index ? "bob" : "alice", seq: ++seq, update: b64(updates[index]) }
    process.stdout.write(JSON.stringify(request) + "\n")
    response = await receive()
    assert.equal(response.saved, seq)
    if (round % 50 === 0) {
      // Identical sequence and bytes are an idempotent transport retry.
      process.stdout.write(JSON.stringify(request) + "\n")
      response = await receive()
      assert.equal(response.saved, seq)
    }
  }
  for (const doc of [a, b]) {
    Y.applyUpdate(doc, bytes(response.state))
    assert.equal(doc.getText("content").toString(), response.text)
  }
  assert.equal(a.getText("content").toString(), b.getText("content").toString())
}
process.stdout.write(JSON.stringify({ done: 1000, text: a.getText("content").toString() }) + "\n")
process.exit(0)

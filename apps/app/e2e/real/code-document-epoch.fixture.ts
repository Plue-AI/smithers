// C-DUR-04 K7e client driver, invoked by the composed real-daemon test.
import assert from "node:assert/strict"
import { LiveChannel, type LiveSocket } from "../../src/mainview/runtime/LiveChannel"
import { LiveDocProvider } from "../../src/mainview/runtime/LiveDocProvider"

const origin = process.env.SMITHERS_CODE_DOCUMENT_ORIGIN!, topic = process.env.SMITHERS_CODE_DOCUMENT_TOPIC!
assert.ok(origin && topic)
let partitioned = false
const member = (cookie: string) => {
  const trace: { t: unknown; code?: unknown; epoch?: unknown }[] = []
  const channel = new LiveChannel({ documentFrames: true, socket: () => {
    const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/api/live`, {
      headers: { Cookie: `smithers_session=${cookie}`, Origin: origin }, protocols: ["smithers.live.v1"]
    } as never)
    socket.addEventListener("message", event => {
      if (typeof event.data !== "string") return
      const frame = JSON.parse(event.data)
      trace.push({ t: frame.t, ...(frame.code ? { code: frame.code } : {}), ...(frame.data?.epoch ? { epoch: frame.data.epoch } : {}) })
      if (trace.length > 50) trace.shift()
    })
    const send = socket.send.bind(socket)
    // A network partition drops outbound packets, never fabricates a receipt.
    socket.send = data => { if (!partitioned || typeof data === "string") send(data) }
    return socket as unknown as LiveSocket
  } })
  const provider = new LiveDocProvider(topic, channel, { contract: true, actor: true, file: true, recovery: true, catalog: true, machine: true })
  return { channel, provider, trace, text: () => provider.doc.getText("content") }
}
const wait = async (name: string, predicate: () => boolean) => {
  const end = performance.now()+10000
  while (!predicate()) {
    if (performance.now()>end) throw new Error(`Timed out: ${name}; Ben=${JSON.stringify({editable:ben.provider.editable,unsaved:ben.provider.unsaved,saved:ben.provider.saved,frames:ben.trace})}; Alice=${JSON.stringify({editable:alice.provider.editable,unsaved:alice.provider.unsaved,saved:alice.provider.saved,frames:alice.trace})}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const ben = member("ben-cookie"), alice = member("alice-cookie")
try {
  await wait("both assigned and synced", () => ben.provider.editable && alice.provider.editable)
  await wait("baseline saved", () => ben.provider.saved === "saved" && alice.provider.saved === "saved")
  assert.equal(ben.text().toString(), "")
  assert.equal(alice.text().toString(), "")
  partitioned = true
  ben.text().insert(0, "BEN-REAPPLY")
  alice.text().insert(0, "ALICE-COPY")
  assert.equal(ben.provider.saved, "saving")
  assert.equal(alice.provider.saved, "saving")
  console.log("NEW_EPOCH")
  const input = console[Symbol.asyncIterator]()
  const reply = await input.next()
  assert.equal(reply.value?.trim(), "RESTARTED")
  partitioned = false
  await wait("new epoch recovery", () => !!ben.provider.unsaved && !!alice.provider.unsaved && !ben.provider.editable && !alice.provider.editable && ben.text().toString() === "" && alice.text().toString() === "")
  assert.deepEqual(ben.provider.unsaved, { count: 1, text: "BEN-REAPPLY" })
  assert.deepEqual(alice.provider.unsaved, { count: 1, text: "ALICE-COPY" })
  assert.equal(ben.text().toString(), "")
  assert.equal(alice.text().toString(), "")
  let copied = ""
  const result = await alice.provider.copy(async value => { copied = value; return { ok: true } })
  assert.equal(result, true)
  assert.equal(copied, "ALICE-COPY")
  assert.equal(alice.text().toString(), "")
  assert.equal(ben.provider.reapply(), true)
  await wait("Reapply saved and peer converged", () => ben.provider.saved === "saved" && alice.text().toString() === "BEN-REAPPLY")
  assert.equal(ben.provider.reapply(), false, "Reapply cannot duplicate an acknowledged recovery")
  assert.equal(ben.text().toString(), "BEN-REAPPLY")
  console.log(JSON.stringify({ text: "BEN-REAPPLY", copied, retained: { Ben: 1, Alice: 1 } }))
} finally {
  ben.provider.dispose(); alice.provider.dispose(); ben.channel.dispose(); alice.channel.dispose()
}

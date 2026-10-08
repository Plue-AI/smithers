// Invoked by TestLiveCodeDocumentsComposedInstall against its own composed
// install. Two members drive the production LiveChannel and LiveDocProvider;
// only the daemon behind the install's authenticated link is scripted.
import assert from "node:assert/strict"
import { LiveChannel, type LiveSocket } from "../../src/mainview/runtime/LiveChannel"
import { LiveDocProvider } from "../../src/mainview/runtime/LiveDocProvider"

const origin = process.env.SMITHERS_CODE_DOCUMENT_ORIGIN
const topic = process.env.SMITHERS_CODE_DOCUMENT_TOPIC
assert.ok(origin && topic, "origin and topic are required")
const prerequisites = { contract: true, actor: true, file: true, recovery: true, catalog: true, machine: true }

const member = (cookie: string) => {
  const frames: string[] = []
  let current: WebSocket | undefined
  const channel = new LiveChannel({
    documentFrames: true,
    socket: () => {
      const socket = current = new WebSocket(`${origin.replace(/^http/, "ws")}/api/live`, {
        headers: { Cookie: `smithers_session=${cookie}`, Origin: origin }, protocols: ["smithers.live.v1"]
      } as never)
      // Keep refusals and closes for a failing run's report.
      socket.addEventListener("message", event => { if (typeof event.data === "string" && !event.data.includes('"saved"')) frames.push(`${new Date().toISOString().slice(11, 23)} ${event.data}`) })
      socket.addEventListener("close", event => frames.push(`close ${event.code} ${event.reason}`))
      return socket as unknown as LiveSocket
    }
  })
  const provider = new LiveDocProvider(topic, channel, prerequisites)
  return { channel, provider, frames, socket: () => current, text: () => provider.doc.getText("content") }
}
const waitFor = async (what: string, predicate: () => boolean, limitMs = 5000) => {
  const started = performance.now()
  while (!predicate()) {
    if (performance.now() - started > limitMs) throw new Error(`Timed out: ${what}`)
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  return performance.now() - started
}

const state = (p: LiveDocProvider) => { const x = p as unknown as Record<string, unknown>; return JSON.stringify({ saved: p.saved, acknowledged: x.acknowledged, pending: (x.pending as unknown[]).length, recovery: x.recovery, sentSeq: x.sentSeq, local: [...(x.localClocks as Map<number, number>)], savedClocks: [...(x.savedClocks as Map<number, number>)] }) }
const ben = member("ben-cookie"), alice = member("alice-cookie")
const diagnose = (error: Error) => { throw new Error(`${error.message}: ben ${JSON.stringify(ben.text().toString())} ${state(ben.provider)} ${JSON.stringify(ben.frames.slice(-5))} alice ${JSON.stringify(alice.text().toString())} ${state(alice.provider)} ${JSON.stringify(alice.frames.slice(-5))}`) }
await waitFor("both members editable", () => ben.provider.editable && alice.provider.editable)
assert.notEqual(ben.provider.doc.clientID, alice.provider.doc.clientID)

// Non-overlapping typing, one keystroke at a time. Each character must reach
// the other member before the next is typed.
const samples: number[] = []
const BEN = "Ben edits line one. "
const ALICE = " Alice edits the end."
for (let i = 0; i < BEN.length; i++) {
  ben.text().insert(i, BEN[i]!)
  const typed = BEN.slice(0, i + 1)
  samples.push(await waitFor(`Alice sees ${JSON.stringify(typed)}`, () => alice.text().toString().startsWith(typed), 1000))
}
for (let i = 0; i < ALICE.length; i++) {
  alice.text().insert(alice.text().length, ALICE[i]!)
  const typed = ALICE.slice(0, i + 1)
  samples.push(await waitFor(`Ben sees ${JSON.stringify(typed)}`, () => ben.text().toString().endsWith(typed), 1000))
}

// Overlapping typing at one position: both pages converge and keep every character.
const OVERLAP_BEN = "bbbbbbbbbb", OVERLAP_ALICE = "aaaaaaaaaa"
for (let i = 0; i < OVERLAP_BEN.length; i++) {
  ben.text().insert(BEN.length, OVERLAP_BEN[i]!)
  alice.text().insert(BEN.length, OVERLAP_ALICE[i]!)
}
await waitFor("pages converge", () => ben.text().toString() === alice.text().toString() && ben.text().length === BEN.length + ALICE.length + 20).catch(diagnose)
const text = ben.text().toString()
assert.equal(text.split("b").length - 1, 10, text)
assert.equal(text.split("a").length - 1, 10, text)
assert.ok(text.startsWith(BEN) && text.endsWith(ALICE), text)

// Saved only after the daemon receipt covers each member's own updates.
await waitFor("both pages saved", () => ben.provider.saved === "saved" && alice.provider.saved === "saved").catch(diagnose)

// Spec §7.1.1 gap on Ben's subscription alone: an oversized frame ends only
// that subscription. Ben keeps typing; resubscribing keeps his client id,
// resends the typing and offers no Reapply.
const benClient = ben.provider.doc.clientID
const gap = new Uint8Array(2 * 1024 * 1024 + 1)
gap.set([1, 0, 0, 0, 1])
ben.socket()!.send(gap)
const GAP = " typed during the gap"
for (const char of GAP) ben.text().insert(ben.text().length, char)
await waitFor("the gap", () => ben.frames.some(frame => frame.includes('"t":"gap"'))).catch(diagnose)
await waitFor("Alice sees typing from the gap", () => alice.text().toString().endsWith(GAP)).catch(diagnose)
await waitFor("both pages saved after the gap", () => ben.provider.saved === "saved" && alice.provider.saved === "saved").catch(diagnose)
assert.equal(ben.provider.doc.clientID, benClient, "the gap kept Ben's client id")
assert.equal(ben.provider.unsaved, undefined, "a gap offers no Reapply")
assert.equal(ben.text().toString(), alice.text().toString())

// The host registered each tab's client id under its member's actor.
const authors = ben.provider.doc.getMap("authors")
const benActor = authors.get(String(ben.provider.doc.clientID)), aliceActor = authors.get(String(alice.provider.doc.clientID))
assert.ok(benActor && aliceActor, JSON.stringify([...authors]))
assert.notEqual(JSON.stringify(benActor), JSON.stringify(aliceActor))

samples.sort((a, b) => a - b)
const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!
assert.ok(p95 < 1000, `keystroke p95 ${p95} ms`)
ben.provider.dispose(); alice.provider.dispose(); ben.channel.dispose(); alice.channel.dispose()
console.log(JSON.stringify({ text: ben.text().toString(), ben: ben.provider.doc.clientID, alice: alice.provider.doc.clientID, samples: samples.length, p95 }))

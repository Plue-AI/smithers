// Invoked against the composed install by both the scripted-relay test and
// TestLiveCodeDocumentsRealDaemonMountedCards. The latter uses the installed
// dispatcher and actual durable files; neither invents client save receipts.
import assert from "node:assert/strict"
import { LiveChannel, type LiveSocket } from "../../src/mainview/runtime/LiveChannel"
import { LiveDocProvider } from "../../src/mainview/runtime/LiveDocProvider"

const origin = process.env.SMITHERS_CODE_DOCUMENT_ORIGIN
const topic = process.env.SMITHERS_CODE_DOCUMENT_TOPIC
assert.ok(origin && topic, "origin and topic are required")
const prerequisites = { contract: true, actor: true, file: true, recovery: true, catalog: true, machine: true }

const NativeWebSocket = WebSocket
const NativeFetch = fetch
const member = (cookie: string) => {
  const frames: string[] = []
  let current: WebSocket | undefined
  const channel = new LiveChannel({
    documentFrames: true,
    socket: () => {
      const socket = current = new NativeWebSocket(`${origin.replace(/^http/, "ws")}/api/live`, {
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
const waitFor = async (what: string, predicate: () => boolean, limitMs = 30000) => {
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
const { mountDocument } = await import("./code-document-mounted.fixture")
const benCard = await mountDocument(ben.provider), aliceCard = await mountDocument(alice.provider)
const BEN = "Ben edits line one. "
const ALICE = " Alice edits the end."
for (let i = 0; i < BEN.length; i++) {
  benCard.insert(i, BEN[i]!)
  samples.push(await waitFor(`Alice sees Ben character ${i}`, () => aliceCard.text().startsWith(BEN.slice(0, i + 1))))
}
for (let i = 0; i < ALICE.length; i++) {
  aliceCard.insert(aliceCard.text().length, ALICE[i]!)
  samples.push(await waitFor(`Ben sees Alice character ${i}`, () => benCard.text().endsWith(ALICE.slice(0, i + 1))))
}

// Overlapping typing at one position: both pages converge and keep every character.
const OVERLAP_BEN = "bbbbbbbbbb", OVERLAP_ALICE = "aaaaaaaaaa"
for (let i = 0; i < OVERLAP_BEN.length; i++) {
  ben.text().insert(BEN.length, OVERLAP_BEN[i]!)
  alice.text().insert(BEN.length, OVERLAP_ALICE[i]!)
}
await waitFor("pages converge", () => ben.text().toString() === alice.text().toString() && ben.text().length === BEN.length + ALICE.length + 20).catch(diagnose)
assert.equal(benCard.text(), aliceCard.text(), "mounted editors converge")
benCard.authors(); aliceCard.authors()
assert.equal(ben.provider.setLine(1, "var(--lane-0)"), true)
assert.equal(alice.provider.setLine(1, "var(--lane-1)"), true)
await waitFor("authenticated remote line flags", () => ben.provider.awareness.getStates().has(alice.provider.doc.clientID) && alice.provider.awareness.getStates().has(ben.provider.doc.clientID))
benCard.nameFlag("Alice"); aliceCard.nameFlag("Ben")
const text = ben.text().toString()
assert.equal(text.split("b").length - 1, 10, text)
assert.equal(text.split("a").length - 1, 10, text)
assert.ok(text.startsWith(BEN) && text.endsWith(ALICE), text)

// Saved only after the daemon receipt covers each member's own updates.
await waitFor("both pages saved", () => ben.provider.saved === "saved" && alice.provider.saved === "saved").catch(diagnose)

// One thousand further alternating mounted edits. Keep the original provider
// contract cases and their 41-sample output intact for the existing Go caller.
// Collect slow arrivals too: the budget is p95 < 1 s, asserted below, rather
// than truncating the sample set at the first individual 1 s outlier.
const mountedSamples: number[] = []
let mountedText = benCard.text()
for (let i = 0; i < 500; i++) {
  const b = String.fromCharCode(0xe000 + i), a = String.fromCharCode(0xe200 + i)
  benCard.insert(benCard.text().length, b)
  mountedText += b
  mountedSamples.push(await waitFor(`mounted Alice edit ${i}`, () => aliceCard.text() === mountedText).catch(diagnose))
  aliceCard.insert(aliceCard.text().length, a)
  mountedText += a
  mountedSamples.push(await waitFor(`mounted Ben edit ${i}`, () => benCard.text() === mountedText).catch(diagnose))
}
assert.equal(mountedSamples.length, 1000)
assert.equal(benCard.text(), aliceCard.text())
await waitFor("mounted edits acknowledged", () => ben.provider.saved === "saved" && alice.provider.saved === "saved").catch(diagnose)
mountedSamples.sort((a, b) => a - b)
const mountedP95 = mountedSamples[949]!
assert.ok(mountedP95 < 1000, `mounted keystroke p95 ${mountedP95} ms`)

// Native mounted Undo keeps Alice's work and receives real relay/save receipts.
await new Promise(resolve => setTimeout(resolve, 600))
benCard.insert(benCard.text().length, "BEN_OWN_UNDO")
await waitFor("peer sees Ben Undo group", () => aliceCard.text().includes("BEN_OWN_UNDO"))
aliceCard.insert(aliceCard.text().length, "ALICE_UNDO_KEEP")
await waitFor("Ben sees Alice preserved text", () => benCard.text().includes("ALICE_UNDO_KEEP"))
benCard.undo()
await waitFor("own group removed in both mounted cards", () => !benCard.text().includes("BEN_OWN_UNDO") && !aliceCard.text().includes("BEN_OWN_UNDO"))
assert.ok(benCard.text().includes("ALICE_UNDO_KEEP")); assert.ok(aliceCard.text().includes("ALICE_UNDO_KEEP"))
await waitFor("Undo acknowledged by daemon", () => ben.provider.saved === "saved" && alice.provider.saved === "saved").catch(diagnose)

const stdin = console[Symbol.asyncIterator]()
if (process.env.SMITHERS_CODE_DOCUMENT_OUTSIDE === "1") {
  console.log("OUTSIDE")
  assert.equal((await stdin.next()).value, "WRITTEN")
  await waitFor("real outside write reaches both mounted cards", () => benCard.text().endsWith("\n// OUTSIDE_MOUNTED_CANARY\n") && aliceCard.text() === benCard.text()).catch(diagnose)
  await waitFor("outside reconciliation saved", () => ben.provider.saved === "saved" && alice.provider.saved === "saved").catch(diagnose)
}

// The installed-daemon steady-state driver ends here. Gap and restart remain
// separate qualification cases; this result proves neither recovery nor activation.
if (process.env.SMITHERS_CODE_DOCUMENT_PHASE === "coedit") {
  // UTF-16 edits cross the production browser/Go/Rust codec seam. The
  // combining mark and astral characters must survive insertion and deletion
  // without changing the other member's text or splitting a surrogate pair.
  const beforeUnicode = benCard.text()
  const unicode = "🧑🏽‍💻 café e\u0301 漢字 שלום 🌍"
  benCard.insert(beforeUnicode.length, unicode)
  await waitFor("Unicode peer interop", () => aliceCard.text() === beforeUnicode + unicode).catch(diagnose)
  const globe = alice.text().toString().lastIndexOf("🌍")
  alice.text().delete(globe, 2)
  const expectedUnicode = beforeUnicode + unicode.slice(0, -2)
  await waitFor("UTF-16 astral deletion", () => benCard.text() === expectedUnicode && aliceCard.text() === expectedUnicode).catch(diagnose)
  await waitFor("Unicode edits saved", () => ben.provider.saved === "saved" && alice.provider.saved === "saved").catch(diagnose)
  const authors = [...ben.provider.doc.getMap("authors")]
  const finalText = benCard.text()
  assert.equal(finalText, aliceCard.text())
  benCard.saved(); aliceCard.saved()
  benCard.dispose(); aliceCard.dispose(); ben.provider.dispose(); alice.provider.dispose(); ben.channel.dispose(); alice.channel.dispose()
  console.log(JSON.stringify({ text: finalText, ben: ben.provider.doc.clientID, alice: alice.provider.doc.clientID, authors,
    samples: samples.length, mountedSamples: mountedSamples.length, mountedP95 }))
  process.exit(0)
}

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

benCard.saved(); aliceCard.saved()

// The host registered each tab's client id under its member's actor.
const authors = ben.provider.doc.getMap("authors")
const benActor = authors.get(String(ben.provider.doc.clientID)), aliceActor = authors.get(String(alice.provider.doc.clientID))
assert.ok(benActor && aliceActor, JSON.stringify([...authors]))
assert.notEqual(JSON.stringify(benActor), JSON.stringify(aliceActor))

// Host restart while Ben types (ADR 0003 ruling, 8a 2026-10-07): typing stays
// pending, both reconnect with their client ids, and nothing offers Reapply.
const aliceClient = alice.provider.doc.clientID
const RESTART = " typed across a host restart"
let restarted = false
console.log("RESTART")
const typing = (async () => {
  for (const char of RESTART) {
    ben.text().insert(ben.text().length, char)
    await new Promise(resolve => setTimeout(resolve, restarted ? 10 : 150))
  }
})()
const answer = await stdin.next()
assert.equal(answer.value, "RESTARTED")
restarted = true
await typing
await waitFor("Alice sees typing across the restart", () => alice.text().toString().endsWith(RESTART), 30000).catch(diagnose)
await waitFor("both pages saved after the restart", () => ben.provider.saved === "saved" && alice.provider.saved === "saved", 30000).catch(diagnose)
assert.ok(ben.frames.some(frame => frame.startsWith("close")), "the restart closed Ben's socket")
assert.equal(ben.provider.doc.clientID, benClient, "the restart kept Ben's client id")
assert.equal(alice.provider.doc.clientID, aliceClient, "the restart kept Alice's client id")
assert.equal(ben.provider.unsaved, undefined, "a host restart offers no Reapply")
assert.equal(alice.provider.unsaved, undefined, "a host restart offers no Reapply")
assert.equal(ben.text().toString(), alice.text().toString())

if (process.env.SMITHERS_CODE_DOCUMENT_OUTSIDE === "1") {
  const identity = await NativeFetch(`${origin}/api/user`, { headers: { Cookie: "smithers_session=alice-cookie" } })
  assert.equal(identity.status, 200, "the member was authenticated before revocation")
  console.log("REVOKE")
  assert.equal((await stdin.next()).value, "REVOKED")
  await waitFor("revocation ends the real mounted subscription", () => !alice.provider.editable, 5000).catch(diagnose)
  aliceCard.readOnly()
  const before = alice.text().toString()
  // Native input enters the read-only mounted control. EditorView.dispatch
  // deliberately bypasses readOnly and is not a person's typing boundary.
  aliceCard.typeReadOnly("REVOKED_MUST_NOT_WRITE")
  assert.equal(alice.text().toString(), before)
  assert.equal(benCard.text(), before)
  const denied = await NativeFetch(`${origin}/api/branches/${topic.split(":")[2]}/files/retry.ts`, { headers: { Cookie: "smithers_session=alice-cookie" } })
  assert.ok([401, 403].includes(denied.status), `revoked file read: ${denied.status}`)
}

samples.sort((a, b) => a - b)
const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!
assert.ok(p95 < 1000, `keystroke p95 ${p95} ms`)
benCard.dispose(); aliceCard.dispose(); ben.provider.dispose(); alice.provider.dispose(); ben.channel.dispose(); alice.channel.dispose()
console.log(JSON.stringify({ text: ben.text().toString(), ben: ben.provider.doc.clientID, alice: alice.provider.doc.clientID, samples: samples.length, p95, mountedSamples: mountedSamples.length, mountedP95 }))
process.exit(0)

// C-DUR-04 K7e client driver, invoked by the composed real-daemon test.
import assert from "node:assert/strict"
import { LiveChannel, type LiveSocket } from "../../src/mainview/runtime/LiveChannel"
import { createAppController } from "../../src/mainview/state/AppController"
import { createAppStore } from "../../src/mainview/state/AppStore"
import { createApplicationClient } from "../../src/mainview/runtime/ApplicationClient"
import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import { memoryStorage } from "../../src/mainview/state/TestFixtures"

const origin = process.env.SMITHERS_CODE_DOCUMENT_ORIGIN!, topic = process.env.SMITHERS_CODE_DOCUMENT_TOPIC!
assert.ok(origin && topic)
const NativeFetch = fetch
const NativeWebSocket = WebSocket
const NativeAbortController = AbortController
const NativeAbortSignal = AbortSignal
const { mountDocument } = await import("./code-document-mounted.fixture")
// The mounted DOM shim must retain Bun's transport cancellation types.
globalThis.AbortController = NativeAbortController
globalThis.AbortSignal = NativeAbortSignal
// Separate member browser contexts have separate identity broadcasts.
Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: undefined })
let partitioned = false
const member = async (cookie: string, login: string) => {
  let epoch: unknown, synchronizedEpoch: unknown, subscription: unknown
  const trace: { t: unknown; code?: unknown; id?: unknown; epoch?: unknown }[] = []
  const channel = new LiveChannel({ documentFrames: true, socket: () => {
    const socket = new NativeWebSocket(`${origin.replace(/^http/, "ws")}/api/live`, {
      headers: { Cookie: `smithers_session=${cookie}`, Origin: origin }, protocols: ["smithers.live.v1"]
    } as never)
    socket.addEventListener("message", event => {
      if (typeof event.data !== "string") {
        // Observe the actual sync-step-2 envelope; assignment alone does
        // not mean the fresh document is ready for Reapply.
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data)
          if (bytes.length > 5 && bytes[0] === 1 && new DataView(event.data).getUint32(1) === subscription && bytes[5] === 1) synchronizedEpoch = epoch
        }
        return
      }
      const frame = JSON.parse(event.data)
      if (frame.t === "snap" && frame.data?.epoch) { epoch = frame.data.epoch; subscription = frame.id; synchronizedEpoch = undefined }
      trace.push({ t: frame.t, id: frame.id, ...(frame.code ? { code: frame.code } : {}), ...(frame.data?.epoch ? { epoch: frame.data.epoch } : {}) })
      if (trace.length > 50) trace.shift()
    })
    const send = socket.send.bind(socket)
    // A network partition drops outbound packets, never fabricates a receipt.
    socket.send = data => { if (!partitioned || typeof data === "string") send(data) }
    return socket as unknown as LiveSocket
  } })
  const branch = topic.split(":")[2]!
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const request: FetchLike = (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set("Cookie", `smithers_session=${cookie}`)
    headers.set("Origin", origin)
    return NativeFetch(new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, origin), { ...init, headers })
  }
  const client = createApplicationClient(resolveApplicationTarget({ apiVersion: 1, mode: "web-selfhost", apiOrigin: "", auth: { kind: "session" }, cors: "same-origin", developerExternal: false }, origin), { fetchImpl: request, pageOrigin: origin })
  assert.equal((await client.identity.current(undefined, "/api/auth/session"))?.username, login)
  const controller = createAppController(store, {
    available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {}
  }, {
    baseUrl: origin,
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "none", sandbox: null },
    live: channel, documentOptions: { channel, prerequisites: { contract: true, actor: true, file: true, recovery: true, catalog: true, machine: true } },
    branchOptions: { ready: () => true, scope: () => ({ branch, member: login, revision: 1, sleeping: false }) },
    fetchImpl: request, applicationIdentity: client.identity
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login, admin: false, scopesPlain: null }).isPersisted.promise
  // This Linux namespace has no admitted microVM runtime for /file reads.
  // Reuse the production controller's document owner and command dispatcher;
  // the separate reference-browser journey proves /file admission on the mini.
  const provider = controller.fileDocuments!.resolve(branch, "retry.ts", {
    path: "retry.ts", branch, language: "", digest: "", content: { kind: "text", text: "" },
    mode: "read_only", diagnostics: [], authors: [], editors: []
  })!.provider
  const card = await mountDocument(provider, controller, {
    id: `epoch-${login}`, kind: "file", title: "retry.ts", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: "ben/demo", ref: branch, path: "retry.ts", content: "", truncated: false }
  })
  return { channel, provider, controller, card, trace, synced: () => epoch !== undefined && synchronizedEpoch === epoch, text: () => provider.doc.getText("content") }
}
const wait = async (name: string, predicate: () => boolean) => {
  const end = performance.now()+10000
  while (!predicate()) {
    if (performance.now()>end) throw new Error(`Timed out: ${name}; Ben=${JSON.stringify({editable:ben.provider.editable,unsaved:ben.provider.unsaved,saved:ben.provider.saved,frames:ben.trace})}; Alice=${JSON.stringify({editable:alice.provider.editable,unsaved:alice.provider.unsaved,saved:alice.provider.saved,frames:alice.trace})}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const ben = await member("ben-cookie", "ben"), alice = await member("alice-cookie", "alice")
try {
  await wait("both assigned and synced", () => ben.provider.editable && alice.provider.editable)
  await wait("baseline saved", () => ben.provider.saved === "saved" && alice.provider.saved === "saved")
  assert.equal(ben.text().toString(), "")
  assert.equal(alice.text().toString(), "")
  if (process.env.SMITHERS_CODE_DOCUMENT_PHASE === "compare") {
    ben.card.insert(0, "BEN-COMPARE")
    await wait("baseline Compare edit saved", () => ben.provider.saved === "saved" && alice.provider.saved === "saved" && alice.card.text() === "BEN-COMPARE")
    console.log("OUTSIDE_COMPARE")
    const input = console[Symbol.asyncIterator]()
    assert.equal((await input.next()).value?.trim(), "WRITTEN")
    const expected = "BEN-COMPARE\nOUTSIDE-COMPARE\n"
    await wait("real watcher reconciles outside text", () => ben.card.text() === expected && alice.card.text() === expected)
    console.log("CAPTURE_COMPARE")
    assert.equal((await input.next()).value?.trim(), "CAPTURED")
    await wait("real outside version projected", () => !!ben.provider.file?.outside && !!alice.provider.file?.outside && ben.card.text() === expected && alice.card.text() === expected)
    const current = expected + "BEN-AFTER-CAPTURE"
    ben.card.insert(ben.card.text().length, "BEN-AFTER-CAPTURE")
    await wait("later edit saved without changing retained version", () => ben.provider.saved === "saved" && alice.provider.saved === "saved" && alice.card.text() === current)
    const result = await ben.card.activate("Compare")
    assert.equal(result?.status, "executed", JSON.stringify(result))
    assert.equal(ben.provider.comparison?.text, expected, "Compare reads the retained outside after-version, not the pre-burst bytes")
    ben.card.comparison(expected, current)
    assert.equal(alice.provider.comparison, undefined, "Compare stays local to its member")
    await wait("Compare never changes the live document", () => ben.provider.saved === "saved" && alice.provider.saved === "saved")
    console.log(JSON.stringify({ text: current, compared: ben.provider.comparison?.text, version: ben.provider.comparison?.version }))
  } else {
    partitioned = true
    ben.card.insert(0, "BEN-REAPPLY")
    alice.card.insert(0, "ALICE-COPY")
    assert.equal(ben.provider.saved, "saving")
    assert.equal(alice.provider.saved, "saving")
    console.log("NEW_EPOCH")
    const input = console[Symbol.asyncIterator]()
    const reply = await input.next()
    assert.equal(reply.value?.trim(), "RESTARTED")
    partitioned = false
    await wait("new epoch recovery", () => ben.synced() && alice.synced() && !!ben.provider.unsaved && !!alice.provider.unsaved && !ben.provider.editable && !alice.provider.editable && ben.text().toString() === "" && alice.text().toString() === "")
    await wait("fresh epoch authenticated and synced", () => ben.provider.available && alice.provider.available)
    assert.deepEqual(ben.provider.unsaved, { count: 1, text: "BEN-REAPPLY" })
    assert.deepEqual(alice.provider.unsaved, { count: 1, text: "ALICE-COPY" })
    assert.equal(ben.text().toString(), "")
    assert.equal(alice.text().toString(), "")
    ben.card.recovery(1, "BEN-REAPPLY")
    alice.card.recovery(1, "ALICE-COPY")
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Clipboard denied") } } })
    await alice.card.activate("Copy")
    await wait("failed Copy stays visible", () => alice.card.copyFailed())
    assert.deepEqual(alice.provider.unsaved, { count: 1, text: "ALICE-COPY" })
    let copied = ""
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied = value } } })
    await alice.card.activate("Copy")
    await wait("mounted Copy clears only Alice recovery", () => alice.provider.unsaved === undefined)
    assert.equal(copied, "ALICE-COPY")
    assert.equal(alice.card.text(), "")
    assert.deepEqual(ben.provider.unsaved, { count: 1, text: "BEN-REAPPLY" })
    assert.ok(ben.controller.fileDocuments!.has("retry.ts", topic.split(":")[2]), "Ben owns his recovery document")
    const reapplied = await ben.card.activate("Reapply")
    assert.equal(reapplied?.status, "executed", JSON.stringify(reapplied))
    assert.deepEqual(ben.provider.unsaved, { count: 1, text: "BEN-REAPPLY" }, "Reapply retains text until the real daemon acknowledgment")
    assert.equal(ben.provider.saved, "saving")
    await wait("Reapply saved and peer converged", () => ben.provider.saved === "saved" && alice.provider.saved === "saved" && alice.text().toString() === "BEN-REAPPLY")
    assert.equal(ben.provider.reapply(), false, "Reapply cannot duplicate an acknowledged recovery")
    assert.equal(ben.text().toString(), "BEN-REAPPLY")
    assert.equal(ben.card.text(), "BEN-REAPPLY")
    assert.equal(alice.card.text(), "BEN-REAPPLY")
    ben.card.saved(); alice.card.saved()
    console.log(JSON.stringify({ text: "BEN-REAPPLY", copied, retained: { Ben: 1, Alice: 1 } }))
  }
} finally {
  ben.card.dispose(); alice.card.dispose(); await ben.controller.dispose(); await alice.controller.dispose(); ben.channel.dispose(); alice.channel.dispose()
}

// The mounted namespace driver owns this process, like the 1,000-edit driver.
process.exit(0)

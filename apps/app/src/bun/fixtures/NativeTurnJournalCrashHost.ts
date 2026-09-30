import { TURN_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { AgentTurnJournalDeliverySchema } from "@smthrs/rpc/AgentTurnJournal"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { createNativeTurnJournal } from "../NativeTurnJournal"
import { startLocalServer } from "../server"
import { signedInKeychain } from "./FakeBackendTurns"

// An owned test process only. The gate withholds committed HTTP output before
// it can reach the consumer; SIGKILL bypasses every graceful shutdown hook.
const [root, backendUrl, boundary] = process.argv.slice(2)
if (!root || !backendUrl || (boundary !== "acceptance" && boundary !== "batch" && boundary !== "before-inference")) throw new Error("Invalid crash fixture")
if (boundary === "before-inference") {
  const journal = createNativeTurnJournal(`${root}/state`)
  const token = crypto.randomUUID()
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    if (new URL(request.url).pathname !== TURN_PATH || request.headers.get(LOCAL_SESSION_HEADER) !== token) return new Response(null, { status: 401 })
    const body = await request.json() as StartAgentTurnRequest & { journal: { version: 1; legId: string; token: string } }
    return journal.start(request, body, () => {
      // Acceptance has committed to SQLite before this synchronous callback runs.
      // Block the only JS thread so no producer output or HTTP receipt can escape.
      console.log(JSON.stringify({ type: "boundary" }))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      throw new Error("The killed producer resumed unexpectedly")
    })
  } })
  console.log(JSON.stringify({ type: "ready", origin: `http://127.0.0.1:${server.port}`, token }))
} else {
  const host = await startLocalServer({
    port: 0, distDir: root, home: root, stateDir: `${root}/state`,
    cloudMode: "hybrid", cloudApi: backendUrl, cloudKeychain: signedInKeychain(), identityUpstream: null,
    log: () => {}
  })
  const never = new Promise<never>(() => {})
  const gate = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    const url = new URL(request.url)
    const headers = new Headers(request.headers)
    headers.delete("host")
    const response = await fetch(`${host.origin}${url.pathname}`, {
      method: request.method, headers, body: await request.arrayBuffer()
    })
    if (url.pathname !== TURN_PATH || !response.ok || response.body === null) return response
    const reader = response.body.getReader()
    return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
      const decoder = new TextDecoder(), encoder = new TextEncoder()
      let pending = ""
      while (true) {
        const next = await reader.read()
        if (next.done) throw new Error("The test producer ended before the crash boundary")
        pending += decoder.decode(next.value, { stream: true })
        let newline: number
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          const delivery = AgentTurnJournalDeliverySchema.parse(JSON.parse(line))
          if (delivery.type === "accepted") controller.enqueue(encoder.encode(`${line}\n`))
          if ((boundary === "acceptance" && delivery.type === "accepted") ||
            (boundary === "batch" && delivery.type === "batch")) {
            console.log(JSON.stringify({ type: "boundary", delivery }))
            await never
          }
          if (delivery.type !== "accepted") controller.enqueue(encoder.encode(`${line}\n`))
        }
      }
    } }), { status: response.status, headers: response.headers })
  } })
  console.log(JSON.stringify({ type: "ready", origin: `http://127.0.0.1:${gate.port}`, token: host.sessionToken }))
}

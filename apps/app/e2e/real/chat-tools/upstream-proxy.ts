import { DEFAULT_CLOUD_API } from "../../../src/bun/server"

// The shared backend the fault host's hybrid agent reaches through this passthrough.
const upstream = new URL(process.env.SMITHERS_CLOUD_API ?? DEFAULT_CLOUD_API).origin
const port = Number(process.env.SMITHERS_REAL_CHAT_PROXY_PORT)
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid SMITHERS_REAL_CHAT_PROXY_PORT: ${process.env.SMITHERS_REAL_CHAT_PROXY_PORT}`)
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const incoming = new URL(request.url)
    if (request.method === "GET" && incoming.pathname === "/__harness_ready") {
      return new Response(null, { status: 204 })
    }
    const headers = new Headers(request.headers)
    headers.delete("host")
    console.error(`[chat-passthrough] forwarding ${request.method} ${incoming.pathname}`)
    const response = await fetch(`${upstream}${incoming.pathname}${incoming.search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body
    })
    return new Response(response.body, { status: response.status, headers: response.headers })
  }
})

console.error(`[chat-passthrough] listening on ${server.url.origin}`)
await new Promise<never>(() => {})

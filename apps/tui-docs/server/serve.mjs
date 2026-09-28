/** Portable self-hosting entry point. Hosted secrets and deployment config belong outside this repository. */
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { extname, resolve } from "node:path"
import { pipeline, Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import { Sponsor } from "./sponsor.mjs"
const root = resolve(process.env.DOCS_DIST || fileURLToPath(new URL("../dist/", import.meta.url))),
  port = Number(process.env.PORT || 4388),
  clientHeader = process.env.DOCS_CLIENT_IP_HEADER?.toLowerCase()
let origin = process.env.DOCS_ORIGIN || `http://localhost:${port}`
const database = process.env.DOCS_BUDGET_DB || fileURLToPath(new URL("../.cache/sponsor.sqlite", import.meta.url))
mkdirSync(resolve(database, ".."), { recursive: true })
const sponsor = new Sponsor({
  key: process.env.OPENROUTER_API_KEY,
  database,
  dailyDollars: Number(process.env.DOCS_DAILY_DOLLARS || 0.5),
  dailyCalls: Number(process.env.DOCS_DAILY_CALLS || 100)
})
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".gif": "image/gif",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm"
}
// Personal providers are any HTTPS endpoint or a loopback HTTP one (src/playground/provider.ts endpoint()).
// CSP cannot name the [::1] loopback, so http: stays open here and endpoint() enforces loopback-only.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https: http:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ")
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin)
    if (url.pathname === "/api/playground/model") {
      const response = await sponsor.handle(
        new Request(url, {
          method: req.method,
          headers: req.headers,
          ...(!["GET", "HEAD"].includes(req.method) ? { body: Readable.toWeb(req), duplex: "half" } : {})
        }),
        origin,
        clientHeader ? req.headers[clientHeader] : req.socket.remoteAddress
      )
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
      return
    }
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405)
      res.end()
      return
    }
    let file = resolve(root, "." + decodeURIComponent(url.pathname))
    if (file !== root && !file.startsWith(root + "/")) {
      res.writeHead(403)
      res.end()
      return
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = resolve(file, "index.html")
    if (!existsSync(file)) {
      res.writeHead(404)
      res.end("Not found")
      return
    }
    res.writeHead(200, {
      "Content-Type": types[extname(file)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy": csp
    })
    if (req.method === "HEAD") res.end()
    else pipeline(createReadStream(file), res, () => {})
  } catch {
    res.writeHead(503, { "Content-Type": "application/json" })
    res.end("{\"error\":\"Sponsored access unavailable\"}")
  }
})
server.listen(port, process.env.HOST || "127.0.0.1", () => {
  if (!process.env.DOCS_ORIGIN) origin = `http://localhost:${server.address().port}`
  console.log(`TUI docs: ${origin}`)
  process.send?.({ origin })
})
for (const name of ["SIGINT", "SIGTERM"]) {
  process.on(name, () =>
    server.close(() => {
      sponsor.close()
      process.exit()
    }))
}

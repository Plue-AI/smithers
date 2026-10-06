// Runs the bundled smithers-docs-redirect Worker (stdin) in workerd through
// wrangler's Miniflare: src/docsRedirect.workerd.test.ts. Outbound fetches go
// to a stand-in origin that echoes the host it was asked for.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const wrangler = createRequire(require.resolve("wrangler/package.json"))
const { Miniflare, convertV4MiniflareOptions } = await import(wrangler.resolve("miniflare"))
let script = ""
for await (const chunk of process.stdin) script += chunk
const runtime = new Miniflare(convertV4MiniflareOptions({
  workers: [
    { name: "redirect", modules: true, script, compatibilityDate: "2026-08-01", compatibilityFlags: ["nodejs_compat"],
      bindings: { UNKNOWN_SLUGS: "off" }, outboundService: "origin" },
    { name: "origin", modules: true, script: 'export default { fetch(request) { return new Response("origin:" + new URL(request.url).host, { status: 203 }) } }' }
  ]
}))
try {
  const docs = "https://github.com/smithersai/smithers/tree/main/packages/smithers/flows"
  for (const [url, location] of [
    ["https://flow.smithers.sh/", `${docs}/flow/docs`],
    ["https://engine.smithers.sh/concepts/retries/", `${docs}/engine/docs`],
    ["https://smithers-patterns.smithers.sh/", `${docs}/patterns/docs`],
    ["https://smithers-sync.smithers.sh/..%2f..%2fevil?next=//evil.example", `${docs}/sync/docs`]
  ]) {
    const response = await runtime.dispatchFetch(url, { redirect: "manual" })
    assert.equal(response.status, 301, url)
    assert.equal(response.headers.get("location"), location, url)
  }
  for (const url of ["https://build.smithers.sh/cache", "https://unknown-docs-slug.smithers.sh/deep"]) {
    const response = await runtime.dispatchFetch(url, { redirect: "manual" })
    assert.equal(response.status, 203, url)
    assert.equal(await response.text(), `origin:${new URL(url).host}`, url)
  }
  console.log("docs redirect passed")
} finally { await runtime.dispose() }

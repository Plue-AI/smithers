import { expect, test } from "bun:test"
import { probeCanonicalSeams } from "./canary-seam-probe"

test("canonical probe requires real routes, auth refusal and valid same-run output", async () => {
  let mode = "healthy", turns = 0
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/api/bootstrap") return Response.json(mode === "legacy" ? { ok: true } : { apiVersion: 1, host: "cloud", version: "1", buildSha: "a".repeat(40), capabilities: ["agent", "identity"], authFlow: "redirect", sandbox: null })
    if (path === "/api/auth/github") return Response.redirect("https://github.com/login/oauth/authorize?client_id=test", 302)
    if (path === "/api/user" && request.headers.has("cookie")) return Response.json({ username: "visitor", is_admin: mode === "admin" })
    if (["/api/user", "/api/user/repos", "/api/billing/balance"].includes(path)) return new Response(null, { status: mode === "missing" ? 404 : 401 })
    if (path === "/api/agent/turn") {
      if (!request.headers.has("cookie")) return new Response(null, { status: 401 })
      turns++
      expect(request.headers.get("x-csrf-token")).toBe("proof")
      const body = await request.json() as { runId: string; journal: { version: number; legId: string; token: string } }
      expect(body.journal.version).toBe(1)
      expect(body.journal.token).toMatch(/^[A-Za-z0-9_-]{32,128}$/)
      return new Response(JSON.stringify({ runId: mode === "foreign" ? "foreign" : body.runId, type: "done", ...(mode === "error" ? { error: "provider failed" } : {}), ...(mode === "cancelled" ? { reason: "cancelled" } : {}) })+"\n", { headers: { "content-type": "application/x-ndjson" } })
    }
    if (path === "/") return new Response("<html></html>", { headers: { "content-type": "text/html" } })
    return new Response(null, { status: 404 })
  } })
  try {
    const origin = server.url.origin
    expect(await probeCanonicalSeams(origin)).toEqual([])
    expect(await probeCanonicalSeams(origin, "session=visitor; __csrf=proof")).toEqual([])
    mode = "legacy"; expect(await probeCanonicalSeams(origin)).toContain("bootstrap")
    mode = "missing"; expect(await probeCanonicalSeams(origin)).toContain("anonymous /api/user")
    mode = "foreign"; expect(await probeCanonicalSeams(origin, "session=visitor; __csrf=proof")).toContain("completed turn")
    mode = "error"; expect(await probeCanonicalSeams(origin, "session=visitor; __csrf=proof")).toContain("completed turn")
    mode = "cancelled"; expect(await probeCanonicalSeams(origin, "session=visitor; __csrf=proof")).toContain("completed turn")
    const before = turns
    mode = "admin"; expect(await probeCanonicalSeams(origin, "session=admin; __csrf=proof")).toContain("scoped identity")
    expect(turns).toBe(before)
  } finally { server.stop(true) }
})

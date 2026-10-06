import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { APP_BOOTSTRAP_PATH, AppBootstrapSchema } from "@smthrs/rpc/AppBootstrap"
import { localCapabilities } from "@smthrs/rpc/HostCapabilities"
import { LOCAL_SESSION_HEADER, LOCAL_SESSION_META } from "@smthrs/rpc/LocalSession"
import { defaultDistDir, describeCookie, rescopeCookie, startLocalServer } from "./server"
import type { LocalServer } from "./server"
import type { CloudAuth } from "./CloudAuth"
import { CLOUD_AUTH_START_PATH } from "@smthrs/rpc/CloudTunnel"

let dist = ""
let server: LocalServer
const logs: Array<string> = []

const apiFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set(LOCAL_SESSION_HEADER, server.sessionToken)
  return fetch(`${server.origin}${path}`, { ...init, headers })
}

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "smithers-dist-"))
  await mkdir(join(dist, "assets"))
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Smithers</title><div id=\"root\"></div>")
  await writeFile(join(dist, "assets", "app.js"), "console.log('hi')")
  server = await startLocalServer({
    port: 0,
    distDir: dist,
    home: "/fake/home",
    log: (line) => logs.push(line)
  })
})

afterAll(async () => {
  await server.stop()
  await rm(dist, { recursive: true, force: true })
})

describe("the local origin", () => {
  test("prints SMITHERS_LOCAL_ORIGIN when listening and binds 127.0.0.1", () => {
    expect(server.origin).toBe(`http://127.0.0.1:${server.port}`)
    expect(logs).toContain(`SMITHERS_LOCAL_ORIGIN=${server.origin}`)
  })

  test("serves the SPA with an index.html fallback and hashed assets", async () => {
    const root = await fetch(`${server.origin}/`)
    expect(root.status).toBe(200)
    const html = await root.text()
    expect(html).toContain("<div id=\"root\">")
    expect(html).toContain(`<meta name="${LOCAL_SESSION_META}" content="${server.sessionToken}">`)
    const deep = await fetch(`${server.origin}/some/client/route`)
    expect(deep.status).toBe(200)
    expect(deep.headers.get("content-type")).toContain("text/html")
    const asset = await fetch(`${server.origin}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get("cache-control")).toContain("immutable")
    expect(await asset.text()).toBe("console.log('hi')")
  })

  test("refuses path traversal out of dist", async () => {
    const response = await fetch(`${server.origin}/assets/..%2F..%2F..%2Fetc%2Fpasswd`)
    // Either the fallback document or nothing: never a file outside dist.
    expect(await response.text()).not.toContain("root:")
  })

  test("a malformed percent-encoding answers the envelope with a trail line, and a dotted directory falls back to the SPA", async () => {
    const staticPath = await fetch(`${server.origin}/%E0%A4%A`)
    expect(staticPath.status).toBe(400)
    expect(staticPath.headers.get("content-type")).toContain("application/json")
    /*
     * The envelope carries the refusal twice: the route's own name where this
     * host's clients read it, and the same refusal classified in the host's
     * namespace (@smthrs/rpc/NativeFailureCodes) for the app's one classifier.
     */
    expect(await staticPath.json()).toEqual({
      error: { code: "invalid_path", message: "Request path is not valid percent-encoded UTF-8." },
      status: "error",
      code: "native_invalid_path",
      message: "Request path is not valid percent-encoded UTF-8.",
      origin: "local"
    })
    const before = logs.length
    const routed = await apiFetch("/api/agent/%E0%A4%A/turn")
    expect(routed.status).toBe(404)
    expect(((await routed.json()) as { error: { code: string } }).error.code).toBe("not_found")
    // A path that never reaches a handler still leaves its line.
    expect(logs.slice(before).some((line) => /^GET \/api\/agent\/%E0%A4%A\/turn -> 404 in \d+ms$/.test(line))).toBe(true)
    // `Bun.file(<directory>)` throws EISDIR, and a dotted name looks like a file.
    await mkdir(join(dist, "docs.d"), { recursive: true })
    const dotted = await fetch(`${server.origin}/docs.d/`)
    expect(dotted.status).toBe(200)
    expect(dotted.headers.get("content-type")).toContain("text/html")
  })

  test("unknown /api paths answer a JSON 404, method mismatches a 405", async () => {
    const missing = await apiFetch("/api/nope")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({
      error: { code: "not_found", message: "No route for GET /api/nope." },
      code: "native_not_found",
      origin: "local"
    })
    const wrongMethod = await apiFetch("/api/health", { method: "POST" })
    expect(wrongMethod.status).toBe(405)
  })

  test("privileged HTTP rejects missing capabilities, foreign origins, bad hosts, and non-JSON writes", async () => {
    expect((await fetch(`${server.origin}${APP_BOOTSTRAP_PATH}`)).status).toBe(401)
    expect((await apiFetch(APP_BOOTSTRAP_PATH, { headers: { origin: "https://evil.test" } })).status).toBe(403)
    expect((await fetch(`${server.origin}/`, { headers: { host: "evil.test" } })).status).toBe(421)
    const plain = await apiFetch("/api/agent/turn/erase", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ runId: "plain", messages: [], instructions: "" })
    })
    expect(plain.status).toBe(415)
  })

  test("a wrong-length or same-length wrong capability is refused on the header and /api/cloud-ws", async () => {
    const token = server.sessionToken
    const sameLength = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`
    for (const wrong of [`${token}x`, token.slice(0, 8), sameLength]) {
      const header = await fetch(`${server.origin}/api/repos`, { headers: { [LOCAL_SESSION_HEADER]: wrong } })
      expect(header.status).toBe(401)
      const protocol = server.websocketProtocol.replace(token, wrong)
      const upgrade = await fetch(`${server.origin}/api/cloud-ws/repos/will/smithers/workspace/sessions/s1/terminal`, {
        headers: { "sec-websocket-protocol": `other, ${protocol}` }
      })
      expect(upgrade.status).toBe(401)
    }
  })

  test("POST /api/telemetry/errors logs the report with its secrets redacted", async () => {
    const report = JSON.stringify({
      name: "TypeError",
      message: "fetch https://api.example.test/v1/items?key=live_c4p4b1l1ty failed with Authorization: Bearer abcdef0123456789token"
    })
    const response = await apiFetch("/api/telemetry/errors", { method: "POST", headers: { "content-type": "application/json" }, body: report })
    expect(response.status).toBe(202)
    const line = logs.find((entry) => entry.startsWith("client-error: ") && entry.includes("TypeError"))
    expect(line).toBeDefined()
    expect(line).not.toContain("live_c4p4b1l1ty")
    expect(line).not.toContain("abcdef0123456789token")
    expect(line).toContain("Bearer [REDACTED_TOKEN]")
  })

  test("POST /api/telemetry/errors redacts diagnostic credential spellings", async () => {
    const secret = "ZqSynthetic7Secret4Value9"
    const report = JSON.stringify({
      name: "DiagnosticSpellingError",
      message: `mysql -u root -p ${secret} db; password: correct horse ${secret}`,
      argv: ["sshpass", "-p", secret]
    })
    const response = await apiFetch("/api/telemetry/errors", { method: "POST", headers: { "content-type": "application/json" }, body: report })
    expect(response.status).toBe(202)
    const line = logs.find((entry) => entry.startsWith("client-error: ") && entry.includes("DiagnosticSpellingError"))
    expect(line).toBeDefined()
    expect(line).not.toContain(secret)
    expect(line).toContain("[REDACTED]")
  })

  test("the OAuth legs are navigations: no session header, yet never 401", async () => {
    // A top-level navigation (window.location, the system browser from the
    // native handoff) cannot carry the local-session header; gating these
    // two on it answered 401 to every sign-in attempt from this origin.
    for (const path of ["/api/auth/github/start?handoff=abc", "/api/auth/github/callback?code=1&state=2"]) {
      const response = await fetch(`${server.origin}${path}`, { redirect: "manual" })
      expect(response.status).not.toBe(401)
      expect(response.status).toBe(501) // the stub seam: reached, and honest about being stubbed
    }
    // Everything else under /api/ still needs the capability.
    expect((await fetch(`${server.origin}/api/user`)).status).toBe(401)
    expect((await fetch(`${server.origin}/api/auth/github/start`, { method: "POST" })).status).toBe(401)
  })

  test("a proxied ready claim re-scopes the session cookie and the trail says the cookie was there", async () => {
    // A fake identity upstream: the claim answers ready with a Domain-scoped session cookie.
    const upstreamHeaders: Array<Headers> = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => (upstreamHeaders.push(request.headers), new URL(request.url).pathname === "/api/auth/native/claim")
          ? new Response(JSON.stringify({ status: "ready" }), {
            headers: {
              "content-type": "application/json",
              "set-cookie": "smithers_session=sealed; Domain=identity.test; Path=/; HttpOnly; Secure; SameSite=Lax"
            }
          })
          : new Response("{}", { status: 404, headers: { "content-type": "application/json" } })
    })
    const proxyLogs: Array<string> = []
    const proxied = await startLocalServer({
      port: 0,
      distDir: dist,
      cloudMode: "hybrid",
      identityUpstream: `http://127.0.0.1:${upstream.port}`,
      home: "/fake/home",
      log: (line) => proxyLogs.push(line)
    })
    try {
      const response = await fetch(`${proxied.origin}/api/auth/native/claim`, {
        method: "POST",
        headers: {
          [LOCAL_SESSION_HEADER]: proxied.sessionToken,
          origin: proxied.origin,
          "content-type": "application/json"
        },
        body: JSON.stringify({ handoffId: "h", pollSecret: "s" })
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: "ready" })
      const cookie = response.headers.getSetCookie()[0] ?? ""
      expect(cookie.startsWith("smithers_session=sealed")).toBe(true)
      expect(cookie.toLowerCase()).not.toContain("domain=")
      // WebKit refuses a Secure cookie set over http://127.0.0.1; every other attribute survives.
      expect(cookie.toLowerCase()).not.toContain("secure")
      expect(cookie).toContain("Path=/")
      expect(cookie).toContain("HttpOnly")
      expect(cookie).toContain("SameSite=Lax")
      // The trail names the attributes the WebView was handed, never the value.
      expect(proxyLogs).toContain(
        "/api/auth/native/claim -> 200, set-cookie present: smithers_session=<redacted>; Path=/; HttpOnly; SameSite=Lax"
      )
      expect(proxyLogs.join("\n")).not.toContain("sealed")
      // The local session capability authorizes this origin only; the seam never receives it.
      expect(upstreamHeaders).toHaveLength(1)
      expect(upstreamHeaders[0]?.get(LOCAL_SESSION_HEADER)).toBeNull()
      expect(upstreamHeaders[0]?.get("origin")).toBe(`http://127.0.0.1:${upstream.port}`)
    } finally {
      await proxied.stop()
      upstream.stop(true)
    }
  })

  test("a thrown handler or an unreachable upstream answers a product sentence; the raw text stays in the trail", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
    const deadOrigin = `http://127.0.0.1:${closed.port}`
    closed.stop(true)
    const trail: Array<string> = []
    const cloudAuth = {
      start: async () => { throw new Error("secret-handler-detail") },
      token: () => undefined,
      session: () => ({ state: "signed-out", username: null, expiresAt: null }),
      signOut: async () => {},
      stop: async () => {}
    } as unknown as CloudAuth
    const local = await startLocalServer({
      port: 0,
      distDir: dist,
      cloudMode: "hybrid",
      cloudApi: deadOrigin,
      identityUpstream: deadOrigin,
      cloudAuth,
      home: "/fake/home",
      log: (line) => trail.push(line)
    })
    try {
      const headers = { [LOCAL_SESSION_HEADER]: local.sessionToken, origin: local.origin }
      const thrown = await fetch(`${local.origin}${CLOUD_AUTH_START_PATH}`, { method: "POST", headers })
      expect(thrown.status).toBe(500)
      const thrownBody = await thrown.json() as { message: string }
      expect(thrownBody.message).toBe("The local app hit an unexpected error. Try again.")
      expect(JSON.stringify(thrownBody)).not.toContain("secret-handler-detail")
      expect(trail.some((line) => line.includes("secret-handler-detail"))).toBe(true)
      for (const [path, seam] of [["/api/user", "The Smithers identity service"], ["/api/cloud/api/user", "Smithers Cloud"]] as const) {
        const before = trail.length
        const dropped = await fetch(`${local.origin}${path}`, { headers })
        const body = await dropped.json() as { code: string; message: string }
        expect(body).toMatchObject({ code: "upstream_unreachable", message: `${seam} is unreachable right now. Try again in a moment.` })
        expect(trail.slice(before).some((line) => line.startsWith(`${seam} is unreachable: `))).toBe(true)
      }
    } finally {
      await local.stop()
    }
  })

  test("rescopeCookie drops Domain and Secure wherever they sit and leaves the rest", () => {
    expect(rescopeCookie("s=v; Domain=identity.test; Path=/; HttpOnly; Secure; SameSite=Lax"))
      .toBe("s=v; Path=/; HttpOnly; SameSite=Lax")
    expect(rescopeCookie("s=v; Path=/; secure")).toBe("s=v; Path=/")
    expect(rescopeCookie("s=v; Secure; Path=/")).toBe("s=v; Path=/")
    // Only the attribute goes: a name or value that merely contains the word stays.
    expect(rescopeCookie("secure_id=insecure; Path=/; SecureFlag=1")).toBe("secure_id=insecure; Path=/; SecureFlag=1")
    expect(describeCookie("smithers_session=sealed-secret; Path=/; HttpOnly")).toBe(
      "smithers_session=<redacted>; Path=/; HttpOnly"
    )
  })

  test("every / and /api request leaves a status-and-duration trail line", async () => {
    const before = logs.length
    const response = await fetch(`${server.origin}/api/health`)
    expect(response.status).toBe(200)
    expect(logs.slice(before).some((line) => /^GET \/api\/health -> 200 in \d+ms$/.test(line))).toBe(true)
  })

  test("the product-API families forward to the Worker with the session cookie; unknown /api paths still 404 locally", async () => {
    const seen: Array<{ path: string; cookie: string | null; origin: string | null }> = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        seen.push({ path: new URL(request.url).pathname, cookie: request.headers.get("cookie"), origin: request.headers.get("origin") })
        return new Response(JSON.stringify([{ number: 7, title: "an issue" }]), { headers: { "content-type": "application/json" } })
      }
    })
    const proxied = await startLocalServer({
      port: 0,
      distDir: dist,
      cloudMode: "hybrid",
      identityUpstream: `http://127.0.0.1:${upstream.port}`,
      home: "/fake/home",
      log: () => {}
    })
    try {
      const headers = { [LOCAL_SESSION_HEADER]: proxied.sessionToken, origin: proxied.origin, cookie: "smithers_identity=sealed" }
      const bootstrap = await (await fetch(`${proxied.origin}/api/bootstrap`, { headers })).json() as { capabilities: string[] }
      expect(bootstrap.capabilities).toContain("billing.balance")
      expect(bootstrap.capabilities).toContain("billing.overview")
      expect(bootstrap.capabilities).toContain("billing.plans")
      for (const path of ["/api/user", "/api/repos/smithersai/smithers/issues?state=open", "/api/user/github-repos/smithersai/smithers/issues", "/api/billing/balance", "/api/billing", "/api/billing/plans", "/api/notifications/unread", "/api/workflow/provision"]) {
        const response = await fetch(`${proxied.origin}${path}`, { headers })
        expect(response.status).toBe(200)
      }
      expect(seen.map((entry) => entry.path)).toEqual([
        "/api/user",
        "/api/repos/smithersai/smithers/issues",
        "/api/user/github-repos/smithersai/smithers/issues",
        "/api/billing/balance",
        "/api/billing",
        "/api/billing/plans",
        "/api/notifications/unread",
        "/api/workflow/provision",
      ])
      // The Worker authenticates by the identity session cookie; the Origin follows the upstream like every identity call.
      expect(seen.every((entry) => entry.cookie === "smithers_identity=sealed")).toBe(true)
      expect(seen.every((entry) => entry.origin === `http://127.0.0.1:${upstream.port}`)).toBe(true)
      expect((await fetch(`${proxied.origin}/api/auth/session`, { headers })).status).toBe(404)
      const unknown = await fetch(`${proxied.origin}/api/nothing/here`, { headers })
      expect(unknown.status).toBe(404)
      for (const path of ["/api/linear", "/api/integrations/linear", "/api/auth/linear", "/api/repos/a/b/issues/1/linear-link", "/api/cloud/api/linear", "/api/cloud/api/integrations/linear", "/api/cloud/api/auth/linear", "/api/cloud/api/repos/a/b/issues/1/linear-link"]) {
        for (const method of ["GET", "POST", "DELETE"]) {
          const response = await fetch(`${proxied.origin}${path}`, { method, headers })
          expect(response.status).toBe(404)
          expect(await response.json()).toMatchObject({ error: { code: "not_found" }, code: "native_not_found", origin: "local" })
          expect(seen).toHaveLength(8)
        }
      }
      // Retired paths do not bypass the native session or origin boundary.
      expect((await fetch(`${proxied.origin}/api/linear`)).status).toBe(401)
      expect((await fetch(`${proxied.origin}/api/linear`, {
        headers: { ...headers, origin: "https://foreign.invalid" }
      })).status).toBe(403)
      expect((await fetch(`${proxied.origin}/webhooks/linear`, { method: "POST", body: "{}" })).status).toBe(405)
      expect((await fetch(`${proxied.origin}/api/billing`, { method: "POST", headers })).status).toBe(404)
      expect((await fetch(`${proxied.origin}/api/billing-other`, { headers })).status).toBe(404)
      expect(seen).toHaveLength(8)
    } finally {
      await proxied.stop()
      upstream.stop(true)
    }
  })

  test("offline, the product-API families answer 501 instead of a misleading 404", async () => {
    const response = await apiFetch("/api/repos/smithersai/smithers/issues")
    expect(response.status).toBe(501)
  })

  test("offline identity has no user session or legacy session route", async () => {
    expect((await apiFetch("/api/user")).status).toBe(501)
    expect((await apiFetch("/api/auth/session")).status).toBe(404)
    expect((await apiFetch("/api/auth/native/start", { method: "POST" })).status).toBe(501)
  })
})

describe("the Smithers Cloud seam", () => {
  test("the bootstrap this host serves is one the client's own schema admits", async () => {
    // The SPA refuses to start on a bootstrap its schema rejects ("Runtime
    // bootstrap broke its contract"), so a field the client requires is part
    // of this route's contract and the key is never omitted.
    //
    // It is a DESCRIPTOR and not `null`: this host wraps no child process —
    // the seatbelt and bubblewrap mechanisms live in `@smthrs/build`
    // `ExecSandbox` and nothing here selects one — so it says `unavailable`
    // and `unenforced` rather than claiming an enforcement it does not perform.
    const body: unknown = await (await apiFetch(APP_BOOTSTRAP_PATH)).json()
    const parsed = AppBootstrapSchema.safeParse(body)
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)).toEqual([])
    expect((body as { readonly sandbox?: unknown }).sandbox).toEqual({
      platform: process.platform,
      mode: "unavailable",
      policies: { loader: "unenforced", targetRun: "unenforced" }
    })
  })

  test("offline answers 501 like the identity stub, and the session is honestly signed-out", async () => {
    // Offline the host claims neither cloud door: the bootstrap is the shared
    // table (@smthrs/rpc/HostCapabilities) for a launch with no Smithers Cloud upstream.
    const bootstrap = (await (await apiFetch("/api/bootstrap")).json()) as { capabilities: Array<string> }
    expect(bootstrap.capabilities).toEqual(
      localCapabilities({ agent: false, identity: false, cloud: false })
    )
    expect((await apiFetch("/api/cloud/api/user/repos")).status).toBe(501)
    expect((await apiFetch("/api/cloud-auth/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    })).status).toBe(501)
    expect((await apiFetch("/api/cloud-auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    })).status).toBe(501)
    const session = await apiFetch("/api/cloud-auth/session")
    expect(await session.json()).toEqual({ state: "signed-out", username: null, expiresAt: null })
  })

  test("/api/cloud/* refuses a scheme-relative path and never forwards the identity cookie", async () => {
    const seen: Array<{ path: string; cookie: string | null }> = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        seen.push({ path: new URL(request.url).pathname, cookie: request.headers.get("cookie") })
        return new Response("{}", { headers: { "content-type": "application/json" } })
      }
    })
    const proxied = await startLocalServer({
      port: 0,
      distDir: dist,
      cloudMode: "hybrid",
      // This host is the cloud proxy alone; the identity seam has its own tests.
      identityUpstream: null,
      cloudApi: `http://127.0.0.1:${upstream.port}`,
      cloudAuth: {
        token: () => "smithers_test_token",
        session: () => ({ state: "signed-in", username: "will", expiresAt: null }),
        start: async () => ({ error: "already signed in" }),
        signOut: async () => {},
        stop: async () => {}
      },
      home: "/fake/home",
      log: () => {}
    })
    try {
      const headers = { [LOCAL_SESSION_HEADER]: proxied.sessionToken, cookie: "smithers_identity=sealed" }
      // `//evil.example/x` sliced naively is scheme-relative: the bearer would go to evil.example.
      for (const path of ["/api/cloud//evil.example/x", "/api/cloud/"]) {
        const refused = await fetch(`${proxied.origin}${path}`, { headers })
        expect(refused.status).toBe(400)
        /* The Worker's envelope on the route the Worker also serves, so one classifier reads both hosts. */
        expect(await refused.json()).toMatchObject({ status: "error", code: "request_invalid" })
      }
      expect(seen).toEqual([])
      const ok = await fetch(`${proxied.origin}/api/cloud/api/user/repos`, { headers })
      expect(ok.status).toBe(200)
      expect(seen).toEqual([{ path: "/api/user/repos", cookie: null }])
      // A percent-encoded backslash stays a path segment on the upstream origin, never a host.
      const encoded = await fetch(`${proxied.origin}/api/cloud/%5C%5Cevil.example/x`, { headers })
      expect(encoded.status).toBe(200)
      expect(seen[1]?.path.startsWith("/%5C%5Cevil.example")).toBe(true)
    } finally {
      await proxied.stop()
      upstream.stop(true)
    }
  })

  test("/api/cloud/* forwards with the Bun-held bearer, the identity-proxy rewrites, and a trail line", async () => {
    const upstreamHeaders: Array<Headers> = []
    const events = 'id: 1007\nevent: notification.fact\ndata: {"sequence":1007}\n\n'
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        upstreamHeaders.push(request.headers)
        const { pathname } = new URL(request.url)
        if (pathname === "/api/notifications/events/stream") {
          return new Response(events, { headers: { "content-type": "text/event-stream" } })
        }
        return pathname === "/api/user/repos"
          ? new Response(JSON.stringify([{ full_name: "will/smithers" }]), {
            headers: {
              "content-type": "application/json",
              "set-cookie": "cloud_session=sealed; Domain=api.smithers-cloud.test; Path=/; Secure; HttpOnly"
            }
          })
          : new Response("not found", { status: 404 })
      }
    })
    const cloudLogs: Array<string> = []
    const proxied = await startLocalServer({
      port: 0,
      distDir: dist,
      cloudMode: "hybrid",
      // This host is the cloud proxy alone; the identity seam has its own tests.
      identityUpstream: null,
      cloudApi: `http://127.0.0.1:${upstream.port}`,
      cloudAuth: {
        token: () => "smithers_test_token",
        session: () => ({ state: "signed-in", username: "will", expiresAt: null }),
        start: async () => ({ error: "already signed in" }),
        signOut: async () => {},
        stop: async () => {}
      },
      home: "/fake/home",
      log: (line) => cloudLogs.push(line)
    })
    try {
      const bootstrap = (await (await fetch(`${proxied.origin}/api/bootstrap`, {
        headers: { [LOCAL_SESSION_HEADER]: proxied.sessionToken }
      })).json()) as { capabilities: Array<string> }
      // The same table the parity matrix reads: a Smithers Cloud upstream opens both cloud doors.
      expect(bootstrap.capabilities).toEqual(
        localCapabilities({ agent: false, identity: false, cloud: true, browser: true })
      )

      const response = await fetch(`${proxied.origin}/api/cloud/api/user/repos?per_page=1`, {
        headers: {
          [LOCAL_SESSION_HEADER]: proxied.sessionToken,
          origin: proxied.origin,
          // A renderer-supplied bearer is a forgery: the token never reaches the renderer.
          authorization: "Bearer renderer_forgery"
        }
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([{ full_name: "will/smithers" }])
      expect(upstreamHeaders).toHaveLength(1)
      const headers = upstreamHeaders[0]!
      expect(headers.get("authorization")).toBe("Bearer smithers_test_token")
      expect(headers.get(LOCAL_SESSION_HEADER)).toBeNull()
      expect(headers.get("host")).toBe(`127.0.0.1:${upstream.port}`)
      expect(headers.get("origin")).toBe(`http://127.0.0.1:${upstream.port}`)
      const cookie = response.headers.getSetCookie()[0] ?? ""
      expect(cookie.startsWith("cloud_session=sealed")).toBe(true)
      expect(cookie.toLowerCase()).not.toContain("domain=")
      expect(cookie.toLowerCase()).not.toContain("secure")
      expect(cloudLogs.some((line) => /^GET \/api\/cloud\/api\/user\/repos -> 200 in \d+ms$/.test(line))).toBe(true)
      const resumed = await fetch(`${proxied.origin}/api/cloud/api/notifications/events/stream?after=12`, {
        headers: { [LOCAL_SESSION_HEADER]: proxied.sessionToken, accept: "text/event-stream", "Last-Event-ID": "1006" }
      })
      expect(resumed.status).toBe(200)
      expect(resumed.headers.get("content-type")).toBe("text/event-stream")
      expect(await resumed.text()).toBe(events)
      expect(upstreamHeaders[1]?.get("last-event-id")).toBe("1006")
      expect(upstreamHeaders[1]?.get("authorization")).toBe("Bearer smithers_test_token")
      expect(upstreamHeaders[1]?.has(LOCAL_SESSION_HEADER)).toBe(false)
      // The sign-in routes answer through the injected manager.
      const session = await fetch(`${proxied.origin}/api/cloud-auth/session`, {
        headers: { [LOCAL_SESSION_HEADER]: proxied.sessionToken }
      })
      expect(await session.json()).toEqual({ state: "signed-in", username: "will", expiresAt: null })
      const started = await fetch(`${proxied.origin}/api/cloud-auth/start`, {
        method: "POST",
        headers: { [LOCAL_SESSION_HEADER]: proxied.sessionToken, "content-type": "application/json" },
        body: "{}"
      })
      expect(started.status).toBe(409)
    } finally {
      await proxied.stop()
      upstream.stop(true)
    }
  })
})


describe("conversation cutover", () => {
  test("the five legacy writes return 404 and never invoke an agent", async () => {
    for (const path of ["/api/agent/turn", "/api/agent/turn/cancel", "/api/agent/turn/retire", "/api/chat/turn", "/api/chat/cancel"]) {
      const response = await apiFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: '{}' })
      expect(response.status).toBe(404)
    }
  })
})

describe("defaultDistDir", () => {
  test("SMITHERS_DIST_DIR wins, then the bundled views, then apps/app/dist", async () => {
    expect(defaultDistDir("/x/bun", { SMITHERS_DIST_DIR: "/explicit" })).toBe("/explicit")
    const app = await mkdtemp(join(tmpdir(), "smithers-app-"))
    await mkdir(join(app, "views", "mainview"), { recursive: true })
    await writeFile(join(app, "views", "mainview", "index.html"), "<html>")
    expect(defaultDistDir(join(app, "bun"), {})).toBe(join(app, "views", "mainview"))
    expect(defaultDistDir("/nowhere/src/bun", {})).toBe("/nowhere/dist")
    await rm(app, { recursive: true, force: true })
  })
})

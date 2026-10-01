import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { refusalOf } from "@smthrs/rpc/Refusal"
import { startLocalServer } from "./server"
import type { LocalServer } from "./server"

/* Real local HTTP proxies must bound time to headers and preserve safe refusals. */

const DEADLINE_MS = 150

/** A socket that accepts and never answers, the shape a hung upstream has. */
const hangingUpstream = () =>
  Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, fetch: () => new Promise<Response>(() => {}) })

let dist: string

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "smithers-proxy-deadline-"))
  await writeFile(join(dist, "index.html"), "<!doctype html><title>t</title>")
})

const cloudHost = (upstreamOrigin: string): Promise<LocalServer> =>
  startLocalServer({
    port: 0,
    distDir: dist,
    cloudMode: "hybrid",
    cloudApi: upstreamOrigin,
    upstreamTimeoutMs: DEADLINE_MS,
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

const identityHost = (upstreamOrigin: string): Promise<LocalServer> =>
  startLocalServer({
    port: 0,
    distDir: dist,
    cloudMode: "hybrid",
    identityUpstream: upstreamOrigin,
    cloudApi: null,
    upstreamTimeoutMs: DEADLINE_MS,
    home: "/fake/home",
    log: () => {}
  })

describe("an upstream that never answers", () => {
  test("the cloud proxy gives up at its deadline with upstream_timeout", async () => {
    const upstream = hangingUpstream()
    const host = await cloudHost(`http://127.0.0.1:${upstream.port}`)
    try {
      const started = Date.now()
      const response = await fetch(`${host.origin}/api/cloud/api/user/repos`, {
        headers: { [LOCAL_SESSION_HEADER]: host.sessionToken }
      })
      const elapsed = Date.now() - started
      expect(response.status).toBe(504)
      const body = (await response.json()) as { code?: string; message?: string; origin?: string }
      expect(body.code).toBe("upstream_timeout")
      // The refusal identifies the local host that applied the deadline.
      expect(body.origin).toBe("local")
      expect(body.message).toContain(`did not answer within ${DEADLINE_MS}ms`)
      const refusal = refusalOf({ body, status: response.status, message: body.message ?? "" })
      expect(refusal.fault).toBe("dependency")
      expect(refusal.origin).toBe("local")
      // The request came back on the deadline, not on the process's lifetime.
      expect(elapsed).toBeLessThan(10_000)
    } finally {
      await host.stop()
      upstream.stop(true)
    }
  }, 20_000)

  test("the identity proxy gives up the same way, where it used to hang until the app gave up", async () => {
    const upstream = hangingUpstream()
    const host = await identityHost(`http://127.0.0.1:${upstream.port}`)
    try {
      const response = await fetch(`${host.origin}/api/user`, {
        headers: { [LOCAL_SESSION_HEADER]: host.sessionToken }
      })
      expect(response.status).toBe(504)
      const body = (await response.json()) as { code?: string; origin?: string; message?: string }
      expect(body.code).toBe("upstream_timeout")
      expect(body.origin).toBe("local")
      expect(body.message).toContain("identity service")
    } finally {
      await host.stop()
      upstream.stop(true)
    }
  }, 20_000)

  test("the deadline covers the HEADERS only, so a slow stream is never cut off mid-body", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 60,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              // Headers and the first byte are out at once; the rest of the
              // body lands well past the deadline.
              controller.enqueue(new TextEncoder().encode("{\"late\""))
              setTimeout(() => {
                controller.enqueue(new TextEncoder().encode(":true}"))
                controller.close()
              }, DEADLINE_MS * 4)
            }
          }),
          { headers: { "content-type": "application/json" } }
        )
    })
    const host = await cloudHost(`http://127.0.0.1:${upstream.port}`)
    try {
      const response = await fetch(`${host.origin}/api/cloud/api/user/repos`, {
        headers: { [LOCAL_SESSION_HEADER]: host.sessionToken }
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ late: true })
    } finally {
      await host.stop()
      upstream.stop(true)
    }
  }, 20_000)


})

describe("an upstream that refuses", () => {
  test("a router's plain 404 is restated, never handed to the reader", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("404 page not found\n", { status: 404, headers: { "content-type": "text/plain" } })
    })
    const host = await cloudHost(`http://127.0.0.1:${upstream.port}`)
    try {
      const response = await fetch(`${host.origin}/api/cloud/api/user/repos`, {
        headers: { [LOCAL_SESSION_HEADER]: host.sessionToken }
      })
      expect(response.status).toBe(404)
      expect(response.headers.get("content-type")).toContain("application/json")
      const body = (await response.json()) as { status?: string; message?: string }
      expect(body.status).toBe("error")
      expect(body.message).not.toContain("page not found")
      expect(body.message).toBe("Smithers Cloud doesn't serve that request.")
    } finally {
      await host.stop()
      upstream.stop(true)
    }
  }, 20_000)

  test("an HTML error page from the identity seam never reaches a seam's fetch", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response("<!doctype html><title>Error 1101</title><body>Worker threw exception</body>", {
          status: 500,
          headers: { "content-type": "text/html" }
        })
    })
    const host = await identityHost(`http://127.0.0.1:${upstream.port}`)
    try {
      const response = await fetch(`${host.origin}/api/user`, {
        headers: { [LOCAL_SESSION_HEADER]: host.sessionToken, accept: "application/json" }
      })
      expect(response.status).toBe(500)
      const body = (await response.json()) as { status?: string; message?: string }
      expect(body.status).toBe("error")
      expect(body.message).not.toContain("<")
      expect(body.message).toContain("having trouble right now")
    } finally {
      await host.stop()
      upstream.stop(true)
    }
  }, 20_000)

  test("keeps the facts a client acts on: the upstream's code, retry_after and Retry-After", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ code: "no_capacity", message: "No sandbox slots are free.", retry_after: 30 }), {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "30" }
        })
    })
    const host = await cloudHost(`http://127.0.0.1:${upstream.port}`)
    try {
      const response = await fetch(`${host.origin}/api/cloud/api/user/repos`, {
        headers: { [LOCAL_SESSION_HEADER]: host.sessionToken }
      })
      expect(response.status).toBe(503)
      expect(response.headers.get("retry-after")).toBe("30")
      const body = (await response.json()) as { code?: string; message?: string; retry_after?: number }
      // The code is what separates a full fleet from this account's own cap;
      // a sentence alone cannot, and the prose is still the upstream's.
      expect(body.code).toBe("no_capacity")
      expect(body.retry_after).toBe(30)
      expect(body.message).toBe("No sandbox slots are free.")
      const refusal = refusalOf({ body, status: response.status, message: body.message ?? "" })
      expect(refusal.code).toBe("no_capacity")
      expect(refusal.origin).toBe("plue")
    } finally {
      await host.stop()
      upstream.stop(true)
    }
  }, 20_000)

  /*
   * The native sign-in handoff opens `/api/auth/sign-in?handoff=…` on this
   * origin in the SYSTEM BROWSER. A failed navigation is answered by the
   * upstream with a branded page a person reads; restating that as JSON would
   * leave a blob of it in a browser window.
   */
  test("a page a person navigated to keeps the upstream's own page", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response("<!doctype html><title>Sign-in didn't finish</title>", {
          status: 400,
          headers: { "content-type": "text/html" }
        })
    })
    const host = await identityHost(`http://127.0.0.1:${upstream.port}`)
    try {
      // The path the native handoff opens in the system browser, which is a
      // navigation and so carries no local session header at all.
      const response = await fetch(`${host.origin}/api/auth/github/start?handoff=h`, {
        headers: { accept: "text/html,application/xhtml+xml" }
      })
      expect(response.status).toBe(400)
      expect(response.headers.get("content-type")).toContain("text/html")
      expect(await response.text()).toContain("Sign-in didn't finish")
    } finally {
      await host.stop()
      upstream.stop(true)
    }
  }, 20_000)

  test("a refusal that clears a session still carries its cookie, re-scoped to this origin", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ message: "That sign-in expired." }), {
          status: 410,
          headers: {
            "content-type": "application/json",
            "set-cookie": "smithers_session=; Domain=identity.test; Path=/; Secure; HttpOnly; Max-Age=0"
          }
        })
    })
    const host = await identityHost(`http://127.0.0.1:${upstream.port}`)
    try {
      const response = await fetch(`${host.origin}/api/auth/native/claim`, {
        method: "POST",
        headers: { [LOCAL_SESSION_HEADER]: host.sessionToken }
      })
      expect(response.status).toBe(410)
      const cookie = response.headers.getSetCookie()[0] ?? ""
      expect(cookie.startsWith("smithers_session=")).toBe(true)
      expect(cookie.toLowerCase()).not.toContain("domain=")
      expect(cookie.toLowerCase()).not.toContain("secure")
      expect(((await response.json()) as { message?: string }).message).toBe("That sign-in expired.")
    } finally {
      await host.stop()
      upstream.stop(true)
    }
  }, 20_000)
})

afterAll(() => {})

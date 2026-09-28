import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { testConfigLayer } from "./Config"
import type { ServerConfigShape } from "./Config"
import { transportLayer } from "./Http"
import { handleAuthNavigation, probeAuthSession, proxyToIdentity, requireTurnSession, validateSession, validReturnTo } from "./identity"

/*
 * The identity seam as Effects over injected layers: the transport is a
 * function, the configuration a record, and no global is patched. The router
 * tests hold the same behaviours at the HTTP surface; these hold the
 * validation outcomes the router branches on.
 */

const IDENTITY = "https://identity.test"

interface Seen {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly body: string
}

const wire = (answer: (request: Request) => Response | Promise<Response>) => {
  const seen: Array<Seen> = []
  const layer = transportLayer(async (input, init) => {
    const request = new Request(input, init)
    seen.push({ url: request.url, method: request.method, headers: request.headers, body: await request.clone().text() })
    return answer(request)
  })
  return { seen, layer }
}

const config = (overrides: Partial<ServerConfigShape> = {}) =>
  testConfigLayer({ identityUpstreamUrl: IDENTITY, identityServiceToken: Redacted.make("service-token"), ...overrides })

const run = <A>(effect: Effect.Effect<A, never, any>, ...layers: ReadonlyArray<Layer.Layer<any>>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(...(layers as [Layer.Layer<any>])))))

const session = (cookie?: string): Request =>
  new Request("https://mvp.test/api/agent/turn", { method: "POST", headers: cookie === undefined ? {} : { cookie } })

const jsonAnswer = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("validateSession", () => {
  test("posts the cookie and the service token to /api/identity/validate and reads the identity back", async () => {
    const { seen, layer } = wire(() => jsonAnswer(200, { login: "will", allowlisted: true, admin: true, scopes: ["a", 7] }))
    const outcome = await run(validateSession(session("smithers_session=abc")), layer, config())
    expect(outcome).toEqual({
      status: "valid",
      identity: { login: "will", allowlisted: true, admin: true, scopes: ["a"] }
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ url: `${IDENTITY}/api/identity/validate`, method: "POST", body: "{}" })
    expect(seen[0]!.headers.get("cookie")).toBe("smithers_session=abc")
    expect(seen[0]!.headers.get("x-smithers-service-token")).toBe("service-token")
  })

  test("a request with no cookie is signed out without an identity subrequest, even when identity is down", async () => {
    const { seen, layer } = wire(() => Promise.reject(new Error("connection reset")))
    expect(await run(validateSession(session()), layer, config())).toEqual({ status: "invalid" })
    expect(await run(validateSession(session("")), layer, config())).toEqual({ status: "invalid" })
    expect(seen).toEqual([])
    const gate = await run(requireTurnSession(session()), layer, config())
    expect((gate as Response).status).toBe(401)
    expect(seen).toEqual([])
  })

  test("a 401 is invalid; any other refusal is the seam being unavailable, with its status named", async () => {
    const refused = await run(validateSession(session("smithers_session=abc")), wire(() => new Response("{}", { status: 401 })).layer, config())
    expect(refused).toEqual({ status: "invalid" })
    const broken = await run(validateSession(session("smithers_session=abc")), wire(() => new Response("{}", { status: 500 })).layer, config())
    expect(broken.status).toBe("unavailable")
    if (broken.status === "unavailable") {
      expect(broken.response.status).toBe(502)
      expect(await broken.response.json()).toEqual({ status: "error", code: "upstream_refused", message: "The identity service answered HTTP 500." })
    }
  })

  test("a loginless 200 is signed out whatever cookies the request carried; only an unparseable body is malformed", async () => {
    // Identity decides a validate by the session cookie alone and answers a
    // missing, stale, or foreign-secret one with a loginless 200. Any other
    // first-party cookie (the live-tutorial cookie, an edge cookie) must not
    // turn that answer into a 502 outage that closes the anonymous door.
    const answer = () => jsonAnswer(200, { state: "signed-out", login: null })
    expect(await run(validateSession(session("__Host-smithers-tutorial=x")), wire(answer).layer, config())).toEqual({ status: "invalid" })
    expect(await run(validateSession(session("smithers_identity=stale")), wire(answer).layer, config())).toEqual({ status: "invalid" })
    const unparseable = await run(
      validateSession(session("smithers_identity=abc")),
      wire(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })).layer,
      config()
    )
    expect(unparseable.status).toBe("unavailable")
    if (unparseable.status === "unavailable") {
      expect(await unparseable.response.json()).toEqual({
        status: "error",
        code: "upstream_malformed",
        message: "The identity service returned a malformed session response."
      })
    }
  })

  test("an unreachable seam is a 502 and a deadline a 504 naming its milliseconds, never a false sign-in", async () => {
    const down = await run(
      validateSession(session("smithers_session=abc")),
      wire(() => Promise.reject(new Error("connection reset"))).layer,
      config()
    )
    expect(down.status).toBe("unavailable")
    if (down.status === "unavailable") {
      expect(down.response.status).toBe(502)
      expect(await down.response.json()).toEqual({ status: "error", code: "upstream_unreachable", message: "The identity service is unreachable." })
    }
    const stalled = wire((request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
      })
    )
    const slow = await run(validateSession(session("smithers_session=abc")), stalled.layer, config({ upstreamTimeoutMs: 20 }))
    expect(slow.status).toBe("unavailable")
    if (slow.status === "unavailable") {
      expect(slow.response.status).toBe(504)
      expect(await slow.response.json()).toEqual({ status: "error", code: "upstream_timeout", message: "The identity service did not answer within 20ms." })
    }
  })

  test("with no identity seam every session is invalid and nothing is fetched", async () => {
    const { seen, layer } = wire(() => jsonAnswer(200, { login: "will" }))
    expect(await run(validateSession(session("smithers_session=abc")), layer, testConfigLayer())).toEqual({ status: "invalid" })
    expect(seen).toEqual([])
  })
})

describe("requireTurnSession", () => {
  test("public admission is an explicit authority claim, never implied by a fresh or revoked login", async () => {
    const answers = [
      [{ login: "new-user", allowlisted: false, admission: "public" }, true],
      [{ login: "revoked", allowlisted: false }, false],
      [{ login: "denied", allowlisted: false, admission: "denied" }, false],
      [{ login: "legacy", allowlisted: false, admission: true }, false],
      [{ login: "invited", allowlisted: true }, true]
    ] as const
    for (const [body, admitted] of answers) {
      const outcome = await run(requireTurnSession(session("smithers_session=abc")), wire(() => jsonAnswer(200, body)).layer, config())
      if (admitted) {
        expect(outcome).toMatchObject({ login: body.login })
      } else {
        expect(outcome).toBeInstanceOf(Response)
        expect((outcome as Response).status).toBe(403)
      }
    }
    const signedOut = await run(requireTurnSession(session("smithers_session=stale")), wire(() => jsonAnswer(200, { admission: "public" })).layer, config())
    expect((signedOut as Response).status).toBe(401)
  })
  test("fails closed without a seam and asks no one", async () => {
    const { seen, layer } = wire(() => jsonAnswer(200, { login: "will", allowlisted: true }))
    const unseamed = await run(requireTurnSession(session("smithers_session=abc")), layer, testConfigLayer())
    expect(unseamed).toBeInstanceOf(Response)
    expect((unseamed as Response).status).toBe(501)
    const body = (await (unseamed as Response).json()) as { code: string; message: string }
    expect(body.code).toBe("deployment_not_configured")
    expect(body.message).toContain("IDENTITY_UPSTREAM_URL")
    expect(seen).toEqual([])
  })
  test("refuses 401 signed out and 403 off the allowlist, and admits a member", async () => {
    const signedOut = await run(requireTurnSession(session()), wire(() => new Response("{}", { status: 401 })).layer, config())
    expect(signedOut).toBeInstanceOf(Response)
    expect((signedOut as Response).status).toBe(401)
    expect(await (signedOut as Response).json()).toEqual({ status: "error", code: "sign_in_required", message: "Sign in to run a Smithers turn." })
    const stranger = await run(
      requireTurnSession(session("smithers_session=abc")),
      wire(() => jsonAnswer(200, { login: "stranger", allowlisted: false })).layer,
      config()
    )
    expect((stranger as Response).status).toBe(403)
    const member = await run(
      requireTurnSession(session("smithers_session=abc")),
      wire(() => jsonAnswer(200, { login: "will", allowlisted: true })).layer,
      config()
    )
    expect(member).toEqual({ login: "will", allowlisted: true, admin: false, scopes: [] })
  })
})

describe("proxyToIdentity", () => {
  test("forwards the path and query, strips client identity claims, keeps the cookie, and states its own origin", async () => {
    const { seen, layer } = wire(() => jsonAnswer(200, { ok: true }))
    const response = await run(
      proxyToIdentity(
        new Request("https://mvp.test/api/auth/session?probe=1", {
          headers: {
            cookie: "smithers_session=abc",
            "x-user-id": "evil",
            "x-smithers-admin-token": "forged",
            authorization: "Bearer forged"
          }
        })
      ),
      layer,
      config()
    )
    expect(response.status).toBe(200)
    expect(seen[0]!.url).toBe(`${IDENTITY}/api/auth/session?probe=1`)
    expect(seen[0]!.headers.get("cookie")).toBe("smithers_session=abc")
    expect(seen[0]!.headers.get("x-user-id")).toBeNull()
    expect(seen[0]!.headers.get("x-smithers-admin-token")).toBeNull()
    expect(seen[0]!.headers.get("authorization")).toBeNull()
    expect(seen[0]!.headers.get("origin")).toBe("https://mvp.test")
  })

  /*
   * The identity worker rate-limits its OAuth routes per client address.
   * Through this proxy, cf-connecting-ip at the upstream is the proxy's own
   * subrequest address, so every user would share one bucket. The proxy
   * attests the browser's address in x-smithers-client-ip beside the
   * service token the upstream already trusts; a client-supplied copy of
   * either header is stripped first.
   */
  test("attests the browser's address beside the service token, never a client-supplied one", async () => {
    const { seen, layer } = wire(() => jsonAnswer(302, {}))
    await run(
      proxyToIdentity(
        new Request("https://mvp.test/api/auth/github/start", {
          headers: {
            "cf-connecting-ip": "203.0.113.7",
            "x-smithers-client-ip": "10.0.0.1",
            "x-smithers-service-token": "forged"
          }
        })
      ),
      layer,
      config()
    )
    expect(seen[0]!.headers.get("x-smithers-client-ip")).toBe("203.0.113.7")
    expect(seen[0]!.headers.get("x-smithers-service-token")).toBe("service-token")

    // No connecting address (local dev): nothing attested, nothing forged through.
    const { seen: local, layer: localLayer } = wire(() => jsonAnswer(302, {}))
    await run(
      proxyToIdentity(new Request("https://mvp.test/api/auth/github/start", { headers: { "x-smithers-client-ip": "10.0.0.1" } })),
      localLayer,
      config()
    )
    expect(local[0]!.headers.get("x-smithers-client-ip")).toBeNull()

    // No service token configured: the address is still not attested (the upstream would ignore it).
    const { seen: untrusted, layer: untrustedLayer } = wire(() => jsonAnswer(302, {}))
    await run(
      proxyToIdentity(new Request("https://mvp.test/api/auth/github/start", { headers: { "cf-connecting-ip": "203.0.113.7" } })),
      untrustedLayer,
      config({ identityServiceToken: undefined })
    )
    expect(untrusted[0]!.headers.get("x-smithers-client-ip")).toBeNull()
    expect(untrusted[0]!.headers.get("x-smithers-service-token")).toBeNull()
  })

  test("the sibling's admin surface is the canonical 404 and never forwarded; no seam is a 501", async () => {
    const { seen, layer } = wire(() => jsonAnswer(200, { ok: true }))
    const hidden = await run(proxyToIdentity(new Request("https://mvp.test/api/identity/admin/allowlist")), layer, config())
    expect(hidden.status).toBe(404)
    expect(await hidden.json()).toEqual({ status: "error", code: "route_not_found", message: "Not found." })
    expect(seen).toEqual([])
    const unset = await run(proxyToIdentity(new Request("https://mvp.test/api/auth/session")), layer, testConfigLayer())
    expect(unset.status).toBe(501)
    expect(((await unset.json()) as { message: string }).message).toContain("IDENTITY_UPSTREAM_URL")
  })

  test("an unreachable seam is a 502 envelope and a deadline a 504, never a thrown error", async () => {
    const down = await run(
      proxyToIdentity(new Request("https://mvp.test/api/auth/session")),
      wire(() => Promise.reject(new Error("connection refused"))).layer,
      config()
    )
    expect(down.status).toBe(502)
    expect(((await down.json()) as { message: string }).message).toContain("The identity service is unreachable right now")
    const slow = await run(
      proxyToIdentity(new Request("https://mvp.test/api/auth/session")),
      wire((request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
        })
      ).layer,
      config({ upstreamTimeoutMs: 20 })
    )
    expect(slow.status).toBe(504)
    expect(await slow.json()).toEqual({ status: "error", code: "upstream_timeout", message: "The identity service did not answer within 20ms. Try again in a moment." })
  })
})

describe("probeAuthSession and the OAuth navigations", () => {
  test("the signed-out 401 is restated as a resolved 200; every other answer passes through", async () => {
    const probe = new Request("https://mvp.test/api/auth/session")
    const signedOut = await run(probeAuthSession(probe), wire(() => new Response("{}", { status: 401 })).layer, config())
    expect(signedOut.status).toBe(200)
    expect(await signedOut.json()).toEqual({ status: "signed-out" })
    const forbidden = await run(probeAuthSession(probe), wire(() => jsonAnswer(403, { error: "Forbidden origin" })).layer, config())
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toEqual({ error: "Forbidden origin" })
  })

  test("the start leg keeps the validated return path in a cookie and the callback spends it", async () => {
    const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } })
    const started = await run(
      handleAuthNavigation(new Request("https://mvp.test/api/auth/github/start?return_to=%2Fsmithersai%2Fsmithers", { headers: { accept: "text/html" } }), "start"),
      wire(redirect("https://github.com/login/oauth/authorize?state=s")).layer,
      config()
    )
    expect(started.status).toBe(302)
    expect(started.headers.getSetCookie()).toEqual([
      "smithers_return_to=%2Fsmithersai%2Fsmithers; Path=/api/auth; Max-Age=600; HttpOnly; Secure; SameSite=Lax"
    ])
    const returned = await run(
      handleAuthNavigation(
        new Request("https://mvp.test/api/auth/github/callback?code=x&state=s", {
          headers: { accept: "text/html", cookie: "smithers_return_to=%2Fsmithersai%2Fsmithers" }
        }),
        "callback"
      ),
      wire(redirect("/?signed-in=github")).layer,
      config()
    )
    expect(returned.status).toBe(302)
    expect(returned.headers.get("location")).toBe("/smithersai/smithers?signed-in=github")
    expect(returned.headers.getSetCookie()[0]).toContain("Max-Age=0")
  })

  test("an unreachable seam on a browser navigation is the branded 502 page; a machine caller gets JSON", async () => {
    const down = wire(() => Promise.reject(new Error("connection refused")))
    const page = await run(
      handleAuthNavigation(new Request("https://mvp.test/api/auth/github/start", { headers: { accept: "text/html" } }), "start"),
      down.layer,
      config()
    )
    expect(page.status).toBe(502)
    expect(page.headers.get("content-type")).toContain("text/html")
    expect(await page.text()).toContain("GitHub sign-in can't start right now.")
    const machine = await run(
      handleAuthNavigation(new Request("https://mvp.test/api/auth/github/start", { headers: { accept: "application/json" } }), "start"),
      down.layer,
      config()
    )
    expect(machine.status).toBe(502)
    // The proxy's own envelope, untouched: no second prefix.
    expect(await machine.json()).toEqual({ status: "error", code: "upstream_unreachable", message: "The identity service is unreachable right now: connection refused" })
  })

  test("an identity deadline on a navigation is the 504 page for a browser and the proxy's 504 envelope, verbatim, for a machine", async () => {
    const stalled = wire((request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
      })
    )
    const page = await run(
      handleAuthNavigation(new Request("https://mvp.test/api/auth/github/callback?code=x&state=y", { headers: { accept: "text/html" } }), "callback"),
      stalled.layer,
      config({ upstreamTimeoutMs: 20 })
    )
    expect(page.status).toBe(504)
    expect(page.headers.get("content-type")).toContain("text/html")
    const html = await page.text()
    expect(html).toContain("GitHub sign-in didn't finish.")
    expect(html).toContain("HTTP 504")
    const machine = await run(
      handleAuthNavigation(new Request("https://mvp.test/api/auth/github/start", { headers: { accept: "application/json" } }), "start"),
      stalled.layer,
      config({ upstreamTimeoutMs: 20 })
    )
    expect(machine.status).toBe(504)
    expect(await machine.json()).toEqual({ status: "error", code: "upstream_timeout", message: "The identity service did not answer within 20ms. Try again in a moment." })
  })

  test("normalized API return paths cannot restart OAuth from start or callback", async () => {
    const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } })
    for (const path of ["/x/../api/auth/github/start", "/x/%2e%2e/api/auth/github/start", "/x/../api", "/x/%2e%2e/api"]) {
      expect(validReturnTo(path)).toBeUndefined()
      const started = await run(
        handleAuthNavigation(new Request(`https://mvp.test/api/auth/github/start?return_to=${encodeURIComponent(path)}`, { headers: { accept: "text/html" } }), "start"),
        wire(redirect("https://github.com/login/oauth/authorize?state=s")).layer,
        config()
      )
      expect(started.status).toBe(302)
      expect(started.headers.getSetCookie()).toEqual([])
      const returned = await run(
        handleAuthNavigation(new Request("https://mvp.test/api/auth/github/callback?code=x&state=s", {
          headers: { accept: "text/html", cookie: `smithers_return_to=${encodeURIComponent(path)}` }
        }), "callback"),
        wire(redirect("/?signed-in=github")).layer,
        config()
      )
      expect(returned.status).toBe(302)
      expect(returned.headers.get("location")).toBe("/?signed-in=github")
      expect(returned.headers.getSetCookie()[0]).toContain("Max-Age=0")
    }
    expect(validReturnTo("/x/../smithersai/smithers?tab=issues#activity")).toBe("/x/../smithersai/smithers?tab=issues#activity")
    expect(validReturnTo("/x/%2e%2e/smithersai/smithers?tab=issues#activity")).toBe("/x/%2e%2e/smithersai/smithers?tab=issues#activity")
  })

  test("validReturnTo admits only a same-origin page path", () => {
    expect(validReturnTo("/smithersai/smithers?tab=issues")).toBe("/smithersai/smithers?tab=issues")
    for (const bad of ["https://evil.example/", "//evil.example/", "/\\evil", "/api/auth/github/start", "/", "", "relative", `/${"a".repeat(512)}`]) {
      expect(validReturnTo(bad)).toBeUndefined()
    }
  })
})

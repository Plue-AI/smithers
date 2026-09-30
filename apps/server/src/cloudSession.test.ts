import { expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import { configLayer } from "./Config"
import { probeCloudSession } from "./cloudSession"
import { transportLayer } from "./Http"

/**
 * Smithers Cloud's refusal envelope, in its own wire order: the machine-
 * readable verdict first, the sentence after (plue pkg/errors/errors.go
 * `APIError`, pinned there by TestErrorBodyPutsVerdictFirst). Every fixture
 * below is a body plue can actually produce on GET /api/user/workspaces.
 */
const cloudRefusal = (status: number, code: string, fault: string, message: string) =>
  new Response(JSON.stringify({ code, fault, message }), {
    status,
    headers: { "content-type": "application/json" }
  })

/** A 403 whose body starts arriving and then fails mid-stream. */
const unreadable = (status: number) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"code":"forbidden","message":"insufficient token scope`))
        controller.error(new Error("connection reset"))
      }
    }),
    { status, headers: { "content-type": "application/json" } }
  )

const run = (options: { identity?: number; token?: boolean; scope?: number; message?: string; offline?: boolean; refusal?: string; cloud?: () => Response } = {}) => {
  const calls: Request[] = []
  const response = Effect.runPromise(probeCloudSession(new Request("https://web.test/api/cloud-auth/session", {
    headers: { cookie: "session=fixture" }
  })).pipe(Effect.provide(configLayer({
    IDENTITY_UPSTREAM_URL: "https://identity.test", IDENTITY_SERVICE_TOKEN: "service-fixture", SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test"
  })), Effect.provide(transportLayer(async (input, init) => {
    const request = new Request(input, init)
    calls.push(request)
    const path = new URL(request.url).pathname
    if (path === "/api/identity/validate") return Response.json({ login: "ada", admin: false, scopes: ["read:user"] }, { status: options.identity ?? 200 })
    if (path === "/api/identity/cloud-token") {
      if (options.refusal !== undefined) return Response.json({ found: false, cloud: { status: "exchange_failed", reason: options.refusal } })
      return Response.json(options.token === false ? { found: false } : { found: true, token: "private-fixture-token" })
    }
    if (options.offline) throw new Error("offline")
    if (options.cloud !== undefined) return options.cloud()
    return Response.json({ message: options.message ?? "upstream refused" }, { status: options.scope ?? 200 })
  }))))
  return { response, calls }
}

test("the session exchange uses the validated login and never exposes its token", async () => {
  const { response, calls } = run()
  const answer = await response
  expect(answer.status).toBe(200)
  expect(answer.headers.get("cache-control")).toBe("no-store")
  expect(await answer.json()).toEqual({ state: "signed-in", username: "ada", expiresAt: null })
  expect(calls.map(request => new URL(request.url).pathname)).toEqual(["/api/identity/validate", "/api/identity/cloud-token", "/api/user/workspaces"])
  expect(calls[0]!.headers.get("cookie")).toBe("session=fixture")
  expect(await calls[1]!.json()).toEqual({ login: "ada" })
  expect(calls[1]!.headers.get("x-smithers-service-token")).toBe("service-fixture")
  expect(calls[2]!.headers.get("authorization")).toBe("Bearer private-fixture-token")
  expect(calls[2]!.headers.has("cookie")).toBe(false)
})

// Accounts are public: no Cloud token refusal code is a fact about the
// account. Retired admission codes and unknown ones all read as the bridge.
for (const refusal of ["access_not_granted", "NOT_ON_WAITLIST", "some_future_code"]) {
  test(`a Cloud token refusal is the bridge, never an account refusal: ${refusal}`, async () => {
    const { response, calls } = run({ refusal })
    const answer = await response
    expect(answer.status).toBe(503)
    expect(await answer.json()).toMatchObject({ code: "cloud_token_unavailable" })
    expect(calls.map(request => new URL(request.url).pathname)).toEqual(["/api/identity/validate", "/api/identity/cloud-token"])
  })
}

test("signed-out identity never exchanges a token or calls Cloud", async () => {
  const { response, calls } = run({ identity: 401 })
  expect(await (await response).json()).toEqual({ state: "signed-out", username: null, expiresAt: null })
  expect(calls).toHaveLength(1)
})

// The one 403 a degraded session is FOR: plue's scope gate
// (internal/middleware/scope.go RequireScope) refusing the Cloud PAT.
test("Cloud's scope refusal is a signed-in degraded session, independent of GitHub scopes", async () => {
  const { response } = run({ cloud: () => cloudRefusal(403, "forbidden", "user", "insufficient token scope") })
  expect(await (await response).json()).toEqual({ state: "signed-in", username: "ada", expiresAt: null, scopes: "degraded" })
})

// Every other refusal Cloud can put on this route. None of them says the
// token's scopes are short, so none of them may publish a signed-in session.
for (const [code, message] of [
  // plue's workspaces feature flag is off for the deployment
  // (internal/middleware/feature_flag.go): the same code, a different refusal.
  ["forbidden", "feature not available"],
  ["forbidden", "repository-bound token cannot access resources outside its repository"],
  ["org_membership_required", "join the organization to read its workspaces"]
] as const) {
  test(`a Cloud 403 that is not the scope refusal never degrades: ${code} / ${message}`, async () => {
    const { response } = run({ cloud: () => cloudRefusal(403, code, "user", message) })
    const answer = await response
    expect(answer.status).toBeGreaterThanOrEqual(500)
    expect(await answer.json()).toMatchObject({ code: "upstream_refused" })
  })
}

// The point of reading the code: two English words in a body nobody typed
// for us decided whether a person stayed signed in. A 403 that carries no
// verdict is not Cloud saying "your scopes are short", whatever it reads like.
for (const [label, body] of [
  ["a bare sentence with no code", `{"message":"Insufficient scope: read:workspace"}`],
  ["another party's envelope", `{"error":{"message":"insufficient scope for this token"}}`],
  ["an edge HTML page", `<!DOCTYPE html><title>403</title><p>insufficient scope</p>`],
  ["a code from no registry", `{"code":"insufficient_scope","message":"insufficient token scope"}`]
] as const) {
  test(`a 403 that only reads like a scope refusal no longer degrades: ${label}`, async () => {
    const { response } = run({ cloud: () => new Response(body, { status: 403 }) })
    const answer = await response
    expect(answer.status).toBeGreaterThanOrEqual(500)
    expect(await answer.json()).toMatchObject({ code: "upstream_refused" })
  })
}

test("a 403 whose body cannot be read refuses rather than degrading", async () => {
  const { response } = run({ cloud: () => unreadable(403) })
  const answer = await response
  expect(answer.status).toBeGreaterThanOrEqual(500)
  expect(await answer.json()).toMatchObject({ code: "upstream_refused" })
})

for (const options of [{ identity: 500 }, { token: false }, { scope: 401 }, { scope: 403 }, { scope: 503 }, { offline: true }]) {
  test(`unavailable identity/token/scope is never reported as signed out or full scope: ${JSON.stringify(options)}`, async () => {
    const response = await run(options).response
    expect(response.status).toBeGreaterThanOrEqual(500)
    const body = await response.text()
    expect(body).not.toContain("signed-out")
    expect(body).not.toContain("private-fixture-token")
  })
}

import { expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import { configLayer } from "./Config"
import { transportLayer } from "./Http"
import { handleGitHubAppInstall } from "./githubAppInstall"

const verify = async (id: string | undefined, options: { signedIn?: boolean; installed?: boolean; status?: number; verdict?: string } = {}) => {
  const seen: Array<{ path: string; auth: string | null }> = []
  const response = await Effect.runPromise(handleGitHubAppInstall(new Request("https://app.test/api/user/github-app/installations", {
    headers: { cookie: "smithers_session=test" }
  }), id).pipe(Effect.provide(configLayer({ IDENTITY_UPSTREAM_URL: "https://identity.test", IDENTITY_SERVICE_TOKEN: "svc", SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test" })),
  Effect.provide(transportLayer(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/api/identity/validate") return options.signedIn === false ? new Response("", { status: 401 }) : Response.json({ login: "ada", admin: false, scopes: [] })
    if (url.pathname === "/api/identity/cloud-token") return Response.json({ found: true, token: "ada-cloud-token" })
    seen.push({ path: url.pathname, auth: new Headers(init?.headers).get("authorization") })
    if (url.pathname === "/api/user/github-repos") return Response.json([{ full_name: "ada/hello", pushed_at: "2026-09-12T00:00:00Z" }])
    if (options.status !== undefined) return Response.json({ message: "upstream failure" }, { status: options.status })
    return Response.json({ verdict: options.verdict ?? (options.installed === false ? "app-not-installed" : "ok"), installation_id: 42, detail: "Your GitHub credential cannot access this repository." })
  }))))
  return { response, seen }
}

test("callback only returns source-only GitHub repositories with a verified matching installation, without prior import", async () => {
  const { response, seen } = await verify("42")
  expect(await response.json()).toEqual({ repos: [{ fullName: "ada/hello", pushedAt: "2026-09-12T00:00:00Z", installationId: 42 }] })
  expect(seen).toEqual([
    { path: "/api/user/github-repos", auth: "Bearer ada-cloud-token" },
    { path: "/api/user/github-access/ada/hello", auth: "Bearer ada-cloud-token" }
  ])
  expect(await (await verify("999")).response.json()).toEqual({ repos: [] })
  expect(await (await verify(undefined, { installed: false })).response.json()).toEqual({ repos: [] })
})

test("a return without an id checks installed repository status, never accepts inventory alone", async () => {
  expect((await (await verify(undefined)).response.json() as { repos: unknown[] }).repos).toHaveLength(1)
  expect((await verify(undefined, { status: 503 })).response.status).toBe(503)
})

test("signed-out callbacks cannot read the repository or App installation inventory", async () => {
  const { response, seen } = await verify("42", { signedIn: false })
  expect(response.status).toBe(401)
  expect(seen).toEqual([])
})


test("an existing installation never bypasses the user's own repository grant", async () => {
  const { response } = await verify("42", { verdict: "no-org-grant" })
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    status: "error",
    code: "request_conflict",
    message: "Your GitHub credential cannot access this repository."
  })
})

test("verification includes later pages so a second installation and every repository reach the chooser", async () => {
  const pages: string[] = []
  const identityCalls = { validate: 0, cloudToken: 0 }
  const response = await Effect.runPromise(handleGitHubAppInstall(new Request("https://app.test/api/user/github-app/installations", {
    headers: { cookie: "smithers_session=test" }
  })).pipe(Effect.provide(configLayer({ IDENTITY_UPSTREAM_URL: "https://identity.test", IDENTITY_SERVICE_TOKEN: "svc", SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test" })),
  Effect.provide(transportLayer(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/api/identity/validate") {
      identityCalls.validate++
      return Response.json({ login: "ada", admin: false, scopes: [] })
    }
    if (url.pathname === "/api/identity/cloud-token") {
      identityCalls.cloudToken++
      return Response.json({ found: true, token: "fixture-token" })
    }
    if (url.pathname === "/api/user/github-repos") {
      pages.push(url.searchParams.get("page")!)
      return Response.json(url.searchParams.get("page") === "1"
        ? Array.from({ length: 100 }, (_, i) => ({ full_name: `ada/repo-${i}`, pushed_at: "2026-09-12T00:00:00Z" }))
        : [{ full_name: "acme/api", pushed_at: "2026-09-01T00:00:00Z" }])
    }
    return Response.json({ verdict: "ok", installation_id: url.pathname.includes("/acme/") ? 99 : 42 })
  }))))
  const body = await response.json() as { repos: Array<{ fullName: string; installationId: number }> }
  expect(pages).toEqual(["1", "2"])
  expect(body.repos).toHaveLength(101)
  expect(body.repos.at(-1)).toMatchObject({ fullName: "acme/api", installationId: 99 })
  // One session check and one Cloud token per verification, not per repository:
  // three subrequests per repo tripped the Worker's 1000-subrequest ceiling.
  expect(identityCalls).toEqual({ validate: 1, cloudToken: 1 })
})

test("oversized inventories refuse before any per-repository access calls", async () => {
  let calls = 0, access = 0
  const response = await Effect.runPromise(handleGitHubAppInstall(new Request("https://app.test/api/user/github-app/installations", { headers: { cookie: "smithers_session=test" } })).pipe(
    Effect.provide(configLayer({ IDENTITY_UPSTREAM_URL: "https://identity.test", IDENTITY_SERVICE_TOKEN: "svc", SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test" })),
    Effect.provide(transportLayer(async input => {
      calls++
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === "/api/identity/validate") return Response.json({ login: "ada" })
      if (url.pathname === "/api/identity/cloud-token") return Response.json({ found: true, token: "fixture" })
      if (url.pathname === "/api/user/github-repos") return Response.json(Array.from({ length: 100 }, (_, i) => ({ full_name: `ada/page${url.searchParams.get("page")}-${i}` })))
      access++
      return Response.json({ verdict: "ok", installation_id: 42 })
    }))
  ))
  expect(response.status).toBe(503)
  expect(access).toBe(0)
  expect(calls).toBe(12)
})

test.each(["inventory", "diagnosis"])("bounds and cancels an oversized %s body", async seam => {
  let cancelled = false
  const response = await Effect.runPromise(handleGitHubAppInstall(new Request("https://app.test/api/user/github-app/installations", { headers: { cookie: "smithers_session=test" } })).pipe(
    Effect.provide(configLayer({ IDENTITY_UPSTREAM_URL: "https://identity.test", IDENTITY_SERVICE_TOKEN: "svc", SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test" })),
    Effect.provide(transportLayer(async input => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname
      if (path === "/api/identity/validate") return Response.json({ login: "ada" })
      if (path === "/api/identity/cloud-token") return Response.json({ found: true, token: "fixture" })
      if (path === "/api/user/github-repos" && seam === "diagnosis") return Response.json([{ full_name: "ada/repo" }])
      let chunks = 0
      return new Response(new ReadableStream({ pull(controller) {
        // Finite but over the limit, so the old unbounded reader finishes.
        if (chunks++ < 80) controller.enqueue(new Uint8Array(65536).fill(32))
        else controller.close()
      }, cancel() { cancelled = true } }))
    }))
  ))
  expect(response.status).toBe(502)
  expect(cancelled).toBe(true)
})

test("an inventory row with dot segments never resolves the access read to another Cloud path", async () => {
  const seen: Array<string> = []
  const response = await Effect.runPromise(handleGitHubAppInstall(new Request("https://app.test/api/user/github-app/installations", {
    headers: { cookie: "smithers_session=test" }
  })).pipe(Effect.provide(configLayer({ IDENTITY_UPSTREAM_URL: "https://identity.test", IDENTITY_SERVICE_TOKEN: "svc", SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test" })),
  Effect.provide(transportLayer(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/api/identity/validate") return Response.json({ login: "ada", admin: false, scopes: [] })
    if (url.pathname === "/api/identity/cloud-token") return Response.json({ found: true, token: "ada-cloud-token" })
    seen.push(url.pathname)
    if (url.pathname === "/api/user/github-repos") return Response.json([{ full_name: "../.." }, { full_name: "ada/.." }, { full_name: "./x" }, { full_name: "ada/hello" }])
    return Response.json({ verdict: "ok", installation_id: 42, detail: "" })
  }))))
  expect(response.status).toBe(200)
  expect(seen).toEqual(["/api/user/github-repos", "/api/user/github-access/ada/hello"])
})
